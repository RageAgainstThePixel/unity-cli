import { describe, it, afterEach, mock } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitHubActionsLoggerProvider, GitHubAnnotationLevel } from '../dist/github-actions-ci.js';
import { LocalCliLoggerProvider } from '../dist/logger-provider.js';

describe('logger providers', () => {
    afterEach(() => {
        mock.restoreAll();
        delete process.env.GITHUB_ENV;
        delete process.env.GITHUB_OUTPUT;
        delete process.env.GITHUB_STEP_SUMMARY;
        delete process.env.UNITY_CLI_WORKFLOW_SUMMARY;
    });

    it('github provider disables workflow summary limit unless UNITY_CLI_WORKFLOW_SUMMARY is set', () => {
        const provider = new GitHubActionsLoggerProvider();
        assert.equal(provider.getMarkdownByteLimit('workflow-summary'), Number.POSITIVE_INFINITY);
        assert.equal(provider.getMarkdownByteLimit('stdout'), Number.POSITIVE_INFINITY);
    });

    it('github provider enforces 1MB workflow summary limit when UNITY_CLI_WORKFLOW_SUMMARY is truthy', () => {
        process.env.UNITY_CLI_WORKFLOW_SUMMARY = 'true';
        const provider = new GitHubActionsLoggerProvider();
        assert.equal(provider.getMarkdownByteLimit('workflow-summary'), 1024 * 1024);
        assert.equal(provider.getMarkdownByteLimit('stdout'), Number.POSITIVE_INFINITY);
    });

    it('local provider is safe no-op for CI side effects and uncapped markdown', () => {
        const provider = new LocalCliLoggerProvider();
        assert.equal(provider.getMarkdownByteLimit('workflow-summary'), Number.POSITIVE_INFINITY);
        assert.equal(provider.getMarkdownByteLimit('stdout'), Number.POSITIVE_INFINITY);
        assert.doesNotThrow(() => provider.mask('secret'));
        assert.doesNotThrow(() => provider.setEnvironmentVariable('A', 'B'));
        assert.doesNotThrow(() => provider.setOutput('A', 'B'));
        assert.doesNotThrow(() => provider.appendStepSummary('hello'));
    });

    it('github provider formats annotations with metadata and escaping', () => {
        const writeSpy = mock.method(process.stdout, 'write', () => true as any);
        const provider = new GitHubActionsLoggerProvider();
        provider.annotate(GitHubAnnotationLevel.Error, 'line1\nline2', {
            file: 'Assets/Test.cs',
            line: 10,
            title: 'Compiler',
        });
        assert.ok(writeSpy.mock.callCount() > 0);
        const output = String(writeSpy.mock.calls[0]!.arguments[0]);
        assert.ok(output.includes('::error '));
        assert.ok(output.includes('file=Assets/Test.cs'));
        assert.ok(output.includes('line=10'));
        assert.ok(output.includes('title=Compiler'));
        assert.ok(output.includes('line1%0Aline2'));
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

        assert.equal(fs.readFileSync(envFile, 'utf8'), 'KEY=VALUE\n');
        assert.equal(fs.readFileSync(outputFile, 'utf8'), 'OUT=123\n');
        assert.equal(fs.readFileSync(summaryFile, 'utf8'), 'summary');
    });
});
