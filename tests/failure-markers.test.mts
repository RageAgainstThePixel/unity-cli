import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { ClassifyFailure, FindLicenseExhaustedLine, LICENSE_EXHAUSTED_MARKER, TRANSIENT_FAILURE_MARKER } from '../dist/failure-markers.js';

describe('FindLicenseExhaustedLine', () => {
    it('carries the licensing client\'s seat error into the editor failure, so it is marked retryable', () => {
        const line = FindLicenseExhaustedLine([
            '[Licensing::Module] Error: Access token is unavailable; failed to update',
            '  [Licensing::Client] Error: Code 404 while processing request (status: Found 0 entitlement groups and 0 free entitlements matching requested entitlement ids)',
            '[Licensing::Module] Error: \'com.unity.editor.headless\' was not found.',
        ]);

        assert.equal(line, '[Licensing::Client] Error: Code 404 while processing request (status: Found 0 entitlement groups and 0 free entitlements matching requested entitlement ids)');
        assert.equal(ClassifyFailure(`Unity failed with exit code 6: ${line}`), LICENSE_EXHAUSTED_MARKER);
    });

    it('finds nothing in ordinary error lines', () => {
        assert.equal(FindLicenseExhaustedLine(["Assets/Foo.cs(2,8): error CS1029: #error: 'Intentional compiler error'", 'download failed: ETIMEDOUT']), undefined);
        assert.equal(FindLicenseExhaustedLine([]), undefined);
    });
});

describe('ClassifyFailure', () => {
    for (const message of [
        'Machine activations limit reached for this account',
        'License command failed with exit code 26: Unity ID sign-in rate limit reached: too many sign-in attempts for this account',
        'Code 404 while processing request (status: Found 1 entitlement groups and 0 free entitlements matching requested entitlement ids)',
        'License command failed with exit code 17: Seat activation or deactivation failed\n[Licensing::Client] Error: Machine activations limit reached for this account',
    ]) {
        it(`marks license exhaustion: ${message}`, () => {
            assert.equal(ClassifyFailure(message), LICENSE_EXHAUSTED_MARKER);
        });
    }

    for (const message of [
        'Error: GET https://cdn.packages.unity.com/upm-cli/releases/v9.36.0/upm-macos-arm64.zip.sha256 failed: HTTP 504',
        'Download failed: read ECONNRESET',
        'unity install failed: 503 Service Unavailable',
        'aborted',
        'Error: aborted',
        'unity install --editor-version 6000.0.40f1 --architecture x86_64 --accept-eula --yes failed with retryable exit code 7',
    ]) {
        it(`marks transient failures: ${message}`, () => {
            assert.equal(ClassifyFailure(message), TRANSIENT_FAILURE_MARKER);
        });
    }

    for (const message of [
        'Unity failed with exit code 6',
        'License command failed with exit code 2: Invalid credentials',
        'GET https://example.com failed: HTTP 404',
        'License command failed with exit code 17: Seat activation or deactivation failed',
        'License command failed with exit code 19: Acquiring license failed',
        'connect ECONNREFUSED 127.0.0.1:443',
        'unity install --editor-version 6000.0.40f1 --architecture x86_64 --accept-eula --yes failed with exit code 1',
    ]) {
        it(`leaves other failures unmarked: ${message}`, () => {
            assert.equal(ClassifyFailure(message), undefined);
        });
    }
});
