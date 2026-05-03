#!/usr/bin/env node

import 'source-map-support/register';
import * as fs from 'fs';
import * as os from 'os';
import * as tar from 'tar';
import * as path from 'path';
import { Command } from 'commander';
import { UnityHub } from './unity-hub';
import { UnityEditor } from './unity-editor';
import updateNotifier from "update-notifier";
import { Logger, LogLevel } from './logging';
import { UnityVersion } from './unity-version';
import { UnityProject } from './unity-project';
import { ChildProcess, spawn } from 'child_process';
import { CheckAndroidSdkInstalled } from './android-sdk';
import { LicenseType, LicensingClient } from './license-client';
import { PromptForSecretInput, ResolveGlobToPath } from './utilities';
import { UpmCli, UpmPackOptions } from './upm-cli';

const pkgPath = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
updateNotifier({ pkg }).notify();
const program = new Command();

program.name('unity-cli')
    .description('A command line utility for the Unity Game Engine.')
    .version(pkg.version);

program.command('install-all-tools')
    .description('Install the Unity Hub and the Unity Package Manager cli (pack/sign). Runs hub-install and upm-install in parallel.')
    .option('--verbose', 'Enable verbose logging.')
    .option('--auto-update', 'If any tools are installed, they\'re automatically updated to the latest versions. Cannot be used with --hub-version or --upm-version.')
    .option('--hub-version <version>', 'Specify to install a specific version of Unity Hub. Cannot be used with --auto-update.')
    .option('--upm-version <version>', 'upm cli release tag (e.g. v9.27.0). Defaults to latest from Unity CDN. Cannot be used with --auto-update.')
    .option('--json', 'Print hub path, UPM release tag, and resolved UPM CLI path as JSON.')
    .action(async (options) => {
        if (options.verbose) {
            Logger.instance.logLevel = LogLevel.DEBUG;
        }

        Logger.instance.debugOptions(options);

        if (options.autoUpdate === true && options.hubVersion) {
            Logger.instance.error('Cannot use --auto-update with --hub-version.');
            process.exit(1);
        }

        if (options.autoUpdate === true && options.upmVersion) {
            Logger.instance.error('Cannot use --auto-update with --upm-version.');
            process.exit(1);
        }

        try {
            const unityHub = new UnityHub();
            const upm = new UpmCli();
            let upmRequestedVersion = options.upmVersion?.toString()?.trim();
            if (options.autoUpdate === true) {
                const currentVersion = upm.GetInstalledReleaseTag();
                const latestVersion = await upm.GetLatestReleaseTag();
                if (currentVersion && !upm.IsUpdateAvailable(latestVersion)) {
                    Logger.instance.info(`Upm cli is already up to date (${currentVersion}).`);
                    upmRequestedVersion = currentVersion;
                } else {
                    if (currentVersion) {
                        Logger.instance.info(`Updating upm cli ${currentVersion} -> ${latestVersion}...`);
                    }
                    upmRequestedVersion = latestVersion;
                }
            }

            const [hubPath, upmVer] = await Promise.all([
                unityHub.Install(options.autoUpdate === true, options.hubVersion),
                upm.Install({
                    version: upmRequestedVersion,
                    skipIfInstalled: true
                }),
            ]);
            Logger.instance.CI_setEnvironmentVariable('UNITY_HUB_PATH', hubPath);
            let upmCliPath: string | undefined;
            try {
                await upm.Version(upmVer);
                upmCliPath = upm.executable;
            } catch (verifyError) {
                Logger.instance.warn(`Upm cli version check failed after install: ${verifyError}`);
                if (process.env.CI === 'true') {
                    Logger.instance.error('Failing in CI because the installed UPM CLI did not match the expected release.');
                    process.exit(1);
                }
                upmCliPath = upm.ResolveManagedPrimaryPath();
            }

            if (options.json) {
                process.stdout.write(`\n${JSON.stringify({
                    UNITY_HUB_PATH: hubPath,
                    UPM_VERSION: upmVer,
                    UPM_CLI_PATH: upmCliPath,
                })}\n`);
            } else {
                process.stdout.write(`Unity Hub: ${hubPath}\nUpm cli: ${upmVer}\n${upmCliPath ?? ''}\n`);
            }

            process.exit(0);
        } catch (error) {
            Logger.instance.error(`${error}`);
            process.exit(1);
        }
    });

