import type { Endpoint, WatchHandle } from "@number0/iroh";
import { Lighthouse, NodeKey, type Topic, type EndpointAddr as LighthouseEndpointAddr, type Peer } from "iroh-lighthouse";
import { isNodeId, type Identity } from "./identity";
import { fromEndpoint } from "./net";
import { dedupe } from "./report";
import type { WireAddr } from "./store";

export const ANNOUNCE_TTL_SECS = 300;
export const REQUEST_TIMEOUT_MS = 10_000;
/** The most `stop()` and `restart()` wait to unregister from a topic. */
const LEAVE_CAP_MS = 2000;
const MIN_REANNOUNCE_MS = 1000;

export function toLighthouseAddr(addr: WireAddr): LighthouseEndpointAddr {
  return {
    id: addr.id,
    addrs: [...addr.direct.map((ip) => ({ Ip: ip })), ...(addr.relay === null ? [] : [{ Relay: addr.relay }])],
  };
}

export function fromLighthouseAddr(addr: LighthouseEndpointAddr): WireAddr {
  let relay: string | null = null;
  const direct: string[] = [];
  for (const t of addr.addrs) {
    if ("Ip" in t && typeof t.Ip === "string") direct.push(t.Ip);
    else if ("Relay" in t && typeof t.Relay === "string" && relay === null) relay = t.Relay;
  }
  return { id: addr.id, relay, direct };
}

export type DiscoveryDeps = {
  endpoint: Endpoint;
  identity: Identity;
  /** The pool's topic (`poolKey(...).topic`): only holders of the pool secret can announce on it or look it up. */
  topic: Topic;
  /** Read at every request, so a test can swap it. */
  lighthouseUrl(): string;
  /** How often a joined node looks the topic up. */
  pollMs: number;
  /** The other nodes on the topic; called only when the set of ids or an address changed. */
  onPeers(peers: WireAddr[]): void;
  /** The ids of the other nodes on the topic, after every announce or lookup that answered (changed or not). */
  onListed?(ids: string[]): void;
  /** Each distinct message at most once a minute. */
  onError?(message: string): void;
  /** Announce retry delays, doubling from `initialMs` up to `maxMs`; default 1000 / 60000. */
  backoff?: { initialMs: number; maxMs: number };
  /** Per-request timeout; default REQUEST_TIMEOUT_MS. */
  requestTimeoutMs?: number;
};

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Announces this node on its pool's lighthouse topic and reports the other nodes found there. The announce retries
 * with backoff until it succeeds, then repeats at half the granted TTL and whenever this endpoint's address changes;
 * a lookup polls every `pollMs` while joined. Never logs and never throws because the lighthouse is down: errors go
 * to `deps.onError`, each distinct message at most once a minute.
 */
export class Discovery {
  private readonly key: NodeKey;
  private readonly backoff: { initialMs: number; maxMs: number };
  private readonly requestTimeoutMs: number;
  private topic: Topic;
  private running = false;
  /** Bumped by every halt, so that the work of a previous run drops its results. */
  private generation = 0;
  private delay: number;
  private announceTimer: ReturnType<typeof setTimeout> | undefined;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private watcher: WatchHandle | null = null;
  /** The announce in flight, if any; `again` asks for another one as soon as it settles. */
  private inflight: Promise<void> | null = null;
  private again = false;
  /** The address of the latest announce attempt, as JSON. */
  private attempted: string | null = null;
  /** The peers last reported to `onPeers`: node id to address as JSON. */
  private known = new Map<string, string>();
  /** Hands a message to `onError` unless the same message was handed over less than a minute ago. */
  private readonly report = dedupe((message) => this.deps.onError?.(message));
  private joinedNow = false;

  constructor(private readonly deps: DiscoveryDeps) {
    this.key = NodeKey.fromBytes(deps.identity.secret);
    this.backoff = deps.backoff ?? { initialMs: 1000, maxMs: 60_000 };
    this.requestTimeoutMs = deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.topic = deps.topic;
    this.delay = this.backoff.initialMs;
  }

  /** The last announce succeeded. */
  get joined(): boolean {
    return this.joinedNow;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const gen = this.generation;
    try {
      this.watcher = this.deps.endpoint.watchAddr(() => this.addressChanged(gen));
    } catch (err) {
      this.report(`watching this node's address: ${messageOf(err)}`);
    }
    this.announceNow(gen);
    this.schedulePoll(gen);
  }

  /** Leaves the old topic (best effort), then starts on `topic`. */
  async restart(topic: Topic): Promise<void> {
    const old = this.topic;
    const wasRunning = this.running;
    const { inflight } = await this.halt();
    if (wasRunning) await this.leave(old, inflight);
    this.topic = topic;
    this.start();
  }

  /** Stops the timers and the address watcher, then unregisters (best effort, at most 2 s). */
  async stop(): Promise<void> {
    if (!this.running) return;
    const { inflight } = await this.halt();
    await this.leave(this.topic, inflight);
  }

