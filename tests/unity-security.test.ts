import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { UnityReleasesClient } from '@rage-against-the-pixel/unity-releases-api';
import { Logger, LogLevel } from '../src/logging';
import { ReportFailure } from '../src/failure-markers';
import { UnityInstaller } from '../src/unity-installer';
import { UnityVersion } from '../src/unity-version';
import {
    FormatUnitySecurityAlert,
    GetLegacySecurityAlert,
    GetUnitySecurityAlert,
    IsSecurityAlertAllowedByEnv,
    IsSecurityLabel,
    ParseLabelDescription,
    SECURITY_ALERT_TITLE,
    UnitySecurityAlertError,
} from '../src/unity-security';

jest.mock('@rage-against-the-pixel/unity-releases-api', () => {
    const actual = jest.requireActual<typeof import('@rage-against-the-pixel/unity-releases-api')>(
        '@rage-against-the-pixel/unity-releases-api'
    );
    return {
        ...actual,
        UnityReleasesClient: jest.fn(),
    };
});

const SECURITY_LABEL = {
    labelText: 'Security Alert',
    icon: 'WARNING',
    color: 'ERROR',
    description: 'Applications built with this Editor version have a known security issue. Update Editor before publishing. <a target="_blank" href="https://unity.com/security/sept-2025-01">Read more</a>.',
};

/** Rows the mocked Releases API serves, keyed by the exact version or major.minor queried. */
const RELEASES: { [query: string]: object[] } = {
    '2022.3.62f1': [{ version: '2022.3.62f1', shortRevision: '1a2b3c4d5e6f', label: SECURITY_LABEL }],
    '2022.3.62f3': [{ version: '2022.3.62f3', shortRevision: '96770f904ca7' }],
    '2022.3': [
        { version: '2022.3.63b1', shortRevision: 'beta00000000' },
        { version: '2022.3.62f3', shortRevision: '96770f904ca7' },
        { version: '2022.3.62f2', shortRevision: '7670c08855a9' },
        { version: '2022.3.62f1', shortRevision: '1a2b3c4d5e6f', label: SECURITY_LABEL },
        { version: '2022.3.61f1', shortRevision: '6b8a6b0d6f2e', label: SECURITY_LABEL },
    ],
    '2018.4.36f1': [{ version: '2018.4.36f1', shortRevision: '6cd387d23174', label: SECURITY_LABEL }],
    '2018.4': [
        { version: '2018.4.36f1', shortRevision: '6cd387d23174', label: SECURITY_LABEL },
        { version: '2018.4.35f1', shortRevision: '4cb7aa0a2d2c', label: SECURITY_LABEL },
    ],
};

const mockGetUnityReleases = jest.fn();

function mockReleasesApi(): void {
    mockGetUnityReleases.mockImplementation(async (request: { query: { version: string } }) => ({
        data: { results: RELEASES[request.query.version] ?? [] },
        error: undefined,
    }));
}

let editorDir: string;
let editorPath: string;

/** A stand-in for the official Unity CLI: `editors info` returns the warnings, `editors path` an installed editor. */
function fakeCli(warnings: unknown[] = []) {
    return {
        executable: 'unity',
        version: '1.0.0-beta.14',
        RunJson: jest.fn(async (args: string[]) => {
            if (args[0] === 'editors' && args[1] === 'info') {
                return { exitCode: 0, envelope: { success: true, data: { modules: [] }, warnings }, stdout: '', stderr: '' };
            }

            return { exitCode: 0, envelope: { success: true, data: { path: editorPath } }, stdout: '', stderr: '' };
        }),
        Run: jest.fn(async () => ({ exitCode: 1, stdout: '', stderr: '' })),
        GetInstallPath: jest.fn(async () => editorDir),
    };
}

