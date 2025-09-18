#!/usr/bin/env node

import { Command } from 'commander';
import { readFileSync } from 'fs';
import { join } from 'path';
import { LicenseType, LicensingClient } from './license-client';
import { PromptForSecretInput } from './utilities';
import { UnityHub } from './unity-hub';
import { Logger, LogLevel } from './logging';
import { UnityVersion } from './unity-version';

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
        const licenseType: LicenseType = options.license.toString().toLowerCase() as LicenseType;

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
        const licenseType: LicenseType = options.license.toString().toLowerCase() as LicenseType;

        if (![LicenseType.personal, LicenseType.professional, LicenseType.floating].includes(licenseType)) {
            throw new Error(`Invalid license type: ${licenseType}`);
        }

        await client.Deactivate(licenseType);
    });

program.command('hub-version')
    .description('Print the version of the Unity Hub.')
    .action(async () => {
        const hub = new UnityHub();
        await hub.Version();
    });

program.command('hub-install')
    .description('Install the Unity Hub.')
    .option('--verbose', 'Enable verbose logging.')
    .action(async (options) => {
        if (options.verbose) {
            Logger.instance.logLevel = LogLevel.DEBUG;
        }

        const hub = new UnityHub();
        await hub.Install();
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
    .option('--verbose', 'Enable verbose logging.')
    .argument('<args...>', 'Arguments to pass to the Unity Hub executable.')
    .action(async (args: string[], options) => {
        if (options.verbose) {
            Logger.instance.logLevel = LogLevel.DEBUG;
        }

        const hub = new UnityHub();
        await hub.Exec(args, { silent: false, showCommand: Logger.instance.logLevel === LogLevel.DEBUG });
    });

program.command('hub-get-editor')
    .description('Attempts to find or install the specified Unity Editor version.')
    .option('-u, --unity-version <unityVersion>', 'The Unity version to get (e.g. 2020.3.1f1, 2021.x, 2022.1.*, 6000).')
    .option('-c, --changeset <changeset>', 'The Unity changeset to get (e.g. 1234567890ab).')
    .option('-m, --modules <modules>', 'The Unity module to get (e.g. ios, android).')
    .option('--verbose', 'Enable verbose logging.')
    .action(async (options) => {
        if (options.verbose) {
            Logger.instance.logLevel = LogLevel.DEBUG;
        }

        Logger.instance.debug(JSON.stringify(options));

        if (!options.unityVersion) {
            throw new Error('You must specify a Unity version with -u or --unity-version.');
        }

        const unityVersion = new UnityVersion(options.unityVersion, options.changeset);
        const modules: string[] = options.modules ? options.modules.split(',').split(' ') : [];
        const hub = new UnityHub();

        const editorPath = await hub.GetEditor(unityVersion, modules);
        process.stdout.write(editorPath);
    });

program.parse(process.argv);
