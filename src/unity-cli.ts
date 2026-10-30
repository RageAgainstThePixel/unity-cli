import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { Logger } from './logging';
import {
    DownloadFile,
    GetTempDir,
    HttpsGetText,
    SanitizeLogText,
    Sha256FileHex,
    redactSensitiveLiterals,
} from './utilities';
import { OwnedSpawnOptions, TrackOwnedProcess } from './process-tracker';
import { compare as compareSemver, valid } from 'semver';

const CDN_BASE = 'https://public-cdn.cloud.unity3d.com/hub/prod/cli/';
const TOOL_NAME = 'unity-cli';
const EXE_NAME = process.platform === 'win32' ? 'unity.exe' : 'unity';
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export interface UnityCliResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

/** The envelope every `--format json` result of the official CLI uses. */
export interface UnityCliEnvelope<T = unknown> {
    success: boolean;
    command?: string;
    data?: T;
    errors?: { code: string; message: string }[];
    warnings?: unknown[];
}

export interface UnityCliRunOptions {
    /** Stream output to the console. Defaults to false. */
    stream?: boolean;
    /** Kill the CLI after this many milliseconds. */
    timeoutMs?: number;
    /** Values replaced with `*****` in logged output and the logged command. */
    redactLiterals?: readonly string[];
}

interface UnityCliManifest {
    version: string;
    binaries: { [platform: string]: { filename: string; sha256: string } };
}

/**
 * A thin wrapper over Unity's official CLI (`unity`).
 * @see https://docs.unity.com/en-us/cli
 */
export class UnityCli {
    private readonly logger: Logger = Logger.instance;

    constructor(
        public readonly executable: string,
        public readonly version: string
    ) { }

    /**
     * Returns the official Unity CLI, installing it when it is missing or is not the requested version.
     * @param version An exact version such as 1.0.0-beta.14, or `latest`. Defaults to UNITY_CLI_VERSION, then `latest`.
     * Every install exports UNITY_CLI_VERSION, so later steps in the same job reuse the version the first one resolved.
     */
    public static async Get(version: string | undefined = undefined): Promise<UnityCli> {
        configureEnvironment();
        const requested = normalizeVersion(version || process.env.UNITY_CLI_VERSION || 'latest');

        // latest resolves the manifest first, so an outdated CLI is not reused
        if (requested === 'latest') {
            return await UnityCli.Install('latest');
        }

        const existing = await UnityCli.Find();

        if (existing && existing.version === requested) {
            Logger.instance.debug(`Using Unity CLI ${existing.version} at ${existing.executable}`);
            return exportCli(existing);
        }

        if (existing) {
            Logger.instance.info(`Found Unity CLI ${existing.version} at ${existing.executable}, but ${requested} was requested`);
        }

        return await UnityCli.Install(requested);
    }

    /**
     * Finds an installed official Unity CLI from UNITY_CLI_PATH, the tool cache, the install script's default location, or the PATH.
     * The PATH comes last, since other programs named unity live there, such as the Unity7 shell on Ubuntu desktops.
     */
    public static async Find(): Promise<UnityCli | undefined> {
        const candidates: string[] = [];

        if (process.env.UNITY_CLI_PATH) {
            candidates.push(process.env.UNITY_CLI_PATH);
        }

        candidates.push(...findCachedExecutables());
        candidates.push(...defaultInstallLocations());

        for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
            if (dir && dir.length > 0) {
                candidates.push(path.join(dir, EXE_NAME));
            }
        }

        for (const candidate of candidates) {
            // only ever run a binary named unity(.exe), even when UNITY_CLI_PATH points elsewhere
            if (path.basename(candidate).toLowerCase() !== EXE_NAME || !isExecutableFile(candidate)) {
                continue;
            }

            try {
                const version = await getCliVersion(candidate);
                return new UnityCli(candidate, version);
            } catch (error) {
                Logger.instance.debug(`Skipping ${candidate}: ${error}`);
            }
        }

