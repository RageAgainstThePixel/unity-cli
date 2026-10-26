import os from 'os';
import fs from 'fs';
import path from 'path';
import { UnityVersion } from './unity-version';
import { ResolveGlobToPath } from './utilities';

export class UnityProject {
    /** The default modules to include in a new Unity project. */
    public static readonly DefaultModules: string[] = (() => {
        switch (os.type()) {
            case 'Linux': return ['linux-il2cpp'];
            case 'Darwin': return ['mac-il2cpp'];
            case 'Windows_NT': return ['windows-il2cpp'];
            default: throw Error(`${os.type()} not supported`);
        }
    })();

    /** A map of build targets to their corresponding Unity Hub module names. */
    public static readonly BuildTargetModuleMap: { [key: string]: string } = (() => {
        switch (os.type()) {
            case 'Linux': return {
                StandaloneLinux64: "linux-il2cpp",
                Android: "android",
                WebGL: "webgl",
                iOS: "ios",
            };
            case 'Darwin': return {
                StandaloneOSX: "mac-il2cpp",
                iOS: "ios",
                Android: "android",
                tvOS: "appletv",
                StandaloneLinux64: "linux-il2cpp",
                WebGL: "webgl",
                VisionOS: "visionos"
            };
            case 'Windows_NT': return {
                StandaloneWindows64: "windows-il2cpp",
                WSAPlayer: "universal-windows-platform",
                Android: "android",
                iOS: "ios",
                tvOS: "appletv",
                StandaloneLinux64: "linux-il2cpp",
                Lumin: "lumin",
                WebGL: "webgl",
            };
            default: throw Error(`${os.type()} not supported`);
        }
    })();

    /** The path to the ProjectVersion.txt file within the Unity project. */
    public readonly projectVersionPath: string;

    /** The Unity version used by the project. */
    public readonly version: UnityVersion;

    /**
     * Initializes a new instance of the UnityProject class.
     * @param projectPath The path to the Unity project.
     * @throws Will throw an error if the project path is invalid or if the ProjectVersion.txt file cannot be found or read.
     */
    constructor(public readonly projectPath: string) {
        fs.accessSync(projectPath, fs.constants.R_OK);
        this.projectVersionPath = path.join(this.projectPath, 'ProjectSettings', 'ProjectVersion.txt');
        fs.accessSync(this.projectVersionPath, fs.constants.R_OK);
        const versionText = fs.readFileSync(this.projectVersionPath, 'utf-8');
        const match = versionText.match(/(?:m_EditorVersion|m_EditorVersionWithRevision): (?<version>(?:(?<major>\d+)\.)?(?:(?<minor>\d+)\.)?(?:(?<patch>\d+[abcfpx]\d+)\b))\s?(?:\((?<changeset>\w+)\))?/);

        if (!match) {
            throw Error(`No version match found!\nProjectVersion.txt content:\n${versionText}`);
        }

        if (!match.groups?.version) {
            throw Error(`No version group found!\nProjectVersion.txt content:\n${versionText}`);
        }

        this.version = new UnityVersion(match.groups!.version!, match.groups?.changeset, undefined);
    }

    /**
     * The build targets of the build profiles saved under the project's Assets folder (Unity 6 and newer).
     * @returns Build target names such as Android or StandaloneWindows64, without duplicates.
     */
    public GetBuildProfileTargets(): string[] {
        const targets = new Set<string>();
        const pending = [path.join(this.projectPath, 'Assets')];

        while (pending.length > 0) {
            const dir = pending.pop()!;
            let entries: fs.Dirent[];

            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch {
                continue;
            }

            for (const entry of entries) {
                const entryPath = path.join(dir, entry.name);

                if (entry.isDirectory()) {
                    pending.push(entryPath);
                    continue;
                }

                if (!entry.isFile() || !entry.name.endsWith('.asset')) {
                    continue;
                }

                const target = UnityProject.readBuildProfileTarget(UnityProject.readSmallFile(entryPath));

                if (target) {
                    targets.add(target);
                }
            }
        }

        return [...targets];
    }

    /** Reads a file of up to 1 MB through one open handle, so the size check and the read see the same file. Larger or unreadable files read as empty. */
    private static readSmallFile(filePath: string): string {
        let fd: number | undefined;

        try {
            fd = fs.openSync(filePath, 'r');

            if (fs.fstatSync(fd).size > 1024 * 1024) {
                return '';
            }

            return fs.readFileSync(fd, 'utf-8');
        } catch {
            return '';
        } finally {
            if (fd !== undefined) {
                fs.closeSync(fd);
            }
        }
    }

    /** BuildTarget enum values a build profile stores, by name. */
    private static readonly BuildTargetNames: { [value: number]: string } = {
        2: 'StandaloneOSX',
        5: 'StandaloneWindows',
        9: 'iOS',
        13: 'Android',
        19: 'StandaloneWindows64',
        20: 'WebGL',
        21: 'WSAPlayer',
        24: 'StandaloneLinux64',
        37: 'tvOS',
        47: 'VisionOS',
    };

    /** The build target of a BuildProfile asset, or undefined for any other asset. */
    private static readBuildProfileTarget(asset: string): string | undefined {
        // BuildProfile is a built-in MonoBehaviour: script fileID 15003 in the editor's built-in guid
        if (!asset.includes('fileID: 15003, guid: 0000000000000000e000000000000000') || !asset.includes('m_PlatformBuildProfile:')) {
            return undefined;
        }

        const match = /^ {2}m_BuildTarget: (\d+)\r?$/m.exec(asset);
        return match ? UnityProject.BuildTargetNames[Number(match[1])] ?? `BuildTarget(${match[1]})` : undefined;
    }

    /**
     * Gets the Unity project located at the specified path, or the current working directory if no path is provided.
     * @param projectPath The path to the Unity project. If undefined, the current working directory is used.
     * @returns The UnityProject instance representing the project at the specified path.
     * @throws Will throw an error if the project path is invalid or if the ProjectVersion.txt file cannot be found or read.
     */
    public static async GetProject(projectPath: string | undefined = undefined): Promise<UnityProject> {
        if (!projectPath) {
            projectPath = process.cwd();
            const versionFilePath = await ResolveGlobToPath([projectPath, '**', 'ProjectVersion.txt']);
            projectPath = path.join(versionFilePath, '..', '..');
        }

        if (process.platform === `win32` && projectPath.endsWith(`\\`)) {
            projectPath = projectPath.slice(0, -1);
        }

        return new UnityProject(projectPath);
    }
}