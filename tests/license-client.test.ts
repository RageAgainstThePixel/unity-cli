import { LicensingClient, LicenseType } from '../src/license-client';

afterEach(() => {
    jest.restoreAllMocks();
});

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

    it('rejects invalid inline config even if it looks like base64', () => {
        // "YWJjZA==" decodes to "abcd", which is not valid JSON
        expect(() => invokeResolver('YWJjZA==')).toThrow('Services config value is not a valid JSON string or base64 encoded JSON string.');
    });

    it('throws when inline config does not match base64 format', () => {
        expect(() => invokeResolver('not-a-valid-config')).toThrow(/Input does not match base64 format/);
    });

    it('rejects empty inline config', () => {
        expect(() => invokeResolver('   ')).toThrow('Services config value is empty. Provide a file path, JSON, or base64 encoded JSON string.');
    });
});

describe('LicensingClient floating activation order', () => {
    it('prepares services config before checking entitlements', async () => {
        const client = new LicensingClient();
        const setupSpy = jest.spyOn(client as any, 'setupServicesConfig').mockResolvedValue('/tmp/services-config.json');
        const entitlementsSpy = jest.spyOn(client, 'GetActiveEntitlements').mockResolvedValue([]);
        jest.spyOn(client as any, 'exec').mockResolvedValue('Successfully acquired with token: "token-123"');

        await client.Activate({
            licenseType: LicenseType.floating,
            servicesConfig: '{"floatingServer":"https://example.com"}'
        });

        expect(setupSpy).toHaveBeenCalledTimes(1);
        expect(entitlementsSpy).toHaveBeenCalledTimes(1);
        expect(entitlementsSpy.mock.invocationCallOrder[0]).toBeGreaterThan(setupSpy.mock.invocationCallOrder[0]);
    });
});
