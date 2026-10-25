import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { Logger } from './logging';
import { UnityEditor } from './unity-editor';
import { UnityVersion } from './unity-version';
import { FindAbsolutePath, UnityCli } from './unity-cli';
import {
    DownloadFile,
    Exec,
    GetTempDir,
} from './utilities';
import {
    UnityReleasesClient,
    GetUnityReleasesData,
    UnityRelease,
} from '@rage-against-the-pixel/unity-releases-api';

/** Exit codes the official CLI documents as retryable: network, install locked and timeout. */
const RETRYABLE_EXIT_CODES = [7, 9, 14];

/**
 * Packages the Unity Linux Editor needs that Ubuntu runners do not ship.
 * Some of them are only in jammy, so its archive is added as a source.
 */
const LINUX_EDITOR_DEPENDENCIES_SCRIPT = `#!/bin/sh
set -e
if [ ! -f /etc/apt/sources.list.d/jammy.list ]; then
  echo "deb https://archive.ubuntu.com/ubuntu jammy main universe" > /etc/apt/sources.list.d/jammy.list
fi
apt-get update
apt-get install -y --no-install-recommends xvfb ffmpeg libgtk2.0-0 libglu1-mesa libgconf-2-4 libncurses5 pulseaudio
apt-get clean
`;

/** Unity 5.x target support installer names, keyed by module id. */
const ARCHIVE_MODULE_NAMES: { [module: string]: string } = {
    'android': 'Android',
    'ios': 'iOS',
    'appletv': 'AppleTV',
    'webgl': 'WebGL',
    'linux': 'Linux',
    'linux-il2cpp': 'Linux',
    'mac': 'Mac',
    'mac-il2cpp': 'Mac',
    'windows': 'Windows',
    'windows-il2cpp': 'Windows',
    'universal-windows-platform': 'Metro',
    'facebook-games': 'Facebook-Games',
    'samsungtv': 'Samsung-TV',
    'tizen': 'Tizen',
};

/**
 * Finds or installs Unity Editors.
 * - 2017.4 and newer install through the official Unity CLI (`unity install`).
 * - 5.x installs from Unity's download archive, because the official CLI reads one-digit majors as Unity 6 shorthand.
 * - 4.x installs from Unity's legacy installers.
 */
export class UnityInstaller {
    private readonly logger: Logger = Logger.instance;
    private cli: UnityCli | undefined;

    /**
     * @param cli The official Unity CLI to use. Installed on demand when omitted.
     */
    constructor(cli: UnityCli | undefined = undefined) {
        this.cli = cli;
    }

    /**
     * Gets the official Unity CLI, installing it when needed.
     */
    public async GetCli(): Promise<UnityCli> {
        if (!this.cli) {
            this.cli = await UnityCli.Get();
        }

        return this.cli;
    }

    /**
     * Sets the directory editors are installed to.
     * @param installPath The directory to install editors to.
     */
    public async SetInstallPath(installPath: string): Promise<void> {
        const cli = await this.GetCli();
        await cli.SetInstallPath(path.resolve(installPath));
    }

    /**
     * Gets the directory editors are installed to.
     */
    public async GetInstallPath(): Promise<string> {
        const cli = await this.GetCli();
        return await cli.GetInstallPath();
    }

    /**
     * Finds the requested Unity Editor, installing it and any missing modules when needed.
     * @param unityVersion The Unity version to find or install. Partial versions such as 2021.3.x resolve to the newest matching release.
     * @param modules The module ids to install alongside the editor.
     * @param channels The release channels to accept when resolving a partial version: f, p, b, a or x. Default is ['f'].
     */
    public async GetEditor(unityVersion: UnityVersion, modules: string[] = [], channels: string[] = ['f']): Promise<UnityEditor> {
        this.logger.ci(`Getting release info for Unity ${unityVersion.toString()}...`);
        const resolvedVersion = await this.resolveVersion(unityVersion, channels);
        let editorPath: string;

        if (resolvedVersion.isLegacy()) {
            editorPath = await this.installLegacyEditor(resolvedVersion);
        } else if (resolvedVersion.isLessThan('2017.0.0')) {
            editorPath = await this.installArchiveEditor(resolvedVersion, modules);
        } else {
            editorPath = await this.installCliEditor(resolvedVersion, modules);
        }

        await fs.promises.access(editorPath, fs.constants.X_OK);
        await this.patchBeeBackend(editorPath);
        return new UnityEditor(path.normalize(editorPath), resolvedVersion);
    }

