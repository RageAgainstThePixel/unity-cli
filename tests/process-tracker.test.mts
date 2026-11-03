import { describe, it, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import { IsExecutableNamed, IsPathUnder, ParseElapsedSeconds, type ProcessDetails, SelectOwnedProcesses } from '../dist/process-tracker.js';

describe('process tracker', () => {
    const platform = process.platform;
    const setPlatform = (value: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value });

    afterEach(() => setPlatform(platform));

    const proc = (fields: Partial<ProcessDetails> & { pid: number }): ProcessDetails => ({
        ppid: 1,
        name: 'p',
        commandLine: 'p',
        ...fields,
    });

    it('selects only the members of owned process groups on macOS and Linux', () => {
        setPlatform('linux');
        const processes = [
            proc({ pid: 100, pgid: 100, name: '/opt/unity/Editor/Unity' }),
            proc({ pid: 101, ppid: 1, pgid: 100, name: '/opt/unity/Editor/Data/Tools/bee_backend' }),
            proc({ pid: 200, pgid: 200, name: '/opt/unity/Editor/Unity' }),
            proc({ pid: 201, ppid: 200, pgid: 200, name: '/opt/unity/Editor/Data/Tools/bee_backend' }),
        ];

        assert.deepEqual(SelectOwnedProcesses([{ pid: 100, startedAt: 0 }], processes).map(p => p.pid), [100, 101]);
    });

    it('selects descendants created after the root on Windows, skipping a reused parent id', () => {
        setPlatform('win32');
        const processes = [
            proc({ pid: 100, ppid: 4, createdAt: 10_000 }),
            proc({ pid: 101, ppid: 100, createdAt: 11_000 }),
            proc({ pid: 102, ppid: 101, createdAt: 12_000 }),
            // created long before the run, so its parent id 100 belonged to an earlier process
            proc({ pid: 300, ppid: 100, createdAt: 1_000 }),
            proc({ pid: 200, ppid: 4, createdAt: 11_000 }),
        ];

        assert.deepEqual(SelectOwnedProcesses([{ pid: 100, startedAt: 10_000 }], processes).map(p => p.pid).sort(), [100, 101, 102]);
    });

    it('skips a reused group id on macOS and Linux', () => {
        setPlatform('darwin');
        const processes = [
            proc({ pid: 101, pgid: 100, createdAt: 11_000 }),
            // a group led by a later process that reused the root's pid, started before the root was recorded
            proc({ pid: 102, pgid: 100, createdAt: 1_000 }),
        ];

        assert.deepEqual(SelectOwnedProcesses([{ pid: 100, startedAt: 10_000 }], processes).map(p => p.pid), [101]);
    });

    it('parses ps elapsed times', () => {
        assert.equal(ParseElapsedSeconds('05'), 5);
        assert.equal(ParseElapsedSeconds('01:05'), 65);
        assert.equal(ParseElapsedSeconds('02:01:05'), 7265);
        assert.equal(ParseElapsedSeconds('1-02:01:05'), 93665);
    });

    it('selects nothing without roots', () => {
        assert.deepEqual(SelectOwnedProcesses([], [proc({ pid: 1, pgid: 1 })]), []);
    });

    it('compares paths on whole segments', () => {
        const root = path.resolve('editors', '6000.0.1f1');
        assert.equal(IsPathUnder(path.join(root, 'Editor', 'Unity'), root), true);
        assert.equal(IsPathUnder(path.resolve('editors', '6000.0.1f1-arm64', 'Editor', 'Unity'), root), false);
    });

    it('matches an executable by its file name', () => {
        const client = proc({ pid: 1, name: 'Unity.Licensing.Client.exe', executablePath: 'C:\\Unity\\Unity.Licensing.Client.exe', commandLine: '"C:\\Unity\\Unity.Licensing.Client.exe" --namedPipe x' });
        const mention = proc({ pid: 2, name: 'pwsh.exe', executablePath: 'C:\\pwsh.exe', commandLine: 'pwsh -c Unity.Licensing.Client' });
        assert.equal(IsExecutableNamed(client, 'Unity.Licensing.Client'), true);
        assert.equal(IsExecutableNamed(mention, 'Unity.Licensing.Client'), false);
    });
});
