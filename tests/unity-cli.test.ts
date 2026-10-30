import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from '../src/logging';
import { FindAbsolutePath, UnityCli } from '../src/unity-cli';
import { moveMacInstalledItem, resolveEditorExecutable } from '../src/unity-installer';
import {
    ActivateLicense,
    GetLegacyLicenseVersion,
    LicenseType,
    LicensingClient,
    ReturnLicense,
} from '../src/license-client';

afterEach(() => {
    jest.restoreAllMocks();
});

describe('FindAbsolutePath', () => {
    const absolute = process.platform === 'win32' ? 'C:\\Unity\\6000.0.0f1' : '/opt/unity/6000.0.0f1';

    it('reads a bare path', () => {
        expect(FindAbsolutePath(absolute)).toBe(absolute);
    });

    it('prefers well-known keys', () => {
        expect(FindAbsolutePath({ name: 'x', path: absolute })).toBe(absolute);
    });

    it('ignores relative paths and errors', () => {
        expect(FindAbsolutePath({ path: 'relative/path', errors: [{ message: absolute }] })).toBeUndefined();
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
            expect(resolveEditorExecutable(root)).toBe(editorPath);
            expect(resolveEditorExecutable(path.join(root, 'missing'))).toBeUndefined();
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('GetLegacyLicenseVersion', () => {
    it('detects 4.x and 5.x editors', () => {
        expect(GetLegacyLicenseVersion('/Applications/Unity/Hub/Editor/Unity 4.7.2/Unity.app/Contents/MacOS/Unity')).toBe('4.x');
        expect(GetLegacyLicenseVersion('C:\\Program Files\\Unity\\Hub\\Editor\\5.6.7f1\\Editor\\Unity.exe')).toBe('5.x');
    });

    it('returns undefined for newer editors or no editor', () => {
        expect(GetLegacyLicenseVersion('/opt/unity/6000.0.0f1/Editor/Unity')).toBeUndefined();
        expect(GetLegacyLicenseVersion(undefined)).toBeUndefined();
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

    afterAll(() => {
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
        jest.spyOn(cli, 'RunJson').mockImplementation(async (args: string[]) => {
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
        jest.spyOn(UnityCli, 'Get').mockResolvedValue(cli);
        return calls;
    };

    it('uses the Unity CLI when it activates the license', async () => {
        const calls = mockCli({
            'license activate': { exitCode: 0 },
            'license status': { exitCode: 0, data: { active: true } },
        });
        const fallback = jest.spyOn(LicensingClient.prototype, 'Activate');

        await ActivateLicense({ licenseType: LicenseType.personal, username: 'user@example.com', password: 'secret' });

        expect(calls[0]).toEqual(['license', 'activate', '--personal', '--accept-eula']);
        expect(fallback).not.toHaveBeenCalled();
    });

    it('falls back to the licensing client when the Unity CLI fails', async () => {
        mockCli({ 'license activate': { exitCode: 3 } });
        const fallback = jest.spyOn(LicensingClient.prototype, 'Activate').mockResolvedValue(undefined);

        await ActivateLicense({ licenseType: LicenseType.personal, username: 'user@example.com', password: 'secret' });

        expect(fallback).toHaveBeenCalledTimes(1);
    });

    it('falls back when the Unity CLI reports no active license', async () => {
        mockCli({
            'license activate': { exitCode: 0 },
            'license status': { exitCode: 4, data: { active: false } },
        });
        const fallback = jest.spyOn(LicensingClient.prototype, 'Activate').mockResolvedValue(undefined);

        await ActivateLicense({ licenseType: LicenseType.personal, username: 'user@example.com', password: 'secret' });

        expect(fallback).toHaveBeenCalledTimes(1);
    });

    it('uses the licensing client directly for 5.x editors', async () => {
        process.env.UNITY_EDITOR_PATH = 'C:\\Unity\\5.6.7f1\\Editor\\Unity.exe';
        const calls = mockCli({});
        const fallback = jest.spyOn(LicensingClient.prototype, 'Activate').mockResolvedValue(undefined);

        await ActivateLicense({ licenseType: LicenseType.personal, username: 'user@example.com', password: 'secret' });

        expect(calls).toHaveLength(0);
        expect(fallback).toHaveBeenCalledTimes(1);
    });

    it('returns through the Unity CLI and verifies nothing is still active', async () => {
        const calls = mockCli({
            'license return': { exitCode: 0 },
            'license status': { exitCode: 4, data: { active: false } },
        });
        const fallback = jest.spyOn(LicensingClient.prototype, 'Deactivate');

        await ReturnLicense(LicenseType.personal);

        expect(calls[0]).toEqual(['license', 'return', '--yes']);
        expect(fallback).not.toHaveBeenCalled();
    });

    it('returns through the licensing client when a license is still active', async () => {
        mockCli({
            'license return': { exitCode: 0 },
            'license status': { exitCode: 0, data: { active: true } },
        });
        const fallback = jest.spyOn(LicensingClient.prototype, 'Deactivate').mockResolvedValue(undefined);

        await ReturnLicense(LicenseType.personal);

        expect(fallback).toHaveBeenCalledTimes(1);
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

            expect(calls).toHaveLength(0);
        });

        it('returns a professional license under auto', async () => {
            const calls = mockCli({
                'license return': { exitCode: 0 },
                'license status': { exitCode: 4, data: { active: false } },
            });
            const warn = jest.spyOn(Logger.instance, 'warn');

            await ReturnLicense(LicenseType.professional);

            expect(calls[0]).toEqual(['license', 'return', '--yes']);
            expect(warn).not.toHaveBeenCalled();
        });

        it('warns about the seat when a professional return is skipped', async () => {
            const calls = mockCli({});
            const warn = jest.spyOn(Logger.instance, 'warn').mockImplementation(() => undefined);

            await ReturnLicense(LicenseType.professional, undefined, 'never');

            expect(calls).toHaveLength(0);
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('id.unity.com > My Seats'));
        });

        it('warns about the seat when a professional return fails', async () => {
            mockCli({ 'license return': { exitCode: 3 } });
            jest.spyOn(LicensingClient.prototype, 'Deactivate').mockRejectedValue(new Error('no seat'));
            const warn = jest.spyOn(Logger.instance, 'warn').mockImplementation(() => undefined);

            await expect(ReturnLicense(LicenseType.professional)).rejects.toThrow('no seat');

            expect(warn).toHaveBeenCalledWith(expect.stringContaining('id.unity.com > My Seats'));
        });
    });
});

describe('licensing client output redaction', () => {
    it('never logs the email, password or serial from the command or its output', async () => {
        const client = new LicensingClient('6.x');
        (client as any).licenseClientPath = process.execPath;
        const written: string[] = [];
        jest.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
            written.push(String(chunk));
            return true;
        });

        await (client as any).exec(['-e', 'console.log(process.argv.slice(1).join(" "))', '--', '--username', 'user@example.com', '--password', 'hunter2222', '--serial', 'AB-CDEF-1234-5678']);

        const logged = written.join('');
        expect(logged).not.toContain('user@example.com');
        expect(logged).not.toContain('hunter2222');
        expect(logged).not.toContain('AB-CDEF-1234-5678');
        expect(logged).toContain('*****');
    });
});

describe('UnityCli.GetLicensingClientPath', () => {
    it('installs the licensing client with license status, which works without a Unity ID session', async () => {
        const cli = new UnityCli('unity', '1.0.0');
        const calls: string[][] = [];
        jest.spyOn(cli, 'RunJson').mockImplementation(async (args: string[]) => {
            calls.push(args);
            // a headless runner has no Unity ID session, so license commands exit 3 (not signed in)
            const exitCode = args[0] === 'license' ? 3 : 0;
            return { exitCode, envelope: { success: exitCode === 0, data: {} }, stdout: '', stderr: '' } as any;
        });

        await expect(cli.GetLicensingClientPath()).resolves.toBeUndefined();
        expect(calls).toEqual([['license', 'status'], ['doctor']]);
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
        expect(fs.existsSync(source)).toBe(false);
        expect(fs.readlinkSync(path.join(destination, 'MonoDevelop.app'))).toBe('/Applications/MonoDevelop.app');
        expect(fs.readlinkSync(path.join(destination, 'tool-link'))).toBe('bin/tool');
        expect(fs.statSync(path.join(destination, 'bin', 'tool')).mode & 0o777).toBe(0o755);
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
            jest.spyOn(fs.promises, 'rename').mockRejectedValueOnce(Object.assign(new Error('cross-device link'), { code: 'EXDEV' }));
            await moveMacInstalledItem(source, destination);
            expectMoved(source, destination);
            expect(fs.existsSync(path.join(destination, 'stale'))).toBe(false);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