        return undefined;
    }

    /**
     * Downloads an exact official Unity CLI release from Unity's CDN, verifies its SHA-256 and caches it.
     * @param version An exact version such as 1.0.0-beta.14, or `latest`.
     */
    public static async Install(version: string = 'latest'): Promise<UnityCli> {
        configureEnvironment();
        const requested = normalizeVersion(version);
        let manifest: UnityCliManifest;

        try {
            manifest = await fetchManifest(requested);
        } catch (error) {
            // with no network, the newest CLI already in the tool cache still does for latest
            const cachedCli = requested === 'latest' ? await findNewestCachedCli() : undefined;

            if (!cachedCli) {
                throw error;
            }

            Logger.instance.warn(`Could not resolve the latest Unity CLI, using the cached ${cachedCli.version}.\n${error}`);
            return exportCli(cachedCli);
        }

        const platformKey = `${process.platform}-${process.arch}`;
        const binary = manifest.binaries[platformKey];

        if (!binary) {
            throw new Error(`Unity CLI ${manifest.version} has no binary for ${platformKey}. Available: ${Object.keys(manifest.binaries).join(', ')}`);
        }

        if (!/^[\w.-]+$/.test(binary.filename) || !/^[0-9a-f]{64}$/i.test(binary.sha256)) {
            throw new Error(`Invalid binary entry for ${platformKey} in the Unity CLI ${manifest.version} manifest`);
        }

        const cached = getToolCachePath(manifest.version);
        const cachedExecutable = path.join(cached, EXE_NAME);

        if (isExecutableFile(cachedExecutable) && fs.existsSync(`${cached}.complete`)) {
            const cachedVersion = await getCliVersion(cachedExecutable);

            if (cachedVersion === manifest.version) {
                Logger.instance.info(`Using cached Unity CLI ${cachedVersion}`);
                return exportCli(new UnityCli(cachedExecutable, cachedVersion));
            }
        }

        Logger.instance.ci(`Installing Unity CLI ${manifest.version}...`);
        const downloadPath = path.join(GetTempDir(), `${TOOL_NAME}-${Date.now()}`, binary.filename);
        await DownloadFile(`${CDN_BASE}${manifest.version}/${binary.filename}`, downloadPath);

        try {
            const actualHash = await Sha256FileHex(downloadPath);

            if (actualHash.toLowerCase() !== binary.sha256.toLowerCase()) {
                throw new Error(`SHA-256 mismatch for ${binary.filename}: expected ${binary.sha256}, got ${actualHash}`);
            }

            await fs.promises.rm(cached, { recursive: true, force: true });
            await fs.promises.rm(`${cached}.complete`, { force: true });
            await fs.promises.mkdir(cached, { recursive: true });
            await fs.promises.copyFile(downloadPath, cachedExecutable);

            if (process.platform !== 'win32') {
                await fs.promises.chmod(cachedExecutable, 0o755);
            }

            await fs.promises.writeFile(`${cached}.complete`, '');
        } finally {
            await fs.promises.rm(path.dirname(downloadPath), { recursive: true, force: true });
        }

        const installedVersion = await getCliVersion(cachedExecutable);

        if (requested !== 'latest' && installedVersion !== requested) {
            throw new Error(`Failed to install Unity CLI ${requested}, found ${installedVersion}`);
        }

        Logger.instance.info(`Installed Unity CLI ${installedVersion} to ${cachedExecutable}`);
        return exportCli(new UnityCli(cachedExecutable, installedVersion));
    }

    /**
     * Runs the CLI and returns its exit code and output without throwing on a non-zero exit code.
     * @param args The arguments to pass to `unity`.
     * @param options Run options.
     */
    public async Run(args: string[], options: UnityCliRunOptions = {}): Promise<UnityCliResult> {
        const redact = (text: string) => redactSensitiveLiterals(text, options.redactLiterals);
        const commandStr = redact(`\x1b[34m${this.executable} ${args.join(' ')}\x1b[0m`);

        if (options.stream) {
            this.logger.startGroup(commandStr);
        } else {
            this.logger.debug(commandStr);
        }

        try {
            return await new Promise<UnityCliResult>((resolve, reject) => {
                let stdout = '';
                let stderr = '';
                let timedOut = false;
                const startedAt = Date.now();
                const child = spawn(this.executable, args, {
                    shell: false,
                    stdio: ['ignore', 'pipe', 'pipe'],
                    env: process.env,
                    ...OwnedSpawnOptions(),
                });
                // helpers the CLI leaves running, such as its licensing client, stay reachable through this record
                TrackOwnedProcess(child, startedAt);
                const timer = options.timeoutMs
                    ? setTimeout(() => {
                        timedOut = true;
                        child.kill('SIGTERM');
                    }, options.timeoutMs)
                    : undefined;
                const onSignal = () => child.kill('SIGTERM');
                process.once('SIGINT', onSignal);
                process.once('SIGTERM', onSignal);
                // a chunk can end mid-line, so each stream keeps its unfinished line until the rest arrives
                const pending = { stdout: '', stderr: '' };
                const writeLine = (line: string) => {
                    // the CLI prints a plugin hint to stderr on every run
                    if (line.length > 0 && !line.includes('<claude-code-hint')) {
                        process.stdout.write(`${redact(line)}\n`);
                    }
                };
                const writeLines = (stream: 'stdout' | 'stderr', chunk: string) => {
                    if (!options.stream) { return; }
                    const lines = (pending[stream] + chunk).split(/\r?\n/);
                    pending[stream] = lines.pop() ?? '';
                    lines.forEach(writeLine);
                };
                const flushLines = () => {
                    if (!options.stream) { return; }
                    writeLine(pending.stdout);
                    writeLine(pending.stderr);
                    pending.stdout = pending.stderr = '';
                };
                child.stdout.on('data', (data: Buffer) => {
                    const chunk = data.toString();
                    stdout += chunk;
                    writeLines('stdout', chunk);
                });
                child.stderr.on('data', (data: Buffer) => {
                    const chunk = data.toString();
                    stderr += chunk;
                    writeLines('stderr', chunk);
                });
                const cleanup = () => {
                    if (timer) { clearTimeout(timer); }
                    process.removeListener('SIGINT', onSignal);
                    process.removeListener('SIGTERM', onSignal);
                };
                child.on('error', (error) => {
                    cleanup();
                    reject(error);
                });
                child.on('close', (code) => {
                    cleanup();
                    flushLines();
                    const exitCode = timedOut ? 14 : (code ?? 1);
                    this.logger.debug(`unity exited with code ${exitCode}`);
                    resolve({ exitCode, stdout: redact(stdout), stderr: redact(stderr) });
                });
            });
        } finally {
            if (options.stream) {
                this.logger.endGroup();
            }
        }
    }

    /**
     * Runs the CLI and throws when it exits with a non-zero exit code.
     * @param args The arguments to pass to `unity`.
     * @param options Run options. Output streams to the console unless `stream` is false.
     */
    public async Exec(args: string[], options: UnityCliRunOptions = {}): Promise<string> {
        const result = await this.Run(args, { stream: true, ...options });

        if (result.exitCode !== 0) {
            const tail = options.stream === false ? `\n${result.stdout}${stripHint(result.stderr)}` : '';
            throw new Error(`unity ${redactSensitiveLiterals(args.join(' '), options.redactLiterals)} failed with exit code ${result.exitCode}${tail}`);
        }

        return result.stdout;
    }

    /**
     * Runs the CLI with `--format json` and parses the result envelope from stdout.
     * @param args The arguments to pass to `unity`.
     * @param options Run options.
     * @returns The exit code and the parsed envelope, if stdout held one.
     */
    public async RunJson<T = unknown>(args: string[], options: UnityCliRunOptions = {}): Promise<{ exitCode: number; envelope: UnityCliEnvelope<T> | undefined; stdout: string; stderr: string }> {
        const result = await this.Run([...args, '--format', 'json'], { ...options, stream: false });
        const envelope = parseEnvelope<T>(result.stdout);
        // JSON results can carry account details and tokens (license activate, status), so the debug copy is sanitized
        this.logger.debug(`unity ${redactSensitiveLiterals(args.join(' '), options.redactLiterals)} [${result.exitCode}]:\n${SanitizeLogText(`${result.stdout}${stripHint(result.stderr)}`, options.redactLiterals)}`);
        return { exitCode: result.exitCode, envelope, stdout: result.stdout, stderr: result.stderr };
    }

    /**
     * Runs the CLI with `--format json` and returns `data`, throwing when the command fails.
     * @param args The arguments to pass to `unity`.
     * @param options Run options.
     */
    public async ExecJson<T = unknown>(args: string[], options: UnityCliRunOptions = {}): Promise<T> {
        const { exitCode, envelope, stdout, stderr } = await this.RunJson<T>(args, options);

        if (exitCode !== 0 || !envelope || envelope.success === false) {
            const errors = envelope?.errors?.map(e => `${e.code}: ${e.message}`).join('\n') || `${stdout}${stripHint(stderr)}`.trim();
            throw new Error(`unity ${redactSensitiveLiterals(args.join(' '), options.redactLiterals)} failed with exit code ${exitCode}\n${errors}`);
        }

        return envelope.data as T;
    }

    /** Gets the directory the CLI installs editors to. */
    public async GetInstallPath(): Promise<string> {
        const data = await this.ExecJson(['install-path', '--get']);
        const installPath = FindAbsolutePath(data);

        if (!installPath) {
            throw new Error(`Unable to read the editor install path from: ${JSON.stringify(data)}`);
        }

        return installPath;
    }

    /**
     * Sets the directory the CLI installs editors to.
     * @param installPath The directory to install editors to.
     */
    public async SetInstallPath(installPath: string): Promise<void> {
        await fs.promises.mkdir(installPath, { recursive: true });
        await this.Exec(['install-path', '--set', installPath]);
    }

    /**
     * Gets the path to the Unity.Licensing.Client the CLI manages, downloading it first if needed.
     * @returns The licensing client executable, or undefined when the CLI does not report one.
     */
    public async GetLicensingClientPath(): Promise<string | undefined> {
        // the first license command makes the CLI download the licensing client
        await this.RunJson(['license', 'list']);
        const { envelope } = await this.RunJson<{ externalComponents?: unknown }>(['doctor']);
        const components = envelope?.data?.externalComponents;
        const executableName = process.platform === 'win32' ? 'Unity.Licensing.Client.exe' : 'Unity.Licensing.Client';
        const candidates: string[] = [];
        collectStrings(components, candidates);

        for (const candidate of candidates) {
            if (!path.isAbsolute(candidate) || !candidate.toLowerCase().includes('licensing')) {
                continue;
            }

            const resolved = resolveLicensingClient(candidate, executableName);

            if (resolved) {
                return resolved;
            }
        }

        return undefined;
    }
}

