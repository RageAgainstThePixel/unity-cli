#!/usr/bin/env node

import 'source-map-support/register';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Command } from 'commander';
import updateNotifier from "update-notifier";
import { Logger, LogLevel } from './logging';
import { UnityCli } from './unity-cli';
import { UnityEditor } from './unity-editor';
import { UnityInstaller } from './unity-installer';
import { UnityVersion } from './unity-version';
import { UnityProject } from './unity-project';
import { CheckAndroidSdkInstalled } from './android-sdk';
import {
    ActivateLicense,
    GetLicenseFilePath,
    LicenseType,
    LicensingClient,
    PrintLicenseContext,
    ReturnLicense,
} from './license-client';
import { PromptForSecretInput } from './utilities';
import { UpmCli, UpmPackOptions } from './upm-cli';
import { ReportFailure } from './failure-markers';

const pkgPath = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
updateNotifier({ pkg }).notify();
const program = new Command();

program.name('unity-cli')
    .description('Bridges the gaps in the official Unity CLI (unity) for CI: Unity ID licensing, Unity 4.x and 5.x editors, Android SDK setup and Editor log annotations.')
    .version(pkg.version)
    .option('--unity-cli-version <version>', 'The official Unity CLI version to use (e.g. 1.0.0-beta.14). Defaults to the UNITY_CLI_VERSION environment variable, then the latest release. Commands install it on first use.')
    .hook('preAction', (command) => {
        const version = command.opts().unityCliVersion?.toString()?.trim();

        if (version) {
            // every command resolves the official CLI through UnityCli.Get(), which reads the request from here
            process.env.UNITY_CLI_VERSION = version;
        }
    });

program.commandsGroup('Auth:');

program.command('license-version')
    .description('Print the Unity License Client version.')
    .action(async () => {
        const client = new LicensingClient();
        await client.Version();
        process.exit(0);
    });

program.command('activate-license')
    .description('Activate a Unity license. Tries the official Unity CLI first, then the Unity Licensing Client with your Unity ID email and password.')
    .option('-l, --license <license>', 'License type (personal, professional, floating). Required.')
    .option('-e, --email <email>', 'Email associated with the Unity account. Used when the Unity CLI cannot activate a personal or professional license. Defaults to the UNITY_USERNAME environment variable.')
    .option('-p, --password <password>', 'Password for the Unity account. Used when the Unity CLI cannot activate a personal or professional license. Defaults to the UNITY_PASSWORD environment variable, which keeps it off the command line.')
    .option('-s, --serial <serial>', 'License serial number. Required when activating a professional license. Defaults to the UNITY_SERIAL environment variable.')
    .option('-c, --config <config>', 'Path to the configuration file, raw JSON, or base64 encoded JSON string. Required when activating a floating license.')
    .option('-f, --license-file <licenseFile>', 'A cached license file (Unity_lic.ulf) from an earlier activation on a machine with the same identity: a path, the raw XML, or base64. Defaults to the UNITY_LICENSE environment variable. Falls back to the email and password when it cannot be used.')
    .option('--verbose', 'Enable verbose logging.')
    .option('--json', 'Prints the last line of output as JSON string.')
    .action(async (options) => {
        if (options.verbose) {
            Logger.instance.logLevel = LogLevel.DEBUG;
        }

        // environment variables keep credentials out of the process command line
        options.email ??= process.env.UNITY_USERNAME || undefined;
        options.password ??= process.env.UNITY_PASSWORD || undefined;
        options.serial ??= process.env.UNITY_SERIAL || undefined;

        // Mask credentials in CI environments before any potential logging
        Logger.instance.maskCredential(options.email);
        Logger.instance.maskCredential(options.password);
        Logger.instance.maskCredential(options.serial);

        Logger.instance.debugOptions(options);

        const licenseStr: string = options.license?.toString()?.trim();

        if (!licenseStr || licenseStr.length === 0) {
            Logger.instance.error('License type is required. Use -l or --license to specify it.');
            process.exit(1);
        }

        const licenseType: LicenseType = licenseStr.toLowerCase() as LicenseType;

        if (![LicenseType.personal, LicenseType.professional, LicenseType.floating].includes(licenseType)) {
            Logger.instance.error(`Invalid license type: ${licenseType}`);
            process.exit(1);
        }

        if (licenseType === LicenseType.professional && !options.serial) {
            options.serial = await PromptForSecretInput('Serial: ');
            Logger.instance.maskCredential(options.serial);
        }

        const token = await ActivateLicense({
            licenseType,
            servicesConfig: options.config,
            serial: options.serial,
            username: options.email,
            password: options.password,
            ...(options.licenseFile ? { licenseFile: options.licenseFile } : {}),
        });

        if (licenseType === LicenseType.floating && token && options.json) {
            process.stdout.write(`\n${JSON.stringify({ token: token })}\n`);
        }

        process.exit(0);
    });

