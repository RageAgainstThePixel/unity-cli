import { Logger, LogLevel } from '../src/logging';

describe('Credential Scrubbing', () => {
    let writeSpy: jest.SpyInstance;
    let originalLogLevel: LogLevel;

    beforeEach(() => {
        writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
        originalLogLevel = Logger.instance.logLevel;
        Logger.instance.logLevel = LogLevel.DEBUG; // Ensure debug logging is enabled
    });

    afterEach(() => {
        writeSpy.mockRestore();
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

            const output = writeSpy.mock.calls.map((call: any[]) => call[0]).join('');
            expect(output).toContain('[REDACTED]');
            expect(output).not.toContain('SuperSecret123');
        });

        it('should scrub email from options', () => {
            const options = {
                email: 'sensitive@example.com',
                package: './my-package',
                verbose: true
            };

            Logger.instance.debugOptions(options);

            const output = writeSpy.mock.calls.map((call: any[]) => call[0]).join('');
            expect(output).toContain('[REDACTED]');
            expect(output).not.toContain('sensitive@example.com');
        });

        it('should scrub serial from options', () => {
            const options = {
                license: 'professional',
                serial: 'ABC-123-DEF-456',
                verbose: true
            };

            Logger.instance.debugOptions(options);

            const output = writeSpy.mock.calls.map((call: any[]) => call[0]).join('');
            expect(output).toContain('[REDACTED]');
            expect(output).not.toContain('ABC-123-DEF-456');
        });

        it('should scrub token from options', () => {
            const options = {
                license: 'floating',
                token: 'secret-token-12345',
                verbose: true
            };

            Logger.instance.debugOptions(options);

            const output = writeSpy.mock.calls.map((call: any[]) => call[0]).join('');
            expect(output).toContain('[REDACTED]');
            expect(output).not.toContain('secret-token-12345');
        });

        it('should scrub organization from options', () => {
            const options = {
                package: './package',
                organization: 'org-id-12345',
                verbose: true
            };

            Logger.instance.debugOptions(options);

            const output = writeSpy.mock.calls.map((call: any[]) => call[0]).join('');
            expect(output).toContain('[REDACTED]');
            expect(output).not.toContain('org-id-12345');
        });

        it('should scrub config from options', () => {
            const options = {
                license: 'floating',
                config: '{"server":"license.example.com","port":8080}',
                verbose: true
            };

            Logger.instance.debugOptions(options);

            const output = writeSpy.mock.calls.map((call: any[]) => call[0]).join('');
            expect(output).toContain('[REDACTED]');
            expect(output).not.toContain('"server":"license.example.com"');
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

            const output = writeSpy.mock.calls.map((call: any[]) => call[0]).join('');
            expect(output).toContain('my-package');
            expect(output).toContain('./output');
            expect(output).toContain('true');
            expect(output).not.toContain('test@example.com');
            expect(output).not.toContain('secret');
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

            const output = writeSpy.mock.calls.map((call: any[]) => call[0]).join('');
            expect(output).toContain('[REDACTED]');
            expect(output).not.toContain('nested@example.com');
            expect(output).not.toContain('nested-secret');
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

            const output = writeSpy.mock.calls.map((call: any[]) => call[0]).join('');
            expect(output).toContain('[REDACTED]');
            expect(output).toContain('User 1');
            expect(output).toContain('User 2');
            expect(output).not.toContain('user1@example.com');
            expect(output).not.toContain('user2@example.com');
        });

        it('should handle null and undefined values', () => {
            const options = {
                email: null,
                password: undefined,
                token: '',
                verbose: true
            };

            Logger.instance.debugOptions(options);

            const output = writeSpy.mock.calls.map((call: any[]) => call[0]).join('');
            expect(output).toBeDefined();
        });

        it('should scrub all sensitive keys case-insensitively', () => {
            const options = {
                Password: 'secret1',
                EMAIL: 'test@example.com',
                Organization: 'org123',
                verbose: true
            };

            Logger.instance.debugOptions(options);

            const output = writeSpy.mock.calls.map((call: any[]) => call[0]).join('');
            expect(output).toContain('[REDACTED]');
            expect(output).not.toContain('secret1');
            expect(output).not.toContain('test@example.com');
            expect(output).not.toContain('org123');
        });
    });

    describe('maskCredential', () => {
        it('should call CI_mask for non-empty credentials', () => {
            const maskSpy = jest.spyOn(Logger.instance, 'CI_mask');

            Logger.instance.maskCredential('my-secret-password');

            expect(maskSpy).toHaveBeenCalledWith('my-secret-password');
            maskSpy.mockRestore();
        });

        it('should not call CI_mask for undefined credentials', () => {
            const maskSpy = jest.spyOn(Logger.instance, 'CI_mask');

            Logger.instance.maskCredential(undefined);

            expect(maskSpy).not.toHaveBeenCalled();
            maskSpy.mockRestore();
        });

        it('should not call CI_mask for empty string credentials', () => {
            const maskSpy = jest.spyOn(Logger.instance, 'CI_mask');

            Logger.instance.maskCredential('');

            expect(maskSpy).not.toHaveBeenCalled();
            maskSpy.mockRestore();
        });
    });
});