program.commandsGroup('Auth:');

program.command('license-version')
    .description('Print the version of the Unity License Client.')
    .action(async () => {
        const client = new LicensingClient();
        await client.Version();
        process.exit(0);
    });

program.command('activate-license')
    .description('Activate a Unity license.')
    .option('-l, --license <license>', 'License type (personal, professional, floating). Required.')
    .option('-e, --email <email>', 'Email associated with the Unity account. Required when activating a personal or professional license.')
    .option('-p, --password <password>', 'Password for the Unity account. Required when activating a personal or professional license.')
    .option('-s, --serial <serial>', 'License serial number. Required when activating a professional license.')
    .option('-c, --config <config>', 'Path to the configuration file, raw JSON, or base64 encoded JSON string. Required when activating a floating license.')
    .option('--verbose', 'Enable verbose logging.')
    .option('--json', 'Prints the last line of output as JSON string.')
    .action(async (options) => {
        if (options.verbose) {
            Logger.instance.logLevel = LogLevel.DEBUG;
        }

        Logger.instance.debugOptions(options);

        const client = new LicensingClient();
        const licenseStr: string = options.license?.toString()?.trim();

        if (!licenseStr || licenseStr.length === 0) {
            Logger.instance.error('License type is required. Use -l or --license to specify it.');
            process.exit(1);
        }

        const licenseType: LicenseType = options.license.toLowerCase() as LicenseType;

        if (![LicenseType.personal, LicenseType.professional, LicenseType.floating].includes(licenseType)) {
            Logger.instance.error(`Invalid license type: ${licenseType}`);
            process.exit(1);
        }

        if (licenseType !== LicenseType.floating) {
            if (!options.email) {
                options.email = await PromptForSecretInput('Email: ');
            }

            if (!options.password) {
                options.password = await PromptForSecretInput('Password: ');
            }

            if (licenseType === LicenseType.professional && !options.serial) {
                options.serial = await PromptForSecretInput('Serial: ');
            }

            // Mask credentials in CI environments before any potential logging
            Logger.instance.maskCredential(options.email);
            Logger.instance.maskCredential(options.password);
            Logger.instance.maskCredential(options.serial);
        }

        const token = await client.Activate({
            licenseType,
            servicesConfig: options.config,
            serial: options.serial,
            username: options.email,
            password: options.password
        });

        if (licenseType === LicenseType.floating && token && options.json) {
            process.stdout.write(`\n${JSON.stringify({ token: token })}\n`);
        }

        process.exit(0);
    });

program.command('return-license')
    .description('Return a Unity license.')
    .option('-l, --license <license>', 'License type (personal, professional, floating)')
    .option('-t, --token <token>', 'Token received when acquiring a floating license lease. Required when returning a floating license.')
    .option('--verbose', 'Enable verbose logging.')
    .action(async (options) => {
        if (options.verbose) {
            Logger.instance.logLevel = LogLevel.DEBUG;
        }

        Logger.instance.debugOptions(options);

        const client = new LicensingClient();
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

        let token: string | undefined = options.token;

        if (licenseType === LicenseType.floating) {
            if (!token || token.length === 0) {
                token = await PromptForSecretInput('Token: ');
            }

            if (!token || token.length === 0) {
                Logger.instance.error('Token is required when returning a floating license. Use -t or --token to specify it.');
                process.exit(1);
            }

            // Mask token in CI environments before any potential logging
            Logger.instance.maskCredential(token);
        }

        await client.Deactivate(licenseType, token);
        process.exit(0);
    });

