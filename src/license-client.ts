import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { Logger } from './logging';
import { UnityCli } from './unity-cli';
import {
    ResolveGlobToPath,
    DownloadFile,
    Exec,
    FindProcessesByName,
    FindProcessesUnder,
    KillProcess,
    SanitizeLogText,
    Sha256FileHex,
    GetTempDir,
    ResolvePathCandidates,
    redactSensitiveLiterals,
    tryParseJson
} from './utilities';

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
    /**
     * A license file (Unity_lic.ulf) from an earlier activation: a path, the raw XML, or base64. Defaults to UNITY_LICENSE.
     * It only works on a machine with the same identity it was activated on.
     */
    licenseFile?: string;
}

/**
 * The v3 licensing client, which drives Unity.Licensing.Client directly.
 * v4 uses it as the fallback when the official Unity CLI cannot activate or return a license,
 * for example a personal license on a headless runner, and for Unity 4.x and 5.x editors.
 */
/** How long one Unity Licensing Client command may run. */
const LICENSING_CLIENT_TIMEOUT_MS = 10 * 60 * 1000;

export class LicensingClient {
    private readonly logger: Logger = Logger.instance;

    private licenseClientPath: string | undefined;
    private readonly secrets: string[] = [];
    private isLicenseClientPatched = false;
    /** Where the 4.x/5.x license link lives, and the folders the client may have written Unity_lic.ulf to. */
    private legacyLicense: { linkPath: string; commonDirectory: string; patchedDirectory: string } | undefined;
    private licenseVersion: string | undefined;

    /**
     * Creates an instance of LicensingClient.
     * @param licenseVersion The license version to use (e.g., '4.x', '5.x', '6.x'). If undefined, defaults to '6.x'.
     */
    constructor(licenseVersion: string | undefined = undefined) {
        this.licenseVersion = licenseVersion;
    }

    /**
     * Finds Unity.Licensing.Client: UNITY_LICENSING_CLIENT_PATH, then the copy the official Unity CLI manages,
     * then the Hub's external modules folder, then the client bundled with the editor in UNITY_EDITOR_PATH.
     * @returns The licensing client executable.
     */
    async init() {
        const licensingClientExecutable = process.platform === 'win32' ? 'Unity.Licensing.Client.exe' : 'Unity.Licensing.Client';
        let licenseClientPath: string | undefined = process.env.UNITY_LICENSING_CLIENT_PATH;
        const legacyVersion = this.licenseVersion ?? GetLegacyLicenseVersion();

        if (!licenseClientPath && process.platform === 'darwin' && (legacyVersion === '4.x' || legacyVersion === '5.x')) {
            // the macOS client the Unity CLI downloads cannot be patched for 4.x/5.x, so use the one Unity Hub bundled
            licenseClientPath = await LicensingClient.getHubBundledClient();
        }

        if (!licenseClientPath) {
            try {
                const cli = await UnityCli.Get();
                licenseClientPath = await cli.GetLicensingClientPath();
            } catch (error) {
                this.logger.debug(`The Unity CLI did not report a licensing client: ${error}`);
            }
        }

        if (!licenseClientPath) {
            const candidates: string[][] = LicensingClient.externalModulesDirectories()
                .map(directory => [directory, '**', licensingClientExecutable]);
            const editorPath = process.env.UNITY_EDITOR_PATH;

            if (editorPath && editorPath.length > 0) {
                candidates.push([path.dirname(editorPath), '**', 'Licensing', 'Client', licensingClientExecutable]);
            }

            licenseClientPath = await ResolvePathCandidates(candidates);
        }

        if (!licenseClientPath) {
            throw new Error('Failed to find Unity.Licensing.Client. Set UNITY_LICENSING_CLIENT_PATH to its location.');
        }

        await LicensingClient.ensureMacLicenseDirectory();

        this.licenseClientPath = licenseClientPath;
        await fs.promises.access(this.licenseClientPath, fs.constants.X_OK);
        this.logger.debug(`Using Unity Licensing Client at ${this.licenseClientPath}`);
        return this.licenseClientPath;
    }

    /**
     * Extracts the licensing client bundled with Unity Hub 3.12.0 on macOS. Its resolver is a separate assembly that
     * the 4.x/5.x patch works on, unlike the single-file macOS client the Unity CLI downloads, whose licenses stay 6.x.
     * Only the client is copied out; the Hub is not installed.
     * @returns The extracted client executable.
     */
    private static async getHubBundledClient(): Promise<string> {
        const hubVersion = '3.12.0';
        const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
        const cacheDirectory = await LicensingClient.privateDirectory(`hub-client-${hubVersion}-${arch}`);
        const findClient = async () => (await fs.promises.readdir(cacheDirectory, { recursive: true }))
            .map(entry => path.join(cacheDirectory, entry.toString()))
            .find(entry => path.basename(entry) === 'Unity.Licensing.Client' && fs.statSync(entry).isFile());

        if (fs.existsSync(cacheDirectory)) {
            const cached = await findClient();

            if (cached) {
                return cached;
            }
        }

        const dmgPath = path.join(GetTempDir(), `UnityHubSetup-${hubVersion}-${arch}.dmg`);
        const mountPoint = path.join(GetTempDir(), `UnityHub-${hubVersion}-${arch}`);
        // pinned so a tampered download never reaches the client that receives the Unity ID
        const dmgSha256: { [arch: string]: string } = {
            'x64': '1b5e9698b6353cb814618ea12c6ca014d50fc33efe086da6b67e5b442a77bb3e',
            'arm64': '0026d98a375d926090b144ca3d54e982612aa24a59404e004e333dc34c4b832a',
        };
        await DownloadFile(`https://public-cdn.cloud.unity3d.com/hub/${hubVersion}/UnityHubSetup-${arch}.dmg`, dmgPath, { sha256: dmgSha256[arch]! });
        await fs.promises.mkdir(mountPoint, { recursive: true });

        try {
            await Exec('hdiutil', ['attach', dmgPath, '-nobrowse', '-readonly', '-mountpoint', mountPoint], { silent: true, showCommand: true });

            try {
                const client = await ResolveGlobToPath([mountPoint, '**', 'Unity.Licensing.Client']);
                const sourceDirectory = LicensingClient.clientRootDirectory(client);
                await fs.promises.rm(cacheDirectory, { recursive: true, force: true });
                await fs.promises.cp(sourceDirectory, cacheDirectory, { recursive: true, verbatimSymlinks: true });
            } finally {
                await Exec('hdiutil', ['detach', mountPoint, '-quiet'], { silent: true, showCommand: true });
            }
        } finally {
            await fs.promises.rm(dmgPath, { force: true });
        }

        const extracted = await findClient();

        if (!extracted) {
            throw new Error(`Failed to extract Unity.Licensing.Client from Unity Hub ${hubVersion}`);
        }

        Logger.instance.info(`Using the Unity Licensing Client bundled with Unity Hub ${hubVersion}: ${extracted}`);
        return extracted;
    }