  /** Ends the current run; `inflight` is the announce it may still have in flight. */
  private async halt(): Promise<{ inflight: Promise<void> }> {
    this.running = false;
    this.generation++;
    clearTimeout(this.announceTimer);
    clearTimeout(this.pollTimer);
    this.announceTimer = this.pollTimer = undefined;
    const watcher = this.watcher;
    this.watcher = null;
    await watcher?.stop().catch(() => {});
    const inflight = this.inflight ?? Promise.resolve();
    this.inflight = null;
    this.again = false;
    this.attempted = null;
    this.joinedNow = false;
    this.known = new Map();
    this.delay = this.backoff.initialMs;
    return { inflight };
  }

  /** A TTL-0 announce on `topic` once `after` settled; best effort and capped at 2 s overall. */
  private async leave(topic: Topic, after: Promise<void>): Promise<void> {
    const timeoutMs = Math.min(this.requestTimeoutMs, LEAVE_CAP_MS);
    const addr = { id: this.deps.identity.id, relay: null, direct: [] };
    const attempt = after
      .then(() => this.lighthouse(timeoutMs).announce(this.key, topic, toLighthouseAddr(addr), 0))
      .then(() => {}, () => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([attempt, new Promise<void>((resolve) => { timer = setTimeout(resolve, LEAVE_CAP_MS); })]);
    clearTimeout(timer);
  }

  private lighthouse(timeoutMs: number = this.requestTimeoutMs): Lighthouse {
    const timed = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      try {
        return await fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        if (err instanceof Error && err.name === "TimeoutError") throw new Error(`request timed out after ${timeoutMs} ms`);
        throw err;
      }
    };
    return new Lighthouse(this.deps.lighthouseUrl(), { fetch: Object.assign(timed, { preconnect: fetch.preconnect }) });
  }

  private addressChanged(gen: number): void {
    if (gen !== this.generation) return;
    let now: string;
    try {
      now = JSON.stringify(fromEndpoint(this.deps.endpoint));
    } catch {
      return;
    }
    if (now !== this.attempted) this.announceNow(gen);
  }

  /** Announces at once, or right after the announce in flight. */
  private announceNow(gen: number): void {
    clearTimeout(this.announceTimer);
    this.announceTimer = undefined;
    if (this.inflight) {
      this.again = true;
      return;
    }
    const run = this.announce(gen);
    this.inflight = run;
    void run.finally(() => {
      if (this.inflight === run) this.inflight = null;
      if (gen !== this.generation) return;
      if (this.again) {
        this.again = false;
        this.announceNow(gen);
      }
    });
  }

  /** One announce; schedules the next one either way. */
  private async announce(gen: number): Promise<void> {
    let nextMs: number;
    try {
      const addr = fromEndpoint(this.deps.endpoint);
      this.attempted = JSON.stringify(addr);
      const url = this.deps.lighthouseUrl();
      let granted: { ttlSecs: number; peers: Peer[] };
      try {
        granted = await this.lighthouse().announce(this.key, this.topic, toLighthouseAddr(addr), ANNOUNCE_TTL_SECS);
      } catch (err) {
        throw new Error(`announcing on ${url}: ${messageOf(err)}`);
      }
      if (gen !== this.generation) return;
      this.joinedNow = true;
      this.delay = this.backoff.initialMs;
      this.publish(granted.peers);
      // A lighthouse that grants no usable TTL is re-announced to as if it granted the one asked for, never in a loop.
      const ttlSecs = typeof granted.ttlSecs === "number" && Number.isFinite(granted.ttlSecs) ? granted.ttlSecs : ANNOUNCE_TTL_SECS;
      nextMs = Math.max(MIN_REANNOUNCE_MS, (ttlSecs * 1000) / 2);
    } catch (err) {
      if (gen !== this.generation) return;
      this.joinedNow = false;
      this.report(messageOf(err));
      nextMs = this.delay;
      this.delay = Math.min(this.delay * 2, this.backoff.maxMs);
    }
    this.announceTimer = setTimeout(() => this.announceNow(gen), nextMs);
  }

  private schedulePoll(gen: number): void {
    this.pollTimer = setTimeout(() => void this.poll(gen), this.deps.pollMs);
  }

  /** One lookup while joined; failures are silent (the announce loop reports the lighthouse's state). */
  private async poll(gen: number): Promise<void> {
    if (this.joinedNow) {
      try {
        const peers = await this.lighthouse().lookup(this.topic);
        if (gen === this.generation) this.publish(peers);
      } catch {
        // The next announce or poll tries again.
      }
    }
    if (gen === this.generation) this.schedulePoll(gen);
  }

  /** Reports the other valid nodes in `peers` when their ids or addresses differ from the last report. */
  private publish(peers: Peer[]): void {
    const found = new Map<string, WireAddr>();
    for (const p of peers) {
      if (!p?.addr || !isNodeId(p.addr.id) || p.addr.id === this.deps.identity.id || !Array.isArray(p.addr.addrs)) continue;
      found.set(p.addr.id, fromLighthouseAddr(p.addr));
    }
    try {
      this.deps.onListed?.([...found.keys()]);
    } catch (err) {
      this.report(`handling listed peers: ${messageOf(err)}`);
    }
    const next = new Map([...found].map(([id, addr]) => [id, JSON.stringify(addr)]));
    if (next.size === this.known.size && [...next].every(([id, json]) => this.known.get(id) === json)) return;
    this.known = next;
    try {
      this.deps.onPeers([...found.values()]);
    } catch (err) {
      this.report(`handling discovered peers: ${messageOf(err)}`);
    }
  }
}
