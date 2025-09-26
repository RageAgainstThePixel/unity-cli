import * as fs from 'fs';
import * as path from 'path';
import { Logger } from './logging';
import {
    getArgumentValueAsString,
    killChildProcesses,
    ProcInfo,
    tryKillProcess
} from './utilities';
import {
    spawn,
    ChildProcessByStdio,
} from 'child_process';

export interface EditorCommand {
    args: string[];
    projectPath?: string;
}

export class UnityEditor {
    public editorRootPath: string;

    private procInfo: ProcInfo | undefined;
    private pidFile: string;
    private logger: Logger = Logger.instance;
    private autoAddNoGraphics: boolean;

    constructor(public editorPath: string) {
        if (!fs.existsSync(editorPath)) {
            throw new Error(`The Unity Editor path does not exist: ${editorPath}`);
        }

        fs.accessSync(editorPath, fs.constants.X_OK);
        this.editorRootPath = UnityEditor.GetEditorRootPath(editorPath);
        this.pidFile = path.join(process.env.RUNNER_TEMP || process.env.USERPROFILE || '.', '.unity', 'unity-editor-process-id.txt');

        const match = editorPath.match(/(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)/);

        if (!match) {
            throw Error(`Invalid Unity Editor Path: ${editorPath}`);
        }

        const unityMajorVersion = match.groups?.major;

        if (!unityMajorVersion) {
            throw Error(`Invalid Unity Major Version: ${editorPath}`);
        }

        this.autoAddNoGraphics = parseInt(unityMajorVersion, 10) > 2018;
    }

    /**
     * Get the full path to a Unity project template based on the provided template name or regex pattern.
     * @param template The name or regex pattern of the template to find.
     * @returns The full path to the matching template file.
     * @throws Error if the template directory does not exist, no templates are found, or no matching template is found.
     */
    public GetTemplatePath(template: string): string {
        let templateDir: string;
        let editorRoot = path.dirname(this.editorPath);

        if (process.platform === 'darwin') {
            templateDir = path.join(path.dirname(editorRoot), 'Resources', 'PackageManager', 'ProjectTemplates');
        } else {
            templateDir = path.join(editorRoot, 'Data', 'Resources', 'PackageManager', 'ProjectTemplates');
        }

        // Check if the template directory exists
        if (!fs.existsSync(templateDir) ||
            !fs.statSync(templateDir).isDirectory()) {
            throw new Error(`Template directory not found: ${templateDir}`);
        }

        // Find all .tgz files in the template directory
        const files = fs.readdirSync(templateDir)
            .filter(f => f.endsWith('.tgz'))
            .map(f => path.join(templateDir, f));

        if (files.length === 0) {
            throw new Error(`No templates found in ${templateDir}`);
        }

        this.logger.ci(`Available templates:`);
        files.forEach(f => this.logger.ci(`  > ${path.basename(f)}`));

        // Build a regex to match the template name and version (e.g., com.unity.template.3d.*[0-9]+\.[0-9]+\.[0-9]+\.tgz)
        // Accepts either a full regex or a simple string
        let regex: RegExp;
        try {
            regex = new RegExp(template + ".*[0-9]+\\.[0-9]+\\.[0-9]+\\.tgz");
        } catch (e) {
            throw new Error(`Invalid template regex: ${template}`);
        }

        // Filter files by regex
        const matches = files.filter(f => regex.test(path.basename(f)));

        if (matches.length === 0) {
            throw new Error(`${template} path not found in ${templateDir}!`);
        }

        // Pick the longest match (as in the shell script: sort by length descending)
        matches.sort((a, b) => b.length - a.length);
        const templatePath = matches[0];

        if (!templatePath) {
            throw new Error('No matching template path found.');
        }

        return path.normalize(templatePath);
    }

    public async Run(command: EditorCommand): Promise<void> {
        let isCancelled = false;
        const onCancel = async () => {
            isCancelled = true;
            await this.tryKillEditorProcess();
        };
        process.once('SIGINT', onCancel);
        process.once('SIGTERM', onCancel);
        let exitCode: number | undefined;
        try {
            this.logger.info(`[command]"${this.editorPath}" ${command.args.join(' ')}`);
            exitCode = await this.exec(command, pInfo => { this.procInfo = pInfo; });
        } catch (error) {
            if (error instanceof Error) {
                this.logger.error(error.toString());
            }

            if (!exitCode) {
                exitCode = 1;
            }
        } finally {
            if (!isCancelled) {
                await this.tryKillEditorProcess();

                if (exitCode !== 0) {
                    throw Error(`Unity failed with exit code ${exitCode}`);
                }
            }
        }
    }

