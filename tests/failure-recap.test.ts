import { errorRecapLines, isCrashLine, isErrorRecapLine, isStackFrameLine } from '../src/unity-logging';

// a failed IL2CPP step as Bee reports it in the Editor log (6000.0.85f1, Android, com.utilities.buildpipeline CI)
const il2cppCommand = '/home/runner/Unity/Hub/Editor/6000.0.85f1/Editor/Data/il2cpp/build/deploy/il2cpp --convert-to-cpp --assembly=Library/Bee/artifacts/Android/ManagedStripped/DemoApp.dll';
const il2cppSegfault = [
    il2cppCommand,
    '##### CommandLine',
    `"${il2cppCommand.split(' ')[0]}" ${il2cppCommand.split(' ').slice(1).join(' ')}`,
    '##### ExitCode',
    '139 (Segmentation fault)',
    '##### Output',
    il2cppCommand,
    'Segmentation fault (core dumped)',
].join('\n');

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

    it('lists crash lines', () => {
        expect(isErrorRecapLine('Segmentation fault (core dumped)')).toBe(true);
        expect(isCrashLine('Segmentation fault (core dumped)')).toBe(true);
        expect(isCrashLine('139 (Segmentation fault)')).toBe(true);
        expect(isCrashLine('Received signal SIGABRT')).toBe(true);
        expect(isCrashLine('Killed')).toBe(true);
        expect(isCrashLine('Killed 3 stale processes')).toBe(false);
        expect(isCrashLine('Failed to find any valid build reports!')).toBe(false);
    });

    it('puts the exit code and crash of a failed build step ahead of its command line', () => {
        expect(errorRecapLines(il2cppSegfault)).toEqual([
            'il2cpp exited with code 139 (Segmentation fault)',
            'Segmentation fault (core dumped)',
            il2cppCommand,
        ]);
    });

    it('keeps a single-line message as it is', () => {
        expect(errorRecapLines('Failed to find any valid build reports!')).toEqual(['Failed to find any valid build reports!']);
        expect(errorRecapLines("Assets/Foo.cs(2,8): error CS1029: oops\nstack line")).toEqual(["Assets/Foo.cs(2,8): error CS1029: oops"]);
        expect(errorRecapLines('')).toEqual([]);
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
