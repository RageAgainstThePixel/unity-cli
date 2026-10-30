import * as fs from 'fs';
import * as path from 'path';
import { ChildProcess } from 'child_process';
import { Logger } from './logging';
import { Exec, GetTempDir, ProcInfo } from './utilities';

/**
 * Tracks the processes unity-cli starts, so cleanup stops only those and their helpers, never another job's.
 *
 * On macOS and Linux each tracked process leads its own process group, and every helper it starts (the editor's
 * shader compiler and bee_backend, a licensing client's background instance) stays in that group even after it is
 * re-parented to pid 1. On Windows a process keeps its parent's id after the parent exits, so helpers are found by
 * walking parent ids from the tracked process, limited to processes created after it started.
 *
 * Tracked processes are recorded in a file under the runner's temp folder, so a later command in the same job, such as
 * return-license, can stop what an earlier one left running. Each runner instance has its own temp folder, so jobs that
 * share a self-hosted machine never see each other's records.
 */

/** A process unity-cli started. */
export interface OwnedRoot {
    pid: number;
    /** Milliseconds since the epoch, taken just before the process was spawned. */
    startedAt: number;
}

/** A running process with the details ownership is decided by. */
export interface ProcessDetails extends ProcInfo {
    /** The process group id; macOS and Linux only. */
    pgid?: number;
    /** Milliseconds since the epoch; Windows only. */
    createdAt?: number;
    /** The executable path when the platform reports it. */
    executablePath?: string | undefined;
    /** The full command line. */
    commandLine: string;
}

const logger = Logger.instance;

/** Options that make a spawned process lead its own process group on macOS and Linux. */
export function OwnedSpawnOptions(): { detached: boolean } {
    return { detached: process.platform !== 'win32' };
}

function stateFilePath(): string {
    return path.join(GetTempDir(), 'unity-cli-owned-processes.json');
}

/** The processes recorded by this job's earlier and current commands. */
export function ReadOwnedRoots(): OwnedRoot[] {
    try {
        const roots = JSON.parse(fs.readFileSync(stateFilePath(), 'utf-8'));
        return Array.isArray(roots)
            ? roots.filter((root): root is OwnedRoot => Number.isInteger(root?.pid) && Number.isFinite(root?.startedAt))
            : [];
    } catch {
        return [];
    }
}

/**
 * Records a process this command started. Only done in CI, where cleanup runs.
 * @param child The spawned process, started with {@link OwnedSpawnOptions}.
 * @param startedAt When it was spawned, in milliseconds since the epoch.
 */
export function TrackOwnedProcess(child: ChildProcess, startedAt: number): void {
    if (process.env.CI !== 'true' || !child.pid) {
        return;
    }

    try {
        const roots = ReadOwnedRoots().filter(root => root.pid !== child.pid);
        roots.push({ pid: child.pid, startedAt });
        fs.writeFileSync(stateFilePath(), JSON.stringify(roots), { encoding: 'utf-8', mode: 0o600 });
    } catch (error) {
        logger.debug(`Failed to record process ${child.pid}: ${error}`);
    }
}

/** Lists running processes with their group, creation time and command line. */
export async function ListProcesses(): Promise<ProcessDetails[]> {
    const results: ProcessDetails[] = [];

    try {
        if (process.platform === 'win32') {
            const output = await Exec('powershell', [
                '-NoProfile',
                '-Command',
                'Get-CimInstance Win32_Process | ForEach-Object { $c = if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { 0 }; "$($_.ProcessId)`t$($_.ParentProcessId)`t$c`t$($_.Name)`t$($_.ExecutablePath)`t$($_.CommandLine)" }'
            ], { silent: true, showCommand: false });

            for (const line of output.split(/\r?\n/)) {
                const [pid, ppid, created, name, executable, ...commandLine] = line.split('\t');

                if (pid && ppid && /^\d+$/.test(pid)) {
                    results.push({
                        pid: parseInt(pid, 10),
                        ppid: parseInt(ppid, 10),
                        createdAt: parseInt(created ?? '0', 10) || 0,
                        name: name ?? '',
                        executablePath: executable || undefined,
                        commandLine: commandLine.join('\t'),
                    });
                }
            }
        } else {
            // etime is the elapsed time as [[dd-]hh:]mm:ss, which both macOS and Linux ps report
            const output = await Exec('ps', ['-axo', 'pid=,ppid=,pgid=,etime=,args='], { silent: true, showCommand: false });
            const now = Date.now();

            for (const line of output.split('\n')) {
                const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d:-]+)\s+(.*)$/.exec(line);

                if (match) {
                    results.push({
                        pid: parseInt(match[1]!, 10),
                        ppid: parseInt(match[2]!, 10),
                        pgid: parseInt(match[3]!, 10),
                        createdAt: now - ParseElapsedSeconds(match[4]!) * 1000,
                        name: match[5]!,
                        commandLine: match[5]!,
                    });
                }
            }
        }
    } catch (error) {
        logger.debug(`Failed to list processes: ${error}`);
    }

    return results.filter(proc => proc.pid !== process.pid);
}

