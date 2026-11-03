import { describe, it, after, beforeEach, afterEach, mock } from 'node:test';
import * as assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from '../dist/logging.js';
import { FindAbsolutePath, UnityCli } from '../dist/unity-cli.js';
import { moveMacInstalledItem, resolveEditorExecutable } from '../dist/unity-installer.js';
import {
    ActivateLicense,
    GetLegacyLicenseVersion,
    LicenseType,
    LicensingClient,
    ReturnLicense,
} from '../dist/license-client.js';

afterEach(() => {
    mock.restoreAll();
});

describe('FindAbsolutePath', () => {
    const absolute = process.platform === 'win32' ? 'C:\\Unity\\6000.0.0f1' : '/opt/unity/6000.0.0f1';

    it('reads a bare path', () => {
        assert.equal(FindAbsolutePath(absolute), absolute);
    });

    it('prefers well-known keys', () => {
        assert.equal(FindAbsolutePath({ name: 'x', path: absolute }), absolute);
    });

    it('ignores relative paths and errors', () => {
        assert.equal(FindAbsolutePath({ path: 'relative/path', errors: [{ message: absolute }] }), undefined);
    });
});

describe('UnityCli.TemplatesListArgs', () => {
    it('uses templates --editor-version on CLI 1.0.0-beta.15 and newer', () => {
        assert.deepEqual(new UnityCli('unity', '1.0.0-beta.15').TemplatesListArgs('6000.0.58f2'), ['templates', '--editor-version', '6000.0.58f2']);
        assert.deepEqual(new UnityCli('unity', '1.0.0').TemplatesListArgs('6000.0.58f2'), ['templates', '--editor-version', '6000.0.58f2']);
        assert.deepEqual(new UnityCli('unity', '1.0.0-beta.15').TemplatesListArgs(), ['templates']);
    });

    it('uses templates list --editor on CLI 1.0.0-beta.14 and older', () => {
        assert.deepEqual(new UnityCli('unity', '1.0.0-beta.14').TemplatesListArgs('6000.0.58f2'), ['templates', 'list', '--editor', '6000.0.58f2']);
        assert.deepEqual(new UnityCli('unity', '1.0.0-beta.9').TemplatesListArgs(), ['templates', 'list']);
    });
});

describe('UnityCli.ListTemplates', () => {
    const listed = [
        { name: 'com.unity.template.3d', type: 'CORE' },
        { name: '3d', version: '0.0.0' },
        { id: 'com.unity.template.urp-blank', type: 'CORE' },
    ];

    it('reads the items list of CLI 1.0.0-beta.15 and newer', async () => {
        const cli = new UnityCli('unity', '1.0.0-beta.15');
        const exec = mock.method(cli, 'ExecJson', async () => ({ items: listed }));
        assert.deepEqual(await cli.ListTemplates('6000.0.58f2'), ['com.unity.template.3d', 'com.unity.template.urp-blank']);
        assert.ok(exec.mock.calls.some(call => isDeepStrictEqual(call.arguments, [['templates', '--editor-version', '6000.0.58f2']])));
    });

    it('reads the bare list of CLI 1.0.0-beta.14 and older', async () => {
        const cli = new UnityCli('unity', '1.0.0-beta.14');
        const exec = mock.method(cli, 'ExecJson', async () => listed);
        assert.deepEqual(await cli.ListTemplates('6000.0.58f2'), ['com.unity.template.3d', 'com.unity.template.urp-blank']);
        assert.ok(exec.mock.calls.some(call => isDeepStrictEqual(call.arguments, [['templates', 'list', '--editor', '6000.0.58f2']])));
    });
});