program.command('return-license')
    .description('Return a Unity license. Tries the official Unity CLI first, then the Unity Licensing Client.')
    .option('-l, --license <license>', 'License type (personal, professional, floating)')
    .option('-t, --token <token>', 'Floating license token from activation. When given, the floating license is returned with the Unity Licensing Client.')
    .option('--verbose', 'Enable verbose logging.')
    .action(async (options) => {
        if (options.verbose) {
            Logger.instance.logLevel = LogLevel.DEBUG;
        }

        const token: string | undefined = options.token?.toString()?.trim() || undefined;

        // Mask token in CI environments before any potential logging
        Logger.instance.maskCredential(token);
        Logger.instance.debugOptions(options);

        const licenseStr: string = options.license?.toString()?.trim();

        if (!licenseStr || licenseStr.length === 0) {
            Logger.instance.error('License type is required. Use -l or --license to specify it.');
            process.exit(1);
        }

        const licenseType: LicenseType = licenseStr.toLowerCase() as LicenseType;

        if (![LicenseType.personal, LicenseType.professional, LicenseType.floating].includes(licenseType)) {
            Logger.instance.error(`Invalid license type: ${licenseType}`);
            process.exit(1);
        }

        await ReturnLicense(licenseType, token);
        process.exit(0);
    });

program.command('license-context')
    .description('Print the current license state from the Unity CLI and the Unity Licensing Client.')
    .action(async () => {
        await PrintLicenseContext();
        process.exit(0);
    });

program.command('license-file-path')
    .description('Prints the path to the machine\'s Unity license file (Unity_lic.ulf).')
    .action(async () => {
        process.stdout.write(`${GetLicenseFilePath()}\n`);
        process.exit(0);
    });

program.command('licensing-client-logs')
    .description('Prints the path to the Unity Licensing Client log file.')
    .action(async () => {
        process.stdout.write(`${LicensingClient.ClientLogPath()}\n`);
        process.exit(0);
    });

program.command('licensing-audit-logs')
    .description('Prints the path to the Unity Licensing Client audit log.')
    .action(async () => {
        process.stdout.write(`${LicensingClient.ClientAuditLogPath()}\n`);
        process.exit(0);
    });

program.commandsGroup('Unity Editor:');

