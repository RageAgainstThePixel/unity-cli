#!/usr/bin/env node

import 'source-map-support/register';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Command } from 'commander';
import { UnityHub } from './unity-hub';
import updateNotifier from "update-notifier";
import { Logger, LogLevel } from './logging';
import { UnityEditor } from './unity-editor';
import { UnityVersion } from './unity-version';
import { UnityProject } from './unity-project';
import { ChildProcess, spawn } from 'child_process';
import { PromptForSecretInput } from './utilities';
import { CheckAndroidSdkInstalled } from './android-sdk';
import { LicenseType, LicensingClient } from './license-client';

const pkgPath = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
updateNotifier({ pkg }).notify();
const program = new Command();

program.commandsGroup('Auth:');

program.name('unity-cli')
    .description('A command line utility for the Unity Game Engine.')
    .version(pkg.version);

program.command('license-version')
    .description('Print the version of the Unity License Client.')
    .action(async () => {
        const client = new LicensingClient();
        await client.Version();
    });

program.command('activate-license')
    .description('Activate a Unity license.')
    .option('-e, --email <email>', 'Email associated with the Unity account. Required when activating a personal or professional license.')
    .option('-p, --password <password>', 'Password for the Unity account. Required when activating a personal or professional license.')
    .option('-s, --serial <serial>', 'License serial number. Required when activating a professional license.')
    .option('-l, --license <license>', 'License type (personal, professional, floating).')
    .option('-c, --config <config>', 'Path to the configuration file. Required when activating a floating license.')
    .option('--verbose', 'Enable verbose logging.')
    .action(async (options) => {
        if (options.verbose) {
            Logger.instance.logLevel = LogLevel.DEBUG;
        }

        Logger.instance.debug(JSON.stringify(options));

        const client = new LicensingClient();
        const licenseStr: string = options.license?.toString()?.trim();

        if (!licenseStr || licenseStr.length === 0) {
            throw new Error('License type is required. Use -l or --license to specify it.');
        }

        const licenseType: LicenseType = options.license.toLowerCase() as LicenseType;

        if (![LicenseType.personal, LicenseType.professional, LicenseType.floating].includes(licenseType)) {
            throw new Error(`Invalid license type: ${licenseType}`);
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
        }

        await client.Activate({
            licenseType,
            servicesConfig: options.config,
            serial: options.serial,
            username: options.email,
            password: options.password
        });
    });

program.command('return-license')
    .description('Return a Unity license.')
    .option('-l, --license <license>', 'License type (personal, professional, floating)')
    .option('--verbose', 'Enable verbose logging.')
    .action(async (options) => {
        if (options.verbose) {
            Logger.instance.logLevel = LogLevel.DEBUG;
        }

        Logger.instance.debug(JSON.stringify(options));

        const client = new LicensingClient();
        const licenseStr: string = options.license?.toString()?.trim();

        if (!licenseStr || licenseStr.length === 0) {
            throw new Error('License type is required. Use -l or --license to specify it.');
        }

        const licenseType: LicenseType = licenseStr.toLowerCase() as LicenseType;

        if (![LicenseType.personal, LicenseType.professional, LicenseType.floating].includes(licenseType)) {
            throw new Error(`Invalid license type: ${licenseType}`);
        }

        await client.Deactivate(licenseType);
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
        }
    });

