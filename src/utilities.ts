import * as crypto from 'crypto';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as readline from 'readline';
import { glob } from 'glob';
import { spawn } from 'child_process';
import { Logger, LogLevel } from './logging';

const logger = Logger.instance;

/**
 * Resolves a glob pattern to this first file path that matches it.
 * @param globs An array of path segments that may include glob patterns.
 * @returns The first matching file path.
 */
export async function ResolveGlobToPath(globs: string[]): Promise<string> {
    const globPath: string = path.join(...globs).split(path.sep).join('/');
    const paths: string[] = await glob(globPath);

    for (const path of paths) {
        await fs.promises.access(path, fs.constants.R_OK);
        return path;
    }

    throw new Error(`No accessible file found for glob pattern: ${path.normalize(globPath)}`);
}

/**
 * Resolves a list of glob patterns to the first matching file path.
 * @param globsList A list of arrays of path segments that may include glob patterns.
 * @returns The first matching file path, or undefined if none found.
 */
export async function ResolvePathCandidates(globsList: string[][]): Promise<string | undefined> {
    for (const globPath of globsList) {
        try {
            return await ResolveGlobToPath(globPath);
        } catch (error) {
            const joinedPath = path.join(...globPath);
            logger.debug(`Failed to resolve sdkmanager using glob: ${joinedPath}`);
        }
    }

    return undefined;
}

/**
 * Prompts the user for input, masking the input with asterisks.
 * @param prompt The prompt message to display.
 * @returns The user input as a string.
 */
export async function PromptForSecretInput(prompt: string): Promise<string> {
    return new Promise<string>((resolve) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            terminal: true
        });

        rl.question(prompt, (input) => {
            // mask the previous line with asterisks in place of each character
            readline.moveCursor(process.stdout, 0, -1);
            readline.clearLine(process.stdout, 0);
            process.stdout.write(`${prompt + '*'.repeat(input.length)}\n`);
            rl.close();
            resolve(input);
        });
    });
}

/**
 * Prompts for y/n. Empty input uses `defaultYes` (Y/n vs y/N suffix).
 */
export async function PromptYesNo(prompt: string, defaultYes: boolean): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });
        const hint = defaultYes ? ' [Y/n]: ' : ' [y/N]: ';
        rl.question(`${prompt}${hint}`, (input) => {
            rl.close();
            const a = input.trim().toLowerCase();
            if (a.length === 0) {
                resolve(defaultYes);
                return;
            }
            resolve(a === 'y' || a === 'yes');
        });
    });
}

/**
 * True when stdin and stdout are TTYs and the process is not running under CI.
 * Use before interactive prompts (readline).
 */
export function isInteractiveTerminalSession(): boolean {
    return (
        process.stdin.isTTY === true &&
        process.stdout.isTTY === true &&
        process.env.CI !== 'true'
    );
}

/**
 * True when {@link process.stdout} is a TTY and the process is not running under CI.
 * Use for terminal-only output (e.g. live tables, ANSI) that does not read from stdin.
 * This is not the same as {@link isInteractiveTerminalSession} (which also requires a TTY on stdin for prompts).
 */
export function isStdoutTTY(): boolean {
    return process.stdout.isTTY === true && process.env.CI !== 'true';
}

export type ExecOptions = {
    silent?: boolean;
    showCommand?: boolean;
    /**
     * Substrings replaced with `*****` in streamed lines, captured output, and the logged command line.
     * Only values with length >= 4 are applied (avoids noisy replacements). Longer literals are applied first.
     */
    redactLiterals?: readonly string[];
}

/** Dedupes, trims, drops short values, longest-first (so one secret cannot leak via another). */
export function orderedRedactionSecrets(literals: readonly string[] | undefined): string[] {
    if (!literals || literals.length === 0) {
        return [];
    }
    const seen = new Set<string>();
    for (const raw of literals) {
        const s = raw.trim();
        if (s.length >= 4) {
            seen.add(s);
        }
    }
    return [...seen].sort((a, b) => b.length - a.length);
}

/** Replaces each configured literal with `*****` everywhere it appears in `text`. */
export function redactSensitiveLiterals(text: string, literals: readonly string[] | undefined): string {
    const secrets = orderedRedactionSecrets(literals);
    if (secrets.length === 0 || text.length === 0) {
        return text;
    }
    let result = text;
    for (const sec of secrets) {
        if (result.includes(sec)) {
            result = result.split(sec).join('*****');
        }
    }
    return result;
}

