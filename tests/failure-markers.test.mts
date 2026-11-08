import { afterEach, describe, it, mock } from 'node:test';
import * as assert from 'node:assert/strict';
import { ClassifyFailure, FindLicenseExhaustedLine, LICENSE_EXHAUSTED_MARKER, ReportFailure, TRANSIENT_FAILURE_MARKER } from '../dist/failure-markers.js';
import { Logger } from '../dist/logging.js';
import { HasErrorAnnotation, UnityCliEnvironment, UnityCliError, UnityCliExitPhrase } from '../dist/unity-cli.js';

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

describe('official CLI exit codes', () => {
    afterEach(() => {
        mock.restoreAll();
    });

    it('marks exit 7 (service unreachable) as transient', () => {
        assert.equal(ClassifyFailure(`unity editors info 6000.0.0f1 failed with ${UnityCliExitPhrase(7)}`), TRANSIENT_FAILURE_MARKER);
    });

    it('leaves exit 6 to the message', () => {
        assert.equal(UnityCliExitPhrase(6), 'exit code 6');
        assert.equal(ClassifyFailure(`Unity failed with ${UnityCliExitPhrase(6)}`), undefined);
    });

    it('never marks exit 8 (tests failed), even when the message names a network error', () => {
        const annotate = mock.method(Logger.instance, 'annotate', () => { });
        mock.method(Logger.instance, 'error', () => { });
        ReportFailure(new UnityCliError('unity test failed with exit code 8: socket hang up', 8));
        assert.equal(annotate.mock.callCount(), 0);
    });

    it('keeps the marker but skips its own error annotation when the CLI already annotated', () => {
        const annotate = mock.method(Logger.instance, 'annotate', () => { });
        const error = mock.method(Logger.instance, 'error', () => { });
        const info = mock.method(Logger.instance, 'info', () => { });
        ReportFailure(new UnityCliError(`unity install 6000.0.0f1 failed with ${UnityCliExitPhrase(7)}`, 7, true));
        assert.equal(annotate.mock.callCount(), 1);
        assert.equal(annotate.mock.calls[0]!.arguments[7], TRANSIENT_FAILURE_MARKER);
        assert.equal(error.mock.callCount(), 0);
        assert.equal(info.mock.callCount(), 1);
    });

    it('still reports an unannotated CLI failure as an error', () => {
        const error = mock.method(Logger.instance, 'error', () => { });
        mock.method(Logger.instance, 'annotate', () => { });
        ReportFailure(new UnityCliError('unity install 6000.0.0f1 failed with exit code 6', 6, false));
        assert.equal(error.mock.callCount(), 1);
    });
});

describe('github format', () => {
    it('detects the CLI\'s error annotations', () => {
        assert.equal(HasErrorAnnotation('::error::Editor path is not signed\n  Code: EDITOR_PATH_NOT_SIGNED'), true);
        assert.equal(HasErrorAnnotation('Installing...\n::error title=x::boom'), true);
        assert.equal(HasErrorAnnotation('Error: something failed\n::warning::careful'), false);
    });

    it('defaults UNITY_FORMAT to github under GitHub Actions only', () => {
        assert.equal(UnityCliEnvironment({ GITHUB_ACTIONS: 'true' }).UNITY_FORMAT, 'github');
        assert.equal(UnityCliEnvironment({ GITHUB_ACTIONS: 'true', UNITY_FORMAT: 'human' }).UNITY_FORMAT, 'human');
        assert.equal(UnityCliEnvironment({ GITHUB_ACTIONS: 'true', HUB_FORMAT: 'human' }).UNITY_FORMAT, undefined);
        assert.equal(UnityCliEnvironment({}).UNITY_FORMAT, undefined);
    });
});
