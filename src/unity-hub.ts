import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';
import * as asar from '@electron/asar';
import { spawn } from 'child_process';
import { Logger, LogLevel } from './logging';
import { UnityEditor } from './unity-editor';
import { UnityVersion } from './unity-version';
import {
    SemVer,
    coerce,
    compare,
    valid
} from 'semver';
import {
    DeleteDirectory,
    DownloadFile,
    Exec,
    ExecOptions,
    ReadFileContents,
    GetTempDir,
} from './utilities';
import {
    UnityReleasesClient,
    GetUnityReleasesData,
    UnityRelease,
} from '@rage-against-the-pixel/unity-releases-api';

interface ReleaseInfo {
    unityRelease: UnityRelease;
    unityVersion: UnityVersion;
}

export class UnityHub {
    /** The path to the Unity Hub executable. */
    public readonly executable: string;
    /** The root directory of the Unity Hub installation. */
    public readonly rootDirectory: string;
    /** The file extension for the Unity editor executable. */
    public readonly editorFileExtension: string;

    private readonly logger: Logger = Logger.instance;

    constructor() {
        switch (process.platform) {
            case 'win32':
                this.executable = process.env.UNITY_HUB_PATH || 'C:\\Program Files\\Unity Hub\\Unity Hub.exe';
                this.rootDirectory = path.join(this.executable, '../');
                this.editorFileExtension = '\\Editor\\Unity.exe';
                break;
            case 'darwin':
                this.executable = process.env.UNITY_HUB_PATH || '/Applications/Unity Hub.app/Contents/MacOS/Unity Hub';
                this.rootDirectory = path.join(this.executable, '../../../');
                this.editorFileExtension = '/Unity.app/Contents/MacOS/Unity';
                break;
            case 'linux':
                this.executable = process.env.UNITY_HUB_PATH || '/opt/unityhub/unityhub';
                this.rootDirectory = path.join(this.executable, '../');
                this.editorFileExtension = '/Editor/Unity';
                break;
            default:
                throw new Error(`Unsupported platform: ${process.platform}`);
        }
    }

