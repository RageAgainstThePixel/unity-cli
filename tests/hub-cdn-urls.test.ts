/**
 * Locks Hub CDN URL contracts against Unity's public CDN (HEAD, short timeouts).
 * Fails if Unity removes or reshuffles artifacts we rely on.
 */
jest.setTimeout(90_000);

async function httpStatus(url: string, method: 'HEAD' | 'GET' = 'HEAD'): Promise<number> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
        const res = await fetch(url, { method, redirect: 'follow', signal: controller.signal });
        return res.status;
    } finally {
        clearTimeout(timer);
    }
}

describe('Unity Hub public CDN URLs', () => {
    it('serves prod Windows arch-specific installers (not legacy UnityHubSetup.exe)', async () => {
        expect(await httpStatus('https://public-cdn.cloud.unity3d.com/hub/prod/UnityHubSetup-x64.exe')).toBe(200);
        expect(await httpStatus('https://public-cdn.cloud.unity3d.com/hub/prod/UnityHubSetup-arm64.exe')).toBe(200);
        expect(await httpStatus('https://public-cdn.cloud.unity3d.com/hub/prod/UnityHubSetup.exe')).toBe(404);
    });

    it('serves pinned Hub semver Windows layout (single UnityHubSetup.exe)', async () => {
        expect(await httpStatus('https://public-cdn.cloud.unity3d.com/hub/3.12.0/UnityHubSetup.exe')).toBe(200);
        expect(await httpStatus('https://public-cdn.cloud.unity3d.com/hub/3.12.0/UnityHubSetup-x64.exe')).toBe(404);
        expect(await httpStatus('https://public-cdn.cloud.unity3d.com/hub/3.12.0/UnityHubSetup-arm64.exe')).toBe(404);
    });

    it('serves prod and pinned Hub macOS arm64 dmgs (installer path used by unity-cli)', async () => {
        expect(await httpStatus('https://public-cdn.cloud.unity3d.com/hub/prod/UnityHubSetup-arm64.dmg')).toBe(200);
        expect(await httpStatus('https://public-cdn.cloud.unity3d.com/hub/3.12.0/UnityHubSetup-arm64.dmg')).toBe(200);
    });

    it('serves latest.yml for Hub version discovery (latest-linux.yml is not published)', async () => {
        expect(await httpStatus('https://public-cdn.cloud.unity3d.com/hub/prod/latest.yml')).toBe(200);
        expect(await httpStatus('https://public-cdn.cloud.unity3d.com/hub/prod/latest-mac.yml')).toBe(200);
        expect(await httpStatus('https://public-cdn.cloud.unity3d.com/hub/prod/latest-linux.yml')).toBe(404);
    });
});
