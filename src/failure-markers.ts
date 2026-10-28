import { Logger, LogLevel } from './logging';

/** Annotation title for a failure a later rerun can clear because a license seat was taken. */
export const LICENSE_EXHAUSTED_MARKER = 'unity-license-exhausted';

/** Annotation title for a network or CDN failure a later rerun can clear. */
export const TRANSIENT_FAILURE_MARKER = 'unity-transient-failure';

// literal alternations only, so matching stays linear on any message
// the licensing client's exit codes 17 and 19 cover a seat it could not take
const LICENSE_EXHAUSTED_PATTERN = /activations? limit|maximum number of activations|max activations|no free seats?|no available seats?|seat limit|0 free entitlements|Seat activation or deactivation failed|Acquiring license failed/i;
const TRANSIENT_PATTERN = /HTTP 5\d\d|Bad Gateway|Service Unavailable|Gateway Time-?out|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|socket hang up/i;

/**
 * The marker for a failure a rerun after other jobs finish can clear, if the message names one.
 * @param message The error message.
 * @returns The marker, or undefined for a failure a rerun would repeat.
 */
export function ClassifyFailure(message: string): string | undefined {
    if (LICENSE_EXHAUSTED_PATTERN.test(message)) {
        return LICENSE_EXHAUSTED_MARKER;
    }

    if (TRANSIENT_PATTERN.test(message)) {
        return TRANSIENT_FAILURE_MARKER;
    }

    return undefined;
}

/**
 * Logs a command failure. Failures a rerun can clear become an error annotation titled with their marker,
 * which the rerun workflow looks for; every other failure is logged as before.
 * @param error The error that ended the command.
 */
export function ReportFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const marker = ClassifyFailure(message);

    if (marker) {
        Logger.instance.annotate(LogLevel.ERROR, message, undefined, undefined, undefined, undefined, undefined, marker);
    } else {
        Logger.instance.error(message);
    }
}
