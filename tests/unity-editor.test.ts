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
            const template = editor.GetTemplatePath(pattern);
            expect(template).toBeDefined();
        }
    });
});