export type MarkdownTarget = 'workflow-summary' | 'stdout';
export type LoggerProviderLevel = 'debug' | 'ci' | 'utp' | 'info' | 'warning' | 'error';
export type LoggerProviderAnnotationLevel = 'notice' | 'warning' | 'error';

export interface LoggerAnnotationOptions {
    file?: string;
    line?: number;
    endLine?: number;
    column?: number;
    endColumn?: number;
    title?: string;
}

export interface ILoggerProvider {
    readonly isCi: boolean;
    log(level: LoggerProviderLevel, message: any, optionalParams?: any[]): void;
    startGroup(message: any, optionalParams?: any[]): void;
    endGroup(): void;
    annotate(level: LoggerProviderAnnotationLevel, message: string, options?: LoggerAnnotationOptions): void;
    mask(message: string): void;
    setEnvironmentVariable(name: string, value: string): void;
    setOutput(name: string, value: string): void;
    appendStepSummary(summary: string): void;
    getMarkdownByteLimit(target: MarkdownTarget): number;
}

export class LocalCliLoggerProvider implements ILoggerProvider {
    public readonly isCi = false;

    public log(level: LoggerProviderLevel, message: any, optionalParams: any[] = []): void {
        const stringColor: string | undefined = {
            debug: '\x1b[35m',
            ci: undefined,
            utp: undefined,
            info: undefined,
            warning: '\x1b[33m',
            error: '\x1b[31m',
        }[level];
        if (stringColor && stringColor.length > 0) {
            process.stdout.write(`${stringColor}${message}\x1b[0m\n`, ...optionalParams);
            return;
        }
        process.stdout.write(`${message}\n`, ...optionalParams);
    }

    public startGroup(message: any, optionalParams: any[] = []): void {
        this.log('info', message, optionalParams);
    }

    public endGroup(): void {
        // no-op for local terminal
    }

    public annotate(level: LoggerProviderAnnotationLevel, message: string): void {
        const mapped: LoggerProviderLevel = level === 'error' ? 'error' : (level === 'warning' ? 'warning' : 'info');
        this.log(mapped, message);
    }

    public mask(_message: string): void {
        // no-op for local terminal
    }

    public setEnvironmentVariable(_name: string, _value: string): void {
        // no-op for local terminal
    }

    public setOutput(_name: string, _value: string): void {
        // no-op for local terminal
    }

    public appendStepSummary(_summary: string): void {
        // no-op for local terminal
    }

    public getMarkdownByteLimit(_target: MarkdownTarget): number {
        return Number.POSITIVE_INFINITY;
    }
}
