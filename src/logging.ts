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

    public CI_appendWorkflowSummary(name: string, telemetry: UTP[]) {
        if (telemetry.length === 0) { return; }
        switch (this._ci) {
            case 'GITHUB_ACTIONS': {
                const githubSummary = process.env.GITHUB_STEP_SUMMARY;

                if (githubSummary) {
                    // Only show LogEntry, Compiler, and Action types in the summary table
                    const showTypes = new Set(['LogEntry', 'Compiler', 'Action']);
                    let foldout = `## ${name} Summary\n\n<details>\n<summary>Show Action, Compiler, and LogEntry details</summary>\n\n`;
                    foldout += `- List of entries as JSON:\n`;

                    for (const entry of telemetry) {
                        const type = entry.type || 'unknown';
                        if (!showTypes.has(type)) {
                            continue;
                        }
                        foldout += `  - \`${JSON.stringify(entry)}\`\n`;
                    }

                    foldout += `\n</details>\n`;

                    // Truncate foldout if over 1MB
                    const byteLimit = 1024 * 1024;
                    if (Buffer.byteLength(foldout, 'utf8') > byteLimit) {
                        const footer = `\n- ...\n\n***Summary truncated due to size limits.***\n</details>\n`;
                        const footerSize = Buffer.byteLength(footer, 'utf8');
                        const lines = foldout.split('\n');
                        let rebuilt = '';
                        for (const line of lines) {
                            const nextSize = Buffer.byteLength(rebuilt + line + '\n', 'utf8') + footerSize;
                            if (nextSize > byteLimit) {
                                break;
                            }
                            rebuilt += `${line}\n`;
                        }
                        foldout = rebuilt + footer;
                    }
                    fs.appendFileSync(githubSummary, foldout, { encoding: 'utf8' });
                }
                break;
            }
        }
    }
}