program.command('setup-unity')
    .description('Find or install the Unity Editor for a project or specific version. 2017.4 and newer install with the official Unity CLI; 4.x and 5.x install from Unity\'s archives.')
    .option('-p, --unity-project <unityProject>', 'The path to a Unity project or "none" to skip project detection.')
    .option('-u, --unity-version <unityVersion>', 'The Unity version to get (e.g. 2020.3.1f1, 2021.x, 2022.1.*, 6000). If specified, it will override the version read from the project.')
    .option('-c, --changeset <changeset>', 'The Unity changeset to get (e.g. 1234567890ab).')
    .option('--channel <channels>', 'Release channel letter(s) to accept when resolving partial versions: f,p,b,a,x (comma-separated). Default: f (stable only).')
    .option('-a, --arch <arch>', 'The Unity architecture to get (e.g. x86_64, arm64). Defaults to the architecture of the current process.')
    .option('-b, --build-targets <buildTargets>', 'The Unity build target to get/install as comma-separated values (e.g. iOS,Android).')
    .option('-m, --modules <modules>', 'The Unity module to get/install as comma-separated values (e.g. ios,android).')
    .option('-i, --install-path <installPath>', 'The path to install the Unity Editor to. By default, it will be installed to the Unity CLI install path.')
    .option('--verbose', 'Enable verbose logging.')
    .option('--json', 'Prints the last line of output as JSON string.')
    .action(async (options) => {
        if (options.verbose) {
            Logger.instance.logLevel = LogLevel.DEBUG;
        }

        Logger.instance.debugOptions(options);

        let unityProject: UnityProject | undefined;

        if (options.unityProject) {
            unityProject = await UnityProject.GetProject(options.unityProject);
        }

        if (!options.unityVersion && !unityProject) {
            Logger.instance.error('You must specify a Unity version or project path with -u, --unity-version, -p, --unity-project.');
            process.exit(1);
        }

        let unityVersion: UnityVersion;

        if (options.unityVersion) {
            const arch = options.arch?.toString()?.trim().toLowerCase();
            const architecture = arch === 'arm64' ? 'ARM64' : arch === 'x86_64' || arch === 'x64' ? 'X86_64' : undefined;
            unityVersion = new UnityVersion(options.unityVersion, options.changeset, architecture);
        } else {
            unityVersion = unityProject!.version;
        }

        const modules: string[] = options.modules ? options.modules.split(/[ ,]+/).filter(Boolean) : [];
        const buildTargets: string[] = options.buildTargets ? options.buildTargets.split(/[ ,]+/).filter(Boolean) : [];

        // with only a project, its saved build profiles pick the modules; --modules or --build-targets override them
        if (unityProject && modules.length === 0 && buildTargets.length === 0) {
            buildTargets.push(...unityProject.GetBuildProfileTargets());

            if (buildTargets.length > 0) {
                Logger.instance.info(`Installing modules for the project's build profiles: ${buildTargets.join(', ')}`);
            }
        }
        const moduleBuildTargetMap = UnityInstaller.GetPlatformTargetModuleMap();

        for (const target of buildTargets) {
            const module = moduleBuildTargetMap[target];

            if (module === undefined) {
                if (target.toLowerCase() !== 'none') {
                    Logger.instance.warn(`${target} is not a valid build target for ${os.type()}`);
                }

                continue;
            }

            if (!modules.includes(module)) {
                modules.push(module);
            }
        }

        if (modules.includes('none') ||
            modules.includes('None')) {
            modules.length = 0;
        }

        const channels: string[] = options.channel
            ? String(options.channel).split(/[ ,]+/).map((c: string) => c.trim().toLowerCase()).filter(Boolean)
            : ['f'];
        const allowedChannels = new Set(['f', 'p', 'b', 'a', 'x']);
        for (const ch of channels) {
            if (!allowedChannels.has(ch)) {
                Logger.instance.error(`Invalid --channel '${ch}'. Expected one of: f, p, b, a, x.`);
                process.exit(1);
            }
        }

        const unityCli = await UnityCli.Get();
        const installer = new UnityInstaller(unityCli);

        if (options.installPath) {
            await installer.SetInstallPath(options.installPath);
        }

        const unityEditor = await installer.GetEditor(unityVersion, modules, channels);
        const output: { [key: string]: string } = {
            'UNITY_CLI_PATH': unityCli.executable,
            'UNITY_EDITOR_PATH': unityEditor.editorPath,
            'UNITY_EDITOR_VERSION': unityEditor.version.version,
            'UNITY_EDITOR_CHANGESET': unityEditor.version.changeset ?? '',
            'UNITY_EDITOR_CHANNELS': channels.join(','),
        };

        if (unityProject) {
            output['UNITY_PROJECT_PATH'] = unityProject.projectPath;

            if (modules.includes('android')) {
                await CheckAndroidSdkInstalled(unityEditor, unityProject.projectPath);
            }
        }

        for (const [key, value] of Object.entries(output)) {
            if (value && value.length > 0) {
                Logger.instance.CI_setEnvironmentVariable(key, value);
            }
        }

        if (options.json) {
            process.stdout.write(`\n${JSON.stringify(output)}\n`);
        } else {
            process.stdout.write(`Unity setup complete!\n`);
            for (const [key, value] of Object.entries(output)) {
                if (value && value.length > 0) {
                    process.stdout.write(`${key}=${value}\n`);
                }
            }
        }

        process.exit(0);
    });

