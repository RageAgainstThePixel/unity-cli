import * as fs from 'fs';

export enum LogLevel {
    DEBUG = 'debug',
    CI = 'ci',
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
                var level: string;
                switch (logLevel) {
                    case LogLevel.CI:
                    case LogLevel.INFO:
                    case LogLevel.DEBUG: {
                        level = 'notice';
                        break;
                    }
                    case LogLevel.WARN: {
                        level = 'warning';
                        break;
                    }
                    case LogLevel.ERROR: {
                        level = 'error';
                        break;
                    }
                }

                let parts: string[] = [];

                if (file !== undefined && file.length > 0) {
                    parts.push(`file=${file}`);
                }

                if (line !== undefined && line > 0) {
                    parts.push(`line=${line}`);
                }

                if (endLine !== undefined && endLine > 0) {
                    parts.push(`endLine=${endLine}`);
                }

                if (column !== undefined && column > 0) {
                    parts.push(`col=${column}`);
                }

                if (endColumn !== undefined && endColumn > 0) {
                    parts.push(`endColumn=${endColumn}`);
                }

                if (title !== undefined && title.length > 0) {
                    parts.push(`title=${title}`);
                }

                annotation = `::${level} ${parts.join(',')}::${message}`;
                break;
            }
        }

        process.stdout.write(`${annotation}\n`);
    }

    private shouldLog(level: LogLevel): boolean {
        if (level === LogLevel.CI) { return true; }
        const levelOrder = [LogLevel.DEBUG, LogLevel.INFO, LogLevel.WARN, LogLevel.ERROR];
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
}