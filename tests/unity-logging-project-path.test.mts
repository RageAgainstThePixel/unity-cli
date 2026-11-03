import { describe, it, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { isFileUnderProjectPath, normalizeAnnotationPath } from '../dist/unity-logging.js';
import * as path from 'path';

describe('isFileUnderProjectPath', () => {
    const origPlatform = process.platform;

    afterEach(() => {
        Object.defineProperty(process, 'platform', { value: origPlatform });
    });

    it('returns true for file under unix-style project root', () => {
        assert.equal(isFileUnderProjectPath('/home/runner/proj/Assets/a.cs', '/home/runner/proj'), true);
    });

    it('returns false when file is outside project', () => {
        assert.equal(isFileUnderProjectPath('/other/Assets/a.cs', '/home/runner/proj'), false);
    });

    it('on win32 matches case-insensitively', () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        assert.equal(isFileUnderProjectPath('D:/Work/MyProj/Assets/Foo.cs', 'd:/work/myproj'), true);
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
        assert.equal(out.absoluteFile, expectedAbsolute);
        assert.equal(out.annotationFile, 'Assets/Scripts/Foo.cs');
    });

    it('returns only absolute path when file is outside project root', () => {
        const out = normalizeAnnotationPath('/other/Foo.cs', '/home/runner/proj');
        assert.equal(out.absoluteFile, '/other/Foo.cs');
        assert.equal(out.annotationFile, undefined);
    });

    // faking process.platform does not swap the path module, so Windows paths only resolve on Windows
    const windowsIt = process.platform === 'win32' ? it : it.skip;

    windowsIt('normalizes windows relative paths for annotation output', () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        const out = normalizeAnnotationPath('Assets\\UnityCliTests\\CompilerErrors.cs', 'D:\\Work\\MyProj');
        assert.equal(out.absoluteFile, 'D:/Work/MyProj/Assets/UnityCliTests/CompilerErrors.cs');
        assert.equal(out.annotationFile, 'Assets/UnityCliTests/CompilerErrors.cs');
    });

    windowsIt('supports windows case-insensitive project roots', () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        const out = normalizeAnnotationPath('D:\\WORK\\MYPROJ\\Assets\\Bar.cs', 'd:/work/myproj');
        assert.equal(out.annotationFile, 'Assets/Bar.cs');
    });
});
