import { describe, it, afterEach, mock } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LicensingClient, LicensingClientDiagnostic, LicenseType } from '../dist/license-client.js';

afterEach(() => {
    mock.restoreAll();
});

describe('LicensingClient services config handling', () => {
    const invokeResolver = (input: string) => {
        const client = new LicensingClient();
        return (client as any).resolveServicesConfigContent(input);
    };

    it('accepts raw JSON input', () => {
        const json = '{"floatingServer":"https://example.com"}';
        assert.equal(invokeResolver(json), json);
    });

    it('accepts base64 encoded JSON input', () => {
        const json = '{"floatingServer":"https://example.com"}';
        const encoded = Buffer.from(json, 'utf-8').toString('base64');
        assert.equal(invokeResolver(encoded), json);
    });

    it('rejects invalid inline config even if it looks like base64', () => {
        // "YWJjZA==" decodes to "abcd", which is not valid JSON
        assert.throws(() => invokeResolver('YWJjZA=='), /Services config value is not a valid JSON string or base64 encoded JSON string\./);
    });

    it('throws when inline config does not match base64 format', () => {
        assert.throws(() => invokeResolver('not-a-valid-config'), /Input does not match base64 format/);
    });

    it('rejects empty inline config', () => {
        assert.throws(() => invokeResolver('   '), /Services config value is empty\. Provide a file path, JSON, or base64 encoded JSON string\./);
    });
});

describe('LicensingClient floating activation order', () => {
    it('prepares services config without checking entitlements', async () => {
        const client = new LicensingClient();
        const setupSpy = mock.method(client as any, 'setupServicesConfig', async () => '/tmp/services-config.json');
        const entitlementsSpy = mock.method(client, 'GetActiveEntitlements', async () => []);
        mock.method(client, 'Context', async () => {});
        const order: string[] = [];
        const waitSpy = mock.method(client as any, 'waitForLicenseServerConfiguration', async () => { order.push('wait'); });
        const execSpy = mock.method(client as any, 'exec', async () => {
            order.push('exec');
            return 'Successfully acquired with token: "token-123"';
        });

        await client.Activate({
            licenseType: LicenseType.floating,
            servicesConfig: '{"floatingServer":"https://example.com"}'
        });

        assert.equal(setupSpy.mock.callCount(), 1);
        assert.equal(entitlementsSpy.mock.callCount(), 0);
        assert.equal(waitSpy.mock.callCount(), 1);
        assert.equal(execSpy.mock.callCount(), 1);
        assert.deepEqual(order, ['wait', 'exec']);
    });
});

describe('LicensingClient waitForLicenseServerConfiguration', () => {
    const createTempLog = () => {
        // a private directory from mkdtemp, so no other user can pre-create or swap the file
        const tempFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'unity-cli-log-')), 'licensing.log');
        fs.writeFileSync(tempFile, 'initial line\n', { flag: 'wx', mode: 0o600 });
        return tempFile;
    };

    it('resolves once floating server URL appears in logs', async () => {
        const client = new LicensingClient();
        const tempLog = createTempLog();
        mock.method(LicensingClient, 'ClientLogPath', () => tempLog);
        mock.method(client as any, 'exec', async () => '');

        setTimeout(() => {
            fs.appendFileSync(tempLog, '\nFloating license server URL is: https://example.com (via config file)\n');
        }, 10);

        await (client as any).waitForLicenseServerConfiguration(500, 10);
        fs.rmSync(tempLog, { force: true });
    });

    it('rejects when floating server URL never appears', async () => {
        const client = new LicensingClient();
        const tempLog = createTempLog();
        mock.method(LicensingClient, 'ClientLogPath', () => tempLog);
        mock.method(client as any, 'exec', async () => '');

        await assert.rejects((client as any).waitForLicenseServerConfiguration(200, 10), /Timed out waiting for floating license server configuration/);
        fs.rmSync(tempLog, { force: true });
    });
});

describe('LicensingClientDiagnostic', () => {
    it('keeps the last lines that say why the command failed', () => {
        const lines = ['Starting', 'Error: first', 'Error: second', 'progress', 'Seat activation failed', 'Machine activations limit reached', ''];
        assert.equal(LicensingClientDiagnostic(lines), 'Error: second\nSeat activation failed\nMachine activations limit reached');
    });

    it('cuts long lines', () => {
        const diagnostic = LicensingClientDiagnostic([`Error: ${'x'.repeat(400)}`]);
        assert.equal(diagnostic.length, 303);
        assert.equal(diagnostic?.endsWith('...'), true);
    });

    it('returns undefined without a diagnostic line', () => {
        assert.equal(LicensingClientDiagnostic(['Starting', 'Done', '']), undefined);
    });
});