    /**
     * Resolves a partial or changeset-less version to an exact release with its changeset.
     * 4.x versions are returned as they are, since no release service lists them.
     * @param unityVersion The requested version.
     * @param channels The release channels to accept.
     */
    public async resolveVersion(unityVersion: UnityVersion, channels: string[] = ['f']): Promise<UnityVersion> {
        if (unityVersion.isLegacy() || (unityVersion.isFullyQualified() && unityVersion.changeset)) {
            return unityVersion;
        }

        try {
            const release = await UnityInstaller.GetEditorReleaseInfo(unityVersion, channels);
            return new UnityVersion(release.version, release.shortRevision, unityVersion.architecture);
        } catch (error) {
            // fail closed for partial versions: never install "6000.6" and hope it picks a release
            if (!unityVersion.isFullyQualified()) {
                const message = error instanceof Error ? error.message : String(error);
                throw new Error(`Failed to resolve Unity ${unityVersion.toString()} for channel(s) [${channels.join(', ')}]: ${message}`);
            }

            this.logger.warn(`Failed to get Unity release info for ${unityVersion.toString()}! falling back to the release notes page...\n${error}`);

            try {
                return await UnityInstaller.fallbackVersionLookup(unityVersion);
            } catch (fallbackError) {
                this.logger.warn(`Failed to lookup changeset for Unity ${unityVersion.toString()}!\n${fallbackError}`);
                return unityVersion;
            }
        }
    }

    private async installCliEditor(unityVersion: UnityVersion, modules: string[]): Promise<string> {
        const cli = await this.GetCli();
        let editorPath = await this.findCliEditor(cli, unityVersion);
        const requestedModules = modules.length > 0 ? await this.filterModules(cli, unityVersion, modules) : [];

        if (!editorPath) {
            if (process.platform === 'linux') {
                await this.installLinuxDependencies(unityVersion);
            }

            this.logger.ci(`Installing Unity ${unityVersion.toString()}...`);
            const args = ['install', unityVersion.version];

            if (unityVersion.changeset) {
                args.push('--changeset', unityVersion.changeset);
            }

            args.push('--architecture', unityVersion.architecture.toLowerCase());

            if (requestedModules.length > 0) {
                for (const module of requestedModules) {
                    this.logger.ci(`  > with module: ${module}`);
                }

                args.push('--module', ...requestedModules, '--child-modules');
            }

            args.push('--accept-eula', '--yes');
            await this.execWithRetry(cli, args);
            editorPath = await this.findCliEditor(cli, unityVersion);

            if (!editorPath) {
                throw new Error(`Unity ${unityVersion.toString()} was installed, but its editor could not be found`);
            }
        } else if (requestedModules.length > 0) {
            this.logger.ci(`Installing modules for Unity ${unityVersion.toString()}: ${requestedModules.join(', ')}`);
            await this.execWithRetry(cli, [
                'install-modules',
                '--editor-version', unityVersion.version,
                '--architecture', unityVersion.architecture.toLowerCase(),
                '--module', ...requestedModules,
                '--child-modules',
                '--accept-eula',
                '--yes'
            ]);
        }

        if (unityVersion.isGreaterThanOrEqualTo('6000.0.0')) {
            // so the editor opens without the terms dialog
            const result = await cli.Run(['terms', 'accept', unityVersion.version, '--architecture', unityVersion.architecture.toLowerCase(), '--yes']);

            if (result.exitCode !== 0) {
                this.logger.debug(`unity terms accept exited with code ${result.exitCode}:\n${result.stdout}${result.stderr}`);
            }
        }

        return editorPath;
    }