describe('resolveEditorExecutable', () => {
    it('finds the editor below an install directory', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unity-cli-resolve-'));

        try {
            const editorPath = process.platform === 'darwin'
                ? path.join(root, 'Unity.app', 'Contents', 'MacOS', 'Unity')
                : path.join(root, 'Editor', process.platform === 'win32' ? 'Unity.exe' : 'Unity');
            fs.mkdirSync(path.dirname(editorPath), { recursive: true });
            fs.writeFileSync(editorPath, '');
            assert.equal(resolveEditorExecutable(root), editorPath);
            assert.equal(resolveEditorExecutable(path.join(root, 'missing')), undefined);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('GetLegacyLicenseVersion', () => {
    it('detects 4.x and 5.x editors', () => {
        assert.equal(GetLegacyLicenseVersion('/Applications/Unity/Hub/Editor/Unity 4.7.2/Unity.app/Contents/MacOS/Unity'), '4.x');
        assert.equal(GetLegacyLicenseVersion('C:\\Program Files\\Unity\\Hub\\Editor\\5.6.7f1\\Editor\\Unity.exe'), '5.x');
    });

    it('returns undefined for newer editors or no editor', () => {
        assert.equal(GetLegacyLicenseVersion('/opt/unity/6000.0.0f1/Editor/Unity'), undefined);
        assert.equal(GetLegacyLicenseVersion(undefined), undefined);
    });
});

describe('license activation order', () => {
    const originalEditorPath = process.env.UNITY_EDITOR_PATH;
    const originalRunnerEnvironment = process.env.RUNNER_ENVIRONMENT;

    beforeEach(() => {
        delete process.env.UNITY_EDITOR_PATH;
        // a GitHub-hosted macOS or Linux runner skips a personal return, which these tests exercise
        delete process.env.RUNNER_ENVIRONMENT;
    });

    after(() => {
        if (originalEditorPath === undefined) {
            delete process.env.UNITY_EDITOR_PATH;
        } else {
            process.env.UNITY_EDITOR_PATH = originalEditorPath;
        }

        if (originalRunnerEnvironment === undefined) {
            delete process.env.RUNNER_ENVIRONMENT;
        } else {
            process.env.RUNNER_ENVIRONMENT = originalRunnerEnvironment;
        }
    });

    const mockCli = (results: { [command: string]: { exitCode: number; data?: unknown } }) => {
        const cli = new UnityCli('unity', '1.0.0-beta.14');
        const calls: string[][] = [];
        mock.method(cli, 'RunJson', async (args: string[]) => {
            calls.push(args);
            const key = args.slice(0, 2).join(' ');
            const result = results[key] ?? { exitCode: 0, data: null };
            return {
                exitCode: result.exitCode,
                envelope: { success: result.exitCode === 0, data: result.data as any, errors: [] },
                stdout: '',
                stderr: '',
            };
        });
        mock.method(UnityCli, 'Get', async () => cli);
        return calls;
    };

    it('uses the Unity CLI when it activates the license', async () => {
        const calls = mockCli({
            'license activate': { exitCode: 0 },
            'license status': { exitCode: 0, data: { active: true } },
        });
        const fallback = mock.method(LicensingClient.prototype, 'Activate');

        await ActivateLicense({ licenseType: LicenseType.personal, username: 'user@example.com', password: 'secret' });

        assert.deepEqual(calls[0], ['license', 'activate', '--personal', '--accept-eula']);
        assert.equal(fallback.mock.callCount(), 0);
    });

    it('falls back to the licensing client when the Unity CLI fails', async () => {
        mockCli({ 'license activate': { exitCode: 3 } });
        const fallback = mock.method(LicensingClient.prototype, 'Activate', async () => undefined);

        await ActivateLicense({ licenseType: LicenseType.personal, username: 'user@example.com', password: 'secret' });

        assert.equal(fallback.mock.callCount(), 1);
    });

    it('falls back when the Unity CLI reports no active license', async () => {
        mockCli({
            'license activate': { exitCode: 0 },
            'license status': { exitCode: 4, data: { active: false } },
        });
        const fallback = mock.method(LicensingClient.prototype, 'Activate', async () => undefined);

        await ActivateLicense({ licenseType: LicenseType.personal, username: 'user@example.com', password: 'secret' });

        assert.equal(fallback.mock.callCount(), 1);
    });

    it('uses the licensing client directly for 5.x editors', async () => {
        process.env.UNITY_EDITOR_PATH = 'C:\\Unity\\5.6.7f1\\Editor\\Unity.exe';
        const calls = mockCli({});
        const fallback = mock.method(LicensingClient.prototype, 'Activate', async () => undefined);

        await ActivateLicense({ licenseType: LicenseType.personal, username: 'user@example.com', password: 'secret' });

        assert.equal(calls.length, 0);
        assert.equal(fallback.mock.callCount(), 1);
    });

    it('returns through the Unity CLI and verifies nothing is still active', async () => {
        const calls = mockCli({
            'license return': { exitCode: 0 },
            'license status': { exitCode: 4, data: { active: false } },
        });
        const fallback = mock.method(LicensingClient.prototype, 'Deactivate');

        await ReturnLicense(LicenseType.personal);

        assert.deepEqual(calls[0], ['license', 'return', '--yes']);
        assert.equal(fallback.mock.callCount(), 0);
    });

    it('returns through the licensing client when a license is still active', async () => {
        mockCli({
            'license return': { exitCode: 0 },
            'license status': { exitCode: 0, data: { active: true } },
        });
        const fallback = mock.method(LicensingClient.prototype, 'Deactivate', async () => undefined);

        await ReturnLicense(LicenseType.personal);

        assert.equal(fallback.mock.callCount(), 1);
    });

    describe('on a shared runner identity', () => {
        const platform = process.platform;

        beforeEach(() => {
            process.env.RUNNER_ENVIRONMENT = 'github-hosted';
            Object.defineProperty(process, 'platform', { value: 'linux' });
        });

        afterEach(() => {
            Object.defineProperty(process, 'platform', { value: platform });
        });

        it('skips a personal return under auto', async () => {
            const calls = mockCli({});

            await ReturnLicense(LicenseType.personal);

            assert.equal(calls.length, 0);
        });

        it('returns a professional license under auto', async () => {
            const calls = mockCli({
                'license return': { exitCode: 0 },
                'license status': { exitCode: 4, data: { active: false } },
            });
            const warn = mock.method(Logger.instance, 'warn');

            await ReturnLicense(LicenseType.professional);

            assert.deepEqual(calls[0], ['license', 'return', '--yes']);
            assert.equal(warn.mock.callCount(), 0);
        });

        it('warns about the seat when a professional return is skipped', async () => {
            const calls = mockCli({});
            const warn = mock.method(Logger.instance, 'warn', () => undefined);

            await ReturnLicense(LicenseType.professional, undefined, 'never');

            assert.equal(calls.length, 0);
            assert.ok(warn.mock.calls.some(call => call.arguments.length === 1 && String(call.arguments[0]).includes('id.unity.com > My Seats')));
        });

        it('warns about the seat when a professional return fails', async () => {
            mockCli({ 'license return': { exitCode: 3 } });
            mock.method(LicensingClient.prototype, 'Deactivate', async () => { throw new Error('no seat'); });
            const warn = mock.method(Logger.instance, 'warn', () => undefined);

            await assert.rejects(ReturnLicense(LicenseType.professional), /no seat/);

            assert.ok(warn.mock.calls.some(call => call.arguments.length === 1 && String(call.arguments[0]).includes('id.unity.com > My Seats')));
        });
    });
});

describe('licensing client output redaction', () => {
    it('never logs the email, password or serial from the command or its output', async () => {
        const client = new LicensingClient('6.x');
        (client as any).licenseClientPath = process.execPath;
        const written: string[] = [];
        const write = process.stdout.write.bind(process.stdout);
        mock.method(process.stdout, 'write', (chunk: any, ...rest: any[]) => {
            // the test runner reports through stdout in binary chunks while this test awaits, so pass those through
            if (typeof chunk !== 'string') { return write(chunk, ...rest); }
            written.push(chunk);
            return true;
        });

        await (client as any).exec(['-e', 'console.log(process.argv.slice(1).join(" "))', '--', '--username', 'user@example.com', '--password', 'hunter2222', '--serial', 'AB-CDEF-1234-5678']);

        const logged = written.join('');
        assert.ok(!logged.includes('user@example.com'));
        assert.ok(!logged.includes('hunter2222'));
        assert.ok(!logged.includes('AB-CDEF-1234-5678'));
        assert.ok(logged.includes('*****'));
    });
});

describe('UnityCli.GetLicensingClientPath', () => {
    it('installs the licensing client with license status, which works without a Unity ID session', async () => {
        const cli = new UnityCli('unity', '1.0.0');
        const calls: string[][] = [];
        mock.method(cli, 'RunJson', async (args: string[]) => {
            calls.push(args);
            // a headless runner has no Unity ID session, so license commands exit 3 (not signed in)
            const exitCode = args[0] === 'license' ? 3 : 0;
            return { exitCode, envelope: { success: exitCode === 0, data: {} }, stdout: '', stderr: '' } as any;
        });

        assert.equal(await cli.GetLicensingClientPath(), undefined);
        assert.deepEqual(calls, [['license', 'status'], ['doctor']]);
    });
});

describe('moveMacInstalledItem', () => {
    // creating symlinks on Windows needs extra privileges, and the helper only runs on macOS
    const posixIt = process.platform === 'win32' ? it.skip : it;

    const makeTree = (root: string) => {
        const source = path.join(root, 'source');
        fs.mkdirSync(path.join(source, 'bin'), { recursive: true });
        fs.writeFileSync(path.join(source, 'bin', 'tool'), '#!/bin/sh\n');
        fs.chmodSync(path.join(source, 'bin', 'tool'), 0o755);
        // a link whose target is gone, like 5.6's MonoDevelop.app
        fs.symlinkSync('/Applications/MonoDevelop.app', path.join(source, 'MonoDevelop.app'));
        fs.symlinkSync('bin/tool', path.join(source, 'tool-link'));
        return source;
    };

    const expectMoved = (source: string, destination: string) => {
        assert.equal(fs.existsSync(source), false);
        assert.equal(fs.readlinkSync(path.join(destination, 'MonoDevelop.app')), '/Applications/MonoDevelop.app');
        assert.equal(fs.readlinkSync(path.join(destination, 'tool-link')), 'bin/tool');
        assert.equal(fs.statSync(path.join(destination, 'bin', 'tool')).mode & 0o777, 0o755);
    };

    posixIt('moves a tree with a dangling symlink', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unity-cli-move-'));

        try {
            const source = makeTree(root);
            const destination = path.join(root, 'destination');
            await moveMacInstalledItem(source, destination);
            expectMoved(source, destination);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    posixIt('copies symlinks and executables as they are across volumes', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unity-cli-move-'));

        try {
            const source = makeTree(root);
            const destination = path.join(root, 'destination');
            fs.mkdirSync(destination);
            fs.writeFileSync(path.join(destination, 'stale'), '');
            mock.method(fs.promises, 'rename', async () => { throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' }); }, { times: 1 });
            await moveMacInstalledItem(source, destination);
            expectMoved(source, destination);
            assert.equal(fs.existsSync(path.join(destination, 'stale')), false);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
