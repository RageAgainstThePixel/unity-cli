
import * as path from 'path';
import * as glob from 'glob';
import * as fs from 'fs';
import * as https from 'https';
import * as readline from 'readline';
import * as os from 'os';
import { spawn } from 'child_process';
import { Logger } from './logging';

const logger = Logger.instance;

/**
 * Resolves a glob pattern to this first file path that matches it.
 * @param globs An array of path segments that may include glob patterns.
 * @returns The first matching file path.
 */
export async function ResolveGlobToPath(globs: string[]): Promise<string> {
    const globPath: string = path.join(...globs).split(path.sep).join('/');
    // logger.debug(`glob: ${globPath}`);
    const paths: string[] = await glob.glob(globPath);

    // logger.debug(`Resolved "${globPath}" to ${paths.length} paths:\n  > ${paths.join('\n  > ')}`);

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

export async function Exec(command: string, args: string[], options: ExecOptions = { silent: false, showCommand: true }): Promise<string> {
    let output: string = '';
    let exitCode: number = 0;

    function processOutput(data: Buffer) {
        const chunk = data.toString();
        output += chunk;

        if (!options.silent) {
            process.stdout.write(chunk);
        }
    }

    if (options.showCommand) {
        logger.startGroup(`\x1b[34m${command} ${args.join(' ')}\x1b[0m`);
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

            child.stdout.on('data', processOutput);
            child.stderr.on('data', processOutput);

            child.on('error', (error) => {
                reject(error);
            });

            child.on('close', (code) => {
                process.stdout.write('\n');
                resolve(code === null ? 0 : code);
            });
        });
    } finally {
        if (options.showCommand) {
            logger.endGroup();
        }
        if (exitCode !== 0) {
            throw new Error(`${command} failed with exit code ${exitCode}`);
        }
    }

    return output;
}

export async function DownloadFile(url: string, downloadPath: string): Promise<void> {
    logger.debug(`Downloading from ${url} to ${downloadPath}...`);
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
    await fs.promises.access(downloadPath, fs.constants.R_OK | fs.constants.X_OK);
}

export async function DeleteDirectory(targetPath: string | undefined): Promise<void> {
    logger.debug(`Attempting to delete directory: ${targetPath}...`);
    if (targetPath && targetPath.length > 0 && fs.existsSync(targetPath)) {
        await fs.promises.rm(targetPath, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
    }
}

export async function ReadFileContents(filePath: string): Promise<string> {
    const fileHandle = await fs.promises.open(filePath, 'r');
    try {
        const projectSettingsContent = await fileHandle.readFile('utf8');
        return projectSettingsContent;
    } finally {
        await fileHandle.close();
    }
}

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
export function getArgumentValue(value: string, args: string[]): string | undefined {
    const index = args.indexOf(value);
    if (index === -1 || index === args.length - 1) {
        throw Error(`Missing ${value} argument`);
    }
    return args[index + 1];
}

export interface ProcInfo {
    pid: number;
    ppid: number;
    name: string;
}

/**
 * Attempts to kill a process with the given PID read from a PID file.
 * @param pidFilePath The path to the PID file.
 * @returns The PID of the killed process, or null if no process was killed.
 */
export async function tryKillPid(pidFilePath: string): Promise<number | null> {
    let pid: number | null = null;
    try {
        if (!fs.existsSync(pidFilePath)) {
            logger.debug(`PID file does not exist: ${pidFilePath}`);
            return null;
        }
        const fileHandle = await fs.promises.open(pidFilePath, 'r');
        try {
            pid = parseInt(await fileHandle.readFile('utf8'));
            logger.debug(`Killing process pid: ${pid}`);
            process.kill(pid);
        } catch (error) {
            const nodeJsException = error as NodeJS.ErrnoException;
            const errorCode = nodeJsException?.code;
            if (errorCode !== 'ENOENT' && errorCode !== 'ESRCH') {
                logger.error(`Failed to kill process:\n${JSON.stringify(error)}`);
            }
        } finally {
            await fileHandle.close();
            await fs.promises.unlink(pidFilePath);
        }

    } catch (error) {
        // ignored
    }
    return pid;
}