/**
 * Executes a command with arguments and options.
 * @param command The command to execute.
 * @param args The arguments for the command.
 * @param options Options for the execution. `silent` controls console output, `showCommand` controls if the command is logged. If LogLevel is DEBUG, both are overridden to show command and not be silent.
 * @returns The output of the command.
 * @throws An error if the command returns a non-zero exit code.
 */
export async function Exec(command: string, args: string[], options: ExecOptions = { silent: false, showCommand: true }): Promise<string> {
    let output: string = '';
    let exitCode: number = 0;

    const isDebug = logger.logLevel === LogLevel.DEBUG;
    const isSilent = isDebug ? false : options.silent ? options.silent : false;
    const mustShowCommand = isDebug ? true : options.showCommand ? options.showCommand : false;
    const redactionSecrets = orderedRedactionSecrets(options.redactLiterals);
    const redact = (text: string): string =>
        redactionSecrets.length === 0 ? text : redactSensitiveLiterals(text, redactionSecrets);

    if (mustShowCommand) {
        const commandStr = redact(`\x1b[34m${command} ${args.join(' ')}\x1b[0m`);

        if (isSilent) {
            logger.info(commandStr);
        } else {
            logger.startGroup(commandStr);
        }
    }

    if (command.includes(path.sep)) {
        fs.accessSync(command, fs.constants.R_OK | fs.constants.X_OK);
    }

    try {
        exitCode = await new Promise<number>((resolve, reject) => {
            const child = spawn(command, args, {
                env: process.env,
                stdio: ['ignore', 'pipe', 'pipe'],
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

            let lineBuffer = ''; // Buffer for incomplete lines
            function processOutput(data: Buffer) {
                try {
                    const chunk = data.toString();
                    const fullChunk = lineBuffer + chunk;
                    const lines = fullChunk.split('\n') // split by newline
                        .map(line => line.replace(/\r$/, '')) // remove trailing carriage return
                        .filter(line => line.length > 0); // filter out empty lines

                    if (!chunk.endsWith('\n')) {
                        lineBuffer = lines.pop() || '';
                    } else {
                        lineBuffer = '';
                    }

                    for (const line of lines) {
                        const safeLine = redact(line);
                        output += `${safeLine}\n`;

                        if (!isSilent) {
                            process.stdout.write(`${safeLine}\n`);
                        }
                    }
                } catch (error: any) {
                    if (error.code !== 'EPIPE') {
                        throw error;
                    }
                }
            }

            child.stdout.on('data', processOutput);
            child.stderr.on('data', processOutput);
            child.on('error', (error) => {
                removeListeners();
                reject(error);
            });
            child.on('close', (code) => {
                removeListeners();

                try {
                    // Flush any remaining buffered content
                    if (lineBuffer.length > 0) {
                        const lines = lineBuffer.split('\n') // split by newline
                            .map(line => line.replace(/\r$/, '')) // remove trailing carriage return
                            .filter(line => line.length > 0); // filter out empty lines

                        for (const line of lines) {
                            const safeLine = redact(line);
                            output += `${safeLine}\n`;

                            if (!isSilent) {
                                process.stdout.write(`${safeLine}\n`);
                            }
                        }
                    }
                } catch (error: any) {
                    if (error.code !== 'EPIPE') {
                        logger.error(`Error while flushing output: ${error}`);
                    }
                }

                resolve(code === null ? 0 : code);
            });
        });
    } finally {
        if (mustShowCommand) {
            if (!isSilent) {
                logger.endGroup();
            }
        }

        if (exitCode !== 0) {
            const tail = isSilent && output.length > 0 ? `\n${output}` : '';
            throw new Error(`${command} failed with exit code ${exitCode}${tail}`);
        }
    }

    return output;
}

/**
 * Confines archive extraction paths before spawning tools (mitigates CodeQL `js/shell-command-constructed-from-input`).
 * Both paths must resolve under the given roots (e.g. temp download dir and managed UPM root).
 */
export interface ZipExtractPathTrust {
    /** Directory tree that must contain `zipPath` (e.g. resolved temp root for this download). */
    zipUnder: string;
    /** Directory tree that must contain `destDir` (e.g. managed `~/.unity-cli/upm`). */
    destUnder: string;
}

function assertResolvedPathUnderRoot(candidate: string, root: string, label: string): void {
    const resolved = path.resolve(candidate);
    const resolvedRoot = path.resolve(root);
    const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
    if (resolved !== resolvedRoot && !resolved.startsWith(prefix)) {
        throw new Error(`${label}: path is outside permitted root (${root}): ${candidate}`);
    }
}

/**
 * Extracts a zip archive using only OS tools (`tar` or PowerShell on Windows, `unzip` on macOS/Linux).
 * Does not use a Node unzip library.
 */
export async function extractZipNative(
    zipPath: string,
    destDir: string,
    pathTrust: ZipExtractPathTrust,
    execOptions?: ExecOptions
): Promise<void> {
    assertResolvedPathUnderRoot(zipPath, pathTrust.zipUnder, 'extractZipNative zipPath');
    assertResolvedPathUnderRoot(destDir, pathTrust.destUnder, 'extractZipNative destDir');
    await fs.promises.mkdir(destDir, { recursive: true });
    const silent = execOptions?.silent ?? true;
    const show = execOptions?.showCommand ?? false;

    if (process.platform === 'win32') {
        try {
            await Exec('tar', [
                '-xf',
                zipPath,
                '-C',
                destDir
            ], {
                silent,
                showCommand: show
            });
        } catch {
            const scriptBody =
                'param([Parameter(Mandatory=$true)][string]$ZipPath,[Parameter(Mandatory=$true)][string]$DestPath)\n' +
                '$ErrorActionPreference = "Stop"\n' +
                'Expand-Archive -LiteralPath $ZipPath -DestinationPath $DestPath -Force\n';
            const tmpDir = await fs.promises.mkdtemp(path.join(GetTempDir(), 'unity-cli-expand-zip-'));
            const scriptPath = path.join(tmpDir, 'Expand-Archive.ps1');
            try {
                await fs.promises.writeFile(scriptPath, scriptBody, 'utf8');
                await Exec('powershell.exe', [
                    '-NoProfile',
                    '-NonInteractive',
                    '-File',
                    scriptPath,
                    zipPath,
                    destDir,
                ], {
                    silent,
                    showCommand: show,
                });
            } finally {
                await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
            }
        }
    } else {
        await Exec('unzip', [
            '-o',
            '-q',
            zipPath,
            '-d',
            destDir
        ], {
            silent,
            showCommand: show
        });
    }
}

/**
 * GET an HTTPS URL and return the response body as UTF-8 text (trimmed).
 * @throws If the response status is not 200 or the request fails.
 */
export async function HttpsGetText(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
        https.get(url, (response) => {
            if (response.statusCode !== 200) {
                reject(new Error(`GET ${url} failed: HTTP ${response.statusCode}`));
                response.resume();
                return;
            }
            const chunks: Buffer[] = [];
            response.on('data', (c: Buffer) => chunks.push(c));
            response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8').trim()));
        }).on('error', reject);
    });
}

