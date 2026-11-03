import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import * as assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { UnityInstaller } from '../dist/unity-installer.js';
import { UnityVersion } from '../dist/unity-version.js';

// the package index re-exports its client through getters, so mock the client where it is defined
const releasesClient = createRequire(import.meta.url)('@rage-against-the-pixel/unity-releases-api/dist/client.js');

const mockGetUnityReleases = mock.fn();

describe('UnityInstaller GetEditorReleaseInfo (sparse API rows)', () => {
    beforeEach(() => {
        mockGetUnityReleases.mock.resetCalls();
        mock.method(releasesClient, 'UnityReleasesClient', function () {
            return {
                api: {
                    Release: {
                        getUnityReleases: mockGetUnityReleases,
                    },
                },
            };
        });
    });

    afterEach(() => {
        mock.restoreAll();
    });

    it('skips results with missing or empty version and still returns the first stable f release', async () => {
        mockGetUnityReleases.mock.mockImplementation(async () => ({
            data: {
                results: [
                    {},
                    { version: undefined, shortRevision: 'bad1' },
                    { version: null as unknown as string, shortRevision: 'bad2' },
                    { version: '', shortRevision: 'bad3' },
                    {
                        version: '2021.3.45f1',
                        shortRevision: 'goodrev',
                        recommended: true,
                    },
                ],
            },
            error: undefined,
        }));
        const info = await UnityInstaller.GetEditorReleaseInfo(new UnityVersion('2021'));

        assert.equal(info.version, '2021.3.45f1');
        assert.equal(info.shortRevision, 'goodrev');
    });

    it('throws when no result row has a usable version for stable channel', async () => {
        mockGetUnityReleases.mock.mockImplementation(async () => ({
            data: {
                results: [{}, { version: undefined }, { version: '2021.3.1a1', shortRevision: 'onlyalpha' }],
            },
            error: undefined,
        }));
        await assert.rejects(UnityInstaller.GetEditorReleaseInfo(new UnityVersion('2021')), /No suitable Unity releases/);
    });

    it('accepts beta releases when channel b is requested', async () => {
        mockGetUnityReleases.mock.mockImplementation(async () => ({
            data: {
                results: [
                    { version: '6000.6.0b7', shortRevision: '53d4abb44f07' },
                    { version: '6000.5.7f1', shortRevision: 'stable' },
                ],
            },
            error: undefined,
        }));
        const info = await UnityInstaller.GetEditorReleaseInfo(new UnityVersion('6000.6'), ['b']);
        assert.equal(info.version, '6000.6.0b7');
        assert.equal(info.shortRevision, '53d4abb44f07');
    });
});
