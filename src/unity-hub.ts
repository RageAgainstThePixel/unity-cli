import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { spawn } from 'child_process';
import { Logger, LogLevel } from './logging';
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
    GetTempDir
} from './utilities';
import { UnityVersion } from './unity-version';
import { GetUnityReleasesData, UnityRelease } from '@rage-against-the-pixel/unity-releases-api/dist/unity-releases-api/types.gen';
import { UnityReleasesClient } from '@rage-against-the-pixel/unity-releases-api/dist/client';
import { UnityEditor } from './unity-editor';

export class UnityHub {
    public executable: string;
    public rootDirectory: string;
    public editorInstallationDirectory: string;
    public editorFileExtension: string;

    private logger: Logger = Logger.instance;

    constructor() {
        switch (process.platform) {
            case 'win32':
                this.executable = process.env.UNITY_HUB_PATH || 'C:\\Program Files\\Unity Hub\\Unity Hub.exe';
                this.rootDirectory = path.join(this.executable, '../');
                this.editorInstallationDirectory = 'C:\\Program Files\\Unity\\Hub\\Editor\\';
                this.editorFileExtension = '\\Editor\\Unity.exe';
                break;
            case 'darwin':
                this.executable = process.env.UNITY_HUB_PATH || '/Applications/Unity Hub.app/Contents/MacOS/Unity Hub';
                this.rootDirectory = path.join(this.executable, '../../../');
                this.editorInstallationDirectory = '/Applications/Unity/Hub/Editor/';
                this.editorFileExtension = '/Unity.app/Contents/MacOS/Unity';
                break;
            case 'linux':
                this.executable = process.env.UNITY_HUB_PATH || '/opt/unityhub/unityhub';
                this.rootDirectory = path.join(this.executable, '../');
                this.editorInstallationDirectory = `${process.env.HOME}/Unity/Hub/Editor/`;
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

        function processOutput(data: Buffer) {
            const chunk = data.toString();
            output += chunk;

            if (!options.silent) {
                process.stdout.write(chunk);
            }
        }

        const filteredArgs = args.filter(arg => arg !== '--headless' && arg !== '--');
        const executable = process.platform === 'linux' ? 'unity-hub' : this.executable;
        const execArgs = process.platform === 'linux' ? ['--headless', ...filteredArgs] : ['--', '--headless', ...filteredArgs];

        if (options.showCommand) {
            this.logger.startGroup(`\x1b[34m${executable} ${execArgs.join(' ')}\x1b[0m`);
        }

        if (this.executable.includes(path.sep)) {
            fs.accessSync(this.executable, fs.constants.R_OK | fs.constants.X_OK);
        }

        try {
            exitCode = await new Promise<number>((resolve, reject) => {
                const child = spawn(executable, execArgs, {
                    stdio: ['ignore', 'pipe', 'pipe'],
                });

                process.once('SIGINT', () => child.kill('SIGINT'));
                process.once('SIGTERM', () => child.kill('SIGTERM'));
                child.stdout.on('data', processOutput);
                child.stderr.on('data', processOutput);
                child.on('error', (error) => reject(error));
                child.on('close', (code) => {
                    process.stdout.write('\n');
                    resolve(code === null ? 0 : code);
                });
            });
        } finally {
            this.logger.endGroup();
            const match = output.match(/Assertion (?<assert>.+) failed/g);

            if (match ||
                output.includes('async hook stack has become corrupted')) {
                this.logger.warn(`Install failed, retrying...`);
                return await this.Exec(args);
            }

            if (exitCode > 0 || output.includes('Error:')) {
                const error = output.match(/Error: (.+)/);
                const errorMessage = error && error[1] ? error[1] : 'Unknown Error';

                switch (errorMessage) {
                    case 'No modules found to install.':
                        break;
                    default:
                        throw new Error(`Failed to execute Unity Hub: [${exitCode}] ${errorMessage}`);
                }
            }

            const ignoredLines = [
                `This error originated either by throwing inside of an async function without a catch block`,
                `Unexpected error attempting to determine if executable file exists`,
                `dri3 extension not supported`,
                `Failed to connect to the bus:`,
                `Checking for beta autoupdate feature for deb/rpm distributions`,
                `Found package-type: deb`,
                `XPC error for connection com.apple.backupd.sandbox.xpc: Connection invalid`
            ];
            output = output.split('\n')
                .filter(line => line.trim().length > 0)
                .filter(line => !ignoredLines.some(ignored => line.includes(ignored)))
                .join('\n');
        }

        return output;
    }

    /**
     * Prints the installed Unity Hub version.
     */
    public async Version(): Promise<string> {
        const version = await this.getInstalledHubVersion();
        return version.version;
    }

    /**
     * Installs or updates the Unity Hub.
     * If the Unity Hub is already installed, it will be updated to the latest version.
     */
    public async Install(): Promise<string> {
        let isInstalled = false;
        try {
            await fs.promises.access(this.executable, fs.constants.X_OK);
            isInstalled = true;
        } catch {
            await this.installHub();
        }

        if (isInstalled) {
            const installedVersion: SemVer = await this.getInstalledHubVersion();
            this.logger.ci(`Installed Unity Hub version: ${installedVersion.version}`);
            let latestVersion: SemVer | undefined = undefined;

            try {
                latestVersion = await this.getLatestHubVersion();
                this.logger.ci(`Latest Unity Hub version: ${latestVersion.version}`);
            } catch (error) {
                this.logger.warn(`Failed to get latest Unity Hub version: ${error}`);
            }

            if (latestVersion && compare(installedVersion, latestVersion) < 0) {
                this.logger.info(`Updating Unity Hub from ${installedVersion.version} to ${latestVersion.version}...`);

                if (process.platform !== 'linux') {
                    await DeleteDirectory(this.rootDirectory);
                    await this.installHub();
                } else {
                    await Exec('sudo', ['sh', '-c', `#!/bin/bash
set -e
wget -qO - https://hub.unity3d.com/linux/keys/public | gpg --dearmor | sudo tee /usr/share/keyrings/Unity_Technologies_ApS.gpg >/dev/null
sudo sh -c 'echo "deb [signed-by=/usr/share/keyrings/Unity_Technologies_ApS.gpg] https://hub.unity3d.com/linux/repos/deb stable main" > /etc/apt/sources.list.d/unityhub.list'
sudo apt-get update --allow-releaseinfo-change
sudo apt-get install -y --no-install-recommends --only-upgrade unityhub`]);
                }
            } else {
                this.logger.info(`Unity Hub is already installed and up to date.`);
            }
        }

        return this.executable;
    }

    private async installHub(): Promise<void> {
        switch (process.platform) {
            case 'win32': {
                const url = 'https://public-cdn.cloud.unity3d.com/hub/prod/UnityHubSetup.exe';
                const downloadPath = path.join(GetTempDir(), 'UnityHubSetup.exe');
                await DownloadFile(url, downloadPath);

                this.logger.info(`Running Unity Hub installer...`);

                try {
                    await Exec(downloadPath, ['/S']);
                } finally {
                    fs.promises.unlink(downloadPath);
                }

                break;
            }
            case 'darwin': {
                const baseUrl = 'https://public-cdn.cloud.unity3d.com/hub/prod';
                const url = `${baseUrl}/UnityHubSetup-${process.arch}.dmg`;
                const downloadPath = path.join(GetTempDir(), `UnityHubSetup-${process.arch}.dmg`);
                this.logger.info(`Downloading Unity Hub from ${url} to ${downloadPath}`);

                await DownloadFile(url, downloadPath);
                await fs.promises.chmod(downloadPath, 0o777);

                let mountPoint = '';
                this.logger.debug(`Mounting DMG...`);

                try {
                    const output = await Exec('hdiutil', ['attach', downloadPath, '-nobrowse']);
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
                        await Exec('sudo', ['rm', '-rf', '/Applications/Unity Hub.app']);
                    }
                    await Exec('sudo', ['cp', '-R', appPath, '/Applications/Unity Hub.app']);
                    await Exec('sudo', ['chmod', '777', '/Applications/Unity Hub.app/Contents/MacOS/Unity Hub']);
                    await Exec('sudo', ['mkdir', '-p', '/Library/Application Support/Unity']);
                    await Exec('sudo', ['chmod', '777', '/Library/Application Support/Unity']);
                } finally {
                    try {
                        if (mountPoint && mountPoint.length > 0) {
                            await Exec('hdiutil', ['detach', mountPoint, '-quiet']);
                        }
                    } finally {
                        await fs.promises.unlink(downloadPath);
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
apt-get install -y --no-install-recommends unityhub ffmpeg libgtk2.0-0 libglu1-mesa libgconf-2-4 libncurses5
apt-get clean
sed -i 's/^\\(.*DISPLAY=:.*XAUTHORITY=.*\\)\\( "\\$@" \\)2>&1$/\\1\\2/' /usr/bin/xvfb-run
printf '#!/bin/bash\nxvfb-run --auto-servernum /opt/unityhub/unityhub "$@" 2>/dev/null' | tee /usr/bin/unity-hub >/dev/null
chmod 777 /usr/bin/unity-hub
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
        this.logger.info(`Unity Hub installed successfully.`);
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

        await fs.promises.access(asarPath, fs.constants.R_OK);
        const asar = await import('@electron/asar');
        const fileBuffer = asar.extractFile(asarPath, 'package.json');
        const packageJson = JSON.parse(fileBuffer.toString());
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
     * @returns {Promise<string>} The install path.
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
     * @param installPath The path to set.
     */
    public async SetInstallPath(installPath: string): Promise<void> {
        await fs.promises.mkdir(installPath, { recursive: true });
        await this.Exec(['install-path', '--set', installPath]);
    }

    /**
     * Locate and associate an installed editor from a stipulated path.
     * @param editorPath
     */
    public async AddEditor(editorPath: string): Promise<void> {
        await fs.promises.access(editorPath, fs.constants.R_OK | fs.constants.X_OK);
        await this.Exec(['editors', '--add', editorPath]);
    }

    /**
     * Attempts to find or install the specified Unity Editor version with the requested modules.
     * @param unityVersion The Unity version to find or install.
     * @param modules The modules to install alongside the editor.
     * @returns The path to the Unity Editor executable.
     */
    public async GetEditor(unityVersion: UnityVersion, modules: string[]): Promise<string> {
        const retryErrorMessages = [
            'Editor already installed in this location',
            'failed to download. Error given: Request timeout'
        ];

        this.logger.ci(`Getting release info for Unity ${unityVersion.toString()}...`);
        let editorPath = await this.checkInstalledEditors(unityVersion, false);

        // attempt to resolve the full version with the changeset if we don't have one already
        if (!unityVersion.isLegacy() && !editorPath && !unityVersion.changeset) {
            try {
                const releases = await this.getLatestHubReleases();
                unityVersion = unityVersion.findMatch(releases);
                const unityReleaseInfo: UnityRelease = await this.getEditorReleaseInfo(unityVersion);
                unityVersion = new UnityVersion(unityReleaseInfo.version, unityReleaseInfo.shortRevision, unityVersion.architecture);
            } catch (error) {
                this.logger.warn(`Failed to get Unity release info for ${unityVersion.toString()}! falling back to legacy search...\n${error}`);
                try {
                    unityVersion = await this.fallbackVersionLookup(unityVersion);
                } catch (fallbackError) {
                    this.logger.warn(`Failed to lookup changeset for Unity ${unityVersion.toString()}!\n${fallbackError}`);
                }
            }
        }

        let installPath: string | undefined = undefined;

        if (!editorPath) {
            try {
                installPath = await this.installUnity(unityVersion, modules);
            } catch (error: Error | any) {
                if (retryErrorMessages.some(msg => error.message.includes(msg))) {
                    if (editorPath) {
                        await DeleteDirectory(editorPath);
                    }

                    if (installPath) {
                        await DeleteDirectory(installPath);
                    }
                    installPath = await this.installUnity(unityVersion, modules);
                } else {
                    throw error;
                }
            }

            editorPath = await this.checkInstalledEditors(unityVersion, true, installPath);
        }

        if (!editorPath) {
            throw new Error(`Failed to find or install Unity Editor: ${unityVersion.toString()}`);
        }

        await fs.promises.access(editorPath, fs.constants.X_OK);
        await this.patchBeeBackend(editorPath);

        if (unityVersion.isLegacy() || modules.length === 0) {
            return editorPath;
        }

        try {
            this.logger.ci(`Checking installed modules for Unity ${unityVersion.toString()}...`);
            const [installedModules, additionalModules] = await this.checkEditorModules(editorPath, unityVersion, modules);

            if (installedModules && installedModules.length > 0) {
                this.logger.ci(`Installed Modules:`);

                for (const module of installedModules) {
                    this.logger.ci(`  > ${module}`);
                }
            }
            if (additionalModules && additionalModules.length > 0) {
                this.logger.ci(`Additional Modules:`);

                for (const module of additionalModules) {
                    this.logger.ci(`  > ${module}`);
                }
            }
        } catch (error: Error | any) {
            if (error.message.includes(`No modules found`)) {
                await DeleteDirectory(editorPath);
                await this.GetEditor(unityVersion, modules);
            }
        }

        return path.normalize(editorPath);
    }

    /**
     * Lists the installed Unity Editors.
     * @returns A list of installed Unity Editor versions and their paths.
     */
    public async ListInstalledEditors(): Promise<string[]> {
        const output = await this.Exec(['editors', '-i']);
        return output.split('\n')
            .filter(line => line.trim().length > 0)
            .map(line => line.trim());
    }

    private async checkInstalledEditors(unityVersion: UnityVersion, failOnEmpty: boolean, installPath: string | undefined = undefined): Promise<string | undefined> {
        let editorPath = undefined;
        if (!installPath) {
            const paths: string[] = await this.ListInstalledEditors();

            if (paths && paths.length > 0) {
                const pattern = /(?<version>\d+\.\d+\.\d+[abcfpx]?\d*)\s*(?:\((?<arch>Apple silicon|Intel)\))?\s*,? installed at (?<editorPath>.*)/;
                const matches = paths.map(path => path.match(pattern)).filter(match => match && match.groups);

                if (paths.length !== matches.length) {
                    throw new Error(`Failed to parse all installed Unity Editors!\n > paths: ${JSON.stringify(paths)}\n  > matches: ${JSON.stringify(matches)}`);
                }

                // Prefer exact version match first
                const exactMatch = matches.find(match => match?.groups?.version === unityVersion.version);

                if (exactMatch) {
                    editorPath = exactMatch.groups!.editorPath;
                } else {
                    // Fallback: semver satisfies
                    const versionMatches = matches.filter(match => match?.groups?.version && unityVersion.satisfies(match.groups.version));

                    if (versionMatches.length === 0) {
                        return undefined;
                    }

                    const archMap = {
                        'ARM64': 'Apple silicon',
                        'X86_64': 'Intel',
                    };

                    for (const match of versionMatches) {
                        if (!match || !match.groups || !match.groups.version || !match.groups.editorPath) {
                            continue;
                        }
                        // If no architecture is set, or no arch in match, accept the version match
                        if (!unityVersion.architecture || !match.groups.arch) {
                            editorPath = match.groups.editorPath;
                        }
                        // If architecture is set and present in match, check for match
                        else if (archMap[unityVersion.architecture] === match.groups.arch) {
                            editorPath = match.groups.editorPath;
                        }
                        // Fallback: check if editorPath includes architecture string (case-insensitive)
                        else if (unityVersion.architecture && match.groups.editorPath.toLowerCase().includes(`-${unityVersion.architecture.toLowerCase()}`)) {
                            editorPath = match.groups.editorPath;
                        }
                    }
                }
            }
        } else {
            if (process.platform == 'win32') {
                editorPath = path.join(installPath, 'Unity.exe');
            } else {
                editorPath = installPath;
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

        this.logger.ci(`Found installed Unity Editor: ${editorPath}`);
        return editorPath;
    }

    private async getLatestHubReleases(): Promise<string[]> {
        // Normalize output to bare version strings (e.g., 2022.3.62f1)
        // Unity Hub can return lines like:
        //  - "6000.0.56f1 (Apple silicon)"
        //  - "2022.3.62f1 installed at C:\\..."
        //  - "2022.3.62f1, installed at ..." (older format)
        // We extract the first version token and discard the rest.
        const versionRegex = /(\d{1,4})\.(\d+)\.(\d+)([abcfpx])(\d+)/;
        return (await this.Exec([`editors`, `--releases`]))
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0)
            .map(line => {
                const match = line.match(versionRegex);
                return match ? match[0] : '';
            })
            .filter(v => v.length > 0);
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

    private async getEditorReleaseInfo(unityVersion: UnityVersion): Promise<UnityRelease> {
        // Prefer querying the releases API with the exact fully-qualified Unity version (e.g., 2022.3.10f1).
        // If we don't have a fully-qualified version, use the most specific prefix available:
        //  - "YYYY.M" when provided (e.g., 6000.1)
        //  - otherwise "YYYY"
        const fullUnityVersionPattern = /^\d{1,4}\.\d+\.\d+[abcfpx]\d+$/;
        let version: string;
        if (fullUnityVersionPattern.test(unityVersion.version)) {
            version = unityVersion.version;
        } else {
            const mm = unityVersion.version.match(/^(\d{1,4})(?:\.(\d+))?/);
            if (mm) {
                version = mm[2] ? `${mm[1]}.${mm[2]}` : mm[1]!;
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
            query: {
                version: version,
                architecture: [unityVersion.architecture],
                platform: getPlatform(),
                limit: 1,
            }
        };

        this.logger.debug(`Get Unity Release: ${JSON.stringify(request, null, 2)}`);
        const { data, error } = await releasesClient.api.ReleaseService.getUnityReleases(request);

        if (error) {
            throw new Error(`Failed to get Unity releases: ${JSON.stringify(error, null, 2)}`);
        }

        if (!data || !data.results || data.results.length === 0) {
            throw new Error(`No Unity releases found for version: ${version}`);
        }

        this.logger.debug(`Found Unity Release: ${JSON.stringify(data, null, 2)}`);
        // Filter to stable 'f' releases only unless the user explicitly asked for a pre-release
        const isExplicitPrerelease = /[abcpx]$/.test(unityVersion.version) || /[abcpx]/.test(unityVersion.version);
        const results = (data.results || [])
            .filter(r => isExplicitPrerelease ? true : /f\d+$/.test(r.version))
            // Sort descending by minor, patch, f-number where possible; fallback to semver coercion
            .sort((a, b) => {
                const parse = (v: string) => {
                    const m = v.match(/(\d{1,4})\.(\d+)\.(\d+)([abcfpx])(\d+)/);
                    return m ? [parseInt(m[2]!), parseInt(m[3]!), m[4], parseInt(m[5]!)] as [number, number, string, number] : [0, 0, 'f', 0] as [number, number, string, number];
                };
                const [aMinor, aPatch, aTag, aNum] = parse(a.version);
                const [bMinor, bPatch, bTag, bNum] = parse(b.version);
                // Prefer higher minor
                if (aMinor !== bMinor) return bMinor - aMinor;
                // Then higher patch
                if (aPatch !== bPatch) return bPatch - aPatch;
                // Tag order: f > p > c > b > a > x
                const order = { f: 5, p: 4, c: 3, b: 2, a: 1, x: 0 } as Record<string, number>;
                if (order[aTag] !== order[bTag]) return (order[bTag] || 0) - (order[aTag] || 0);
                return bNum - aNum;
            });

        if (results.length === 0) {
            throw new Error(`No suitable Unity releases (stable) found for version: ${version}`);
        }

        this.logger.debug(`Found Unity Release: ${JSON.stringify({ query: version, picked: results[0] }, null, 2)}`);
        return results[0]!;
    }

    private async fallbackVersionLookup(unityVersion: UnityVersion): Promise<UnityVersion> {
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

        const output = await this.Exec([...args, '--cm']);
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

            if (['2019.1', '2019.2'].some(v => unityVersion.version.startsWith(v))) {
                const url = `https://archive.ubuntu.com/ubuntu/pool/main/o/openssl/libssl1.0.0_1.0.2g-1ubuntu4.20_${arch}.deb`;
                const downloadPath = path.join(GetTempDir(), `libssl1.0.0_1.0.2g-1ubuntu4.20_${arch}.deb`);
                await DownloadFile(url, downloadPath);

                try {
                    await Exec('sudo', ['dpkg', '-i', downloadPath]);
                } finally {
                    fs.promises.unlink(downloadPath);
                }
            } else if (['2019.3', '2019.4'].some(v => unityVersion.version.startsWith(v)) || unityVersion.version.startsWith('2020.')) {
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

        this.logger.info(`Installing Unity ${unityVersion.toString()}...`);
        const output = await this.Exec(args, { showCommand: true, silent: false });

        if (output.includes(`Error while installing an editor or a module from changeset`)) {
            throw new Error(`Failed to install Unity ${unityVersion.toString()}`);
        }
    }

    private async installUnity4x(unityVersion: UnityVersion): Promise<string> {
        const installDir = await this.GetInstallPath();

        switch (process.platform) {
            case 'win32': {
                const installPath = path.join(installDir, `Unity ${unityVersion.version}`);

                if (!fs.existsSync(installPath)) {
                    const url = `https://beta.unity3d.com/download/UnitySetup-${unityVersion.version}.exe`;
                    const installerPath = path.join(GetTempDir(), `UnitySetup-${unityVersion.version}.exe`);
                    await DownloadFile(url, installerPath);

                    this.logger.info(`Running Unity ${unityVersion.toString()} installer...`);

                    try {
                        await Exec(installerPath, ['/S', `/D=${installPath}`, '-Wait', '-NoNewWindow']);
                    } catch (error) {
                        this.logger.error(`Failed to install Unity ${unityVersion.toString()}: ${error}`);
                    } finally {
                        fs.promises.unlink(installerPath);
                    }
                }

                await fs.promises.access(installPath, fs.constants.R_OK);
                return installPath;
            }
            case 'darwin': {
                const installPath = path.join(installDir, `Unity ${unityVersion.version}`, 'Unity.app');

                if (!fs.existsSync(installPath)) {
                    const url = `https://beta.unity3d.com/download/unity-${unityVersion.version}.dmg`;
                    const installerPath = path.join(GetTempDir(), `UnitySetup-${unityVersion.version}.dmg`);
                    await DownloadFile(url, installerPath);

                    this.logger.info(`Running Unity ${unityVersion.toString()} installer...`);

                    let mountPoint = '';

                    try {
                        const output = await Exec('hdiutil', ['attach', installerPath, '-nobrowse']);
                        const mountPointMatch = output.match(/\/Volumes\/Unity Installer.*$/m);

                        if (!mountPointMatch || mountPointMatch.length === 0) {
                            throw new Error(`Failed to find mount point in hdiutil output: ${output}`);
                        }

                        mountPoint = mountPointMatch[0];
                        this.logger.debug(`Mounted Unity Installer at ${mountPoint}`);

                        const pkgPath = path.join(mountPoint, 'Unity.pkg');
                        await fs.promises.access(pkgPath, fs.constants.R_OK);

                        this.logger.debug(`Found .pkg installer: ${pkgPath}`);
                        await Exec('sudo', ['installer', '-pkg', pkgPath, '-target', '/', '-verboseR']);
                        const unityAppPath = path.join('/Applications', 'Unity');
                        const targetPath = path.join(installDir, `Unity ${unityVersion.version}`);

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
                                await Exec('hdiutil', ['detach', mountPoint, '-quiet']);
                            }
                        } finally {
                            await fs.promises.unlink(installerPath);
                        }
                    }
                }

                await fs.promises.access(installPath, fs.constants.R_OK);
                return installPath;
            }
            default:
                throw new Error(`Unity ${unityVersion.toString()} is not supported on ${process.platform}`);
        }
    }
}