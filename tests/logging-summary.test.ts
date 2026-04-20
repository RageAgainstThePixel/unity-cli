import { Severity } from '../src/utp';
import { mergeLogEntriesPreferringSeverity, buildTestResultsTableMarkdown, buildUnitTestJobSummaryMarkdown, utpToTestResultSummary } from '../src/logging';

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
        expect(merged).toHaveLength(1);
        expect(merged[0].severity).toBe(Severity.Error);
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
        expect(merged).toHaveLength(1);
        expect(merged[0]).toBe(a);
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
        expect(md).toContain('A\\|B');
        expect(md.split('\n').filter(l => l.startsWith('|')).length).toBeGreaterThanOrEqual(3);
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
        expect(md).toMatch(/a\\\\b\\|c/);
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
        expect(md).toContain('### Unit test results');
        expect(md).toContain('**2** tests');
        expect(md).toContain('Fail.Test (Assets/Tests/Fail.cs:42)');
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
        expect(summary.file).toBe('Assets/A.cs');
        expect(summary.line).toBe(12);
    });
});
