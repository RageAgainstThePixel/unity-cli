import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from './logging';
import { UnityVersion } from './unity-version';
import {
    spawn,
    ChildProcess
} from 'child_process';
import {
    GetArgumentValueAsString,
    ProcInfo,
    KillProcess,
    Exec,
    redactSensitiveLiterals,
} from './utilities';
import { UnityCli } from './unity-cli';
import {
    IsExecutableNamed,
    IsPathUnder,
    ListProcesses,
    OwnedRoot,
    OwnedSpawnOptions,
    SelectOwnedProcesses,
    TrackOwnedProcess,
} from './process-tracker';
import {
    TailLogFile,
    LogTailResult,
} from './unity-logging';

/** Thrown when `unity run` refuses the editor arguments before it starts the editor. */
class UnityRunRejectedError extends Error { }

export interface EditorCommand {
    args: string[];
    projectPath?: string | undefined;
}

export class UnityEditor {
    /** Editor flags whose values are never logged. */
    private static readonly SENSITIVE_FLAGS = ['-username', '-password', '-cloudOrganization', '-serial'];

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
     * Scrubs sensitive command-line arguments for safe logging.
     * Replaces values for sensitive flags like -username, -password, etc. with [REDACTED].
     * @param args The command-line arguments array.
     * @returns A new array with sensitive values redacted.
     */
    public scrubSensitiveArgs(args: string[]): string[] {
        const sensitiveFlags = UnityEditor.SENSITIVE_FLAGS;
        const scrubbedArgs: string[] = [];

        for (let i = 0; i < args.length; i++) {
            const arg = args[i];
            if (!arg) continue;

            scrubbedArgs.push(arg);

            // If this is a sensitive flag and the next item is its value
            if (sensitiveFlags.includes(arg) && i + 1 < args.length) {
                scrubbedArgs.push('[REDACTED]');
                i++; // Skip the next item (the actual value) since we've already added [REDACTED]
            }
        }

        return scrubbedArgs;
    }

    /**
     * Run the Unity Editor with the specified command line arguments.
     * @param command The command containing arguments and optional project path.
     * @throws Will throw an error if the Unity Editor fails to start or exits with a non-zero code.
     */
    public async Run(command: EditorCommand): Promise<void> {
        try {
            await this.runEditor(command, true);
        } catch (error) {
            if (!(error instanceof UnityRunRejectedError)) {
                throw error;
            }

            // unity run refused the arguments before it started the editor, so launching directly runs it once
            this.logger.warn(`${error.message}\nLaunching the editor directly instead.`);
            await this.runEditor(command, false);
        }
    }

