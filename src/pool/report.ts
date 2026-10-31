// Reporting each distinct message at most once a minute, as discovery and the pool runtime log.

/** How long the same message stays quiet after it was reported. */
export const QUIET_MS = 60_000;

/**
 * Wraps `sink` so that each distinct message reaches it at most once per `quietMs` (default a minute): a repeat within
 * that time is dropped, a different message passes. `now` is the clock (tests).
 */
export function dedupe(sink: (message: string) => void, options: { quietMs?: number; now?: () => number } = {}): (message: string) => void {
  const quietMs = options.quietMs ?? QUIET_MS;
  const now = options.now ?? Date.now;
  const reportedAt = new Map<string, number>();
  return (message) => {
    const at = now();
    for (const [m, when] of reportedAt) if (at - when >= quietMs) reportedAt.delete(m);
    if (reportedAt.has(message)) return;
    reportedAt.set(message, at);
    sink(message);
  };
}
