import * as path from 'path';

export class UnityHub {
    public executable: string;
    public rootDirectory: string;
    public editorInstallationDirectory: string;
    public editorFileExtension: string;

    constructor() {
        switch (process.platform) {
            case 'win32':
                this.executable = process.env.UNITY_HUB_PATH || 'C:/Program Files/Unity Hub/Unity Hub.exe';
                this.rootDirectory = path.join(this.executable, '../');
                this.editorInstallationDirectory = 'C:/Program Files/Unity/Hub/Editor/';
                this.editorFileExtension = '/Editor/Unity.exe';
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
}