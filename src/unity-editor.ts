import * as fs from 'fs';
import * as path from 'path';
import { Logger } from './logging';
import { UnityVersion } from './unity-version';
import {
    spawn,
    ChildProcessByStdio
} from 'child_process';
import {
    GetArgumentValueAsString,
    ProcInfo,
    KillProcess,
    KillChildProcesses,
    TailLogFile,
    LogTailResult,
    WaitForFileToBeCreatedAndReadable,
} from './utilities';

export interface EditorCommand {
    args: string[];
    projectPath?: string;
}

export class UnityEditor {
    public readonly editorPath: string;
    public readonly editorRootPath: string;
    public readonly version: UnityVersion;

    private readonly logger: Logger = Logger.instance;
    private readonly autoAddNoGraphics: boolean;

    /**
     * Initializes a new instance of the UnityEditor class.
     * @param editorPath The path to the Unity Editor installation.
     * @param version Optional UnityVersion instance. If not provided, the version will be inferred from the editorPath.
     * @throws Will throw an error if the editor path is invalid or not executable.
     */
    constructor(
        editorPath: string,
        version?: UnityVersion | undefined
    ) {
        this.editorPath = path.normalize(editorPath);

        if (!fs.existsSync(editorPath)) {
            throw new Error(`The Unity Editor path does not exist: ${editorPath}`);
        }

        fs.accessSync(editorPath, fs.constants.X_OK);
        this.editorRootPath = UnityEditor.GetEditorRootPath(editorPath);

        if (!version) {
            const match = editorPath.match(/(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\w+)/);

            if (!match || !match.groups) {
                throw Error(`Invalid Unity Editor Path: ${editorPath}`);
            }

            const unityMajorVersion = match.groups!.major;

            if (!unityMajorVersion) {
                throw Error(`Invalid Unity Major Version: ${editorPath}`);
            }

            this.version = new UnityVersion(`${match.groups!.major}.${match.groups!.minor}.${match.groups!.patch}`);
        } else {
            this.version = version;
        }

        this.autoAddNoGraphics = this.version.satisfies('>2018.0.0');
    }

    /**
     * Get the full path to a Unity project template based on the provided template name or regex pattern.
     * @param template The name or regex pattern of the template to find.
     * @returns The full path to the matching template file.
     * @throws If no templates are found, or no matching template is found.
     */
    public GetTemplatePath(template: string): string {
        const templates: string[] = this.GetAvailableTemplates();

        if (templates.length === 0) {
            throw new Error('No Unity templates found!');
        }

        // Build a regex to match the template name and version
        // e.g., com.unity.template.3d(-cross-platform)?.*[0-9]+\.[0-9]+\.[0-9]+\.tgz
        // Accepts either a full regex or a simple string
        let regex: RegExp;
        try {
            regex = new RegExp(`^${template}.*[0-9]+\\.[0-9]+\\.[0-9]+\\.tgz$`);
        } catch (e) {
            throw new Error(`Invalid template regex: ${template}`);
        }

        // Filter files by regex
        const matches = templates.filter(t => regex.test(path.basename(t)));

        if (matches.length === 0) {
            throw new Error(`${template} path not found!`);
        }

        // Pick the longest match (as in the shell script: sort by length descending)
        matches.sort((a, b) => b.length - a.length);
        const templatePath = matches[0];

        if (!templatePath) {
            throw new Error('No matching template path found.');
        }

        return path.normalize(templatePath);
    }

    /**
     * Get a list of available Unity project templates.
     * @returns An array of available template file names.
     */
    public GetAvailableTemplates(): string[] {
        let templateDir: string;
        let editorRoot = path.dirname(this.editorPath);

        const templates: string[] = [];

        if (process.platform === 'darwin') {
            templateDir = path.join(path.dirname(editorRoot), 'Resources', 'PackageManager', 'ProjectTemplates');
        } else {
            templateDir = path.join(editorRoot, 'Data', 'Resources', 'PackageManager', 'ProjectTemplates');
        }

        this.logger.debug(`Looking for templates in: ${templateDir}`);

        // Check if the template directory exists
        if (!fs.existsSync(templateDir) ||
            !fs.statSync(templateDir).isDirectory()) {
            return templates;
        }

        // Find all .tgz packages in the template directory
        const packages = fs.readdirSync(templateDir)
            .filter(f => f.endsWith('.tgz'))
            .map(f => path.join(templateDir, f));
        templates.push(...packages);
        return templates;
    }

