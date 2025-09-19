import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { UnityEditor } from './unity-editor';
import {
    ReadFileContents,
    ResolveGlobToPath
} from './utilities';
import {
    Logger,
    LogLevel
} from './logging';

const logger = Logger.instance;

/**
 * Checks if the required Android SDK is installed for the given Unity Editor and Project.
 * @param editorPath The path to the Unity Editor executable.
 * @param projectPath The path to the Unity project.
 * @returns A promise that resolves when the check is complete.
 */
export async function CheckAndroidSdkInstalled(editorPath: string, projectPath: string): Promise<void> {
    logger.debug(`Checking Android SDK installation for:\n  > Editor: ${editorPath}\n  > Project: ${projectPath}`);
    let sdkPath = undefined;
    await createRepositoryCfg();
    const rootEditorPath = await UnityEditor.GetEditorRootPath(editorPath);
    const projectSettingsPath = path.join(projectPath, 'ProjectSettings/ProjectSettings.asset');
    const projectSettingsContent = await ReadFileContents(projectSettingsPath);
    const matchResult = projectSettingsContent.match(/(?<=AndroidTargetSdkVersion: )\d+/);
    const androidTargetSdk = matchResult ? parseInt(matchResult[0]) : 0;
    logger.debug(`AndroidTargetSdkVersion:\n  > ${androidTargetSdk}`);

    if (androidTargetSdk === undefined || androidTargetSdk === 0) { return; }

    logger.debug('Validating Android Target SDK Installed...');
    sdkPath = await getAndroidSdkPath(rootEditorPath, androidTargetSdk);

    if (sdkPath) {
        logger.debug(`Target Android SDK android-${androidTargetSdk} Installed in:\n  > "${sdkPath}"`);
        return;
    }

    logger.debug(`Installing Android Target SDK:\n  > android-${androidTargetSdk}`);
    const sdkManagerPath = await getSdkManager(rootEditorPath);
    const javaSdk = await getJDKPath(rootEditorPath);
    await execSdkManager(sdkManagerPath, javaSdk, ['--licenses']);
    await execSdkManager(sdkManagerPath, javaSdk, ['--update']);
    await execSdkManager(sdkManagerPath, javaSdk, ['platform-tools', `platforms;android-${androidTargetSdk}`]);
    sdkPath = await getAndroidSdkPath(rootEditorPath, androidTargetSdk);

    if (!sdkPath) {
        throw new Error(`Failed to install android-${androidTargetSdk} in ${rootEditorPath}`);
    }

    logger.debug(`Target Android SDK Installed in:\n  > "${sdkPath}"`);

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
    logger.debug(`jdkPath:\n  > "${jdkPath}"`);
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
    logger.debug(`sdkmanagerPath:\n  > "${sdkmanagerPath}"`);
    return sdkmanagerPath;
}

async function getAndroidSdkPath(rootEditorPath: string, androidTargetSdk: number): Promise<string | undefined> {
    logger.debug(`Attempting to locate Android SDK Path...\n  > editorPath: ${rootEditorPath}\n  > androidTargetSdk: ${androidTargetSdk}`);
    const sdkPath = await ResolveGlobToPath([rootEditorPath, '**', 'AndroidPlayer', '**', `android-${androidTargetSdk}`]);
    try {
        await fs.promises.access(sdkPath, fs.constants.R_OK);
    } catch (error) {
        logger.debug(`android-${androidTargetSdk} not installed`);
        return undefined;
    }
    logger.debug(`sdkPath:\n  > "${sdkPath}"`);
    return sdkPath;
}

async function execSdkManager(sdkManagerPath: string, javaPath: string, args: string[]): Promise<void> {
    const acceptBuffer = Buffer.from(Array(10).fill('y').join(os.EOL), 'utf8');
    let output = '';
    let exitCode = 0;

    try {
        exitCode = await new Promise<number>((resolve, reject) => {
            if (logger.logLevel === LogLevel.DEBUG) {
                logger.info(`\x1b[34m${sdkManagerPath} ${args.join(' ')}\x1b[0m`);
            }

            const child = spawn(sdkManagerPath, args, {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env, JAVA_HOME: javaPath }
            });

            child.stdout.on('data', (data: Buffer) => {
                const chunk = data.toString();
                output += chunk;

                if (output.includes('Accept? (y/N):')) {
                    child.stdin?.write(acceptBuffer);
                    output = '';
                }

                logger.debug(chunk);
            });

            child.stderr.on('data', (data: Buffer) => {
                const chunk = data.toString();
                output += chunk;
                logger.error(chunk);
            });

            child.on('error', (error: Error) => {
                reject(error);
            });

            child.on('close', (code: number | null) => {
                resolve(code === null ? 0 : code);
            });
        });
    } finally {
        if (exitCode !== 0) {
            throw new Error(`${sdkManagerPath} ${args.join(' ')} failed with exit code ${exitCode}`);
        }
    }
}