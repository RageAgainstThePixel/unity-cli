import { UTP, Severity } from './utp';
import { GitHubActionsLoggerProvider, GitHubAnnotationLevel } from './github-actions-ci';
import { ILoggerProvider, LocalCliLoggerProvider, LoggerAnnotationOptions, MarkdownTarget } from './logger-provider';

const TRUNCATE_MSG = 120;

/** Severity order for display: Error first, then Warning, then Info. Undefined treats as Warning. */
function severityRank(s: string | undefined): number {
    if (s === Severity.Error || s === Severity.Exception || s === Severity.Assert) return 0;
    if (s === Severity.Warning || s === undefined) return 1;
    return 2; // Info
}

function dedupeKey(e: UTP): string {
    const msg = (e.message || '').trim();
    const file = (e.file || (e as { fileName?: string }).fileName || '').replace(/\\/g, '/');
    const line = e.line ?? (e as { lineNumber?: number }).lineNumber ?? 0;
    return `${msg}\n${file}\n${line}`;
}

/**
 * Returns true if the path looks absolute (Unix / or Windows X:/).
 */
function isAbsolutePath(file: string): boolean {
    const norm = file.replace(/\\/g, '/');
    if (norm.startsWith('/')) return true;
    return /^[a-zA-Z]:\//.test(norm);
}

/**
 * Returns true if the entry's file is under the project path (or entry has no file).
 * Relative paths (e.g. Assets/..., Packages/...) are always kept so Unity UTP log/compiler
 * entries with relative file paths still appear in the summary.
 */
function isEntryUnderProjectPath(e: UTP, projectPath: string): boolean {
    const file = (e.file || (e as { fileName?: string }).fileName || '').trim();
    if (!file) return true;
    const normFile = file.replace(/\\/g, '/');
    if (!isAbsolutePath(normFile)) return true;
    const normProject = projectPath.replace(/\\/g, '/');
    const base = normProject.endsWith('/') ? normProject : normProject + '/';
    return normFile === normProject || normFile.startsWith(base);
}

/**
 * Returns true if the entry's file looks like a Unity engine path (should be omitted when not using projectPath).
 */
function isUnityEnginePath(file: string): boolean {
    const norm = file.replace(/\\/g, '/');
    if (UNITY_ENGINE_PATH_PREFIXES.some(p => norm.startsWith(p))) return true;
    if (norm.includes('/Runtime/') || norm.includes('\\Runtime\\')) return true;
    if (!norm.endsWith('.cpp')) return false;
    const underProject = norm.includes('/Assets/') || norm.includes('/Packages/') || norm.includes('/Library/PackageCache/');
    return !underProject;
}

/**
 * Merges LogEntry/Compiler rows by message+file+line; on collision keeps the more severe entry.
 * Exported for unit tests.
 */
export function mergeLogEntriesPreferringSeverity(candidates: UTP[]): UTP[] {
    const byKey = new Map<string, UTP>();
    for (const e of candidates) {
        const key = dedupeKey(e);
        const existing = byKey.get(key);
        if (!existing || severityRank(e.severity) < severityRank(existing.severity)) {
            byKey.set(key, e);
        }
    }
    const merged = [...byKey.values()];
    merged.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
    return merged;
}

/**
 * Builds one merged list from LogEntry and Compiler entries.
 * Deduplicated by message+file+line (keeping worse severity on collision), sorted by severity.
 */
function buildMergedLogList(filtered: UTP[]): UTP[] {
    const candidates = filtered.filter(e => e.type === 'LogEntry' || e.type === 'Compiler');
    return mergeLogEntriesPreferringSeverity(candidates);
}

/**
 * Filters merged list to project-relevant entries only.
 * When projectPath is set: keep entries with no file or file under projectPath.
 * When projectPath is not set: exclude Unity engine paths only (keep PackageCache and project paths).
 */
