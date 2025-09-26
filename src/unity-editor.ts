import * as fs from 'fs';
import * as path from 'path';

export class UnityEditor {
    static async GetEditorRootPath(editorPath: string): Promise<string> {
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
        return editorRootPath;
    }
}