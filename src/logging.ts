import * as fs from 'fs';
import { UTP, Severity } from './utp/utp';

const TRUNCATE_MSG = 120;
const SUMMARY_BYTE_LIMIT = 1024 * 1024;

/** Severity order for display: Error first, then Warning, then Info */
function severityRank(s: string | undefined): number {
    if (s === Severity.Error || s === Severity.Exception || s === Severity.Assert) return 0;
    if (s === Severity.Warning) return 1;
    return 2; // Info or unknown
}

function dedupeKey(e: UTP): string {
    const msg = (e.message || '').trim();
    const file = (e.file || (e as { fileName?: string }).fileName || '').replace(/\\/g, '/');
    const line = e.line ?? (e as { lineNumber?: number }).lineNumber ?? 0;
    return `${msg}\n${file}\n${line}`;
}

/**
 * Builds one merged list from LogEntry, Compiler, and error-severity entries.
 * Deduplicated by message+file+line, sorted by severity (Error, Warning, Info).
 */
function buildMergedLogList(filtered: UTP[]): UTP[] {
    const logEntries = filtered.filter(e => e.type === 'LogEntry');
    const compilerEntries = filtered.filter(e => e.type === 'Compiler');
    const isErrorSeverity = (s: string | undefined) =>
        s === Severity.Error || s === Severity.Exception || s === Severity.Assert;
    const errorSeverityEntries = filtered.filter(
        e => (e.type === 'LogEntry' || e.type === 'Compiler') && isErrorSeverity(e.severity)
    );

    const seen = new Set<string>();
    const merged: UTP[] = [];

    const add = (e: UTP) => {
        const key = dedupeKey(e);
        if (seen.has(key)) return;
        seen.add(key);
        merged.push(e);
    };

    for (const e of logEntries) add(e);
    for (const e of compilerEntries) add(e);
    for (const e of errorSeverityEntries) add(e);

    merged.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
    return merged;
}

/** Groups merged log by severity for foldouts (Error, Warning, Info). */
function groupBySeverity(merged: UTP[]): { errorCritical: UTP[]; warning: UTP[]; info: UTP[] } {
    const errorCritical: UTP[] = [];
    const warning: UTP[] = [];
    const info: UTP[] = [];
    for (const e of merged) {
        if (e.severity === Severity.Error || e.severity === Severity.Exception || e.severity === Severity.Assert) {
            errorCritical.push(e);
        } else if (e.severity === Severity.Warning) {
            warning.push(e);
        } else {
            info.push(e);
        }
    }
    return { errorCritical, warning, info };
}

function truncateStr(s: string, max: number): string {
    return s.length <= max ? s : s.slice(0, max) + '…';
}

