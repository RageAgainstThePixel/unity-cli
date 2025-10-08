import { UnityRelease } from '@rage-against-the-pixel/unity-releases-api';
import { UnityHub } from '../src/unity-hub';
import { UnityVersion } from '../src/unity-version';
import { Logger, LogLevel } from '../src/logging';

jest.setTimeout(30000); // UnityHub operations can be slow

describe('UnityHub', () => {
    it('should get the Unity Hub version', async () => {
        const unityHub = new UnityHub();
        const version = await unityHub.Version();
        expect(version).toBeDefined();
        expect(typeof version).toBe('string');
    });

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

    it('should get latest editor release info for a partial version YYYY', async () => {
        const unityHub = new UnityHub();
        const version = new UnityVersion('2021');
        const releaseInfo: UnityRelease = await unityHub.GetEditorReleaseInfo(version);
        expect(releaseInfo).toBeDefined();
        expect(releaseInfo.version).toMatch(/^2021.3.\d+[abcfpx]\d+$/);
    });

    it('should get latest editor release info for a partial version YYYY.x', async () => {
        const unityHub = new UnityHub();
        const version = new UnityVersion('2021.x');
        const releaseInfo: UnityRelease = await unityHub.GetEditorReleaseInfo(version);
        expect(releaseInfo).toBeDefined();
        expect(releaseInfo.version).toMatch(/^2021.3.\d+[abcfpx]\d+$/);
    });

    it('should get latest editor release info for a partial version YYYY.Y.x', async () => {
        const unityHub = new UnityHub();
        const version = new UnityVersion('2021.3.x');
        const releaseInfo: UnityRelease = await unityHub.GetEditorReleaseInfo(version);
        expect(releaseInfo).toBeDefined();
        expect(releaseInfo.version).toMatch(/^2021.3.\d+[abcfpx]\d+$/);
    });

    it('should get release info for multiple channels', async () => {
        const unityHub = new UnityHub();
        const requestedVersionGlob = new UnityVersion('6000.3');
        const channels = ['f', 'b'];
        const releases = await unityHub.ListAvailableReleases();
        expect(releases).toBeDefined();
        expect(Array.isArray(releases)).toBe(true);
        const versionMatch = requestedVersionGlob.findMatch(releases, channels);
        expect(versionMatch).toBeDefined();
        expect(versionMatch.version).toMatch(/^6000.3.\d+[bf]\d+$/);
        const unityReleaseInfo: UnityRelease = await unityHub.GetEditorReleaseInfo(versionMatch);
        expect(unityReleaseInfo).toBeDefined();
        expect(unityReleaseInfo.version).toBe(versionMatch.version);
        expect(unityReleaseInfo.shortRevision).toBeDefined();
        const resolvedVersion = new UnityVersion(unityReleaseInfo.version, unityReleaseInfo.shortRevision, versionMatch.architecture);
        expect(resolvedVersion.isFullyQualified()).toBe(true);
    });
});