/**
 * Finds the first absolute path in a CLI result, preferring well-known keys.
 * @param value A parsed CLI JSON value.
 */
export function FindAbsolutePath(value: unknown): string | undefined {
    const pathKeys = ['path', 'editorPath', 'installPath', 'location', 'directory', 'value'];

    if (typeof value === 'string') {
        return path.isAbsolute(value) ? value : undefined;
    }

    if (Array.isArray(value)) {
        for (const item of value) {
            const found = FindAbsolutePath(item);
            if (found) { return found; }
        }
        return undefined;
    }

    if (value && typeof value === 'object') {
        const record = value as { [key: string]: unknown };

        for (const key of pathKeys) {
            const found = FindAbsolutePath(record[key]);
            if (found) { return found; }
        }

        for (const [key, item] of Object.entries(record)) {
            if (key === 'errors' || key === 'warnings') { continue; }
            const found = FindAbsolutePath(item);
            if (found) { return found; }
        }
    }

    return undefined;
}

function parseEnvelope<T>(stdout: string): UnityCliEnvelope<T> | undefined {
    const trimmed = stdout.trim();

    if (trimmed.length === 0) {
        return undefined;
    }

    try {
        return JSON.parse(trimmed) as UnityCliEnvelope<T>;
    } catch {
        // fall back to the last line that parses, in case anything else was printed first
        const lines = trimmed.split(/\r?\n/).reverse();

        for (const line of lines) {
            try {
                const parsed = JSON.parse(line);
                if (parsed && typeof parsed === 'object' && 'success' in parsed) {
                    return parsed as UnityCliEnvelope<T>;
                }
            } catch {
                // keep looking
            }
        }
    }

    return undefined;
}