    private async execWithRetry(cli: UnityCli, args: string[]): Promise<void> {
        let result = await cli.Run(args, { stream: true });

        if (RETRYABLE_EXIT_CODES.includes(result.exitCode)) {
            this.logger.warn(`unity ${args[0]} failed with exit code ${result.exitCode}, retrying...`);
            result = await cli.Run(args[0] === 'install' ? [...args, '--resume'] : args, { stream: true });
        }

        // install-modules fails when every requested module is already installed
        if (result.exitCode !== 0 && args[0] === 'install-modules' && `${result.stdout}${result.stderr}`.includes('No modules found to install')) {
            this.logger.info('The requested modules are already installed.');
            return;
        }

        if (result.exitCode !== 0) {
            throw new Error(`unity ${args.join(' ')} failed with exit code ${result.exitCode}`);
        }
    }

    /**
     * Drops modules the release does not offer, since `unity install` fails on an unknown module id.
     */
    private async filterModules(cli: UnityCli, unityVersion: UnityVersion, modules: string[]): Promise<string[]> {
        const { exitCode, envelope } = await cli.RunJson<{ modules?: { id: string }[] }>(['editors', 'info', unityVersion.version]);
        const available = envelope?.data?.modules?.map(module => module.id);

        if (exitCode !== 0 || !available || available.length === 0) {
            this.logger.debug(`Could not read the module list for Unity ${unityVersion.version}, requesting modules as given`);
            return [...modules];
        }

        const supported: string[] = [];

        for (const module of modules) {
            if (available.includes(module)) {
                supported.push(module);
            } else {
                this.logger.warn(`Unity ${unityVersion.version} has no ${module} module on ${process.platform}, skipping it`);
            }
        }

        return supported;
    }

    /**
     * Looks up an installed editor with `unity editors path`, registering one that sits in the install path but that the CLI does not know about yet.
     */
    private async findCliEditor(cli: UnityCli, unityVersion: UnityVersion): Promise<string | undefined> {
        const { exitCode, envelope } = await cli.RunJson(['editors', 'path', unityVersion.version]);

        if (exitCode === 0 && envelope?.success !== false) {
            const editorPath = resolveEditorExecutable(FindAbsolutePath(envelope?.data));

            if (editorPath) {
                this.logger.debug(`Found installed editor: "${editorPath}"`);
                return editorPath;
            }
        }

        let installPath: string;

        try {
            installPath = await cli.GetInstallPath();
        } catch (error) {
            this.logger.debug(`${error}`);
            return undefined;
        }

        const candidates = [
            path.join(installPath, unityVersion.version),
            path.join(installPath, `${unityVersion.version}-${unityVersion.architecture.toLowerCase()}`),
        ];

        for (const candidate of candidates) {
            const editorPath = resolveEditorExecutable(candidate);

            if (editorPath) {
                this.logger.info(`Registering existing Unity ${unityVersion.version} at ${editorPath}`);
                const result = await cli.Run(['editors', 'add', editorPath]);

                if (result.exitCode !== 0) {
                    this.logger.warn(`unity editors add exited with code ${result.exitCode}`);
                }

                return editorPath;
            }
        }

        return undefined;
    }

    private async getLegacyInstallPath(): Promise<string> {
        try {
            return await this.GetInstallPath();
        } catch (error) {
            this.logger.debug(`Falling back to the default editor install path: ${error}`);

            switch (process.platform) {
                case 'win32':
                    return path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Unity', 'Hub', 'Editor');
                case 'darwin':
                    return '/Applications/Unity/Hub/Editor';
                default:
                    return path.join(os.homedir(), 'Unity', 'Hub', 'Editor');
            }
        }
    }

