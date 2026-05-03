import { isFileUnderProjectPath, normalizeAnnotationPath } from '../src/unity-logging';
import * as path from 'path';

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

describe('normalizeAnnotationPath', () => {
    const origPlatform = process.platform;

    afterEach(() => {
        Object.defineProperty(process, 'platform', { value: origPlatform });
    });

    it('resolves relative project file to project-relative annotation path', () => {
        const out = normalizeAnnotationPath('Assets/Scripts/Foo.cs', '/home/runner/proj');
        const expectedAbsolute = path.resolve('/home/runner/proj', 'Assets/Scripts/Foo.cs').replace(/\\/g, '/');
        expect(out.absoluteFile).toBe(expectedAbsolute);
        expect(out.annotationFile).toBe('Assets/Scripts/Foo.cs');
    });

    it('returns only absolute path when file is outside project root', () => {
        const out = normalizeAnnotationPath('/other/Foo.cs', '/home/runner/proj');
        expect(out.absoluteFile).toBe('/other/Foo.cs');
        expect(out.annotationFile).toBeUndefined();
    });

    it('normalizes windows relative paths for annotation output', () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        const out = normalizeAnnotationPath('Assets\\UnityCliTests\\CompilerErrors.cs', 'D:\\Work\\MyProj');
        expect(out.absoluteFile).toBe('D:/Work/MyProj/Assets/UnityCliTests/CompilerErrors.cs');
        expect(out.annotationFile).toBe('Assets/UnityCliTests/CompilerErrors.cs');
    });

    it('supports windows case-insensitive project roots', () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        const out = normalizeAnnotationPath('D:\\WORK\\MYPROJ\\Assets\\Bar.cs', 'd:/work/myproj');
        expect(out.annotationFile).toBe('Assets/Bar.cs');
    });
});
