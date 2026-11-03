import { describe, it, before, after, beforeEach, afterEach, mock } from 'node:test';
import * as assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'node:module';
import { Logger, LogLevel } from '../dist/logging.js';
import { ReportFailure } from '../dist/failure-markers.js';
import { UnityInstaller } from '../dist/unity-installer.js';
import { UnityVersion } from '../dist/unity-version.js';
import {
    BuildSecurityAlertRerunCommand,
    QuoteShellArgument,
    FormatUnitySecurityAlert,
    GetLegacySecurityAlert,
    GetUnitySecurityAlert,
    IsSecurityAlertAllowedByEnv,
    IsSecurityLabel,
    ParseLabelDescription,
    SECURITY_ALERT_TITLE,
    UnitySecurityAlertError,
} from '../dist/unity-security.js';

// the package index re-exports its client through getters, so mock the client where it is defined
const releasesClient = createRequire(import.meta.url)('@rage-against-the-pixel/unity-releases-api/dist/client.js');

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

const mockGetUnityReleases = mock.fn();

function mockReleasesApi(): void {
    mockGetUnityReleases.mock.mockImplementation(async (request: { query: { version: string } }) => ({
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
        RunJson: mock.fn(async (args: string[]) => {
            if (args[0] === 'editors' && args[1] === 'info') {
                return { exitCode: 0, envelope: { success: true, data: { modules: [] }, warnings }, stdout: '', stderr: '' };
            }

            return { exitCode: 0, envelope: { success: true, data: { path: editorPath } }, stdout: '', stderr: '' };
        }),
        Run: mock.fn(async () => ({ exitCode: 1, stdout: '', stderr: '' })),
        GetInstallPath: mock.fn(async () => editorDir),
    };
}

describe('Unity Security Alert', () => {
    let annotate: ReturnType<typeof mock.method>;
    let warn: ReturnType<typeof mock.method>;

    before(() => {
        editorDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unity-security-'));
        editorPath = path.join(editorDir, process.platform === 'win32' ? 'Unity.exe' : 'Unity');
        fs.writeFileSync(editorPath, '', { mode: 0o755 });
    });

    after(() => {
        fs.rmSync(editorDir, { recursive: true, force: true });
    });

    beforeEach(() => {
        mockGetUnityReleases.mock.resetCalls();
        delete process.env.UNITY_ALLOW_SECURITY_ALERT;
        mock.method(releasesClient, 'UnityReleasesClient', function () {
            return { api: { Release: { getUnityReleases: mockGetUnityReleases } } };
        });
        mockReleasesApi();
        annotate = mock.method(Logger.instance, 'annotate', () => { });
        warn = mock.method(Logger.instance, 'warn', () => { });
    });

    afterEach(() => {
        mock.restoreAll();
        delete process.env.UNITY_ALLOW_SECURITY_ALERT;
    });

    it('reads Unity\'s text without the HTML and keeps the advisory link', () => {
        assert.deepEqual(ParseLabelDescription(SECURITY_LABEL.description), {
            text: 'Applications built with this Editor version have a known security issue. Update Editor before publishing. Read more: https://unity.com/security/sept-2025-01',
            links: ['https://unity.com/security/sept-2025-01'],
        });
        assert.deepEqual(ParseLabelDescription('a &amp;lt; b <a href="javascript:alert(1)">x</a>'), { text: 'a &lt; b x', links: [] });
    });

    it('converts label HTML into text with each link after its text', () => {
        // attributes in any order, single or double quotes
        assert.deepEqual(ParseLabelDescription('See <a href=\'https://a.example/x\' target="_blank">this</a> and <a target=\'_blank\' class="c" href="http://b.example/y">that</a>.'), {
            text: 'See this: https://a.example/x and that: http://b.example/y',
            links: ['https://a.example/x', 'http://b.example/y'],
        });
        // named and numeric entities, decoded once
        assert.equal(ParseLabelDescription('Fish &amp; chips &lt;b&gt; &quot;q&quot; &#39;s&#39; &#8212; &#x2014; &amp;lt;').text, 'Fish & chips <b> "q" \'s\' — — &lt;');
        // <br> becomes a space and other tags are dropped
        assert.equal(ParseLabelDescription('Line one.<br/>Line <b>two</b>.<br> <i>Three</i>').text, 'Line one. Line two. Three');
        // punctuation after a link before more text becomes a separator, so no URL ends in punctuation
        assert.equal(ParseLabelDescription('Read <a href="https://a.example/x">this</a>, then update.').text, 'Read this: https://a.example/x | then update.');
        // no link
        assert.deepEqual(ParseLabelDescription('No link here.'), { text: 'No link here.', links: [] });
        // only http and https links survive
        assert.deepEqual(ParseLabelDescription('Bad <a href="javascript:alert(1)">x</a> <a href="data:text/html,hi">y</a>.'), { text: 'Bad x y.', links: [] });
    });

    it('treats Security in the label text or the error color as a security alert', () => {
        assert.equal(IsSecurityLabel(SECURITY_LABEL), true);
        assert.equal(IsSecurityLabel({ labelText: 'Security Alert' }), true);
        assert.equal(IsSecurityLabel({ labelText: 'Known issue', color: 'ERROR' }), true);
        assert.equal(IsSecurityLabel({ labelText: 'Known issue', color: 'WARNING' }), false);
        assert.equal(IsSecurityLabel(undefined), false);
    });

    it('reports a labelled release with the newest unlabelled release on its branch', async () => {
        const alert = await GetUnitySecurityAlert(new UnityVersion('2022.3.62f1', '1a2b3c4d5e6f', 'X86_64'));

        assert.notEqual(alert, undefined);
        assert.equal(FormatUnitySecurityAlert(alert!, true),
            'Unity Security Alert for 2022.3.62f1 (allowed): Applications built with this Editor version have a known security issue. Update Editor before publishing. Read more: https://unity.com/security/sept-2025-01 | Patched: 2022.3.62f3');
        assert.equal(FormatUnitySecurityAlert(alert!, false),
            'Unity Security Alert for 2022.3.62f1: Applications built with this Editor version have a known security issue. Update Editor before publishing. Read more: https://unity.com/security/sept-2025-01 | Patched: 2022.3.62f3\n' +
            'Pass --allow-security-alert or set UNITY_ALLOW_SECURITY_ALERT=1 to continue.');
    });

    it('passes an unlabelled release', async () => {
        assert.equal(await GetUnitySecurityAlert(new UnityVersion('2022.3.62f3', '96770f904ca7', 'X86_64')), undefined);
        assert.equal(warn.mock.callCount(), 0);
    });

    it('says when a branch has no patched release and points to the advisory', async () => {
        const alert = await GetUnitySecurityAlert(new UnityVersion('2018.4.36f1', '6cd387d23174', 'X86_64'));

        assert.equal(alert!.patched, 'No patched release on this branch');
        assert.ok(alert!.summary.includes('Read more: https://unity.com/security/sept-2025-01 | No patched release on this branch'));
    });

    it('reads every page of the branch and suggests an older unlabelled release when the newer ones are labelled', async () => {
        const labelledRows = Array.from({ length: 30 }, (_, i) => ({ version: `2022.3.${100 - i}f1`, shortRevision: `l${i}`, label: SECURITY_LABEL }));
        const branchRows = [...labelledRows, { version: '2022.3.62f3', shortRevision: '96770f904ca7' }];
        mockGetUnityReleases.mock.mockImplementation(async (request: { query: { version: string; offset?: number; limit?: number } }) => {
            const { version, offset = 0, limit = 25 } = request.query;
            const rows = version === '2022.3' ? branchRows : [{ version: '2022.3.100f1', shortRevision: 'l0', label: SECURITY_LABEL }];
            return { data: { results: rows.slice(offset, offset + limit) }, error: undefined };
        });

        const alert = await GetUnitySecurityAlert(new UnityVersion('2022.3.100f1', 'l0', 'X86_64'));

        assert.equal(alert!.patched, 'Patched: 2022.3.62f3');
        assert.deepEqual(mockGetUnityReleases.mock.calls.filter(call => call.arguments[0].query.version === '2022.3').map(call => call.arguments[0].query.offset), [0, 25]);
    });

    it('warns and continues when the Releases API cannot be reached', async () => {
        mockGetUnityReleases.mock.mockImplementation(async () => { throw new Error('fetch failed'); });

        assert.equal(await GetUnitySecurityAlert(new UnityVersion('2022.3.62f1', '1a2b3c4d5e6f', 'X86_64')), undefined);
        assert.ok(warn.mock.calls.some(call => call.arguments.length === 1 && String(call.arguments[0]).includes('could not check Unity security status for 2022.3.62f1')));
    });

    it('skips 4.x and 5.x without asking the Releases API', async () => {
        assert.equal(await GetUnitySecurityAlert(new UnityVersion('4.7.2f1', undefined, 'X86_64')), undefined);
        assert.equal(await GetUnitySecurityAlert(new UnityVersion('5.6.7f1', 'e80cc3114ac1', 'X86_64')), undefined);
        assert.equal(mockGetUnityReleases.mock.callCount(), 0);
        assert.equal(warn.mock.callCount(), 0);
    });

    describe('4.x and 5.x', () => {
        it('lists both editor CVEs for 5.6 before their fixes', () => {
            const alert = GetLegacySecurityAlert(new UnityVersion('5.6.2f1', undefined, 'X86_64'))!;

            assert.equal(FormatUnitySecurityAlert(alert, false, 'unity-cli setup-unity -u 5.6.2f1 --allow-security-alert'), [
                'Unity Security Alert for 5.6.2f1: Applications built with this Editor version have known security issues. Read more: https://unity.com/security | CVE-2017-12939: https://nvd.nist.gov/vuln/detail/CVE-2017-12939 | CVE-2019-9197: https://nvd.nist.gov/vuln/detail/CVE-2019-9197 | No patched release on this branch',
                'To continue, re-run: unity-cli setup-unity -u 5.6.2f1 --allow-security-alert (or set UNITY_ALLOW_SECURITY_ALERT=1)',
            ].join('\n'));
        });

        it('orders patch releases after the final release of the same patch number', () => {
            assert.ok(GetLegacySecurityAlert(new UnityVersion('5.3.8f1', undefined, 'X86_64'))!.summary.includes('CVE-2017-12939'));
            assert.ok(!GetLegacySecurityAlert(new UnityVersion('5.3.8p2', undefined, 'X86_64'))!.summary.includes('CVE-2017-12939'));
        });

        it('lists only the CVEs that reach the version', () => {
            const legacy4 = GetLegacySecurityAlert(new UnityVersion('4.7.2', undefined, 'X86_64'))!;
            assert.equal(FormatUnitySecurityAlert(legacy4, true),
                'Unity Security Alert for 4.7.2 (allowed): Applications built with this Editor version have known security issues. Read more: https://unity.com/security | CVE-2017-12939: https://nvd.nist.gov/vuln/detail/CVE-2017-12939 | No patched release on this branch');

            const legacy55 = GetLegacySecurityAlert(new UnityVersion('5.5.0f3', undefined, 'X86_64'))!;
            assert.ok(legacy55.summary.includes('CVE-2017-12939'));
            assert.ok(!legacy55.summary.includes('CVE-2019-9197'));
        });

        it('still alerts when no CVE names the version, pointing to Unity\'s advisories', () => {
            const alert = GetLegacySecurityAlert(new UnityVersion('5.6.7f1', 'e80cc3114ac1', 'X86_64'))!;

            assert.deepEqual(alert.details, []);
            assert.equal(alert.summary, 'Applications built with this Editor version have known security issues. Read more: https://unity.com/security | No patched release on this branch');
        });

        it('does not apply to 2017 and newer', () => {
            assert.equal(GetLegacySecurityAlert(new UnityVersion('2017.4.40f1', undefined, 'X86_64')), undefined);
        });

        it('stops setup before anything is found or downloaded without the opt-in', async () => {
            const cli = fakeCli();
            const installer = new UnityInstaller(cli as never);
            const error = await installer.GetEditor(new UnityVersion('5.6.7f1', 'e80cc3114ac1', 'X86_64'), [], ['f'], { securityAlert: 'enforce' }).catch(e => e);

            assert.ok(error instanceof UnitySecurityAlertError);
            assert.ok(error.message.includes('Pass --allow-security-alert or set UNITY_ALLOW_SECURITY_ALERT=1 to continue.'));
            assert.equal(cli.RunJson.mock.callCount(), 0);
            assert.equal(cli.Run.mock.callCount(), 0);
            assert.equal(mockGetUnityReleases.mock.callCount(), 0);
        });

        it('warns with the opt-in and carries on to the install', async () => {
            const installer = new UnityInstaller(fakeCli() as never);
            // past the alert, 4.x installs need Windows or macOS, so the install itself is stopped here
            mock.method(installer as never, 'installLegacyEditor', async () => { throw new Error('install skipped') as never; });
            const error = await installer.GetEditor(new UnityVersion('4.7.2', undefined, 'X86_64'), [], ['f'], { securityAlert: 'allow' }).catch(e => e);

            assert.equal(error.message, 'install skipped');
            assert.ok(annotate.mock.calls.some(call => isDeepStrictEqual(call.arguments, [LogLevel.WARN, call.arguments[1], undefined, undefined, undefined, undefined, undefined, SECURITY_ALERT_TITLE]) && String(call.arguments[1]).includes('Unity Security Alert for 4.7.2 (allowed):')));
        });
    });

    it('rebuilds the command line for the re-run hint without secrets', () => {
        assert.equal(BuildSecurityAlertRerunCommand(['setup-unity', '-u', '2022.3.62f1', '-p', 'My Project'], 'unity-cli', 'linux'), 'unity-cli setup-unity -u 2022.3.62f1 -p \'My Project\' --allow-security-alert');
        assert.equal(BuildSecurityAlertRerunCommand(['run', '--unity-project', 'p', '-quit', '-username', 'me@example.com', '-password', 'hunter2', '--token=abc'], 'unity-cli', 'linux'), 'unity-cli run --unity-project p -quit -username <redacted> -password <redacted> --token=<redacted> --allow-security-alert');
        assert.equal(BuildSecurityAlertRerunCommand(['setup-unity', '-u', '4.7.2', '--allow-security-alert'], 'unity-cli', 'win32'), 'unity-cli setup-unity -u 4.7.2 --allow-security-alert');
    });

    it('quotes re-run arguments for a POSIX shell', () => {
        const q = (arg: string) => QuoteShellArgument(arg, 'linux');
        assert.equal(q('plain-arg_1.2'), 'plain-arg_1.2');
        assert.equal(q('my proj'), '\'my proj\'');
        assert.equal(q('dir\\'), '\'dir\\\'');
        assert.equal(q('it\'s'), '\'it\'\\\'\'s\'');
        assert.equal(q('say "hi"'), '\'say "hi"\'');
        assert.equal(q('$HOME'), '\'$HOME\'');
        assert.equal(q('`date`'), '\'`date`\'');
        assert.equal(q(''), '\'\'');
    });

    it('quotes re-run arguments for PowerShell on Windows', () => {
        const q = (arg: string) => QuoteShellArgument(arg, 'win32');
        assert.equal(q('C:\\Projects\\Game'), 'C:\\Projects\\Game');
        assert.equal(q('C:\\My Projects\\Game\\'), '\'C:\\My Projects\\Game\\\'');
        assert.equal(q('it\'s'), '\'it\'\'s\'');
        assert.equal(q('say "hi"'), '\'say "hi"\'');
        assert.equal(q('$env:HOME'), '\'$env:HOME\'');
        assert.equal(q('`n'), '\'`n\'');
        assert.equal(q(''), '\'\'');
    });
    it('accepts UNITY_ALLOW_SECURITY_ALERT=1 or true only', () => {
        assert.equal(IsSecurityAlertAllowedByEnv(), false);
        process.env.UNITY_ALLOW_SECURITY_ALERT = '1';
        assert.equal(IsSecurityAlertAllowedByEnv(), true);
        process.env.UNITY_ALLOW_SECURITY_ALERT = 'TRUE';
        assert.equal(IsSecurityAlertAllowedByEnv(), true);
        process.env.UNITY_ALLOW_SECURITY_ALERT = 'no';
        assert.equal(IsSecurityAlertAllowedByEnv(), false);
    });

    describe('setup', () => {
        const labelled = () => new UnityVersion('2022.3.62f1', '1a2b3c4d5e6f', 'X86_64');

        it('stops before anything is found or installed without the opt-in', async () => {
            const cli = fakeCli();
            const installer = new UnityInstaller(cli as never);
            const error = await installer.GetEditor(labelled(), [], ['f'], { securityAlert: 'enforce' }).catch(e => e);

            assert.ok(error instanceof UnitySecurityAlertError);
            assert.ok(error.message.includes('Unity Security Alert for 2022.3.62f1:'));
            assert.ok(error.message.includes('Patched: 2022.3.62f3'));
            assert.ok(error.message.includes('Pass --allow-security-alert or set UNITY_ALLOW_SECURITY_ALERT=1 to continue.'));
            assert.deepEqual(cli.RunJson.mock.calls.map(call => call.arguments[0].slice(0, 2).join(' ')), ['editors info']);
            assert.equal(cli.Run.mock.callCount(), 0);
        });

        it('reports the stop as an error annotation titled Unity Security Alert', () => {
            ReportFailure(new UnitySecurityAlertError('alert text'));
            assert.ok(annotate.mock.calls.some(call => isDeepStrictEqual(call.arguments, [LogLevel.ERROR, 'alert text', undefined, undefined, undefined, undefined, undefined, SECURITY_ALERT_TITLE])));
        });

        it('warns and continues with --allow-security-alert', async () => {
            const installer = new UnityInstaller(fakeCli() as never);
            const editor = await installer.GetEditor(labelled(), [], ['f'], { securityAlert: 'allow' });

            assert.equal(editor.editorPath, path.normalize(editorPath));
            assert.ok(annotate.mock.calls.some(call => isDeepStrictEqual(call.arguments, [LogLevel.WARN, call.arguments[1], undefined, undefined, undefined, undefined, undefined, SECURITY_ALERT_TITLE]) && String(call.arguments[1]).includes('Patched: 2022.3.62f3')));
        });

        it('warns and continues with UNITY_ALLOW_SECURITY_ALERT', async () => {
            process.env.UNITY_ALLOW_SECURITY_ALERT = 'true';
            const installer = new UnityInstaller(fakeCli() as never);
            const editor = await installer.GetEditor(labelled(), [], ['f'], { securityAlert: IsSecurityAlertAllowedByEnv() ? 'allow' : 'enforce' });

            assert.equal(editor.editorPath, path.normalize(editorPath));
            assert.ok(annotate.mock.calls.some(call => isDeepStrictEqual(call.arguments, [LogLevel.WARN, call.arguments[1], undefined, undefined, undefined, undefined, undefined, SECURITY_ALERT_TITLE]) && String(call.arguments[1]).includes('Unity Security Alert for 2022.3.62f1 (allowed):')));
        });

        it('prints the official CLI\'s own security warning instead of the Releases API text', async () => {
            const cliWarning = { code: 'SECURITY_ALERT', message: 'Unity 2022.3.62f1 has a known security issue.' };
            const installer = new UnityInstaller(fakeCli([cliWarning, 'Some other warning']) as never);
            const error = await installer.GetEditor(labelled(), [], ['f'], { securityAlert: 'enforce' }).catch(e => e);

            assert.ok(error instanceof UnitySecurityAlertError);
            assert.ok(error.message.includes('Unity Security Alert for 2022.3.62f1: SECURITY_ALERT: Unity 2022.3.62f1 has a known security issue. | Patched: 2022.3.62f3'));
            assert.ok(!error.message.includes('Applications built with this Editor version'));
            assert.ok(annotate.mock.calls.some(call => isDeepStrictEqual(call.arguments, [LogLevel.WARN, 'Some other warning'])));
        });

        it('enforces by default, and allows with UNITY_ALLOW_SECURITY_ALERT', async () => {
            const blocked = await new UnityInstaller(fakeCli() as never).GetEditor(labelled()).catch(e => e);
            assert.ok(blocked instanceof UnitySecurityAlertError);

            process.env.UNITY_ALLOW_SECURITY_ALERT = '1';
            const editor = await new UnityInstaller(fakeCli() as never).GetEditor(labelled());
            assert.equal(editor.editorPath, path.normalize(editorPath));
        });

        it('shows the command to re-run with the opt-in', async () => {
            const error = await new UnityInstaller(fakeCli() as never)
                .GetEditor(labelled(), [], ['f'], { securityAlert: 'enforce', rerunCommand: 'unity-cli setup-unity -u 2022.3.62f1 --allow-security-alert' })
                .catch(e => e);
            assert.ok(error.message.includes('To continue, re-run: unity-cli setup-unity -u 2022.3.62f1 --allow-security-alert (or set UNITY_ALLOW_SECURITY_ALERT=1)'));
        });

        it('checks an editor a command selects without installing it, the same way', async () => {
            const cli = fakeCli();
            const installer = new UnityInstaller(cli as never);

            await assert.rejects(installer.CheckSecurityAlert(labelled(), 'enforce'), UnitySecurityAlertError);
            await assert.rejects(installer.CheckSecurityAlert(new UnityVersion('4.7.2', undefined, 'X86_64'), 'enforce'), UnitySecurityAlertError);
            assert.equal(await installer.CheckSecurityAlert(new UnityVersion('2022.3.62f3', '96770f904ca7', 'X86_64'), 'enforce'), undefined);
            await installer.CheckSecurityAlert(labelled(), 'allow');
            assert.ok(annotate.mock.calls.some(call => isDeepStrictEqual(call.arguments, [LogLevel.WARN, call.arguments[1], undefined, undefined, undefined, undefined, undefined, SECURITY_ALERT_TITLE]) && String(call.arguments[1]).includes('Unity Security Alert for 2022.3.62f1 (allowed):')));
            assert.equal(cli.Run.mock.callCount(), 0);
        });
    });
});