/**
 * The running processes that belong to the given roots: on macOS and Linux every member of their process groups, on
 * Windows the roots and their descendants created after the root started.
 * @param roots The processes unity-cli started.
 * @param processes A process list from {@link ListProcesses}.
 */
export function SelectOwnedProcesses(roots: OwnedRoot[], processes: ProcessDetails[]): ProcessDetails[] {
    if (roots.length === 0) {
        return [];
    }

    // a dead process's id can be reused by another job, so a member must be no older than the root it belongs to;
    // ps reports whole seconds, hence the slack
    const earliest = Math.min(...roots.map(root => root.startedAt)) - 2000;

    if (process.platform !== 'win32') {
        const groups = new Map(roots.map(root => [root.pid, root.startedAt - 2000] as const));
        return processes.filter(proc => proc.pgid !== undefined && groups.has(proc.pgid) &&
            (proc.createdAt === undefined || proc.createdAt >= groups.get(proc.pgid)!));
    }
    const owned = new Map<number, ProcessDetails>();
    let frontier = new Set(roots.map(root => root.pid));

    for (const proc of processes) {
        if (frontier.has(proc.pid) && (proc.createdAt ?? 0) >= earliest) {
            owned.set(proc.pid, proc);
        }
    }

    while (frontier.size > 0) {
        const next = new Set<number>();

        for (const proc of processes) {
            if (!owned.has(proc.pid) && frontier.has(proc.ppid) && (proc.createdAt ?? 0) >= earliest) {
                owned.set(proc.pid, proc);
                next.add(proc.pid);
            }
        }

        frontier = next;
    }

    return [...owned.values()];
}

/**
 * Converts a ps elapsed time, [[dd-]hh:]mm:ss, to seconds.
 * @param elapsed The etime value.
 */
export function ParseElapsedSeconds(elapsed: string): number {
    const [days, clock] = elapsed.includes('-') ? elapsed.split('-', 2) as [string, string] : ['0', elapsed];
    const parts = clock.split(':').map(part => parseInt(part, 10) || 0);

    while (parts.length < 3) {
        parts.unshift(0);
    }

    return (parseInt(days, 10) || 0) * 86400 + parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
}

/** The running processes this job's unity-cli commands started, and their helpers. */
export async function FindOwnedProcesses(): Promise<ProcessDetails[]> {
    const roots = ReadOwnedRoots();
    return roots.length === 0 ? [] : SelectOwnedProcesses(roots, await ListProcesses());
}

/**
 * Whether a process's executable is the named one, e.g. Unity.Licensing.Client.
 * @param proc The process.
 * @param name The executable file name, without .exe.
 */
export function IsExecutableNamed(proc: ProcessDetails, name: string): boolean {
    const target = name.toLowerCase();
    const executable = (proc.executablePath ?? proc.commandLine.split(' ')[0] ?? proc.name).toLowerCase();
    return path.basename(executable).replace(/\.exe$/, '') === target || proc.name.toLowerCase().replace(/\.exe$/, '') === target;
}

/**
 * Whether a path lies inside a directory, compared on whole path segments.
 * @param candidate The path to check.
 * @param directory The directory.
 */
export function IsPathUnder(candidate: string, directory: string): boolean {
    const normalize = (value: string) => {
        const resolved = path.resolve(value);
        return process.platform === 'win32' || process.platform === 'darwin' ? resolved.toLowerCase() : resolved;
    };
    const root = normalize(directory);
    const target = normalize(candidate);
    return target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}