    /**
     * Run the Unity Editor with the specified command line arguments.
     * @param command The command containing arguments and optional project path.
     * @throws Will throw an error if the Unity Editor fails to start or exits with a non-zero code.
     */
    public async Run(command: EditorCommand): Promise<void> {
        let isCancelled = false;
        let exitCode: number = 1;
        let procInfo: ProcInfo | null = null;
        let logTail: LogTailResult | null = null;
        let unityProcess: ChildProcessByStdio<null, null, null>;

        async function tryKillEditorProcesses(): Promise<void> {
            try {
                if (procInfo) {
                    await KillProcess(procInfo);
                    await KillChildProcesses(procInfo);
                }
            } catch (error) {
                Logger.instance.error(`Failed to kill Unity process: ${error}`);
            }
        }

        function onCancel(): void {
            isCancelled = true;
            void tryKillEditorProcesses();
        }

        try {
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
                command.args.push('-logFile', this.GenerateLogFilePath(command.projectPath));
            }

            const logPath: string = GetArgumentValueAsString('-logFile', command.args);
            const commandStr = `\x1b[34m${this.editorPath} ${command.args.join(' ')}\x1b[0m`;
            this.logger.startGroup(commandStr);

            if (process.platform === 'linux' && !command.args.includes('-nographics')) {
                unityProcess = spawn(
                    'xvfb-run',
                    [this.editorPath, ...command.args], {
                    stdio: ['ignore', 'ignore', 'ignore'],
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
                    env: {
                        ...process.env,
                        UNITY_THISISABUILDMACHINE: '1'
                    }
                });
            }

            if (!unityProcess?.pid) {
                throw new Error('Failed to start Unity process!');
            }

            process.once('SIGINT', onCancel);
            process.once('SIGTERM', onCancel);
            procInfo = { pid: unityProcess.pid, ppid: process.pid, name: this.editorPath };
            this.logger.debug(`Unity process started with pid: ${procInfo.pid}`);
            await WaitForFileToBeCreatedAndReadable(logPath, 10_000);
            logTail = TailLogFile(logPath);
            exitCode = await new Promise((resolve, reject) => {
                unityProcess.on('close', (code) => {
                    logTail?.stopLogTail();
                    resolve(code === null ? 1 : code);
                });
                unityProcess.on('error', (error) => {
                    logTail?.stopLogTail();
                    reject(error);
                });
            });
            // Wait for log tailing to finish writing remaining content
            if (logTail && logTail.tailPromise) {
                try {
                    await logTail.tailPromise;
                } catch (error) {
                    this.logger.error(`Error occurred while tailing log: ${error}`);
                }
            }
        } finally {
            process.removeListener('SIGINT', onCancel);
            process.removeListener('SIGTERM', onCancel);
            this.logger.endGroup();

            if (!isCancelled) {
                await tryKillEditorProcesses();

                if (exitCode !== 0) {
                    throw Error(`Unity failed with exit code ${exitCode}`);
                }
            }
        }
    }

    /**
     * Get or create the Logs directory within the Unity project or current working directory.
     * @param projectPath The path to the Unity project. If undefined, uses the current working directory.
     * @returns The path to the Logs directory.
     */
    public GetLogsDirectory(projectPath: string | undefined): string {
        const logsDir = projectPath !== undefined
            ? path.join(projectPath, 'Builds', 'Logs')
            : path.join(process.env.GITHUB_WORKSPACE || process.cwd(), 'Logs');

        try {
            fs.accessSync(logsDir, fs.constants.R_OK);
        } catch (error) {
            this.logger.debug(`Creating Logs Directory:\n  > "${logsDir}"`);
            fs.mkdirSync(logsDir, { recursive: true });
        }

        return logsDir;
    }

    /**
     * Generate a log file path with an optional prefix in the Logs directory.
     * @param projectPath The path to the Unity project. If undefined, uses the current working directory.
     * @param prefix An optional prefix for the log file name.
     * @returns The generated log file path.
     */
    public GenerateLogFilePath(projectPath: string | undefined, prefix: string | undefined = undefined): string {
        const logsDir = this.GetLogsDirectory(projectPath);
        const timestamp = new Date().toISOString().replace(/[-:]/g, ``).replace(/\..+/, ``);
        return path.join(logsDir, `${prefix ? prefix + '-' : ''}Unity-${timestamp}.log`);
    }

    /**
     * Get the root path of the Unity Editor installation based on the provided editor path.
     * @param editorPath The path to the Unity Editor executable.
     * @returns The root path of the Unity Editor installation.
     */
    public static GetEditorRootPath(editorPath: string): string {
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