    /**
     * Installs Unity 5.x from the download archive.
     */
    private async installArchiveEditor(unityVersion: UnityVersion, modules: string[]): Promise<string> {
        if (!unityVersion.changeset) {
            throw new Error(`Unity ${unityVersion.toString()} needs a changeset to install from the download archive`);
        }

        UnityInstaller.assertArchiveVersion(unityVersion);
        const installPath = await this.getLegacyInstallPath();
        const installDir = path.join(installPath, unityVersion.version);
        const baseUrl = `https://download.unity3d.com/download_unity/${unityVersion.changeset}`;
        const moduleNames = this.getArchiveModuleNames(unityVersion, modules);

        switch (process.platform) {
            case 'win32': {
                let editorPath = resolveEditorExecutable(installDir);

                if (!editorPath) {
                    this.logger.ci(`Installing Unity ${unityVersion.toString()}...`);
                    await this.runWindowsInstaller(`${baseUrl}/Windows64EditorInstaller/UnitySetup64-${unityVersion.version}.exe`, installDir);
                    editorPath = resolveEditorExecutable(installDir);
                }

                if (!editorPath) {
                    throw new Error(`Failed to install Unity ${unityVersion.toString()} to ${installDir}`);
                }

                for (const moduleName of moduleNames) {
                    if (fs.existsSync(path.join(installDir, 'Editor', 'Data', 'PlaybackEngines', `${moduleName.toLowerCase()}support`))) {
                        continue;
                    }

                    this.logger.ci(`  > with module: ${moduleName}`);
                    await this.runWindowsInstaller(`${baseUrl}/TargetSupportInstaller/UnitySetup-${moduleName}-Support-for-Editor-${unityVersion.version}.exe`, installDir);
                }

                return editorPath;
            }
            case 'darwin': {
                let editorPath = resolveEditorExecutable(installDir);

                if (editorPath) {
                    if (moduleNames.length > 0) {
                        this.logger.warn(`Unity ${unityVersion.version} is already installed; add modules to it with its own installers`);
                    }

                    return editorPath;
                }

                this.logger.ci(`Installing Unity ${unityVersion.toString()}...`);
                const packages = [
                    `${baseUrl}/MacEditorInstaller/Unity-${unityVersion.version}.pkg`,
                    ...moduleNames.map(name => `${baseUrl}/MacEditorTargetInstaller/UnitySetup-${name}-Support-for-Editor-${unityVersion.version}.pkg`),
                ];

                for (const url of packages) {
                    const pkgPath = tempInstallerPath('.pkg');
                    await DownloadFile(url, pkgPath);

                    try {
                        await Exec('sudo', ['installer', '-pkg', pkgPath, '-target', '/'], { silent: true, showCommand: true });
                    } finally {
                        await fs.promises.rm(pkgPath, { force: true });
                    }
                }

                await this.moveMacApplicationsUnity(installDir);
                editorPath = resolveEditorExecutable(installDir);

                if (!editorPath) {
                    throw new Error(`Failed to install Unity ${unityVersion.toString()} to ${installDir}`);
                }

                return editorPath;
            }
            default:
                throw new Error(`Unity ${unityVersion.toString()} is not supported on ${process.platform}`);
        }
    }

    private getArchiveModuleNames(unityVersion: UnityVersion, modules: string[]): string[] {
        const hostModule = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'Mac' : 'Linux';
        const names: string[] = [];

        for (const module of modules) {
            const name = ARCHIVE_MODULE_NAMES[module];

            if (!name) {
                this.logger.warn(`Unity ${unityVersion.version} has no ${module} module in the download archive, skipping it`);
            } else if (name !== hostModule && !names.includes(name)) {
                names.push(name);
            }
        }

        return names;
    }

