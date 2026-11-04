// When each member was last heard of, and whether it is gone: not heard of for longer than the pool's `roster.forget`.
// Gone is this node's own judgement, never replicated: it drops the member from the address book (not dialed, its
// address not offered) but not from the roster, and it rejoins by proving the secret.
import type { RosterRow } from "./store";

/** A jump of the wall clock against the monotonic one larger than this means the machine slept (or the clock moved). */
const SLEEP_JUMP_MS = 30_000;

export type Clocks = { now(): number; monotonic(): number };

const realClocks: Clocks = { now: () => Date.now(), monotonic: () => performance.now() };

/**
 * A member is last heard of at the newest of: a connection with this node (now, while there is one), a member's
 * report of a connection with it (`reachedAt`, replicated), and a lighthouse listing of it seen here. It is gone once
 * that is more than the threshold before the last time this node itself heard of the pool (a connection, or a
 * lighthouse that answered): a node cut off from everyone forgets nobody, so it keeps dialing them. Nor is a member
 * gone within the threshold of this node first knowing of it in this process, or of the machine waking from sleep:
 * a node that was itself away judges no one by the time it was away.
 */
export class Presence {
  /** When this process first knew of each node id. */
  private readonly known = new Map<string, number>();
  /** When each node id was last listed by the lighthouse. */
  private readonly listed = new Map<string, number>();
  private readonly clocks: Clocks;
  /** The last time this node heard of the pool itself. */
  private contact: number;
  /** When the machine last woke (or the process started). */
  private awakeSince: number;
  /** Wall time minus monotonic time at the last `tick`. */
  private drift: number;

  constructor(clocks: Clocks = realClocks) {
    this.clocks = clocks;
    const now = clocks.now();
    this.contact = now;
    this.awakeSince = now;
    this.drift = now - clocks.monotonic();
  }

  /**
   * Brings the judgement up to date: notices a sleep (the wall clock ran ahead of the monotonic one) and, when
   * `inTouch` (this node has a connection, or the lighthouse answered it), records that it heard of the pool now.
   */
  tick(inTouch: boolean): void {
    const now = this.clocks.now();
    const drift = now - this.clocks.monotonic();
    if (Math.abs(drift - this.drift) > SLEEP_JUMP_MS) this.awakeSince = now;
    this.drift = drift;
    if (inTouch) this.contact = now;
  }

  /** Records that this process knows of these node ids (from now, for the ones it did not know yet). */
  know(ids: Iterable<string>): void {
    const now = this.clocks.now();
    for (const id of ids) if (!this.known.has(id)) this.known.set(id, now);
  }

  /** The lighthouse listed these node ids just now: each is heard of, and so is the pool. */
  listedNow(ids: Iterable<string>): void {
    const now = this.clocks.now();
    for (const id of ids) this.listed.set(id, now);
    this.contact = now;
  }

  /** When the node was last heard of (ms), or null when never: now while `online`. */
  lastHeard(row: Pick<RosterRow, "nodeId" | "reachedAt">, online: boolean): number | null {
    if (online) return this.clocks.now();
    const reached = row.reachedAt === null ? NaN : Date.parse(row.reachedAt);
    const listed = this.listed.get(row.nodeId) ?? NaN;
    const newest = Math.max(Number.isFinite(reached) ? reached : -Infinity, Number.isFinite(listed) ? listed : -Infinity);
    return newest === -Infinity ? null : newest;
  }

  /** Whether the member is gone, with `thresholdMs` the pool's `roster.forget` (null: nobody ever is). */
  gone(row: Pick<RosterRow, "nodeId" | "reachedAt">, online: boolean, thresholdMs: number | null): boolean {
    if (thresholdMs === null || online) return false;
    const floor = Math.max(this.known.get(row.nodeId) ?? this.clocks.now(), this.awakeSince);
    const heard = Math.max(this.lastHeard(row, false) ?? -Infinity, floor);
    return heard < this.contact - thresholdMs;
  }
}