program.command('license-context')
    .description('Display the context information of the Unity Licensing Client.')
    .action(async () => {
        const client = new LicensingClient();
        await client.Context();
        process.exit(0);
    });

program.command('licensing-client-logs')
    .description('Prints the path to the Unity Licensing Client log file.')
    .action(async () => {
        process.stdout.write(`${LicensingClient.ClientLogPath()}\n`);
        process.exit(0);
    });

program.command('licensing-audit-logs')
    .description('Prints the path to the Unity Licensing Client audit log file.')
    .action(async () => {
        process.stdout.write(`${LicensingClient.ClientAuditLogPath()}\n`);
        process.exit(0);
    });

program.commandsGroup('Unity Hub:');

program.command('hub-version')
    .description('Print the version of the Unity Hub.')
    .action(async () => {
        const unityHub = new UnityHub();
        try {
            const version = await unityHub.Version();
            process.stdout.write(`${version}\n`);
        } catch (error) {
            process.stdout.write(`${error}\n`);
        } finally {
            process.exit(0);
        }
    });

program.command('hub-path')
    .description('Print the path to the Unity Hub executable.')
    .option('--json', 'Prints the last line of output as JSON string.')
    .action(async (options) => {
        const hub = new UnityHub();

        Logger.instance.CI_setEnvironmentVariable('UNITY_HUB_PATH', hub.executable);

        if (options.json) {
            process.stdout.write(`\n${JSON.stringify({ UNITY_HUB_PATH: hub.executable })}\n`);
        } else {
            process.stdout.write(`${hub.executable}\n`);
        }

        process.exit(0);
    });

program.command('hub-logs')
    .description('Prints the path to the Unity Hub log file.')
    .action(async () => {
        process.stdout.write(`${UnityHub.LogPath()}\n`);
        process.exit(0);
    });

program.command('package-manager-logs')
    .description('Prints the path to the Unity Package Manager log file.')
    .action(async () => {
        process.stdout.write(`${UnityHub.PackageManagerLogsPath()}\n`);
        process.exit(0);
    });

program.command('hub-install')
    .description('Install the Unity Hub.')
    .option('--verbose', 'Enable verbose logging.')
    .option('--auto-update', 'Automatically updates the Unity Hub if it is already installed. Cannot be used with --hub-version.')
    .option('--hub-version <version>', 'Specify to install a specific version of Unity Hub. Cannot be used with --auto-update.')
    .option('--json', 'Prints the last line of output as JSON string.')
    .action(async (options) => {
        if (options.verbose) {
            Logger.instance.logLevel = LogLevel.DEBUG;
        }

        Logger.instance.debugOptions(options);

        if (options.autoUpdate === true && options.hubVersion) {
            Logger.instance.error('Cannot use --auto-update with --hub-version.');
            process.exit(1);
        }

        const unityHub = new UnityHub();
        const hubPath = await unityHub.Install(options.autoUpdate === true, options.hubVersion);

        Logger.instance.CI_setEnvironmentVariable('UNITY_HUB_PATH', hubPath);

        if (options.json) {
            process.stdout.write(`\n${JSON.stringify({ UNITY_HUB_PATH: hubPath })}\n`);
        } else {
            process.stdout.write(`${hubPath}\n`);
        }

        process.exit(0);
    });

program.command('hub')
    .description('Run commands directly to the Unity Hub. (You need not to pass --headless or -- to this command).')
    .option('--verbose', 'Enable verbose logging.')
    .option('--json', 'Prints the last line of output as a json string, which contains the operation results.')
    .allowUnknownOption(true)
    .argument('<args...>', 'Arguments to pass to the Unity Hub executable.')
    .action(async (args: string[], options) => {
        if (options.verbose) {
            Logger.instance.logLevel = LogLevel.DEBUG;
        }

        Logger.instance.debugOptions({ args, options });

        const unityHub = new UnityHub();
        const output = await unityHub.Exec(args, { silent: false, showCommand: Logger.instance.logLevel === LogLevel.DEBUG });

        if (options.json) {
            process.stdout.write(`\n${JSON.stringify({ output })}\n`);
        }

        process.exit(0);
    });

