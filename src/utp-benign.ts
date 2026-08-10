/**
 * Known Unity/editor messages that are non-actionable despite elevated UTP severity.
 * Kept in a leaf module (no imports) so normalize, summaries, and CI share one list
 * without circular deps between utp.ts and logging.ts.
 *
 * Severity strings must match {@link Severity} in utp.ts.
 */
export const UTP_BENIGN_SEVERITY_REMAPS: ReadonlyArray<{
    readonly fragment: string;
    readonly severity: 'Info' | 'Warning';
}> = [
    // Longer OpenCL form first so summary strip does not leave a "Failed to find a suitable" prefix.
    { fragment: 'Failed to find a suitable OpenCL device, baking cannot use GPU lightmapper.', severity: 'Info' },
    { fragment: 'OpenCL device, baking cannot use GPU lightmapper.', severity: 'Info' },
    {
        fragment:
            '~StackAllocator(ALLOC_TEMP_MAIN) m_LastAlloc not NULL. Did you forget to call FreeAllStackAllocations()?',
        severity: 'Info',
    },
    // Windows hosted CI: WSAEACCES (10013) — player-connection multicast / socket bind. Unity falls back.
    { fragment: 'Unable to join player connection multicast group', severity: 'Info' },
    { fragment: 'Socket: bind failed', severity: 'Info' },
    {
        fragment: 'An attempt was made to access a socket in a way forbidden by its access permissions',
        severity: 'Info',
    },
    { fragment: 'Access token is unavailable; failed to update', severity: 'Info' },
];

/** True if the message matches a known benign Unity/CI noise fragment. */
export function utpMessageMatchesBenignRemap(message: string): boolean {
    if (!message) {
        return false;
    }
    for (const { fragment } of UTP_BENIGN_SEVERITY_REMAPS) {
        if (message.includes(fragment)) {
            return true;
        }
    }
    return false;
}
