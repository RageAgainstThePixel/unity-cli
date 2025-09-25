import * as os from 'os';

export enum LogLevel {
    DEBUG = 'debug',
    CI = 'ci',
    INFO = 'info',
    WARN = 'warn',
    ERROR = 'error',
}

export class Logger {
    public logLevel: LogLevel = LogLevel.INFO;
    private _ci: string | undefined;
    static instance: Logger = new Logger();

    private constructor() {
        if (process.env.GITHUB_ACTIONS) {
            this._ci = 'GITHUB_ACTIONS';
            this.logLevel = LogLevel.CI;
        }

        Logger.instance = this;
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
                            message.toString().split(os.EOL).forEach((line: string) => {
                                process.stdout.write(`::debug::${line}${os.EOL}`, ...optionalParams);
                            });
                        }
                        case LogLevel.CI:
                        case LogLevel.INFO: {
                            process.stdout.write(`${message}${os.EOL}`, ...optionalParams);
                            break;
                        }
                        default: {
                            process.stdout.write(`::${level}::${message}${os.EOL}`, ...optionalParams);
                            break;
                        }
                    }
                    break;
                }
                default: {
                    const clear = '\x1b[0m';
                    const stringColor: string = {
                        [LogLevel.DEBUG]: '\x1b[35m', // Purple
                        [LogLevel.INFO]: clear,       // No color / White
                        [LogLevel.CI]: clear,         // No color / White
                        [LogLevel.WARN]: '\x1b[33m',  // Yellow
                        [LogLevel.ERROR]: '\x1b[31m', // Red
                    }[level] || clear;                // Default to no color / White
                    process.stdout.write(`${stringColor}${message}${clear}${os.EOL}`, ...optionalParams);
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
                const firstLine: string = message.toString().split(os.EOL)[0];
                const restLines: string[] = message.toString().split(os.EOL).slice(1);
                const cyan = '\x1b[36m';
                const clear = '\x1b[0m';
                process.stdout.write(`::group::${firstLine}${os.EOL}`, ...optionalParams);
                restLines.forEach(line => {
                    process.stdout.write(`${cyan}${line}${clear}${os.EOL}`, ...optionalParams);
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
                process.stdout.write(`::endgroup::${os.EOL}`);
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

    private shouldLog(level: LogLevel): boolean {
        if (level === LogLevel.CI) { return true; }
        const levelOrder = [LogLevel.DEBUG, LogLevel.INFO, LogLevel.WARN, LogLevel.ERROR];
        return levelOrder.indexOf(level) >= levelOrder.indexOf(this.logLevel);
    }
}