function stripHint(text: string): string {
    return text.split(/\r?\n/).filter(line => !line.includes('<claude-code-hint')).join('\n');
}

function collectStrings(value: unknown, results: string[]): void {
    if (typeof value === 'string') {
        results.push(value);
    } else if (Array.isArray(value)) {
        value.forEach(item => collectStrings(item, results));
    } else if (value && typeof value === 'object') {
        Object.values(value).forEach(item => collectStrings(item, results));
    }
}

function resolveLicensingClient(candidate: string, executableName: string): string | undefined {
    if (!fs.existsSync(candidate)) {
        return undefined;
    }

    if (fs.statSync(candidate).isFile()) {
        return path.basename(candidate) === executableName ? candidate : undefined;
    }

    const queue = [candidate];

    // the client sits a few folders down, e.g. licensingClient/<platform>/Unity.Licensing.Client
    for (let depth = 0; depth < 4 && queue.length > 0; depth++) {
        const next: string[] = [];

        for (const dir of queue) {
            const direct = path.join(dir, executableName);

            if (isExecutableFile(direct)) {
                return direct;
            }

            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                if (entry.isDirectory()) {
                    next.push(path.join(dir, entry.name));
                }
            }
        }

        queue.splice(0, queue.length, ...next);
    }

    return undefined;
}