program.command('run')
    .description('Run Unity Editor command line arguments with live Editor log and UTP annotations. Runs with a project go through the official CLI\'s unity run.')
    .option('--unity-editor <unityEditor>', 'The path to the Unity Editor executable. If unspecified, --unity-project or the UNITY_EDITOR_PATH environment variable must be set.')
    .option('--unity-project <unityProject>', 'The path to a Unity project. If unspecified, the UNITY_PROJECT_PATH environment variable will be used, otherwise no project will be specified.')
    .option('--log-name <logName>', 'The name of the log file.')
    .option('--log-level <logLevel>', 'Override the logger verbosity (debug, info, minimal, warning, error). Defaults to info.')
    .option('--verbose', 'Enable verbose logging. Deprecated, use --log-level instead.')
    .allowUnknownOption(true)
    .argument('<args...>', 'Arguments to pass to the Unity Editor executable.')
    .action(async (args: string[], options) => {
        if (options.verbose) {
            Logger.instance.warn('The --verbose option is deprecated. Please use "--log-level <value>" instead.');
            Logger.instance.logLevel = LogLevel.DEBUG;
        }

        let requestedLogLevel: LogLevel | undefined;

        if (options.logLevel) {
            const levelStr: string = options.logLevel?.toString()?.trim().toLowerCase();

            switch (levelStr) {
                case 'debug':
                    requestedLogLevel = LogLevel.DEBUG;
                    break;
                case 'ci':
                    requestedLogLevel = LogLevel.CI;
                    break;
                case 'minimal':
                    requestedLogLevel = LogLevel.UTP;
                    break;
                case 'info':
                    requestedLogLevel = LogLevel.INFO;
                    break;
                case 'warning':
                    requestedLogLevel = LogLevel.WARN;
                    break;
                case 'error':
                    requestedLogLevel = LogLevel.ERROR;
                    break;
                default:
                    Logger.instance.warn(`Unknown log level: ${levelStr}. Using default log level.`);
                    break;
            }
        }

        if (requestedLogLevel === LogLevel.UTP) {
            if (process.env.GITHUB_ACTIONS === 'true') {
                Logger.instance.warn('The "minimal" log level is not supported in CI environments. Falling back to CI log output.');
                Logger.instance.logLevel = LogLevel.CI;
            } else {
                Logger.instance.logLevel = LogLevel.UTP;
            }
        } else if (requestedLogLevel) {
            Logger.instance.logLevel = requestedLogLevel;
        }

        Logger.instance.debugOptions({ options, args });

        let unityEditor: UnityEditor | undefined;
        const editorPath = options.unityEditor?.toString()?.trim() || process.env.UNITY_EDITOR_PATH || undefined;

        if (editorPath && editorPath.length > 0) {
            try {
                unityEditor = new UnityEditor(editorPath);
            } catch {
                Logger.instance.error(`The specified Unity Editor path is invalid: ${editorPath}. Use --unity-editor or set the UNITY_EDITOR_PATH environment variable.`);
                process.exit(1);
            }
        }

        let unityProject: UnityProject | undefined;
        const projectPath = options.unityProject?.toString()?.trim() || process.env.UNITY_PROJECT_PATH || undefined;

        if (projectPath && projectPath.length > 0) {
            try {
                unityProject = await UnityProject.GetProject(projectPath);

                if (!unityProject) {
                    throw Error('Invalid Unity project path.');
                }
            } catch (error) {
                Logger.instance.error(`The specified path is not a valid Unity project: ${projectPath}. Use --unity-project or set the UNITY_PROJECT_PATH environment variable.`);
                process.exit(1);
            }

            if (!unityEditor) {
                try {
                    unityEditor = await new UnityInstaller().GetEditor(unityProject.version);
                } catch {
                    Logger.instance.error(`Could not find Unity Editor version ${unityProject.version.version} installed for project at ${unityProject.projectPath}. Please specify the editor path with --unity-editor or set the UNITY_EDITOR_PATH environment variable.`);
                    process.exit(1);
                }
            }
        }

        if (!unityEditor) {
            Logger.instance.error('The Unity Editor path was not specified. Use --unity-editor to specify it or set the UNITY_EDITOR_PATH environment variable.');
            process.exit(1);
        }

        if (!args.includes('-logFile')) {
            const logPath = unityEditor.GenerateLogFilePath(unityProject?.projectPath, options.logName);
            args.push('-logFile', logPath);
        }

        await unityEditor.Run({
            projectPath: unityProject?.projectPath,
            args: [...args]
        });
        process.exit(0);
    });

