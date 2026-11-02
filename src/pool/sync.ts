// Pool sync: each node holds every online peer's PoolObject (peer variant) over a chord link on iroh, merges the
// peer's roster and settings into its own and pulls the token when the peer's is newer.
import { createHost, type Host } from "@earendil-works/chord";
import type { NodeConfig } from "../config";
import { PoolObject, type TokenMeta } from "../state/contracts";
import { setToken, tokenStatus } from "../token";
import { shortId } from "./identity";
import { IrohLink, type LinkTap } from "./link";
import { fromEndpoint, type PoolNet } from "./net";
import { PEER_PRINCIPAL_PREFIX } from "./object";
import type { PoolSettings } from "./settings";
import type { NodeSummary, PoolStore } from "./store";

export type SyncDeps = {
  cfg: NodeConfig;
  store: PoolStore;
  net: PoolNet;
  selfId: string;
  /** The pool's settings: a peer's are merged in, then applied. */
  settings: PoolSettings;
  summary(): NodeSummary | Promise<NodeSummary>;
  /** The roster, the token or the settings changed because of a peer, or the self row was refreshed. */
  onChange(): void;
  onError?(err: unknown): void;
  /** Tests: every frame sent or received on every peer link. */
  tap?: LinkTap;
  /** Self-row refresh period, default 15000. */
  refreshMs?: number;
};

/** The peer's PoolObject as held over its link; `host` is this node's client host for that link. */
type PeerView = { host: Host | null; abort: AbortController };

/** Reported when this node could not hold a peer's PoolObject (it is tried again when the peer is next online). */
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

export class PoolSync {
  private readonly views = new Map<string, PeerView>();
  /** Client hosts being closed, so that `stop()` can wait for them. */
  private readonly closing = new Set<Promise<void>>();
  /** Token pulls, one at a time, so two peers' answers cannot interleave between the newer-check and the write. */
  private pulls: Promise<void> = Promise.resolve();
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
      else void this.drop(id);
    });
    for (const id of this.deps.net.online()) this.hold(id);
    this.refreshInBackground();
    this.timer = setInterval(() => this.refreshInBackground(), this.deps.refreshMs ?? 15_000);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
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

  /** Records this node's current summary and address in its own row, then tells the node. */
  async refreshSelf(): Promise<void> {
    const { store, net, selfId } = this.deps;
    store.seen(selfId, new Date().toISOString(), await this.deps.summary(), fromEndpoint(net.endpoint));
    this.deps.onChange();
  }

  private refreshInBackground(): void {
    this.refreshSelf().catch((err: unknown) => this.report(err));
  }

  private report(err: unknown): void {
    if (!this.stopped) this.deps.onError?.(err);
  }

  /** Starts holding the peer's PoolObject, replacing any view of it held before. */
  private hold(id: string): void {
    if (this.stopped) return;
    void this.drop(id);
    const view: PeerView = { host: null, abort: new AbortController() };
    this.views.set(id, view);
    void this.attach(id, view);
  }

  /** Opens a `chord` stream to the peer and holds its PoolObject; a failure is reported and retried when it is next online. */
  private async attach(id: string, view: PeerView): Promise<void> {
    const current = () => !this.stopped && this.views.get(id) === view;
    try {
      const stream = await this.deps.net.openStream(id, { stream: "chord" });
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
      pool.token.subscribe((meta) => {
        if (meta === null) return;
        // A call in flight when the view is dropped is not settled by closing its client host: the drop's abort ends
        // it, so that one gone peer cannot hold up the pull chain (and `stop()`).
        this.pulls = this.pulls
          .then(() => this.pull(meta, () => unlessAborted(pool.fetchToken({}), view.abort.signal), current))
          .catch((err: unknown) => { if (current()) this.report(err); });
      });
    } catch (err) {
      if (!current()) return;
      this.report(new HoldFailed(id, `holding the pool of ${shortId(id)}: ${messageOf(view.abort.signal.reason ?? err)}`));
      await this.drop(id);
    }
  }

  /** Fetches the peer's token and stores it, when it is newer than this node's (checked again after the fetch). */
  private async pull(
    meta: TokenMeta, fetch: () => Promise<{ value: string; setAt: string; setBy: string | null }>, current: () => boolean,
  ): Promise<void> {
    if (!current() || !(await this.isNewer(meta.setAt))) return;
    const got = await fetch();
    if (!current() || !(await this.isNewer(got.setAt))) return;
    await setToken(this.deps.cfg, got.value, { setAt: got.setAt, ...(got.setBy === null ? {} : { setBy: got.setBy }) });
    this.deps.onChange();
  }

  private async isNewer(setAt: string): Promise<boolean> {
    const local = await tokenStatus(this.deps.cfg);
    return !local.present || local.setAt === undefined || setAt > local.setAt;
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
