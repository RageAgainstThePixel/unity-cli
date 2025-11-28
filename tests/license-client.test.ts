import { LicensingClient } from '../src/license-client';

describe('LicensingClient services config handling', () => {
    const invokeResolver = (input: string) => {
        const client = new LicensingClient();
        return (client as any).resolveServicesConfigContent(input);
    };

    it('accepts raw JSON input', () => {
        const json = '{"floatingServer":"https://example.com"}';
        expect(invokeResolver(json)).toBe(json);
    });

    it('accepts base64 encoded JSON input', () => {
        const json = '{"floatingServer":"https://example.com"}';
        const encoded = Buffer.from(json, 'utf-8').toString('base64');
        expect(invokeResolver(encoded)).toBe(json);
    });

    it('rejects invalid inline config', () => {
        expect(() => invokeResolver('not-a-valid-config')).toThrow('Services config value is not a valid JSON string or base64 encoded JSON string.');
    });

    it('rejects empty inline config', () => {
        expect(() => invokeResolver('   ')).toThrow('Services config value is empty. Provide a file path, JSON, or base64 encoded JSON string.');
    });
});