program.command('setup-unity')
    .description('Sets up the environment for the specified project and finds or installs the Unity Editor version for it.')
    .option('-p, --unity-project <unityProject>', 'The path to a Unity project or "none" to skip project detection.')
    .option('-u, --unity-version <unityVersion>', 'The Unity version to get (e.g. 2020.3.1f1, 2021.x, 2022.1.*, 6000). If specified, it will override the version read from the project.')
    .option('-c, --changeset <changeset>', 'The Unity changeset to get (e.g. 1234567890ab).')
    .option('-a, --arch <arch>', 'The Unity architecture to get (e.g. x86_64, arm64). Defaults to the architecture of the current process.')
    .option('-b, --build-targets <buildTargets>', 'The Unity build target to get/install as comma-separated values (e.g. iOS,Android).')
    .option('-m, --modules <modules>', 'The Unity module to get/install as comma-separated values (e.g. ios,android).')
    .option('-i, --install-path <installPath>', 'The path to install the Unity Editor to. By default, it will be installed to the default Unity Hub location.')
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
            unityVersion = new UnityVersion(options.unityVersion, options.changeset, options.arch);
        } else {
            unityVersion = unityProject!.version;
        }

        const modules: string[] = options.modules ? options.modules.split(/[ ,]+/).filter(Boolean) : [];
        const buildTargets: string[] = options.buildTargets ? options.buildTargets.split(/[ ,]+/).filter(Boolean) : [];
        const moduleBuildTargetMap = UnityHub.GetPlatformTargetModuleMap();

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

        const unityHub = new UnityHub();
        const unityEditor = await unityHub.GetEditor(unityVersion, modules);
        const output: { [key: string]: string } = {
            'UNITY_HUB_PATH': unityHub.executable,
            'UNITY_EDITOR_PATH': unityEditor.editorPath
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

program.command('uninstall-unity')
    .description('Uninstall the specified Unity Editor version.')
    .option('-e, --unity-editor <unityEditor>', 'The path to the Unity Editor executable. If unspecified, -u, --unity-version or the UNITY_EDITOR_PATH environment variable must be set.')
    .option('-u, --unity-version <unityVersion>', 'The Unity version to get (e.g. 2020.3.1f1, 2021.x, 2022.1.*, 6000). If unspecified, then --unity-editor must be specified.')
    .option('-c, --changeset <changeset>', 'The Unity changeset to get (e.g. 1234567890ab).')
    .option('-a, --arch <arch>', 'The Unity architecture to get (e.g. x86_64, arm64). Defaults to the architecture of the current process.')
    .option('--verbose', 'Enable verbose logging.')
    .action(async (options) => {
        if (options.verbose) {
            Logger.instance.logLevel = LogLevel.DEBUG;
        }

        Logger.instance.debugOptions(options);

        let unityEditor: UnityEditor | undefined;
        const unityVersionStr = options.unityVersion?.toString()?.trim();

        if (unityVersionStr) {
            const unityVersion = new UnityVersion(unityVersionStr, options.changeset, options.arch);
            const unityHub = new UnityHub();
            const installedEditors = await unityHub.ListInstalledEditors();

            if (unityVersion.isLegacy()) {
                const installPath = await unityHub.GetInstallPath();
                unityEditor = new UnityEditor(path.join(installPath, `Unity ${unityVersion.toString()}`, 'Unity.exe'));
            } else {
                unityEditor = installedEditors.find(e => e.version.equals(unityVersion));
            }
        } else {
            const editorPath = options.unityEditor?.toString()?.trim() || process.env.UNITY_EDITOR_PATH || undefined;

            if (!editorPath || editorPath.length === 0) {
                Logger.instance.error('You must specify a Unity version or editor path with -u, --unity-version, -e, --unity-editor.');
                process.exit(1);
            }

            try {
                unityEditor = new UnityEditor(editorPath);
            } catch {
                // ignored
            }
        }

        if (!unityEditor) {
            Logger.instance.info('The specified Unity Editor was not found.');
        }
        else {
            await unityEditor.Uninstall();
        }

        process.exit(0);
    });

program.commandsGroup('Unity Editor:');

program.command('run')
    .description('Run command line args directly to the Unity Editor.')
    .option('--unity-editor <unityEditor>', 'The path to the Unity Editor executable. If unspecified, --unity-project or the UNITY_EDITOR_PATH environment variable must be set.')
    .option('--unity-project <unityProject>', 'The path to a Unity project. If unspecified, the UNITY_PROJECT_PATH environment variable will be used, otherwise no project will be specified.')
    .option('--log-name <logName>', 'The name of the log file.')
    .option('--log-level <logLevel>', 'Set the logging level (debug, info, minimal, warning, error). Default is info.')
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
                const unityHub = new UnityHub();
                try {
                    unityEditor = await unityHub.GetEditor(unityProject.version);
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

program.command('list-project-templates')
    .description('List all available project templates for the given Unity editor.')
    .option('-u, --unity-version <unityVersion>', 'The Unity version to get (e.g. 2020.3.1f1, 2021.x, 2022.1.*, 6000). If unspecified, then --unity-editor must be specified.')
    .option('-e, --unity-editor <unityEditor>', 'The path to the Unity Editor executable. If unspecified, the UNITY_EDITOR_PATH environment variable must be set.')
    .option('--verbose', 'Enable verbose logging.')
    .option('--json', 'Prints the last line of output as JSON string.')
    .action(async (options) => {
        if (options.verbose) {
            Logger.instance.logLevel = LogLevel.DEBUG;
        }

        Logger.instance.debugOptions(options);

        const unityVersionStr = options.unityVersion?.toString()?.trim();

        if (!unityVersionStr && !options.unityEditor) {
            Logger.instance.error('You must specify a Unity version or editor path with -u, --unity-version, -e, --unity-editor.');
            process.exit(1);
        }

        let unityEditor: UnityEditor;

        if (unityVersionStr) {
            const unityVersion = new UnityVersion(unityVersionStr);
            unityEditor = await new UnityHub().GetEditor(unityVersion);
        } else {
            const editorPath = options.unityEditor?.toString()?.trim() || process.env.UNITY_EDITOR_PATH;

            if (!editorPath || editorPath.length === 0) {
                throw new Error('The Unity Editor path was not specified. Use -e or --unity-editor to specify it, or set the UNITY_EDITOR_PATH environment variable.');
            }

            unityEditor = new UnityEditor(editorPath);
        }

        const templates = unityEditor.GetAvailableTemplates();

        if (templates.length > 0) {
            if (options.json) {
                process.stdout.write(`\n${JSON.stringify({ templates })}\n`);
            } else {
                process.stdout.write(`Available project templates:\n${templates.map(t => `  - ${path.basename(t)}`).join('\n')}\n`);
            }
        } else {
            process.stdout.write('No project templates found for this Unity Editor.\n');
        }

        process.exit(0);
    });

program.command('create-project')
    .description('Create a new Unity project.')
    .option('-n, --name <projectName>', 'The name of the new Unity project. If unspecified, the project will be created in the specified path or the current working directory.')
    .option('-p, --path <projectPath>', 'The path to create the new Unity project. If unspecified, the current working directory will be used.')
    .option('-t, --template <projectTemplate>', 'The name of the template package to use for creating the unity project. Supports regex patterns.', 'com.unity.template.3d(-cross-platform)?')
    .option('-u, --unity-version <unityVersion>', 'The Unity version to get (e.g. 2020.3.1f1, 2021.x, 2022.1.*, 6000). If unspecified, then --unity-editor must be specified.')
    .option('-e, --unity-editor <unityEditor>', 'The path to the Unity Editor executable. If unspecified, -u, --unity-version, or the UNITY_EDITOR_PATH environment variable must be set.')
    .option('--verbose', 'Enable verbose logging.')
    .option('--json', 'Prints the last line of output as JSON string.')
    .action(async (options) => {
        if (options.verbose) {
            Logger.instance.logLevel = LogLevel.DEBUG;
        }

        Logger.instance.debugOptions(options);

        const unityVersionStr = options.unityVersion?.toString()?.trim();

        if (!unityVersionStr && !options.unityEditor) {
            Logger.instance.error('You must specify a Unity version or editor path with -u, --unity-version, -e, --unity-editor.');
            process.exit(1);
        }

        let unityEditor: UnityEditor;

        if (unityVersionStr) {
            const unityVersion = new UnityVersion(unityVersionStr);
            unityEditor = await new UnityHub().GetEditor(unityVersion);
        } else {
            const editorPath = options.unityEditor?.toString()?.trim() || process.env.UNITY_EDITOR_PATH;

            if (!editorPath || editorPath.length === 0) {
                Logger.instance.error('The Unity Editor path was not specified. Use -e or --unity-editor to specify it, or set the UNITY_EDITOR_PATH environment variable.');
                process.exit(1);
            }

            unityEditor = new UnityEditor(editorPath);
        }

        let args: string[] = [
            '-quit',
            '-nographics',
            '-batchmode'
        ];

        const projectName = options.name?.toString()?.trim();
        let projectPath = options.path?.toString()?.trim() || process.cwd();

        if (projectName && projectName.length > 0) {
            projectPath = path.join(projectPath, projectName);
        }

        args.push('-createProject', projectPath);

        if (!unityEditor.version.isLegacy() && options.template && options.template.length > 0) {
            const templatePath = unityEditor.GetTemplatePath(options.template);

            if (templatePath) {
                args.push('-cloneFromTemplate', templatePath);
            }
        }

        await unityEditor.Run({ projectPath, args });

        Logger.instance.CI_setEnvironmentVariable('UNITY_PROJECT_PATH', projectPath);

        if (options.json) {
            process.stdout.write(`\n${JSON.stringify({ UNITY_PROJECT_PATH: projectPath })}\n`);
        } else {
            process.stdout.write(`Unity project created at: ${projectPath}\n`);
        }

        process.exit(0);
    });

program.command('open-project')
    .description('Open a Unity project in the Unity Editor.')
    .option('-p, --unity-project <unityProject>', 'The path to a Unity project. If unspecified, the UNITY_PROJECT_PATH environment variable or the current working directory will be used.')
    .option('-u, --unity-version <unityVersion>', 'The Unity version to get (e.g. 2020.3.1f1, 2021.x, 2022.1.*, 6000). If specified, it will override the version read from the project.')
    .option('-t, --build-target <buildTarget>', 'The Unity build target to switch the project to (e.g. StandaloneWindows64, StandaloneOSX, iOS, Android).')
    .option('--verbose', 'Enable verbose logging.')
    .action(async (options) => {
        if (options.verbose) {
            Logger.instance.logLevel = LogLevel.DEBUG;
        }

        Logger.instance.debugOptions(options);
        const projectPath = options.unityProject?.toString()?.trim() ||
            process.env.UNITY_PROJECT_PATH ||
            undefined;
        const unityProject = await UnityProject.GetProject(projectPath);

        if (!unityProject) {
            Logger.instance.error(`The specified path is not a valid Unity project: ${projectPath}`);
            process.exit(1);
        }

        let unityVersion: UnityVersion | undefined = unityProject?.version;

        if (options.unityVersion) {
            unityVersion = new UnityVersion(options.unityVersion);
        }

        const buildTarget = options.buildTarget?.toString()?.trim();
        let module: string[] | undefined = undefined;

        if (buildTarget && buildTarget.length > 0) {
            const moduleBuildTargetMap = UnityHub.GetPlatformTargetModuleMap();
            module = moduleBuildTargetMap[buildTarget] ? [moduleBuildTargetMap[buildTarget]] : undefined;
        }

        const unityHub = new UnityHub();
        const unityEditor = await unityHub.GetEditor(unityVersion, module);

        Logger.instance.info(`Opening "${unityProject.projectPath}" with Unity ${unityEditor.version}${buildTarget ? ` - ${buildTarget}` : ''}...`);

        const openArgs = ['-projectPath', unityProject.projectPath];

        if (buildTarget && buildTarget.length > 0) {
            openArgs.push('-buildTarget', buildTarget);
        }

        let child: ChildProcess | null = null;
        try {
            child = spawn(unityEditor.editorPath, openArgs, { detached: true });
            child.unref();
        } finally {
            process.exit(child?.pid !== undefined ? 0 : 1);
        }
    });

program.command('editor-logs')
    .description('Prints the path to the Unity Editor log files.')
    .action(async () => {
        const unityEditorLogsPath = UnityEditor.GetEditorLogsDirectory();
        process.stdout.write(`${unityEditorLogsPath}\n`);
        process.exit(0);
    });

program.commandsGroup("Unity Package Manager:");

program.command('upm-install')
    .description('Download and install the Unity Package Manager cli (pack/sign).')
    .option('--verbose', 'Enable verbose logging.')
    .option('--auto-update', 'Automatically updates the upm cli if a newer release is available. Cannot be used with --version.')
    .option('--version <version>', 'upm cli release tag (e.g. v9.27.0). Defaults to latest from Unity CDN.')
    .option('--json', 'Print UPM release tag, CLI path, and managed install root as JSON.')
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
            Logger.instance.error(`${error}`);
            process.exit(1);
        }
    });