    /**
     * On macOS the client writes Unity_lic.ulf to /Library/Application Support/Unity. When that folder is missing or not
     * writable it asks for an administrator password in a dialog, which never returns on a headless runner.
     * The Unity Hub installer used to create it; without the Hub, it is created here with non-interactive sudo.
     */
    private static async ensureMacLicenseDirectory(): Promise<void> {
        if (process.platform !== 'darwin') {
            return;
        }

        const directory = '/Library/Application Support/Unity';

        try {
            await fs.promises.access(directory, fs.constants.W_OK);
            return;
        } catch {
            // missing or not writable
        }

        // owned by the current user rather than world-writable
        const user = os.userInfo().username;

        for (const args of [['-n', 'mkdir', '-p', directory], ['-n', 'chown', user, directory], ['-n', 'chmod', '755', directory]]) {
            const exitCode = await new Promise<number>((resolve) => {
                const child = spawn('sudo', args, { stdio: 'ignore' });
                child.on('error', () => resolve(1));
                child.on('close', (code) => resolve(code ?? 1));
            });

            if (exitCode !== 0) {
                Logger.instance.warn(`Could not prepare ${directory} (sudo ${args.slice(1).join(' ')} exited with code ${exitCode}). Activation may wait for an administrator password.`);
                return;
            }
        }
    }

