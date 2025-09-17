import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { UnityHub } from './unity-hub';
import { ResolveGlobPath } from './utilities';

export enum LicenseType {
    personal = 'personal',
    professional = 'professional',
    floating = 'floating'
}

export class LicensingClient {
    private unityHub: UnityHub = new UnityHub();
    private licenseClientPath: string | undefined;
    private licenseVersion: string | undefined;

    constructor(licenseVersion: string | undefined = undefined) {
        this.licenseVersion = licenseVersion;
    }

    async init() {
        try {
            await fs.promises.access(this.unityHub.executable, fs.constants.R_OK);
            await fs.promises.access(this.unityHub.rootDirectory, fs.constants.R_OK);
        } catch (error) {
            await this.unityHub.Install();
        }

        const licensingClientExecutable = process.platform === 'win32' ? 'Unity.Licensing.Client.exe' : 'Unity.Licensing.Client';
        const licenseClientPath = await ResolveGlobPath([this.unityHub.rootDirectory, '**', licensingClientExecutable]);
        this.licenseClientPath = licenseClientPath;
        await fs.promises.access(this.licenseClientPath, fs.constants.X_OK);
        return this.licenseClientPath;
    }

    private getUnityCommonDir() {
        const result = process.env['UNITY_COMMON_DIR'];

        if (result) {
            return result;
        }

        const platform = os.platform();

        switch (platform) {
            case 'win32': {
                const programData = process.env['PROGRAMDATA'] || 'C:\\ProgramData';
                return path.join(programData, 'Unity');
            }
            case 'darwin': {
                return '/Library/Application Support/Unity';
            }
            case 'linux': {
                const dataHome = process.env['XDG_DATA_HOME'] || path.join(os.homedir(), '.local', 'share');
                return path.join(dataHome, 'unity3d', 'Unity');
            }
            default:
                throw new Error(`Failed to determine Unity common directory for platform: ${platform}`);
        }
    }

    private getExitCodeMessage(exitCode: number): string {
        switch (exitCode) {
            case 0:
                return 'OK';
            case 1:
                return 'Invalid arguments';
            case 2:
                return 'Invalid credentials';
            case 3:
                return 'Organization ID is missing';
            case 4:
                return 'Package Access Control List file download failed';
            case 5:
                return 'Context initialization failed';
            case 6:
                return 'Replication service initialization failed';
            case 7:
                return 'Orchestrator initialization failed';
            case 8:
                return 'Floating service initialization failed';
            case 9:
                return 'Package service initialization failed';
            case 10:
                return 'Access token initialization failed';
            case 11:
                return 'Multi client pipe server start failed';
            case 12:
                return 'License activation generation failed';
            case 13:
                return 'Syncing entitlements failed';
            case 14:
                return 'No valid entitlement found';
            case 15:
                return 'License update failed';
            case 16:
                return 'Unable to get list of user seats';
            case 17:
                return 'Seat activation or deactivation failed';
            case 18:
                return 'Getting entitlements failed';
            case 19:
                return 'Acquiring license failed';
            case 20:
                return 'Renewing floating lease failed';
            case 21:
                return 'Returning floating lease failed';
            default:
                return `Unknown Error`;
        }
    }

    private async patchBinary(src: string, dest: string, searchValue: Buffer, replaceValue: Buffer): Promise<void> {
        const data = await fs.promises.readFile(src);
        let modified = false;

        for (let i = 0; i <= data.length - searchValue.length; i++) {
            if (data.subarray(i, i + searchValue.length).equals(searchValue)) {
                replaceValue.copy(data, i);
                modified = true;
                i += searchValue.length - 1;
            }
        }

        if (!modified) {
            throw new Error('Could not find the search value');
        }

        await fs.promises.writeFile(dest, data);
    }