program.command('upm-version')
    .description('Print the managed upm cli version.')
    .action(async () => {
        try {
            const upmCli = new UpmCli();
            const version = await upmCli.Version();
            process.stdout.write(`v${version.version}\n`);
            process.exit(0);
        } catch (error) {
            Logger.instance.error(`${error}`);
            process.exit(1);
        }
    });

interface UpmPackCliOptions {
    source?: string;
    destination?: string;
    verbose?: boolean;
}

program.command('upm-pack')
    .description('Pack a Unity package (bundled UPM CLI `pack` command).')
    .option('--source <path>', 'An absolute or relative path to the root folder of the custom package to pack. This is the folder that contains the package manifest file (package.json). (optional; defaults to the current working directory).')
    .option('--destination <path>', 'The output path where UPM CLI places the signed tarball. If you specify a folder that doesn\'t exist, UPM CLI creates it. Note: If you omit this parameter, UPM CLI places the file in the current working directory.')
    .option('--verbose', 'Enable verbose logging.')
    .action(async (options: UpmPackCliOptions) => {
        if (options.verbose) {
            Logger.instance.logLevel = LogLevel.DEBUG;
        }

        Logger.instance.debugOptions({ options });

        try {
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

            const upm = new UpmCli();
            await upm.PromptInstallOrUpdateWhenInteractive();
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
            Logger.instance.error(`${error}`);
            process.exit(1);
        }
    });

