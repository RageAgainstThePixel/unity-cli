import { ActionTableRenderer, type ActionTableSnapshot } from '../src/unity-logging';

describe('ActionTableRenderer behavior (unit)', () => {
    const baseSnapshot: ActionTableSnapshot = {
        completed: Array.from({ length: 10 }, (_, index) => ({
            name: `Step ${index}`,
            description: `Description ${index}`,
            durationMs: index * 10,
            errors: [],
        })),
        pending: [],
        totalDurationMs: 100,
        totalErrorCount: 0,
    };

    const originalColumns = process.stdout.columns;
    const originalRows = process.stdout.rows;

    const noopWrite = jest.fn(() => true);

    beforeEach(() => {
        jest.resetModules();
        noopWrite.mockClear();
        jest.spyOn(process.stdout, 'write').mockImplementation(noopWrite);
    });

    afterEach(() => {
        (process.stdout as typeof process.stdout & { columns?: number; rows?: number }).columns = originalColumns;
        (process.stdout as typeof process.stdout & { columns?: number; rows?: number }).rows = originalRows;
        jest.restoreAllMocks();
    });

    it('anchors the table using rewind-to-heading sequences', () => {
        (process.stdout as typeof process.stdout & { columns?: number; rows?: number }).columns = 80;
        (process.stdout as typeof process.stdout & { columns?: number; rows?: number }).rows = 60;

        const renderer = new ActionTableRenderer(true);

        renderer.render(baseSnapshot);
        renderer.render(baseSnapshot);
        renderer.prepareForContent();
        process.stdout.write('log line\n');

        const writeCalls = noopWrite.mock.calls as Array<unknown[]>;
        const chunks = writeCalls.map(call => call[0]).filter((chunk): chunk is string => typeof chunk === 'string');
        const rewindOps = chunks.filter(chunk => /\u001b\[\d+F/.test(chunk));
        expect(rewindOps.length).toBeGreaterThan(0);
        const clearOps = chunks.filter(chunk => chunk.includes('\u001b[J'));
        expect(clearOps.length).toBeGreaterThan(0);
        const legacyAnchors = chunks.filter(chunk => chunk.includes('\u001b[s') || chunk.includes('\u001b[u'));
        expect(legacyAnchors.length).toBe(0);
    });

    it('renders all rows even when terminal height is small', () => {
        (process.stdout as typeof process.stdout & { columns?: number; rows?: number }).columns = 80;
        (process.stdout as typeof process.stdout & { columns?: number; rows?: number }).rows = 10;

        const renderer = new ActionTableRenderer(true);
        renderer.render(baseSnapshot);

        const writeCalls = noopWrite.mock.calls as Array<unknown[]>;
        const chunks = writeCalls.map(call => call[0]).filter((chunk): chunk is string => typeof chunk === 'string');
        const joined = chunks.join('');
        expect(joined.includes('hidden')).toBe(false);
        expect(joined.includes('⋯')).toBe(false);
    });
});
