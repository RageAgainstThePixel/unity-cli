import { UnityReleasesClient } from '@rage-against-the-pixel/unity-releases-api';
import { UnityHub } from '../src/unity-hub';
import { UnityVersion } from '../src/unity-version';

jest.mock('@rage-against-the-pixel/unity-releases-api', () => {
    const actual = jest.requireActual<typeof import('@rage-against-the-pixel/unity-releases-api')>(
        '@rage-against-the-pixel/unity-releases-api'
    );
    return {
        ...actual,
        UnityReleasesClient: jest.fn(),
    };
});

const mockGetUnityReleases = jest.fn();

describe('UnityHub GetEditorReleaseInfo (sparse API rows)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (UnityReleasesClient as jest.Mock).mockImplementation(() => ({
            api: {
                Release: {
                    getUnityReleases: mockGetUnityReleases,
                },
            },
        }));
    });

    it('skips results with missing or empty version and still returns the first stable f release', async () => {
        mockGetUnityReleases.mockResolvedValue({
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
        });

        const hub = new UnityHub();
        const info = await hub.GetEditorReleaseInfo(new UnityVersion('2021'));

        expect(info.version).toBe('2021.3.45f1');
        expect(info.shortRevision).toBe('goodrev');
    });

    it('throws when no result row has a usable version for stable channel', async () => {
        mockGetUnityReleases.mockResolvedValue({
            data: {
                results: [{}, { version: undefined }, { version: '2021.3.1a1', shortRevision: 'onlyalpha' }],
            },
            error: undefined,
        });

        const hub = new UnityHub();
        await expect(hub.GetEditorReleaseInfo(new UnityVersion('2021'))).rejects.toThrow(/No suitable Unity releases/);
    });

    it('accepts beta releases when channel b is requested', async () => {
        mockGetUnityReleases.mockResolvedValue({
            data: {
                results: [
                    { version: '6000.6.0b7', shortRevision: '53d4abb44f07' },
                    { version: '6000.5.7f1', shortRevision: 'stable' },
                ],
            },
            error: undefined,
        });

        const hub = new UnityHub();
        const info = await hub.GetEditorReleaseInfo(new UnityVersion('6000.6'), ['b']);
        expect(info.version).toBe('6000.6.0b7');
        expect(info.shortRevision).toBe('53d4abb44f07');
    });
});
