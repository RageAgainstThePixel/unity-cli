import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitHubActionsLoggerProvider, GitHubAnnotationLevel } from '../src/github-actions-ci';
import { LocalCliLoggerProvider } from '../src/logger-provider';

describe('logger providers', () => {
    afterEach(() => {
        jest.restoreAllMocks();
        delete process.env.GITHUB_ENV;
        delete process.env.GITHUB_OUTPUT;
        delete process.env.GITHUB_STEP_SUMMARY;
    });

    it('github provider enforces 1MB workflow summary limit and uncapped stdout', () => {
        const provider = new GitHubActionsLoggerProvider();
        expect(provider.getMarkdownByteLimit('workflow-summary')).toBe(1024 * 1024);
        expect(provider.getMarkdownByteLimit('stdout')).toBe(Number.POSITIVE_INFINITY);
    });

    it('local provider is safe no-op for CI side effects and uncapped markdown', () => {
        const provider = new LocalCliLoggerProvider();
        expect(provider.getMarkdownByteLimit('workflow-summary')).toBe(Number.POSITIVE_INFINITY);
        expect(provider.getMarkdownByteLimit('stdout')).toBe(Number.POSITIVE_INFINITY);
        expect(() => provider.mask('secret')).not.toThrow();
        expect(() => provider.setEnvironmentVariable('A', 'B')).not.toThrow();
        expect(() => provider.setOutput('A', 'B')).not.toThrow();
        expect(() => provider.appendStepSummary('hello')).not.toThrow();
    });

    it('github provider formats annotations with metadata and escaping', () => {
        const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true as any);
        const provider = new GitHubActionsLoggerProvider();
        provider.annotate(GitHubAnnotationLevel.Error, 'line1\nline2', {
            file: 'Assets/Test.cs',
            line: 10,
            title: 'Compiler',
        });
        expect(writeSpy).toHaveBeenCalled();
        const output = String(writeSpy.mock.calls[0][0]);
        expect(output).toContain('::error ');
        expect(output).toContain('file=Assets/Test.cs');
        expect(output).toContain('line=10');
        expect(output).toContain('title=Compiler');
        expect(output).toContain('line1%0Aline2');
    });

    it('github provider appends env/output/summary files when configured', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unity-cli-provider-'));
        const envFile = path.join(tempDir, 'env');
        const outputFile = path.join(tempDir, 'output');
        const summaryFile = path.join(tempDir, 'summary');
        process.env.GITHUB_ENV = envFile;
        process.env.GITHUB_OUTPUT = outputFile;
        process.env.GITHUB_STEP_SUMMARY = summaryFile;
        const provider = new GitHubActionsLoggerProvider();

        provider.setEnvironmentVariable('KEY', 'VALUE');
        provider.setOutput('OUT', '123');
        provider.appendStepSummary('summary');

        expect(fs.readFileSync(envFile, 'utf8')).toBe('KEY=VALUE\n');
        expect(fs.readFileSync(outputFile, 'utf8')).toBe('OUT=123\n');
        expect(fs.readFileSync(summaryFile, 'utf8')).toBe('summary');
    });
});
