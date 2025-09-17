#!/usr/bin/env node

import { Command } from 'commander';
import { readFileSync } from 'fs';
import { join } from 'path';
import { LicenseType, LicensingClient } from './license-client';
import { promptForSecretInput } from './utilities';

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
    .option('--email <email>', 'Email associated with the Unity account. Required when activating a personal or professional license.')
    .option('--password <password>', 'Password for the Unity account. Required when activating a personal or professional license.')
    .option('--serial <serial>', 'License serial number. Required when activating a professional license.')
    .option('--type <type>', 'License type (personal, professional, floating)')
    .option('--config <config>', 'Path to the configuration file. Required when activating a floating license.')
    .action(async (options) => {
        const client = new LicensingClient();
        const licenseType: LicenseType = options.type;
        if (![LicenseType.personal, LicenseType.professional, LicenseType.floating].includes(licenseType)) {
            throw new Error(`Invalid license type: ${licenseType}`);
        }

        if (licenseType !== LicenseType.floating) {
            if (!options.email) {
                options.email = await promptForSecretInput('Email: ');
            }

            if (!options.password) {
                options.password = await promptForSecretInput('Password: ');
            }

            if (licenseType === LicenseType.professional && !options.serial) {
                options.serial = await promptForSecretInput('Serial: ');
            }
        }

        await client.Activate(licenseType, options.config, options.serial, options.email, options.password);
    });

program.command('return-license')
    .description('Return a Unity license.')
    .option('--type <type>', 'License type (personal, professional, floating)')
    .action(async (options) => {
        const client = new LicensingClient();
        const licenseType: LicenseType = options.type;
        if (![LicenseType.personal, LicenseType.professional, LicenseType.floating].includes(licenseType)) {
            throw new Error(`Invalid license type: ${licenseType}`);
        }

        await client.Deactivate(licenseType);
    });

program.parse(process.argv);
