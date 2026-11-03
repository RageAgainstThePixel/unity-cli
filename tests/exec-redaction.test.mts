import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { orderedRedactionSecrets, redactSensitiveLiterals } from '../dist/utilities.js';

describe('exec redaction helpers', () => {
    it('orderedRedactionSecrets dedupes, drops short strings, longest first', () => {
        assert.deepEqual(orderedRedactionSecrets(['ab', 'abcd', 'abcd', 'wxyz']), ['abcd', 'wxyz']);
    });

    it('redactSensitiveLiterals replaces configured secrets', () => {
        const secrets = ['2474207050017', 'my-long-service-secret'];
        const line = 'Organization ID: 2474207050017 token my-long-service-secret end';
        assert.equal(redactSensitiveLiterals(line, secrets),
            'Organization ID: ***** token ***** end'
        );
    });
});
