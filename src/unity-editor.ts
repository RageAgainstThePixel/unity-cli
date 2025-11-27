import * as os from 'os';
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
    Exec,
    DeleteDirectory,
} from './utilities';
import {
    TailLogFile,
    LogTailResult,
} from './unity-logging';

export interface EditorCommand {
    args: string[];
    projectPath?: string | undefined;
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

        this.autoAddNoGraphics = this.version.isGreaterThan('2018.0.0');


        // ensure metadata.hub.json exists and has a productName entry
        const hubMetaDataPath = path.join(this.editorRootPath, 'metadata.hub.json');
        try {
            // check if we have permissions to write to this file
            fs.accessSync(hubMetaDataPath, fs.constants.W_OK);

            if (!fs.existsSync(hubMetaDataPath)) {
                const metadata = {
                    productName: `Unity ${this.version.version.toString()}`,
                    entitlements: [],
                    releaseStream: '',
                    isLTS: null
                };
                fs.writeFileSync(hubMetaDataPath, JSON.stringify(metadata), { encoding: 'utf-8' });
            } else {
                const metadataContent = fs.readFileSync(hubMetaDataPath, { encoding: 'utf-8' });
                const metadata = JSON.parse(metadataContent);

                if (!metadata.productName) {
                    // projectName must be the first property
                    const newMetadata: any = {
                        productName: `Unity ${this.version.version.toString()}`
                    };
                    Object.keys(metadata).forEach(key => {
                        if (key === 'productName') { return; }
                        newMetadata[key] = metadata[key];
                    });
                    fs.writeFileSync(hubMetaDataPath, JSON.stringify(newMetadata), { encoding: 'utf-8' });
                }
            }
        } catch (error) {
            // ignore - we just won't be able to update the metadata file
            this.logger.debug(`No write access to Unity editor root path: ${this.editorRootPath}`);
        }
    }

    /**
     * Get the full path to a Unity project template based on the provided template name or regex pattern.
     * @param template The name or regex pattern of the template to find.
     * @returns The full path to the matching template file.
     * @throws If no templates are found, or no matching template is found.
     */
    public GetTemplatePath(template: string): string | undefined {
        const templates: string[] = this.GetAvailableTemplates();

        if (templates.length === 0) {
            this.logger.warn(`No Unity templates found for ${this.version.toString()}`);
            return undefined;
        }

        // Build a regex to match the template name, an optional numeric version suffix, and required file extension
        // Example input: com.unity.template.3d(-cross-platform)?.*
        // Example match: com.unity.template.3d-cross-platform-1.2.3.tar.gz or com.unity.template.3d-1.2.3.tgz
        let regex: RegExp;
        try {
            regex = new RegExp(`^${template}(?:-\\d+\\.\\d+\\.\\d+)?(?:\\.tgz|\\.tar\\.gz)$`);
        } catch (e) {
            throw new Error(`Invalid template regex: ${template}`);
        }

        // Filter files by regex
        const matches = templates.filter(t => regex.test(path.basename(t)));

        if (matches.length === 0) {
            this.logger.warn(`No matching template path found for ${template}`);
            return undefined;
        }

        // Pick the longest match (as in the shell script: sort by length descending)
        matches.sort((a, b) => b.length - a.length);
        const templatePath = matches[0];

        if (!templatePath) {
            this.logger.warn(`No matching template path found for ${template}`);
            return undefined;
        }

        return path.normalize(templatePath);
    }

    /**
     * Get a list of available Unity project templates.
     * @returns An array of available template file names.
     */
    public GetAvailableTemplates(): string[] {
        if (this.version.isLessThan('2019.0.0')) {
            this.logger.warn(`Unity version ${this.version.toString()} does not support project templates.`);
            return [];
        }

        let templateDir: string;
        let editorRoot = path.dirname(this.editorPath);

        if (process.platform === 'darwin') {
            templateDir = path.join(path.dirname(editorRoot), 'Resources', 'PackageManager', 'ProjectTemplates');
        } else {
            templateDir = path.join(editorRoot, 'Data', 'Resources', 'PackageManager', 'ProjectTemplates');
        }

        this.logger.debug(`Looking for templates in: ${templateDir}`);

        if (!fs.existsSync(templateDir) ||
            !fs.statSync(templateDir).isDirectory()) {
            return [];
        }

        const templates: string[] = [];
        const entries = fs.readdirSync(templateDir, { withFileTypes: true });

        for (const entry of entries) {
            if (entry.isFile() && (entry.name.endsWith('.tgz') || entry.name.endsWith('.tar.gz'))) {
                templates.push(path.join(templateDir, entry.name));
            }
        }

        this.logger.debug(`Found ${templates.length} templates:\n${templates.map(t => `  - ${t}`).join('\n')}`);
        return templates;
    }

    /**
     * Run the Unity Editor with the specified command line arguments.
     * @param command The command containing arguments and optional project path.
     * @throws Will throw an error if the Unity Editor fails to start or exits with a non-zero code.
     */
    public async Run(command: EditorCommand): Promise<void> {
        let isCancelled = false;
        let exitCode: number | undefined = undefined;
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

            if (this.autoAddNoGraphics &&
                !command.args.includes(`-nographics`) &&
                !command.args.includes(`-force-graphics`)) {
                command.args.unshift(`-nographics`);
            }

            if (!command.args.includes(`-batchmode`)) {
                command.args.unshift(`-batchmode`);
            }

            if (!command.args.includes(`-automated`)) {
                command.args.unshift(`-automated`);
            }

            if (!command.args.includes('-logFile')) {
                command.args.unshift('-logFile', this.GenerateLogFilePath(command.projectPath));
            } else {
                const existingLogPath = GetArgumentValueAsString('-logFile', command.args);
                command.args.splice(command.args.indexOf(existingLogPath) - 1, 2);
                command.args.unshift('-logFile', existingLogPath);
            }

            if (command.projectPath) {
                if (!command.args.includes('-projectPath')) {
                    command.args.unshift('-projectPath', command.projectPath);
                } else {
                    const existingPath = GetArgumentValueAsString('-projectPath', command.args);

                    if (existingPath !== command.projectPath) {
                        throw Error(`Conflicting project paths provided. Argument: "${existingPath}", Command: "${command.projectPath}"`);
                    }

                    // Ensure -projectPath is the first argument
                    command.args.splice(command.args.indexOf(existingPath) - 1, 2);
                    command.args.unshift('-projectPath', command.projectPath);
                }
            }

            const logPath: string = GetArgumentValueAsString('-logFile', command.args);
            logTail = TailLogFile(logPath, command.projectPath);
            const commandStr = `\x1b[34m${this.editorPath} ${command.args.join(' ')}\x1b[0m`;
            this.logger.startGroup(commandStr);

            if (this.version.isLegacy() && process.platform === 'darwin' && process.arch === 'arm64') {
                throw new Error(`Cannot execute Unity ${this.version.toString()} on Apple Silicon Macs.`);
            }

            const linuxEnvOverrides = process.platform === 'linux'
                ? await this.prepareLinuxAudioEnvironment()
                : undefined;
            const baseEditorEnv: NodeJS.ProcessEnv = {
                ...process.env,
                UNITY_THISISABUILDMACHINE: '1',
                ...(linuxEnvOverrides ?? {})
            };

            if (process.platform === 'linux' &&
                !command.args.includes('-nographics')
            ) {
                unityProcess = spawn(
                    'xvfb-run',
                    [this.editorPath, ...command.args], {
                    stdio: ['ignore', 'ignore', 'ignore'],
                    env: {
                        ...baseEditorEnv,
                        DISPLAY: baseEditorEnv.DISPLAY || ':99'
                    }
                });
            } else if (process.arch === 'arm64' &&
                process.platform === 'darwin' &&
                this.version.architecture === 'X86_64'
            ) { // Force the Unity Editor to run under Rosetta 2 on Apple Silicon Macs if the editor is x86_64
                unityProcess = spawn(
                    'arch',
                    ['-x86_64', this.editorPath, ...command.args], {
                    stdio: ['ignore', 'ignore', 'ignore'],
                    env: baseEditorEnv
                });
            } else {
                unityProcess = spawn(
                    this.editorPath,
                    command.args, {
                    stdio: ['ignore', 'ignore', 'ignore'],
                    env: baseEditorEnv
                });
            }

            if (!unityProcess?.pid || unityProcess.killed) {
                throw new Error('Failed to start Unity process!');
            }

            process.once('SIGINT', onCancel);
            process.once('SIGTERM', onCancel);
            procInfo = { pid: unityProcess.pid, ppid: process.pid, name: this.editorPath };
            this.logger.debug(`Unity process started with pid: ${procInfo.pid}`);
            exitCode = await new Promise((resolve, reject) => {
                unityProcess.on('close', (code) => {
                    logTail?.stopLogTail();
                    resolve(code === null ? 1 : code);
                });
                unityProcess.on('error', (error) => {
                    this.logger.error(`Unity process error: ${error}`);
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

                if (exitCode === undefined) {
                    throw Error('Failed to start Unity!');
                } else if (exitCode !== 0) {
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

    private async prepareLinuxAudioEnvironment(): Promise<NodeJS.ProcessEnv> {
        if (process.platform !== 'linux') {
            return {};
        }

        const envOverrides: NodeJS.ProcessEnv = {
            SDL_AUDIODRIVER: process.env.SDL_AUDIODRIVER || 'dummy',
            AUDIODRIVER: process.env.AUDIODRIVER || 'dummy',
            AUDIODEV: process.env.AUDIODEV || 'null',
            ALSA_CARD: process.env.ALSA_CARD || 'Loopback',
            PULSE_SINK: process.env.PULSE_SINK || 'unity_dummy'
        };

        const defaultRuntimeDir = `/run/user/${typeof process.getuid === 'function' ? process.getuid() : 1000}`;
        const runtimeDir = process.env.XDG_RUNTIME_DIR || defaultRuntimeDir;
        envOverrides.XDG_RUNTIME_DIR = runtimeDir;

        try {
            await fs.promises.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
        } catch (error) {
            this.logger.debug(`Failed to ensure XDG_RUNTIME_DIR (${runtimeDir}): ${error}`);
        }

        await this.tryExec('bash', ['-c', 'pulseaudio --check 2>/dev/null || pulseaudio --start --exit-idle-time=-1 || true']);
        await this.tryExec('bash', ['-c', 'command -v pactl >/dev/null 2>&1 && { pactl list short sinks 2>/dev/null | grep -q unity_dummy || pactl load-module module-null-sink sink_name=unity_dummy sink_properties=device.description=UnityCI >/tmp/unity-null-sink.id; } || true']);

        return envOverrides;
    }

    private async tryExec(command: string, args: string[]): Promise<void> {
        try {
            await Exec(command, args, { silent: true, showCommand: false });
        } catch (error) {
            this.logger.debug(`Skipped helper command "${command} ${args.join(' ')}": ${error}`);
        }
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

    /**
     * Gets the path to the Unity Editor log directory.
     * @returns The path to the Unity Editor logs directory.
     */
    static GetEditorLogsDirectory() {
        switch (process.platform) {
            case 'darwin':
                return path.join(os.homedir(), 'Library', 'Logs', 'Unity');
            case 'linux':
                return path.join(os.homedir(), '.config', 'unity3d', 'Editor');
            case 'win32':
                return path.join(process.env.LOCALAPPDATA || '', 'Unity', 'Editor');
            default:
                throw new Error(`Unsupported platform: ${process.platform}`);
        }
    }

    /**
     * Uninstall the Unity Editor.
     */
    public async Uninstall(): Promise<void> {
        switch (process.platform) {
            case 'darwin':
            case 'linux':
                await Exec('sudo', [
                    'rm', '-rf', this.editorRootPath
                ], { silent: true, showCommand: true });
                break;
            case 'win32':
                const editorDir = path.dirname(this.editorPath);
                const uninstallPath = path.join(editorDir, 'Uninstall.exe');
                await fs.promises.access(uninstallPath, fs.constants.R_OK | fs.constants.X_OK);
                await Exec('powershell', [
                    '-NoProfile',
                    '-Command',
                    `Start-Process -FilePath "${uninstallPath}" -ArgumentList "/S" -Wait`
                ], { silent: true, showCommand: true });
                // delete the editor root directory if it still exists
                await DeleteDirectory(editorDir);

                if (this.version.isLegacy()) {
                    // delete the MonoDevelop that is a sibling of the Unity editor directory
                    const monoDevelopDir = path.join(path.dirname(editorDir), 'MonoDevelop');
                    await DeleteDirectory(monoDevelopDir);
                }
                break;
        }
    }
}