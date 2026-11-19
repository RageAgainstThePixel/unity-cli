import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import * as assert from 'node:assert/strict';
import { ActivateLicense, LicensingClient, LicensingClientDiagnostic, LicenseType } from '../dist/license-client.js';
import { ClassifyFailure, LICENSE_EXHAUSTED_MARKER } from '../dist/failure-markers.js';
import { Logger } from '../dist/logging.js';
import { UnityCli } from '../dist/unity-cli.js';

const LEASE = 'lease-value-for-tests';
const saved: { [key: string]: string | undefined } = {};

type Call = string[];

function mockCli(activateData: unknown, returnActive: boolean) {
    const calls: Call[] = [];
    mock.method(UnityCli, 'Get', async () => ({
        RunJson: async (args: string[]) => {
            calls.push(args);

            if (args[1] === 'activate') {
                return { exitCode: 0, envelope: { success: true, data: activateData }, stdout: '', stderr: '' };
            }

            if (args[1] === 'status') {
                return { exitCode: 4, envelope: { success: false, data: { active: false } }, stdout: '', stderr: '' };
            }

            if (args[1] === 'return') {
                return returnActive
                    ? { exitCode: 0, envelope: { success: true }, stdout: '', stderr: '' }
                    : { exitCode: 1, envelope: { success: false }, stdout: '', stderr: '' };
            }

            throw new Error(`unexpected ${args.join(' ')}`);
        },
    }));
    return calls;
}

function mockLogger() {
    return {
        annotate: mock.method(Logger.instance, 'annotate', () => { }),
        warn: mock.method(Logger.instance, 'warn', () => { }),
        mask: mock.method(Logger.instance, 'CI_mask', () => { }),
        info: mock.method(Logger.instance, 'info', () => { }),
        output: mock.method(Logger.instance, 'CI_setOutput', () => { }),
    };
}

function mockLicensingClient(activate: () => Promise<string | undefined>) {
    mock.method(LicensingClient.prototype as any, 'setupServicesConfig', async () => '/tmp/services-config.json');
    mock.method(LicensingClient.prototype, 'GetMachineBindings', async () => []);
    mock.method(LicensingClient, 'StopBackgroundClients', async () => { });
    return {
        activate: mock.method(LicensingClient.prototype, 'Activate', activate),
        deactivate: mock.method(LicensingClient.prototype, 'Deactivate', async () => { }),
    };
}

const floating = { licenseType: LicenseType.floating, servicesConfig: '{"floatingServer":"https://example.com"}' };

beforeEach(() => {
    for (const key of ['UNITY_EDITOR_PATH', 'UNITY_LICENSE']) {
        saved[key] = process.env[key];
        delete process.env[key];
    }
});

afterEach(() => {
    mock.restoreAll();

    for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
});

