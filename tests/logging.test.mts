import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import * as assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { createRequire } from 'node:module';
import * as path from 'path';
type LoggingModule = typeof import('../dist/logging.js');

const require = createRequire(import.meta.url);
const distDir = path.resolve(import.meta.dirname, '..', 'dist') + path.sep;

describe('Logger annotate', () => {
    const ORIGINAL_ENV = process.env;

    const loadLoggingModule = (): LoggingModule => {
        return require('../dist/logging.js') as LoggingModule;
    };

    beforeEach(() => {
        // load a fresh Logger for each test, so it picks up the environment the test sets
        for (const key of Object.keys(require.cache)) {
            if (key.startsWith(distDir)) { delete require.cache[key]; }
        }
        process.env = { ...ORIGINAL_ENV };
    });

    afterEach(() => {
        process.env = ORIGINAL_ENV;
        mock.restoreAll();
    });

    it('formats annotations correctly for GitHub Actions', () => {
        process.env.GITHUB_ACTIONS = 'true';
        const logging = loadLoggingModule();
        const writeSpy = mock.method(process.stdout, 'write', () => true);

        logging.Logger.instance.annotate(
            logging.LogLevel.ERROR,
            'Line one\nLine two',
            'src/file.ts',
            7,
            undefined,
            undefined,
            undefined,
            'Build failed'
        );

        assert.ok(writeSpy.mock.calls.some(call => isDeepStrictEqual(call.arguments, ['::error file=src/file.ts,line=7,title=Build failed::Line one%0ALine two\n'])));
    });

    it('omits metadata spacing when none is provided', () => {
        process.env.GITHUB_ACTIONS = 'true';
        const logging = loadLoggingModule();
        const writeSpy = mock.method(process.stdout, 'write', () => true);

        logging.Logger.instance.annotate(logging.LogLevel.INFO, 'Hello world');

        assert.ok(writeSpy.mock.calls.some(call => isDeepStrictEqual(call.arguments, ['::notice::Hello world\n'])));
    });

    it('falls back to standard logging when annotations are unavailable', () => {
        delete process.env.GITHUB_ACTIONS;
        const logging = loadLoggingModule();
        const writeSpy = mock.method(process.stdout, 'write', () => true);

        logging.Logger.instance.annotate(logging.LogLevel.INFO, 'Hello local');

        assert.ok(writeSpy.mock.calls.some(call => isDeepStrictEqual(call.arguments, ['Hello local\n'])));
    });
});
