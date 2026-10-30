import { Logger, LogLevel } from './logging';

/** Annotation title for a failure a later rerun can clear because a license seat was taken. */
export const LICENSE_EXHAUSTED_MARKER = 'unity-license-exhausted';

/** Annotation title for a network or CDN failure a later rerun can clear. */
export const TRANSIENT_FAILURE_MARKER = 'unity-transient-failure';

// only phrases that name a seat or activation limit: the licensing client's generic "seat activation failed" and
// "acquiring license failed" also cover a wrong password or a revoked license, which a rerun would only repeat.
// Literal alternations only, so matching stays linear on any message.
const LICENSE_EXHAUSTED_PATTERN = /activations? limit|maximum number of activations|max activations|no free seats?|no available seats?|seat limit|0 free entitlements|sign-in rate limit/i;
// a refused connection usually means a wrong host or port, which a rerun repeats, so it is not listed
const TRANSIENT_PATTERN = /HTTP 5\d\d|Bad Gateway|Service Unavailable|Gateway Time-?out|ECONNRESET|ECONNABORTED|ETIMEDOUT|EAI_AGAIN|socket hang up/i;

/**
 * The marker for a failure a rerun after other jobs finish can clear, if the message names one.
 * @param message The error message.
 * @returns The marker, or undefined for a failure a rerun would repeat.
 */
export function ClassifyFailure(message: string): string | undefined {
    if (LICENSE_EXHAUSTED_PATTERN.test(message)) {
        return LICENSE_EXHAUSTED_MARKER;
    }

    // Node reports a download cut off mid-stream with a bare "aborted"
    if (TRANSIENT_PATTERN.test(message) || /^(Error: )?aborted$/.test(message.trim())) {
        return TRANSIENT_FAILURE_MARKER;
    }

    return undefined;
}

/**
 * Logs a command failure. Failures a rerun can clear get a notice annotation titled with their marker, which the
 * rerun workflow looks for; every failure is then logged as an error as before. The marker is a notice because GitHub
 * keeps only 10 error annotations per step, and a step that already reported editor errors would drop it.
 * @param error The error that ended the command.
 */
export function ReportFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const marker = ClassifyFailure(message);

    if (marker) {
        Logger.instance.annotate(LogLevel.INFO, `Retryable failure: ${message}`, undefined, undefined, undefined, undefined, undefined, marker);
    }

    Logger.instance.error(message);
}