/**
 * Computes the SHA-256 digest of a file as a lowercase hex string.
 */
export async function Sha256FileHex(filePath: string): Promise<string> {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    return new Promise((resolve, reject) => {
        stream.on('data', (chunk: string | Buffer) => {
            hash.update(chunk);
        });
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}

/**
 * Downloads a file from a URL to a specified path.
 * Requires HTTP status 200 before writing. Verifies the file is readable after download.
 * @param url The URL to download from.
 * @param downloadPath The path to save the downloaded file.
 * @throws An error if the download fails or the file is not accessible after download.
 */
export async function DownloadFile(url: string, downloadPath: string): Promise<void> {
    logger.ci(`Downloading from ${url} to ${downloadPath}...`);
    await fs.promises.mkdir(path.dirname(downloadPath), { recursive: true });
    await new Promise<void>((resolve, reject) => {
        https.get(url, (response) => {
            if (response.statusCode !== 200) {
                response.resume();
                reject(new Error(`GET ${url} failed: HTTP ${response.statusCode}`));
                return;
            }
            const file = fs.createWriteStream(downloadPath, { mode: 0o755 });
            const fail = (err: Error) => {
                file.destroy();
                void fs.promises.unlink(downloadPath).catch(() => undefined);
                reject(err);
            };
            response.once('error', fail);
            file.once('error', fail);
            response.pipe(file);
            file.on('finish', () => {
                file.close(() => resolve());
            });
        }).on('error', (error) => {
            void fs.promises.unlink(downloadPath).catch(() => undefined);
            reject(error);
        });
    });

    await new Promise((r) => setTimeout(r, 100));
    await fs.promises.access(downloadPath, fs.constants.R_OK);
}

/**
 * Deletes a directory and its contents if it exists.
 * @param targetPath The path of the directory to delete.
 * @throws An error if the deletion fails.
 */
export async function DeleteDirectory(targetPath: string | undefined): Promise<void> {
    if (targetPath && targetPath.length > 0 && fs.existsSync(targetPath)) {
        logger.debug(`Attempting to delete directory: ${targetPath}...`);
        try {
            await fs.promises.rm(targetPath, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
        } catch (error) {
            logger.warn(`Failed to delete directory: ${targetPath}\n${error}`);
        }
    }
}

/**
 * Reads the contents of a file.
 * @param filePath The path of the file to read.
 * @returns The contents of the file as a string.
 * @throws An error if the file cannot be read.
 */
export async function ReadFileContents(filePath: string): Promise<string> {
    const fileHandle = await fs.promises.open(filePath, 'r');
    try {
        const projectSettingsContent = await fileHandle.readFile('utf8');
        return projectSettingsContent;
    } finally {
        await fileHandle.close();
    }
}

/**
 * Gets the path to a temporary directory.
 * @returns The path to a temporary directory.
 * @remarks Falls back to the system temp directory if no environment variables are set.
 */
export function GetTempDir(): string {
    if (process.env['RUNNER_TEMP']) {
        return process.env['RUNNER_TEMP']!;
    } else if (process.env['TMPDIR']) {
        return process.env['TMPDIR']!;
    } else if (process.env['TEMP']) {
        return process.env['TEMP']!;
    } else if (process.env['TMP']) {
        return process.env['TMP']!;
    }
    // fallback to current directory
    return os.tmpdir();
}

/**
 * Get the value of a command line argument.
 * @param value The name of the argument to retrieve.
 * @param args The list of command line arguments.
 * @returns The value of the argument or an error if not found.
 */
export function GetArgumentValueAsString(value: string, args: string[]): string {
    const index = args.indexOf(value);

    if (index === -1 || index === args.length - 1) {
        throw Error(`Missing ${value} argument`);
    }

    return args[index + 1] as string;
}

export interface ProcInfo {
    pid: number;
    ppid: number;
    name: string;
}

/**
 * Reads a PID file and returns the process information.
 * @param pidFilePath The path to the PID file.
 * @returns The process information, or undefined if the file does not exist or cannot be read.
 * @remarks The PID file is deleted after reading.
 */
export async function ReadPidFile(pidFilePath: string): Promise<ProcInfo | undefined> {
    let procInfo: ProcInfo | undefined;
    try {
        if (!fs.existsSync(pidFilePath)) {
            logger.debug(`PID file does not exist: ${pidFilePath}`);
            return procInfo;
        }

        const fileHandle = await fs.promises.open(pidFilePath, 'r');
        try {
            const pid = parseInt(await fileHandle.readFile('utf8'));

            if (isNaN(pid)) {
                logger.error(`Invalid PID in file: ${pidFilePath}`);
                return procInfo;
            }

            procInfo = { pid, ppid: 0, name: '' };
        } catch (error) {
            logger.error(`Failed to read PID file: ${pidFilePath}\n${error}`);
        } finally {
            await fileHandle.close();
            await fs.promises.unlink(pidFilePath);
        }
    } catch (error) {
        // ignored
    }

    return procInfo;
}

/**
 * Delays execution for a specified number of milliseconds.
 * @param ms The number of milliseconds to delay.
 * @returns A promise that resolves after the delay.
 */
export async function Delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Waits for a file to be unlocked (not exclusively locked by another process).
 * If the file does not exist, it is considered unlocked.
 * If the file exists, attempts to open it with read/write access.
 * @param filePath The path of the file to wait for.
 * @param timeout The maximum time to wait in milliseconds. Default is 30000 (30 seconds).
 * @returns A promise that resolves when the file is unlocked.
 */
export async function WaitForFileToBeUnlocked(filePath: string, timeout: number = 30000): Promise<void> {
    const pollInterval = 100;
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
        // test file access by attempting to open the file with read/write access
        if (await TestFileAccess(filePath, fs.constants.O_RDWR)) {
            return;
        }

        await Delay(pollInterval);
    }

    throw new Error(`Timed out after ${timeout / 1000} seconds waiting for file to be unlocked: ${filePath}`);
}

/**
 * Tests if a file can be opened with the specified flags.
 * @remarks If the file does not exist, it returns false.
 * @param filePath The path of the file to test.
 * @param flags The flags to use when opening the file (e.g., fs.constants.O_RDONLY).
 * @returns A promise that resolves to true if the file can be opened, false otherwise.
 */
export async function TestFileAccess(filePath: string, flags: number): Promise<boolean> {
    // expect the file to be visible and accessible
    try {
        await fs.promises.access(filePath, fs.constants.F_OK);
    } catch (error) {
        return false;
    }

    let fh: fs.promises.FileHandle | undefined;

    // try to open the file with the specified flags
    try {
        fh = await fs.promises.open(filePath, flags);
        return true;
    } catch (error: any) {
        const code = error && error.code ? error.code : null;
        // These codes indicate the file is temporarily inaccessible (locked/permission) or missing.
        if (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY' || code === 'ETXTBSY' || code === 'ENOENT') {
            return false;
        }
        // Unexpected error, rethrow
        throw error;
    } finally {
        await fh?.close();
    }
}

/**
 * Attempts to kill a process with the given ProcInfo.
 * Escalates to SIGKILL or taskkill if the process does not exit after 5 seconds.
 * @param procInfo The process information containing the PID.
 * @param signal The signal to use for killing the process. Defaults to 'SIGTERM'.
 */
export async function KillProcess(procInfo: ProcInfo, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    try {
        logger.debug(`Killing process [${procInfo.pid}] ${procInfo.name}...`);
        process.kill(procInfo.pid, signal);

        // Immediately check if the process has exited
        try {
            process.kill(procInfo.pid, 0);
        } catch {
            logger.debug(`Process [${procInfo.pid}] ${procInfo.name} has exited successfully.`);
            return; // Process has exited
        }

        await Delay(5000); // wait 5 seconds

        try {
            // Check if the process is still running
            process.kill(procInfo.pid, 0);
        } catch {
            logger.debug(`Process [${procInfo.pid}] ${procInfo.name} has exited successfully.`);
            return; // Process has exited
        }

        // If the process is still running, escalate to SIGKILL or taskkill to force quit.
        logger.debug(`Process [${procInfo.pid}] ${procInfo.name} did not exit after ${signal}, attempting to force quit...`);

        try {
            if (process.platform === 'win32') {
                await Exec('taskkill', ['/PID', procInfo.pid.toString(), '/F', '/T'], { silent: true, showCommand: false });
            } else { // linux and macos
                process.kill(procInfo.pid, 'SIGKILL');
            }
        } catch (error: NodeJS.ErrnoException | any) {
            if (error.code !== 'ENOENT' && error.code !== 'ESRCH') {
                logger.error(`Failed to kill process:\n${JSON.stringify(error)}`);
                throw error;
            }
        }
    } catch (error: NodeJS.ErrnoException | any) {
        if (error.code !== 'ENOENT' && error.code !== 'ESRCH') {
            logger.error(`Failed to kill process:\n${JSON.stringify(error)}`);
            throw error;
        }
    }
}

/**
 * Kills all child processes of the given process.
 * @param procInfo The process information of the parent process.
 */
export async function KillChildProcesses(procInfo: ProcInfo): Promise<void> {
    logger.debug(`Killing child processes of [${procInfo.pid}] ${procInfo.name}...`);
    try {
        if (process.platform === 'win32') {
            const command = `Get-CimInstance Win32_Process -Filter "ParentProcessId=${procInfo.pid}" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`;
            await Exec('powershell', [
                '-NoProfile',
                '-Command',
                command
            ], { silent: true, showCommand: false });
        } else { // linux and macos
            const psOutput = await Exec('ps', ['-eo', 'pid,ppid,comm'], { silent: true, showCommand: false });
            const lines = psOutput.split('\n').slice(1); // Skip header line
            const killPromises: Promise<void>[] = [];

            for (const line of lines) {
                const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);

                if (match) {
                    const pid: number = parseInt(match[1]!, 10);
                    const ppid: number = parseInt(match[2]!, 10);
                    const name: string = match[3]!.trim();

                    if (ppid === procInfo.pid) {
                        killPromises.push(KillProcess({ pid, ppid, name }));
                    }
                }
            }

            await Promise.all(killPromises);
        }
    } catch (error) {
        logger.error(`Failed to kill child processes of pid ${procInfo.pid}:\n${JSON.stringify(error)}`);
    }
}

/**
 * Checks if the current process is running with elevated (administrator) privileges.
 * @returns True if the process is elevated, false otherwise.
 */
export async function isProcessElevated(): Promise<boolean> {
    if (process.platform !== 'win32') { return true; } // We can sudo easily on non-windows platforms
    const output = await Exec('powershell', [
        '-NoLogo', '-NoProfile', '-Command',
        "(New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"
    ], { silent: true, showCommand: false });
    return output.trim().toLowerCase() === 'true';
}

export function tryParseJson(content: string | undefined): string | undefined {
    if (!content) {
        return undefined;
    }

    try {
        JSON.parse(content);
        return content;
    } catch {
        return undefined;
    }
}