    /**
     * Runs a Unity NSIS installer silently. NSIS needs `/D=` last and unquoted, so the command line is passed verbatim, without a shell.
     */
    private async runWindowsInstaller(url: string, installDir: string): Promise<void> {
        if (/["\r\n]/.test(installDir)) {
            throw new Error(`Invalid install directory: ${installDir}`);
        }

        const installerPath = tempInstallerPath('.exe');
        await DownloadFile(url, installerPath);
        this.logger.info(`Running ${path.basename(url)}...`);

        try {
            const exitCode = await new Promise<number>((resolve, reject) => {
                const child = spawn(installerPath, ['/S', `/D=${installDir}`], {
                    shell: false,
                    stdio: 'ignore',
                    windowsVerbatimArguments: true,
                });
                child.on('error', reject);
                child.on('close', (code) => resolve(code ?? 1));
            });

            if (exitCode !== 0) {
                throw new Error(`${path.basename(url)} failed with exit code ${exitCode}`);
            }
        } finally {
            await fs.promises.rm(installerPath, { force: true });
        }
    }

    /**
     * Moves an editor that a macOS package installed to /Applications/Unity into its versioned folder.
     */
    private async moveMacApplicationsUnity(targetPath: string): Promise<void> {
        const unityAppPath = path.join('/Applications', 'Unity');

        if (!fs.existsSync(path.join(unityAppPath, 'Unity.app'))) {
            throw new Error('Failed to find /Applications/Unity/Unity.app after installation.');
        }

        this.logger.debug(`Moving ${unityAppPath} to ${targetPath}...`);
        await fs.promises.mkdir(targetPath, { recursive: true });

        for (const item of await fs.promises.readdir(unityAppPath)) {
            // the editor install path itself lives in /Applications/Unity/Hub
            if (item === 'Hub') {
                continue;
            }

            const src = path.join(unityAppPath, item);
            await fs.promises.cp(src, path.join(targetPath, item), { recursive: true, verbatimSymlinks: true });
            await fs.promises.rm(src, { recursive: true, force: true });
        }

        await fs.promises.chmod(targetPath, 0o777);
    }

    /**
     * Rejects versions and changesets that are not plain Unity release identifiers before they become URLs and paths.
     */
    private static assertArchiveVersion(unityVersion: UnityVersion): void {
        if (!/^\d{1,2}\.\d{1,2}\.\d{1,2}(?:[abcfpx]\d{1,3})?$/.test(unityVersion.version)) {
            throw new Error(`Invalid Unity version: ${unityVersion.version}`);
        }

        if (unityVersion.changeset && !/^[0-9a-f]{12}$/i.test(unityVersion.changeset)) {
            throw new Error(`Invalid Unity changeset: ${unityVersion.changeset}`);
        }
    }

    /**
     * Installs Unity 4.x from Unity's legacy installers.
     */
    private async installLegacyEditor(unityVersion: UnityVersion): Promise<string> {
        UnityInstaller.assertArchiveVersion(unityVersion);
        const installPath = await this.getLegacyInstallPath();
        const installDir = path.join(installPath, `Unity ${unityVersion.version}`);
        let editorPath = resolveEditorExecutable(installDir);

        if (editorPath) {
            return editorPath;
        }

        this.logger.ci(`Installing Unity ${unityVersion.toString()}...`);

        switch (process.platform) {
            case 'win32': {
                await this.runWindowsInstaller(`https://beta.unity3d.com/download/UnitySetup-${unityVersion.version}.exe`, installDir);
                break;
            }
            case 'darwin': {
                const url = `https://beta.unity3d.com/download/unity-${unityVersion.version}.dmg`;
                const installerPath = tempInstallerPath('.dmg');
                await DownloadFile(url, installerPath);
                let mountPoint = '';

                try {
                    const output = await Exec('hdiutil', ['attach', installerPath, '-nobrowse'], { silent: true, showCommand: true });
                    const mountPointMatch = output.match(/\/Volumes\/Unity Installer.*$/m);

                    if (!mountPointMatch || mountPointMatch.length === 0) {
                        throw new Error(`Failed to find mount point in hdiutil output: ${output}`);
                    }

                    mountPoint = mountPointMatch[0];
                    const pkgPath = path.join(mountPoint, 'Unity.pkg');
                    await fs.promises.access(pkgPath, fs.constants.R_OK);
                    await Exec('sudo', ['installer', '-pkg', pkgPath, '-target', '/', '-verboseR'], { silent: true, showCommand: true });
                    await this.moveMacApplicationsUnity(installDir);
                } finally {
                    try {
                        if (mountPoint.length > 0) {
                            await Exec('hdiutil', ['detach', mountPoint, '-quiet'], { silent: true, showCommand: true });
                        }
                    } finally {
                        await fs.promises.rm(installerPath, { force: true });
                    }
                }
                break;
            }
            default:
                throw new Error(`Unity ${unityVersion.toString()} is not supported on ${process.platform}`);
        }

        editorPath = resolveEditorExecutable(installDir);

        if (!editorPath) {
            throw new Error(`Failed to install Unity ${unityVersion.toString()} to ${installDir}`);
        }

        return editorPath;
    }

    /**
     * Installs the system packages the Linux editor needs, and the older libssl that 2019.1 to 2021.x link against.
     */
    private async installLinuxDependencies(unityVersion: UnityVersion): Promise<void> {
        if (process.env.UNITY_CLI_LINUX_DEPENDENCIES_INSTALLED !== 'true') {
            try {
                await Exec('sudo', ['sh', '-c', LINUX_EDITOR_DEPENDENCIES_SCRIPT], { silent: true, showCommand: true });
                process.env.UNITY_CLI_LINUX_DEPENDENCIES_INSTALLED = 'true';
                this.logger.CI_setEnvironmentVariable('UNITY_CLI_LINUX_DEPENDENCIES_INSTALLED', 'true');
            } catch (error) {
                this.logger.warn(`Failed to install Linux editor dependencies: ${error}`);
            }
        }

        const arch = process.arch === 'x64' ? 'amd64' : process.arch;
        let debName: string | undefined;

        if (['2019.1', '2019.2'].some(v => unityVersion.version.startsWith(v))) {
            debName = `libssl1.0.0_1.0.2g-1ubuntu4.20_${arch}.deb`;
        } else if (
            ['2019.3', '2019.4'].some(v => unityVersion.version.startsWith(v)) ||
            unityVersion.version.startsWith('2020.') ||
            unityVersion.version.startsWith('2021.')
        ) {
            debName = `libssl1.1_1.1.0g-2ubuntu4_${arch}.deb`;
        }

        if (debName) {
            const downloadPath = tempInstallerPath('.deb');
            await DownloadFile(`https://archive.ubuntu.com/ubuntu/pool/main/o/openssl/${debName}`, downloadPath);

            try {
                await Exec('sudo', ['dpkg', '-i', downloadPath]);
            } finally {
                await fs.promises.rm(downloadPath, { force: true });
            }
        }
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
            // linking fails with EEXIST once patched and ENOENT without a bee_backend, so nothing is checked before it is used
            try {
                await fs.promises.link(beeBackend, dotBeeBackend);
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;

                if (code === 'EEXIST' || code === 'ENOENT') {
                    return;
                }

                throw error;
            }

            this.logger.ci(`Patching Unity Linux Editor for Bee Backend...`);
            await fs.promises.unlink(beeBackend);
            // 'wx' fails instead of overwriting if something recreated the file since the unlink
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
            await fs.promises.writeFile(beeBackend, wrapperSource, { encoding: 'utf-8', mode: 0o755, flag: 'wx' });
        }
    }

