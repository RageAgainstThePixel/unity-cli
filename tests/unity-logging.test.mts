import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
    type ActionTableSnapshot,
    describeUtpForUtpLogLevel,
    formatActionTimelineTable,
    normalizeAnnotationPath,
    sanitizeTelemetryJson,
    stringDisplayWidth
} from '../dist/unity-logging.js';

describe('sanitizeTelemetryJson', () => {
    it('removes trailing null characters that break JSON.parse', () => {
        const raw = '{"type":"TestStatus"}\u0000\u0000';
        assert.equal(sanitizeTelemetryJson(raw), '{"type":"TestStatus"}');
    });

    it('strips a UTF-8 BOM and surrounding whitespace', () => {
        const raw = '\ufeff  {"key":"value"}  ';
        const result = sanitizeTelemetryJson(raw);
        assert.notEqual(result, undefined);
        assert.equal(result, '{"key":"value"}');
    });

    it('removes ANSI color codes around JSON', () => {
        const raw = '\u001b[32m{"type":"TestStatus"}\u001b[0m';
        const result = sanitizeTelemetryJson(raw);
        assert.notEqual(result, undefined);
        assert.equal(result, '{"type":"TestStatus"}');
    });
});

describe('stringDisplayWidth', () => {
    it('treats ASCII characters as single width', () => {
        assert.equal(stringDisplayWidth('ABC'), 3);
    });

    it('treats build status emoji as double width', () => {
        assert.equal(stringDisplayWidth('✅'), 2);
        assert.equal(stringDisplayWidth('❌'), 2);
        assert.equal(stringDisplayWidth('⏳'), 2);
    });

    it('handles emoji with variation selectors', () => {
        assert.equal(stringDisplayWidth('✔️'), 2);
    });
});

describe('formatActionTimelineTable', () => {
    const snapshot: ActionTableSnapshot = {
        completed: [
            {
                name: 'Build player',
                description: 'This is a very long description for building scenes and processing assets used to verify column sizing logic.',
                durationMs: 1500,
                errors: [],
            },
        ],
        pending: [],
        totalDurationMs: 1500,
        totalErrorCount: 0,
        playerBuildInfo: undefined,
    };

    const collectTableLines = (text?: string): string[] => {
        if (!text) {
            return [];
        }
        return text.split('\n').filter(line => line.startsWith('┌') || line.startsWith('├') || line.startsWith('└') || line.startsWith('│'));
    };

    const extractDescriptionCellWidth = (row: string): number => {
        const segments = row.split('│');
        const descriptionSegment = segments[2] ?? '';
        return Math.max(0, stringDisplayWidth(descriptionSegment) - 2);
    };

    it('expands the description column to fill the terminal width when space allows', () => {
        const maxWidth = 200;
        const formatted = formatActionTimelineTable(snapshot, { maxWidth });
        assert.notEqual(formatted, undefined);
        const lines = collectTableLines(formatted?.text);
        assert.ok(lines.length > 0);
        lines.forEach(line => {
            assert.equal(stringDisplayWidth(line), maxWidth);
        });

        const fullRow = lines.find(line => line.includes('This is'));
        assert.notEqual(fullRow, undefined);
        assert.ok(!fullRow.includes('...'));
    });

    it('uses the minimum description width when the terminal is too narrow', () => {
        const maxWidth = 38; // Intentionally smaller than the minimum viable table width
        const formatted = formatActionTimelineTable(snapshot, { maxWidth });
        assert.notEqual(formatted, undefined);
        const lines = collectTableLines(formatted?.text);
        const buildRow = lines.find(line => line.includes('This is'));
        assert.notEqual(buildRow, undefined);

        const descriptionWidth = extractDescriptionCellWidth(buildRow!);
        const expectedMinWidth = Math.max(stringDisplayWidth('Description'), 16);
        assert.equal(descriptionWidth, expectedMinWidth);
        assert.ok(buildRow.includes('...'));
    });

    it('renders detailed error sections with multi-line stacks', () => {
        const snapshotWithErrors: ActionTableSnapshot = {
            completed: [
                {
                    name: 'Build player',
                    description: 'Postprocess built player',
                    durationMs: 1500,
                    errors: [
                        'IOException: The file could not be moved\n   at Foo()',
                        'Another error occurred',
                    ],
                },
            ],
            pending: [],
            totalDurationMs: 1500,
            totalErrorCount: 2,
            playerBuildInfo: undefined,
        };

        const formatted = formatActionTimelineTable(snapshotWithErrors, { maxWidth: 120 });
        assert.ok(formatted?.text.includes('Error Details'));
        assert.ok(formatted?.text.includes('Postprocess built player'));
        assert.ok(formatted?.text.includes('IOException: The file could not be moved'));
        assert.ok(formatted?.text.includes('at Foo()'));
        assert.ok(formatted?.text.includes('Another error occurred'));
    });

    it('appends a player build info table when summary data is provided', () => {
        const snapshotWithBuildInfo: ActionTableSnapshot = {
            completed: [],
            pending: [],
            totalDurationMs: 0,
            totalErrorCount: 0,
            playerBuildInfo: {
                steps: [
                    { description: 'Build player', durationMs: 27000, errorCount: 0 },
                    { description: 'Postprocess built player', durationMs: 6200, errorCount: 1 },
                ],
                totalDurationMs: 33200,
                totalErrorCount: 1,
            },
        };

        const formatted = formatActionTimelineTable(snapshotWithBuildInfo, { maxWidth: 120 });
        assert.notEqual(formatted, undefined);
        assert.ok(formatted?.text.includes('📋 Player Build Info'));
        assert.ok(formatted?.text.includes('Postprocess built player'));
        assert.ok(formatted?.text.includes('# of Errors'));
    });
});

describe('describeUtpForUtpLogLevel', () => {
    it('returns a one-line debug string for Compiler', () => {
        const s = describeUtpForUtpLogLevel({
            type: 'Compiler',
            severity: 'Error',
            message: 'bad',
            file: 'Assets/A.cs',
            line: 3,
        } as any);
        assert.ok(s.includes('[UTP] Compiler'));
        assert.ok(s.includes('Assets/A.cs:3'));
        assert.ok(s.includes('bad'));
    });

    it('returns a one-line debug string for TestStatus', () => {
        const s = describeUtpForUtpLogLevel({
            type: 'TestStatus',
            name: 'T.Name',
            state: 1,
            duration: 42,
        } as any);
        assert.ok(s.includes('TestStatus'));
        assert.ok(s.includes('state=1'));
        assert.ok(s.includes('T.Name'));
    });

    it('returns JSON for settings-like types', () => {
        const s = describeUtpForUtpLogLevel({
            type: 'BuildSettings',
            BuildSettings: { Platform: 'Android' },
        } as any);
        assert.ok(s.includes('BuildSettings'));
        assert.ok(s.includes('Android'));
    });

    it('returns undefined for an unknown type string', () => {
        assert.equal(describeUtpForUtpLogLevel({ type: 'FutureUnityType', x: 1 } as any), undefined);
    });
});

describe('normalizeAnnotationPath edge cases', () => {
    it('returns empty result for undefined file', () => {
        assert.deepEqual(normalizeAnnotationPath(undefined, '/tmp/proj'), {});
    });

    it('keeps normalized relative path without project path', () => {
        const out = normalizeAnnotationPath('Assets\\X.cs', undefined);
        assert.equal(out.annotationFile, 'Assets/X.cs');
    });
});