function filterMergedByPath(merged: UTP[], options: { projectPath?: string } | undefined): UTP[] {
    if (options?.projectPath != null && options.projectPath !== '') {
        return merged.filter(e => isEntryUnderProjectPath(e, options.projectPath!));
    }
    return merged.filter(e => {
        const file = (e.file || (e as { fileName?: string }).fileName || '').trim();
        if (!file) return true;
        return !isUnityEnginePath(file);
    });
}

/** Groups merged log by severity for foldouts (Error, Warning, Info). Missing severity is grouped as Warning. */
function groupBySeverity(merged: UTP[]): { errorCritical: UTP[]; warning: UTP[]; info: UTP[] } {
    const errorCritical: UTP[] = [];
    const warning: UTP[] = [];
    const info: UTP[] = [];
    for (const e of merged) {
        if (e.severity === Severity.Error || e.severity === Severity.Exception || e.severity === Severity.Assert) {
            errorCritical.push(e);
        } else if (e.severity === Severity.Warning || e.severity === undefined) {
            warning.push(e);
        } else {
            info.push(e);
        }
    }
    return { errorCritical, warning, info };
}

/** Single test result row for summary and CLI table. */
export interface TestResultSummary {
    status: string;
    durationMs: number;
    description: string;
    message?: string;
    file?: string;
    line?: number;
}

/** Maps UTPTestStatus.state to display status (Unity/NUnit-style: 0 Inconclusive, 1 Passed, 2 Failed, 3 Skipped). */
export function testStatusFromState(state: number | undefined): string {
    switch (state) {
        case 1: return '✅';
        case 2: return '❌';
        case 3: return '⏭️';
        case 0:
        default: return '◯';
    }
}

/** Converts a single TestStatus UTP to TestResultSummary. Exported for CLI use. */
export function utpToTestResultSummary(e: UTP): TestResultSummary {
    const state = (e as { state?: number }).state;
    const durationMs = e.duration ?? (e.durationMicroseconds != null ? e.durationMicroseconds / 1000 : 0);
    const description = (e.name || e.description || '—').trim();
    const msg = (e.message || '').trim();
    const summary: TestResultSummary = {
        status: testStatusFromState(state),
        durationMs,
        description,
    };
    if (msg !== '') {
        summary.message = msg;
    }
    const file = (e.file || (e as { fileName?: string }).fileName || '').trim();
    const line = e.line ?? (e as { lineNumber?: number }).lineNumber;
    if (file !== '') {
        summary.file = file.replace(/\\/g, '/');
    }
    if (line !== undefined && line > 0) {
        summary.line = line;
    }
    return summary;
}

/** Collects TestStatus entries from telemetry into TestResultSummary rows. */
function collectTestResults(filtered: UTP[]): TestResultSummary[] {
    return filtered.filter(e => e.type === 'TestStatus').map(utpToTestResultSummary);
}

function escapeMarkdownTableCell(value: string): string {
    return value
        .replace(/\\/g, '\\\\')
        .replace(/\|/g, '\\|');
}

/** Builds a markdown table string for test results (Status | Duration | Test). Exported for CLI use. */
export function buildTestResultsTableMarkdown(testResults: TestResultSummary[], byteLimit: number, prefix?: string): string {
    if (testResults.length === 0) return '';
    const p = prefix ?? '';
    let out = p + `### Test results\n\n`;
    out += `| Status | Duration | Test |\n`;
    out += `|--------|----------|------|\n`;
    let shown = 0;
    for (const row of testResults) {
        const durationStr = row.durationMs >= 1000
            ? `${(row.durationMs / 1000).toFixed(1)}s`
            : `${Math.round(row.durationMs)} ms`;
        const rawDesc = row.description.length > 80 ? row.description.slice(0, 77) + '…' : row.description;
        const desc = escapeMarkdownTableCell(rawDesc);
        const line = `| ${escapeMarkdownTableCell(row.status)} | ${escapeMarkdownTableCell(durationStr)} | ${desc} |\n`;
        if (Buffer.byteLength(out + line, 'utf8') > byteLimit) break;
        out += line;
        shown++;
    }
    if (shown < testResults.length) {
        out += `| … | … | … and ${testResults.length - shown} more |\n`;
    }
    out += `\n`;
    return out;
}

