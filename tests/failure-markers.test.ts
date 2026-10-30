import { ClassifyFailure, LICENSE_EXHAUSTED_MARKER, TRANSIENT_FAILURE_MARKER } from '../src/failure-markers';

describe('ClassifyFailure', () => {
    it.each([
        'Machine activations limit reached for this account',
        'License command failed with exit code 26: Unity ID sign-in rate limit reached: too many sign-in attempts for this account',
        'Code 404 while processing request (status: Found 1 entitlement groups and 0 free entitlements matching requested entitlement ids)',
        'License command failed with exit code 17: Seat activation or deactivation failed\n[Licensing::Client] Error: Machine activations limit reached for this account',
    ])('marks license exhaustion: %s', message => {
        expect(ClassifyFailure(message)).toBe(LICENSE_EXHAUSTED_MARKER);
    });

    it.each([
        'Error: GET https://cdn.packages.unity.com/upm-cli/releases/v9.36.0/upm-macos-arm64.zip.sha256 failed: HTTP 504',
        'Download failed: read ECONNRESET',
        'unity install failed: 503 Service Unavailable',
        'aborted',
        'Error: aborted',
    ])('marks transient failures: %s', message => {
        expect(ClassifyFailure(message)).toBe(TRANSIENT_FAILURE_MARKER);
    });

    it.each([
        'Unity failed with exit code 6',
        'License command failed with exit code 2: Invalid credentials',
        'GET https://example.com failed: HTTP 404',
        'License command failed with exit code 17: Seat activation or deactivation failed',
        'License command failed with exit code 19: Acquiring license failed',
        'connect ECONNREFUSED 127.0.0.1:443',
    ])('leaves other failures unmarked: %s', message => {
        expect(ClassifyFailure(message)).toBeUndefined();
    });
});
