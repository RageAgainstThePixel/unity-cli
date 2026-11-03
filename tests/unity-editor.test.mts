import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { UnityEditor } from '../dist/unity-editor.js';
import { UnityVersion } from '../dist/unity-version.js';

describe('UnityEditor', () => {
    let tempRoot: string;
    let testEditor: UnityEditor;

    before(() => {
        // a fake editor executable is enough for the pure helpers under test
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'unity-cli-editor-'));
        const editorPath = process.platform === 'darwin'
            ? path.join(tempRoot, '6000.0.0f1', 'Unity.app', 'Contents', 'MacOS', 'Unity')
            : path.join(tempRoot, '6000.0.0f1', 'Editor', process.platform === 'win32' ? 'Unity.exe' : 'Unity');
        fs.mkdirSync(path.dirname(editorPath), { recursive: true });
        fs.writeFileSync(editorPath, '', { mode: 0o755 });
        testEditor = new UnityEditor(editorPath, new UnityVersion('6000.0.0f1'));
    });

    after(() => {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    describe('GetUnityRunArgs', () => {
        it('passes the .app bundle on macOS', () => {
            const args = UnityEditor.GetUnityRunArgs('/Applications/Unity/Hub/Editor/6000.0.0f1/Unity.app/Contents/MacOS/Unity', '/project', '/logs/run.log', ['-quit']);
            assert.equal(args[3], '/Applications/Unity/Hub/Editor/6000.0.0f1/Unity.app');
        });

        it('lets unity run own -batchmode, -quit, -projectPath and -logFile', () => {
            const args = UnityEditor.GetUnityRunArgs('/editor/Unity', '/project', '/logs/run.log', [
                '-projectPath', '/project',
                '-logFile', '/logs/run.log',
                '-automated',
                '-batchmode',
                '-nographics',
                '-quit',
                '-executeMethod', 'Build.Run',
            ]);

            assert.deepEqual(args, [
                'run', '/project',
                '--editor-path', '/editor/Unity',
                '--log-file', '/logs/run.log',
                '--no-tail',
                '--',
                '-automated',
                '-nographics',
                '-executeMethod', 'Build.Run',
            ]);
        });
    });

    describe('scrubSensitiveArgs', () => {
        it('should redact -username value', () => {
            const args = ['-batchmode', '-username', 'test@example.com', '-quit'];
            const scrubbedArgs = testEditor.scrubSensitiveArgs(args);

            assert.ok(scrubbedArgs.includes('-username'));
            assert.ok(scrubbedArgs.includes('[REDACTED]'));
            assert.ok(!scrubbedArgs.includes('test@example.com'));
            assert.ok(scrubbedArgs.includes('-batchmode'));
            assert.ok(scrubbedArgs.includes('-quit'));
        });

        it('should redact -password value', () => {
            const args = ['-batchmode', '-password', 'SuperSecret123', '-quit'];
            const scrubbedArgs = testEditor.scrubSensitiveArgs(args);

            assert.ok(scrubbedArgs.includes('-password'));
            assert.ok(scrubbedArgs.includes('[REDACTED]'));
            assert.ok(!scrubbedArgs.includes('SuperSecret123'));
        });

        it('should redact -cloudOrganization value', () => {
            const args = ['-batchmode', '-cloudOrganization', 'org-id-12345', '-quit'];
            const scrubbedArgs = testEditor.scrubSensitiveArgs(args);

            assert.ok(scrubbedArgs.includes('-cloudOrganization'));
            assert.ok(scrubbedArgs.includes('[REDACTED]'));
            assert.ok(!scrubbedArgs.includes('org-id-12345'));
        });

        it('should redact -serial value', () => {
            const args = ['-batchmode', '-serial', 'ABC-123-DEF-456', '-quit'];
            const scrubbedArgs = testEditor.scrubSensitiveArgs(args);

            assert.ok(scrubbedArgs.includes('-serial'));
            assert.ok(scrubbedArgs.includes('[REDACTED]'));
            assert.ok(!scrubbedArgs.includes('ABC-123-DEF-456'));
        });

        it('should preserve non-sensitive arguments', () => {
            const args = [
                '-batchmode',
                '-projectPath', '/path/to/project',
                '-buildTarget', 'StandaloneWindows64',
                '-quit'
            ];
            const scrubbedArgs = testEditor.scrubSensitiveArgs(args);

            assert.deepEqual(scrubbedArgs, args);
        });

        it('should handle empty array', () => {
            assert.deepEqual(testEditor.scrubSensitiveArgs([]), []);
        });

        it('should handle sensitive flag at end of array without value', () => {
            const scrubbedArgs = testEditor.scrubSensitiveArgs(['-batchmode', '-quit', '-username']);

            assert.ok(scrubbedArgs.includes('-username'));
            assert.ok(!scrubbedArgs.includes('[REDACTED]'));
        });
    });
});