    /**
     * Gets a folder under ~/.unity-cli/licensing that only the current user can read and write, creating it when needed.
     * Used instead of the shared temp folder for the patched licensing client and the license it writes.
     * @param name The folder name.
     */
    private static async privateDirectory(name: string): Promise<string> {
        const root = path.join(os.homedir(), '.unity-cli', 'licensing');
        await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });

        if (process.platform !== 'win32') {
            await fs.promises.chmod(root, 0o700);
        }

        return path.join(root, name);
    }

    /**
     * The folder that holds the whole licensing client: the bundle root for a macOS bundle (…/Contents/MacOS/client), otherwise the executable's folder.
     */
    private static clientRootDirectory(clientPath: string): string {
        const macOSDirectory = path.dirname(clientPath);

        if (path.basename(macOSDirectory) === 'MacOS' && path.basename(path.dirname(macOSDirectory)) === 'Contents') {
            return path.dirname(path.dirname(macOSDirectory));
        }

        return macOSDirectory;
    }

    /**
     * Lists the files under a directory that can hold compiled code: executables, libraries and extensionless binaries.
     */
    private static async listBinaries(directory: string): Promise<string[]> {
        const results: string[] = [];

        for (const entry of await fs.promises.readdir(directory, { withFileTypes: true, recursive: true })) {
            if (!entry.isFile()) {
                continue;
            }

            const extension = path.extname(entry.name).toLowerCase();
            // the macOS client is named Unity.Licensing.Client, so its extension reads as ".client"
            const isClient = entry.name.startsWith('Unity.Licensing.') && !['.md', '.config', '.json', '.plist', '.xml', '.txt'].includes(extension);

            if (isClient || ['', '.exe', '.dll', '.dylib', '.so'].includes(extension)) {
                results.push(path.join(entry.parentPath, entry.name));
            }
        }

        return results;
    }

    /**
     * The folders the Unity Hub and the official Unity CLI download Unity.Licensing.Client to.
     */
    private static externalModulesDirectories(): string[] {
        switch (process.platform) {
            case 'win32':
                return [path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'UnityHub', 'external-modules')];
            case 'darwin':
                return [path.join(os.homedir(), 'Library', 'Application Support', 'UnityHub', 'external-modules')];
            default: {
                const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
                return [
                    path.join(configHome, 'UnityHub', 'external-modules'),
                    path.join(configHome, 'unityhub', 'external-modules'),
                ];
            }
        }
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
                servicesConfigDirectory = path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'Unity', 'Config');
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

        if (process.platform !== 'win32') {
            fs.chmodSync(servicesConfigDirectory, 0o755);
        }

        fs.accessSync(servicesConfigDirectory, fs.constants.R_OK | fs.constants.W_OK);
        return path.join(servicesConfigDirectory, 'services-config.json');
    }

    private resolveServicesConfigContent(input: string): string {
        const trimmedInput = input.trim();

        if (trimmedInput.length === 0) {
            throw new Error('Services config value is empty. Provide a file path, JSON, or base64 encoded JSON string.');
        }

        const rawJson = tryParseJson(trimmedInput);

        if (rawJson) {
            return rawJson;
        }

        try {
            const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;

            if (base64Regex.test(trimmedInput)) {
                const decoded = Buffer.from(trimmedInput, 'base64').toString('utf-8').trim();
                const decodedJson = tryParseJson(decoded);

                if (decodedJson) {
                    return decodedJson;
                }
            } else {
                throw new Error('Input does not match base64 format.');
            }
        }
        catch (error) {
            throw new Error(`Failed to decode services config as base64: ${error}`);
        }

        throw new Error('Services config value is not a valid JSON string or base64 encoded JSON string.');
    }

    /**
     * Writes the floating license server's services-config.json where Unity's licensing reads it.
     * @param configSource A path to the configuration file, raw JSON, or base64 encoded JSON.
     * @returns The path the configuration was written to.
     */
    public async setupServicesConfig(configSource: string): Promise<string> {
        const servicesConfigPath = this.servicesConfigPath();

        if (fs.existsSync(configSource)) {
            fs.copyFileSync(configSource, servicesConfigPath);
        }
        else {
            const configContent = this.resolveServicesConfigContent(configSource);
            fs.writeFileSync(servicesConfigPath, configContent, { encoding: 'utf-8' });
        }

        if (process.platform !== 'win32') {
            fs.chmodSync(servicesConfigPath, 0o644);
        }

        fs.accessSync(servicesConfigPath, fs.constants.R_OK);
        return servicesConfigPath;
    }

    /**
     * Gets the path to the Unity Licensing Client log file.
     * @see https://docs.unity.com/en-us/licensing-server/troubleshooting-client#logs
     * @returns The path to the log file.
     */
    public static ClientLogPath(): string {
        switch (process.platform) {
            case 'win32':
                // $env:LOCALAPPDATA\Unity\Unity.Licensing.Client.log
                return path.join(process.env.LOCALAPPDATA || '', 'Unity', 'Unity.Licensing.Client.log');
            case 'darwin':
                // ~/Library/Logs/Unity/Unity.Licensing.Client.log
                return path.join(process.env.HOME || '', 'Library', 'Logs', 'Unity', 'Unity.Licensing.Client.log');
            case 'linux':
                // ~/.config/unity3d/Unity/Unity.Licensing.Client.log
                return path.join(process.env.HOME || '', '.config', 'unity3d', 'Unity', 'Unity.Licensing.Client.log');
            default:
                throw new Error(`Unsupported platform: ${process.platform}`);
        }
    }

    /**
     * Gets the path to the Unity Licensing Client audit log file.
     * @see https://docs.unity.com/en-us/licensing-server/troubleshooting-client#logs
     * @returns The path to the audit log file.
     */
    public static ClientAuditLogPath(): string {
        switch (process.platform) {
            case 'win32':
                // $env:LOCALAPPDATA\Unity\Unity.Entitlements.Audit.log
                return path.join(process.env.LOCALAPPDATA || '', 'Unity', 'Unity.Entitlements.Audit.log');
            case 'darwin':
                // ~/Library/Logs/Unity/Unity.Entitlements.Audit.log
                return path.join(process.env.HOME || '', 'Library', 'Logs', 'Unity', 'Unity.Entitlements.Audit.log');
            case 'linux':
                // ~/.config/unity3d/Unity/Unity.Entitlements.Audit.log
                return path.join(process.env.HOME || '', '.config', 'unity3d', 'Unity', 'Unity.Entitlements.Audit.log');
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
            // use the editor in UNITY_EDITOR_PATH to determine the license version, defaulting to 6.x
            this.licenseVersion = GetLegacyLicenseVersion() ?? '6.x';
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

        if (this.licenseVersion === '6.x' || this.isLicenseClientPatched) {
            return; // no patching needed, or already done for this instance
        }

        const clientRoot = LicensingClient.clientRootDirectory(this.licenseClientPath);
        // a private per-user folder rather than the shared temp folder: it holds a client that receives the Unity ID and the license it writes
        const patchedDirectory = await LicensingClient.privateDirectory(`patched-client-${this.licenseVersion.replace('.', '_')}`);
        const patchedClientPath = path.join(patchedDirectory, path.relative(clientRoot, this.licenseClientPath));
        const sourceMarker = path.join(patchedDirectory, '.source-sha256');
        const sourceHash = await Sha256FileHex(this.licenseClientPath);
        const isCurrent = (await fs.promises.readFile(sourceMarker, 'utf-8').catch(() => '')).trim() === sourceHash;

        if (isCurrent) {
            this.logger.debug('Unity Licensing Client was already patched from the same client, reusing');
        } else {
            await fs.promises.rm(patchedDirectory, { recursive: true, force: true });
            await fs.promises.mkdir(patchedDirectory, { recursive: true, mode: 0o700 });
            // copy the whole client, then patch whichever binary holds the "6.x" license version:
            // older clients ship it in Unity.Licensing.EntitlementResolver.dll, the single-file client the Unity CLI downloads embeds it in the executable
            await fs.promises.cp(clientRoot, patchedDirectory, { recursive: true, verbatimSymlinks: true });
            const patchedFiles: string[] = [];

            // Windows and Linux builds hold the value as a UTF-16 string; the macOS build only as the
            // UTF-8 constant k_UnityLicenseVersionCompatibility, so that one is matched with its name
            const constantName = Buffer.concat([Buffer.from('k_UnityLicenseVersionCompatibility'), Buffer.from([0x06])]);
            const patterns: [Buffer, Buffer][] = [
                [Buffer.from('6.x', 'utf16le'), Buffer.from(this.licenseVersion, 'utf16le')],
                [Buffer.concat([constantName, Buffer.from('6.x')]), Buffer.concat([constantName, Buffer.from(this.licenseVersion)])],
            ];

            const binaries = await LicensingClient.listBinaries(patchedDirectory);

            // the UTF-8 constant is only patched when no UTF-16 value exists, which leaves the Windows and Linux patch as it was
            for (const [searchValue, replaceValue] of patterns) {
                for (const file of binaries) {
                    try {
                        await this.patchBinary(file, file, searchValue, replaceValue);
                        patchedFiles.push(file);
                    } catch (error) {
                        if (!(error instanceof Error && error.message === 'Could not find the search value')) {
                            throw error;
                        }
                    }
                }

                if (patchedFiles.length > 0) {
                    break;
                }
            }

            if (patchedFiles.length === 0) {
                const searched = (await LicensingClient.listBinaries(patchedDirectory)).map(file => path.relative(patchedDirectory, file));
                await fs.promises.rm(patchedDirectory, { recursive: true, force: true });
                throw new Error(`Could not find the 6.x license version in any Unity Licensing Client binary under ${clientRoot}. Searched:\n${searched.map(file => `  > ${file}`).join('\n')}`);
            }

            this.logger.debug(`Patched the license version in:\n${patchedFiles.map(file => `  > ${file}`).join('\n')}`);
            await fs.promises.chmod(patchedClientPath, 0o755);

            if (process.platform === 'darwin') {
                // patching invalidates the signature, and macOS kills binaries with a broken one
                const isBundle = fs.existsSync(path.join(patchedDirectory, 'Contents', 'MacOS'));
                const targets = isBundle ? [patchedDirectory] : patchedFiles;

                for (const target of targets) {
                    await new Promise<void>((resolve, reject) => {
                        const child = spawn('codesign', ['--force', '--deep', '--sign', '-', target], { stdio: 'ignore' });
                        child.on('error', reject);
                        child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`codesign failed with exit code ${code}`)));
                    });
                }
            }

            // records which client the copy came from, so a newer client is patched again instead of reused
            await fs.promises.writeFile(sourceMarker, sourceHash, { encoding: 'utf-8', mode: 0o600 });
        }

        this.licenseClientPath = patchedClientPath;
        this.isLicenseClientPatched = true;
        const unityCommonDir = this.getUnityCommonDir();
        const legacyLicenseFile = path.join(unityCommonDir, `Unity_v${this.licenseVersion}.ulf`);
        this.legacyLicense ??= { linkPath: legacyLicenseFile, commonDirectory: unityCommonDir, patchedDirectory };
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
        let timedOut = false;

        // values that must never reach a log, even outside CI where ::add-mask:: does nothing
        const sensitiveFlags = ['--username', '--password', '--serial', '--return-floating'];
        const argSecrets = args.filter((_, i) => i > 0 && sensitiveFlags.includes(args[i - 1]!));
        const secrets = [...this.secrets, ...argSecrets];
        const redact = (text: string) => redactSensitiveLiterals(text, secrets);
        this.logger.startGroup(`\x1b[34m${this.licenseClientPath} ${redact(args.join(' '))}\x1b[0m`);
        const logOffset = await this.getClientLogSize();
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
                // a client that waits on something that never comes must not hold a CI job until it times out
                const timer = setTimeout(() => {
                    timedOut = true;
                    child.kill('SIGKILL');
                }, LICENSING_CLIENT_TIMEOUT_MS);

                let hasCleanedUpListeners = false;
                function removeListeners() {
                    if (hasCleanedUpListeners) { return; }
                    hasCleanedUpListeners = true;
                    clearTimeout(timer);
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
                // the client can start a background instance that inherits its stdout and stderr,
                // so 'close' may never fire; settle on 'exit' and stop reading the pipes shortly after
                let settled = false;
                const settle = (code: number | null) => {
                    if (settled) { return; }
                    settled = true;
                    removeListeners();
                    resolve(timedOut ? -1 : code === null ? 0 : code);
                };
                child.on('close', settle);
                child.on('exit', (code) => {
                    setTimeout(() => {
                        child.stdout.destroy();
                        child.stderr.destroy();
                        settle(code);
                    }, 1000);
                });
            });
        } finally {
            if (timedOut) {
                this.logger.error(`Unity Licensing Client did not finish within ${LICENSING_CLIENT_TIMEOUT_MS / 60000} minutes. Its log: ${LicensingClient.ClientLogPath()}`);
                await this.printClientLogProblems(logOffset, secrets);
            }

            if (!silent || exitCode !== 0) {
                // --debug output can carry tokens, so it gets the same sanitizing as the client log
                const maskedOutput = args.includes('--debug')
                    ? this.maskSerialInOutput(output).split(/\r?\n/).map(line => LicensingClient.sanitizeLogLine(line, secrets)).join('\n')
                    : redact(this.maskSerialInOutput(output));
                const splitLines = maskedOutput.split(/\r?\n/);

                for (const line of splitLines) {
                    if (line === undefined || line.length === 0) { continue; }
                    this.logger.info(line);
                }
            }

            this.logger.endGroup();

            if (exitCode !== 0) {
                const message = timedOut ? 'Timed out' : this.getExitCodeMessage(exitCode);
                throw new Error(`License command failed with exit code ${exitCode}: ${message}`);
            }
        }

        return output;
    }

    /**
     * Redacts the known secrets, email addresses and long token-like strings (JWTs, access and refresh tokens) from a client log line.
     * The line is split on separator characters and each piece is checked on its own, which stays linear on any input.
     */
    private static sanitizeLogLine(line: string, secrets: string[]): string {
        return SanitizeLogText(line, secrets);
    }

    /**
     * Prints the last lines the client logged since `offset`, to show why a command hung.
     * The log can hold account details and tokens, so every line is sanitized first.
     */
    private async printClientLogProblems(offset: number, secrets: string[], maxLines: number = 40): Promise<void> {
        try {
            const content = await fs.promises.readFile(LicensingClient.ClientLogPath());
            const lines = content.subarray(offset).toString('utf-8').split(/\r?\n/)
                .filter(line => line.trim().length > 0)
                .slice(-maxLines)
                .map(line => LicensingClient.sanitizeLogLine(line, secrets));

            if (lines.length > 0) {
                this.logger.info(`Last lines the Unity Licensing Client logged (redacted):\n${lines.join('\n')}`);
            }
        } catch (error) {
            this.logger.debug(`Could not read the Unity Licensing Client log: ${error}`);
        }
    }

    /**
     * Stops Unity.Licensing.Client instances left running in the background, such as the one the official Unity CLI starts.
     * A command line activation can wait on that instance indefinitely. Only done in CI, so a developer's own session is left alone.
     */
    public static async StopBackgroundClients(): Promise<void> {
        if (process.env.CI !== 'true') {
            return;
        }

        // matched on the executable's own name, so a process that only mentions it on its command line is left alone
        const clients = await FindProcessesByName('Unity.Licensing.Client');
        await Promise.all(clients.map(client => KillProcess(client).catch(() => undefined)));
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

    private async getClientLogSize(): Promise<number> {
        try {
            const stats = await fs.promises.stat(LicensingClient.ClientLogPath());
            return stats.size;
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return 0;
            }

            throw error;
        }
    }

    private async waitForLicenseServerConfiguration(timeoutMs: number = 30_000, pollIntervalMs: number = 1_000): Promise<void> {
        const logPath = LicensingClient.ClientLogPath();
        const configuredPattern = /Floating license server URL is:\s*(?<url>[^\s]+)\s*\(via config file\)/;
        const notConfiguredPattern = /Floating license server is not configured/;
        const deadline = Date.now() + timeoutMs;
        let offset = await this.getClientLogSize();
        let remainder = '';

        while (Date.now() < deadline) {
            let newChunk = '';

            try {
                const stats = await fs.promises.stat(logPath);

                if (stats.size > offset) {
                    const length = stats.size - offset;
                    const handle = await fs.promises.open(logPath, 'r');

                    try {
                        const buffer = Buffer.alloc(length);
                        await handle.read(buffer, 0, length, offset);
                        newChunk = buffer.toString('utf-8');
                        offset = stats.size;
                    }
                    finally {
                        await handle.close();
                    }
                }
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                    this.logger.error(`Failed to inspect licensing client log: ${error}`);
                    continue;
                }
            }

            if (newChunk.length > 0) {
                remainder += newChunk;
                const lines = remainder.split(/\r?\n/);
                remainder = lines.pop() ?? '';

                for (const line of lines) {
                    const configuredMatch = line.match(configuredPattern);

                    if (configuredMatch && configuredMatch.groups?.url) {
                        this.logger.info(`License server configured with URL: ${configuredMatch.groups.url}`);
                        return;
                    }

                    if (notConfiguredPattern.test(line)) {
                        this.logger.debug('Floating license server is not configured. Waiting for configuration...');
                    }
                }
            }

            await this.exec(['--showContext'], true);
            await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        }

        throw new Error(`Timed out waiting for floating license server configuration. Check '${logPath}' for details.`);
    }

    /**
     * Activates a Unity license.
     * @param options The activation options including license type, services config, serial, username, and password.
     * @param skipEntitlementCheck Whether to skip the entitlement check.
     * @returns A promise that resolves to the floating license token if applicable, otherwise undefined.
     * @throws Error if activation fails or required parameters are missing.
     */
    public async Activate(options: ActivateOptions, skipEntitlementCheck: boolean = false): Promise<string | undefined> {
        let servicesConfigPath: string | undefined;

        if (options.licenseType === LicenseType.floating) {
            if (!options.servicesConfig) {
                throw new Error('Services config path is required for floating license activation');
            }

            servicesConfigPath = await this.setupServicesConfig(options.servicesConfig);
            this.logger.debug(`Using services config at: ${servicesConfigPath}`);
        }

        // For floating licenses, skip the entitlement check
        skipEntitlementCheck = options.licenseType === LicenseType.floating;

        if (!skipEntitlementCheck) {
            const activeLicenses = await this.GetActiveEntitlements();

            if (activeLicenses.includes(options.licenseType)) {
                this.logger.info(`License of type '${options.licenseType}' is already active, skipping activation`);
                return;
            }
        }

        switch (options.licenseType) {
            case LicenseType.floating: {
                await this.waitForLicenseServerConfiguration();
                const output = await this.exec([`--acquire-floating`], true);
                const tokenMatch = output.match(/with token:\s*"(?<token>[\w-]+)"/);

                if (!tokenMatch || !tokenMatch.groups || !tokenMatch.groups['token']) {
                    throw new Error(`Failed to acquire floating license lease: No token found in output.\n  ${SanitizeLogText(output)}`);
                }

                const token = tokenMatch.groups['token'];
                this.logger.CI_mask(token);
                // the token is returned to the caller (and printed with --json); the log never shows it
                this.logger.info(redactSensitiveLiterals(output, [token]));
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
        await this.returnLicense(licenseType, token);
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

    /**
     * The machine binding values the licensing client reports for this machine (Legacy.MachineBinding1, 2, ...).
     * @returns The values, or an empty list when the client cannot report them.
     */
    public async GetMachineBindings(): Promise<string[]> {
        try {
            const context = await this.exec(['--showContext'], true);
            return [...context.matchAll(/Legacy\.MachineBinding\d+[ \t]+(\S+)/g)].map(match => match[1]!);
        } catch (error) {
            this.logger.debug(`Failed to read the machine bindings: ${error}`);
            return [];
        }
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

        // keep redacting the account details in every later command's output, such as --showEntitlements
        this.secrets.push(username, password, ...(serial ? [serial, serial.slice(0, -4) + 'XXXX'] : []));
        await this.exec(args);

        const activeLicenses = await this.GetActiveEntitlements();

        if (!activeLicenses.includes(licenseType)) {
            throw new Error(`Failed to activate license of type '${licenseType}'`);
        }

        await this.linkLegacyLicenseFile();
        this.logger.info(`Successfully activated license of type '${licenseType}'`);
    }

    /**
     * Points Unity_v4.x.ulf or Unity_v5.x.ulf at the license the client actually wrote. Clients that ignore
     * UNITY_COMMON_DIR, such as the macOS one, write Unity_lic.ulf to the regular folder instead of the patched one.
     */
    private async linkLegacyLicenseFile(): Promise<void> {
        if (!this.legacyLicense) {
            return;
        }

        const { linkPath, commonDirectory, patchedDirectory } = this.legacyLicense;
        const candidates = [path.join(patchedDirectory, 'Unity_lic.ulf'), path.join(commonDirectory, 'Unity_lic.ulf')];
        const licensePath = candidates.find(candidate => fs.existsSync(candidate));

        if (!licensePath) {
            this.logger.warn(`No Unity_lic.ulf was written to ${candidates.join(' or ')}`);
            return;
        }

        await fs.promises.rm(linkPath, { force: true });
        await fs.promises.symlink(licensePath, linkPath);
        // the license version decides whether a 4.x or 5.x editor accepts the file
        const licenseVersion = (await fs.promises.readFile(licensePath, 'utf-8')).match(/<LicenseVersion Value="([^"]+)"/)?.[1];
        this.logger.info(`Linked ${linkPath} to ${licensePath} (license version ${licenseVersion ?? 'unknown'})`);
    }

    private async returnLicense(licenseType: LicenseType, token?: string): Promise<void> {
        if (licenseType === LicenseType.floating) {
            if (!token || token.length === 0) {
                throw new Error('A token is required to return a floating license');
            }

            await this.exec([`--return-floating`, token]);
        }
        else {
            let activeLicenses = await this.GetActiveEntitlements();

            if (activeLicenses.includes(licenseType)) {
                await this.exec([`--return-ulf`]);
            } else {
                this.logger.info(`No active license of type '${licenseType}' found`);
                return;
            }

            activeLicenses = await this.GetActiveEntitlements();

            if (activeLicenses.includes(licenseType)) {
                throw new Error(`Failed to return license of type '${licenseType}'`);
            }
        }

        this.logger.info(`Successfully returned license of type '${licenseType}'`);
    }
}
/**
 * Gets the license version a 4.x or 5.x editor in UNITY_EDITOR_PATH reads, or undefined for newer editors.
 * @param editorPath The editor executable. Defaults to UNITY_EDITOR_PATH.
 */
export function GetLegacyLicenseVersion(editorPath: string | undefined = process.env.UNITY_EDITOR_PATH): '4.x' | '5.x' | undefined {
    // anchored per path segment, so the match stays linear on any input
    for (const segment of (editorPath ?? '').split(/[\\/ ]/)) {
        const major = /^(\d{1,4})\.\d{1,4}\.\d/.exec(segment)?.[1];

        if (major === undefined) {
            continue;
        }

        switch (major) {
            case '4':
                return '4.x';
            case '5':
                return '5.x';
            default:
                return undefined;
        }
    }

    return undefined;
}

/** How long one official CLI license command may run before it falls back. */
const UNITY_CLI_LICENSE_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * Activates a Unity license through the official Unity CLI first.
 * Falls back to the Unity Licensing Client with the Unity ID email and password when the CLI fails,
 * for example a personal license on a headless runner with no browser sign-in.
 * 4.x and 5.x editors read their own license file, so they always use the Unity Licensing Client.
 * @param options The activation options.
 * @returns The floating license token, when one is known.
 */
export async function ActivateLicense(options: ActivateOptions): Promise<string | undefined> {
    const logger = Logger.instance;
    const legacyLicenseVersion = GetLegacyLicenseVersion();

    if (legacyLicenseVersion) {
        logger.info(`Unity ${legacyLicenseVersion} editors read their own license file, activating with the Unity Licensing Client...`);
        await LicensingClient.StopBackgroundClients();
        return await new LicensingClient(legacyLicenseVersion).Activate(options);
    }

    const licenseFile = options.licenseFile ?? process.env.UNITY_LICENSE;

    if (licenseFile && licenseFile.trim().length > 0 &&
        (options.licenseType === LicenseType.personal || options.licenseType === LicenseType.professional)) {
        try {
            if (await activateFromLicenseFile(licenseFile)) {
                // lets a CI step tell whether it needs to store a fresh license
                logger.CI_setOutput('license-source', 'license-file');
                return undefined;
            }
        } catch (error) {
            logger.warn(`The license file could not be used, activating with the account instead.\n${error}`);
        }
    }

    logger.CI_setOutput('license-source', 'account');
    let cliError: unknown;

    try {
        const result = await activateWithUnityCli(options);

        if (result.activated) {
            await logLicenseBinding();
            return result.token;
        }

        cliError = result.reason;
    } catch (error) {
        cliError = error;
    }

    logger.warn(`Unity CLI license activation failed, falling back to the Unity Licensing Client.\n${cliError}`);

    if (options.licenseType !== LicenseType.floating &&
        !options.username && !process.env.UNITY_USERNAME_BASE64) {
        throw new Error(`Unity CLI license activation failed, and no Unity ID email and password were given for the fallback.\n${cliError}`);
    }

    await LicensingClient.StopBackgroundClients();
    return await new LicensingClient().Activate(options);
}

/**
 * Logs whether the license file now on disk names this machine's binding, which is what a cached copy is checked
 * against on the next run. Only a yes or no is logged, never the binding or the file.
 */
async function logLicenseBinding(): Promise<void> {
    try {
        const content = await fs.promises.readFile(GetLicenseFilePath(), 'utf-8');
        const bindings = await new LicensingClient().GetMachineBindings();

        if (bindings.length > 0) {
            Logger.instance.info(`The license file is bound to this machine's identity: ${bindings.some(binding => content.includes(binding)) ? 'yes' : 'no'}`);
        }
    } catch (error) {
        Logger.instance.debug(`Could not compare the license file with this machine's identity: ${error}`);
    }
}

/** When `return-license` returns: `auto` skips a shared runner identity, `always` and `never` do what they say. */
export type ReturnWhen = 'auto' | 'always' | 'never';

/**
 * Whether this is a GitHub-hosted macOS or Linux runner. Those report one machine identity to Unity across every job
 * and repo, so returning a license there revokes it for all of them. Windows and self-hosted runners have their own.
 */
export function IsSharedRunnerIdentity(): boolean {
    return process.env.RUNNER_ENVIRONMENT === 'github-hosted' && (process.platform === 'darwin' || process.platform === 'linux');
}

/**
 * Returns a Unity license through the official Unity CLI first, then the Unity Licensing Client.
 * @param licenseType The type of license to return.
 * @param token The floating license token from activation. A floating license with a token is returned by the Unity Licensing Client.
 * @param when `auto` (the default) skips returning a personal or professional license on a shared runner identity.
 */
export async function ReturnLicense(licenseType: LicenseType, token: string | undefined = undefined, when: ReturnWhen = 'auto'): Promise<void> {
    try {
        if (when === 'never') {
            Logger.instance.info('Skipping the license return (--when never).');
        } else if (when === 'auto' && licenseType !== LicenseType.floating && IsSharedRunnerIdentity()) {
            Logger.instance.info('Skipping the license return: GitHub-hosted macOS and Linux runners share one machine identity, so a return would revoke the license for every job and repo on it. Use --when always to return anyway.');
        } else {
            await returnLicense(licenseType, token);
        }
    } finally {
        // returning is the last licensing step of a job, so stop what the licensing calls left running in the background
        await LicensingClient.StopBackgroundClients();
        await stopUnityCliHelpers();
    }
}

/**
 * Stops background processes the official Unity CLI left running from its own folder. Only done in CI.
 */
async function stopUnityCliHelpers(): Promise<void> {
    const cliPath = process.env.UNITY_CLI_PATH;

    if (process.env.CI !== 'true' || !cliPath) {
        return;
    }

    const helpers = await FindProcessesUnder(path.dirname(cliPath));
    await Promise.all(helpers.map(helper => KillProcess(helper).catch(() => undefined)));
}

async function returnLicense(licenseType: LicenseType, token: string | undefined): Promise<void> {
    const logger = Logger.instance;
    const legacyLicenseVersion = GetLegacyLicenseVersion();

    if (legacyLicenseVersion || (licenseType === LicenseType.floating && token)) {
        await LicensingClient.StopBackgroundClients();
        await new LicensingClient(legacyLicenseVersion).Deactivate(licenseType, token);
        return;
    }

    try {
        const cli = await UnityCli.Get();
        const { exitCode, envelope } = await cli.RunJson(['license', 'return', '--yes'], { timeoutMs: UNITY_CLI_LICENSE_TIMEOUT_MS });

        if (exitCode === 0 && envelope?.success !== false && !(await isLicenseActive(cli))) {
            logger.info(`Successfully returned license of type '${licenseType}'`);
            return;
        }

        logger.warn(`unity license return exited with code ${exitCode}${formatEnvelopeErrors(envelope)}, falling back to the Unity Licensing Client...`);
    } catch (error) {
        logger.warn(`Unity CLI license return failed, falling back to the Unity Licensing Client.\n${error}`);
    }

    if (licenseType === LicenseType.floating) {
        throw new Error('The Unity CLI could not return the floating license. Pass the token from activation to return it with the Unity Licensing Client.');
    }

    await LicensingClient.StopBackgroundClients();
    await new LicensingClient().Deactivate(licenseType);
}

/**
 * Prints the license state from the official Unity CLI, then the Unity Licensing Client context.
 */
export async function PrintLicenseContext(): Promise<void> {
    try {
        const cli = await UnityCli.Get();
        await cli.Run(['license', 'status'], { stream: true });
    } catch (error) {
        Logger.instance.warn(`Failed to read the Unity CLI license status: ${error}`);
    }

    await new LicensingClient(GetLegacyLicenseVersion()).Context();
}

/**
 * Gets where Unity reads the machine's license file, Unity_lic.ulf.
 */
export function GetLicenseFilePath(): string {
    switch (process.platform) {
        case 'win32':
            return path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'Unity', 'Unity_lic.ulf');
        case 'darwin':
            return path.join('/Library', 'Application Support', 'Unity', 'Unity_lic.ulf');
        default:
            return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'unity3d', 'Unity', 'Unity_lic.ulf');
    }
}