program.command('editor-logs')
    .description('Prints the path to the Unity Editor log files.')
    .action(async () => {
        const unityEditorLogsPath = UnityEditor.GetEditorLogsDirectory();
        process.stdout.write(`${unityEditorLogsPath}\n`);
        process.exit(0);
    });


program.commandsGroup('Deprecated, forwarded to the official Unity CLI:');

program.command('uninstall-unity')
    .description('[Deprecated] Uninstall a Unity Editor version. Forwards to: unity uninstall <version> --yes')
    .option('-e, --unity-editor <unityEditor>', 'The path to the Unity Editor executable. If unspecified, -u, --unity-version or the UNITY_EDITOR_PATH environment variable must be set.')
    .option('-u, --unity-version <unityVersion>', 'The Unity version to uninstall (e.g. 2020.3.1f1, 6000.2). If unspecified, then --unity-editor must be specified.')
    .option('-c, --changeset <changeset>', 'Ignored; the official CLI uninstalls by version.')
    .option('-a, --arch <arch>', 'The Unity architecture to uninstall (x86_64, arm64).')
    .option('--verbose', 'Enable verbose logging.')
    .action(async (options) => {
        if (options.verbose) {
            Logger.instance.logLevel = LogLevel.DEBUG;
        }

        Logger.instance.debugOptions(options);
        const version = await forwardedEditorVersion(options);

        if (!version) {
            Logger.instance.error('You must specify the Unity version or editor path with -u, --unity-version, -e, --unity-editor or UNITY_EDITOR_PATH.');
            process.exit(1);
        }

        const args = ['uninstall', version, '--yes'];
        const arch = options.arch?.toString()?.trim();

        if (arch) {
            args.push('--architecture', arch);
        }

        await forwardToUnityCli('uninstall-unity', args);
    });

program.command('list-project-templates')
    .description('[Deprecated] List available Unity project templates for an editor. Forwards to: unity templates list --editor <version>')
    .option('-u, --unity-version <unityVersion>', 'The Unity version to list templates for (e.g. 2022.3.1f1, 6000.2). If unspecified, then --unity-editor must be specified.')
    .option('-e, --unity-editor <unityEditor>', 'The path to the Unity Editor executable. If unspecified, -u, --unity-version or the UNITY_EDITOR_PATH environment variable must be set.')
    .option('--verbose', 'Enable verbose logging.')
    .option('--json', 'Prints the output as JSON.')
    .action(async (options) => {
        if (options.verbose) {
            Logger.instance.logLevel = LogLevel.DEBUG;
        }

        Logger.instance.debugOptions(options);
        const version = await forwardedEditorVersion(options, true);
        await forwardToUnityCli('list-project-templates', ['templates', 'list', ...(version ? ['--editor', version] : [])], options.json === true);
    });

