// Pool sync: each node holds every online peer's PoolObject (peer variant) over a chord link on iroh, merges the
// peer's roster, settings and token rows into its own, pulls the value of each token it lists but lacks, by id, and
// deletes the value of each token the pool removed.
import type { Database } from "bun:sqlite";
import { createHost, type Host } from "@earendil-works/chord";
import type { NodeConfig } from "../config";
import { PoolObject } from "../state/contracts";
import { deleteTokenValue, hasTokenValue, listTokens, mergeTokens, tokenId, tokenRow, tokenValue, writeTokenValue } from "../token";
import { shortId } from "./identity";
import { IrohLink, type LinkTap } from "./link";
import { fromEndpoint, remoteAddrOf, type PoolNet } from "./net";
import { PEER_PRINCIPAL_PREFIX } from "./object";
import type { PoolSettings } from "./settings";
import type { NodeSummary, PoolStore } from "./store";

export type SyncDeps = {
  cfg: NodeConfig;
  /** The node's database: a peer's token rows are merged into it. */
  db: Database;
  store: PoolStore;
  net: PoolNet;
  selfId: string;
  /** The pool's settings: a peer's are merged in, then applied. */
  settings: PoolSettings;
  summary(): NodeSummary | Promise<NodeSummary>;
  /** The roster, the tokens or the settings changed because of a peer, or the self row was refreshed. */
  onChange(): void;
  onError?(err: unknown): void;
  /** Log lines (a peer's token rows this node dropped); default `console.error`. */
  log?(line: string): void;
  /** Tests: every frame sent or received on every peer link. */
  tap?: LinkTap;
  /** Self-row refresh period, default 15000. */
  refreshMs?: number;
  /** The first wait before holding a peer's PoolObject again after a failure, default 1000 (doubling to 30 s). */
  holdRetryMs?: number;
};

/** The peer's PoolObject as held over its link; `host` is this node's client host for that link. */
type PeerView = {
  host: Host | null;
  abort: AbortController;
  /** The ids of the tokens the peer's rows list as not removed, from its latest `tokens` state. */
  tokenIds: Set<string>;
  /** Asks the peer for a token's value (aborted with the view); set once its PoolObject is held. */
  fetchToken: ((id: string) => Promise<{ value: string }>) | null;
};

/** Reported when this node could not hold a peer's PoolObject (it is tried again, with backoff, while the peer is online). */
export class HoldFailed extends Error {
  constructor(readonly peerId: string, message: string) {
    super(message);
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Settles as `promise` does, or rejects with the signal's reason once it aborts. */
function unlessAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (err: unknown) => { signal.removeEventListener("abort", onAbort); reject(err); },
    );
  });
}

/** Whether `promise` settles within `ms`. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.race([
    promise.then(() => true, () => true),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); }),
  ]);
  clearTimeout(timer);
  return settled;
}

/** The longest wait between attempts to hold an online peer's PoolObject. */
const HOLD_RETRY_MAX_MS = 30_000;

/** How many dropped token ids are logged at most, so that a peer sending junk cannot fill the log. */
const MAX_LOGGED_REJECTIONS = 100;

export class PoolSync {
  private readonly views = new Map<string, PeerView>();
  /** Client hosts being closed, so that `stop()` can wait for them. */
  private readonly closing = new Set<Promise<void>>();
  /**
   * Token value pulls and deletions, one at a time, so that two peers' answers, or an answer and a removal, cannot
   * interleave between a check of the row and the write.
   */
  private pulls: Promise<void> = Promise.resolve();
  /** Token ids a periodic retry queued and that have not run yet, so retries cannot pile up behind a slow pull. */
  private readonly retrying = new Set<string>();
  /** Periodic retries so far: which holder of an id is asked turns with it. */
  private retries = 0;
  /** Token ids already logged as dropped (at most `MAX_LOGGED_REJECTIONS`), so each is logged once. */
  private readonly rejectedLogged = new Set<string>();
  /** Per peer whose hold failed: the next wait before trying again, and the timer of the try pending. */
  private readonly holdRetry = new Map<string, { waitMs: number; timer: ReturnType<typeof setTimeout> | null }>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private unsubscribe: (() => void) | undefined;
  private started = false;
  private stopped = false;