    /**
     * Gets the specified Unity release info from the Unity Releases API.
     * Supports querying by exact version or by prefix (e.g., "2020", "2020.1", "2021.x", "2021.3.x").
     * @param unityVersion The Unity version to get the release info for.
     * @param channels Letter channels to accept (`f`, `p`, `b`, `a`, `x`). Default stable-only.
     * @returns The Unity release info.
     */
    public static async GetEditorReleaseInfo(unityVersion: UnityVersion, channels: string[] = ['f']): Promise<UnityRelease> {
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
        const channelSet = new Set(channels.map(c => c.toLowerCase()));

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

        function releaseChannelLetter(releaseVersion: string): string | undefined {
            const m = /^(\d{1,4})\.(\d+)\.(\d+)([abcfpx])(\d+)$/.exec(releaseVersion);
            return m?.[4];
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

        Logger.instance.debug(`Get Unity Release: ${JSON.stringify(request, null, 2)}`);

        async function getRelease() {
            const { data, error } = await releasesClient.api.Release.getUnityReleases(request);

            if (error) {
                throw new Error(`Failed to get Unity releases: ${JSON.stringify(error, null, 2)}`);
            }

            if (!data || !data.results || data.results.length === 0) {
                throw new Error(`No Unity releases found for version: ${version}`);
            }

            const releases = (data.results || [])
                .filter((release) => {
                    const v = release.version;
                    if (v == null || v === '') {
                        return false;
                    }
                    // Exact FQ request: accept that row regardless of channel filter.
                    if (fullUnityVersionPattern.test(unityVersion.version) && v === unityVersion.version) {
                        return true;
                    }
                    const letter = releaseChannelLetter(v);
                    return letter != null && channelSet.has(letter);
                })
                .map(release => ({
                    unityRelease: release,
                    unityVersion: new UnityVersion(release.version!, release.shortRevision, unityVersion.architecture)
                }));

            if (releases.length === 0) {
                const channelList = [...channelSet].join(',');
                throw new Error(
                    `No suitable Unity releases (channels: ${channelList}) found for version: ${version}` +
                    (channelSet.has('f') && channelSet.size === 1
                        ? `. No stable (f) release for ${version}; use --channel b/a or a fully-qualified version.`
                        : '')
                );
            }

            releases.sort((a, b) => UnityVersion.compare(b.unityVersion, a.unityVersion));

            Logger.instance.debug(`Found ${releases.length} matching Unity releases for version: ${version}`);
            releases.forEach(release => {
                Logger.instance.debug(` - ${release.unityRelease.version} (${release.unityRelease.shortRevision}) - ${release.unityRelease.recommended}`);
            });
            return releases[0]!.unityRelease!;
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

    private static async fallbackVersionLookup(unityVersion: UnityVersion): Promise<UnityVersion> {
        const url = `https://unity.com/releases/editor/whats-new/${unityVersion.version}`;
        Logger.instance.debug(`Fetching release page: "${url}"`);
        const response = await fetch(url);
        const responseText = await response.text();

        if (!response.ok) {
            throw new Error(`Failed to fetch changeset for Unity ${unityVersion.toString()} [${response.status}] "${url}"`);
        }

        const match = responseText.match(/unityhub:\/\/(?<version>\d+\.\d+\.\d+[abcfpx]?\d*)\/(?<changeset>[a-zA-Z0-9]+)/);

        if (match && match.groups && match.groups.version && match.groups.changeset) {
            return new UnityVersion(match.groups.version, match.groups.changeset, unityVersion.architecture);
        }

        throw new Error(`Failed to find changeset for Unity ${unityVersion.toString()} in "${url}"`);
    }

    /**
     * Get the mapping of Unity platform targets to their corresponding module identifiers for the current OS.
     * @returns A map of Unity platform targets to their corresponding module identifiers for the current OS.
     */
    public static GetPlatformTargetModuleMap(): { [key: string]: string } {
        const osType = os.type();

        switch (osType) {
            case 'Linux':
                return {
                    "StandaloneLinux64": "linux-il2cpp",
                    "Android": "android",
                    "WebGL": "webgl",
                    "iOS": "ios",
                };
            case 'Darwin':
                return {
                    "StandaloneOSX": "mac-il2cpp",
                    "iOS": "ios",
                    "Android": "android",
                    "tvOS": "appletv",
                    "StandaloneLinux64": "linux-il2cpp",
                    "WebGL": "webgl",
                    "VisionOS": "visionos"
                };
            case 'Windows_NT':
                return {
                    "StandaloneWindows64": "windows-il2cpp",
                    "WSAPlayer": "universal-windows-platform",
                    "Android": "android",
                    "iOS": "ios",
                    "tvOS": "appletv",
                    "StandaloneLinux64": "linux-il2cpp",
                    "Lumin": "lumin",
                    "WebGL": "webgl",
                };
            default:
                throw Error(`${osType} not supported`);
        }
    }
}

/**
 * Resolves an install directory, Editor folder, app bundle or executable to the editor executable.
 * @param location A path the editor may be under.
 * @returns The editor executable, or undefined when none is found.
 */
export function resolveEditorExecutable(location: string | undefined): string | undefined {
    if (!location || !fs.existsSync(location)) {
        return undefined;
    }

    if (fs.statSync(location).isFile()) {
        return location;
    }

    let candidates: string[];

    switch (process.platform) {
        case 'darwin':
            candidates = [
                path.join(location, 'Unity.app', 'Contents', 'MacOS', 'Unity'),
                path.join(location, 'Contents', 'MacOS', 'Unity'),
            ];
            break;
        case 'win32':
            candidates = [
                path.join(location, 'Editor', 'Unity.exe'),
                path.join(location, 'Unity.exe'),
            ];
            break;
        default:
            candidates = [
                path.join(location, 'Editor', 'Unity'),
                path.join(location, 'Unity'),
            ];
            break;
    }

    return candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
}

/**
 * A fresh temp path for a downloaded installer. The name is random rather than taken from the URL,
 * so nothing from the requested version reaches the installer command line.
 * @param extension The installer's file extension, e.g. .pkg.
 */
function tempInstallerPath(extension: string): string {
    return path.join(GetTempDir(), `unity-installer-${randomUUID()}${extension}`);
}
