
import * as path from 'path';
import * as glob from 'glob';
import * as fs from 'fs';
import * as https from 'https';
import * as readline from 'readline';
import { spawn } from 'child_process';

export async function ResolveGlobPath(globs: string[]): Promise<string> {
    const globPath: string = path.join(...globs).split(path.sep).join('/');
    const files: string[] = await glob.glob(globPath, { nodir: true });

    for (const file of files) {
        await fs.promises.access(file, fs.constants.R_OK);
        return file;
    }

    throw new Error(`No accessible file found for glob pattern: ${globPath}`);
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
            console.log(); // Move to next line after input
            resolve(input);
        });
    });
}

export async function Exec(command: string, args: string[]): Promise<string> {
    let output: string = '';
    let exitCode: number = 0;

    try {
        exitCode = await new Promise<number>((resolve, reject) => {
            const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });

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
            throw new Error(`${command} failed with exit code ${exitCode}`);
        }
    }

    return output;
}

export async function DownloadFile(url: string, downloadPath: string): Promise<void> {
    console.log(`Downloading from ${url} to ${downloadPath}`);
    await new Promise<void>((resolve, reject) => {
        const file = fs.createWriteStream(downloadPath);
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