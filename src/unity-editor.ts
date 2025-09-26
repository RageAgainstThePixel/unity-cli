import * as fs from 'fs';
import * as path from 'path';
import { Logger } from './logging';
import { getArgumentValue } from './utilities';
import {
    ChildProcessByStdio,
    spawn
} from 'child_process';

export class UnityEditor {
    public editorRootPath: string;

    private logger: Logger = Logger.instance;

    constructor(public editorPath: string) {
        if (!fs.existsSync(editorPath)) {
            throw new Error(`The Unity Editor path does not exist: ${editorPath}`);
        }

        fs.accessSync(editorPath, fs.constants.X_OK);
        this.editorRootPath = UnityEditor.GetEditorRootPath(editorPath);
    }

    public async Exec(args: string[], options = { silent: false, showCommand: true }): Promise<string> {
        let output: string = '';
        let exitCode: number = 0;

        const logPath = getArgumentValue('-logFile', args);

        if (!logPath) {
            throw Error('Log file path not specified in command arguments');
        }

        let unityProcess: ChildProcessByStdio<null, null, null>;
    }

    static GetEditorRootPath(editorPath: string): string {
        let editorRootPath = editorPath;
        switch (process.platform) {
            case 'darwin':
                editorRootPath = path.join(editorPath, '../../../../');
                break;
            case 'linux':
                editorRootPath = path.join(editorPath, '../../');
                break;
            case 'win32':
                editorRootPath = path.join(editorPath, '../../');
                break
        }
        fs.accessSync(editorRootPath, fs.constants.R_OK);
        return editorRootPath;
    }
}