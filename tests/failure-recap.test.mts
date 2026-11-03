import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { errorRecapLines, FailureRecap, isCrashLine, isErrorRecapLine, isStackFrameLine } from '../dist/unity-logging.js';

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
        assert.equal(isErrorRecapLine("Assets/Foo.cs(2,8): error CS1029: #error: 'Intentional compiler error'"), true);
        assert.equal(isErrorRecapLine('No valid Unity Editor license found. Please activate your license.'), true);
        assert.equal(isErrorRecapLine('Aborting batchmode due to failure:'), true);
        assert.equal(isErrorRecapLine('NullReferenceException: Object reference not set to an instance of an object'), true);
        assert.equal(isErrorRecapLine('Failed to activate/update license.'), true);
    });

    it('skips ordinary lines and zero-error summaries', () => {
        assert.equal(isErrorRecapLine('Refreshing native plugins compatible for Editor in 1.23 ms'), false);
        assert.equal(isErrorRecapLine('Build completed with 0 errors'), false);
    });

    it('lists crash lines', () => {
        assert.equal(isErrorRecapLine('Segmentation fault (core dumped)'), true);
        assert.equal(isCrashLine('Segmentation fault (core dumped)'), true);
        assert.equal(isCrashLine('139 (Segmentation fault)'), true);
        assert.equal(isCrashLine('Received signal SIGABRT'), true);
        assert.equal(isCrashLine('Killed'), true);
        assert.equal(isCrashLine('Aborted'), true);
        assert.equal(isCrashLine('Aborting batchmode due to failure:'), false);
        assert.equal(isCrashLine('Killed 3 stale processes'), false);
        assert.equal(isCrashLine('Failed to find any valid build reports!'), false);
    });

    it('puts the exit code and crash of a failed build step ahead of its command line', () => {
        assert.deepEqual(errorRecapLines(il2cppSegfault), [
            'il2cpp exited with code 139 (Segmentation fault)',
            'Segmentation fault (core dumped)',
            il2cppCommand,
        ]);
    });

    it('keeps a single-line message as it is', () => {
        assert.deepEqual(errorRecapLines('Failed to find any valid build reports!'), ['Failed to find any valid build reports!']);
        assert.deepEqual(errorRecapLines("Assets/Foo.cs(2,8): error CS1029: oops\nstack line"), ["Assets/Foo.cs(2,8): error CS1029: oops"]);
        assert.deepEqual(errorRecapLines(''), []);
    });

    it('turns a Bee block in the plain Editor log into one exit line', () => {
        const recap = new FailureRecap();
        const feed = (line: string): void => recap.addPlainLine(line, isErrorRecapLine(line));

        feed('Failed to find any valid build reports!');
        il2cppSegfault.split('\n').slice(1).forEach(feed);

        assert.deepEqual(recap.lines, [
            'il2cpp exited with code 139 (Segmentation fault)',
            'Segmentation fault (core dumped)',
            'Failed to find any valid build reports!',
        ]);
    });

    it('reports a plain numeric exit code from the plain Editor log', () => {
        const recap = new FailureRecap();

        ['##### CommandLine', '"C:\\Unity\\Editor\\Data\\il2cpp\\build\\deploy\\il2cpp.exe" --convert-to-cpp', '##### ExitCode', '1', '##### Output', 'done']
            .forEach(line => recap.addPlainLine(line, isErrorRecapLine(line)));

        assert.deepEqual(recap.lines, ['il2cpp.exe exited with code 1']);
    });

    it('skips a successful step and keeps ordinary error lines', () => {
        const recap = new FailureRecap();

        ['##### CommandLine', 'tool --arg', '##### ExitCode', '0', 'Assets/Foo.cs(1,1): error CS0001: oops']
            .forEach(line => recap.addPlainLine(line, isErrorRecapLine(line)));

        assert.deepEqual(recap.lines, ['Assets/Foo.cs(1,1): error CS0001: oops']);
    });

    it('lets a crash line push out an ordinary line once the recap is full', () => {
        const recap = new FailureRecap(2);

        recap.add('error one');
        recap.add('error two');
        recap.add('error three');
        recap.add('Segmentation fault (core dumped)');

        assert.deepEqual(recap.lines, ['Segmentation fault (core dumped)', 'error one']);
        assert.equal(recap.count, 4);
    });

    it('records a telemetry message with its crash and exit lines first', () => {
        const recap = new FailureRecap();

        recap.addMessage(il2cppSegfault);
        recap.addMessage('Failed to find any valid build reports!');

        assert.deepEqual(recap.lines, [
            'il2cpp exited with code 139 (Segmentation fault)',
            'Segmentation fault (core dumped)',
            il2cppCommand,
            'Failed to find any valid build reports!',
        ]);
    });

    it('recognizes stack frames', () => {
        assert.equal(isStackFrameLine('  at UnityEditor.BuildPipeline.BuildPlayer (UnityEditor.BuildPlayerOptions options) [0x00000] in <abc>:0'), true);
        assert.equal(isStackFrameLine('UnityEngine.Debug:LogError (object)'), true);
        assert.equal(isStackFrameLine('Utilities.Editor.BuildPipeline.UnityPlayerBuildTools:StartCommandLineBuild () (at Library/PackageCache/x.cs:42)'), true);
        assert.equal(isStackFrameLine('(Filename: Assets/Foo.cs Line: 12)'), true);
        assert.equal(isStackFrameLine('#0 0x00007ff6 in Unity::Something'), true);
        assert.equal(isStackFrameLine("Assets/Foo.cs(2,8): error CS1029: #error: 'Intentional compiler error'"), false);
    });
});