async function getCliVersion(cliPath: string): Promise<string> {
    const cli = new UnityCli(cliPath, '');
    const { exitCode, stdout, stderr } = await cli.Run(['--version'], { timeoutMs: 60_000 });

    if (exitCode !== 0) {
        throw new Error(`${cliPath} --version failed with exit code ${exitCode}: ${stripHint(stderr).trim()}`);
    }

    // the official CLI prints only its version; another program named unity prints more, such as "unity 7.7.0"
    const lastLine = stdout.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0).pop() ?? '';
    const match = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(lastLine);

    if (!match || !match[1]) {
        throw new Error(`Unable to parse Unity CLI version from: ${stdout.trim()}`);
    }

    return match[1];
}

async function fetchManifest(version: string): Promise<UnityCliManifest> {
    const urls = version === 'latest'
        ? [`${CDN_BASE}latest.json`, `${CDN_BASE}latest-beta.json`]
        : [`${CDN_BASE}${version}/latest.json`];
    let lastError: unknown;

    for (const url of urls) {
        try {
            const manifest = JSON.parse(await HttpsGetText(url)) as UnityCliManifest;

            // the version becomes part of a cache path and a download URL
            if (typeof manifest.version !== 'string' || !VERSION_PATTERN.test(manifest.version)) {
                throw new Error(`Invalid version in ${url}: ${JSON.stringify(manifest.version)}`);
            }

            if (version !== 'latest' && manifest.version !== version) {
                throw new Error(`Manifest mismatch: requested ${version} but ${url} reports ${manifest.version}`);
            }

            return manifest;
        } catch (error) {
            lastError = error;
            Logger.instance.debug(`Failed to read ${url}: ${error}`);
        }
    }

    throw new Error(`Failed to find Unity CLI ${version}: ${lastError}`);
}

