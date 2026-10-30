import * as path from 'path';
import { IsExecutableNamed, IsPathUnder, ParseElapsedSeconds, ProcessDetails, SelectOwnedProcesses } from '../src/process-tracker';

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

        expect(SelectOwnedProcesses([{ pid: 100, startedAt: 0 }], processes).map(p => p.pid)).toEqual([100, 101]);
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

        expect(SelectOwnedProcesses([{ pid: 100, startedAt: 10_000 }], processes).map(p => p.pid).sort()).toEqual([100, 101, 102]);
    });

    it('skips a reused group id on macOS and Linux', () => {
        setPlatform('darwin');
        const processes = [
            proc({ pid: 101, pgid: 100, createdAt: 11_000 }),
            // a group led by a later process that reused the root's pid, started before the root was recorded
            proc({ pid: 102, pgid: 100, createdAt: 1_000 }),
        ];

        expect(SelectOwnedProcesses([{ pid: 100, startedAt: 10_000 }], processes).map(p => p.pid)).toEqual([101]);
    });

    it('parses ps elapsed times', () => {
        expect(ParseElapsedSeconds('05')).toBe(5);
        expect(ParseElapsedSeconds('01:05')).toBe(65);
        expect(ParseElapsedSeconds('02:01:05')).toBe(7265);
        expect(ParseElapsedSeconds('1-02:01:05')).toBe(93665);
    });

    it('selects nothing without roots', () => {
        expect(SelectOwnedProcesses([], [proc({ pid: 1, pgid: 1 })])).toEqual([]);
    });

    it('compares paths on whole segments', () => {
        const root = path.resolve('editors', '6000.0.1f1');
        expect(IsPathUnder(path.join(root, 'Editor', 'Unity'), root)).toBe(true);
        expect(IsPathUnder(path.resolve('editors', '6000.0.1f1-arm64', 'Editor', 'Unity'), root)).toBe(false);
    });

    it('matches an executable by its file name', () => {
        const client = proc({ pid: 1, name: 'Unity.Licensing.Client.exe', executablePath: 'C:\\Unity\\Unity.Licensing.Client.exe', commandLine: '"C:\\Unity\\Unity.Licensing.Client.exe" --namedPipe x' });
        const mention = proc({ pid: 2, name: 'pwsh.exe', executablePath: 'C:\\pwsh.exe', commandLine: 'pwsh -c Unity.Licensing.Client' });
        expect(IsExecutableNamed(client, 'Unity.Licensing.Client')).toBe(true);
        expect(IsExecutableNamed(mention, 'Unity.Licensing.Client')).toBe(false);
    });
});