function summarizeTestOutcomes(testResults: TestResultSummary[]): { passed: number; failed: number; skipped: number; inconclusive: number; totalDurationMs: number } {
    let passed = 0;
    let failed = 0;
    let skipped = 0;
    let inconclusive = 0;
    let totalDurationMs = 0;
    for (const t of testResults) {
        totalDurationMs += t.durationMs;
        switch (t.status) {
            case '✅': passed++; break;
            case '❌': failed++; break;
            case '⏭️': skipped++; break;
            default: inconclusive++; break;
        }
    }
    return { passed, failed, skipped, inconclusive, totalDurationMs };
}

/**
 * Rich unit-test markdown block used by workflow summary and stdout.
 * Keeps byte-budget behavior and truncation hints.
 */
export function buildUnitTestJobSummaryMarkdown(testResults: TestResultSummary[], byteLimit: number, prefix?: string): string {
    if (testResults.length === 0) return '';
    const p = prefix ?? '';
    let out = p + '### Unit test results\n\n';
    const counts = summarizeTestOutcomes(testResults);
    const durationStr = counts.totalDurationMs >= 1000
        ? `${(counts.totalDurationMs / 1000).toFixed(1)}s`
        : `${Math.round(counts.totalDurationMs)} ms`;
    out += `**${testResults.length}** tests — **${counts.passed}** ✓, **${counts.failed}** ✗, **${counts.skipped}** skipped, **${counts.inconclusive}** inconclusive — **${durationStr}** total\n\n`;
    out += '| Test | Result | Time | Message |\n';
    out += '| --- | --- | --- | --- |\n';

    const ordered = [...testResults].sort((a, b) => {
        const aFail = a.status === '❌' ? 0 : 1;
        const bFail = b.status === '❌' ? 0 : 1;
        if (aFail !== bFail) return aFail - bFail;
        return b.durationMs - a.durationMs;
    });

    let shown = 0;
    for (const row of ordered) {
        const durationText = row.durationMs >= 1000 ? `${(row.durationMs / 1000).toFixed(1)}s` : `${Math.round(row.durationMs)} ms`;
        const loc = row.file && row.line ? ` (${row.file}:${row.line})` : '';
        const rawName = `${row.description}${loc}`;
        const name = escapeMarkdownTableCell(rawName.length > 90 ? `${rawName.slice(0, 87)}…` : rawName);
        const msgRaw = (row.message ?? '').replace(/\r?\n/g, ' ').trim();
        const msg = escapeMarkdownTableCell(msgRaw.length > 120 ? `${msgRaw.slice(0, 117)}…` : msgRaw);
        const line = `| ${name} | ${escapeMarkdownTableCell(row.status)} | ${escapeMarkdownTableCell(durationText)} | ${msg} |\n`;
        if (Buffer.byteLength(out + line, 'utf8') > byteLimit) break;
        out += line;
        shown++;
    }
    if (shown < ordered.length) {
        out += `| … | … | … | … and ${ordered.length - shown} more |\n`;
    }
    out += '\n';
    return out;
}

function truncateStr(s: string, max: number): string {
    return s.length <= max ? s : s.slice(0, max) + '…';
}

