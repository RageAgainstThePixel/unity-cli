import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { Logger } from './logging';
import { UnityHub } from './unity-hub';
import { ResolveGlobToPath } from './utilities';

export enum LicenseType {
    personal = 'personal',
    professional = 'professional',
    floating = 'floating'
}

export interface ActivateOptions {
    /** The type of license to activate */
    licenseType: LicenseType;
    /** Base64 encoded services configuration json */
    servicesConfig?: string;
    /** The license serial number */
    serial?: string;
    /** The Unity ID username (email address) */
    username?: string;
    /** The Unity ID password */
    password?: string;
}

export class LicensingClient {
    private readonly unityHub: UnityHub = new UnityHub();
    private readonly logger: Logger = Logger.instance;

    private licenseClientPath: string | undefined;
    private licenseVersion: string | undefined;

    /**
     * Creates an instance of LicensingClient.
     * @param licenseVersion The license version to use (e.g., '4.x', '5.x', '6.x'). If undefined, defaults to '6.x'.
     */
    constructor(licenseVersion: string | undefined = undefined) {
        this.licenseVersion = licenseVersion;
    }

    async init() {
        try {
            await fs.promises.access(this.unityHub.executable, fs.constants.R_OK);
            await fs.promises.access(this.unityHub.rootDirectory, fs.constants.R_OK);
        } catch (error) {
            throw new Error('Unity Hub is not installed or not accessible. Please install Unity Hub before using the Licensing Client.');
        }

        const licensingClientExecutable = process.platform === 'win32' ? 'Unity.Licensing.Client.exe' : 'Unity.Licensing.Client';
        const licenseClientPath = await ResolveGlobToPath([this.unityHub.rootDirectory, '**', licensingClientExecutable]);
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

    /**
     * Gets the path to the Unity Licensing Client services configuration file.
     * @see https://docs.unity.com/en-us/licensing-server/client-config#copying-the-configuration-file
     * @returns The path to the services configuration file.
     */
    private servicesConfigPath(): string {
        let servicesConfigDirectory: string;

        switch (process.platform) {
            case 'win32':
                // %PROGRAMDATA%\Unity\Config
                servicesConfigDirectory = path.join(process.env.PROGRAMDATA || '', 'Unity', 'Config');
                break;
            case 'darwin':
                // /Library/Application Support/Unity/config
                servicesConfigDirectory = path.join('/Library', 'Application Support', 'Unity', 'config');
                break;
            case 'linux':
                // /usr/share/unity3d/config
                servicesConfigDirectory = path.join('/usr', 'share', 'unity3d', 'config');
                break;
            default:
                throw new Error(`Unsupported platform: ${process.platform}`);
        }

        // Ensure the services directory exists
        if (!fs.existsSync(servicesConfigDirectory)) {
            fs.mkdirSync(servicesConfigDirectory, { recursive: true });
        }

        return path.join(servicesConfigDirectory, 'services-config.json');
    }

    /**
     * Gets the path to the Unity Licensing Client log file.
     * @see https://docs.unity.com/en-us/licensing-server/troubleshooting-client#logs
     * @returns The path to the log file.
     */
    public logPath(): string {
        switch (process.platform) {
            case 'win32':
                // $env:LOCALAPPDATA\Unity\Unity.Licensing.Client.log
                return path.join(process.env.LOCALAPPDATA || '', 'Unity', 'Unity.Licensing.Client.log');
            case 'darwin':
                // ~/Library/Logs/Unity/Unity.Licensing.Client.log
                return path.join(os.homedir(), 'Library', 'Logs', 'Unity', 'Unity.Licensing.Client.log');
            case 'linux':
                // ~/.config/unity3d/Unity/Unity.Licensing.Client.log
                return path.join(os.homedir(), '.config', 'unity3d', 'Unity', 'Unity.Licensing.Client.log');
            default:
                throw new Error(`Unsupported platform: ${process.platform}`);
        }
    }

    /**
     * Displays the context information of the licensing client to the console.
     * @see https://docs.unity.com/en-us/licensing-server/troubleshooting-client#exit-codes
     */
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
            const versionMatch = process.env.UNITY_EDITOR_PATH?.match(/(\d+)\.(\d+)\.(\d+)/);

            if (versionMatch) {
                switch (versionMatch[1]) {
                    case '4': {
                        this.licenseVersion = '4.x';
                        break;
                    }
                    case '5': {
                        this.licenseVersion = '5.x';
                        break;
                    }
                    default: {
                        this.licenseVersion = '6.x'; // default to 6.x for any other
                        break;
                    }
                }
            } else {
                this.licenseVersion = '6.x'; // default to 6.x if not set
            }
        }

