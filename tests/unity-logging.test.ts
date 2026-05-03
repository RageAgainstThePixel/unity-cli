import {
    type ActionTableSnapshot,
    describeUtpForUtpLogLevel,
    formatActionTimelineTable,
    normalizeAnnotationPath,
    sanitizeTelemetryJson,
    stringDisplayWidth
} from '../src/unity-logging';

describe('sanitizeTelemetryJson', () => {
    it('removes trailing null characters that break JSON.parse', () => {
        const raw = '{"type":"TestStatus"}\u0000\u0000';
        expect(sanitizeTelemetryJson(raw)).toBe('{"type":"TestStatus"}');
    });

    it('strips a UTF-8 BOM and surrounding whitespace', () => {
        const raw = '\ufeff  {"key":"value"}  ';
        const result = sanitizeTelemetryJson(raw);
        expect(result).not.toBeUndefined();
        expect(result).toBe('{"key":"value"}');
    });

    it('removes ANSI color codes around JSON', () => {
        const raw = '\u001b[32m{"type":"TestStatus"}\u001b[0m';
        const result = sanitizeTelemetryJson(raw);
        expect(result).not.toBeUndefined();
        expect(result).toBe('{"type":"TestStatus"}');
    });
});

describe('stringDisplayWidth', () => {
    it('treats ASCII characters as single width', () => {
        expect(stringDisplayWidth('ABC')).toBe(3);
    });

    it('treats build status emoji as double width', () => {
        expect(stringDisplayWidth('✅')).toBe(2);
        expect(stringDisplayWidth('❌')).toBe(2);
        expect(stringDisplayWidth('⏳')).toBe(2);
    });

    it('handles emoji with variation selectors', () => {
        expect(stringDisplayWidth('✔️')).toBe(2);
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
        expect(formatted).toBeDefined();
        const lines = collectTableLines(formatted?.text);
        expect(lines.length).toBeGreaterThan(0);
        lines.forEach(line => {
            expect(stringDisplayWidth(line)).toBe(maxWidth);
        });

        const fullRow = lines.find(line => line.includes('This is'));
        expect(fullRow).toBeDefined();
        expect(fullRow).not.toContain('...');
    });

    it('uses the minimum description width when the terminal is too narrow', () => {
        const maxWidth = 38; // Intentionally smaller than the minimum viable table width
        const formatted = formatActionTimelineTable(snapshot, { maxWidth });
        expect(formatted).toBeDefined();
        const lines = collectTableLines(formatted?.text);
        const buildRow = lines.find(line => line.includes('This is'));
        expect(buildRow).toBeDefined();

        const descriptionWidth = extractDescriptionCellWidth(buildRow!);
        const expectedMinWidth = Math.max(stringDisplayWidth('Description'), 16);
        expect(descriptionWidth).toBe(expectedMinWidth);
        expect(buildRow).toContain('...');
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
        expect(formatted?.text).toContain('Error Details');
        expect(formatted?.text).toContain('Postprocess built player');
        expect(formatted?.text).toContain('IOException: The file could not be moved');
        expect(formatted?.text).toContain('at Foo()');
        expect(formatted?.text).toContain('Another error occurred');
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
        expect(formatted).toBeDefined();
        expect(formatted?.text).toContain('📋 Player Build Info');
        expect(formatted?.text).toContain('Postprocess built player');
        expect(formatted?.text).toContain('# of Errors');
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
        expect(s).toContain('[UTP] Compiler');
        expect(s).toContain('Assets/A.cs:3');
        expect(s).toContain('bad');
    });

    it('returns a one-line debug string for TestStatus', () => {
        const s = describeUtpForUtpLogLevel({
            type: 'TestStatus',
            name: 'T.Name',
            state: 1,
            duration: 42,
        } as any);
        expect(s).toContain('TestStatus');
        expect(s).toContain('state=1');
        expect(s).toContain('T.Name');
    });

    it('returns JSON for settings-like types', () => {
        const s = describeUtpForUtpLogLevel({
            type: 'BuildSettings',
            BuildSettings: { Platform: 'Android' },
        } as any);
        expect(s).toContain('BuildSettings');
        expect(s).toContain('Android');
    });

    it('returns undefined for an unknown type string', () => {
        expect(describeUtpForUtpLogLevel({ type: 'FutureUnityType', x: 1 } as any)).toBeUndefined();
    });
});

describe('normalizeAnnotationPath edge cases', () => {
    it('returns empty result for undefined file', () => {
        expect(normalizeAnnotationPath(undefined, '/tmp/proj')).toEqual({});
    });

    it('keeps normalized relative path without project path', () => {
        const out = normalizeAnnotationPath('Assets\\X.cs', undefined);
        expect(out.annotationFile).toBe('Assets/X.cs');
    });
});
