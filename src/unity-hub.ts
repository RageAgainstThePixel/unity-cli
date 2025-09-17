import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { DownloadFile, Exec } from './utilities';

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

    private async exec(args: string[]): Promise<string> {
        await fs.promises.access(this.executable, fs.constants.X_OK);

        let output: string = '';
        let exitCode: number = 0;

        // These lines are commonly found in stderr but can be ignored
        const ignoredLines = [
            `This error originated either by throwing inside of an async function without a catch block`,
            `Unexpected error attempting to determine if executable file exists`,
            `dri3 extension not supported`,
            `Failed to connect to the bus:`,
            `Checking for beta autoupdate feature for deb/rpm distributions`,
            `Found package-type: deb`,
            `XPC error for connection com.apple.backupd.sandbox.xpc: Connection invalid`
        ];

        function processOutput(line: string) {
            if (line && line.trim().length > 0) {
                if (ignoredLines.some(ignored => line.includes(ignored))) {
                    return;
                }

                console.log(line);
                output += `${line}\n`;
            }
        }

        try {
            exitCode = await new Promise<number>((resolve, reject) => {
                const executable = process.platform === 'linux' ? 'unity-hub' : this.executable;
                const execArgs = process.platform === 'linux' ? ['--headless', ...args] : ['--', '--headless', ...args];
                const child = spawn(executable, execArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

                child.stdout.on('data', (data) => {
                    processOutput(data.toString());
                });

                child.stderr.on('data', (data) => {
                    processOutput(data.toString());
                });

                child.on('error', (error) => {
                    reject(error);
                });

                child.on('close', (code) => {
                    resolve(code === null ? 0 : code);
                });
            });
        } finally {
            if (exitCode !== 0) {
                throw new Error(`License command failed with exit code ${exitCode}`);
            }
        }

        const match = output.match(/Assertion (?<assert>.+) failed/g);

        if (match ||
            output.includes('async hook stack has become corrupted')) {
            console.warn(`Install failed, retrying...`);
            return await this.exec(args);
        }

        if (output.includes('Error:')) {
            const error = output.match(/Error: (.+)/);
            const errorMessage = error && error[1] ? error[1] : 'Unknown Error';

            switch (errorMessage) {
                case 'No modules found to install.':
                    return output;
                default:
                    throw new Error(`Failed to execute Unity Hub: ${errorMessage}`);
            }
        }

        return output;
    }

    public async Install(): Promise<void> {
        try {
            await fs.promises.access(this.executable, fs.constants.X_OK);
        } catch {
            await this.installInternal();
        }
    }

    private async installInternal(): Promise<void> {
        switch (process.platform) {
            case 'win32': {
                const url = 'https://public-cdn.cloud.unity3d.com/hub/prod/UnityHubSetup.exe';
                const downloadPath = path.join(process.env.TEMP || '.', 'UnityHubSetup.exe');
                await DownloadFile(url, downloadPath);

                console.log(`Running Unity Hub installer...`);

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
                const downloadPath = path.join(process.env.TEMP || '.', `UnityHubSetup-${process.arch}.dmg`);
                console.log(`Downloading Unity Hub from ${url} to ${downloadPath}`);

                await DownloadFile(url, downloadPath);

                let mountPoint = '';
                console.log(`Mounting DMG...`);

                try {
                    const output = await Exec('hdiutil', ['attach', downloadPath, '-nobrowse']);
                    // can be "/Volumes/Unity Hub 3.13.1-arm64" or "/Volumes/Unity Hub 3.13.1"
                    const mountPointMatch = output.match(/\/Volumes\/Unity Hub.*$/m);

                    if (!mountPointMatch || mountPointMatch.length === 0) {
                        throw new Error(`Failed to find mount point in hdiutil output: ${output}`);
                    }

                    mountPoint = mountPointMatch[0];
                    console.log(`Mounted Unity Hub at ${mountPoint}`);

                    const appPath = path.join(mountPoint, 'Unity Hub.app');
                    console.log(`Copying ${appPath} to /Applications...`);

                    await fs.promises.access(appPath, fs.constants.R_OK | fs.constants.X_OK);
                    await fs.promises.cp(appPath, '/Applications/Unity Hub.app', { recursive: true });
                    await fs.promises.chmod('/Applications/Unity Hub.app/Contents/MacOS/Unity Hub', 0o777);
                    await fs.promises.mkdir('/Library/Application Support/Unity', { recursive: true });
                    await fs.promises.chmod('/Library/Application Support/Unity', 0o777);
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
        console.log(`Unity Hub installed successfully.`);
    }
}