  constructor(private readonly deps: SyncDeps) {}

  /** Holds every online peer's PoolObject (and each one that comes online), and refreshes the self row periodically. */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.unsubscribe = this.deps.net.onPeer((id, online) => {
      if (online) this.hold(id);
      else {
        // Back online later, it is held at once, and a failure then backs off from the start.
        this.cancelRetry(id, true);
        void this.drop(id);
      }
    });
    for (const id of this.deps.net.online()) this.hold(id);
    this.refreshInBackground();
    this.timer = setInterval(() => this.refreshInBackground(), this.deps.refreshMs ?? 15_000);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    for (const id of [...this.holdRetry.keys()]) this.cancelRetry(id, true);
    this.unsubscribe?.();
    for (const id of [...this.views.keys()]) void this.drop(id);
    await Promise.all([...this.closing]);
    await this.pulls;
  }

  /**
   * This node's client host on its link to the peer, when it holds one (the peer is online and its stream opened): a
   * reconnect replaces it, so callers take what they need from it fresh for each step.
   */
  hostFor(peerId: string): Host | undefined {
    return this.views.get(peerId)?.host ?? undefined;
  }

  /** `hostFor` with the signal that aborts when this view of the peer is dropped (the peer went offline). */
  viewFor(peerId: string): { host: Host; signal: AbortSignal } | undefined {
    const view = this.views.get(peerId);
    return view?.host ? { host: view.host, signal: view.abort.signal } : undefined;
  }

  /**
   * Records this node's current summary and address in its own row, and a report of each connection it holds (now,
   * at the address it sees the peer at) in that peer's row, then tells the node.
   */
  async refreshSelf(): Promise<void> {
    const { store, net, selfId } = this.deps;
    const now = new Date().toISOString();
    store.seen(selfId, now, await this.deps.summary(), fromEndpoint(net.endpoint));
    await this.reportLinks(net.online(), now);
    this.deps.onChange();
  }

  /** Reports this node's connection with each of `ids` at `at` (default now), at the address it sees each at. */
  async reportLinks(ids: string[], at: string = new Date().toISOString()): Promise<boolean> {
    const { store, net } = this.deps;
    let changed = false;
    for (const id of ids) {
      const addr = await remoteAddrOf(net.endpoint, id).catch(() => null);
      if (net.isOnline(id) && store.reached(id, at, addr)) changed = true;
    }
    return changed;
  }

  private refreshInBackground(): void {
    this.refreshSelf().catch((err: unknown) => this.report(err));
    try {
      this.retryPulls();
    } catch (err) {
      // A database or file error here must not escape the timer; the next refresh tries again.
      const message = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim();
      (this.deps.log ?? ((line: string) => console.error(line)))(`meddle: tokens: retrying value pulls failed: ${message}`);
    }
  }

  /**
   * Asks again for every token value this node lists (not removed) and lacks, once per id per refresh, from one online
   * peer whose rows list it (each refresh the next such peer): a pull that failed, or found its holder unreachable,
   * is not left waiting for a row to change.
   */
  private retryPulls(): void {
    if (this.stopped) return;
    const round = this.retries++;
    for (const t of listTokens(this.deps.db)) {
      if (this.retrying.has(t.id) || hasTokenValue(this.deps.cfg, t.id)) continue;
      const holders = [...this.views.entries()].filter(([, v]) => v.fetchToken !== null && v.tokenIds.has(t.id));
      if (holders.length === 0) continue;
      const [peerId, view] = holders[round % holders.length]!;
      const fetch = view.fetchToken!;
      const current = () => !this.stopped && this.views.get(peerId) === view;
      this.retrying.add(t.id);
      this.serially(async () => {
        this.retrying.delete(t.id);
        await this.pull(t.id, () => fetch(t.id), current);
      }, current);
    }
  }

  private report(err: unknown): void {
    if (!this.stopped) this.deps.onError?.(err);
  }

  /** Starts holding the peer's PoolObject, replacing any view of it held before. */
  private hold(id: string): void {
    if (this.stopped) return;
    this.cancelRetry(id, false);
    void this.drop(id);
    const view: PeerView = { host: null, abort: new AbortController(), tokenIds: new Set(), fetchToken: null };
    this.views.set(id, view);
    void this.attach(id, view);
  }

  /**
   * Opens a `chord` stream to the peer and holds its PoolObject. A failure is reported (unless the connection it rode
   * on closed: the net then says the peer went, and holding starts again when it is back) and tried again while the
   * peer stays online, after 1 s doubling to 30 s: a peer that was not serving its PoolObject yet (it is still
   * starting) is held once it does, without waiting for the connection to drop.
   */
  private async attach(id: string, view: PeerView): Promise<void> {
    const current = () => !this.stopped && this.views.get(id) === view;
    let closed: Promise<string> | null = null;
    try {
      const stream = await this.deps.net.openStream(id, { stream: "chord" });
      closed = stream.closed;
      const link = new IrohLink(stream, this.deps.tap ? { tap: this.deps.tap } : {});
      if (!current()) {
        link.close("bye");
        return;
      }
      // Until the reference is held, a closed link fails the hold instead of leaving it waiting for a reconnect.
      link.onClose((reason) => view.abort.abort(new Error(`chord link to ${shortId(id)} closed: ${reason}`)));
      view.host = createHost({
        name: `peer-view:${shortId(id)}`,
        self: "node",
        kind: "client",
        upstream: { link, principal: `${PEER_PRINCIPAL_PREFIX}${id}` },
        onError: (err) => this.report(err),
      });
      const pool = await view.host.get(PoolObject, {}, { signal: view.abort.signal });
      if (!current()) return;
      if (pool.variant !== "peer") throw new Error(`${shortId(id)} did not serve the peer variant of PoolObject`);
      pool.roster.subscribe((rows) => {
        if (current() && this.deps.store.merge([...rows])) this.deps.onChange();
      });
      pool.settings.subscribe((rows) => {
        if (!current() || !this.deps.settings.merge([...rows])) return;
        this.deps.settings.apply();
        this.deps.onChange();
      });
      // A call in flight when the view is dropped is not settled by closing its client host: the drop's abort ends it,
      // so that one gone peer cannot hold up the chain (and `stop()`).
      view.fetchToken = (tokenId) => unlessAborted(pool.fetchToken({ id: tokenId }), view.abort.signal);
      // Held: a later failure backs off from the start again.
      this.holdRetry.delete(id);
      pool.tokens.subscribe((rows) => {
        if (!current()) return;
        view.tokenIds = new Set(rows.filter((r) => !r.removed).map((r) => r.id));
        const merged = mergeTokens(this.deps.cfg, this.deps.db, rows);
        for (const id of merged.rejected) this.logRejected(id);
        for (const id of merged.removedValues) this.serially(() => this.dropValue(id), current);
        for (const id of merged.missingValues) this.serially(() => this.pull(id, () => view.fetchToken!(id), current), current);
        if (merged.changed) this.deps.onChange();
      });
    } catch (err) {
      if (!current()) return;
      // The connection the stream rode on closed (the peer went, or a connection that wins replaced it): the net says
      // so, and the hold starts again on the next connection. Nothing failed that is this node's to report.
      if (closed !== null && (await settlesWithin(closed, 250))) {
        if (current()) {
          await this.drop(id);
          this.retryHold(id);
        }
        return;
      }
      if (!current()) return;
      this.report(new HoldFailed(id, `holding the pool of ${shortId(id)}: ${messageOf(view.abort.signal.reason ?? err)}`));
      await this.drop(id);
      this.retryHold(id);
    }
  }

  /** Holds the peer again after the wait its failures have earned, if it is still online and not held by then. */
  private retryHold(id: string): void {
    if (this.stopped) return;
    const first = this.deps.holdRetryMs ?? 1000;
    const entry = this.holdRetry.get(id) ?? { waitMs: first, timer: null };
    if (entry.timer !== null) return;
    const wait = entry.waitMs;
    entry.waitMs = Math.min(wait * 2, HOLD_RETRY_MAX_MS);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      if (!this.stopped && this.deps.net.isOnline(id) && !this.views.has(id)) this.hold(id);
    }, wait);
    entry.timer.unref?.();
    this.holdRetry.set(id, entry);
  }

  /** Cancels a pending retry of holding the peer; `reset` also forgets its backoff. */
  private cancelRetry(id: string, reset: boolean): void {
    const entry = this.holdRetry.get(id);
    if (entry === undefined) return;
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.timer = null;
    if (reset) this.holdRetry.delete(id);
  }

  /** Runs `step` after the pulls and deletions before it; its failure is reported while the view is current. */
  private serially(step: () => Promise<void>, current: () => boolean): void {
    this.pulls = this.pulls.then(step).catch((err: unknown) => { if (current()) this.report(err); });
  }

  /** Whether token `id` is listed here, not removed, and its value is not here yet. */
  private async wanted(id: string): Promise<boolean> {
    const row = tokenRow(this.deps.db, id);
    return row !== null && !row.removed && (await tokenValue(this.deps.cfg, id)) === null;
  }

  /**
   * Fetches token `id`'s value from the peer and stores it, when this node still lists it and lacks it (checked again
   * after the fetch). A value that is not the one the id names is refused.
   */
  private async pull(id: string, fetch: () => Promise<{ value: string }>, current: () => boolean): Promise<void> {
    if (!current() || !(await this.wanted(id))) return;
    const { value } = await fetch();
    if (!current() || !(await this.wanted(id))) return;
    if (tokenId(value) !== id) throw new Error(`a peer answered token ${id} with a value of another id`);
    await writeTokenValue(this.deps.cfg, id, value.trim());
    // Removed here (by the CLI) while the value was being written: it does not stay.
    if (tokenRow(this.deps.db, id)?.removed !== false) await deleteTokenValue(this.deps.cfg, id);
    this.deps.onChange();
  }

  /** Deletes token `id`'s value, when the token is still removed here. */
  private async dropValue(id: string): Promise<void> {
    if (tokenRow(this.deps.db, id)?.removed !== true) return;
    await deleteTokenValue(this.deps.cfg, id);
    this.deps.onChange();
  }

  private logRejected(id: string): void {
    const key = id.slice(0, 80);
    if (this.rejectedLogged.has(key) || this.rejectedLogged.size >= MAX_LOGGED_REJECTIONS) return;
    this.rejectedLogged.add(key);
    (this.deps.log ?? ((line: string) => console.error(line)))(`meddle: tokens: ignored replicated token ${JSON.stringify(key)}`);
  }

  /** Forgets the peer's view at once, ends its calls in flight and closes its client host, if it has one yet. */
  private async drop(id: string): Promise<void> {
    const view = this.views.get(id);
    if (!view) return;
    this.views.delete(id);
    view.abort.abort(new Error(`stopped holding the pool of ${shortId(id)}`));
    if (view.host === null) return;
    const closed = view.host.close().catch((err: unknown) => this.report(err));
    this.closing.add(closed);
    await closed;
    this.closing.delete(closed);
  }
}

/**
 * Accepts every `chord` stream a member opens as a client link on `host` acting as `peer:<peerId>` (a non-member's is
 * reset), and takes no other kind. Returns the unsubscribe.
 */
export function acceptPeerLinks(net: PoolNet, host: Host, isMember: (id: string) => boolean): () => void {
  return net.onStream((s) => {
    if (s.header.stream !== "chord") return false;
    if (!isMember(s.peerId)) {
      void s.stream.send.reset(0n).catch(() => {});
      void s.stream.recv.stop(0n).catch(() => {});
      return true;
    }
    host.accept(new IrohLink(s), { principal: `${PEER_PRINCIPAL_PREFIX}${s.peerId}`, kind: "client" });
    return true;
  });
}