program.command('hub-install')
    .description('Install the Unity Hub.')
    .option('--verbose', 'Enable verbose logging.')
    .option('--auto-update', 'Automatically updates the Unity Hub if it is already installed.')
    .option('--json', 'Prints the last line of output as JSON string.')
    .action(async (options) => {
        if (options.verbose) {
            Logger.instance.logLevel = LogLevel.DEBUG;
        }

        Logger.instance.debug(JSON.stringify(options));

        const unityHub = new UnityHub();
        const hubPath = await unityHub.Install(options.autoUpdate === true);

        Logger.instance.CI_setEnvironmentVariable('UNITY_HUB_PATH', hubPath);

        if (options.json) {
            process.stdout.write(`\n${JSON.stringify({ UNITY_HUB_PATH: hubPath })}\n`);
        } else {
            process.stdout.write(`${hubPath}\n`);
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
    });

program.command('hub')
    .description('Run commands directly to the Unity Hub. (You need not to pass --headless or -- to this command).')
    .argument('<args...>', 'Arguments to pass to the Unity Hub executable.')
    .option('--verbose', 'Enable verbose logging.')
    .action(async (args: string[], options) => {
        if (options.verbose) {
            Logger.instance.logLevel = LogLevel.DEBUG;
        }

        Logger.instance.debug(JSON.stringify({ args, options }));

        const unityHub = new UnityHub();
        await unityHub.Exec(args, { silent: false, showCommand: Logger.instance.logLevel === LogLevel.DEBUG });
    });

program.command('setup-unity')
    .description('Sets up the environment for the specified project and finds or installs the Unity Editor version for it.')
    .option('-p, --unity-project <unityProjectPath>', 'The path to a Unity project or "none" to skip project detection.')
    .option('-u, --unity-version <unityVersion>', 'The Unity version to get (e.g. 2020.3.1f1, 2021.x, 2022.1.*, 6000). If specified, it will override the version read from the project.')
    .option('-c, --changeset <changeset>', 'The Unity changeset to get (e.g. 1234567890ab).')
    .option('-a, --arch <architecture>', 'The Unity architecture to get (e.g. x86_64, arm64). Defaults to the architecture of the current process.')
    .option('-b, --build-targets <buildTargets>', 'The Unity build target to get (e.g. iOS, Android).')
    .option('-m, --modules <modules>', 'The Unity module to get (e.g. ios, android).')
    .option('-i, --install-path <installPath>', 'The path to install the Unity Editor to. By default, it will be installed to the default Unity Hub location.')
    .option('--verbose', 'Enable verbose logging.')
    .option('--json', 'Prints the last line of output as JSON string.')
    .action(async (options) => {
        if (options.verbose) {
            Logger.instance.logLevel = LogLevel.DEBUG;
        }

        Logger.instance.debug(JSON.stringify(options));

        let unityProject: UnityProject | undefined;

        if (options.unityProject) {
            unityProject = await UnityProject.GetProject(options.unityProject);
        }

        if (!options.unityVersion && !unityProject) {
            throw new Error('You must specify a Unity version or project path with -u, --unity-version, -p, --unity-project.');
        }

        const unityVersion = unityProject?.version ?? new UnityVersion(options.unityVersion, options.changeset);
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
                await CheckAndroidSdkInstalled(unityEditor.editorPath, unityProject.projectPath);
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
    });

program.command('uninstall-unity')
    .description('Uninstall the specified Unity Editor version.')
    .option('-e, --unity-editor <unityEditorPath>', 'The path to the Unity Editor executable. If unspecified, -u, --unity-version or the UNITY_EDITOR_PATH environment variable must be set.')
    .option('-u, --unity-version <unityVersion>', 'The Unity version to get (e.g. 2020.3.1f1, 2021.x, 2022.1.*, 6000). If unspecified, then --unity-editor must be specified.')
    .option('-c, --changeset <changeset>', 'The Unity changeset to get (e.g. 1234567890ab).')
    .option('-a, --arch <architecture>', 'The Unity architecture to get (e.g. x86_64, arm64). Defaults to the architecture of the current process.')
    .option('--verbose', 'Enable verbose logging.')
    .action(async (options) => {
        if (options.verbose) {
            Logger.instance.logLevel = LogLevel.DEBUG;
        }

        Logger.instance.debug(JSON.stringify(options));

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
                throw new Error('You must specify a Unity version or editor path with -u, --unity-version, -e, --unity-editor.');
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

program.command('open-project')
    .description('Open a Unity project in the Unity Editor.')
    .option('-p, --unity-project <unityProjectPath>', 'The path to a Unity project. If unspecified, the UNITY_PROJECT_PATH environment variable or the current working directory will be used.')
    .option('-u, --unity-version <unityVersion>', 'The Unity version to get (e.g. 2020.3.1f1, 2021.x, 2022.1.*, 6000). If specified, it will override the version read from the project.')
    .option('--verbose', 'Enable verbose logging.')
    .action(async (options) => {
        if (options.verbose) {
            Logger.instance.logLevel = LogLevel.DEBUG;
        }

        Logger.instance.debug(JSON.stringify(options));
        const projectPath = options.unityProject?.toString()?.trim() || process.env.UNITY_PROJECT_PATH || process.cwd();
        const unityProject = await UnityProject.GetProject(projectPath);

        if (!unityProject) {
            throw new Error(`The specified path is not a valid Unity project: ${projectPath}`);
        }

        const unityVersion = unityProject?.version ?? new UnityVersion(options.unityVersion, options.changeset);
        const unityHub = new UnityHub();
        const unityEditor = await unityHub.GetEditor(unityVersion);

        Logger.instance.info(`Opening project at "${unityProject.projectPath}" with Unity ${unityEditor.version}...`);

        let child: ChildProcess | null = null;
        try {
            child = spawn(unityEditor.editorPath, ['-projectPath', unityProject.projectPath], { detached: true });
            child.unref();
        } finally {
            process.exit(child?.pid !== undefined ? 0 : 1);
        }
    });

program.command('run')
    .description('Run command line args directly to the Unity Editor.')
    .option('--unity-editor <unityEditorPath>', 'The path to the Unity Editor executable. If unspecified, --unity-project or the UNITY_EDITOR_PATH environment variable must be set.')
    .option('--unity-project <unityProjectPath>', 'The path to a Unity project. If unspecified, the UNITY_PROJECT_PATH environment variable or the current working directory will be used.')
    .option('--log-name <logName>', 'The name of the log file.')
    .option('--verbose', 'Enable verbose logging.')
    .argument('<args...>', 'Arguments to pass to the Unity Editor executable.')
    .action(async (args: string[], options) => {
        if (options.verbose) {
            Logger.instance.logLevel = LogLevel.DEBUG;
        }

        Logger.instance.debug(JSON.stringify({ options, args }));

        let unityEditor: UnityEditor | undefined;
        const editorPath = options.unityEditor?.toString()?.trim() || process.env.UNITY_EDITOR_PATH || undefined;

        if (editorPath && editorPath.length > 0) {
            unityEditor = new UnityEditor(editorPath);
        }

        const projectPath = options.unityProject?.toString()?.trim() || process.env.UNITY_PROJECT_PATH || process.cwd();
        const unityProject = await UnityProject.GetProject(projectPath);

        if (!unityProject) {
            throw new Error(`The specified path is not a valid Unity project: ${projectPath}`);
        }

        if (!unityEditor) {
            const unityHub = new UnityHub();
            unityEditor = await unityHub.GetEditor(unityProject.version);
        }

        if (!unityEditor) {
            throw new Error('The Unity Editor path was not specified. Use --unity-editor to specify it or set the UNITY_EDITOR_PATH environment variable.');
        }

        if (!args.includes('-logFile')) {
            const logPath = unityEditor.GenerateLogFilePath(unityProject.projectPath, options.logName);
            args.push('-logFile', logPath);
        }

        await unityEditor.Run({
            args: [...args]
        });
    });

program.command('list-project-templates')
    .description('List all available project templates for the given Unity editor.')
    .option('-u, --unity-version <unityVersion>', 'The Unity version to get (e.g. 2020.3.1f1, 2021.x, 2022.1.*, 6000). If unspecified, then --unity-editor must be specified.')
    .option('-e, --unity-editor <unityEditorPath>', 'The path to the Unity Editor executable. If unspecified, the UNITY_EDITOR_PATH environment variable must be set.')
    .option('--verbose', 'Enable verbose logging.')
    .option('--json', 'Prints the last line of output as JSON string.')
    .action(async (options) => {
        if (options.verbose) {
            Logger.instance.logLevel = LogLevel.DEBUG;
        }

        Logger.instance.debug(JSON.stringify(options));

        const unityVersionStr = options.unityVersion?.toString()?.trim();

        if (!unityVersionStr && !options.unityEditor) {
            throw new Error('You must specify a Unity version or editor path with -u, --unity-version, -e, --unity-editor.');
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
                process.stdout.write(`Available project templates:\n`);
                for (const template of templates) {
                    process.stdout.write(`  - ${path.basename(template)}\n`);
                }
            }
        } else {
            process.stdout.write('No project templates found for this Unity Editor.\n');
        }
    });

program.command('create-project')
    .description('Create a new Unity project.')
    .option('-n, --name <projectName>', 'The name of the new Unity project. If unspecified, the project will be created in the specified path or the current working directory.')
    .option('-p, --path <projectPath>', 'The path to create the new Unity project. If unspecified, the current working directory will be used.')
    .option('-t, --template <projectTemplate>', 'The name of the template package to use for creating the unity project. Supports regex patterns.', 'com.unity.template.3d(-cross-platform)?')
    .option('-u, --unity-version <unityVersion>', 'The Unity version to get (e.g. 2020.3.1f1, 2021.x, 2022.1.*, 6000). If unspecified, then --unity-editor must be specified.')
    .option('-e, --unity-editor <unityEditorPath>', 'The path to the Unity Editor executable. If unspecified, -u, --unity-version, or the UNITY_EDITOR_PATH environment variable must be set.')
    .option('--verbose', 'Enable verbose logging.')
    .option('--json', 'Prints the last line of output as JSON string.')
    .action(async (options) => {
        if (options.verbose) {
            Logger.instance.logLevel = LogLevel.DEBUG;
        }

        Logger.instance.debug(JSON.stringify(options));

        const unityVersionStr = options.unityVersion?.toString()?.trim();

        if (!unityVersionStr && !options.unityEditor) {
            throw new Error('You must specify a Unity version or editor path with -u, --unity-version, -e, --unity-editor.');
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
            args.push('-cloneFromTemplate', templatePath);
        }

        await unityEditor.Run({ projectPath, args });

        Logger.instance.CI_setEnvironmentVariable('UNITY_PROJECT_PATH', projectPath);

        if (options.json) {
            process.stdout.write(`\n${JSON.stringify({ UNITY_PROJECT_PATH: projectPath })}\n`);
        } else {
            process.stdout.write(`Unity project created at: ${projectPath}\n`);
        }
    });

program.parse(process.argv);
