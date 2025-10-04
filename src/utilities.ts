
import * as path from 'path';
import * as glob from 'glob';
import * as fs from 'fs';
import * as https from 'https';
import * as readline from 'readline';
import * as os from 'os';
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
    const paths: string[] = await glob.glob(globPath);

    for (const path of paths) {
        await fs.promises.access(path, fs.constants.R_OK);
        return path;
    }

    throw new Error(`No accessible file found for glob pattern: ${path.normalize(globPath)}`);
}

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
            process.stdout.write(prompt + '*'.repeat(input.length) + '\n');
            rl.close();
            console.log(); // Don't use logger. Move to next line after input.
            resolve(input);
        });
    });
}

export type ExecOptions = {
    silent?: boolean;
    showCommand?: boolean;
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

    if (mustShowCommand) {
        const commandStr = `\x1b[34m${command} ${args.join(' ')}\x1b[0m`;

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
                        output += `${line}\n`;

                        if (!isSilent) {
                            process.stdout.write(`${line}\n`);
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

                // Flush any remaining buffered content
                if (lineBuffer.length > 0) {
                    const lines = lineBuffer.split('\n') // split by newline
                        .map(line => line.replace(/\r$/, '')) // remove trailing carriage return
                        .filter(line => line.length > 0); // filter out empty lines

                    for (const line of lines) {
                        output += `${line}\n`;

                        if (!isSilent) {
                            process.stdout.write(`${line}\n`);
                        }
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
            throw new Error(`${command} failed with exit code ${exitCode}`);
        }
    }

    return output;
}

/**
 * Downloads a file from a URL to a specified path.
 * @param url The URL to download from.
 * @param downloadPath The path to save the downloaded file.
 * @throws An error if the download fails or the file is not accessible after download.
 */
export async function DownloadFile(url: string, downloadPath: string): Promise<void> {
    logger.ci(`Downloading from ${url} to ${downloadPath}...`);
    await fs.promises.mkdir(path.dirname(downloadPath), { recursive: true });
    await new Promise<void>((resolve, reject) => {
        const file = fs.createWriteStream(downloadPath, { mode: 0o755 });
        https.get(url, (response) => {
            response.pipe(file);
            file.on('finish', () => {
                file.close();
                resolve();
            });
        }).on('error', (error) => {
            fs.unlink(downloadPath, () => reject(`Download failed: ${error}`));
        });
    });
    // make sure the file is closed and accessible
    await new Promise((r) => setTimeout(r, 100));
    await fs.promises.access(downloadPath, fs.constants.R_OK | fs.constants.X_OK);
}

/**
 * Deletes a directory and its contents if it exists.
 * @param targetPath The path of the directory to delete.
 * @throws An error if the deletion fails.
 */
export async function DeleteDirectory(targetPath: string | undefined): Promise<void> {
    logger.debug(`Attempting to delete directory: ${targetPath}...`);
    if (targetPath && targetPath.length > 0 && fs.existsSync(targetPath)) {
        await fs.promises.rm(targetPath, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
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

async function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
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

        await delay(5000); // wait 5 seconds

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
                const command = `taskkill /PID ${procInfo.pid} /F /T`;
                await Exec('powershell', ['-Command', command], { silent: true, showCommand: false });
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
            await Exec('powershell', ['-Command', command], { silent: true, showCommand: true });
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