function toSingleLineText(value: string): string {
    return value
        .replace(/\r?\n+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Paths to treat as Unity engine (omit from summary when using heuristic filter). */
const UNITY_ENGINE_PATH_PREFIXES = [
    'Runtime/',
    './Runtime/',
    'Modules/',
    './Modules/',
];

/**
 * Normalizes a log message for display by stripping a redundant file:line prefix
 * when it matches the entry's file/line so the path appears only once.
 * Returns the normalized message and optional column if present in the prefix.
 */
function normalizeMessageForDisplay(
    message: string,
    file: string,
    line: number | undefined
): { message: string; column?: number } {
    const trimmed = message.trim();
    const normFile = file.replace(/\\/g, '/');
    if (!normFile && line === undefined) return { message: trimmed };

    // path(line,col): e.g. Assets/File.cs(2,8): error ...
    const parenColon = trimmed.match(/^(.+?)\((\d+),(\d+)\):\s*/);
    if (parenColon && parenColon[1] != null && parenColon[2] != null && parenColon[3] != null) {
        const fullMatch = parenColon[0];
        const msgPath = parenColon[1].replace(/\\/g, '/');
        const msgLine = parseInt(parenColon[2], 10);
        const msgCol = parseInt(parenColon[3], 10);
        const pathMatches = msgPath === normFile || normFile.endsWith(msgPath) || msgPath.endsWith(normFile);
        if (pathMatches && (line === undefined || line === msgLine)) {
            return { message: trimmed.slice(fullMatch.length).trim(), column: msgCol };
        }
    }

    // path(line): e.g. Assets/File.cs(2): ...
    const parenOnly = trimmed.match(/^(.+?)\((\d+)\):\s*/);
    if (parenOnly && parenOnly[1] != null && parenOnly[2] != null) {
        const fullMatch = parenOnly[0];
        const msgPath = parenOnly[1].replace(/\\/g, '/');
        const msgLine = parseInt(parenOnly[2], 10);
        const pathMatches = msgPath === normFile || normFile.endsWith(msgPath) || msgPath.endsWith(normFile);
        if (pathMatches && (line === undefined || line === msgLine)) {
            return { message: trimmed.slice(fullMatch.length).trim() };
        }
    }

    // path:line: e.g. path/to/file.cs:10:
    const pathLineColon = trimmed.match(/^(.+?):(\d+):\s*/);
    if (pathLineColon && pathLineColon[1] != null && pathLineColon[2] != null) {
        const fullMatch = pathLineColon[0];
        const msgPath = pathLineColon[1].replace(/\\/g, '/');
        const msgLine = parseInt(pathLineColon[2], 10);
        const pathMatches = msgPath === normFile || normFile.endsWith(msgPath) || msgPath.endsWith(normFile);
        if (pathMatches && (line === undefined || line === msgLine)) {
            return { message: trimmed.slice(fullMatch.length).trim() };
        }
    }

    return { message: trimmed };
}

/**
 * One line per entry: path(line,col): &lt;message&gt; or path(line): &lt;message&gt; when column is missing.
 * When file/line are missing, outputs: - &lt;message&gt;.
 */
function formatLogEntryLine(e: UTP, maxMsgLen: number = TRUNCATE_MSG): string {
    const file = (e.file || (e as { fileName?: string }).fileName || '').replace(/\\/g, '/');
    const line = e.line ?? (e as { lineNumber?: number }).lineNumber;
    const hasLocation = file && (line !== undefined && line > 0);
    const rawMsg = toSingleLineText(e.message || '');
    const { message: normalizedMsg, column } = hasLocation
        ? normalizeMessageForDisplay(rawMsg, file, line)
        : { message: rawMsg, column: undefined as number | undefined };
    const msg = truncateStr(normalizedMsg, maxMsgLen);

    if (hasLocation) {
        const loc = column !== undefined ? `${file}(${line},${column})` : `${file}(${line})`;
        return `${loc}: ${msg}\n`;
    }
    return `${msg}\n`;
}

export enum LogLevel {
    DEBUG = 'debug',
    CI = 'ci',
    UTP = 'utp', // minimal logging level
    INFO = 'info',
    WARN = 'warning',
    ERROR = 'error',
}

export class Logger {
    public logLevel: LogLevel = LogLevel.INFO;
    private readonly _provider: ILoggerProvider;
    static readonly instance: Logger = new Logger();

    private constructor() {
        this._provider = process.env.GITHUB_ACTIONS === 'true'
            ? new GitHubActionsLoggerProvider()
            : new LocalCliLoggerProvider();
        if (process.env.GITHUB_ACTIONS === 'true') {
            this.logLevel = process.env.ACTIONS_STEP_DEBUG === 'true' ? LogLevel.DEBUG : LogLevel.CI;
        }
    }

    /**
     * Logs a message to the console.
     * @param level The log level for this message.
     * @param message The message to log.
     * @param optionalParams Additional parameters to log.
     */
    public log(level: LogLevel, message: any, optionalParams: any[] = []): void {
        if (this.shouldLog(level)) {
            this._provider.log(level, message, optionalParams);
        }
    }

    /**
     * Starts a log group. In CI environments that support grouping, this will create a collapsible group.
     */
    public startGroup(message: any, optionalParams: any[] = [], logLevel: LogLevel = LogLevel.INFO): void {
        if (this._provider.isCi) {
            this._provider.startGroup(message, optionalParams);
            return;
        }
        this.log(logLevel, message, optionalParams);
    }

    /**
     * Ends a log group. In CI environments that support grouping, this will end the current group.
     */
    public endGroup(): void {
        this._provider.endGroup();
    }

    /**
     * Logs a message with CI level.
     * @param message
     * @param optionalParams
     */
    public ci(message: any, ...optionalParams: any[]): void {
        this.log(LogLevel.CI, message, optionalParams);
    }

    public debug(message: any, ...optionalParams: any[]): void {
        this.log(LogLevel.DEBUG, message, optionalParams);
    }

    public info(message: any, ...optionalParams: any[]): void {
        this.log(LogLevel.INFO, message, optionalParams);
    }

    public warn(message: any, ...optionalParams: any[]): void {
        this.log(LogLevel.WARN, message, optionalParams);
    }

    public error(message: any, ...optionalParams: any[]): void {
        this.log(LogLevel.ERROR, message, optionalParams);
    }

    /**
     * Annotates a file and line number in CI environments that support it.
     * @param logLevel The level of the log.
     * @param message The message to annotate.
     * @param file The file to annotate.
     * @param line The line number to annotate.
     * @param endLine The end line number to annotate.
     * @param column The column number to annotate.
     * @param endColumn The end column number to annotate.
     * @param title The title of the annotation.
     */
    public annotate(logLevel: LogLevel, message: string, file?: string, line?: number, endLine?: number, column?: number, endColumn?: number, title?: string): void {
        const level = {
            [LogLevel.CI]: 'notice',
            [LogLevel.INFO]: 'notice',
            [LogLevel.DEBUG]: 'notice',
            [LogLevel.UTP]: 'notice',
            [LogLevel.WARN]: 'warning',
            [LogLevel.ERROR]: 'error',
        }[logLevel] ?? 'notice';
        const options: LoggerAnnotationOptions = {};
        if (file !== undefined && file !== '') { options.file = file; }
        if (line !== undefined) { options.line = line; }
        if (endLine !== undefined) { options.endLine = endLine; }
        if (column !== undefined) { options.column = column; }
        if (endColumn !== undefined) { options.endColumn = endColumn; }
        if (title !== undefined && title !== '') { options.title = title; }
        const backendLevel = level === 'error'
            ? GitHubAnnotationLevel.Error
            : (level === 'warning' ? GitHubAnnotationLevel.Warning : GitHubAnnotationLevel.Notice);
        this._provider.annotate(backendLevel, message, options);
    }

    private shouldLog(level: LogLevel): boolean {
        if (level === LogLevel.CI) { return true; }
        const levelOrder = [LogLevel.DEBUG, LogLevel.UTP, LogLevel.INFO, LogLevel.WARN, LogLevel.ERROR];
        return levelOrder.indexOf(level) >= levelOrder.indexOf(this.logLevel);
    }

    /**
     * Masks a string in the console output in CI environments that support it.
     * @param message The string to mask.
     */
    public CI_mask(message: string): void {
        this._provider.mask(message);
    }

    /**
     * Sets an environment variable in CI environments that support it.
     * @param name The name of the environment variable.
     * @param value The value of the environment variable.
     */
    public CI_setEnvironmentVariable(name: string, value: string): void {
        this._provider.setEnvironmentVariable(name, value);
    }

    public CI_setOutput(name: string, value: string): void {
        this._provider.setOutput(name, value);
    }

    private static formatDurationMs(ms: number | undefined): string {
        if (ms === undefined || !Number.isFinite(ms)) { return '—'; }
        if (ms < 1000) { return `${Math.round(ms)}ms`; }
        return `${(ms / 1000).toFixed(1)}s`;
    }

    private static truncateStr(s: string, max: number): string {
        return s.length <= max ? s : s.slice(0, max) + '…';
    }

    private static truncateSummaryToByteLimit(summary: string, byteLimit: number): string {
        const footer = `\n***Summary truncated due to size limits.***\n`;
        const footerSize = Buffer.byteLength(footer, 'utf8');
        const lines = summary.split('\n');
        let rebuilt = '';
        for (const line of lines) {
            const nextSize = Buffer.byteLength(rebuilt + line + '\n', 'utf8') + footerSize;
            if (nextSize > byteLimit) { break; }
            rebuilt += `${line}\n`;
        }
        return rebuilt + footer;
    }

    /**
     * Returns the markdown byte limit for a given output target.
     * Workflow summary may be backend constrained; stdout is intentionally uncapped.
     */
    public getMarkdownByteLimit(target: MarkdownTarget): number {
        return this._provider.getMarkdownByteLimit(target);
    }

    public CI_appendWorkflowSummary(name: string, telemetry: UTP[], options?: { projectPath?: string; additionalLogEntries?: UTP[] }) {
        if (telemetry.length === 0) { return; }
        if (this.getMarkdownByteLimit('workflow-summary') === Number.POSITIVE_INFINITY) {
            return;
        }
        const excludedTypes = new Set(['MemoryLeaks', 'MemoryLeak']);
        const filtered = telemetry.filter(entry => !excludedTypes.has(entry.type || ''));
        if (filtered.length === 0) { return; }

        const completedActions = filtered.filter(
            e => e.type === 'Action' && e.phase === 'End'
        );
        const testResults = collectTestResults(filtered);
        const additional = options?.additionalLogEntries ?? [];
        const merged = mergeLogEntriesPreferringSeverity([
            ...buildMergedLogList(filtered),
            ...additional.filter(e => e.type === 'LogEntry' || e.type === 'Compiler'),
        ]);
        const pathFiltered = filterMergedByPath(merged, options);
        const bySeverity = groupBySeverity(pathFiltered);
        const limit = this.getMarkdownByteLimit('workflow-summary');

        const builders: (() => string)[] = [
            () => this.buildSummaryTimelineAndMergedLog(name, completedActions, bySeverity, testResults, limit),
            () => this.buildSummaryCollapsibleWithMergedLog(name, completedActions, bySeverity, testResults, limit),
            () => this.buildSummaryTimelineAndCounts(name, completedActions, pathFiltered.length, testResults, limit),
        ];
        let summary = '';
        for (const build of builders) {
            summary = build();
            if (Buffer.byteLength(summary, 'utf8') <= limit) { break; }
        }
        if (Buffer.byteLength(summary, 'utf8') > limit) {
            summary = Logger.truncateSummaryToByteLimit(summary, limit);
        }
        this._provider.appendStepSummary(summary);
    }

    /**
     * Builds summary: stats + list timeline + unit-test block + severity foldouts.
     */
    private buildSummaryTimelineAndMergedLog(
        name: string,
        completedActions: UTP[],
        bySeverity: { errorCritical: UTP[]; warning: UTP[]; info: UTP[] },
        testResults: TestResultSummary[],
        byteLimit: number
    ): string {
        let out = `## ${name} Summary\n\n`;

        const totalDurationMs = completedActions.reduce(
            (sum, a) => sum + (a.duration ?? (a.durationMicroseconds != null ? a.durationMicroseconds / 1000 : 0)),
            0
        );
        const totalSec = totalDurationMs / 1000;
        const totalStr = totalSec >= 60 ? `${Math.round(totalSec / 60)}m ${Math.round(totalSec % 60)}s` : `${totalSec.toFixed(1)}s`;
        out += `Errors: ${bySeverity.errorCritical.length}\n`;
        out += `Warnings: ${bySeverity.warning.length}\n`;
        out += `Total duration: ${totalStr}\n`;
        out += `Actions: ${completedActions.length}\n`;
        if (testResults.length > 0) {
            out += `Tests: ${testResults.length}\n`;
        }
        out += '\n';

        if (completedActions.length > 0) {
            out += '```text\n';
            let timelineShown = 0;
            for (const a of completedActions) {
                const durationMs = a.duration ?? (a.durationMicroseconds != null ? a.durationMicroseconds / 1000 : undefined);
                const errCount = Array.isArray(a.errors) ? a.errors.length : 0;
                const status = errCount > 0 ? '❌' : '✅';
                const desc = toSingleLineText(a.description || a.name || '—');
                const durationStr = Logger.formatDurationMs(durationMs);
                const row = `${status} ${durationStr} ${errCount} — ${desc}\n`;
                if (Buffer.byteLength(out + row, 'utf8') > byteLimit) break;
                out += row;
                timelineShown++;
            }
            if (timelineShown < completedActions.length) {
                out += `... and ${completedActions.length - timelineShown} more actions\n`;
            }
            out += '```\n\n';
        }

        if (testResults.length > 0) {
            const remaining = byteLimit - Buffer.byteLength(out, 'utf8');
            out += buildUnitTestJobSummaryMarkdown(testResults, remaining, '');
        }

        const limit = byteLimit;
        const appendFoldout = (title: string, entries: UTP[], dropSuffix: string, openByDefault?: boolean): void => {
            if (entries.length === 0) return;
            const openAttr = openByDefault ? ' open' : '';
            out += `<details${openAttr}><summary>${title} (${entries.length})</summary>\n\n`;
            out += '```text\n';
            let shown = 0;
            let omitted = 0;
            for (const e of entries) {
                const line = formatLogEntryLine(e);
                if (Buffer.byteLength(out + line, 'utf8') > limit) {
                    omitted = entries.length - shown;
                    break;
                }
                out += line;
                shown++;
            }
            if (omitted > 0) {
                out += `... and ${omitted} more ${dropSuffix}\n`;
            }
            out += '```\n\n';
            out += `</details>\n\n`;
        };

        appendFoldout('Error', bySeverity.errorCritical, '(see annotations).', true);
        appendFoldout('Warning', bySeverity.warning, '(truncated; see full log).');
        appendFoldout('Info', bySeverity.info, '(truncated; see full log).');

        return out;
    }

    /**
     * Builds summary with timeline in a <details> and merged log foldouts by severity.
     * Used when primary builder would exceed size limit.
     */
    private buildSummaryCollapsibleWithMergedLog(
        name: string,
        completedActions: UTP[],
        bySeverity: { errorCritical: UTP[]; warning: UTP[]; info: UTP[] },
        testResults: TestResultSummary[],
        byteLimit: number
    ): string {
        let out = `## ${name} Summary\n\n`;

        if (completedActions.length > 0) {
            out += `<details><summary>Build timeline (${completedActions.length} actions)</summary>\n\n`;
            out += '```text\n';
            let timelineShown = 0;
            for (const a of completedActions) {
                const errCount = Array.isArray(a.errors) ? a.errors.length : 0;
                const row = `${errCount > 0 ? '❌' : '✅'} ${Logger.formatDurationMs(a.duration ?? (a.durationMicroseconds != null ? a.durationMicroseconds / 1000 : undefined))} ${errCount} — ${toSingleLineText(a.description || a.name || '—')}\n`;
                if (Buffer.byteLength(out + row, 'utf8') > byteLimit) break;
                out += row;
                timelineShown++;
            }
            if (timelineShown < completedActions.length) {
                out += `... and ${completedActions.length - timelineShown} more actions\n`;
            }
            out += '```\n\n';
            out += `</details>\n\n`;
        }

        if (testResults.length > 0) {
            const remaining = byteLimit - Buffer.byteLength(out, 'utf8');
            out += buildUnitTestJobSummaryMarkdown(testResults, remaining, '');
        }

        const limit = byteLimit;
        const appendFoldout = (title: string, entries: UTP[], dropSuffix: string, openByDefault?: boolean): void => {
            if (entries.length === 0) return;
            const openAttr = openByDefault ? ' open' : '';
            out += `<details${openAttr}><summary>${title} (${entries.length})</summary>\n\n`;
            out += '```text\n';
            let shown = 0;
            let omitted = 0;
            for (const e of entries) {
                const line = formatLogEntryLine(e);
                if (Buffer.byteLength(out + line, 'utf8') > limit) {
                    omitted = entries.length - shown;
                    break;
                }
                out += line;
                shown++;
            }
            if (omitted > 0) out += `... and ${omitted} more ${dropSuffix}\n`;
            out += '```\n\n';
            out += `</details>\n\n`;
        };
        appendFoldout('Error', bySeverity.errorCritical, '(see annotations).', true);
        appendFoldout('Warning', bySeverity.warning, '(truncated; see full log).');
        appendFoldout('Info', bySeverity.info, '(truncated; see full log).');

        return out;
    }

    /**
     * Fallback: list timeline (when actions exist) + unit-test block (when present) + compact count lines.
     * Used when even collapsible summary would exceed 1 MB.
     */
    private buildSummaryTimelineAndCounts(
        name: string,
        completedActions: UTP[],
        logCount: number,
        testResults: TestResultSummary[],
        byteLimit: number
    ): string {
        let out = `## ${name} Summary\n\n`;
        if (completedActions.length > 0) {
            out += '```text\n';
            let timelineShown = 0;
            for (const a of completedActions) {
                const durationMs = a.duration ?? (a.durationMicroseconds != null ? a.durationMicroseconds / 1000 : undefined);
                const errCount = Array.isArray(a.errors) ? a.errors.length : 0;
                const status = errCount > 0 ? '❌' : '✅';
                const desc = toSingleLineText(a.description || a.name || '—');
                const row = `${status} ${Logger.formatDurationMs(durationMs)} ${errCount} — ${desc}\n`;
                if (Buffer.byteLength(out + row, 'utf8') > byteLimit) break;
                out += row;
                timelineShown++;
            }
            if (timelineShown < completedActions.length) {
                out += `... and ${completedActions.length - timelineShown} more actions\n`;
            }
            out += '```\n\n';
        }
        if (testResults.length > 0) {
            const remaining = byteLimit - Buffer.byteLength(out, 'utf8');
            out += buildUnitTestJobSummaryMarkdown(testResults, remaining, '');
        }
        out += `Log entries: ${logCount}\n`;
        out += `Actions: ${completedActions.length}\n`;
        if (testResults.length > 0) {
            out += `Tests: ${testResults.length}\n`;
        }
        out += `\nSee annotations for details.\n`;
        return out;
    }
}
