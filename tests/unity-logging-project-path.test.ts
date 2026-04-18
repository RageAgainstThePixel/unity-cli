import { isFileUnderProjectPath } from '../src/unity-logging';

describe('isFileUnderProjectPath', () => {
    const origPlatform = process.platform;

    afterEach(() => {
        Object.defineProperty(process, 'platform', { value: origPlatform });
    });

    it('returns true for file under unix-style project root', () => {
        expect(isFileUnderProjectPath('/home/runner/proj/Assets/a.cs', '/home/runner/proj')).toBe(true);
    });

    it('returns false when file is outside project', () => {
        expect(isFileUnderProjectPath('/other/Assets/a.cs', '/home/runner/proj')).toBe(false);
    });

    it('on win32 matches case-insensitively', () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        expect(isFileUnderProjectPath('D:/Work/MyProj/Assets/Foo.cs', 'd:/work/myproj')).toBe(true);
    });
});
