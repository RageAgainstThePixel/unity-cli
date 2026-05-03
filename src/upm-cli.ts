import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    SemVer,
    coerce,
    compare,
    parse,
    valid,
} from 'semver';
import {
    Logger,
    LogLevel
} from './logging';
import {
    DeleteDirectory,
    DownloadFile,
    Exec,
    ExecOptions,
    extractZipNative,
    GetTempDir,
    HttpsGetText,
    isInteractiveTerminalSession,
    PromptYesNo,
    Sha256FileHex,
} from './utilities';

export interface EnsureUpmInstalledOptions {
    version?: string;
    skipIfInstalled?: boolean;
}

/** Arguments for {@link UpmCli.Pack} (mapped to `UnityPackageManager pack …`). */
export interface UpmPackOptions {
    /** Unity Cloud organization id. */
    organizationId: string;
    /** Output path for the packed artifact. */
    destination?: string;
    /** Folder containing `package.json` to pack; when omitted the child process cwd applies. */
    packageDirectory?: string;
}

/**
 * Managed Unity Package Manager CLI (unity-cli–installed `UnityPackageManager`), modeled after {@link UnityHub}:
 * parameterless constructor resolves roots and executable preference, {@link Install} manages downloads, {@link Exec} runs the binary.
 */
export class UpmCli {
    /** Root directory for managed installs (~/.unity-cli/upm), analogous to {@link UnityHub.rootDirectory}. */
    public readonly managedRoot: string;

    private readonly logger: Logger = Logger.instance;

    constructor() {
        this.managedRoot = path.join(os.homedir(), '.unity-cli', 'upm');
    }

    private static getCdnBaseUrl(): string {
        const override = process.env.UPM_CDN_BASE_URL?.trim();
        if (override && override.length > 0) {
            return `${override.replace(/\/$/, '')}/upm-cli`;
        }
        return 'https://cdn.packages.unity.com/upm-cli';
    }

    private static normalizeSemver(version: string): string | undefined {
        const normalized = valid(version);
        if (normalized) {
            return normalized;
        }
        const coerced = coerce(version);
        return coerced?.version;
    }

    private static parseVerifiedSemVerFromLine(line: string): SemVer | null {
        const t = line.trim();
        if (!t) {
            return null;
        }
        const direct = valid(t);
        if (direct) {
            const parsed = parse(direct, false);
            if (parsed && valid(parsed.version)) {
                return parsed;
            }
        }
        const coerced = coerce(t);
        if (coerced && valid(coerced)) {
            return coerced;
        }
        return null;
    }

    private static parseCliVersionStdout(output: string): SemVer {
        const trimmed = output.trim();
        if (!trimmed) {
            throw new Error('Upm cli --version produced empty output.');
        }
        const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
        for (let i = lines.length - 1; i >= 0; i--) {
            const version = UpmCli.parseVerifiedSemVerFromLine(lines[i]!);
            if (version) {
                return version;
            }
        }
        const fallback = UpmCli.parseVerifiedSemVerFromLine(trimmed);
        if (fallback) {
            return fallback;
        }
        throw new Error(`Failed to parse upm cli version: ${JSON.stringify(trimmed)}`);
    }

    private getVersionInstallDir(version: string): string {
        const t = version.trim();
        this.validateVersionFormat(t);
        if (t.includes('..') || path.normalize(t) !== t) {
            throw new Error(`Invalid upm cli release tag for path use: ${version}`);
        }
        const dir = path.join(this.managedRoot, t);
        const resolvedDir = path.resolve(dir);
        const resolvedRoot = path.resolve(this.managedRoot);
        const rootPrefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
        if (resolvedDir !== resolvedRoot && !resolvedDir.startsWith(rootPrefix)) {
            throw new Error('Resolved UPM install directory left managed root.');
        }
        return dir;
    }

    private getCurrentVersionFilePath(): string {
        return path.join(this.managedRoot, 'current-version.txt');
    }

    private getPlatformId(): string {
        const plat = process.platform;
        const arch = process.arch;

        if (plat === 'win32') {
            if (arch === 'arm64') {
                return 'windows-arm64';
            }
            return 'windows-x64';
        }

        if (plat === 'darwin') {
            if (arch === 'arm64') {
                return 'macos-arm64';
            }
            return 'macos-x64';
        }

        if (plat === 'linux') {
            if (arch === 'arm64') {
                return 'linux-arm64';
            }
            return 'linux-x64';
        }

        throw new Error(`Unsupported platform for upm cli: ${plat} ${arch}`);
    }