    private async runEditor(command: EditorCommand, allowUnityRun: boolean): Promise<void> {
        let isCancelled = false;
        let exitCode: number | undefined = undefined;
        let procInfo: ProcInfo | null = null;
        let logTail: LogTailResult | null = null;
        let unityProcess: ChildProcess;
        let unityRunOutput: string | undefined = undefined;
        let editorLogPath: string | undefined = undefined;

        const editorRootPath = this.editorRootPath;
        let runStartedAt = 0;
        let runPaths: string[] = [];

        // the helpers the editor starts (shader compiler, bee_backend, licensing client) outlive it as orphans, so the
        // sweep looks for this run's own process group (macOS, Linux) or descendants (Windows), never the whole machine:
        // on a shared self-hosted runner another job's editor may run from the same install
        async function tryKillEditorProcesses(): Promise<void> {
            try {
                if (!procInfo) {
                    return;
                }

                const root: OwnedRoot = { pid: procInfo.pid, startedAt: runStartedAt };
                const processes = await ListProcesses();
                const owned = new Map(SelectOwnedProcesses([root], processes).map(proc => [proc.pid, proc] as const));

                if (process.platform === 'win32') {
                    // a helper whose parent already exited can no longer be traced to the run, so on Windows an
                    // editor-folder process started during this run that names this run's project or log counts too
                    for (const proc of processes) {
                        if ((proc.createdAt ?? 0) >= runStartedAt - 2000 &&
                            proc.executablePath && IsPathUnder(proc.executablePath, editorRootPath) &&
                            runPaths.some(runPath => proc.commandLine.toLowerCase().includes(runPath.toLowerCase()))) {
                            owned.set(proc.pid, proc);
                        }
                    }
                }

                // the licensing client is left alone: it may still be saving the license it just updated, and killing it
                // then loses the license for the next run; return-license stops it at the end of the job instead
                const leftovers = [...owned.values()].filter(proc => !IsExecutableNamed(proc, 'Unity.Licensing.Client'));
                await Promise.all(leftovers.map(proc => KillProcess(proc).catch(() => undefined)));
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
            editorLogPath = logPath;
            // values of sensitive flags are masked in CI and redacted from everything printed from the Editor log
            const sensitiveValues = command.args.filter((_, i) => i > 0 && UnityEditor.SENSITIVE_FLAGS.includes(command.args[i - 1]!));
            sensitiveValues.forEach(value => this.logger.maskCredential(value));
            logTail = TailLogFile(logPath, command.projectPath, sensitiveValues);

            // Scrub sensitive arguments before logging
            const scrubbedArgs = this.scrubSensitiveArgs(command.args);
            const commandStr = `\x1b[34m${this.editorPath} ${scrubbedArgs.join(' ')}\x1b[0m`;
            this.logger.startGroup(commandStr);

            if (this.version.isLegacy() && process.platform === 'darwin' && process.arch === 'arm64') {
                throw new Error(`Cannot execute Unity ${this.version.toString()} on Apple Silicon Macs.`);
            }

            const linuxEnvOverrides = process.platform === 'linux'
                ? await this.prepareLinuxAudioEnvironment()
                : undefined;
            const baseEditorEnv: NodeJS.ProcessEnv = {
                ...process.env,
                DISABLE_EMBEDDED_BUILD_PIPELINE_PLUGIN_LOGGING: '1',
                ...(linuxEnvOverrides ?? {})
            };

            const unityCli = allowUnityRun ? await this.getUnityCliForRun(command) : undefined;
            runPaths = [logPath, ...(command.projectPath ? [command.projectPath] : [])];
            runStartedAt = Date.now();

            if (unityCli) {
                const runArgs = UnityEditor.GetUnityRunArgs(this.editorPath, command.projectPath!, logPath, command.args);
                this.logger.debug(`Launching through the Unity CLI: ${unityCli.executable} ${this.scrubSensitiveArgs(runArgs).join(' ')}`);
                unityRunOutput = '';
                const child = spawn(
                    unityCli.executable,
                    runArgs, {
                    stdio: ['ignore', 'pipe', 'pipe'],
                    ...OwnedSpawnOptions(),
                    env: baseEditorEnv
                });
                const collect = (data: Buffer) => { unityRunOutput += data.toString(); };
                child.stdout.on('data', collect);
                child.stderr.on('data', collect);
                unityProcess = child;
            } else if (process.platform === 'linux' &&
                !command.args.includes('-nographics')
            ) {
                unityProcess = spawn(
                    'xvfb-run',
                    [this.editorPath, ...command.args], {
                    stdio: ['ignore', 'ignore', 'ignore'],
                    ...OwnedSpawnOptions(),
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
                    ...OwnedSpawnOptions(),
                    env: baseEditorEnv
                });
            } else {
                unityProcess = spawn(
                    this.editorPath,
                    command.args, {
                    stdio: ['ignore', 'ignore', 'ignore'],
                    ...OwnedSpawnOptions(),
                    env: baseEditorEnv
                });
            }

            if (!unityProcess?.pid || unityProcess.killed) {
                throw new Error('Failed to start Unity process!');
            }

            process.once('SIGINT', onCancel);
            process.once('SIGTERM', onCancel);
            procInfo = { pid: unityProcess.pid, ppid: process.pid, name: this.editorPath };
            // the licensing client the editor starts is left running after the run; recording the editor lets
            // return-license find and stop it at the end of the job
            TrackOwnedProcess(unityProcess, runStartedAt);
            this.logger.debug(`Unity process started with pid: ${procInfo.pid}`);
            exitCode = await new Promise((resolve, reject) => {
                // the editor can start a licensing client that outlives it and inherits unity run's piped
                // stdout and stderr, so 'close' may never fire; settle on 'exit' and stop reading the pipes shortly after
                let settled = false;
                const settle = (code: number | null) => {
                    if (settled) { return; }
                    settled = true;
                    logTail?.stopLogTail();
                    resolve(code === null ? 1 : code);
                };
                unityProcess.on('close', settle);
                unityProcess.on('exit', (code) => {
                    setTimeout(() => {
                        unityProcess.stdout?.destroy();
                        unityProcess.stderr?.destroy();
                        settle(code);
                    }, 1000);
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

                if (exitCode !== undefined && exitCode !== 0 && unityRunOutput) {
                    // unity run can echo arguments back, so values of sensitive flags are redacted the same way as the logged command
                    const sensitiveValues = command.args.filter((_, i) => i > 0 && UnityEditor.SENSITIVE_FLAGS.includes(command.args[i - 1]!));
                    const output = redactSensitiveLiterals(unityRunOutput, sensitiveValues)
                        .split(/\r?\n/).filter(line => line.length > 0 && !line.includes('<claude-code-hint')).join('\n');

                    if (output.includes('conflicts with a reserved Unity flag')) {
                        throw new UnityRunRejectedError(`unity run rejected the editor arguments:\n${output}`);
                    }

                    if (output.length > 0) {
                        this.logger.info(`unity run output:\n${output}`);
                    }
                }

                if (exitCode !== undefined && exitCode !== 0) {
                    await this.printFailureRecap(logTail, editorLogPath);
                }

                if (exitCode === undefined) {
                    throw Error('Failed to start Unity!');
                } else if (exitCode !== 0) {
                    throw Error(`Unity failed with exit code ${exitCode}`);
                }
            } else {
                // a cancelled run did not finish, so it must not end the command with exit code 0
                throw Error('The Unity run was cancelled');
            }
        }
    }

    /**
     * After a failed run, lists the error lines from the Editor log outside the collapsed log group, so the cause sits
     * next to "Unity failed with exit code N". Stack frames are left out and the list is capped; with no error line,
     * the log's last lines are printed instead. Annotations are not affected.
     */
    private async printFailureRecap(logTail: LogTailResult | null, logPath: string | undefined): Promise<void> {
        const maxLines = 100;
        const errorLines = logTail?.errorLines ?? [];

        if (errorLines.length > 0) {
            const total = logTail!.errorLineCount();
            const shown = errorLines.slice(0, maxLines);
            const more = total - shown.length;
            this.logger.info(`Unity reported ${total} error line${total === 1 ? '' : 's'}:\n${shown.map(line => `  ${line}`).join('\n')}` +
                (more > 0 ? `\n  ... ${more} more in ${logPath ?? 'the Editor log'}` : ''));
            return;
        }

        if (!logPath) {
            return;
        }

        try {
            const lines = (await fs.promises.readFile(logPath, 'utf-8')).split(/\r?\n/).filter(line => line.trim().length > 0);
            const tail = lines.slice(-20);

            if (tail.length > 0) {
                this.logger.info(`No error lines found; the last ${tail.length} lines of ${logPath}:\n${tail.map(line => `  ${line}`).join('\n')}`);
            }
        } catch (error) {
            this.logger.debug(`Could not read ${logPath}: ${error}`);
        }
    }

    /**
     * Decides whether a run goes through the official CLI's `unity run`.
     * It needs a project and a -quit argument, and is skipped for editors and hosts it is not verified with:
     * editors older than 2019.1, Linux runs that need xvfb, and x86_64 editors under Rosetta.
     * Set UNITY_CLI_DIRECT_LAUNCH=true to always launch the editor directly.
     */
    private async getUnityCliForRun(command: EditorCommand): Promise<UnityCli | undefined> {
        const directLaunch = process.env.UNITY_CLI_DIRECT_LAUNCH?.trim().toLowerCase();

        // unity run always quits the editor, so commands that manage their own shutdown launch directly.
        // Android builds start a Gradle daemon that inherits the editor's output, and unity run waits on that
        // output until the daemon dies, so it never returns; those launch directly too
        const buildTarget = command.args.indexOf('-buildTarget');
        const isAndroidBuild = buildTarget >= 0 && command.args[buildTarget + 1]?.toLowerCase() === 'android';

        if (!command.projectPath ||
            !command.args.includes('-quit') ||
            isAndroidBuild ||
            directLaunch === 'true' || directLaunch === '1' ||
            this.version.isLessThan('2019.1.0') ||
            (process.platform === 'linux' && !command.args.includes('-nographics')) ||
            (process.platform === 'darwin' && process.arch === 'arm64' && this.version.architecture === 'X86_64')) {
            return undefined;
        }

        try {
            return await UnityCli.Find();
        } catch (error) {
            this.logger.debug(`Launching the editor directly, the Unity CLI was not found: ${error}`);
            return undefined;
        }
    }

    /**
     * Builds the `unity run` arguments for an editor command.
     * `unity run` adds -batchmode, -quit, -projectPath and -logFile itself and rejects them after `--`, so those are not forwarded.
     * @param editorPath The editor executable.
     * @param projectPath The Unity project.
     * @param logPath The editor log file, which unity-cli tails itself.
     * @param args The editor arguments.
     */
    public static GetUnityRunArgs(editorPath: string, projectPath: string, logPath: string, args: string[]): string[] {
        const forwarded: string[] = [];

        for (let i = 0; i < args.length; i++) {
            const arg = args[i]!;

            if (arg === '-projectPath' || arg === '-logFile') {
                i++;
                continue;
            }

            if (arg === '-batchmode' || arg === '-quit') {
                continue;
            }

            forwarded.push(arg);
        }

        return [
            'run', projectPath,
            // on macOS unity run wants the .app bundle, not the executable inside it
            '--editor-path', editorPath.replace(/(\.app)[\\/]Contents[\\/]MacOS[\\/][^\\/]+$/, '$1'),
            '--log-file', logPath,
            '--no-tail',
            '--',
            ...forwarded
        ];
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
     * Resolves a writable Pulse/XDG runtime directory. CI runners often lack systemd-logind's `/run/user/$UID`
     * (Pulse then fails with "Failed to create secure directory (.../pulse)").
     */
    private async resolveLinuxXdgRuntimeDir(): Promise<string> {
        const fromEnv = process.env.XDG_RUNTIME_DIR?.trim();
        if (fromEnv && fromEnv.length > 0) {
            try {
                await fs.promises.mkdir(fromEnv, { recursive: true, mode: 0o700 });
            } catch (error) {
                this.logger.debug(`Could not mkdir XDG_RUNTIME_DIR (${fromEnv}): ${error}`);
            }
            try {
                await fs.promises.access(fromEnv, fs.constants.W_OK);
                return fromEnv;
            } catch {
                this.logger.debug(
                    `XDG_RUNTIME_DIR from environment is not usable (${fromEnv}); falling back like unset.`
                );
            }
        }

        const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
        const systemdUser = `/run/user/${uid}`;
        try {
            await fs.promises.access(systemdUser, fs.constants.W_OK);
            return systemdUser;
        } catch {
            this.logger.debug(`Using tmp XDG_RUNTIME_DIR (not using ${systemdUser}: missing or not writable).`);
        }

        const fallback = path.join(os.tmpdir(), `unity-cli-xdg-runtime-${uid}`);
        await fs.promises.mkdir(fallback, { recursive: true, mode: 0o700 });
        return fallback;
    }

    private async prepareLinuxAudioEnvironment(): Promise<NodeJS.ProcessEnv> {
        if (process.platform !== 'linux') {
            return {};
        }

        const runtimeDir = await this.resolveLinuxXdgRuntimeDir();

        const envOverrides: NodeJS.ProcessEnv = {
            SDL_AUDIODRIVER: process.env.SDL_AUDIODRIVER || 'dummy',
            AUDIODRIVER: process.env.AUDIODRIVER || 'dummy',
            AUDIODEV: process.env.AUDIODEV?.trim() || 'null',
            PULSE_SINK: process.env.PULSE_SINK || 'unity_dummy',
            XDG_RUNTIME_DIR: runtimeDir,
        };

        const alsaCard = process.env.ALSA_CARD?.trim();
        if (alsaCard && alsaCard.length > 0) {
            envOverrides.ALSA_CARD = alsaCard;
        }

        await this.tryExec(
            'bash',
            ['-c', 'pulseaudio --check 2>/dev/null || pulseaudio --start --exit-idle-time=-1 || true'],
            envOverrides
        );
        await this.tryExec(
            'bash',
            [
                '-c',
                'command -v pactl >/dev/null 2>&1 && { pactl list short sinks 2>/dev/null | grep -q unity_dummy || pactl load-module module-null-sink sink_name=unity_dummy sink_properties=device.description=UnityCI >/tmp/unity-null-sink.id; } || true',
            ],
            envOverrides
        );

        return envOverrides;
    }

    private async tryExec(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
        try {
            await Exec(command, args, { silent: true, showCommand: false, env });
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
            case 'win32':
                return path.join(process.env.LOCALAPPDATA || '', 'Unity', 'Editor');
            case 'darwin':
                return path.join(process.env.HOME || '', 'Library', 'Logs', 'Unity');
            case 'linux':
                return path.join(process.env.HOME || '', '.config', 'unity3d', 'Editor');
            default:
                throw new Error(`Unsupported platform: ${process.platform}`);
        }
    }
}
