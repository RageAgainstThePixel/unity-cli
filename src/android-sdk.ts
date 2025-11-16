import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { Logger } from './logging';
import { UnityEditor } from './unity-editor';
import {
    Exec,
    GetTempDir,
    isProcessElevated,
    ReadFileContents,
    ResolveGlobToPath,
    ResolvePathCandidates,
} from './utilities';

const logger = Logger.instance;

/**
 * Checks if the required Android SDK is installed for the given Unity Editor and Project.
 * @param editor The UnityEditor instance.
 * @param projectPath The path to the Unity project.
 * @returns A promise that resolves when the check is complete.
 */
export async function CheckAndroidSdkInstalled(editor: UnityEditor, projectPath: string): Promise<void> {
    logger.ci(`Checking Android SDK installation for:\n  > Editor: ${editor.editorRootPath}\n  > Project: ${projectPath}`);
    let sdkPath = undefined;
    await createRepositoryCfg();
    const projectSettingsPath = path.join(projectPath, 'ProjectSettings/ProjectSettings.asset');
    const projectSettingsContent = await ReadFileContents(projectSettingsPath);
    const matchResult = projectSettingsContent.match(/(?<=AndroidTargetSdkVersion: )\d+/);
    const androidTargetSdk = matchResult ? parseInt(matchResult[0]) : 0;
    logger.ci(`AndroidTargetSdkVersion:\n  > ${androidTargetSdk}`);

    if (androidTargetSdk === undefined || androidTargetSdk === 0) { return; }

    sdkPath = await getAndroidSdkPath(editor, androidTargetSdk);

    if (sdkPath) {
        logger.ci(`Target Android SDK android-${androidTargetSdk} Installed in:\n  > "${sdkPath}"`);
        return;
    }

    logger.info(`Installing Android Target SDK:\n  > android-${androidTargetSdk}`);
    const sdkManagerPath = await getSdkManager(editor);
    const javaSdk = await getJDKPath(editor);
    await execSdkManager(sdkManagerPath, javaSdk, ['--licenses']);
    await execSdkManager(sdkManagerPath, javaSdk, ['--update']);
    await execSdkManager(sdkManagerPath, javaSdk, ['platform-tools', `platforms;android-${androidTargetSdk}`]);
    sdkPath = await getAndroidSdkPath(editor, androidTargetSdk);

    if (!sdkPath) {
        throw new Error(`Failed to install android-${androidTargetSdk} in ${editor.editorRootPath}`);
    }

    logger.ci(`Target Android SDK Installed in:\n  > "${sdkPath}"`);

}

async function createRepositoryCfg(): Promise<void> {
    const androidPath = path.join(os.homedir(), '.android');
    await fs.promises.mkdir(androidPath, { recursive: true });
    const fileHandle = await fs.promises.open(path.join(androidPath, 'repositories.cfg'), 'w');
    await fileHandle.close();
}

async function getJDKPath(editor: UnityEditor): Promise<string> {
    let jdkPath: string | undefined = undefined;

    if (editor.version.isGreaterThanOrEqualTo('2019.0.0')) {
        logger.debug('Using JDK bundled with Unity 2019+');
        jdkPath = await ResolveGlobToPath([editor.editorRootPath, '**', 'AndroidPlayer', 'OpenJDK/']);

        if (!jdkPath) {
            throw new Error(`Failed to resolve OpenJDK in ${editor.editorRootPath}`);
        }
    } else {
        logger.debug('Using system JDK for Unity versions prior to 2019');
        jdkPath = process.env.JAVA_HOME || process.env.JDK_HOME;

        if (!jdkPath) {
            throw new Error('JDK installation not found: No system JAVA_HOME or JDK_HOME defined');
        }
    }

    await fs.promises.access(jdkPath, fs.constants.R_OK);
    logger.ci(`jdkPath:\n  > "${jdkPath}"`);
    return jdkPath;
}

