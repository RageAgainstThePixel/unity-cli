import { type ActionTableSnapshot, formatActionTimelineTable, stringDisplayWidth } from '../src/unity-logging';

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
});
