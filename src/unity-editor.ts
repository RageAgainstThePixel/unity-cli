import { Logger } from './logging.js';
import * as fs from 'fs';
import * as path from 'path';

export class UnityEditor {
    private static logger: Logger = Logger.instance;

    static async GetEditorRootPath(editorPath: string): Promise<string> {
        this.logger.debug(`searching for editor root path: ${editorPath}`);
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
        await fs.promises.access(editorRootPath, fs.constants.R_OK);
        this.logger.debug(`found editor root path: ${editorRootPath}`);
        return editorRootPath;
    }
}