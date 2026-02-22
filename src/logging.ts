import * as fs from 'fs';
import { UTP } from './utp/utp';

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

    private static readonly SUMMARY_BYTE_LIMIT = 1024 * 1024;

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

                    const severityError = (s: string | undefined): boolean =>
                        s === 'Error' || s === 'Exception' || s === 'Assert';
                    const errorEntries = filtered.filter(
                        e => (e.type === 'LogEntry' || e.type === 'Compiler') && severityError(e.severity)
                    );
                    const completedActions = filtered.filter(
                        e => e.type === 'Action' && e.phase === 'End'
                    );
                    const logEntries = filtered.filter(e => e.type === 'LogEntry');
                    const compilerEntries = filtered.filter(e => e.type === 'Compiler');

                    const limit = Logger.SUMMARY_BYTE_LIMIT;
                    const builders: (() => string)[] = [
                        () => this.buildSummaryCollapsible(name, errorEntries, completedActions, logEntries, compilerEntries),
                        () => this.buildSummaryCountsOnly(name, errorEntries, logEntries.length, compilerEntries.length, completedActions.length),
                        () => this.buildSummaryErrorsAndTimeline(name, errorEntries, completedActions),
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
     * Builds summary with collapsible sections per type
     * (Errors, Build timeline, LogEntry, Compiler), one line per entry.
     */
    private buildSummaryCollapsible(
        name: string,
        errorEntries: UTP[],
        completedActions: UTP[],
        logEntries: UTP[],
        compilerEntries: UTP[]
    ): string {
        const MAX_ERROR = 20;
        const MAX_ACTION = 50;
        const MAX_LOG = 50;
        const MAX_COMPILER = 50;
        const TRUNCATE_MSG = 120;

        let out = `## ${name} Summary\n\n`;

        if (errorEntries.length > 0) {
            out += `<details><summary>Errors (${errorEntries.length})</summary>\n\n`;
            const shown = errorEntries.slice(0, MAX_ERROR);
            for (const e of shown) {
                out += `- ${Logger.truncateStr((e.message || '').trim(), TRUNCATE_MSG)}\n`;
                if (e.file && e.line !== undefined && e.line > 0) {
                    const file = (e.file || '').replace(/\\/g, '/');
                    out += `  \`${file}:${e.line}\`\n`;
                }
            }
            if (errorEntries.length > MAX_ERROR) {
                out += `- ... and ${errorEntries.length - MAX_ERROR} more (see annotations).\n`;
            }
            out += `\n</details>\n\n`;
        }

        if (completedActions.length > 0) {
            out += `<details><summary>Build timeline (${completedActions.length} actions)</summary>\n\n`;
            const shown = completedActions.slice(0, MAX_ACTION);
            for (const a of shown) {
                const durationMs = a.duration ?? (a.durationMicroseconds != null ? a.durationMicroseconds / 1000 : undefined);
                const errCount = Array.isArray(a.errors) ? a.errors.length : 0;
                const status = errCount > 0 ? '❌' : '✅';
                const desc = Logger.truncateStr((a.description || a.name || '—').trim(), 60);
                out += `${status} ${desc} ${Logger.formatDurationMs(durationMs)} (${errCount} errors)\n`;
            }
            out += `\n</details>\n\n`;
        }

        if (logEntries.length > 0) {
            out += `<details><summary>LogEntry (${logEntries.length})</summary>\n\n`;
            const shown = logEntries.slice(0, MAX_LOG);
            for (const e of shown) {
                out += `- ${e.severity ?? 'Info'}: ${Logger.truncateStr((e.message || '').trim(), TRUNCATE_MSG)}\n`;
            }
            if (logEntries.length > MAX_LOG) {
                out += `- ... and ${logEntries.length - MAX_LOG} more.\n`;
            }
            out += `\n</details>\n\n`;
        }

        if (compilerEntries.length > 0) {
            out += `<details><summary>Compiler (${compilerEntries.length})</summary>\n\n`;
            const shown = compilerEntries.slice(0, MAX_COMPILER);
            for (const e of shown) {
                out += `- ${e.severity ?? 'Info'}: ${Logger.truncateStr((e.message || '').trim(), TRUNCATE_MSG)}\n`;
            }
            if (compilerEntries.length > MAX_COMPILER) {
                out += `- ... and ${compilerEntries.length - MAX_COMPILER} more.\n`;
            }
            out += `\n</details>\n\n`;
        }

        return out;
    }

    /**
     * Builds summary with type counts in a markdown table.
     * When there are errors, adds a line pointing to annotations.
     */
    private buildSummaryCountsOnly(
        name: string,
        errorEntries: UTP[],
        logEntryCount: number,
        compilerCount: number,
        actionCount: number
    ): string {
        const errorCount = errorEntries.length;

        let out = `## ${name} Summary\n\n`;
        out += `| Type | Count |\n`;
        out += `|------|-------|\n`;
        out += `| Errors | ${errorCount} |\n`;
        out += `| LogEntry | ${logEntryCount} |\n`;
        out += `| Compiler | ${compilerCount} |\n`;
        out += `| Actions | ${actionCount} |\n\n`;
        if (errorCount > 0) {
            out += `See annotations for details.\n`;
        }
        return out;
    }

    /**
     * Builds minimal summary: errors list with optional file:line,
     * then one line per completed action (no LogEntry/Compiler).
     */
    private buildSummaryErrorsAndTimeline(
        name: string,
        errorEntries: UTP[],
        completedActions: UTP[]
    ): string {
        const MAX_ERROR = 20;
        const TRUNCATE_MSG = 120;

        let out = `## ${name} Summary\n\n`;

        if (errorEntries.length > 0) {
            const shown = errorEntries.slice(0, MAX_ERROR);
            for (const e of shown) {
                out += `- ${Logger.truncateStr((e.message || '').trim(), TRUNCATE_MSG)}\n`;
                if (e.file && e.line !== undefined && e.line > 0) {
                    const file = (e.file || '').replace(/\\/g, '/');
                    out += `  \`${file}:${e.line}\`\n`;
                }
            }
            if (errorEntries.length > MAX_ERROR) {
                out += `- ... and ${errorEntries.length - MAX_ERROR} more (see annotations).\n`;
            }
            out += `\n`;
        }

        for (const a of completedActions) {
            const durationMs = a.duration ?? (a.durationMicroseconds != null ? a.durationMicroseconds / 1000 : undefined);
            const errCount = Array.isArray(a.errors) ? a.errors.length : 0;
            const status = errCount > 0 ? '❌' : '✅';
            const desc = Logger.truncateStr((a.description || a.name || '—').trim(), 60);
            out += `${status} ${desc} ${Logger.formatDurationMs(durationMs)} (${errCount} errors)\n`;
        }

        return out;
    }
}