program.command('create-project')
    .description('[Deprecated] Create a new Unity project. Forwards to: unity projects create <name> --path <path> --editor-version <version> --template <id> --no-cloud')
    .option('-n, --name <projectName>', 'The name of the new Unity project. If unspecified, the project will be created in the specified path or the current working directory.')
    .option('-p, --path <projectPath>', 'The path to create the new Unity project. If unspecified, the current working directory will be used.')
    .option('-t, --template <projectTemplate>', 'The template package id to create the project from; an id prefix picks the first matching template.', 'com.unity.template.3d')
    .option('-u, --unity-version <unityVersion>', 'The Unity version to create the project with (e.g. 2022.3.1f1, 6000.2). If unspecified, then --unity-editor must be specified.')
    .option('-e, --unity-editor <unityEditor>', 'The path to the Unity Editor executable. If unspecified, -u, --unity-version, or the UNITY_EDITOR_PATH environment variable must be set.')
    .option('--verbose', 'Enable verbose logging.')
    .option('--json', 'Prints the output as JSON.')
    .action(async (options) => {
        if (options.verbose) {
            Logger.instance.logLevel = LogLevel.DEBUG;
        }

        Logger.instance.debugOptions(options);
        const version = await forwardedEditorVersion(options, true);
        const target = path.resolve(options.path?.toString()?.trim() || process.cwd());
        const name = options.name?.toString()?.trim();
        const args = ['projects', 'create', name || path.basename(target), '--path', name ? target : path.dirname(target)];

        if (version) {
            args.push('--editor-version', version);
        }

        const template = options.template.toString().trim();
        // v3 took a regex here; a pattern is never compiled from the argument, so its leading literal part
        // (com.unity.template.3d for the v3 default) is matched as an exact id, then as an id prefix
        const prefix = /^[\w.-]+/.exec(template)?.[0];

        if (!prefix) {
            Logger.instance.error(`Invalid project template: ${template}. Use a template id such as com.unity.template.3d.`);
            process.exit(1);
        }

        if (prefix !== template) {
            Logger.instance.warn(`Template patterns are no longer supported; matching templates that start with ${prefix}.`);
        }

        const cli = await UnityCli.Get();
        const { envelope } = await cli.RunJson<{ name?: string; id?: string }[]>(['templates', 'list', ...(version ? ['--editor', version] : [])]);
        const ids = (envelope?.data ?? []).map(t => t.name || t.id).filter((id): id is string => !!id);
        const templateId = ids.find(id => id === prefix) ?? ids.find(id => id.startsWith(prefix));

        if (!templateId) {
            Logger.instance.error(`No project template matches ${prefix}. Available: ${ids.join(', ')}`);
            process.exit(1);
        }

        args.push('--template', templateId, '--no-cloud');
        await forwardToUnityCli('create-project', args, options.json === true);
    });

program.command('open-project')
    .description('[Deprecated] Open a Unity project in the Unity Editor. Forwards to: unity open <project>')
    .option('-p, --unity-project <unityProject>', 'The path to a Unity project. If unspecified, the UNITY_PROJECT_PATH environment variable or the current working directory will be used.')
    .option('-u, --unity-version <unityVersion>', 'The Unity version to open the project with. If specified, it will override the version read from the project.')
    .option('-t, --build-target <buildTarget>', 'The Unity build target to switch the project to (e.g. StandaloneWindows64, StandaloneOSX, iOS, Android).')
    .option('--verbose', 'Enable verbose logging.')
    .action(async (options) => {
        if (options.verbose) {
            Logger.instance.logLevel = LogLevel.DEBUG;
        }

        Logger.instance.debugOptions(options);
        const projectPath = options.unityProject?.toString()?.trim() || process.env.UNITY_PROJECT_PATH || process.cwd();
        const args = ['open', projectPath];
        const version = options.unityVersion?.toString()?.trim();
        const buildTarget = options.buildTarget?.toString()?.trim();

        if (version) {
            args.push('--editor-version', version);
        }

        if (buildTarget) {
            args.push('--build-target', buildTarget);
        }

        await forwardToUnityCli('open-project', args);
    });