function formatLogEntryLine(e: UTP, maxMsgLen: number = TRUNCATE_MSG): string {
    const msg = truncateStr((e.message || '').trim(), maxMsgLen);
    let line = `- ${msg}\n`;
    const file = (e.file || (e as { fileName?: string }).fileName || '').replace(/\\/g, '/');
    if (file && (e.line !== undefined && e.line > 0 || (e as { lineNumber?: number }).lineNumber)) {
        const ln = e.line ?? (e as { lineNumber?: number }).lineNumber ?? '';
        line += `  \`${file}${ln ? `(${ln})` : ''}\`\n`;
    }
    return line;
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
    private readonly _ci: string | undefined;
    static readonly instance: Logger = new Logger();

    private constructor() {
        if (process.env.GITHUB_ACTIONS === 'true') {
            this._ci = 'GITHUB_ACTIONS';
            this.logLevel = process.env.ACTIONS_STEP_DEBUG === 'true' ? LogLevel.DEBUG : LogLevel.CI;
        }
    }

    private printLine(message: any, lineColor: string | undefined, optionalParams: any[] = []): void {
        if (lineColor && lineColor.length > 0) {
            process.stdout.write(`${lineColor}${message}\x1b[0m\n`, ...optionalParams);
        } else {
            process.stdout.write(`${message}\n`, ...optionalParams);
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
            switch (this._ci) {
                case 'GITHUB_ACTIONS': {
                    switch (level) {
                        case LogLevel.DEBUG: {
                            message.toString().split('\n').forEach((line: string) => {
                                process.stdout.write(`::debug::${line}\n`, ...optionalParams);
                            });
                            break;
                        }
                        case LogLevel.CI:
                        case LogLevel.INFO: {
                            process.stdout.write(`${message}\n`, ...optionalParams);
                            break;
                        }
                        default: {
                            process.stdout.write(`::${level}::${message}\n`, ...optionalParams);
                            break;
                        }
                    }
                    break;
                }
                default: {
                    const stringColor: string | undefined = {
                        [LogLevel.DEBUG]: '\x1b[35m', // Purple
                        [LogLevel.INFO]: undefined,   // No color / White
                        [LogLevel.CI]: undefined,     // No color / White
                        [LogLevel.UTP]: undefined,    // No color / White
                        [LogLevel.WARN]: '\x1b[33m',  // Yellow
                        [LogLevel.ERROR]: '\x1b[31m', // Red
                    }[level] || undefined;            // Default to no color / White
                    this.printLine(message, stringColor, optionalParams);
                    break;
                }
            }
        }
    }

    /**
     * Starts a log group. In CI environments that support grouping, this will create a collapsible group.
     */
    public startGroup(message: any, optionalParams: any[] = [], logLevel: LogLevel = LogLevel.INFO): void {
        switch (this._ci) {
            case 'GITHUB_ACTIONS': {
                // if there is newline in message, only use the first line for group title
                // then print the rest of the lines inside the group in cyan color
                const firstLine: string = message.toString().split('\n')[0];
                const restLines: string[] = message.toString().split('\n').slice(1);
                process.stdout.write(`::group::${firstLine}\n`, ...optionalParams);
                restLines.forEach(line => {
                    this.printLine(line, '\x1b[36m', ...optionalParams);
                });
                break;
            }
            default: {
                // No grouping in standard console
                this.log(logLevel, message, optionalParams);
                break;
            }
        }
    }

    /**
     * Ends a log group. In CI environments that support grouping, this will end the current group.
     */
    public endGroup(): void {
        switch (this._ci) {
            case 'GITHUB_ACTIONS': {
                process.stdout.write(`::endgroup::\n`);
                break;
            }
            default: {
                break; // No grouping in standard console
            }
        }
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
        let annotation = '';

        switch (this._ci) {
            case 'GITHUB_ACTIONS': {
                const level = {
                    [LogLevel.CI]: 'notice',
                    [LogLevel.INFO]: 'notice',
                    [LogLevel.DEBUG]: 'notice',
                    [LogLevel.UTP]: 'notice',
                    [LogLevel.WARN]: 'warning',
                    [LogLevel.ERROR]: 'error',
                }[logLevel] ?? 'notice';

                const parts: string[] = [];
                const appendPart = (key: string, value?: string | number): void => {
                    if (value === undefined || value === null) { return; }
                    const stringValue = value.toString();
                    if (stringValue.length === 0) { return; }
                    parts.push(`${key}=${this.escapeGitHubCommandValue(stringValue)}`);
                };

                appendPart('file', file);
                if (line !== undefined && line > 0) {
                    appendPart('line', line);
                }
                if (endLine !== undefined && endLine > 0) {
                    appendPart('endLine', endLine);
                }
                if (column !== undefined && column > 0) {
                    appendPart('col', column);
                }
                if (endColumn !== undefined && endColumn > 0) {
                    appendPart('endColumn', endColumn);
                }
                appendPart('title', title);

                const metadata = parts.length > 0 ? ` ${parts.join(',')}` : '';
                annotation = `::${level}${metadata}::${this.escapeGitHubCommandValue(message)}`;
                break;
            }
        }

        if (annotation.length > 0) {
            process.stdout.write(`${annotation}\n`);
        } else {
            this.log(logLevel, message);
        }
    }

    private escapeGitHubCommandValue(value: string): string {
        return value
            .replace(/%/g, '%25')
            .replace(/\r/g, '%0D')
            .replace(/\n/g, '%0A');
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
        switch (this._ci) {
            case 'GITHUB_ACTIONS': {
                process.stdout.write(`::add-mask::${message}\n`);
                break;
            }
        }
    }

    /**
     * Sets an environment variable in CI environments that support it.
     * @param name The name of the environment variable.
     * @param value The value of the environment variable.
     */
    public CI_setEnvironmentVariable(name: string, value: string): void {
        switch (this._ci) {
            case 'GITHUB_ACTIONS': {
                // needs to be appended to the temporary file specified in the GITHUB_ENV environment variable
                const githubEnv = process.env.GITHUB_ENV;
                // echo "MY_ENV_VAR=myValue" >> $GITHUB_ENV
                if (githubEnv) {
                    fs.appendFileSync(githubEnv, `${name}=${value}\n`, { encoding: 'utf8' });
                }
                break;
            }
        }
    }

    public CI_setOutput(name: string, value: string): void {
        switch (this._ci) {
            case 'GITHUB_ACTIONS': {
                // needs to be appended to the temporary file specified in the GITHUB_OUTPUT environment variable
                const githubOutput = process.env.GITHUB_OUTPUT;
                // echo "myOutput=myValue" >> $GITHUB_OUTPUT
                if (githubOutput) {
                    fs.appendFileSync(githubOutput, `${name}=${value}\n`, { encoding: 'utf8' });
                }
                break;
            }
        }
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

    public CI_appendWorkflowSummary(name: string, telemetry: UTP[]) {
        if (telemetry.length === 0) { return; }
        switch (this._ci) {
            case 'GITHUB_ACTIONS': {
                const githubSummary = process.env.GITHUB_STEP_SUMMARY;
                if (githubSummary) {
                    const excludedTypes = new Set(['MemoryLeaks', 'MemoryLeak']);
                    const filtered = telemetry.filter(entry => !excludedTypes.has(entry.type || ''));
                    if (filtered.length === 0) { return; }

                    const completedActions = filtered.filter(
                        e => e.type === 'Action' && e.phase === 'End'
                    );
                    const merged = buildMergedLogList(filtered);
                    const bySeverity = groupBySeverity(merged);
                    const errorCount = bySeverity.errorCritical.length;
                    const limit = SUMMARY_BYTE_LIMIT;

                    const builders: (() => string)[] = [
                        () => this.buildSummaryTimelineAndMergedLog(name, completedActions, bySeverity, limit),
                        () => this.buildSummaryCollapsibleWithMergedLog(name, completedActions, bySeverity, limit),
                        () => this.buildSummaryTimelineAndCounts(name, completedActions, merged.length, limit),
                    ];
                    let summary = '';
                    for (const build of builders) {
                        summary = build();
                        if (Buffer.byteLength(summary, 'utf8') <= limit) { break; }
                    }
                    if (Buffer.byteLength(summary, 'utf8') > limit) {
                        summary = Logger.truncateSummaryToByteLimit(summary, limit);
                    }
                    fs.appendFileSync(githubSummary, summary, { encoding: 'utf8' });
                }
                break;
            }
        }
    }

    /**
     * Builds summary: optional stats, build timeline table (always first), then one <details> per
     * severity that has messages (Error, Warning, Info). Truncates log content only when
     * needed to stay under byteLimit.
     */
    private buildSummaryTimelineAndMergedLog(
        name: string,
        completedActions: UTP[],
        bySeverity: { errorCritical: UTP[]; warning: UTP[]; info: UTP[] },
        byteLimit: number
    ): string {
        let out = `## ${name} Summary\n\n`;

        const totalDurationMs = completedActions.reduce(
            (sum, a) => sum + (a.duration ?? (a.durationMicroseconds != null ? a.durationMicroseconds / 1000 : 0)),
            0
        );
        const totalSec = totalDurationMs / 1000;
        const totalStr = totalSec >= 60 ? `${Math.round(totalSec / 60)}m ${Math.round(totalSec % 60)}s` : `${totalSec.toFixed(1)}s`;
        out += `${bySeverity.errorCritical.length} errors, ${completedActions.length} actions, total ${totalStr}\n\n`;

        out += `| Status | Duration | Errors | Step |\n`;
        out += `|--------|----------|--------|------|\n`;
        let timelineShown = 0;
        for (const a of completedActions) {
            const durationMs = a.duration ?? (a.durationMicroseconds != null ? a.durationMicroseconds / 1000 : undefined);
            const errCount = Array.isArray(a.errors) ? a.errors.length : 0;
            const status = errCount > 0 ? '❌' : '✅';
            const desc = (a.description || a.name || '—').trim();
            const durationStr = Logger.formatDurationMs(durationMs);
            const row = `| ${status} | ${durationStr} | ${errCount} | ${desc} |\n`;
            if (Buffer.byteLength(out + row, 'utf8') > byteLimit) break;
            out += row;
            timelineShown++;
        }
        if (timelineShown < completedActions.length) {
            out += `| … | … | … | … and ${completedActions.length - timelineShown} more |\n`;
        }
        out += `\n`;

        const limit = byteLimit;
        const appendFoldout = (title: string, entries: UTP[], dropSuffix: string): void => {
            if (entries.length === 0) return;
            out += `<details><summary>${title} (${entries.length})</summary>\n\n`;
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
                out += `- ... and ${omitted} more ${dropSuffix}\n`;
            }
            out += `\n</details>\n\n`;
        };

        appendFoldout('Error', bySeverity.errorCritical, '(see annotations).');
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
        byteLimit: number
    ): string {
        let out = `## ${name} Summary\n\n`;

        if (completedActions.length > 0) {
            out += `<details><summary>Build timeline (${completedActions.length} actions)</summary>\n\n`;
            out += `| Status | Duration | Errors | Step |\n`;
            out += `|--------|----------|--------|------|\n`;
            let timelineShown = 0;
            for (const a of completedActions) {
                const errCount = Array.isArray(a.errors) ? a.errors.length : 0;
                const row = `| ${errCount > 0 ? '❌' : '✅'} | ${Logger.formatDurationMs(a.duration ?? (a.durationMicroseconds != null ? a.durationMicroseconds / 1000 : undefined))} | ${errCount} | ${(a.description || a.name || '—').trim()} |\n`;
                if (Buffer.byteLength(out + row, 'utf8') > byteLimit) break;
                out += row;
                timelineShown++;
            }
            if (timelineShown < completedActions.length) {
                out += `| … | … | … | … and ${completedActions.length - timelineShown} more |\n`;
            }
            out += `\n</details>\n\n`;
        }

        const limit = byteLimit;
        const appendFoldout = (title: string, entries: UTP[], dropSuffix: string): void => {
            if (entries.length === 0) return;
            out += `<details><summary>${title} (${entries.length})</summary>\n\n`;
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
            if (omitted > 0) out += `- ... and ${omitted} more ${dropSuffix}\n`;
            out += `\n</details>\n\n`;
        };
        appendFoldout('Error', bySeverity.errorCritical, '(see annotations).');
        appendFoldout('Warning', bySeverity.warning, '(truncated; see full log).');
        appendFoldout('Info', bySeverity.info, '(truncated; see full log).');

        return out;
    }

    /**
     * Fallback: build timeline table + counts table only (no log foldouts).
     * Used when even collapsible summary would exceed 1 MB.
     */
    private buildSummaryTimelineAndCounts(
        name: string,
        completedActions: UTP[],
        logCount: number,
        byteLimit: number
    ): string {
        let out = `## ${name} Summary\n\n`;
        out += `| Status | Duration | Errors | Step |\n`;
        out += `|--------|----------|--------|------|\n`;
        let timelineShown = 0;
        for (const a of completedActions) {
            const durationMs = a.duration ?? (a.durationMicroseconds != null ? a.durationMicroseconds / 1000 : undefined);
            const errCount = Array.isArray(a.errors) ? a.errors.length : 0;
            const status = errCount > 0 ? '❌' : '✅';
            const desc = (a.description || a.name || '—').trim();
            const row = `| ${status} | ${Logger.formatDurationMs(durationMs)} | ${errCount} | ${desc} |\n`;
            if (Buffer.byteLength(out + row, 'utf8') > byteLimit) break;
            out += row;
            timelineShown++;
        }
        if (timelineShown < completedActions.length) {
            out += `| … | … | … | … and ${completedActions.length - timelineShown} more |\n`;
        }
        out += `\n`;
        out += `| Type | Count |\n`;
        out += `|------|-------|\n`;
        out += `| Log | ${logCount} |\n`;
        out += `| Actions | ${completedActions.length} |\n\n`;
        out += `See annotations for details.\n`;
        return out;
    }
}