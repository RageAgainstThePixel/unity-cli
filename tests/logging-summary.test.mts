import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { Severity } from '../dist/utp.js';
import {
    mergeLogEntriesPreferringSeverity,
    buildTestResultsTableMarkdown,
    buildUnitTestJobSummaryMarkdown,
    stripSummaryNoiseFromLogMessage,
    truncateStringToUtf8ByteLength,
    utpToTestResultSummary,
} from '../dist/logging.js';

describe('truncateStringToUtf8ByteLength', () => {
    it('returns the string unchanged when it fits', () => {
        assert.equal(truncateStringToUtf8ByteLength('hello', 100), 'hello');
    });

    it('truncates with ellipsis when UTF-8 length exceeds the budget', () => {
        const long = 'a'.repeat(200);
        const out = truncateStringToUtf8ByteLength(long, 20);
        assert.equal(out.endsWith('…'), true);
        assert.ok(Buffer.byteLength(out, 'utf8') <= 20);
    });
});

describe('stripSummaryNoiseFromLogMessage', () => {
    it('removes access token noise and trims', () => {
        assert.equal(stripSummaryNoiseFromLogMessage('Scripts have compiler errors.\nAccess token is unavailable; failed to update'),
            'Scripts have compiler errors.'
        );
        assert.equal(stripSummaryNoiseFromLogMessage('Access token is unavailable; failed to update'), '');
    });

    it('removes player-connection multicast noise', () => {
        assert.equal(stripSummaryNoiseFromLogMessage('Unable to join player connection multicast group (err: 10013).'), '');
        assert.equal(stripSummaryNoiseFromLogMessage('Before. Unable to join player connection multicast group (err: 10013). After.'), 'Before. After.');
    });

    it('removes OpenCL / access-token noise phrases from the shared remap list', () => {
        assert.equal(stripSummaryNoiseFromLogMessage('Access token is unavailable; failed to update'), '');
        assert.equal(stripSummaryNoiseFromLogMessage('Failed to find a suitable OpenCL device, baking cannot use GPU lightmapper.'), '');
    });
});

describe('mergeLogEntriesPreferringSeverity', () => {
    it('keeps Error over Info when dedupe key matches', () => {
        const info = {
            type: 'LogEntry',
            message: 'dup',
            file: 'Assets/Foo.cs',
            line: 3,
            severity: Severity.Info,
        };
        const err = {
            type: 'LogEntry',
            message: 'dup',
            file: 'Assets/Foo.cs',
            line: 3,
            severity: Severity.Error,
        };
        const merged = mergeLogEntriesPreferringSeverity([info, err]);
        assert.equal(merged.length, 1);
        assert.equal(merged[0].severity, Severity.Error);
    });

    it('keeps first entry when severities tie', () => {
        const a = {
            type: 'Compiler',
            message: 'm',
            file: 'Assets/Foo.cs',
            line: 1,
            severity: Severity.Warning,
        };
        const b = {
            type: 'Compiler',
            message: 'm',
            file: 'Assets/Foo.cs',
            line: 1,
            severity: Severity.Warning,
        };
        const merged = mergeLogEntriesPreferringSeverity([a, b]);
        assert.equal(merged.length, 1);
        assert.equal(merged[0], a);
    });
});

describe('buildTestResultsTableMarkdown', () => {
    it('escapes pipe characters in cells', () => {
        const rows = [
            utpToTestResultSummary({
                type: 'TestStatus',
                name: 'A|B',
                state: 1,
                duration: 10,
            } as any),
        ];
        const md = buildTestResultsTableMarkdown(rows, 1024 * 1024, '');
        assert.ok(md.includes('A\\|B'));
        assert.ok((md.split('\n').filter(l => l.startsWith('|')).length) >= 3);
    });

    it('escapes backslashes before pipes so markdown cells stay well-formed', () => {
        const rows = [
            utpToTestResultSummary({
                type: 'TestStatus',
                name: 'a\\b|c',
                state: 1,
                duration: 10,
            } as any),
        ];
        const md = buildTestResultsTableMarkdown(rows, 1024 * 1024, '');
        assert.match(md, /a\\\\b\\|c/);
    });
});

describe('buildUnitTestJobSummaryMarkdown', () => {
    it('renders aggregate counts and failure-first rows', () => {
        const rows = [
            utpToTestResultSummary({
                type: 'TestStatus',
                name: 'Pass.Test',
                state: 1,
                duration: 10,
            } as any),
            utpToTestResultSummary({
                type: 'TestStatus',
                name: 'Fail.Test',
                state: 2,
                duration: 20,
                message: 'assert fail',
                file: 'Assets/Tests/Fail.cs',
                line: 42,
            } as any),
        ];
        const md = buildUnitTestJobSummaryMarkdown(rows, 1024 * 1024, '');
        assert.ok(md.includes('### Unit test results'));
        assert.ok(md.includes('**2** tests'));
        assert.ok(md.includes('Fail.Test (Assets/Tests/Fail.cs:42)'));
    });
});

describe('utpToTestResultSummary', () => {
    it('preserves file and line when available', () => {
        const summary = utpToTestResultSummary({
            type: 'TestStatus',
            name: 'A.Test',
            state: 2,
            file: 'Assets/A.cs',
            line: 12,
        } as any);
        assert.equal(summary.file, 'Assets/A.cs');
        assert.equal(summary.line, 12);
    });
});