/**
 * The editor version a forwarded v3 command names, from --unity-version or the editor at --unity-editor / UNITY_EDITOR_PATH.
 * Partial versions such as 2021.3.x become 2021.3, the short form `unity uninstall` accepts; with `exact`, they resolve
 * to the newest matching release instead, because `unity templates list` and `unity projects create` need a full version.
 */
async function forwardedEditorVersion(options: { unityVersion?: string; unityEditor?: string }, exact: boolean = false): Promise<string | undefined> {
    const version = options.unityVersion?.toString()?.trim();

    if (version) {
        if (!exact) {
            return version.replace(/\.[x*]$/i, '');
        }

        const unityVersion = new UnityVersion(version);

        if (unityVersion.isFullyQualified()) {
            return unityVersion.version;
        }

        return (await new UnityInstaller(await UnityCli.Get()).resolveVersion(unityVersion)).version;
    }

    const editorPath = options.unityEditor?.toString()?.trim() || process.env.UNITY_EDITOR_PATH;
    return editorPath ? new UnityEditor(editorPath).version.version : undefined;
}

/** Warns that a v3 command is deprecated, runs its official Unity CLI replacement and exits with that exit code. */
async function forwardToUnityCli(command: string, args: string[], json: boolean = false): Promise<never> {
    Logger.instance.warn(`unity-cli ${command} is deprecated and will be removed. Use the official Unity CLI instead: unity ${args.join(' ')}`);
    const cli = await UnityCli.Get();
    const result = await cli.Run(json ? [...args, '--json'] : args, { stream: !json });

    if (json) {
        process.stdout.write(`${result.stdout.trim()}\n`);
    }

    process.exit(result.exitCode);
}

program.commandsGroup("Unity Package Manager:");

program.command('upm-install')
    .description('Download and install the Unity Package Manager cli (pack/sign).')
    .option('--verbose', 'Enable verbose logging.')
    .option('--auto-update', 'Automatically updates the upm cli if it is already installed and a newer release is available. Cannot be used with --version.')
    .option('--version <version>', 'Specify to install a specific version of the Unity Package Manager cli. Cannot be used with --auto-update.')
    .option('--json', 'Print version and managed paths as JSON.')
    .action(async (options) => {
        if (options.verbose) {
            Logger.instance.logLevel = LogLevel.DEBUG;
        }

        Logger.instance.debugOptions(options);

        try {
            if (options.autoUpdate === true && options.version) {
                Logger.instance.error('Cannot use --auto-update with --version.');
                process.exit(1);
            }

            const upm = new UpmCli();
            let requestedVersion = options.version?.toString()?.trim();
            if (options.autoUpdate === true) {
                const currentVersion = upm.GetInstalledReleaseTag();
                const latestVersion = await upm.GetLatestReleaseTag();

                if (currentVersion && !upm.IsUpdateAvailable(latestVersion)) {
                    Logger.instance.info(`Upm cli is already up to date (${currentVersion}).`);
                    requestedVersion = currentVersion;
                } else {
                    if (currentVersion) {
                        Logger.instance.info(`Updating upm cli ${currentVersion} -> ${latestVersion}...`);
                    }
                    requestedVersion = latestVersion;
                }
            }

            const ver = await upm.Install({
                version: requestedVersion,
                skipIfInstalled: true
            });

            await upm.Version(ver);
            const exe = upm.executable;

            if (options.json) {
                process.stdout.write(`\n${JSON.stringify({
                    UPM_VERSION: ver,
                    UPM_CLI_PATH: exe,
                    UPM_MANAGED_ROOT: upm.managedRoot,
                })}\n`);
            } else {
                process.stdout.write(`Upm cli ${ver} installed.\n`);
                process.stdout.write(`${exe}\n`);
            }

            process.exit(0);
        } catch (error) {
            ReportFailure(error);
            process.exit(1);
        }
    });

program.command('upm-version')
    .description('Print the Unity Package Manager cli version.')
    .action(async () => {
        try {
            const upmCli = new UpmCli();
            const version = await upmCli.Version();
            process.stdout.write(`v${version.version}\n`);
            process.exit(0);
        } catch (error) {
            ReportFailure(error);
            process.exit(1);
        }
    });

