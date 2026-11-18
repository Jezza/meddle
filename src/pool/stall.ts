// How long a peer may keep this node waiting on a stream: a fetch gives up on a step that takes longer, and so on the
// peer, rather than wait for it for good.

/** How long a fetch waits for the next piece of what it fetches before it gives the peer up. */
export const STALL_MS = 60_000;

/** What `withTimeout` rejects with when the time ran out first. */
export class TimedOut extends Error {}

/** `promise`, or a rejection `<what> timed out` (`TimedOut`) once `ms` have passed without it settling. */
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new TimedOut(`${what} timed out`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}