/**
 * Activates from a cached license file: `unity license activate --file` first, then by placing the file where Unity reads it.
 * The file's contents are never logged.
 * @param licenseFile A path to the license file, its raw XML, or base64.
 * @returns True when a license is active afterwards.
 */
async function activateFromLicenseFile(licenseFile: string): Promise<boolean> {
    const logger = Logger.instance;
    const trimmed = licenseFile.trim();
    let content: string;

    if (!trimmed.startsWith('<') && fs.existsSync(trimmed)) {
        content = await fs.promises.readFile(trimmed, 'utf-8');
    } else if (trimmed.startsWith('<')) {
        content = trimmed;
    } else {
        content = Buffer.from(trimmed, 'base64').toString('utf-8');
    }

    if (!content.includes('<License') || !content.includes('</root>')) {
        throw new Error('The license file is not a Unity license (Unity_lic.ulf).');
    }

    // a license file is bound to the machine it was issued to: it still activates offline on another machine, but the
    // licensing servers resolve no entitlements for it, and the editor fails later. Runner images change that identity.
    const bindings = await new LicensingClient().GetMachineBindings();

    if (bindings.length > 0 && !bindings.some(binding => content.includes(binding))) {
        logger.warn('The cached license file was issued to a different machine identity, likely before a runner image change. Activating with the account instead.');
        return false;
    }

    logger.info('Activating from the cached license file...');
    const tempDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'unity-license-'));
    const tempFile = path.join(tempDirectory, 'Unity_lic.ulf');

    try {
        await fs.promises.writeFile(tempFile, content, { encoding: 'utf-8', mode: 0o600 });

        try {
            const cli = await UnityCli.Get();
            const { exitCode, envelope } = await cli.RunJson(['license', 'activate', '--file', tempFile], { timeoutMs: UNITY_CLI_LICENSE_TIMEOUT_MS });

            if (exitCode === 0 && envelope?.success !== false && await isLicenseActive(cli)) {
                logger.info('Successfully activated from the cached license file with the Unity CLI');
                return true;
            }

            logger.warn(`unity license activate --file exited with code ${exitCode}${formatEnvelopeErrors(envelope)}, placing the license file directly...`);
        } catch (error) {
            logger.warn(`Unity CLI activation from the license file failed, placing the license file directly...\n${error}`);
        }

        const licensePath = GetLicenseFilePath();
        await fs.promises.mkdir(path.dirname(licensePath), { recursive: true });
        await fs.promises.copyFile(tempFile, licensePath);
        const active = await new LicensingClient().GetActiveEntitlements();

        if (active.length > 0) {
            logger.info(`Successfully activated from the cached license file (${active.join(', ')})`);
            return true;
        }

        return false;
    } finally {
        await fs.promises.rm(tempDirectory, { recursive: true, force: true });
    }
}

