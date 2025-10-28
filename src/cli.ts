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

const pkgPath = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
updateNotifier({ pkg }).notify();
const program = new Command();

program.name('unity-cli')
    .description('A command line utility for the Unity Game Engine.')
    .version(pkg.version);

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
    .option('-c, --config <config>', 'Path to the configuration file, or base64 encoded JSON string. Required when activating a floating license.')
    .option('--verbose', 'Enable verbose logging.')
    .action(async (options) => {
        if (options.verbose) {
            Logger.instance.logLevel = LogLevel.DEBUG;
        }

        Logger.instance.debug(JSON.stringify(options));

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
        }

        await client.Activate({
            licenseType,
            servicesConfig: options.config,
            serial: options.serial,
            username: options.email,
            password: options.password
        });
        process.exit(0);
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
            Logger.instance.error('License type is required. Use -l or --license to specify it.');
            process.exit(1);
        }

        const licenseType: LicenseType = licenseStr.toLowerCase() as LicenseType;

        if (![LicenseType.personal, LicenseType.professional, LicenseType.floating].includes(licenseType)) {
            Logger.instance.error(`Invalid license type: ${licenseType}`);
            process.exit(1);
        }

        await client.Deactivate(licenseType);
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

        Logger.instance.debug(JSON.stringify(options));

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

program.command('hub')
    .description('Run commands directly to the Unity Hub. (You need not to pass --headless or -- to this command).')
    .allowUnknownOption(true)
    .argument('<args...>', 'Arguments to pass to the Unity Hub executable.')
    .option('--verbose', 'Enable verbose logging.')
    .action(async (args: string[], options) => {
        if (options.verbose) {
            Logger.instance.logLevel = LogLevel.DEBUG;
        }

        Logger.instance.debug(JSON.stringify({ args, options }));

        const unityHub = new UnityHub();
        await unityHub.Exec(args, { silent: false, showCommand: Logger.instance.logLevel === LogLevel.DEBUG });
        process.exit(0);
    });

program.command('setup-unity')
    .description('Sets up the environment for the specified project and finds or installs the Unity Editor version for it.')
    .option('-p, --unity-project <unityProject>', 'The path to a Unity project or "none" to skip project detection.')
    .option('-u, --unity-version <unityVersion>', 'The Unity version to get (e.g. 2020.3.1f1, 2021.x, 2022.1.*, 6000). If specified, it will override the version read from the project.')
    .option('-c, --changeset <changeset>', 'The Unity changeset to get (e.g. 1234567890ab).')
    .option('-a, --arch <arch>', 'The Unity architecture to get (e.g. x86_64, arm64). Defaults to the architecture of the current process.')
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
    .option('--verbose', 'Enable verbose logging.')
    .allowUnknownOption(true)
    .argument('<args...>', 'Arguments to pass to the Unity Editor executable.')
    .action(async (args: string[], options) => {
        if (options.verbose) {
            Logger.instance.logLevel = LogLevel.DEBUG;
        }

        Logger.instance.debug(JSON.stringify({ options, args }));

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

        Logger.instance.debug(JSON.stringify(options));

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

        Logger.instance.debug(JSON.stringify(options));

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

        Logger.instance.debug(JSON.stringify(options));
        const projectPath = options.unityProject?.toString()?.trim() || process.env.UNITY_PROJECT_PATH || undefined;
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

program.commandsGroup("Unity Package Manager:");

program.command('sign-package')
    .description('Sign a Unity package.')
    .option('--package <package>', 'Required. The fully qualified path to the folder that contains the package.json file for the package you want to sign. Note: Don’t include package.json in this parameter value.')
    .option('--output <output>', 'Optional. The output directory where you want to save the signed tarball file (.tgz). If unspecified, the package contents will be updated in place with the signed .attestation.p7m file.')
    .option('--email <email>', 'Email associated with the Unity account. If unspecified, the UNITY_USERNAME environment variable will be used.')
    .option('--password <password>', 'The password of the Unity account. If unspecified, the UNITY_PASSWORD environment variable will be used.')
    .option('--organization <organization>', 'The Organization ID you copied from the Unity Cloud Dashboard. If unspecified, the UNITY_ORGANIZATION_ID environment variable will be used.')
    .option('--verbose', 'Enable verbose logging.')
    .action(async (options) => {
        if (options.verbose) {
            Logger.instance.logLevel = LogLevel.DEBUG;
        }

        Logger.instance.debug(JSON.stringify(options));

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
