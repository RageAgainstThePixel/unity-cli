#!/usr/bin/env node

import 'source-map-support/register';
import { Command } from 'commander';
import { readFileSync } from 'fs';
import { join } from 'path';
import { LicenseType, LicensingClient } from './license-client';
import { PromptForSecretInput } from './utilities';
import { UnityHub } from './unity-hub';
import { Logger, LogLevel } from './logging';
import { UnityVersion } from './unity-version';
import { UnityProject } from './unity-project';
import { CheckAndroidSdkInstalled } from './android-sdk';

const pkgPath = join(__dirname, '..', 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
const program = new Command();

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

        await client.Activate(licenseType, options.config, options.serial, options.email, options.password);
    });

program.command('return-license')
    .description('Return a Unity license.')
    .option('-l, --license <license>', 'License type (personal, professional, floating)')
    .option('--verbose', 'Enable verbose logging.')
    .action(async (options) => {
        if (options.verbose) {
            Logger.instance.logLevel = LogLevel.DEBUG;
        }

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

program.command('hub-version')
    .description('Print the version of the Unity Hub.')
    .action(async () => {
        const unityHub = new UnityHub();
        const version = await unityHub.Version();
        process.stdout.write(version);
    });

program.command('hub-install')
    .description('Install the Unity Hub.')
    .option('--verbose', 'Enable verbose logging.')
    .option('--json', 'Prints the last line of output as JSON string.')
    .action(async (options) => {
        if (options.verbose) {
            Logger.instance.logLevel = LogLevel.DEBUG;
        }

        const unityHub = new UnityHub();
        const hubPath = await unityHub.Install();

        if (options.json) {
            process.stdout.write(JSON.stringify({ UNITY_HUB: hubPath }));
        } else {
            process.stdout.write(hubPath);
        }
    });

program.command('hub-path')
    .description('Print the path to the Unity Hub executable.')
    .action(async () => {
        const hub = new UnityHub();
        process.stdout.write(hub.executable);
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

        const hub = new UnityHub();
        await hub.Exec(args, { silent: false, showCommand: Logger.instance.logLevel === LogLevel.DEBUG });
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
            throw new Error('You must specify a Unity version or project with -u, --unity-version, -p, --unity-project.');
        }

        const unityVersion = unityProject?.version ?? new UnityVersion(options.unityVersion, options.changeset);
        const modules: string[] = options.modules ? options.modules.split(/[ ,]+/).filter(Boolean) : [];
        const unityHub = new UnityHub();

        const output: { [key: string]: string } = {};

        output['UNITY_HUB_PATH'] = unityHub.executable;

        const editorPath = await unityHub.GetEditor(unityVersion, modules);

        output['UNITY_EDITOR'] = editorPath;

        if (unityProject) {
            output['UNITY_PROJECT'] = unityProject.projectPath;

            if (modules.includes('android')) {
                await CheckAndroidSdkInstalled(editorPath, unityProject.projectPath);
            }
        }

        process.stdout.write(JSON.stringify(output));
    });

program.parse(process.argv);