function normalizeVersion(version: string): string {
    const trimmed = version.trim();

    if (trimmed.toLowerCase() === 'latest') {
        return 'latest';
    }

    const normalized = trimmed.replace(/^v/i, '');

    if (!VERSION_PATTERN.test(normalized)) {
        throw new Error(`Invalid Unity CLI version: ${version}. Use an exact version such as 1.0.0-beta.14, or latest.`);
    }

    return normalized;
}

function getToolCacheRoot(): string {
    return process.env.RUNNER_TOOL_CACHE || path.join(os.homedir(), '.unity-cli', 'tools');
}

/** Same layout as @actions/tool-cache, so actions can find the CLI with tc.find('unity-cli', version). */
function getToolCachePath(version: string): string {
    return path.join(getToolCacheRoot(), TOOL_NAME, version, os.arch());
}

function findCachedExecutables(): string[] {
    const toolDir = path.join(getToolCacheRoot(), TOOL_NAME);

    if (!fs.existsSync(toolDir)) {
        return [];
    }

    // newest first by semver, so 1.0.0-beta.14 sorts ahead of 1.0.0-beta.9
    return fs.readdirSync(toolDir)
        .filter(version => valid(version) !== null && fs.existsSync(path.join(toolDir, version, `${os.arch()}.complete`)))
        .sort((a, b) => compareSemver(b, a))
        .map(version => path.join(toolDir, version, os.arch(), EXE_NAME));
}

/** The newest complete CLI in the tool cache that still runs, if any. */
async function findNewestCachedCli(): Promise<UnityCli | undefined> {
    for (const candidate of findCachedExecutables()) {
        if (!isExecutableFile(candidate)) {
            continue;
        }

        try {
            return new UnityCli(candidate, await getCliVersion(candidate));
        } catch (error) {
            Logger.instance.debug(`Skipping ${candidate}: ${error}`);
        }
    }

    return undefined;
}

function defaultInstallLocations(): string[] {
    if (process.platform === 'win32') {
        return [path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Unity', 'bin', EXE_NAME)];
    }

    return [
        path.join(os.homedir(), '.local', 'bin', EXE_NAME),
        path.join(os.homedir(), '.unity', 'bin', EXE_NAME),
    ];
}

function isExecutableFile(filePath: string): boolean {
    try {
        if (!fs.statSync(filePath).isFile()) {
            return false;
        }

        fs.accessSync(filePath, fs.constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

/** Keeps the CLI from prompting or updating itself mid-job. */
function configureEnvironment(): void {
    const vars: { [key: string]: string } = {
        UNITY_NON_INTERACTIVE: '1',
        UNITY_NO_UPDATE_CHECK: '1',
        UNITY_NO_CONSENT_PROMPT: '1',
        UNITY_NO_BANNER: '1',
        UNITY_NO_PAGER: '1',
    };

    for (const [name, value] of Object.entries(vars)) {
        if (!process.env[name]) {
            process.env[name] = value;
            Logger.instance.CI_setEnvironmentVariable(name, value);
        }
    }
}

function exportCli(cli: UnityCli): UnityCli {
    process.env.UNITY_CLI_PATH = cli.executable;
    process.env.UNITY_CLI_VERSION = cli.version;
    Logger.instance.CI_setEnvironmentVariable('UNITY_CLI_PATH', cli.executable);
    Logger.instance.CI_setEnvironmentVariable('UNITY_CLI_VERSION', cli.version);
    Logger.instance.CI_addPath(path.dirname(cli.executable));
    return cli;
}