async function activateWithUnityCli(options: ActivateOptions): Promise<{ activated: boolean; token?: string | undefined; reason?: string | undefined }> {
    const args = ['license', 'activate'];
    const redactLiterals: string[] = [];

    switch (options.licenseType) {
        case LicenseType.personal:
            args.push('--personal', '--accept-eula');
            break;
        case LicenseType.professional:
            if (!options.serial) {
                return { activated: false, reason: 'A serial is required to activate a professional license with the Unity CLI.' };
            }

            args.push('--serial', options.serial.trim());
            redactLiterals.push(options.serial.trim());
            break;
        case LicenseType.floating:
            if (!options.servicesConfig) {
                throw new Error('Services config path is required for floating license activation');
            }

            await new LicensingClient().setupServicesConfig(options.servicesConfig);
            args.push('--floating');
            break;
    }

    const cli = await UnityCli.Get();
    Logger.instance.info(`Activating a ${options.licenseType} license with the Unity CLI...`);
    const { exitCode, envelope } = await cli.RunJson<unknown>(args, { timeoutMs: UNITY_CLI_LICENSE_TIMEOUT_MS, redactLiterals });

    if (exitCode !== 0 || envelope?.success === false) {
        return { activated: false, reason: `unity license activate exited with code ${exitCode}${formatEnvelopeErrors(envelope)}` };
    }

    if (!(await isLicenseActive(cli))) {
        return { activated: false, reason: 'unity license activate succeeded, but unity license status reports no active license' };
    }

    const token = findToken(envelope?.data);

    if (token) {
        Logger.instance.CI_mask(token);
    }

    Logger.instance.info(`Successfully activated license of type '${options.licenseType}' with the Unity CLI`);
    return { activated: true, token };
}

