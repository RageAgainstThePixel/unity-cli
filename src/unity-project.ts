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
        const match = versionText.match(/m_EditorVersionWithRevision: (?<version>(?:(?<major>\d+)\.)?(?:(?<minor>\d+)\.)?(?:(?<patch>\d+[abcfpx]\d+)\b))\s?(?:\((?<changeset>\w+)\))?/);

        if (!match) {
            throw Error(`No version match found!`);
        }

        if (!match.groups?.version) {
            throw Error(`No version group found!`);
        }

        if (!match.groups?.changeset) {
            throw Error(`No changeset group found!`);
        }

        this.version = new UnityVersion(match.groups.version, match.groups.changeset, undefined);
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