async function getSdkManager(editor: UnityEditor): Promise<string> {
    let globCandidates: string[][] = [];
    if (editor.version.range('>=2019.0.0 <2021.0.0')) {
        logger.debug('Using sdkmanager bundled with Unity 2019 and 2020');
        switch (process.platform) {
            case 'darwin':
            case 'linux':
                globCandidates = [[editor.editorRootPath, '**', 'AndroidPlayer', '**', 'sdkmanager']];
                break;
            case 'win32':
                globCandidates = [[editor.editorRootPath, '**', 'AndroidPlayer', '**', 'sdkmanager.bat']];
                break;
            default:
                throw new Error(`Unsupported platform: ${process.platform}`);
        }
    } else if (editor.version.range('>=2021.0.0')) {
        logger.debug('Using cmdline-tools sdkmanager bundled with Unity 2021+');
        switch (process.platform) {
            case 'darwin':
            case 'linux':
                globCandidates = [[editor.editorRootPath, '**', 'AndroidPlayer', '**', 'cmdline-tools', '**', 'sdkmanager']];
                break;
            case 'win32':
                globCandidates = [[editor.editorRootPath, '**', 'AndroidPlayer', '**', 'cmdline-tools', '**', 'sdkmanager.bat']];
                break;
            default:
                throw new Error(`Unsupported platform: ${process.platform}`);
        }
    } else {
        logger.debug('Using system sdkmanager');
        const systemSdkPath = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME;

        if (!systemSdkPath) {
            throw new Error('Android installation not found: No system ANDROID_SDK_ROOT or ANDROID_HOME defined');
        }

        const sdkManagerBinary = process.platform === 'win32' ? 'sdkmanager.bat' : 'sdkmanager';
        switch (process.platform) {
            case 'darwin':
            case 'linux':
            case 'win32':
                globCandidates = [
                    [systemSdkPath, 'cmdline-tools', 'latest', 'bin', sdkManagerBinary],
                    [systemSdkPath, 'cmdline-tools', '**', 'bin', sdkManagerBinary],
                    [systemSdkPath, 'tools', 'bin', sdkManagerBinary]
                ];
                break;
            default:
                throw new Error(`Unsupported platform: ${process.platform}`);
        }
    }

    const sdkmanagerPath = await ResolvePathCandidates(globCandidates);

    if (!sdkmanagerPath) {
        const normalizedCandidates = globCandidates.map(candidate => path.join(...candidate).split(path.sep).join('/'));
        if (normalizedCandidates.length > 0) {
            logger.ci(`sdkmanager glob candidates:\n${normalizedCandidates.map(candidate => `  > ${candidate}`).join('\n')}`);
        } else {
            logger.ci('sdkmanager glob candidates:\n  > <none>');
        }
        throw new Error('Failed to resolve sdkmanager in expected locations');
    }

    await fs.promises.access(sdkmanagerPath, fs.constants.R_OK);
    logger.ci(`sdkmanagerPath:\n  > "${sdkmanagerPath}"`);
    return sdkmanagerPath;
}

async function getAndroidSdkPath(editor: UnityEditor, androidTargetSdk: number): Promise<string | undefined> {
    logger.ci(`Attempting to locate Android SDK Path...\n  > editorRootPath: ${editor.editorRootPath}\n  > androidTargetSdk: ${androidTargetSdk}`);
    let sdkPath: string;

    // if 2019+ test editor path, else use system android installation
    if (editor.version.isGreaterThanOrEqualTo('2019.0.0')) {
        logger.debug('Using Android SDK bundled with Unity 2019+');
        try {
            sdkPath = await ResolveGlobToPath([editor.editorRootPath, '**', 'PlaybackEngines', 'AndroidPlayer', 'SDK', 'platforms', `android-${androidTargetSdk}/`]);
        } catch (error) {
            logger.debug(`android-${androidTargetSdk} not installed`);
            return undefined;
        }
    } else { // fall back to system android installation
        logger.debug('Using system Android SDK for Unity versions prior to 2019');
        try {
            const systemSdkPath = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME;

            if (!systemSdkPath) {
                logger.debug('Android installation not found: No system ANDROID_SDK_ROOT or ANDROID_HOME defined');
                return undefined;
            }

            sdkPath = await ResolveGlobToPath([systemSdkPath, 'platforms', `android-${androidTargetSdk}/`]);
        } catch (error) {
            logger.debug(`android-${androidTargetSdk} not installed`);
            return undefined;
        }
    }

    return sdkPath;
}

