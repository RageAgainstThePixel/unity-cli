import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import * as assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { Logger, LogLevel } from '../dist/logging.js';

describe('Credential Scrubbing', () => {
    let writeSpy: ReturnType<typeof mock.method>;
    let originalLogLevel: LogLevel;

    beforeEach(() => {
        writeSpy = mock.method(process.stdout, 'write', () => true);
        originalLogLevel = Logger.instance.logLevel;
        Logger.instance.logLevel = LogLevel.DEBUG; // Ensure debug logging is enabled
    });

    afterEach(() => {
        writeSpy.mock.restore();
        Logger.instance.logLevel = originalLogLevel; // Restore original log level
    });

    describe('debugOptions', () => {
        it('should scrub password from options', () => {
            const options = {
                email: 'test@example.com',
                password: 'SuperSecret123',
                verbose: true
            };

            Logger.instance.debugOptions(options);

            const output = writeSpy.mock.calls.map(call => call.arguments[0]).join('');
            assert.ok(output.includes('[REDACTED]'));
            assert.ok(!output.includes('SuperSecret123'));
        });

        it('should scrub email from options', () => {
            const options = {
                email: 'sensitive@example.com',
                package: './my-package',
                verbose: true
            };

            Logger.instance.debugOptions(options);

            const output = writeSpy.mock.calls.map(call => call.arguments[0]).join('');
            assert.ok(output.includes('[REDACTED]'));
            assert.ok(!output.includes('sensitive@example.com'));
        });

        it('should scrub serial from options', () => {
            const options = {
                license: 'professional',
                serial: 'ABC-123-DEF-456',
                verbose: true
            };

            Logger.instance.debugOptions(options);

            const output = writeSpy.mock.calls.map(call => call.arguments[0]).join('');
            assert.ok(output.includes('[REDACTED]'));
            assert.ok(!output.includes('ABC-123-DEF-456'));
        });

        it('should scrub token from options', () => {
            const options = {
                license: 'floating',
                token: 'secret-token-12345',
                verbose: true
            };

            Logger.instance.debugOptions(options);

            const output = writeSpy.mock.calls.map(call => call.arguments[0]).join('');
            assert.ok(output.includes('[REDACTED]'));
            assert.ok(!output.includes('secret-token-12345'));
        });

        it('should scrub organization from options', () => {
            const options = {
                package: './package',
                organization: 'org-id-12345',
                verbose: true
            };

            Logger.instance.debugOptions(options);

            const output = writeSpy.mock.calls.map(call => call.arguments[0]).join('');
            assert.ok(output.includes('[REDACTED]'));
            assert.ok(!output.includes('org-id-12345'));
        });

        it('should scrub config from options', () => {
            const options = {
                license: 'floating',
                config: '{"server":"license.example.com","port":8080}',
                verbose: true
            };

            Logger.instance.debugOptions(options);

            const output = writeSpy.mock.calls.map(call => call.arguments[0]).join('');
            assert.ok(output.includes('[REDACTED]'));
            assert.ok(!output.includes('"server":"license.example.com"'));
        });

        it('should preserve non-sensitive options', () => {
            const options = {
                email: 'test@example.com',
                password: 'secret',
                verbose: true,
                package: './my-package',
                output: './output'
            };

            Logger.instance.debugOptions(options);

            const output = writeSpy.mock.calls.map(call => call.arguments[0]).join('');
            assert.ok(output.includes('my-package'));
            assert.ok(output.includes('./output'));
            assert.ok(output.includes('true'));
            assert.ok(!output.includes('test@example.com'));
            assert.ok(!output.includes('secret'));
        });

        it('should scrub nested sensitive options', () => {
            const options = {
                credentials: {
                    email: 'nested@example.com',
                    password: 'nested-secret'
                },
                verbose: true
            };

            Logger.instance.debugOptions(options);

            const output = writeSpy.mock.calls.map(call => call.arguments[0]).join('');
            assert.ok(output.includes('[REDACTED]'));
            assert.ok(!output.includes('nested@example.com'));
            assert.ok(!output.includes('nested-secret'));
        });

        it('should scrub sensitive options in arrays', () => {
            const options = {
                users: [
                    { email: 'user1@example.com', name: 'User 1' },
                    { email: 'user2@example.com', name: 'User 2' }
                ],
                verbose: true
            };

            Logger.instance.debugOptions(options);

            const output = writeSpy.mock.calls.map(call => call.arguments[0]).join('');
            assert.ok(output.includes('[REDACTED]'));
            assert.ok(output.includes('User 1'));
            assert.ok(output.includes('User 2'));
            assert.ok(!output.includes('user1@example.com'));
            assert.ok(!output.includes('user2@example.com'));
        });

        it('should handle null and undefined values', () => {
            const options = {
                email: null,
                password: undefined,
                token: '',
                verbose: true
            };

            Logger.instance.debugOptions(options);

            const output = writeSpy.mock.calls.map(call => call.arguments[0]).join('');
            assert.notEqual(output, undefined);
        });

        it('should scrub all sensitive keys case-insensitively', () => {
            const options = {
                Password: 'secret1',
                EMAIL: 'test@example.com',
                Organization: 'org123',
                verbose: true
            };

            Logger.instance.debugOptions(options);

            const output = writeSpy.mock.calls.map(call => call.arguments[0]).join('');
            assert.ok(output.includes('[REDACTED]'));
            assert.ok(!output.includes('secret1'));
            assert.ok(!output.includes('test@example.com'));
            assert.ok(!output.includes('org123'));
        });
    });

    describe('maskCredential', () => {
        it('should call CI_mask for non-empty credentials', () => {
            const maskSpy = mock.method(Logger.instance, 'CI_mask');

            Logger.instance.maskCredential('my-secret-password');

            assert.ok(maskSpy.mock.calls.some(call => isDeepStrictEqual(call.arguments, ['my-secret-password'])));
            maskSpy.mock.restore();
        });

        it('should not call CI_mask for undefined credentials', () => {
            const maskSpy = mock.method(Logger.instance, 'CI_mask');

            Logger.instance.maskCredential(undefined);

            assert.equal(maskSpy.mock.callCount(), 0);
            maskSpy.mock.restore();
        });

        it('should not call CI_mask for empty string credentials', () => {
            const maskSpy = mock.method(Logger.instance, 'CI_mask');

            Logger.instance.maskCredential('');

            assert.equal(maskSpy.mock.callCount(), 0);
            maskSpy.mock.restore();
        });
    });
});
