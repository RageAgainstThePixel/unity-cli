import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import * as assert from 'node:assert/strict';
import { ActionTableRenderer, type ActionTableSnapshot } from '../dist/unity-logging.js';

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

    const noopWrite = mock.fn(() => true);

    beforeEach(() => {
        noopWrite.mock.resetCalls();
        mock.method(process.stdout, 'write', noopWrite);
    });

    afterEach(() => {
        (process.stdout as typeof process.stdout & { columns?: number; rows?: number }).columns = originalColumns;
        (process.stdout as typeof process.stdout & { columns?: number; rows?: number }).rows = originalRows;
        mock.restoreAll();
    });

    it('anchors the table using rewind-to-heading sequences', () => {
        (process.stdout as typeof process.stdout & { columns?: number; rows?: number }).columns = 80;
        (process.stdout as typeof process.stdout & { columns?: number; rows?: number }).rows = 60;

        const renderer = new ActionTableRenderer(true);

        renderer.render(baseSnapshot);
        renderer.render(baseSnapshot);
        renderer.prepareForContent();
        process.stdout.write('log line\n');

        const writeCalls = noopWrite.mock.calls;
        const chunks = writeCalls.map(call => call.arguments[0]).filter((chunk): chunk is string => typeof chunk === 'string');
        const rewindOps = chunks.filter(chunk => /\u001b\[\d+F/.test(chunk));
        assert.ok(rewindOps.length > 0);
        const clearOps = chunks.filter(chunk => chunk.includes('\u001b[J'));
        assert.ok(clearOps.length > 0);
        const legacyAnchors = chunks.filter(chunk => chunk.includes('\u001b[s') || chunk.includes('\u001b[u'));
        assert.equal(legacyAnchors.length, 0);
    });

    it('renders all rows even when terminal height is small', () => {
        (process.stdout as typeof process.stdout & { columns?: number; rows?: number }).columns = 80;
        (process.stdout as typeof process.stdout & { columns?: number; rows?: number }).rows = 10;

        const renderer = new ActionTableRenderer(true);
        renderer.render(baseSnapshot);

        const writeCalls = noopWrite.mock.calls;
        const chunks = writeCalls.map(call => call.arguments[0]).filter((chunk): chunk is string => typeof chunk === 'string');
        const joined = chunks.join('');
        assert.equal(joined.includes('hidden'), false);
        assert.equal(joined.includes('⋯'), false);
    });
});
