
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

    try {
        exitCode = await new Promise<number>((resolve, reject) => {
            if (command.includes(path.sep)) {
                fs.accessSync(command, fs.constants.R_OK | fs.constants.X_OK);
            }

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