program.command('sign-package')
    .description('[Deprecated] Sign a Unity package using Unity Editor 6000.3+ batch mode (-upmPack). Prefer `unity-cli upm-pack` for new workflows.')
    .option('--package <package>', 'Required. The fully qualified path to the folder that contains the package.json file for the package you want to sign. Note: Don\'t include package.json in this parameter value.')
    .option('--output <output>', 'Optional. The output directory where you want to save the signed tarball file (.tgz). If unspecified, the package contents will be updated in place with the signed .attestation.p7m file.')
    .option('--email <email>', 'Email associated with the Unity account. If unspecified, the UNITY_USERNAME environment variable will be used.')
    .option('--password <password>', 'The password of the Unity account. If unspecified, the UNITY_PASSWORD environment variable will be used.')
    .option('--organization <organization>', 'The Organization ID you copied from the Unity Cloud Dashboard. If unspecified, the UNITY_ORGANIZATION_ID environment variable will be used.')
    .option('--verbose', 'Enable verbose logging.')
    .action(async (options) => {
        Logger.instance.warn('The sign-package command is deprecated. Use `unity-cli upm-pack` instead.');

        if (options.verbose) {
            Logger.instance.logLevel = LogLevel.DEBUG;
        }

        Logger.instance.debugOptions(options);

        const packagePath = path.normalize(options.package?.toString()?.trim());

        if (!packagePath || packagePath.length === 0) {
            Logger.instance.error('The package path is required. Use --package to specify it.');
            process.exit(1);
        }

        const packageJsonPath = path.join(packagePath, 'package.json');
        try {
            await fs.promises.access(packageJsonPath, fs.constants.R_OK);
        } catch {
            Logger.instance.error(`Failed to find a valid package.json file at: ${packageJsonPath}`);
            process.exit(1);
        }

        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));

        let outputPath = options.output?.toString()?.trim();

        if (outputPath && outputPath.length > 0) {
            outputPath = path.resolve(outputPath);

            if (outputPath.endsWith('.tgz')) {
                // remove .tgz if present
                outputPath = outputPath.substring(0, outputPath.length - 4);
            }
        } else {
            outputPath = path.join(path.resolve(packagePath, '..'));
        }

        let username = options.email?.toString()?.trim() || process.env.UNITY_USERNAME || undefined;

        if (!username || username.length === 0) {
            username = await PromptForSecretInput('Email: ');
        }

        if (!username || username.length === 0) {
            Logger.instance.error('The email is required. Use --email to specify it.');
            process.exit(1);
        }

        let password = options.password?.toString()?.trim() || process.env.UNITY_PASSWORD || undefined;

        if (!password || password.length === 0) {
            password = await PromptForSecretInput('Password: ');
        }

        if (!password || password.length === 0) {
            Logger.instance.error('The password is required. Use --password to specify it.');
            process.exit(1);
        }

        let organization = options.organization?.toString()?.trim() || process.env.UNITY_ORGANIZATION_ID || undefined;

        if (!organization || organization.length === 0) {
            organization = await PromptForSecretInput('Organization ID: ');
        }

        if (!organization || organization.length === 0) {
            Logger.instance.error('The organization ID is required. Use --organization to specify it.');
            process.exit(1);
        }

        // Mask credentials in CI environments before any potential logging
        Logger.instance.maskCredential(username);
        Logger.instance.maskCredential(password);
        Logger.instance.maskCredential(organization);

        // must use a unity editor 6000.3 or newer
        const unityVersion = new UnityVersion('6000.3');
        const unityHub = new UnityHub();
        const unityEditor = await unityHub.GetEditor(unityVersion, undefined, ['f', 'b']);
        try {
            await unityEditor.Run({
                args: [
                    '-batchmode',
                    '-username', username,
                    '-password', password,
                    '-upmPack', packagePath, path.normalize(outputPath),
                    '-cloudOrganization', organization
                ]
            });
        } catch (error) {
            // currently the editor returns exit code 1 even on success
        } finally {
            if (fs.existsSync(outputPath)) {
                const pkg = await ResolveGlobToPath([outputPath, `${path.basename(packageJson.name)}*.tgz`]);
                Logger.instance.info(`Package signed successfully: ${pkg}`);

                // if the output directory was not specified in the command options,
                // then unpack the .tgz file and overwrite the package contents.
                if (!options.output || options.output.length === 0) {
                    await tar.x({
                        file: pkg,
                        cwd: packagePath,
                        strip: 1
                    });

                    Logger.instance.info(`Package contents extracted to: ${packagePath}`);
                    fs.unlinkSync(pkg);
                }

                process.exit(0);
            } else {
                Logger.instance.error('Failed to sign the package.');
                process.exit(1);
            }
        }
    });

program.parse(process.argv);