async function execSdkManager(sdkManagerPath: string, javaPath: string, args: string[]): Promise<void> {
    let output = '';
    let exitCode = 0;

    logger.startGroup(`\x1b[34m${sdkManagerPath} ${args.join(' ')}\x1b[0m`);

    if (sdkManagerPath.includes(path.sep)) {
        fs.accessSync(sdkManagerPath, fs.constants.R_OK | fs.constants.X_OK);
    }

    try {
        if (!await isProcessElevated()) {
            if (process.platform === 'win32') {
                await runSdkManagerElevatedWindows(sdkManagerPath, javaPath, args);
            } else {
                await runSdkManagerElevatedPosix(sdkManagerPath, javaPath, args);
            }
            return;
        }

        exitCode = await new Promise<number>(async (resolve, reject) => {
            let cmdEnv = { ...process.env };
            cmdEnv.JAVA_HOME = javaPath;
            cmdEnv.JDK_HOME = javaPath;
            cmdEnv.SKIP_JDK_VERSION_CHECK = 'true';
            let cmd = sdkManagerPath;
            let cmdArgs = args;

            if (process.platform === 'win32') {
                cmd = 'cmd.exe';
                cmdArgs = ['/c', sdkManagerPath, ...args];
            }

            const child = spawn(cmd, cmdArgs, {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: cmdEnv
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

            function handleDataStream(data: Buffer) {
                const chunk = data.toString();
                output += chunk;
                process.stdout.write(chunk);
            }
            const acceptBuffer = Buffer.from(Array(10).fill('y').join(os.EOL), 'utf8');
            child.stdin.write(acceptBuffer);
            child.stdout.on('data', (data: Buffer) => handleDataStream(data));
            child.stderr.on('data', (data: Buffer) => handleDataStream(data));
            child.on('error', (error) => {
                removeListeners();
                reject(error);
            });
            child.on('close', (code) => {
                removeListeners();
                resolve(code === null ? 0 : code);
            });
        });
    } finally {
        logger.endGroup();

        if (exitCode !== 0) {
            throw new Error(`${sdkManagerPath} ${args.join(' ')} failed with exit code ${exitCode}`);
        }
    }
}

async function runSdkManagerElevatedWindows(sdkManagerPath: string, javaPath: string, args: string[]): Promise<void> {
    const tempDir = GetTempDir();
    await fs.promises.mkdir(tempDir, { recursive: true });
    const uniqueId = `sdkmanager-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const scriptPath = path.join(tempDir, `unity-cli-${uniqueId}.ps1`);
    const logPath = path.join(tempDir, `unity-cli-${uniqueId}.log`);
    const escapeSingleQuotes = (value: string): string => value.replace(/'/g, "''");
    const quotedArgs = args.map(arg => `'${escapeSingleQuotes(arg)}'`).join(' ');
    const formattedArgs = quotedArgs.length > 0 ? ` ${quotedArgs}` : '';
    const acceptanceBuffer = new Array(40).fill("'y'").join(', ');
    const scriptContents = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$env:JAVA_HOME = '${escapeSingleQuotes(javaPath)}'
$env:JDK_HOME = '${escapeSingleQuotes(javaPath)}'
$env:SKIP_JDK_VERSION_CHECK = 'true'
$logPath = '${escapeSingleQuotes(logPath)}'
$acceptBuffer = @(${acceptanceBuffer})
$null = New-Item -ItemType File -Path $logPath -Force
$acceptBuffer | & '${escapeSingleQuotes(sdkManagerPath)}'${formattedArgs} 2>&1 | Tee-Object -FilePath $logPath -Append
exit $LASTEXITCODE
`.trim();

    await fs.promises.writeFile(scriptPath, scriptContents, { encoding: 'utf8' });

    const launcher = `$process = Start-Process -FilePath 'powershell' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${escapeSingleQuotes(scriptPath)}' -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $process.ExitCode`;

    let logPrinted = false;
    const emitLog = async (): Promise<void> => {
        if (logPrinted) { return; }
        try {
            const logContent = await fs.promises.readFile(logPath, 'utf8');
            if (logContent && logContent.length > 0) {
                process.stdout.write(logContent.endsWith('\n') ? logContent : `${logContent}\n`);
            }
            logPrinted = true;
        } catch {
            // ignore missing log file
        }
    };

    try {
        await Exec('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', launcher], { silent: true, showCommand: true });
    } catch (error) {
        await emitLog();
        throw error;
    } finally {
        await emitLog();

        try {
            await fs.promises.unlink(scriptPath);
        } catch {
            // ignore cleanup errors
        }

        try {
            await fs.promises.unlink(logPath);
        } catch {
            // ignore cleanup errors
        }
    }
}

async function runSdkManagerElevatedPosix(sdkManagerPath: string, javaPath: string, args: string[]): Promise<void> {
    const tempDir = GetTempDir();
    await fs.promises.mkdir(tempDir, { recursive: true });
    const uniqueId = `sdkmanager-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const scriptPath = path.join(tempDir, `unity-cli-${uniqueId}.sh`);
    const escapeForBash = (value: string): string => value.replace(/'/g, `'"'"'`);
    const argsArray = args.map(arg => `'${escapeForBash(arg)}'`).join(' ');
    const scriptContents = `#!/usr/bin/env bash
set -eu

export JAVA_HOME='${escapeForBash(javaPath)}'
export JDK_HOME='${escapeForBash(javaPath)}'
export SKIP_JDK_VERSION_CHECK='true'
SDKMANAGER='${escapeForBash(sdkManagerPath)}'
ARGS=(${argsArray})

send_accept_buffer() {
  for i in $(seq 1 50); do
    printf 'y\n'
  done
}

run_sdkmanager() {
  if [ ${args.length} -eq 0 ]; then
    send_accept_buffer | "$SDKMANAGER"
  else
    send_accept_buffer | "$SDKMANAGER" "${ARGS[@]}"
  fi
}

run_sdkmanager
`;

    await fs.promises.writeFile(scriptPath, scriptContents, { encoding: 'utf8', mode: 0o700 });
    await fs.promises.chmod(scriptPath, 0o700);

    try {
        await new Promise<void>((resolve, reject) => {
            const child = spawn('sudo', ['-E', '/bin/bash', scriptPath], {
                stdio: ['inherit', 'pipe', 'pipe']
            });
            const sigintHandler = () => child.kill('SIGINT');
            const sigtermHandler = () => child.kill('SIGTERM');
            process.once('SIGINT', sigintHandler);
            process.once('SIGTERM', sigtermHandler);

            let hasCleanedUpListeners = false;
            function removeListeners(): void {
                if (hasCleanedUpListeners) { return; }
                hasCleanedUpListeners = true;
                process.removeListener('SIGINT', sigintHandler);
                process.removeListener('SIGTERM', sigtermHandler);
            }

            const handleDataStream = (data: Buffer): void => {
                const chunk = data.toString();
                process.stdout.write(chunk);
            };

            child.stdout.on('data', handleDataStream);
            child.stderr.on('data', handleDataStream);
            child.on('error', (error) => {
                removeListeners();
                reject(error);
            });
            child.on('close', (code) => {
                removeListeners();
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`sudo bash ${scriptPath} failed with exit code ${code ?? -1}`));
                }
            });
        });
    } finally {
        try {
            await fs.promises.unlink(scriptPath);
        } catch {
            // ignore cleanup errors
        }
    }
}