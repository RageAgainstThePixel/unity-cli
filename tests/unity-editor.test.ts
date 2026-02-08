import { UnityEditor } from '../src/unity-editor';
import { UnityHub } from '../src/unity-hub';

jest.setTimeout(30000); // UnityHub operations can be slow

describe('UnityEditor', () => {
    const editors: UnityEditor[] = [];

    beforeAll(async () => {
        const unityHub = new UnityHub();
        editors.push(...await unityHub.ListInstalledEditors());
    });

    it('lists available templates for each installed Unity editor', async () => {
        expect(editors).toBeDefined();
        expect(Array.isArray(editors)).toBe(true);

        for (const editor of editors) {
            const templates = editor.GetAvailableTemplates();
            expect(templates).toBeDefined();
            expect(Array.isArray(templates)).toBe(true);
        }
    });

    it('gets a single template by regex for each installed Unity editor', async () => {
        const pattern: string = 'com.unity.template.3d(-cross-platform)?';

        expect(editors).toBeDefined();
        expect(Array.isArray(editors)).toBe(true);

        for (const editor of editors) {
            if (editor.version.isLessThan('2019.0.0')) {
                continue; // Skip versions that do not support templates
            }

            const template = editor.GetTemplatePath(pattern);
            expect(template).toBeDefined();
        }
    });

        describe('scrubSensitiveArgs', () => {
            // Create a simple UnityEditor instance for testing scrubSensitiveArgs
            // We don't need a full editor setup since we're only testing a pure function
            let testEditor: UnityEditor;

            beforeAll(() => {
                // Use the first available editor or create a mock-like one
                if (editors.length > 0) {
                    testEditor = editors[0];
                }
            });

            it('should redact -username value', () => {
                if (!testEditor) {
                    // Skip if no editors available
                    return;
                }

                const args = ['-batchmode', '-username', 'test@example.com', '-quit'];
                const scrubbedArgs = testEditor.scrubSensitiveArgs(args);

                expect(scrubbedArgs).toContain('-username');
                expect(scrubbedArgs).toContain('[REDACTED]');
                expect(scrubbedArgs).not.toContain('test@example.com');
                expect(scrubbedArgs).toContain('-batchmode');
                expect(scrubbedArgs).toContain('-quit');
            });

            it('should redact -password value', () => {
                if (!testEditor) return;

                const args = ['-batchmode', '-password', 'SuperSecret123', '-quit'];
                const scrubbedArgs = testEditor.scrubSensitiveArgs(args);

                expect(scrubbedArgs).toContain('-password');
                expect(scrubbedArgs).toContain('[REDACTED]');
                expect(scrubbedArgs).not.toContain('SuperSecret123');
            });

            it('should redact -cloudOrganization value', () => {
                if (!testEditor) return;

                const args = ['-batchmode', '-cloudOrganization', 'org-id-12345', '-quit'];
                const scrubbedArgs = testEditor.scrubSensitiveArgs(args);

                expect(scrubbedArgs).toContain('-cloudOrganization');
                expect(scrubbedArgs).toContain('[REDACTED]');
                expect(scrubbedArgs).not.toContain('org-id-12345');
            });

            it('should redact -serial value', () => {
                if (!testEditor) return;

                const args = ['-batchmode', '-serial', 'ABC-123-DEF-456', '-quit'];
                const scrubbedArgs = testEditor.scrubSensitiveArgs(args);

                expect(scrubbedArgs).toContain('-serial');
                expect(scrubbedArgs).toContain('[REDACTED]');
                expect(scrubbedArgs).not.toContain('ABC-123-DEF-456');
            });

            it('should redact multiple sensitive values', () => {
                if (!testEditor) return;

                const args = [
                    '-batchmode',
                    '-username', 'user@example.com',
                    '-password', 'MyPassword123',
                    '-cloudOrganization', 'org-xyz',
                    '-quit'
                ];
                const scrubbedArgs = testEditor.scrubSensitiveArgs(args);

                expect(scrubbedArgs).toContain('[REDACTED]');
                expect(scrubbedArgs).not.toContain('user@example.com');
                expect(scrubbedArgs).not.toContain('MyPassword123');
                expect(scrubbedArgs).not.toContain('org-xyz');
                expect(scrubbedArgs).toContain('-batchmode');
                expect(scrubbedArgs).toContain('-quit');
            });

            it('should preserve non-sensitive arguments', () => {
                if (!testEditor) return;

                const args = [
                    '-batchmode',
                    '-projectPath', '/path/to/project',
                    '-buildTarget', 'StandaloneWindows64',
                    '-quit'
                ];
                const scrubbedArgs = testEditor.scrubSensitiveArgs(args);

                expect(scrubbedArgs).toEqual(args);
                expect(scrubbedArgs).toContain('/path/to/project');
                expect(scrubbedArgs).toContain('StandaloneWindows64');
            });

            it('should handle empty array', () => {
                if (!testEditor) return;

                const args: string[] = [];
                const scrubbedArgs = testEditor.scrubSensitiveArgs(args);

                expect(scrubbedArgs).toEqual([]);
            });

            it('should handle sensitive flag at end of array without value', () => {
                if (!testEditor) return;

                const args = ['-batchmode', '-quit', '-username'];
                const scrubbedArgs = testEditor.scrubSensitiveArgs(args);

                // The flag is included but there's no value to redact
                expect(scrubbedArgs).toContain('-username');
                expect(scrubbedArgs).not.toContain('[REDACTED]');
            });
        });
});