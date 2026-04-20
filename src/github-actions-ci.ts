import * as fs from 'fs';
import {
    ILoggerProvider,
    LoggerAnnotationOptions,
    LoggerProviderLevel,
    MarkdownTarget
} from './logger-provider';

export enum GitHubAnnotationLevel {
    Notice = 'notice',
    Warning = 'warning',
    Error = 'error',
}

export class GitHubActionsLoggerProvider implements ILoggerProvider {
    public readonly isCi = process.env.GITHUB_ACTIONS === 'true';

    public log(level: LoggerProviderLevel, message: any, optionalParams: any[] = []): void {
        switch (level) {
            case 'debug': {
                message.toString().split('\n').forEach((line: string) => {
                    process.stdout.write(`::debug::${line}\n`, ...optionalParams);
                });
                break;
            }
            case 'ci':
            case 'info':
                process.stdout.write(`${message}\n`, ...optionalParams);
                break;
            default:
                process.stdout.write(`::${level}::${message}\n`, ...optionalParams);
                break;
        }
    }

    public startGroup(message: any, optionalParams: any[] = []): void {
        const firstLine: string = message.toString().split('\n')[0];
        process.stdout.write(`::group::${firstLine}\n`, ...optionalParams);
    }

    public endGroup(): void {
        process.stdout.write('::endgroup::\n');
    }

    public annotate(level: GitHubAnnotationLevel, message: string, options?: LoggerAnnotationOptions): void {
        const parts: string[] = [];
        const appendPart = (key: string, value?: string | number): void => {
            if (value === undefined || value === null) { return; }
            const stringValue = value.toString();
            if (stringValue.length === 0) { return; }
            parts.push(`${key}=${this.escapeGitHubCommandValue(stringValue)}`);
        };

        appendPart('file', options?.file);
        if (options?.line !== undefined && options.line > 0) appendPart('line', options.line);
        if (options?.endLine !== undefined && options.endLine > 0) appendPart('endLine', options.endLine);
        if (options?.column !== undefined && options.column > 0) appendPart('col', options.column);
        if (options?.endColumn !== undefined && options.endColumn > 0) appendPart('endColumn', options.endColumn);
        appendPart('title', options?.title);

        const metadata = parts.length > 0 ? ` ${parts.join(',')}` : '';
        process.stdout.write(`::${level}${metadata}::${this.escapeGitHubCommandValue(message)}\n`);
    }

    public mask(message: string): void {
        process.stdout.write(`::add-mask::${message}\n`);
    }

    public setEnvironmentVariable(name: string, value: string): void {
        const githubEnv = process.env.GITHUB_ENV;
        if (githubEnv) {
            fs.appendFileSync(githubEnv, `${name}=${value}\n`, { encoding: 'utf8' });
        }
    }

    public setOutput(name: string, value: string): void {
        const githubOutput = process.env.GITHUB_OUTPUT;
        if (githubOutput) {
            fs.appendFileSync(githubOutput, `${name}=${value}\n`, { encoding: 'utf8' });
        }
    }

    public appendStepSummary(summary: string): void {
        const githubSummary = process.env.GITHUB_STEP_SUMMARY;
        if (!githubSummary) { return; }
        fs.appendFileSync(githubSummary, summary, { encoding: 'utf8' });
    }

    public getMarkdownByteLimit(target: MarkdownTarget): number {
        if (target === 'workflow-summary') {
            return 1024 * 1024;
        }
        return Number.POSITIVE_INFINITY;
    }

    private escapeGitHubCommandValue(value: string): string {
        return value
            .replace(/%/g, '%25')
            .replace(/\r/g, '%0D')
            .replace(/\n/g, '%0A');
    }
}