interface UpmPackCliOptions {
    source?: string;
    destination?: string;
    verbose?: boolean;
}

program.command('upm-pack')
    .description('Sign and pack a Unity package.')
    .option('--source <path>', 'An absolute or relative path to the root folder of the custom package to pack. This is the folder that contains the package manifest file (package.json). (optional; defaults to the current working directory).')
    .option('--destination <path>', 'The output path for the signed tarball. If you specify a folder that doesn\'t exist, it will be created for you. Note: If you omit this parameter, the tarball will be placed in the current working directory.')
    .option('--verbose', 'Enable verbose logging.')
    .action(async (options: UpmPackCliOptions) => {
        if (options.verbose) {
            Logger.instance.logLevel = LogLevel.DEBUG;
        }

        Logger.instance.debugOptions({ options });

        try {
            const upm = new UpmCli();
            await upm.PromptInstallOrUpdateWhenInteractive();

            let serviceAccountKeyId = process.env.UPM_SERVICE_ACCOUNT_KEY_ID?.trim();

            if (!serviceAccountKeyId) {
                serviceAccountKeyId = (await PromptForSecretInput('UPM_SERVICE_ACCOUNT_KEY_ID: ')).trim();
            }

            if (!serviceAccountKeyId) {
                Logger.instance.error(
                    'UPM_SERVICE_ACCOUNT_KEY_ID is required. Set the environment variable or enter a value when prompted.'
                );
                process.exit(1);
            }

            let serviceAccountKeySecret = process.env.UPM_SERVICE_ACCOUNT_KEY_SECRET?.trim();

            if (!serviceAccountKeySecret) {
                serviceAccountKeySecret = (await PromptForSecretInput('UPM_SERVICE_ACCOUNT_KEY_SECRET: ')).trim();
            }

            if (!serviceAccountKeySecret) {
                Logger.instance.error(
                    'UPM_SERVICE_ACCOUNT_KEY_SECRET is required. Set the environment variable or enter a value when prompted.'
                );
                process.exit(1);
            }

            process.env.UPM_SERVICE_ACCOUNT_KEY_ID = serviceAccountKeyId;
            Logger.instance.maskCredential(serviceAccountKeyId);
            process.env.UPM_SERVICE_ACCOUNT_KEY_SECRET = serviceAccountKeySecret;
            Logger.instance.maskCredential(serviceAccountKeySecret);

            let orgId = process.env.UNITY_ORGANIZATION_ID?.trim() || process.env.UNITY_ORG_ID?.trim();
            const dest = options.destination?.toString()?.trim();

            if (!orgId) {
                orgId = (await PromptForSecretInput('UNITY_ORGANIZATION_ID: ')).trim();
            }

            if (!orgId) {
                Logger.instance.error(
                    'Organization ID is required. Set UNITY_ORGANIZATION_ID or UNITY_ORG_ID, or enter a value when prompted.'
                );
                process.exit(1);
            }

            Logger.instance.maskCredential(orgId);

            const redactLiterals = [orgId, serviceAccountKeyId, serviceAccountKeySecret].filter(
                (s): s is string => typeof s === 'string' && s.trim().length > 0
            );

            const packOptions: UpmPackOptions = {
                organizationId: orgId,
            };

            if (dest) {
                packOptions.destination = dest;
            }

            const sourceArg = options.source?.toString()?.trim();
            packOptions.packageDirectory =
                sourceArg && sourceArg.length > 0 ? path.resolve(sourceArg) : process.cwd();

            await upm.Pack(packOptions, {
                silent: false,
                showCommand: Logger.instance.logLevel === LogLevel.DEBUG,
                redactLiterals,
            });

            process.exit(0);
        } catch (error) {
            ReportFailure(error);
            process.exit(1);
        }
    });

void program.parseAsync(process.argv).catch((err: unknown) => {
    ReportFailure(err);
    process.exit(1);
});