    /**
     * Executes the Unity Hub command with the specified arguments.
     * @param args Arguments to pass to the Unity Hub executable.
     * @param silent If true, suppresses output logging.
     * @returns The output from the command.
     */
    public async Exec(args: string[], options: ExecOptions = { silent: this.logger.logLevel > LogLevel.CI, showCommand: this.logger.logLevel <= LogLevel.CI }): Promise<string> {
        let output: string = '';
        let exitCode: number = 0;

        const filteredArgs = args.filter(arg => arg !== '--headless' && arg !== '--');
        const executable = process.platform === 'linux' ? 'unity-hub' : this.executable;
        const execArgs = process.platform === 'linux' ? ['--headless', ...filteredArgs] : ['--', '--headless', ...filteredArgs];

        if (options.showCommand) {
            this.logger.startGroup(`\x1b[34m${executable} ${execArgs.join(' ')}\x1b[0m`);
        }

        if (this.executable.includes(path.sep)) {
            fs.accessSync(this.executable, fs.constants.R_OK | fs.constants.X_OK);
        }

        const ignoredLines = [
            'This error originated either by throwing inside of an async function without a catch block',
            'Unexpected error attempting to determine if executable file exists',
            'dri3 extension not supported',
            'Failed to connect to the bus:',
            'Error: No modules found to install.',
            'Checking for beta autoupdate feature for deb/rpm distributions',
            'Found package-type: deb',
            'XPC error for connection com.apple.backupd.sandbox.xpc: Connection invalid',
            'Failed to execute the command due the following, please see \'-- --headless help\' for assistance.',
            'Unable to move the cache: Access is denied.',
            'Entities without keys will be embedded directly on the parent entity. If this is intentional, create a `keys` config for `UnityReleaseLabel` that always returns null.',
            'https://bit.ly/2XbVrpR#15',
            'Interaction is not allowed with the Security Server." (-25308)',
            'Network service crashed, restarting service.',
            'Invalid key: The GraphQL query at the field at',
            'You have to request `id` or `_id` fields for all selection sets or create a custom `keys` config for `UnityReleaseLabel`.',
        ];

        try {
            exitCode = await new Promise<number>((resolve, reject) => {
                let isSettled: boolean = false; // Has the promise been settled (resolved or rejected)?
                let isHubTaskCompleteSuccess: boolean = false; // Has the Unity Hub tasks completed successfully?
                let isHubTaskCompleteFailed: boolean = false; // Has the Unity Hub tasks completed with failure?
                let lineBuffer = ''; // Buffer for incomplete lines
                const tasksCompleteMessages: string[] = [
                    'All Tasks Completed Successfully.',
                    'Completed with errors.'
                ];
                const child = spawn(executable, execArgs, {
                    stdio: ['ignore', 'pipe', 'pipe']
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

                function processOutput(data: Buffer): void {
                    try {
                        const chunk = data.toString();
                        const fullChunk = lineBuffer + chunk;
                        const lines = fullChunk.split(/\r?\n/) // split by newline
                            .filter(line => line.length > 0); // filter out empty lines

                        if (!chunk.endsWith('\n')) {
                            lineBuffer = lines.pop() || '';
                        } else {
                            lineBuffer = '';
                        }

                        if (lines.some(line => tasksCompleteMessages.includes(line))) {
                            isHubTaskCompleteSuccess = lines.includes('All Tasks Completed Successfully.');
                            isHubTaskCompleteFailed = lines.includes('Completed with errors.');

                            if (child?.pid) {
                                try {
                                    child.kill('SIGTERM');

                                    setTimeout(() => {
                                        try {
                                            if (child?.pid && !child.killed) {
                                                child.kill('SIGKILL');
                                            }
                                        } catch {
                                            // Ignore, process may have already exited
                                        }
                                    }, 1000);
                                } catch {
                                    // Ignore, process may have already exited
                                } finally {
                                    if (isHubTaskCompleteSuccess) {
                                        settle(0);
                                    } else if (isHubTaskCompleteFailed) {
                                        settle(1);
                                    } else {
                                        settle(null);
                                    }
                                }
                            }
                        }

                        for (const line of lines) {
                            output += `${line}\n`;

                            if (!options.silent && !ignoredLines.some(ignored => line.includes(ignored))) {
                                process.stdout.write(`${line}\n`);
                            }
                        }
                    } catch (error: any) {
                        if (error.code !== 'EPIPE') {
                            throw error;
                        }
                    }
                }

                function flushOutput(): void {
                    try {
                        if (lineBuffer.length > 0) {
                            const lines = lineBuffer.split(/\r?\n/) // split by newline
                                .filter(line => line.length > 0); // filter out empty lines
                            lineBuffer = '';
                            const outputLines = lines.filter(line => !ignoredLines.some(ignored => line.includes(ignored)));

                            if (outputLines.some(line => tasksCompleteMessages.includes(line))) {
                                isHubTaskCompleteSuccess = outputLines.includes('All Tasks Completed Successfully.');
                                isHubTaskCompleteFailed = outputLines.includes('Completed with errors.');
                            }

                            for (const line of outputLines) {
                                output += `${line}\n`;

                                if (!options.silent) {
                                    process.stdout.write(`${line}\n`);
                                }
                            }
                        }
                    } catch (error: any) {
                        if (error.code !== 'EPIPE') {
                            Logger.instance.error(`Failed to process buffered output: ${error}`);
                        }
                    }
                }

                function settle(code: number | null): void {
                    if (isSettled) { return; }
                    isSettled = true;
                    removeListeners();
                    flushOutput();
                    resolve(code === null ? 0 : code);
                }

                child.stdout.on('data', processOutput);
                child.stderr.on('data', processOutput);
                child.on('error', (error) => {
                    isSettled = true;
                    removeListeners();
                    flushOutput();
                    reject(error);
                });
                child.on('close', settle);
            });
        } finally {
            this.logger.endGroup();
            const match = output.match(/Assertion (?<assert>.+) failed/g);
            const retryConditions = [
                'async hook stack has become corrupted',
                'failed to download'
            ];

            if (match ||
                retryConditions.some(s => output.includes(s))) {
                this.logger.warn(`Install failed, retrying...`);
                return await this.Exec(args);
            }

            if (exitCode > 0) {
                const error = output.match(/Error(?: given)?:\s*(.+)/);
                const errorMessage = error && error[1] ? error[1] : 'Unknown Error';

                switch (errorMessage) {
                    case 'No modules found to install.':
                        break;
                    default:
                        this.logger.debug(output);
                        throw new Error(`Failed to execute Unity Hub (exit code: ${exitCode}) ${errorMessage}`);
                }
            }

            output = output.split('\n')
                .filter(line => line.trim().length > 0)
                .filter(line => !ignoredLines.some(ignored => line.includes(ignored)))
                .join('\n');
        }

        return output;
    }

    /**
     * Prints the installed Unity Hub version.
     * @returns The installed Unity Hub version.
     */
    public async Version(): Promise<string> {
        const version = await this.getInstalledHubVersion();
        return version.version;
    }

    /**
     * Installs or updates the Unity Hub.
     * If the Unity Hub is already installed, it will be updated to the latest version.
     * @param autoUpdate If true, automatically updates the Unity Hub if it is already installed. Default is true.
     * @returns The path to the Unity Hub executable.
     */
    public async Install(autoUpdate: boolean = true, version: string | undefined): Promise<string> {
        if (autoUpdate && version) {
            throw new Error('Cannot use autoUpdate with version.');
        }

        let isInstalled = false;
        let installedVersion: SemVer | undefined = undefined;

        try {
            await fs.promises.access(this.executable, fs.constants.X_OK);
            installedVersion = await this.getInstalledHubVersion();
            isInstalled = true;
        } catch {
            await this.installHub(version);
        }

        if (isInstalled && autoUpdate) {
            if (!installedVersion) {
                installedVersion = await this.getInstalledHubVersion();
            }

            this.logger.ci(`Installed Unity Hub version: ${installedVersion.version}`);
            let versionToInstall: SemVer | null = null;

            if (!version) {
                try {
                    versionToInstall = await this.getLatestHubVersion();
                    this.logger.ci(`Latest Unity Hub version: ${versionToInstall.version}`);
                } catch (error) {
                    this.logger.warn(`Failed to get latest Unity Hub version: ${error}`);
                }
            } else {
                versionToInstall = coerce(version);
            }

            if (versionToInstall === null ||
                !versionToInstall &&
                !valid(versionToInstall)) {
                throw new Error(`Invalid Unity Hub version to install: ${versionToInstall}`);
            }

            const mustInstall = version || (versionToInstall && compare(installedVersion, versionToInstall) < 0);

            if (mustInstall) {
                this.logger.info(`Updating Unity Hub from ${installedVersion.version} to ${versionToInstall.version}...`);

                if (process.platform === 'darwin') {
                    await Exec('sudo', ['rm', '-rf', this.rootDirectory], { silent: true, showCommand: true });
                    await this.installHub(version);
                } else if (process.platform === 'win32') {
                    const uninstaller = path.join(this.rootDirectory, 'Uninstall Unity Hub.exe');
                    await Exec('powershell', [
                        '-NoProfile',
                        '-Command',
                        `Start-Process -FilePath '${uninstaller}' -ArgumentList '/S' -Verb RunAs -Wait`
                    ], { silent: true, showCommand: true });
                    await DeleteDirectory(this.rootDirectory);
                    await this.installHub(version);
                } else if (process.platform === 'linux') {
                    await Exec('sudo', ['sh', '-c', `#!/bin/bash
set -e
wget -qO - https://hub.unity3d.com/linux/keys/public | gpg --dearmor | sudo tee /usr/share/keyrings/Unity_Technologies_ApS.gpg >/dev/null
sudo sh -c 'echo "deb [signed-by=/usr/share/keyrings/Unity_Technologies_ApS.gpg] https://hub.unity3d.com/linux/repos/deb stable main" > /etc/apt/sources.list.d/unityhub.list'
sudo apt-get update --allow-releaseinfo-change
sudo apt-get install -y --no-install-recommends --only-upgrade unityhub${version ? '=' + version : ''}`]);
                } else {
                    throw new Error(`Unsupported platform: ${process.platform}`);
                }
            } else {
                this.logger.info(`Unity Hub is already installed and up to date.`);
            }
        }

        await fs.promises.access(this.executable, fs.constants.X_OK);
        return this.executable;
    }

    private async installHub(version: SemVer | string | undefined): Promise<void> {
        this.logger.ci(`Installing Unity Hub${version ? ' ' + version : ''}...`);

        if (!version) {
            switch (process.platform) {
                case 'win32':
                case 'darwin':
                    version = 'prod';
                    break;
            }
        }

        switch (process.platform) {
            case 'win32': {
                const url = `https://public-cdn.cloud.unity3d.com/hub/${version}/UnityHubSetup.exe`;
                const downloadPath = path.join(GetTempDir(), 'UnityHubSetup.exe');
                await DownloadFile(url, downloadPath);

                this.logger.info(`Running Unity Hub installer...`);

                try {
                    await Exec('powershell', [
                        '-NoProfile',
                        '-Command',
                        `Start-Process -FilePath '${downloadPath}' -ArgumentList '/S' -Verb RunAs -Wait`
                    ], { silent: true, showCommand: true });
                } finally {
                    if (fs.statSync(downloadPath).isFile()) {
                        await fs.promises.unlink(downloadPath);
                    }
                }

                break;
            }
            case 'darwin': {
                const baseUrl = `https://public-cdn.cloud.unity3d.com/hub/${version}`;
                const url = `${baseUrl}/UnityHubSetup-${process.arch}.dmg`;
                const downloadPath = path.join(GetTempDir(), `UnityHubSetup-${process.arch}.dmg`);

                await DownloadFile(url, downloadPath);
                await fs.promises.chmod(downloadPath, 0o777);

                let mountPoint = '';
                this.logger.debug(`Mounting DMG...`);

                try {
                    const output = await Exec('hdiutil', ['attach', downloadPath, '-nobrowse'], { silent: true, showCommand: true });
                    // can be "/Volumes/Unity Hub 3.13.1-arm64" or "/Volumes/Unity Hub 3.13.1"
                    const mountPointMatch = output.match(/\/Volumes\/Unity Hub.*$/m);

                    if (!mountPointMatch || mountPointMatch.length === 0) {
                        throw new Error(`Failed to find mount point in hdiutil output: ${output}`);
                    }

                    mountPoint = mountPointMatch[0];
                    this.logger.debug(`Mounted Unity Hub at ${mountPoint}`);

                    const appPath = path.join(mountPoint, 'Unity Hub.app');
                    this.logger.debug(`Copying ${appPath} to /Applications...`);

                    await fs.promises.access(appPath, fs.constants.R_OK | fs.constants.X_OK);
                    if (fs.existsSync('/Applications/Unity Hub.app')) {
                        await Exec('sudo', ['rm', '-rf', '/Applications/Unity Hub.app'], { silent: true, showCommand: true });
                    }
                    await Exec('sudo', ['cp', '-R', appPath, '/Applications/Unity Hub.app'], { silent: true, showCommand: true });
                    await Exec('sudo', ['chmod', '777', '/Applications/Unity Hub.app/Contents/MacOS/Unity Hub'], { silent: true, showCommand: true });
                    await Exec('sudo', ['mkdir', '-p', '/Library/Application Support/Unity'], { silent: true, showCommand: true });
                    await Exec('sudo', ['chmod', '777', '/Library/Application Support/Unity'], { silent: true, showCommand: true });
                } finally {
                    try {
                        if (mountPoint && mountPoint.length > 0) {
                            await Exec('hdiutil', ['detach', mountPoint, '-quiet'], { silent: true, showCommand: true });
                        }
                    } finally {
                        if (fs.statSync(downloadPath).isFile()) {
                            await fs.promises.unlink(downloadPath);
                        }
                    }
                }
                break;
            }
            case 'linux': {
                await Exec('sudo', ['sh', '-c', `#!/bin/bash
set -e
dbus-uuidgen >/etc/machine-id && mkdir -p /var/lib/dbus/ && ln -sf /etc/machine-id /var/lib/dbus/machine-id
wget -qO - https://hub.unity3d.com/linux/keys/public | gpg --dearmor | tee /usr/share/keyrings/Unity_Technologies_ApS.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/Unity_Technologies_ApS.gpg] https://hub.unity3d.com/linux/repos/deb stable main" > /etc/apt/sources.list.d/unityhub.list
echo "deb https://archive.ubuntu.com/ubuntu jammy main universe" | tee /etc/apt/sources.list.d/jammy.list
apt-get update
apt-get install -y --no-install-recommends \\
  unityhub${version ? '=' + version : ''} \\
  xvfb \\
  ffmpeg \\
  libgtk2.0-0 \\
  libglu1-mesa \\
  libgconf-2-4 \\
  libncurses5 \\
  pulseaudio
apt-get clean
sed -i 's/^\\(.*DISPLAY=:.*XAUTHORITY=.*\\)\\( "\\$@" \\)2>&1$/\\1\\2/' /usr/bin/xvfb-run
printf '#!/bin/bash\nxvfb-run --auto-servernum /opt/unityhub/unityhub "$@" 2>/dev/null' | tee /usr/bin/unity-hub >/dev/null
chmod 777 /usr/bin/unity-hub
which unityhub || { echo "Unity Hub installation failed"; exit 1; }
hubPath=$(which unityhub)

if [ -z "$hubPath" ]; then
    echo "Failed to install Unity Hub"
    exit 1
fi

chmod -R 777 "$hubPath"`]);
                break;
            }
            default:
                throw new Error(`Unsupported platform: ${process.platform}`);
        }

        await fs.promises.access(this.executable, fs.constants.X_OK);
        const installedVersion = await this.getInstalledHubVersion();
        this.logger.info(`Unity Hub ${installedVersion} installed successfully.`);
    }

    private async getInstalledHubVersion(): Promise<SemVer> {
        let asarPath: string | undefined = undefined;

        switch (process.platform) {
            case 'darwin': {
                asarPath = path.join(this.rootDirectory, 'Contents', 'Resources', 'app.asar');
                break;
            }
            default: {
                asarPath = path.join(this.rootDirectory, 'resources', 'app.asar');
                break;
            }
        }

        try {
            await fs.promises.access(asarPath, fs.constants.R_OK);
        } catch {
            throw new Error('Unity Hub is not installed.');
        }

        asar.uncacheAll();
        const fileBuffer = asar.extractFile(asarPath, 'package.json').toString('utf-8');
        let packageJson: any;

        try {
            packageJson = JSON.parse(fileBuffer);
        } catch (error) {

            throw new Error(`Failed to parse Unity Hub package.json: ${error}\n${fileBuffer}`);
        }

        const version = coerce(packageJson.version);

        if (!version || !valid(version)) {
            throw new Error(`Failed to parse Unity Hub version: ${packageJson.version}`);
        }

        return version;
    }

    private async getLatestHubVersion(): Promise<SemVer> {
        let url: string | undefined = undefined;

        switch (process.platform) {
            case 'win32':
                url = 'https://public-cdn.cloud.unity3d.com/hub/prod/latest.yml';
                break;
            case 'darwin':
                url = 'https://public-cdn.cloud.unity3d.com/hub/prod/latest-mac.yml';
                break;
            case 'linux':
                url = 'https://public-cdn.cloud.unity3d.com/hub/prod/latest-linux.yml';
                break;
            default:
                throw new Error(`Unsupported platform: ${process.platform}`);
        }

        const response = await fetch(url);
        const data = await response.text();
        const parsed = yaml.parse(data);
        const version = coerce(parsed.version);

        if (!version || !valid(version)) {
            throw new Error(`Failed to parse latest Unity Hub version: ${parsed.version}`);
        }

        return version;
    }

    /**
     * Returns the path where the Unity editors will be installed.
     * @returns The editor install path.
     */
    public async GetInstallPath(): Promise<string> {
        const result = (await this.Exec(['install-path', '--get'])).trim();

        if (!result || result.length === 0) {
            throw new Error('Failed to get Unity Hub install path.');
        }

        return result;
    }

    /**
     * Sets the path where Unity editors will be installed.
     * @param installPath The install path to set when installing Unity editors.
     */
    public async SetInstallPath(installPath: string): Promise<void> {
        await fs.promises.mkdir(installPath, { recursive: true });
        await this.Exec(['install-path', '--set', installPath]);
    }

    /**
     * Locate and associate an installed editor from a stipulated path.
     * @param editorPath The path to the Unity Editor installation.
     */
    public async AddEditor(editorPath: string): Promise<void> {
        await fs.promises.access(editorPath, fs.constants.R_OK | fs.constants.X_OK);
        await this.Exec(['editors', '--add', editorPath]);
    }

    /**
     * Attempts to find or install the specified Unity Editor version with the requested modules.
     * @param unityVersion The Unity version to find or install.
     * @param modules The modules to install alongside the editor.
     * @param channels The channels to consider when searching for the editor. Can be 'f' (final), 'p' (patch), 'b' (beta), 'a' (alpha), or 'x' (experimental). Default is ['f'].
     * @returns The path to the Unity Editor executable.
     */
    public async GetEditor(unityVersion: UnityVersion, modules: string[] = [], channels: string[] = ['f']): Promise<UnityEditor> {
        const retryErrorMessages = [
            'Editor already installed in this location',
            'failed to download. Error given: Request timeout'
        ];

        this.logger.ci(`Getting release info for Unity ${unityVersion.toString()}...`);
        let resolvedVersion = unityVersion;

        if (!resolvedVersion.isLegacy()) {
            try {
                if (!resolvedVersion.isFullyQualified()) {
                    const releases = await this.ListAvailableReleases();
                    Logger.instance.debug(`Found ${releases.length} available Unity releases, searching channels: ${channels.join(', ')}`);
                    resolvedVersion = resolvedVersion.findMatch(releases, channels);
                }

                if (!resolvedVersion?.changeset) {
                    const unityReleaseInfo: UnityRelease = await this.GetEditorReleaseInfo(resolvedVersion);
                    resolvedVersion = new UnityVersion(unityReleaseInfo.version, unityReleaseInfo.shortRevision, resolvedVersion.architecture);
                }
            } catch (error) {
                this.logger.warn(`Failed to get Unity release info for ${resolvedVersion.toString()}! falling back to legacy search...\n${error}`);
                try {
                    resolvedVersion = await this.fallbackVersionLookup(resolvedVersion);
                } catch (fallbackError) {
                    this.logger.warn(`Failed to lookup changeset for Unity ${resolvedVersion.toString()}!\n${fallbackError}`);
                }
            }
        }

        const allowPartialMatches = !resolvedVersion.isFullyQualified();
        let editorPath = await this.checkInstalledEditors(resolvedVersion, false, undefined, allowPartialMatches);
        unityVersion = resolvedVersion;

        let installDir: string | undefined = undefined;

        if (!editorPath) {
            try {
                installDir = await this.installUnity(unityVersion, modules);
            } catch (error: Error | any) {
                if (retryErrorMessages.some(msg => error.message.includes(msg))) {
                    if (editorPath) {
                        await DeleteDirectory(editorPath);
                    }

                    if (installDir) {
                        await DeleteDirectory(installDir);
                    }

                    installDir = await this.installUnity(unityVersion, modules);
                } else {
                    throw error;
                }
            }

            editorPath = await this.checkInstalledEditors(unityVersion, true, installDir);
        }

        if (!editorPath) {
            throw new Error(`Failed to find or install Unity Editor: ${unityVersion.toString()}`);
        }

        await fs.promises.access(editorPath, fs.constants.X_OK);
        await this.patchBeeBackend(editorPath);

        if (unityVersion.isLegacy() || modules.length === 0) {
            return new UnityEditor(path.normalize(editorPath), unityVersion);
        }

        try {
            this.logger.info(`Validating installed modules for Unity ${unityVersion.toString()}...`);
            const [installedModules, additionalModules] = await this.checkEditorModules(editorPath, unityVersion, modules);

            if (installedModules && installedModules.length > 0) {
                this.logger.info(`Installed Modules:`);

                for (const module of installedModules) {
                    this.logger.info(`  > ${module}`);
                }
            }

            if (additionalModules && additionalModules.length > 0) {
                this.logger.info(`Additional Modules:`);

                for (const module of additionalModules) {
                    this.logger.info(`  > ${module}`);
                }
            }
        } catch (error: Error | any) {
            if (error.message.includes(`No modules found`)) {
                await DeleteDirectory(editorPath);
                await this.GetEditor(unityVersion, modules);
            } else {
                throw error;
            }
        }

        return new UnityEditor(path.normalize(editorPath), unityVersion);
    }

    /**
     * Lists the installed Unity Editors.
     * @returns A list of installed Unity Editor versions and their paths.
     */
    public async ListInstalledEditors(): Promise<UnityEditor[]> {
        const output = await this.Exec(['editors', '-i']);
        const paths = output.split('\n')
            .filter(line => /installed at/.test(line))
            .map(line => line.trim());
        const editors: UnityEditor[] = [];
        const pattern = /(?<version>\d+\.\d+\.\d+[abcfpx]?\d*)\s*(?:\((?<arch>Apple silicon|Intel)\))?\s*,? installed at (?<editorPath>.*)/;
        const matches = paths.map(path => path.match(pattern)).filter(match => match && match.groups);

        if (paths.length !== matches.length) {
            throw new Error(`Failed to parse all installed Unity Editors!\n > paths: ${JSON.stringify(paths)}\n  > matches: ${JSON.stringify(matches)}`);
        }

        for (const match of matches) {
            if (match && match.groups && match.groups.version && match.groups.editorPath) {
                const version = new UnityVersion(match.groups.version, null, match.groups.arch === 'Apple silicon' ? 'ARM64' : match.groups.arch === 'Intel' ? 'X86_64' : undefined);
                editors.push(new UnityEditor(path.normalize(match.groups.editorPath), version));
            }
        }

        // Sort editors descending by UnityVersion so callers receive newest matches first
        editors.sort((a, b) => {
            if (!a.version && !b.version) { return 0; }
            if (!a.version) { return 1; }
            if (!b.version) { return -1; }
            return UnityVersion.compare(b.version!, a.version!);
        });

        return editors;
    }

    /**
     * Lists the available Unity releases.
     * @returns A list of available Unity release versions.
     */
    public async ListAvailableReleases(): Promise<UnityVersion[]> {
        const output = await this.Exec(['editors', '--releases']);
        // filter out version lines only 2021.3.45f2 (may include installed path following version)
        return output.split('\n')
            .map(line => line.trim())
            .map(line => {
                const match = line.match(/^(\d{1,4}\.\d+\.\d+[abcfpx]?\d*)/);
                return match ? match[1] : undefined;
            })
            .filter((line): line is string => !!line && /^\d{1,4}\.\d+\.\d+[abcfpx]?\d*/.test(line))
            .map(line => new UnityVersion(line!))
            .sort((a, b) => UnityVersion.compare(b, a)); // Sort descending by version
    }

    private async checkInstalledEditors(
        unityVersion: UnityVersion,
        failOnEmpty: boolean,
        installDir: string | undefined = undefined,
        allowPartialMatches: boolean = true
    ): Promise<string | undefined> {
        let editorPath = undefined;

        if (!installDir) {
            const editors: UnityEditor[] = await this.ListInstalledEditors();

            if (editors && editors.length > 0) {
                // Prefer exact version match first
                const exactEditor = editors.find(e => e.version && e.version.version === unityVersion.version);

                if (exactEditor) {
                    editorPath = exactEditor.editorPath;
                } else if (allowPartialMatches) {
                    // Fallback: semver satisfies
                    const versionEditors = editors.filter(e => e.version && unityVersion.satisfies(e.version));

                    if (versionEditors.length === 0) {
                        return undefined;
                    }

                    // ListInstalledEditors already returns editors sorted descending by version.
                    for (const editor of versionEditors) {
                        if (!editor.version || !editor.editorPath) {
                            continue;
                        }

                        // If no architecture requested or editor has no arch info, accept it
                        if (!unityVersion.architecture || !editor.version.architecture) {
                            editorPath = editor.editorPath;
                            break;
                        }

                        // Exact architecture match
                        if (unityVersion.architecture === editor.version.architecture) {
                            editorPath = editor.editorPath;
                            break;
                        }

                        // Fallback: check for architecture suffix in path (e.g., -arm64)
                        if (unityVersion.architecture && editor.editorPath.toLowerCase().includes(`-${unityVersion.architecture.toLowerCase()}`)) {
                            editorPath = editor.editorPath;
                            break;
                        }
                    }
                }
            }
        } else {
            if (process.platform == 'win32') {
                editorPath = path.join(installDir, 'Unity.exe');
            } else {
                editorPath = installDir;
            }
        }

        if (!editorPath) {
            if (failOnEmpty) {
                throw new Error(`Failed to find installed Unity Editor: ${unityVersion.toString()}`);
            }
            else {
                return undefined;
            }
        }

        if (process.platform === 'darwin') {
            editorPath = path.join(editorPath, '/Contents/MacOS/Unity');
        }

        try {
            await fs.promises.access(editorPath, fs.constants.R_OK | fs.constants.X_OK);
        } catch (error) {
            throw new Error(`Failed to find installed Unity Editor: ${unityVersion.toString()}\n  > ${error}`);
        }

        this.logger.debug(`Found installed editor: "${editorPath}"`);
        return editorPath;
    }

    /**
     * Patches the Bee Backend for Unity Linux Editor.
     * https://discussions.unity.com/t/linux-editor-stuck-on-loading-because-of-bee-backend-w-workaround/854480
     * @param editorPath The path to the Unity Editor executable.
     */
    private async patchBeeBackend(editorPath: string): Promise<void> {
        if (process.platform === 'linux') {
            const dataPath = path.join(path.dirname(editorPath), 'Data');
            const beeBackend = path.join(dataPath, 'bee_backend');
            const dotBeeBackend = path.join(dataPath, '.bee_backend');
            if (fs.existsSync(beeBackend) && !fs.existsSync(dotBeeBackend)) {
                this.logger.ci(`Patching Unity Linux Editor for Bee Backend...`);
                await fs.promises.rename(beeBackend, dotBeeBackend);
                const wrapperSource: string = `#!/bin/bash
# https://discussions.unity.com/t/linux-editor-stuck-on-loading-because-of-bee-backend-w-workaround/854480
set -e
args=("$@")
for ((i = 0; i < "\${#args[@]}"; ++i)); do
    case \${args[i]} in
    --stdin-canary)
        unset "args[i]"
        break
        ;;
    esac
done
"$(dirname "$0")/.$(basename "$0")" "\${args[@]}"`
                await fs.promises.writeFile(beeBackend, wrapperSource, { encoding: 'utf-8', mode: 0o755 });
            }
        }
    }

    /**
     * Gets the specified Unity release info from the Unity Releases API.
     * Supports querying by exact version or by prefix (e.g., "2020", "2020.1", "2021.x", "2021.3.x").
     * @param unityVersion The Unity version to get the release info for.
     * @returns The Unity release info.
     */
    public async GetEditorReleaseInfo(unityVersion: UnityVersion): Promise<UnityRelease> {
        // Prefer querying the releases API with the exact fully-qualified Unity version (e.g., 2022.3.10f1).
        // If we don't have a fully-qualified version, use the most specific prefix available:
        //  - "YYYY.M" when provided (e.g., 6000.1)
        //  - otherwise "YYYY"
        const fullUnityVersionPattern = /^\d{1,4}\.\d+\.\d+[abcfpx]\d+$/;
        let version: string;

        if (fullUnityVersionPattern.test(unityVersion.version)) {
            version = unityVersion.version;
        } else {
            const match = unityVersion.version.match(/^(\d{1,4})(?:\.(\d+))?/);

            if (match) {
                version = match[2] ? `${match[1]}.${match[2]}` : match[1]!;
            } else {
                version = unityVersion.version.split('.')[0]!;
            }
        }

        const releasesClient = new UnityReleasesClient();

        function getPlatform(): Array<('MAC_OS' | 'LINUX' | 'WINDOWS')> {
            switch (process.platform) {
                case 'darwin':
                    return ['MAC_OS'];
                case 'linux':
                    return ['LINUX'];
                case 'win32':
                    return ['WINDOWS'];
                default:
                    throw new Error(`Unsupported platform: ${process.platform}`);
            }
        }

        const request: GetUnityReleasesData = {
            url: '/unity/editor/release/v1/releases',
            query: {
                version: version,
                architecture: [unityVersion.architecture],
                platform: getPlatform(),
                limit: 10,
                order: 'RELEASE_DATE_DESC',
            }
        };

        this.logger.debug(`Get Unity Release: ${JSON.stringify(request, null, 2)}`);

        async function getRelease() {
            const { data, error } = await releasesClient.api.Release.getUnityReleases(request);

            if (error) {
                throw new Error(`Failed to get Unity releases: ${JSON.stringify(error, null, 2)}`);
            }

            if (!data || !data.results || data.results.length === 0) {
                throw new Error(`No Unity releases found for version: ${version}`);
            }

            // Filter to stable 'f' releases only unless the user explicitly asked for a pre-release
            const isExplicitPrerelease = /[abcpx]$/.test(unityVersion.version) || /[abcpx]/.test(unityVersion.version);
            const releases: ReleaseInfo[] = (data.results || [])
                .filter(release => isExplicitPrerelease || release.version.includes('f'))
                .map(release => ({
                    unityRelease: release,
                    unityVersion: new UnityVersion(release.version, release.shortRevision, unityVersion.architecture)
                }));

            if (releases.length === 0) {
                throw new Error(`No suitable Unity releases (stable) found for version: ${version}`);
            }

            releases.sort((a, b) => UnityVersion.compare(b.unityVersion, a.unityVersion));

            Logger.instance.debug(`Found ${releases.length} matching Unity releases for version: ${version}`);
            releases.forEach(release => {
                Logger.instance.debug(` - ${release.unityRelease.version} (${release.unityRelease.shortRevision}) - ${release.unityRelease.recommended}`);
            });
            const latest = releases[0]!.unityRelease!;
            return latest;
        }

        try {
            return await getRelease();
        } catch (error) {
            if (error instanceof Error && error.message.includes('fetch failed')) {
                // Transient network error, retry once
                return await getRelease();
            }

            throw new Error(`Failed to get Unity releases: ${error}`);
        }
    }

    private async fallbackVersionLookup(unityVersion: UnityVersion): Promise<UnityVersion> {
        if (!unityVersion.isFullyQualified()) {
            throw new Error(`Cannot lookup changeset for non-fully-qualified Unity version: ${unityVersion.toString()}`);
        }

        const url = `https://unity.com/releases/editor/whats-new/${unityVersion.version}`;
        this.logger.debug(`Fetching release page: "${url}"`);
        let response: Response;

        try {
            response = await fetch(url);
        } catch (error) {
            this.logger.warn(`Failed to fetch changeset for Unity ${unityVersion.toString()}: ${error}`);
            return unityVersion;
        }

        const responseText = await response.text();

        if (!response.ok) {
            this.logger.info(responseText);
        }

        if (!response.ok) {
            throw new Error(`Failed to fetch changeset for Unity ${unityVersion.toString()} [${response.status}] "${url}"`);
        }

        this.logger.debug(`Release page content: \n${responseText}`);
        const match = responseText.match(/unityhub:\/\/(?<version>\d+\.\d+\.\d+[abcfpx]?\d*)\/(?<changeset>[a-zA-Z0-9]+)/);

        if (match && match.groups && match.groups.version && match.groups.changeset) {
            return new UnityVersion(match.groups.version, match.groups.changeset, unityVersion.architecture);
        }

        this.logger.error(`Failed to find changeset for Unity ${unityVersion.toString()}`);
        return unityVersion;
    }

    private async checkEditorModules(editorPath: string, unityVersion: UnityVersion, modules: string[]): Promise<[string[], string[]]> {
        let args = ['install-modules', '--version', unityVersion.version];

        if (unityVersion.architecture) {
            args.push('-a', unityVersion.architecture.toLowerCase());
        }

        for (const module of modules) {
            args.push('-m', module);
        }

        const editorRootPath = UnityEditor.GetEditorRootPath(editorPath);
        const modulesPath = path.join(editorRootPath, 'modules.json');
        this.logger.debug(`Editor Modules Manifest:\n  > "${modulesPath}"`);
        const output = await this.Exec([...args, '--cm'], { showCommand: true, silent: false });
        const moduleMatches = output.matchAll(/Omitting module (?<module>.+) because it's already installed/g);

        if (moduleMatches) {
            const omittedModules = [...moduleMatches].map(match => match.groups?.module);
            for (const module of omittedModules) {
                if (module && !modules.includes(module)) {
                    modules.push(module);
                }
            }
        }

        const installedModules = [...modules];
        const additionalModules = [];
        const additionalModulesJson = await this.getModulesContent(modulesPath);

        if (additionalModulesJson.length > 0) {
            for (const module of additionalModulesJson) {
                if (module.category === "Platforms" && module.visible === true) {
                    if (!installedModules.includes(module.id)) {
                        additionalModules.push(module.id);
                    }
                }
            }
        }

        return [installedModules, additionalModules];
    }

    private async getModulesContent(modulesPath: string): Promise<any> {
        const modulesContent = await ReadFileContents(modulesPath);
        return JSON.parse(modulesContent);
    }

    private async installUnity(unityVersion: UnityVersion, modules: string[]): Promise<string | undefined> {
        if (unityVersion.isLegacy()) {
            return await this.installUnity4x(unityVersion);
        }

        if (process.platform === 'linux') {
            const arch = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : process.arch;

            // install older versions of libssl for older Unity versions
            if (['2019.1', '2019.2'].some(v => unityVersion.version.startsWith(v))) {
                const url = `https://archive.ubuntu.com/ubuntu/pool/main/o/openssl/libssl1.0.0_1.0.2g-1ubuntu4.20_${arch}.deb`;
                const downloadPath = path.join(GetTempDir(), `libssl1.0.0_1.0.2g-1ubuntu4.20_${arch}.deb`);
                await DownloadFile(url, downloadPath);

                try {
                    await Exec('sudo', ['dpkg', '-i', downloadPath]);
                } finally {
                    fs.promises.unlink(downloadPath);
                }
            } else if (
                ['2019.3', '2019.4'].some(v => unityVersion.version.startsWith(v)) ||
                unityVersion.version.startsWith('2020.') ||
                unityVersion.version.startsWith('2021.')
            ) {
                const url = `https://archive.ubuntu.com/ubuntu/pool/main/o/openssl/libssl1.1_1.1.0g-2ubuntu4_${arch}.deb`;
                const downloadPath = path.join(GetTempDir(), `libssl1.1_1.1.0g-2ubuntu4_${arch}.deb`);
                await DownloadFile(url, downloadPath);

                try {
                    await Exec('sudo', ['dpkg', '-i', downloadPath]);
                } finally {
                    fs.promises.unlink(downloadPath);
                }
            }
        }

        this.logger.ci(`Installing Unity ${unityVersion.toString()}...`);
        const args = ['install', '--version', unityVersion.version];

        if (unityVersion.changeset) {
            args.push('--changeset', unityVersion.changeset);
        }

        if (unityVersion.architecture) {
            args.push('-a', unityVersion.architecture.toLowerCase());
        }

        if (modules.length > 0) {
            for (const module of modules) {
                this.logger.ci(`  > with module: ${module}`);
                args.push('-m', module);
            }

            args.push('--cm');
        }

        const output = await this.Exec(args, { showCommand: true, silent: false });

        if (output.includes(`Error while installing an editor or a module from changeset`) ||
            output.includes(`failed to download.`)) {
            throw new Error(`Failed to install Unity ${unityVersion.toString()}`);
        }
    }

    private async installUnity4x(unityVersion: UnityVersion): Promise<string> {
        this.logger.ci(`Installing Unity ${unityVersion.toString()}...`);
        const hubInstallDir = await this.GetInstallPath();

        switch (process.platform) {
            case 'win32': {
                const installDir = path.join(hubInstallDir, `Unity ${unityVersion.version}`);
                const installPath = path.join(installDir, 'Unity.exe');

                if (!fs.existsSync(installPath)) {
                    const url = `https://beta.unity3d.com/download/UnitySetup-${unityVersion.version}.exe`;
                    const installerPath = path.join(GetTempDir(), `UnitySetup-${unityVersion.version}.exe`);
                    await DownloadFile(url, installerPath);

                    this.logger.info(`Running Unity ${unityVersion.toString()} installer...`);

                    try {
                        await Exec('powershell', [
                            '-Command',
                            `Start-Process -FilePath \"${installerPath}\" -ArgumentList \"/S /D=${installDir}\" -Wait`
                        ], { silent: true, showCommand: true });
                    } catch (error) {
                        this.logger.error(`Failed to install Unity ${unityVersion.toString()}: ${error}`);
                    } finally {
                        fs.promises.unlink(installerPath);
                    }
                }

                await fs.promises.access(installDir, fs.constants.R_OK | fs.constants.X_OK);
                return installDir;
            }
            case 'darwin': {
                const installDir = path.join(hubInstallDir, `Unity ${unityVersion.version}`, 'Unity.app');

                if (!fs.existsSync(installDir)) {
                    const url = `https://beta.unity3d.com/download/unity-${unityVersion.version}.dmg`;
                    const installerPath = path.join(GetTempDir(), `UnitySetup-${unityVersion.version}.dmg`);
                    await DownloadFile(url, installerPath);

                    this.logger.info(`Running Unity ${unityVersion.toString()} installer...`);

                    let mountPoint = '';

                    try {
                        const output = await Exec('hdiutil', ['attach', installerPath, '-nobrowse'], { silent: true, showCommand: true });
                        const mountPointMatch = output.match(/\/Volumes\/Unity Installer.*$/m);

                        if (!mountPointMatch || mountPointMatch.length === 0) {
                            throw new Error(`Failed to find mount point in hdiutil output: ${output}`);
                        }

                        mountPoint = mountPointMatch[0];
                        this.logger.debug(`Mounted Unity Installer at ${mountPoint}`);

                        const pkgPath = path.join(mountPoint, 'Unity.pkg');
                        await fs.promises.access(pkgPath, fs.constants.R_OK);

                        this.logger.debug(`Found .pkg installer: ${pkgPath}`);
                        await Exec('sudo', ['installer', '-pkg', pkgPath, '-target', '/', '-verboseR'], { silent: true, showCommand: true });
                        const unityAppPath = path.join('/Applications', 'Unity');
                        const targetPath = path.join(hubInstallDir, `Unity ${unityVersion.version}`);

                        if (fs.existsSync(unityAppPath)) {
                            this.logger.debug(`Moving ${unityAppPath} to ${targetPath}...`);
                            await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });

                            const items = await fs.promises.readdir(unityAppPath);

                            for (const item of items) {
                                if (item !== 'Hub') {
                                    const src = path.join(unityAppPath, item);
                                    const dest = path.join(targetPath, item);
                                    this.logger.debug(`  > Moving ${src} to ${dest}`);
                                    await fs.promises.cp(src, dest, { recursive: true });
                                    await fs.promises.rm(src, { recursive: true, force: true });
                                }
                            }

                            await fs.promises.chmod(targetPath, 0o777);
                        } else {
                            throw new Error(`Failed to find Unity.app after installation.`);
                        }
                    } catch (error) {
                        this.logger.error(`Failed to mount Unity ${unityVersion.toString()} installer: ${error}`);
                    } finally {
                        try {
                            if (mountPoint && mountPoint.length > 0) {
                                await Exec('hdiutil', ['detach', mountPoint, '-quiet'], { silent: true, showCommand: true });
                            }
                        } finally {
                            await fs.promises.unlink(installerPath);
                        }
                    }
                }

                await fs.promises.access(installDir, fs.constants.R_OK | fs.constants.X_OK);
                return installDir;
            }
            default:
                throw new Error(`Unity ${unityVersion.toString()} is not supported on ${process.platform}`);
        }
    }

    /**
     * Get the mapping of Unity platform targets to their corresponding module identifiers for the current OS.
     * @returns A map of Unity platform targets to their corresponding module identifiers for the current OS.
     */
    public static GetPlatformTargetModuleMap(): { [key: string]: string } {
        const osType = os.type();
        let moduleMap: { [key: string]: string };

        switch (osType) {
            case 'Linux':
                moduleMap = {
                    "StandaloneLinux64": "linux-il2cpp",
                    "Android": "android",
                    "WebGL": "webgl",
                    "iOS": "ios",
                };
                break;
            case 'Darwin':
                moduleMap = {
                    "StandaloneOSX": "mac-il2cpp",
                    "iOS": "ios",
                    "Android": "android",
                    "tvOS": "appletv",
                    "StandaloneLinux64": "linux-il2cpp",
                    "WebGL": "webgl",
                    "VisionOS": "visionos"
                };
                break;
            case 'Windows_NT':
                moduleMap = {
                    "StandaloneWindows64": "windows-il2cpp",
                    "WSAPlayer": "universal-windows-platform",
                    "Android": "android",
                    "iOS": "ios",
                    "tvOS": "appletv",
                    "StandaloneLinux64": "linux-il2cpp",
                    "Lumin": "lumin",
                    "WebGL": "webgl",
                };
                break;
            default:
                throw Error(`${osType} not supported`);
        }

        return moduleMap;
    }

    /**
     * Returns the path to the Unity Hub log file.
     * @see https://docs.unity.com/en-us/licensing-server/troubleshooting-client#logs
     * @returns The Unity Hub log file path.
     */
    public static LogPath(): string {
        switch (process.platform) {
            case 'win32':
                // %APPDATA%\UnityHub\logs\info-log.json
                return path.join(process.env.APPDATA || '', 'UnityHub', 'logs', 'info-log.json');
            case 'darwin':
                // ~/Library/Application Support/UnityHub/logs/info-log.json
                return path.join(process.env.HOME || '', 'Library', 'Application Support', 'UnityHub', 'logs', 'info-log.json');
            case 'linux':
                // ~/.config/UnityHub/logs/info-log.json
                return path.join(process.env.HOME || '', '.config', 'UnityHub', 'logs', 'info-log.json');
            default:
                throw new Error(`Unsupported platform: ${process.platform}`);
        }
    }
}