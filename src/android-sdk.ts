import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { Logger } from './logging';
import { UnityEditor } from './unity-editor';
import {
    ReadFileContents,
    ResolveGlobToPath
} from './utilities';

const logger = Logger.instance;

/**
 * Checks if the required Android SDK is installed for the given Unity Editor and Project.
 * @param editorPath The path to the Unity Editor executable.
 * @param projectPath The path to the Unity project.
 * @returns A promise that resolves when the check is complete.
 */
export async function CheckAndroidSdkInstalled(editorPath: string, projectPath: string): Promise<void> {
    logger.ci(`Checking Android SDK installation for:\n  > Editor: ${editorPath}\n  > Project: ${projectPath}`);
    let sdkPath = undefined;
    await createRepositoryCfg();
    const rootEditorPath = UnityEditor.GetEditorRootPath(editorPath);
    const projectSettingsPath = path.join(projectPath, 'ProjectSettings/ProjectSettings.asset');
    const projectSettingsContent = await ReadFileContents(projectSettingsPath);
    const matchResult = projectSettingsContent.match(/(?<=AndroidTargetSdkVersion: )\d+/);
    const androidTargetSdk = matchResult ? parseInt(matchResult[0]) : 0;
    logger.ci(`AndroidTargetSdkVersion:\n  > ${androidTargetSdk}`);

    if (androidTargetSdk === undefined || androidTargetSdk === 0) { return; }

    sdkPath = await getAndroidSdkPath(rootEditorPath, androidTargetSdk);

    if (sdkPath) {
        logger.ci(`Target Android SDK android-${androidTargetSdk} Installed in:\n  > "${sdkPath}"`);
        return;
    }

    logger.info(`Installing Android Target SDK:\n  > android-${androidTargetSdk}`);
    const sdkManagerPath = await getSdkManager(rootEditorPath);
    const javaSdk = await getJDKPath(rootEditorPath);
    await execSdkManager(sdkManagerPath, javaSdk, ['--licenses']);
    await execSdkManager(sdkManagerPath, javaSdk, ['--update']);
    await execSdkManager(sdkManagerPath, javaSdk, ['platform-tools', `platforms;android-${androidTargetSdk}`]);
    sdkPath = await getAndroidSdkPath(rootEditorPath, androidTargetSdk);

    if (!sdkPath) {
        throw new Error(`Failed to install android-${androidTargetSdk} in ${rootEditorPath}`);
    }

    logger.ci(`Target Android SDK Installed in:\n  > "${sdkPath}"`);

}

async function createRepositoryCfg(): Promise<void> {
    const androidPath = path.join(os.homedir(), '.android');
    await fs.promises.mkdir(androidPath, { recursive: true });
    const fileHandle = await fs.promises.open(path.join(androidPath, 'repositories.cfg'), 'w');
    await fileHandle.close();
}

async function getJDKPath(rootEditorPath: string): Promise<string> {
    const jdkPath = await ResolveGlobToPath([rootEditorPath, '**', 'AndroidPlayer', 'OpenJDK']);

    if (!jdkPath) {
        throw new Error(`Failed to resolve OpenJDK in ${rootEditorPath}`);
    }

    await fs.promises.access(jdkPath, fs.constants.R_OK);
    logger.ci(`jdkPath:\n  > "${jdkPath}"`);
    return jdkPath;
}

async function getSdkManager(rootEditorPath: string): Promise<string> {
    let globPath: string[] = [];
    switch (process.platform) {
        case 'darwin':
        case 'linux':
            globPath = [rootEditorPath, '**', 'AndroidPlayer', '**', 'sdkmanager'];
            break;
        case 'win32':
            globPath = [rootEditorPath, '**', 'AndroidPlayer', '**', 'sdkmanager.bat'];
            break;
        default:
            throw new Error(`Unsupported platform: ${process.platform}`);
    }
    const sdkmanagerPath = await ResolveGlobToPath(globPath);

    if (!sdkmanagerPath) {
        throw new Error(`Failed to resolve sdkmanager in ${globPath}`);
    }

    await fs.promises.access(sdkmanagerPath, fs.constants.R_OK);
    logger.ci(`sdkmanagerPath:\n  > "${sdkmanagerPath}"`);
    return sdkmanagerPath;
}

async function getAndroidSdkPath(rootEditorPath: string, androidTargetSdk: number): Promise<string | undefined> {
    logger.ci(`Attempting to locate Android SDK Path...\n  > editorPath: ${rootEditorPath}\n  > androidTargetSdk: ${androidTargetSdk}`);
    let sdkPath: string;

    try {
        sdkPath = await ResolveGlobToPath([rootEditorPath, '**', 'PlaybackEngines', 'AndroidPlayer', 'SDK', 'platforms', `android-${androidTargetSdk}/`]);
        await fs.promises.access(sdkPath, fs.constants.R_OK);
    } catch (error) {
        logger.debug(`android-${androidTargetSdk} not installed`);
        return undefined;
    }

    logger.ci(`Android sdkPath:\n  > "${sdkPath}"`);
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
        exitCode = await new Promise<number>((resolve, reject) => {
            const child = spawn(sdkManagerPath, args, {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: {
                    ...process.env,
                    JAVA_HOME: process.platform === 'win32' ? `"${javaPath}"` : javaPath
                }
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
                process.stderr.write(chunk);
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