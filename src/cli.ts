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

const pkgPath = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
updateNotifier({ pkg }).notify();
const program = new Command();

program.name('unity-cli')
    .description('Bridges the gaps in the official Unity CLI (unity) for CI: Unity ID licensing, Unity 4.x and 5.x editors, Android SDK setup and Editor log annotations.')
    .version(pkg.version);

program.command('setup-cli')
    .description('Install the official Unity CLI (unity), or reuse it when the requested version is already installed.')
    .option('--unity-cli-version <version>', 'An exact official Unity CLI version (e.g. 1.0.0-beta.14) or latest. Defaults to an installed CLI, then the version unity-cli is tested against.')
    .option('--verbose', 'Enable verbose logging.')
    .option('--json', 'Prints the last line of output as JSON string.')
    .action(async (options) => {
        if (options.verbose) {
            Logger.instance.logLevel = LogLevel.DEBUG;
        }

        Logger.instance.debugOptions(options);
        const cli = await UnityCli.Get(options.unityCliVersion?.toString()?.trim() || undefined);

        if (options.json) {
            process.stdout.write(`\n${JSON.stringify({ UNITY_CLI_PATH: cli.executable, UNITY_CLI_VERSION: cli.version })}\n`);
        } else {
            process.stdout.write(`${cli.executable}\n`);
        }

        process.exit(0);
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
    .option('-e, --email <email>', 'Email associated with the Unity account. Used when the Unity CLI cannot activate a personal or professional license.')
    .option('-p, --password <password>', 'Password for the Unity account. Used when the Unity CLI cannot activate a personal or professional license.')
    .option('-s, --serial <serial>', 'License serial number. Required when activating a professional license.')
    .option('-c, --config <config>', 'Path to the configuration file, raw JSON, or base64 encoded JSON string. Required when activating a floating license.')
    .option('-f, --license-file <licenseFile>', 'A cached license file (Unity_lic.ulf) from an earlier activation on a machine with the same identity: a path, the raw XML, or base64. Defaults to the UNITY_LICENSE environment variable. Falls back to the email and password when it cannot be used.')
    .option('--verbose', 'Enable verbose logging.')
    .option('--json', 'Prints the last line of output as JSON string.')
    .action(async (options) => {
        if (options.verbose) {
            Logger.instance.logLevel = LogLevel.DEBUG;
        }

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
        }

        // Mask credentials in CI environments before any potential logging
        Logger.instance.maskCredential(options.email);
        Logger.instance.maskCredential(options.password);
        Logger.instance.maskCredential(options.serial);

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

        const token: string | undefined = options.token?.toString()?.trim() || undefined;

        // Mask token in CI environments before any potential logging
        Logger.instance.maskCredential(token);

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
    .option('--unity-cli-version <version>', 'The official Unity CLI version to install when it is missing (e.g. 1.0.0-beta.14, latest).')
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

        const unityCli = await UnityCli.Get(options.unityCliVersion?.toString()?.trim() || undefined);
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

void program.parseAsync(process.argv).catch((err: unknown) => {
    Logger.instance.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
});