/**
 * Reads whether a license is active. Throws when the CLI gives no clear answer (a timeout or an unparseable result),
 * so callers fall back instead of assuming the license is gone. LICENSE_NOT_ACTIVE exits 4 with active: false.
 */
async function isLicenseActive(cli: UnityCli): Promise<boolean> {
    const { exitCode, envelope } = await cli.RunJson<{ active?: boolean }>(['license', 'status'], { timeoutMs: UNITY_CLI_LICENSE_TIMEOUT_MS });
    const active = envelope?.data?.active;

    if ((exitCode === 0 || exitCode === 4) && typeof active === 'boolean') {
        return active;
    }

    throw new Error(`unity license status exited with code ${exitCode} without a license state${formatEnvelopeErrors(envelope)}`);
}

function findToken(value: unknown): string | undefined {
    if (!value || typeof value !== 'object') {
        return undefined;
    }

    for (const [key, item] of Object.entries(value as { [key: string]: unknown })) {
        if (typeof item === 'string' && /token/i.test(key) && item.length > 0) {
            return item;
        }

        const nested = findToken(item);

        if (nested) {
            return nested;
        }
    }

    return undefined;
}

function formatEnvelopeErrors(envelope: { errors?: { code: string; message: string }[] } | undefined): string {
    const errors = envelope?.errors ?? [];
    return errors.length > 0 ? `\n${errors.map(e => `  > ${e.code}: ${e.message}`).join('\n')}` : '';
}