    private async patchLicenseVersion(): Promise<void> {
        if (!this.licenseVersion) {
            // check if the UNITY_EDITOR_PATH is set. If it is, use it to determine the license version
            const unityEditorPath = process.env['UNITY_EDITOR_PATH'];

            if (unityEditorPath) {
                const versionMatch = unityEditorPath.match(/(\d+)\.(\d+)\.(\d+)/);

                if (!versionMatch) {
                    this.licenseVersion = '6.x'; // default to 6.x if version cannot be determined
                } else {
                    switch (versionMatch[1]) {
                        case '4':
                            this.licenseVersion = '4.x';
                            break;
                        case '5':
                            this.licenseVersion = '5.x';
                            break;
                        default:
                            this.licenseVersion = '6.x'; // default to 6.x for any other
                            break;
                    }
                }
            }

            if (!this.licenseVersion) {
                this.licenseVersion = '6.x'; // default to 6.x if not set
            }
        }

        if (this.licenseVersion === '6.x') {
            return;
        }

        if (this.licenseVersion !== '5.x' && this.licenseVersion !== '4.x') {
            console.warn(`Warning: Specified license version '${this.licenseVersion}' is unsupported, skipping`);
            return;
        }

        if (!this.licenseClientPath) {
            this.licenseClientPath = await this.init();
        }

        const clientDirectory = path.dirname(this.licenseClientPath);
        const patchedDirectory = path.join(os.tmpdir(), `UnityLicensingClient-${this.licenseVersion.replace('.', '_')}`);

        if (await fs.promises.mkdir(patchedDirectory, { recursive: true }) === undefined) {
            console.log('Unity Licensing Client was already patched, reusing')
        } else {
            let found = false;
            for (const fileName of await fs.promises.readdir(clientDirectory)) {
                if (fileName === 'Unity.Licensing.EntitlementResolver.dll') {
                    await this.patchBinary(
                        path.join(clientDirectory, fileName), path.join(patchedDirectory, fileName),
                        Buffer.from('6.x', 'utf16le'),
                        Buffer.from(this.licenseVersion, 'utf16le'),
                    );
                    found = true;
                } else {
                    await fs.promises.symlink(path.join(clientDirectory, fileName), path.join(patchedDirectory, fileName));
                }
            }

            if (!found) {
                throw new Error('Could not find Unity.Licensing.EntitlementResolver.dll in the unityhub installation');
            }
        }

        this.licenseClientPath = path.join(patchedDirectory, path.basename(this.licenseClientPath));
        const unityCommonDir = this.getUnityCommonDir();
        const legacyLicenseFile = path.join(unityCommonDir, `Unity_v${this.licenseVersion}.ulf`);
        await fs.promises.mkdir(unityCommonDir, { recursive: true });

        try {
            await fs.promises.symlink(path.join(patchedDirectory, 'Unity_lic.ulf'), legacyLicenseFile);
        } catch (error) {
            if (error && (error as NodeJS.ErrnoException).code === 'EEXIST') {
                await fs.promises.unlink(legacyLicenseFile);
                await fs.promises.symlink(path.join(patchedDirectory, 'Unity_lic.ulf'), legacyLicenseFile);
            } else {
                throw error;
            }
        }

        process.env['UNITY_COMMON_DIR'] = patchedDirectory;
    }

    private async exec(args: string[]): Promise<string> {
        await this.patchLicenseVersion();

        if (!this.licenseClientPath) {
            this.licenseClientPath = await this.init();
        }

        await fs.promises.access(this.licenseClientPath, fs.constants.X_OK);

        let output: string = '';
        let exitCode: number = 0;

        try {
            exitCode = await new Promise<number>((resolve, reject) => {
                const child = spawn(this.licenseClientPath!, args, { stdio: ['ignore', 'pipe', 'pipe'] });

                child.stdout.on('data', (data) => {
                    const chunk = data.toString();
                    output += chunk;
                    console.log(chunk);
                });

                child.stderr.on('data', (data) => {
                    const chunk = data.toString();
                    output += chunk;
                    console.error(chunk);
                });

                child.on('error', (error) => {
                    reject(error);
                });

                child.on('close', (code) => {
                    resolve(code === null ? 0 : code);
                });
            });
        } finally {
            if (exitCode !== 0) {
                const message = this.getExitCodeMessage(exitCode);
                throw new Error(`License command failed with exit code ${exitCode}: ${message}`);
            }
        }

        return output;
    }

    public async Version(): Promise<void> {
        await this.exec(['--version']);
    }

