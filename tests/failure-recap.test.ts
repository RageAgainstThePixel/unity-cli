import { isErrorRecapLine, isStackFrameLine } from '../src/unity-logging';

describe('failure recap line detection', () => {
    it('lists error lines, including ones without a project file', () => {
        expect(isErrorRecapLine("Assets/Foo.cs(2,8): error CS1029: #error: 'Intentional compiler error'")).toBe(true);
        expect(isErrorRecapLine('No valid Unity Editor license found. Please activate your license.')).toBe(true);
        expect(isErrorRecapLine('Aborting batchmode due to failure:')).toBe(true);
        expect(isErrorRecapLine('NullReferenceException: Object reference not set to an instance of an object')).toBe(true);
        expect(isErrorRecapLine('Failed to activate/update license.')).toBe(true);
    });

    it('skips ordinary lines and zero-error summaries', () => {
        expect(isErrorRecapLine('Refreshing native plugins compatible for Editor in 1.23 ms')).toBe(false);
        expect(isErrorRecapLine('Build completed with 0 errors')).toBe(false);
    });

    it('recognizes stack frames', () => {
        expect(isStackFrameLine('  at UnityEditor.BuildPipeline.BuildPlayer (UnityEditor.BuildPlayerOptions options) [0x00000] in <abc>:0')).toBe(true);
        expect(isStackFrameLine('UnityEngine.Debug:LogError (object)')).toBe(true);
        expect(isStackFrameLine('Utilities.Editor.BuildPipeline.UnityPlayerBuildTools:StartCommandLineBuild () (at Library/PackageCache/x.cs:42)')).toBe(true);
        expect(isStackFrameLine('(Filename: Assets/Foo.cs Line: 12)')).toBe(true);
        expect(isStackFrameLine('#0 0x00007ff6 in Unity::Something')).toBe(true);
        expect(isStackFrameLine("Assets/Foo.cs(2,8): error CS1029: #error: 'Intentional compiler error'")).toBe(false);
    });
});