    private async exec(command: EditorCommand, onPid: (pid: ProcInfo) => void): Promise<number> {
        if (!command.args || command.args.length === 0) {
            throw Error('No command arguments provided for Unity execution');
        }

        if (!command.args.includes(`-automated`)) {
            command.args.push(`-automated`);
        }

        if (!command.args.includes(`-batchmode`)) {
            command.args.push(`-batchmode`);
        }

        if (this.autoAddNoGraphics &&
            !command.args.includes(`-nographics`) &&
            !command.args.includes(`-force-graphics`)) {
            command.args.push(`-nographics`);
        }

        if (!command.args.includes('-logFile')) {
            const logsDir = command.projectPath !== undefined
                ? path.join(command.projectPath, 'Builds', 'Logs')
                : path.join(process.env.GITHUB_WORKSPACE || process.cwd(), 'Logs');

            try {
                await fs.promises.access(logsDir, fs.constants.R_OK);
            } catch (error) {
                this.logger.debug(`Creating Logs Directory:\n  > "${logsDir}"`);
                await fs.promises.mkdir(logsDir, { recursive: true });
            }

            const timestamp = new Date().toISOString().replace(/[-:]/g, ``).replace(/\..+/, ``);
            const generatedLogPath = path.join(logsDir, `Unity-${timestamp}.log`);
            this.logger.debug(`Log File Path:\n  > "${generatedLogPath}"`);
            command.args.push('-logFile', generatedLogPath);
        }

        const logPath: string = getArgumentValueAsString('-logFile', command.args);

        let unityProcess: ChildProcessByStdio<null, null, null>;

        if (process.platform === 'linux' && !command.args.includes('-nographics')) {
            unityProcess = spawn(
                'xvfb-run',
                [this.editorPath, ...command.args], {
                stdio: ['ignore', 'ignore', 'ignore'],
                detached: true,
                env: {
                    ...process.env,
                    DISPLAY: ':99',
                    UNITY_THISISABUILDMACHINE: '1'
                }
            });
        } else {
            unityProcess = spawn(
                this.editorPath,
                command.args, {
                stdio: ['ignore', 'ignore', 'ignore'],
                detached: true,
                env: {
                    ...process.env,
                    UNITY_THISISABUILDMACHINE: '1'
                }
            });
        }

        const processId = unityProcess.pid;

        if (!processId) {
            throw new Error('Failed to start Unity process!');
        }

        onPid({ pid: processId, ppid: process.pid, name: this.editorPath });
        this.logger.debug(`Unity process started with pid: ${processId}`);
        // make sure the directory for the PID file exists
        const pidDir = path.dirname(this.pidFile);

        if (!fs.existsSync(pidDir)) {
            fs.mkdirSync(pidDir, { recursive: true });
        } else {
            try {
                await fs.promises.access(this.pidFile, fs.constants.R_OK | fs.constants.W_OK);
                if (this.procInfo) {
                    const killedPid = await tryKillProcess(this.procInfo);
                    if (killedPid) {
                        this.logger.warn(`Killed existing Unity process with pid: ${killedPid}`);
                    }
                }
            } catch {
                // PID file does not exist, continue
            }
        }
        // Write the PID to the PID file
        fs.writeFileSync(this.pidFile, String(processId));
        const logPollingInterval = 100; // milliseconds
        // Wait for log file to appear
        while (!fs.existsSync(logPath)) {
            await new Promise(res => setTimeout(res, logPollingInterval));
        }
        // Start tailing the log file
        let lastSize = 0;
        let logEnded = false;

        const tailLog = async () => {
            while (!logEnded) {
                try {
                    const stats = fs.statSync(logPath);
                    if (stats.size > lastSize) {
                        const fd = fs.openSync(logPath, 'r');
                        const buffer = Buffer.alloc(stats.size - lastSize);
                        fs.readSync(fd, buffer, 0, buffer.length, lastSize);
                        process.stdout.write(buffer.toString('utf8'));
                        fs.closeSync(fd);
                        lastSize = stats.size;
                    }
                } catch (error) {
                    // ignore read errors
                }
                await new Promise(res => setTimeout(res, logPollingInterval));
            }
            // Write a newline at the end of the log tail
            // prevents appending logs from being printed on the same line
            process.stdout.write('\n');
        };
        const timeout = 10000; // 10 seconds
        // Start log tailing in background
        const tailPromise = tailLog();
        const exitCode: number = await new Promise((resolve, reject) => {
            unityProcess.on('exit', (code: number) => {
                setTimeout(() => {
                    logEnded = true;
                    resolve(code ?? 1);
                }, timeout);
            });
            unityProcess.on('error', (error: Error) => {
                setTimeout(() => {
                    logEnded = true;
                    reject(error);
                }, timeout);
            });
        });
        // Wait for log tailing to finish
        await tailPromise;
        // Wait for log file to be unlocked
        const start = Date.now();
        let fileLocked = true;

        while (fileLocked && Date.now() - start < timeout) {
            try {
                if (fs.existsSync(logPath)) {
                    const fd = fs.openSync(logPath, 'r+');
                    fs.closeSync(fd);
                    fileLocked = false;
                } else {
                    fileLocked = false;
                }
            } catch {
                fileLocked = true;
                await new Promise(r => setTimeout(r, logPollingInterval));
            }
        }

        return exitCode;
    }

    private async tryKillEditorProcess(): Promise<void> {
        if (this.procInfo) {
            await tryKillProcess(this.procInfo);
            await killChildProcesses(this.procInfo);
        } else {
            this.logger.debug('No Unity process info available to kill.');
        }
    }

    static GetEditorRootPath(editorPath: string): string {
        let editorRootPath = editorPath;
        switch (process.platform) {
            case 'darwin':
                editorRootPath = path.join(editorPath, '../../../../');
                break;
            case 'linux':
                editorRootPath = path.join(editorPath, '../../');
                break;
            case 'win32':
                editorRootPath = path.join(editorPath, '../../');
                break
        }
        fs.accessSync(editorRootPath, fs.constants.R_OK);
        return editorRootPath;
    }
}