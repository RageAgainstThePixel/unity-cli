import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { UnityEditor } from '../src/unity-editor';
import { UnityVersion } from '../src/unity-version';

describe('UnityEditor', () => {
    let tempRoot: string;
    let testEditor: UnityEditor;

    beforeAll(() => {
        // a fake editor executable is enough for the pure helpers under test
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'unity-cli-editor-'));
        const editorPath = process.platform === 'darwin'
            ? path.join(tempRoot, '6000.0.0f1', 'Unity.app', 'Contents', 'MacOS', 'Unity')
            : path.join(tempRoot, '6000.0.0f1', 'Editor', process.platform === 'win32' ? 'Unity.exe' : 'Unity');
        fs.mkdirSync(path.dirname(editorPath), { recursive: true });
        fs.writeFileSync(editorPath, '', { mode: 0o755 });
        testEditor = new UnityEditor(editorPath, new UnityVersion('6000.0.0f1'));
    });

    afterAll(() => {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    describe('GetUnityRunArgs', () => {
        it('lets unity run own -batchmode, -projectPath and -logFile', () => {
            const args = UnityEditor.GetUnityRunArgs('/editor/Unity', '/project', '/logs/run.log', [
                '-projectPath', '/project',
                '-logFile', '/logs/run.log',
                '-automated',
                '-batchmode',
                '-nographics',
                '-quit',
                '-executeMethod', 'Build.Run',
            ]);

            expect(args).toEqual([
                'run', '/project',
                '--editor-path', '/editor/Unity',
                '--log-file', '/logs/run.log',
                '--no-tail',
                '--',
                '-automated',
                '-nographics',
                '-quit',
                '-executeMethod', 'Build.Run',
            ]);
        });
    });

    describe('scrubSensitiveArgs', () => {
        it('should redact -username value', () => {
            const args = ['-batchmode', '-username', 'test@example.com', '-quit'];
            const scrubbedArgs = testEditor.scrubSensitiveArgs(args);

            expect(scrubbedArgs).toContain('-username');
            expect(scrubbedArgs).toContain('[REDACTED]');
            expect(scrubbedArgs).not.toContain('test@example.com');
            expect(scrubbedArgs).toContain('-batchmode');
            expect(scrubbedArgs).toContain('-quit');
        });

        it('should redact -password value', () => {
            const args = ['-batchmode', '-password', 'SuperSecret123', '-quit'];
            const scrubbedArgs = testEditor.scrubSensitiveArgs(args);

            expect(scrubbedArgs).toContain('-password');
            expect(scrubbedArgs).toContain('[REDACTED]');
            expect(scrubbedArgs).not.toContain('SuperSecret123');
        });

        it('should redact -cloudOrganization value', () => {
            const args = ['-batchmode', '-cloudOrganization', 'org-id-12345', '-quit'];
            const scrubbedArgs = testEditor.scrubSensitiveArgs(args);

            expect(scrubbedArgs).toContain('-cloudOrganization');
            expect(scrubbedArgs).toContain('[REDACTED]');
            expect(scrubbedArgs).not.toContain('org-id-12345');
        });

        it('should redact -serial value', () => {
            const args = ['-batchmode', '-serial', 'ABC-123-DEF-456', '-quit'];
            const scrubbedArgs = testEditor.scrubSensitiveArgs(args);

            expect(scrubbedArgs).toContain('-serial');
            expect(scrubbedArgs).toContain('[REDACTED]');
            expect(scrubbedArgs).not.toContain('ABC-123-DEF-456');
        });

        it('should preserve non-sensitive arguments', () => {
            const args = [
                '-batchmode',
                '-projectPath', '/path/to/project',
                '-buildTarget', 'StandaloneWindows64',
                '-quit'
            ];
            const scrubbedArgs = testEditor.scrubSensitiveArgs(args);

            expect(scrubbedArgs).toEqual(args);
        });

        it('should handle empty array', () => {
            expect(testEditor.scrubSensitiveArgs([])).toEqual([]);
        });

        it('should handle sensitive flag at end of array without value', () => {
            const scrubbedArgs = testEditor.scrubSensitiveArgs(['-batchmode', '-quit', '-username']);

            expect(scrubbedArgs).toContain('-username');
            expect(scrubbedArgs).not.toContain('[REDACTED]');
        });
    });
});