describe('Unity Security Alert', () => {
    let annotate: jest.SpyInstance;
    let warn: jest.SpyInstance;

    beforeAll(() => {
        editorDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unity-security-'));
        editorPath = path.join(editorDir, process.platform === 'win32' ? 'Unity.exe' : 'Unity');
        fs.writeFileSync(editorPath, '', { mode: 0o755 });
    });

    afterAll(() => {
        fs.rmSync(editorDir, { recursive: true, force: true });
    });

    beforeEach(() => {
        jest.clearAllMocks();
        delete process.env.UNITY_ALLOW_SECURITY_ALERT;
        (UnityReleasesClient as jest.Mock).mockImplementation(() => ({
            api: { Release: { getUnityReleases: mockGetUnityReleases } },
        }));
        mockReleasesApi();
        annotate = jest.spyOn(Logger.instance, 'annotate').mockImplementation(() => { });
        warn = jest.spyOn(Logger.instance, 'warn').mockImplementation(() => { });
    });

    afterEach(() => {
        annotate.mockRestore();
        warn.mockRestore();
        delete process.env.UNITY_ALLOW_SECURITY_ALERT;
    });

    it('reads Unity\'s text without the HTML and keeps the advisory link', () => {
        expect(ParseLabelDescription(SECURITY_LABEL.description)).toEqual({
            text: 'Applications built with this Editor version have a known security issue. Update Editor before publishing. Read more: https://unity.com/security/sept-2025-01',
            links: ['https://unity.com/security/sept-2025-01'],
        });
        expect(ParseLabelDescription('a &amp;lt; b <a href="javascript:alert(1)">x</a>')).toEqual({ text: 'a &lt; b x', links: [] });
    });

    it('converts label HTML into text with each link after its text', () => {
        // attributes in any order, single or double quotes
        expect(ParseLabelDescription('See <a href=\'https://a.example/x\' target="_blank">this</a> and <a target=\'_blank\' class="c" href="http://b.example/y">that</a>.')).toEqual({
            text: 'See this: https://a.example/x and that: http://b.example/y',
            links: ['https://a.example/x', 'http://b.example/y'],
        });
        // named and numeric entities, decoded once
        expect(ParseLabelDescription('Fish &amp; chips &lt;b&gt; &quot;q&quot; &#39;s&#39; &#8212; &#x2014; &amp;lt;').text).toBe('Fish & chips <b> "q" \'s\' — — &lt;');
        // <br> becomes a space and other tags are dropped
        expect(ParseLabelDescription('Line one.<br/>Line <b>two</b>.<br> <i>Three</i>').text).toBe('Line one. Line two. Three');
        // punctuation after a link before more text becomes a separator, so no URL ends in punctuation
        expect(ParseLabelDescription('Read <a href="https://a.example/x">this</a>, then update.').text).toBe('Read this: https://a.example/x | then update.');
        // no link
        expect(ParseLabelDescription('No link here.')).toEqual({ text: 'No link here.', links: [] });
        // only http and https links survive
        expect(ParseLabelDescription('Bad <a href="javascript:alert(1)">x</a> <a href="data:text/html,hi">y</a>.')).toEqual({ text: 'Bad x y.', links: [] });
    });

    it('treats Security in the label text or the error color as a security alert', () => {
        expect(IsSecurityLabel(SECURITY_LABEL)).toBe(true);
        expect(IsSecurityLabel({ labelText: 'Security Alert' })).toBe(true);
        expect(IsSecurityLabel({ labelText: 'Known issue', color: 'ERROR' })).toBe(true);
        expect(IsSecurityLabel({ labelText: 'Known issue', color: 'WARNING' })).toBe(false);
        expect(IsSecurityLabel(undefined)).toBe(false);
    });

    it('reports a labelled release with the newest unlabelled release on its branch', async () => {
        const alert = await GetUnitySecurityAlert(new UnityVersion('2022.3.62f1', '1a2b3c4d5e6f', 'X86_64'));

        expect(alert).toBeDefined();
        expect(FormatUnitySecurityAlert(alert!, true)).toBe(
            'Unity Security Alert for 2022.3.62f1 (allowed): Applications built with this Editor version have a known security issue. Update Editor before publishing. Read more: https://unity.com/security/sept-2025-01 | Patched: 2022.3.62f3');
        expect(FormatUnitySecurityAlert(alert!, false)).toBe(
            'Unity Security Alert for 2022.3.62f1: Applications built with this Editor version have a known security issue. Update Editor before publishing. Read more: https://unity.com/security/sept-2025-01 | Patched: 2022.3.62f3\n' +
            'Pass --allow-security-alert or set UNITY_ALLOW_SECURITY_ALERT=1 to continue.');
    });

    it('passes an unlabelled release', async () => {
        await expect(GetUnitySecurityAlert(new UnityVersion('2022.3.62f3', '96770f904ca7', 'X86_64'))).resolves.toBeUndefined();
        expect(warn).not.toHaveBeenCalled();
    });

    it('says when a branch has no patched release and points to the advisory', async () => {
        const alert = await GetUnitySecurityAlert(new UnityVersion('2018.4.36f1', '6cd387d23174', 'X86_64'));

        expect(alert!.patched).toBe('No patched release on this branch');
        expect(alert!.summary).toContain('Read more: https://unity.com/security/sept-2025-01 | No patched release on this branch');
    });

    it('reads every page of the branch and suggests an older unlabelled release when the newer ones are labelled', async () => {
        const labelledRows = Array.from({ length: 30 }, (_, i) => ({ version: `2022.3.${100 - i}f1`, shortRevision: `l${i}`, label: SECURITY_LABEL }));
        const branchRows = [...labelledRows, { version: '2022.3.62f3', shortRevision: '96770f904ca7' }];
        mockGetUnityReleases.mockImplementation(async (request: { query: { version: string; offset?: number; limit?: number } }) => {
            const { version, offset = 0, limit = 25 } = request.query;
            const rows = version === '2022.3' ? branchRows : [{ version: '2022.3.100f1', shortRevision: 'l0', label: SECURITY_LABEL }];
            return { data: { results: rows.slice(offset, offset + limit) }, error: undefined };
        });

        const alert = await GetUnitySecurityAlert(new UnityVersion('2022.3.100f1', 'l0', 'X86_64'));

        expect(alert!.patched).toBe('Patched: 2022.3.62f3');
        expect(mockGetUnityReleases.mock.calls.filter(call => call[0].query.version === '2022.3').map(call => call[0].query.offset)).toEqual([0, 25]);
    });

    it('warns and continues when the Releases API cannot be reached', async () => {
        mockGetUnityReleases.mockRejectedValue(new Error('fetch failed'));

        await expect(GetUnitySecurityAlert(new UnityVersion('2022.3.62f1', '1a2b3c4d5e6f', 'X86_64'))).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not check Unity security status for 2022.3.62f1'));
    });

    it('skips 4.x and 5.x without asking the Releases API', async () => {
        await expect(GetUnitySecurityAlert(new UnityVersion('4.7.2f1', undefined, 'X86_64'))).resolves.toBeUndefined();
        await expect(GetUnitySecurityAlert(new UnityVersion('5.6.7f1', 'e80cc3114ac1', 'X86_64'))).resolves.toBeUndefined();
        expect(mockGetUnityReleases).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
    });

    describe('4.x and 5.x', () => {
        it('lists both editor CVEs for 5.6 before their fixes', () => {
            const alert = GetLegacySecurityAlert(new UnityVersion('5.6.2f1', undefined, 'X86_64'))!;

            expect(FormatUnitySecurityAlert(alert, false)).toBe([
                'Unity Security Alert for 5.6.2f1: Applications built with this Editor version have known security issues, and Unity never patched it. Read more: https://unity.com/security',
                '  CVE-2017-12939 Windows editor RCE, fixed in 5.6.3p1 https://nvd.nist.gov/vuln/detail/CVE-2017-12939',
                '  CVE-2019-9197 editor RCE, fixed in 5.6.7f1 https://nvd.nist.gov/vuln/detail/CVE-2019-9197',
                'Pass --allow-security-alert or set UNITY_ALLOW_SECURITY_ALERT=1 to continue.',
            ].join('\n'));
        });

        it('orders patch releases after the final release of the same patch number', () => {
            expect(GetLegacySecurityAlert(new UnityVersion('5.3.8f1', undefined, 'X86_64'))!.details.join('\n')).toContain('CVE-2017-12939');
            expect(GetLegacySecurityAlert(new UnityVersion('5.3.8p2', undefined, 'X86_64'))!.details.join('\n')).not.toContain('CVE-2017-12939');
        });

        it('lists only the CVEs that reach the version', () => {
            const legacy4 = GetLegacySecurityAlert(new UnityVersion('4.7.2', undefined, 'X86_64'))!;
            expect(FormatUnitySecurityAlert(legacy4, true)).toBe([
                'Unity Security Alert for 4.7.2 (allowed): Applications built with this Editor version have known security issues, and Unity never patched it. Read more: https://unity.com/security',
                '  CVE-2017-12939 Windows editor RCE https://nvd.nist.gov/vuln/detail/CVE-2017-12939',
            ].join('\n'));

            const legacy55 = GetLegacySecurityAlert(new UnityVersion('5.5.0f3', undefined, 'X86_64'))!;
            expect(legacy55.details.join('\n')).toContain('CVE-2017-12939');
            expect(legacy55.details.join('\n')).not.toContain('CVE-2019-9197');
        });

        it('still alerts when no CVE names the version, pointing to Unity\'s advisories', () => {
            const alert = GetLegacySecurityAlert(new UnityVersion('5.6.7f1', 'e80cc3114ac1', 'X86_64'))!;

            expect(alert.details).toEqual([]);
            expect(alert.summary).toBe('Applications built with this Editor version have known security issues, and Unity never patched it. Read more: https://unity.com/security');
        });

        it('does not apply to 2017 and newer', () => {
            expect(GetLegacySecurityAlert(new UnityVersion('2017.4.40f1', undefined, 'X86_64'))).toBeUndefined();
        });

        it('stops setup before anything is found or downloaded without the opt-in', async () => {
            const cli = fakeCli();
            const installer = new UnityInstaller(cli as never);
            const error = await installer.GetEditor(new UnityVersion('5.6.7f1', 'e80cc3114ac1', 'X86_64'), [], ['f'], { securityAlert: 'enforce' }).catch(e => e);

            expect(error).toBeInstanceOf(UnitySecurityAlertError);
            expect(error.message).toContain('Pass --allow-security-alert or set UNITY_ALLOW_SECURITY_ALERT=1 to continue.');
            expect(cli.RunJson).not.toHaveBeenCalled();
            expect(cli.Run).not.toHaveBeenCalled();
            expect(mockGetUnityReleases).not.toHaveBeenCalled();
        });

        it('warns with the opt-in and carries on to the install', async () => {
            const installer = new UnityInstaller(fakeCli() as never);
            // past the alert, 4.x installs need Windows or macOS, so the install itself is stopped here
            jest.spyOn(installer as never, 'installLegacyEditor').mockRejectedValue(new Error('install skipped') as never);
            const error = await installer.GetEditor(new UnityVersion('4.7.2', undefined, 'X86_64'), [], ['f'], { securityAlert: 'allow' }).catch(e => e);

            expect(error.message).toBe('install skipped');
            expect(annotate).toHaveBeenCalledWith(LogLevel.WARN, expect.stringContaining('Unity Security Alert for 4.7.2 (allowed):'), undefined, undefined, undefined, undefined, undefined, SECURITY_ALERT_TITLE);
        });
    });

    it('accepts UNITY_ALLOW_SECURITY_ALERT=1 or true only', () => {
        expect(IsSecurityAlertAllowedByEnv()).toBe(false);
        process.env.UNITY_ALLOW_SECURITY_ALERT = '1';
        expect(IsSecurityAlertAllowedByEnv()).toBe(true);
        process.env.UNITY_ALLOW_SECURITY_ALERT = 'TRUE';
        expect(IsSecurityAlertAllowedByEnv()).toBe(true);
        process.env.UNITY_ALLOW_SECURITY_ALERT = 'no';
        expect(IsSecurityAlertAllowedByEnv()).toBe(false);
    });

    describe('setup', () => {
        const labelled = () => new UnityVersion('2022.3.62f1', '1a2b3c4d5e6f', 'X86_64');

        it('stops before anything is found or installed without the opt-in', async () => {
            const cli = fakeCli();
            const installer = new UnityInstaller(cli as never);
            const error = await installer.GetEditor(labelled(), [], ['f'], { securityAlert: 'enforce' }).catch(e => e);

            expect(error).toBeInstanceOf(UnitySecurityAlertError);
            expect(error.message).toContain('Unity Security Alert for 2022.3.62f1:');
            expect(error.message).toContain('Patched: 2022.3.62f3');
            expect(error.message).toContain('Pass --allow-security-alert or set UNITY_ALLOW_SECURITY_ALERT=1 to continue.');
            expect(cli.RunJson.mock.calls.map(call => call[0].slice(0, 2).join(' '))).toEqual(['editors info']);
            expect(cli.Run).not.toHaveBeenCalled();
        });

        it('reports the stop as an error annotation titled Unity Security Alert', () => {
            ReportFailure(new UnitySecurityAlertError('alert text'));
            expect(annotate).toHaveBeenCalledWith(LogLevel.ERROR, 'alert text', undefined, undefined, undefined, undefined, undefined, SECURITY_ALERT_TITLE);
        });

        it('warns and continues with --allow-security-alert', async () => {
            const installer = new UnityInstaller(fakeCli() as never);
            const editor = await installer.GetEditor(labelled(), [], ['f'], { securityAlert: 'allow' });

            expect(editor.editorPath).toBe(path.normalize(editorPath));
            expect(annotate).toHaveBeenCalledWith(LogLevel.WARN, expect.stringContaining('Patched: 2022.3.62f3'), undefined, undefined, undefined, undefined, undefined, SECURITY_ALERT_TITLE);
        });

        it('warns and continues with UNITY_ALLOW_SECURITY_ALERT', async () => {
            process.env.UNITY_ALLOW_SECURITY_ALERT = 'true';
            const installer = new UnityInstaller(fakeCli() as never);
            const editor = await installer.GetEditor(labelled(), [], ['f'], { securityAlert: IsSecurityAlertAllowedByEnv() ? 'allow' : 'enforce' });

            expect(editor.editorPath).toBe(path.normalize(editorPath));
            expect(annotate).toHaveBeenCalledWith(LogLevel.WARN, expect.stringContaining('Unity Security Alert for 2022.3.62f1 (allowed):'), undefined, undefined, undefined, undefined, undefined, SECURITY_ALERT_TITLE);
        });

        it('prints the official CLI\'s own security warning instead of the Releases API text', async () => {
            const cliWarning = { code: 'SECURITY_ALERT', message: 'Unity 2022.3.62f1 has a known security issue.' };
            const installer = new UnityInstaller(fakeCli([cliWarning, 'Some other warning']) as never);
            const error = await installer.GetEditor(labelled(), [], ['f'], { securityAlert: 'enforce' }).catch(e => e);

            expect(error).toBeInstanceOf(UnitySecurityAlertError);
            expect(error.message).toContain('Unity Security Alert for 2022.3.62f1: SECURITY_ALERT: Unity 2022.3.62f1 has a known security issue. Patched: 2022.3.62f3');
            expect(error.message).not.toContain('Applications built with this Editor version');
            expect(annotate).toHaveBeenCalledWith(LogLevel.WARN, 'Some other warning');
        });

        it('does not check when no policy is given', async () => {
            const installer = new UnityInstaller(fakeCli() as never);
            await installer.GetEditor(labelled());

            expect(mockGetUnityReleases).not.toHaveBeenCalled();
        });
    });
});