    public async Activate(licenseType: LicenseType, servicesConfig: string | undefined = undefined, serial: string | undefined = undefined, username: string | undefined = undefined, password: string | undefined = undefined): Promise<void> {
        let activeLicenses = await this.showEntitlements();

        if (activeLicenses.includes(licenseType)) {
            console.log(`License of type '${licenseType}' is already active, skipping activation`);
            return;
        }

        switch (licenseType) {
            case LicenseType.floating: {
                if (!servicesConfig) {
                    throw new Error('Services config path is required for floating license activation');
                }

                let servicesPath: string;
                switch (process.platform) {
                    case 'win32':
                        servicesPath = path.join(process.env.PROGRAMDATA || '', 'Unity', 'config');
                        break;
                    case 'darwin':
                        servicesPath = path.join('/Library', 'Application Support', 'Unity', 'config');
                        break;
                    case 'linux':
                        servicesPath = path.join('/usr', 'share', 'unity3d', 'config');
                        break;
                    default:
                        throw new Error(`Unsupported platform: ${process.platform}`);
                }

                const servicesConfigPath = path.join(servicesPath, 'services-config.json');
                await fs.promises.writeFile(servicesConfigPath, Buffer.from(servicesConfig, 'base64'));
                return;
            }
            default: { // personal and professional license activation
                if (!username) {
                    const encodedUsername = process.env.UNITY_USERNAME_BASE64;

                    if (!encodedUsername) {
                        throw Error('Username is required for Unity License Activation!');
                    }

                    username = Buffer.from(encodedUsername, 'base64').toString('utf-8');
                }

                const emailRegex: RegExp = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

                if (username.length === 0 || !emailRegex.test(username)) {
                    throw Error('Username must be your Unity ID email address!');
                }

                if (!password) {
                    const encodedPassword = process.env.UNITY_PASSWORD_BASE64;

                    if (!encodedPassword) {
                        throw Error('Password is required for Unity License Activation!');
                    }

                    password = Buffer.from(encodedPassword, 'base64').toString('utf-8');
                }

                if (password.length === 0) {
                    throw Error('Password is required for Unity License Activation!');
                }

                await this.activateLicense(licenseType, username, password, serial);
            }
        }
    }

    public async Deactivate(licenseType: LicenseType): Promise<void> {
        if (licenseType === LicenseType.floating) {
            return;
        }

        const activeLicenses = await this.showEntitlements();

        if (activeLicenses.includes(licenseType)) {
            await this.returnLicense(licenseType);
        }
    }

    private async showEntitlements(): Promise<LicenseType[]> {
        const output = await this.exec([`--showEntitlements`]);
        const matches = output.matchAll(/Product Name: (?<license>.+)/g);
        const licenses: LicenseType[] = [];
        for (const match of matches) {
            if (match.groups?.license) {
                switch (match.groups.license) {
                    case 'Unity Pro':
                        if (!licenses.includes(LicenseType.professional)) {
                            licenses.push(LicenseType.professional);
                        }
                        break;
                    case 'Unity Personal':
                        if (!licenses.includes(LicenseType.personal)) {
                            licenses.push(LicenseType.personal);
                        }
                        break;
                    default:
                        throw Error(`Unsupported license type: ${match.groups.license}`);
                }
            }
        }
        return licenses;
    }

    private async activateLicense(licenseType: LicenseType, username: string, password: string, serial: string | undefined = undefined): Promise<void> {
        const args = [
            `--activate-ulf`,
            `--username`, username,
            `--password`, password
        ];

        if (serial !== undefined && serial.length > 0) {
            serial = serial.trim();
            args.push(`--serial`, serial);
        }

        if (licenseType === LicenseType.personal) {
            args.push(`--include-personal`);
        }

        await this.exec(args);

        const activeLicenses = await this.showEntitlements();

        if (!activeLicenses.includes(licenseType)) {
            throw new Error(`Failed to activate license of type '${licenseType}'`);
        }

        console.log(`Successfully activated license of type '${licenseType}'`);
    }

    private async returnLicense(licenseType: LicenseType): Promise<void> {
        await this.exec([`--return-ulf`]);

        const activeLicenses = await this.showEntitlements();

        if (activeLicenses.includes(licenseType)) {
            throw new Error(`Failed to return license of type '${licenseType}'`);
        }

        console.log(`Successfully returned license of type '${licenseType}'`);
    }
}