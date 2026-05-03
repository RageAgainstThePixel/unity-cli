import { orderedRedactionSecrets, redactSensitiveLiterals } from '../src/utilities';

describe('exec redaction helpers', () => {
    it('orderedRedactionSecrets dedupes, drops short strings, longest first', () => {
        expect(orderedRedactionSecrets(['ab', 'abcd', 'abcd', 'wxyz'])).toEqual(['abcd', 'wxyz']);
    });

    it('redactSensitiveLiterals replaces configured secrets', () => {
        const secrets = ['2474207050017', 'my-long-service-secret'];
        const line = 'Organization ID: 2474207050017 token my-long-service-secret end';
        expect(redactSensitiveLiterals(line, secrets)).toBe(
            'Organization ID: ***** token ***** end'
        );
    });
});