        if (this.licenseVersion !== '6.x') {
            if (this.licenseVersion !== '5.x' && this.licenseVersion !== '4.x') {
                this.logger.warn(`Warning: Specified license version '${this.licenseVersion}' is unsupported, skipping`);
                return;
            }
        }

        if (!this.licenseClientPath) {
            this.licenseClientPath = await this.init();
        }

        if (this.licenseVersion === '6.x') {
            return; // no patching needed
        }

        const clientDirectory = path.dirname(this.licenseClientPath);
        const patchedDirectory = path.join(os.tmpdir(), `UnityLicensingClient-${this.licenseVersion.replace('.', '_')}`);

        if (await fs.promises.mkdir(patchedDirectory, { recursive: true }) === undefined) {
            this.logger.debug('Unity Licensing Client was already patched, reusing');
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

    private async exec(args: string[], silent: boolean = false): Promise<string> {
        await this.patchLicenseVersion();

        if (!this.licenseClientPath) {
            this.licenseClientPath = await this.init();
        }

        let output: string = '';
        let exitCode: number = 0;

        this.logger.startGroup(`\x1b[34m${this.licenseClientPath} ${args.join(' ')}\x1b[0m`);
        await fs.promises.access(this.licenseClientPath!, fs.constants.R_OK | fs.constants.X_OK);

        try {
            exitCode = await new Promise<number>((resolve, reject) => {
                fs.accessSync(this.licenseClientPath!, fs.constants.R_OK | fs.constants.X_OK);
                const child = spawn(this.licenseClientPath!, args, {
                    stdio: ['ignore', 'pipe', 'pipe']
                });

                const sigintHandler = () => child.kill('SIGINT');
                const sigtermHandler = () => child.kill('SIGTERM');
                process.once('SIGINT', sigintHandler);
                process.once('SIGTERM', sigtermHandler);

                let hasCleanedUpListeners = false;
                function removeListeners() {
                    if (hasCleanedUpListeners) { return; }
                    hasCleanedUpListeners = true;
                    process.removeListener('SIGINT', sigintHandler);
                    process.removeListener('SIGTERM', sigtermHandler);
                }

                function processOutput(data: Buffer) {
                    const chunk = data.toString();
                    output += chunk;
                }

                child.stdout.on('data', processOutput);
                child.stderr.on('data', processOutput);
                child.on('error', (error) => {
                    removeListeners();
                    reject(error);
                });
                child.on('close', (code) => {
                    removeListeners();
                    resolve(code === null ? 0 : code);
                });
            });
        } finally {
            if (!silent || exitCode !== 0) {
                const maskedOutput = this.maskSerialInOutput(output);
                const splitLines = maskedOutput.split(/\r?\n/);

                for (const line of splitLines) {
                    if (line === undefined || line.length === 0) { continue; }
                    this.logger.info(line);
                }
            }

            this.logger.endGroup();

            if (exitCode !== 0) {
                const message = this.getExitCodeMessage(exitCode);
                throw new Error(`License command failed with exit code ${exitCode}: ${message}`);
            }
        }

        return output;
    }

    private maskSerialInOutput(output: string): string {
        return output.replace(/([\w-]+-XXXX)/g, (_, serial) => {
            const maskedSerial = serial.slice(0, -4) + `XXXX`;
            this.logger.CI_mask(maskedSerial);
            return serial;
        });
    }

    /**
     * Displays the version of the licensing client to the console.
     */
    public async Version(): Promise<void> {
        await this.exec(['--version']);
    }

    /**
     * Displays the context information of the licensing client to the console.
     */
    public async Context(): Promise<void> {
        await this.exec(['--showContext']);
    }

    /**
     * Activates a Unity license.
     * @param options The activation options including license type, services config, serial, username, and password.
     * @param skipEntitlementCheck Whether to skip the entitlement check.
     * @returns A promise that resolves to the floating license token if applicable, otherwise undefined.
     * @throws Error if activation fails or required parameters are missing.
     */
    public async Activate(options: ActivateOptions, skipEntitlementCheck: boolean = false): Promise<string | undefined> {
        if (!skipEntitlementCheck) {
            let activeLicenses = await this.GetActiveEntitlements();

            if (activeLicenses.includes(options.licenseType)) {
                this.logger.info(`License of type '${options.licenseType}' is already active, skipping activation`);
                return;
            }
        }

        switch (options.licenseType) {
            case LicenseType.floating: {
                if (!options.servicesConfig) {
                    throw new Error('Services config path is required for floating license activation');
                }

                const servicesConfigPath = this.servicesConfigPath();

                if (fs.existsSync(options.servicesConfig)) {
                    fs.copyFileSync(options.servicesConfig, servicesConfigPath);
                }
                else {
                    fs.writeFileSync(servicesConfigPath, Buffer.from(options.servicesConfig, 'base64'));
                }

                this.logger.debug(`Using services config at: ${servicesConfigPath}`);

                const output = await this.exec([`--acquire-floating`], true);
                const tokenMatch = output.match(/with token:\s*"(?<token>[\w-]+)"/);

                if (!tokenMatch || !tokenMatch.groups || !tokenMatch.groups['token']) {
                    throw new Error('Failed to acquire floating license lease: No token found in output');
                }

                const token = tokenMatch.groups['token'];
                this.logger.CI_mask(token);
                this.logger.info(output);
                return token;
            }
            default: { // personal and professional license activation
                if (!options.username) {
                    const encodedUsername = process.env.UNITY_USERNAME_BASE64;

                    if (!encodedUsername) {
                        throw Error('Username is required for Unity License Activation!');
                    }

                    options.username = Buffer.from(encodedUsername, 'base64').toString('utf-8');
                }

                function isValidEmail(email: string): boolean {
                    const emailRegex: RegExp = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
                    return emailRegex.test(email);
                }

                if (options.username.length === 0 || !isValidEmail(options.username)) {
                    throw Error('Username must be your Unity ID email address!');
                }

                if (!options.password) {
                    const encodedPassword = process.env.UNITY_PASSWORD_BASE64;

                    if (!encodedPassword) {
                        throw Error('Password is required for Unity License Activation!');
                    }

                    options.password = Buffer.from(encodedPassword, 'base64').toString('utf-8');
                }

                if (options.password.length === 0) {
                    throw Error('Password is required for Unity License Activation!');
                }

                await this.activateLicense(options.licenseType, options.username, options.password, options.serial);
                return undefined;
            }
        }
    }

    /**
     * Deactivates a Unity license.
     * @param licenseType The type of license to deactivate.
     * @param token The token received when acquiring a floating license lease. Required when deactivating a floating license.
     * @returns A promise that resolves when the license is deactivated.
     * @throws Error if deactivation fails.
     */
    public async Deactivate(licenseType: LicenseType, token?: string): Promise<void> {
        const activeLicenses = await this.GetActiveEntitlements();

        if (activeLicenses.includes(licenseType)) {
            await this.returnLicense(licenseType, token);
        }
    }

    /**
     * Shows the currently active entitlements/licenses.
     * @returns A list of active license types.
     */
    public async GetActiveEntitlements(): Promise<LicenseType[]> {
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
            const maskedSerial = serial.slice(0, -4) + `XXXX`;
            this.logger.CI_mask(maskedSerial);
        }

        if (licenseType === LicenseType.personal) {
            args.push(`--include-personal`);
        }

        await this.exec(args);

        const activeLicenses = await this.GetActiveEntitlements();

        if (!activeLicenses.includes(licenseType)) {
            throw new Error(`Failed to activate license of type '${licenseType}'`);
        }

        this.logger.info(`Successfully activated license of type '${licenseType}'`);
    }

    private async returnLicense(licenseType: LicenseType, token?: string): Promise<void> {
        if (licenseType === LicenseType.floating) {
            if (!token || token.length === 0) {
                throw new Error('A token is required to return a floating license');
            }

            await this.exec([`--return-floating`, token]);
        }
        else {
            await this.exec([`--return-ulf`]);
        }

        const activeLicenses = await this.GetActiveEntitlements();

        if (activeLicenses.includes(licenseType)) {
            throw new Error(`Failed to return license of type '${licenseType}'`);
        }

        this.logger.info(`Successfully returned license of type '${licenseType}'`);
    }
}