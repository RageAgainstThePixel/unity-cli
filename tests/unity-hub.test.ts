import { UnityHub } from '../src/unity-hub';

jest.setTimeout(30000); // UnityHub operations can be slow

describe('UnityHub', () => {
    it('should list installed editors', async () => {
        const unityHub = new UnityHub();
        const editors = await unityHub.ListInstalledEditors();

        expect(editors).toBeDefined();
        expect(Array.isArray(editors)).toBe(true);

        if (editors.length > 0) {
            for (const editor of editors) {
                expect(editor).toHaveProperty('version');
                expect(editor).toHaveProperty('editorPath');
                expect(editor).toHaveProperty('editorRootPath');
            }
        } else {
            console.warn('No Unity editors installed. Skipping ListInstalledEditors tests.');
        }
    });
});