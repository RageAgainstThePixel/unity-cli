export enum LogLevel {
    DEBUG = 'debug',
    INFO = 'info',
    WARN = 'warn',
    ERROR = 'error',
}

export class Logger {
    public logLevel: LogLevel = LogLevel.INFO;
    public ci: string | undefined;
    static instance: Logger = new Logger();

    private constructor() {
        if (process.env.GITHUB_ACTIONS) {
            this.ci = 'GITHUB_ACTIONS';
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
            switch (this.ci) {
                case 'GITHUB_ACTIONS': {
                    console.log(`::${level}::${message}`, ...optionalParams);
                    break;
                }
                default: {
                    const clear = '\x1b[0m';
                    const stringColor: string = {
                        [LogLevel.DEBUG]: '\x1b[35m', // Purple
                        [LogLevel.INFO]: clear,  // No color / White
                        [LogLevel.WARN]: '\x1b[33m',  // Yellow
                        [LogLevel.ERROR]: '\x1b[31m', // Red
                    }[level] || clear; // Default
                    console.log(`${stringColor}${message}${clear}`, ...optionalParams);
                }
            }
        }
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
        const levelOrder = [LogLevel.DEBUG, LogLevel.INFO, LogLevel.WARN, LogLevel.ERROR];
        return levelOrder.indexOf(level) >= levelOrder.indexOf(this.logLevel);
    }
}