    private validateVersionFormat(version: string): void {
        const t = version.trim();
        if (!t.startsWith('v') || !valid(t)) {
            throw new Error(`Invalid upm cli version format: ${version}. Expected a semver release tag with leading v (e.g. v9.27.0).`);
        }
    }

    private findPrimaryExecutable(installDir: string): string {
        if (process.platform === 'win32') {
            const exe = path.join(installDir, 'UnityPackageManager.exe');
            if (fs.existsSync(exe)) {
                return exe;
            }
        } else {
            const bin = path.join(installDir, 'UnityPackageManager');
            if (fs.existsSync(bin)) {
                return bin;
            }
        }
        throw new Error(`Could not find UnityPackageManager binary under ${installDir}`);
    }

    /** Optional executable override (mirrors `UNITY_HUB_PATH` for {@link UnityHub}). */
    private getExecutablePathOverride(): string | undefined {
        const p = process.env.UPM_CLI_PATH?.trim();
        return p && p.length > 0 ? path.normalize(p) : undefined;
    }

    private executableOverrideIsUsable(): boolean {
        const p = this.getExecutablePathOverride();
        if (!p) {
            return false;
        }
        try {
            fs.accessSync(p, fs.constants.R_OK | fs.constants.X_OK);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Release tag of the managed install from `current-version.txt`, if present and valid.
     */
    public GetInstalledReleaseTag(): string | undefined {
        const currentFile = this.getCurrentVersionFilePath();
        if (!fs.existsSync(currentFile)) {
            return undefined;
        }
        try {
            const version = fs.readFileSync(currentFile, 'utf8').trim();
            if (!version) {
                return undefined;
            }
            this.validateVersionFormat(version);
            return version;
        } catch {
            return undefined;
        }
    }

    /**
     * Path to the primary `UnityPackageManager` binary for a managed release, or `undefined` if missing.
     */
    public ResolveManagedPrimaryPath(version?: string): string | undefined {
        let v = version?.trim() || this.GetInstalledReleaseTag();

        if (!v) {
            return undefined;
        }

        const installDir = this.getVersionInstallDir(v);
        try {
            return this.findPrimaryExecutable(installDir);
        } catch {
            return undefined;
        }
    }

    /**
     * Resolved path used to spawn the UPM CLI: `UPM_CLI_PATH` override when set, otherwise the managed primary binary.
     * @throws If nothing usable is installed (mirrors Hub/Editor behavior when the executable cannot be used).
     */
    public GetExecutablePath(): string {
        const overridePath = this.getExecutablePathOverride();
        if (overridePath) {
            fs.accessSync(overridePath, fs.constants.R_OK | fs.constants.X_OK);
            return overridePath;
        }
        const managed = this.ResolveManagedPrimaryPath();
        if (!managed) {
            throw new Error('Upm cli is not installed. Run `unity-cli upm-install` first.');
        }
        fs.accessSync(managed, fs.constants.R_OK | fs.constants.X_OK);
        return managed;
    }

    /** Same role as {@link UnityHub.executable}: path used to spawn the UPM CLI (may reflect `UPM_CLI_PATH` or the managed install). */
    public get executable(): string {
        return this.GetExecutablePath();
    }

    public async GetLatestReleaseTag(): Promise<string> {
        const cdn = UpmCli.getCdnBaseUrl();
        const latestUrl = `${cdn}/latest.txt`;
        const version = (await HttpsGetText(latestUrl)).trim();
        this.validateVersionFormat(version);
        return version;
    }

    /** True if `latestTag` is newer than the installed managed release, or nothing is installed yet. */
    public IsUpdateAvailable(latestTag: string): boolean {
        const current = this.GetInstalledReleaseTag();
        if (!current) {
            return true;
        }
        const normalizedCurrent = UpmCli.normalizeSemver(current);
        const normalizedLatest = UpmCli.normalizeSemver(latestTag);
        if (normalizedCurrent && normalizedLatest) {
            return compare(normalizedLatest, normalizedCurrent) > 0;
        }
        return latestTag.trim() !== current.trim();
    }

    /**
     * Installs or updates the managed UPM CLI (mirrors {@link UnityHub.Install} for the Hub itself).
     * @returns Installed release tag (e.g. v9.27.0).
     */
    public async Install(options?: EnsureUpmInstalledOptions): Promise<string> {
        const cdn = UpmCli.getCdnBaseUrl();
        let version = options?.version?.trim();

        if (!version || version.length === 0) {
            version = await this.GetLatestReleaseTag();
        }

        version = version.trim();

        const installDir = this.getVersionInstallDir(version);
        const markerPath = path.join(installDir, '.unity-cli-upm-installed');

        if (options?.skipIfInstalled !== false && fs.existsSync(markerPath)) {
            try {
                this.findPrimaryExecutable(installDir);
                const recordedTag = path.basename(installDir);
                await fs.promises.writeFile(this.getCurrentVersionFilePath(), `${recordedTag}\n`, 'utf8');
                return version;
            } catch {
                // reinstall
            }
        }

        const platform = this.getPlatformId();
        const zipName = `upm-${platform}.zip`;
        const baseReleaseUrl = `${cdn}/releases/${version}`;
        const zipUrl = `${baseReleaseUrl}/${zipName}`;
        const checksumUrl = `${baseReleaseUrl}/${zipName}.sha256`;

        const tempRoot = path.join(GetTempDir(), `unity-cli-upm-${Date.now()}`);
        const resolvedTempRoot = path.resolve(tempRoot);
        const zipPath = path.join(resolvedTempRoot, zipName);
        const checksumPath = path.join(resolvedTempRoot, `${zipName}.sha256`);

        try {
            this.logger.info(`Installing upm cli ${version} (${platform})...`);
            await DownloadFile(zipUrl, zipPath);
            await DownloadFile(checksumUrl, checksumPath);

            const checksumContent = (await fs.promises.readFile(checksumPath, 'utf8')).trim();
            const expectedHash = checksumContent.split(/\s+/)[0]?.toLowerCase();
            if (!expectedHash) {
                throw new Error(`Could not read SHA-256 from ${checksumPath}`);
            }

            const actualHash = (await Sha256FileHex(zipPath)).toLowerCase();
            if (actualHash !== expectedHash) {
                throw new Error(`SHA-256 mismatch for upm cli zip. Expected ${expectedHash}, got ${actualHash}`);
            }

            await DeleteDirectory(installDir);
            await fs.promises.mkdir(installDir, { recursive: true });
            await extractZipNative(zipPath, installDir, {
                zipUnder: resolvedTempRoot,
                destUnder: path.resolve(this.managedRoot),
            }, {
                silent: false,
                showCommand: this.logger.logLevel === LogLevel.DEBUG
            });

            const primary = this.findPrimaryExecutable(installDir);
            if (process.platform !== 'win32') {
                try {
                    fs.chmodSync(primary, 0o755);
                } catch {
                    // ignore
                }
            }

            const wrapperUnix = path.join(installDir, 'upm');
            if (process.platform !== 'win32' && fs.existsSync(wrapperUnix)) {
                try {
                    fs.chmodSync(wrapperUnix, 0o755);
                } catch {
                    // ignore
                }
            }

            await fs.promises.writeFile(markerPath, `${new Date().toISOString()}\n`, 'utf8');
            const recordedTag = path.basename(installDir);
            await fs.promises.writeFile(this.getCurrentVersionFilePath(), `${recordedTag}\n`, 'utf8');

            return version;
        } finally {
            await DeleteDirectory(tempRoot);
        }
    }

    /**
     * When running in an interactive terminal, may prompt to install a missing UPM CLI or update to the latest CDN release.
     * When not interactive, logs a warning if the running binary is older than the CDN latest (no install).
     * Compares the running binary ({@link Version}) to {@link GetLatestReleaseTag} (including when {@code UPM_CLI_PATH} overrides the managed install).
     * Call before {@link GetExecutablePath} / {@link Exec} for Hub-style optional install/update (e.g. pack).
     */
    public async PromptInstallOrUpdateWhenInteractive(): Promise<void> {
        const overrideUsable = this.executableOverrideIsUsable();
        const managedExe = this.ResolveManagedPrimaryPath();
        const hasExecutable = overrideUsable || managedExe !== undefined;

        if (!hasExecutable) {
            if (isInteractiveTerminalSession()) {
                const install = await PromptYesNo(
                    'The upm cli is not installed. Download and install it now?',
                    true
                );
                if (install) {
                    await this.Install({ skipIfInstalled: false });
                }
            }
            return;
        }

        try {
            const latestTag = await this.GetLatestReleaseTag();
            const latestSem = UpmCli.parseVerifiedSemVerFromLine(latestTag);
            if (!latestSem) {
                return;
            }

            const installedSem = await this.Version();
            if (compare(latestSem, installedSem) <= 0) {
                return;
            }

            const usingOverride = overrideUsable;

            if (!isInteractiveTerminalSession()) {
                if (usingOverride) {
                    this.logger.warn(
                        `The upm cli (UPM_CLI_PATH) reports ${installedSem.version}, but ${latestTag} is available on the CDN. This run still uses UPM_CLI_PATH; update that binary or unset it and run unity-cli upm-install to use the managed release.`,
                    );
                } else {
                    this.logger.warn(
                        `The upm cli (${installedSem.version}) is older than the latest release (${latestTag}). Run unity-cli upm-install or unity-cli upm-install --auto-update to update.`,
                    );
                }
                return;
            }

            const prompt = usingOverride
                ? `Your upm cli (UPM_CLI_PATH) reports ${installedSem.version}, but ${latestTag} is available. Install the latest to the managed location now? This run will keep using UPM_CLI_PATH until you unset it or point it at the new binary.`
                : `A newer upm cli version is available (${installedSem.version} -> ${latestTag}). Install it now?`;

            const shouldUpdate = await PromptYesNo(prompt, !usingOverride);
            if (!shouldUpdate) {
                return;
            }

            await this.Install({
                version: latestTag,
                skipIfInstalled: false,
            });

            if (usingOverride) {
                this.logger.warn(
                    `Installed upm cli ${latestTag} under ${this.managedRoot}. Unset UPM_CLI_PATH (or update it) so subsequent commands use the new install.`,
                );
            }
        } catch (error) {
            this.logger.debug(`Failed to check for upm cli updates: ${error}`);
        }
    }

    /**
     * Executes the UPM CLI with the given arguments (mirrors {@link UnityHub.Exec}).
     */
    public async Exec(args: string[], options: ExecOptions = { silent: this.logger.logLevel > LogLevel.CI, showCommand: this.logger.logLevel <= LogLevel.CI }): Promise<string> {
        const exe = this.GetExecutablePath();
        if (exe.includes(path.sep)) {
            fs.accessSync(exe, fs.constants.R_OK | fs.constants.X_OK);
        }
        return Exec(exe, args, options);
    }

    /**
     * Runs `--version` and returns the verified semver from the binary.
     * @param expectedReleaseTag When set (e.g. from {@link Install}), ensures the reported semver matches this CDN release tag.
     */
    public async Version(expectedReleaseTag?: string): Promise<SemVer> {
        const raw = await this.Exec(['--version'], {
            silent: true,
            showCommand: this.logger.logLevel === LogLevel.DEBUG,
        });
        const version = UpmCli.parseCliVersionStdout(raw);
        if (expectedReleaseTag !== undefined && expectedReleaseTag.trim().length > 0) {
            const tag = expectedReleaseTag.trim();
            const expected = UpmCli.parseVerifiedSemVerFromLine(tag);
            if (!expected) {
                throw new Error(`Invalid installed upm cli release tag: ${expectedReleaseTag}`);
            }
            if (compare(version, expected) !== 0) {
                throw new Error(
                    `Upm cli binary version mismatch: binary reported ${version.version} (--version), expected ${expected.version} (${expectedReleaseTag}).`
                );
            }
        }
        return version;
    }

    /**
     * Runs the UPM CLI `pack` subcommand (builds argv from {@link UpmPackOptions}, then {@link Exec}).
     */
    public async Pack(options: UpmPackOptions, execOptions?: ExecOptions): Promise<string> {
        const orgId = options.organizationId.trim();

        if (!orgId) {
            throw new Error('UpmCli.Pack requires a non-empty organizationId.');
        }

        const args: string[] = [];

        if (this.logger.logLevel === LogLevel.DEBUG) {
            args.push('--log-level', '5', '--console-log-level', '5');
        }

        args.push('pack', '--organization-id', orgId);
        const dest = options.destination?.trim();

        if (dest && dest.length > 0) {
            args.push('--destination', dest);
        }

        const dir = options.packageDirectory?.trim();

        if (dir && dir.length > 0) {
            args.push(dir);
        }

        return this.Exec(args, execOptions);
    }
}
