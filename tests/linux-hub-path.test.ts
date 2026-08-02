import {
    LINUX_HUB_EXECUTABLE_LEGACY,
    LINUX_HUB_EXECUTABLE_MODERN,
    resolveLinuxHubExecutable,
} from '../src/unity-hub';

describe('resolveLinuxHubExecutable', () => {
    it('prefers UNITY_HUB_PATH when set', () => {
        const exists = jest.fn(() => true);
        expect(resolveLinuxHubExecutable('/custom/unityhub', exists)).toBe('/custom/unityhub');
        expect(exists).not.toHaveBeenCalled();
    });

    it('ignores empty UNITY_HUB_PATH and uses filesystem candidates', () => {
        const exists = (p: string) => p === LINUX_HUB_EXECUTABLE_LEGACY;
        expect(resolveLinuxHubExecutable('', exists)).toBe(LINUX_HUB_EXECUTABLE_LEGACY);
        expect(resolveLinuxHubExecutable(undefined, exists)).toBe(LINUX_HUB_EXECUTABLE_LEGACY);
    });

    it('prefers Hub 3.20+ /usr/lib layout over legacy /opt', () => {
        const exists = (p: string) =>
            p === LINUX_HUB_EXECUTABLE_MODERN || p === LINUX_HUB_EXECUTABLE_LEGACY;
        expect(resolveLinuxHubExecutable(undefined, exists)).toBe(LINUX_HUB_EXECUTABLE_MODERN);
    });

    it('falls back to legacy /opt when modern path is missing', () => {
        const exists = (p: string) => p === LINUX_HUB_EXECUTABLE_LEGACY;
        expect(resolveLinuxHubExecutable(undefined, exists)).toBe(LINUX_HUB_EXECUTABLE_LEGACY);
    });

    it('defaults to modern path when neither layout is installed', () => {
        expect(resolveLinuxHubExecutable(undefined, () => false)).toBe(LINUX_HUB_EXECUTABLE_MODERN);
    });
});
