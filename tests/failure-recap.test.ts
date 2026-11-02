import { errorRecapLines, FailureRecap, isCrashLine, isErrorRecapLine, isStackFrameLine } from '../src/unity-logging';

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
        expect(isCrashLine('Aborted')).toBe(true);
        expect(isCrashLine('Aborting batchmode due to failure:')).toBe(false);
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

    it('turns a Bee block in the plain Editor log into one exit line', () => {
        const recap = new FailureRecap();
        const feed = (line: string): void => recap.addPlainLine(line, isErrorRecapLine(line));

        feed('Failed to find any valid build reports!');
        il2cppSegfault.split('\n').slice(1).forEach(feed);

        expect(recap.lines).toEqual([
            'il2cpp exited with code 139 (Segmentation fault)',
            'Segmentation fault (core dumped)',
            'Failed to find any valid build reports!',
        ]);
    });

    it('reports a plain numeric exit code from the plain Editor log', () => {
        const recap = new FailureRecap();

        ['##### CommandLine', '"C:\\Unity\\Editor\\Data\\il2cpp\\build\\deploy\\il2cpp.exe" --convert-to-cpp', '##### ExitCode', '1', '##### Output', 'done']
            .forEach(line => recap.addPlainLine(line, isErrorRecapLine(line)));

        expect(recap.lines).toEqual(['il2cpp.exe exited with code 1']);
    });

    it('skips a successful step and keeps ordinary error lines', () => {
        const recap = new FailureRecap();

        ['##### CommandLine', 'tool --arg', '##### ExitCode', '0', 'Assets/Foo.cs(1,1): error CS0001: oops']
            .forEach(line => recap.addPlainLine(line, isErrorRecapLine(line)));

        expect(recap.lines).toEqual(['Assets/Foo.cs(1,1): error CS0001: oops']);
    });

    it('lets a crash line push out an ordinary line once the recap is full', () => {
        const recap = new FailureRecap(2);

        recap.add('error one');
        recap.add('error two');
        recap.add('error three');
        recap.add('Segmentation fault (core dumped)');

        expect(recap.lines).toEqual(['Segmentation fault (core dumped)', 'error one']);
        expect(recap.count).toBe(4);
    });

    it('records a telemetry message with its crash and exit lines first', () => {
        const recap = new FailureRecap();

        recap.addMessage(il2cppSegfault);
        recap.addMessage('Failed to find any valid build reports!');

        expect(recap.lines).toEqual([
            'il2cpp exited with code 139 (Segmentation fault)',
            'Segmentation fault (core dumped)',
            il2cppCommand,
            'Failed to find any valid build reports!',
        ]);
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
