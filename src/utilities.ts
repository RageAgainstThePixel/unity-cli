
import * as path from 'path';
import * as glob from 'glob';
import * as fs from 'fs';
import * as readline from 'readline';

export async function ResolveGlobPath(globs: string[]): Promise<string> {
    const globPath: string = path.join(...globs).split(path.sep).join('/');
    const files: string[] = await glob.glob(globPath, { nodir: true });

    for (const file of files) {
        await fs.promises.access(file, fs.constants.R_OK);
        return file;
    }

    throw new Error(`No accessible file found for glob pattern: ${globPath}`);
}

export async function promptForSecretInput(prompt: string): Promise<string> {
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