describe('inconsistent Unity CLI activation', () => {
    it('masks and returns the leftover token, then falls back', async () => {
        const logger = mockLogger();
        const calls = mockCli({ license: { token: LEASE } }, true);
        const client = mockLicensingClient(async () => 'fallback-token');

        assert.equal(await ActivateLicense({ ...floating }), 'fallback-token');

        assert.equal(logger.mask.mock.calls.some(call => call.arguments[0] === LEASE), true);
        assert.equal(client.deactivate.mock.callCount(), 1);
        assert.deepEqual(client.deactivate.mock.calls[0]!.arguments, [LicenseType.floating, LEASE]);
        assert.equal(calls.some(args => args[1] === 'return'), false);
        assert.equal(client.activate.mock.callCount(), 1);

        assert.equal(logger.annotate.mock.callCount(), 1);
        const [level, message, , , , , , title] = logger.annotate.mock.calls[0]!.arguments;
        assert.equal(level, 'warning');
        assert.equal(title, 'unity-cli-inconsistent-activation');
        assert.match(message, /token in response: yes, lease released: yes/);
        assert.equal(message.includes(LEASE), false);
        assert.equal(logger.warn.mock.calls.some(call => /Unity CLI license activation failed/.test(String(call.arguments[0]))), false);
    });

    it('tries unity license return --yes without a token, then falls back', async () => {
        const logger = mockLogger();
        const calls = mockCli({ license: {} }, true);
        const client = mockLicensingClient(async () => 'fallback-token');

        assert.equal(await ActivateLicense({ ...floating }), 'fallback-token');

        const returnCall = calls.find(args => args[1] === 'return');
        assert.deepEqual(returnCall, ['license', 'return', '--yes']);
        assert.equal(client.deactivate.mock.callCount(), 0);
        assert.equal(client.activate.mock.callCount(), 1);
        assert.match(logger.annotate.mock.calls[0]!.arguments[1], /token in response: no, lease released: yes/);
    });

    it('still falls back when the leftover lease cannot be released', async () => {
        const logger = mockLogger();
        mockCli({}, false);
        const client = mockLicensingClient(async () => 'fallback-token');

        assert.equal(await ActivateLicense({ ...floating }), 'fallback-token');

        assert.equal(client.activate.mock.callCount(), 1);
        assert.equal(logger.warn.mock.calls.some(call => /Could not release the lease/.test(String(call.arguments[0]))), true);
        assert.match(logger.annotate.mock.calls[0]!.arguments[1], /token in response: no, lease released: no/);
    });

    it('skips the return for a personal license on a shared runner identity', async () => {
        const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
        const runner = process.env.RUNNER_ENVIRONMENT;
        Object.defineProperty(process, 'platform', { value: 'linux' });
        process.env.RUNNER_ENVIRONMENT = 'github-hosted';

        try {
            const logger = mockLogger();
            const calls = mockCli({ license: { token: LEASE } }, true);
            const client = mockLicensingClient(async () => undefined);

            await ActivateLicense({ licenseType: LicenseType.personal, username: 'user@example.com', password: 'unused' });

            assert.equal(calls.some(args => args[1] === 'return'), false);
            assert.equal(client.deactivate.mock.callCount(), 0);
            assert.equal(client.activate.mock.callCount(), 1);
            assert.match(logger.annotate.mock.calls[0]!.arguments[1], /lease released: skipped on a shared runner identity/);
        } finally {
            Object.defineProperty(process, 'platform', platform);

            if (runner === undefined) {
                delete process.env.RUNNER_ENVIRONMENT;
            } else {
                process.env.RUNNER_ENVIRONMENT = runner;
            }
        }
    });

    it('keeps the false success in the error when the fallback hits a floating 429, marked exhausted', async () => {
        mockLogger();
        mockCli({ license: { token: LEASE } }, true);
        mockLicensingClient(async () => {
            throw new Error('License command failed with exit code 19: Acquiring license failed\n' +
                'Error [429 Too Many Requests] received from: https://example.com/v1/license/floating\n' +
                '[status: 429 | title: Can not acquire Floating license | detail: No remaining license for server default toolset]');
        });

        await assert.rejects(ActivateLicense({ ...floating }), (error: Error) => {
            assert.match(error.message, /Acquiring license failed/);
            assert.match(error.message, /Before the fallback: unity license activate exited 0 and reported success, but unity license status reports no active license/);
            assert.equal(error.message.includes(LEASE), false);
            assert.equal(ClassifyFailure(error.message), LICENSE_EXHAUSTED_MARKER);
            return true;
        });
    });
});

describe('floating exhaustion markers', () => {
    for (const message of [
        'Error [429 Too Many Requests] received from: https://example.com/v1/license/floating',
        '[status: 429 | title: Can not acquire Floating license | detail: No remaining license for server default toolset]',
    ]) {
        it(`marks: ${message}`, () => {
            assert.equal(ClassifyFailure(message), LICENSE_EXHAUSTED_MARKER);
        });
    }

    it('keeps the floating detail through diagnostic extraction', () => {
        const diagnostic = LicensingClientDiagnostic([
            'Acquiring license failed',
            '[status: 429 | title: Can not acquire Floating license | detail: No remaining license for server default toolset]',
            '',
        ]);

        assert.match(diagnostic ?? '', /No remaining license/);
        assert.equal(ClassifyFailure(`License command failed with exit code 19: ${diagnostic}`), LICENSE_EXHAUSTED_MARKER);
    });
});
