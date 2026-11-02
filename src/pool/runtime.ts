// The pool runtime: this node's identity, endpoint, roster, peer connections, sync and discovery, composed, with
// membership enforced after every roster change.
import { hostname } from "node:os";
import type { Database } from "bun:sqlite";
import type { Endpoint } from "@number0/iroh";
import type { AnyContract, InputOf, Ref, Subscribable } from "@earendil-works/chord";
import type { NodeConfig } from "../config";
import { Discovery } from "./discovery";
import { loadOrCreateIdentity, shortId, type Identity } from "./identity";
import { createInvite, decodeTicket, handleJoin, joinPool } from "./invite";
import { DialFailed, PeerClosed, PoolNet, fromEndpoint, openEndpoint, type RefusalReason } from "./net";
import type { PoolObjectDeps } from "./object";
import { dedupe } from "./report";
import { PoolSettings, discoveryLighthouseUrl } from "./settings";
import { PoolStore, type NodeSummary, type WireAddr } from "./store";
import { HoldFailed, PoolSync } from "./sync";

export type PoolRuntime = {
  readonly identity: Identity;
  readonly store: PoolStore;
  readonly net: PoolNet;
  readonly endpoint: Endpoint;
  /** The pool's settings, applied to `cfg.poolEnv` at start and after every change. */
  readonly settings: PoolSettings;
  /** What `servePool` needs; `createNodeHost` passes it on. */
  readonly objectDeps: PoolObjectDeps;
  /** A new invite ticket; throws "this node is not a member of a pool" once this node was removed. */
  invite(): string;
  join(ticket: string): Promise<{ poolId: string; members: number }>;
  /** Removes a node from the pool and cuts it off; rejects "a node cannot remove itself". */
  remove(nodeId: string): Promise<void>;
  /** The token file changed on this node: tell the pool. */
  tokenChanged(): Promise<void>;
  /** Sets a pool setting here (rejects what `PoolSettings.set` refuses), applies it and tells the pool. */
  setSetting(key: string, value: string): Promise<void>;
  /** Unsets a pool setting here, applies it and tells the pool. */
  unsetSetting(key: string): Promise<void>;
  /**
   * This node's summary changed (a task was created): tell the pool now rather than at the next periodic refresh.
   * Never rejects.
   */
  refresh(): Promise<void>;
  /** Fires whenever the roster, a peer's online state, the token or the settings changed. Returns the unsubscribe. */
  onChange(cb: () => void): () => void;
  /**
   * A reference to `contract` (input `{}`) on the peer, over this node's client host for it; rejects
   * `not connected to <shortId>` when there is none. The caller releases it when done.
   */
  peerRef<C extends AnyContract>(nodeId: string, contract: C): Promise<Ref<C>>;
  stop(): Promise<void>;
};

/** What this node reports about itself, apart from its hostname. */
export type PoolSummaryDeps = { version: string; claudeCodeVersion: string; hostsTasks(): Promise<boolean>; taskCount(): number };

/**
 * Optional (tests): `onError` sees every error the net and the sync report, after the runtime acted on it; `log` gets
 * the runtime's log lines instead of `console.error`.
 */
export type PoolHooks = { onError?(err: unknown): void; log?(line: string): void };

/** How long `remove` waits for the removed node to see its removal and close its connection before cutting it off. */
const REMOVAL_GRACE_MS = 1000;
/**
 * What `closed()` resolves to when a peer closed or refused this node as removed at the captured `updatedAt`, an ISO
 * time as the store writes it: anything else (`removed zzz`) is not a removal this node can date, and is ignored.
 */
const REMOVED_AT = /^closed by peer: removed (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) \(code 1\)$/;

/**
 * Starts this node's part in its pool (a pool of one on first start): identity, endpoint, roster, settings (applied to
 * `cfg.poolEnv` before anything runs), the connection to every member, sync, and lighthouse discovery unless
 * `cfg.lighthouseUrl` is empty (the pool's `lighthouse.url` applies live unless `MEDDLE_LIGHTHOUSE_URL` is set). Logs (`meddle: discovery: …`
 * and `meddle: pool: …`, each distinct message at most once a minute) discovery errors and why a member cannot be
 * reached: dial failures, admission timeouts, refusals that persist, a removal learned from a refusal, and a peer's
 * PoolObject that could not be held. A healthy pool logs nothing.
 */
export async function startPool(cfg: NodeConfig, db: Database, summary: PoolSummaryDeps, hooks: PoolHooks = {}): Promise<PoolRuntime> {
  const identity = await loadOrCreateIdentity(cfg);
  const selfId = identity.id;
  const endpoint = await openEndpoint(cfg, identity);
  const store = new PoolStore(db);
  const liveSummary = async (): Promise<NodeSummary> => ({
    hostname: hostname(),
    version: summary.version,
    claudeCodeVersion: summary.claudeCodeVersion,
    hostsTasks: await summary.hostsTasks(),
    taskCount: summary.taskCount(),
  });
  try {
    store.ensurePool({ nodeId: selfId, hostname: hostname() });
    store.seen(selfId, new Date().toISOString(), await liveSummary(), fromEndpoint(endpoint));
  } catch (err) {
    await endpoint.close();
    throw err;
  }

  let stopped = false;
  const log = hooks.log ?? ((line: string) => console.error(line));
  const settings = new PoolSettings(db, cfg, selfId, log);
  settings.apply();
  /** A connection diagnostic, each distinct message at most once a minute. */
  const diagnose = dedupe((message) => { if (!stopped) log(`meddle: pool: ${message}`); });
  /** Consecutive code-1 closes and refusals from each member since it was last online (or a dial to it failed). */
  const refusals = new Map<string, number>();

  const listeners = new Set<() => void>();
  const notify = () => {
    for (const cb of [...listeners]) {
      try {
        cb();
      } catch {
        // A listener's failure is its own; the others still hear of the change.
      }
    }
  };
  const onChange = (cb: () => void) => {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
  };

  /** The members this node keeps a connection with, and the address it last offered for each. */
  const followed = new Map<string, string | null>();
  let leftPool = false;
  let discovery: Discovery | null = null;

  /** A removed node accepts no pool connection at all. */
  const admits = (id: string) => store.isMember(selfId) && store.isMember(id);
  /** `removed <updatedAt>` for a node the roster has as removed: the refused node can tell how recent that is. */
  const removalOf = (id: string): RefusalReason | null => {
    const row = store.row(id);
    return row?.status === "removed" ? `removed ${row.updatedAt}` : null;
  };
  /** A dialer this (member) node has as removed is told so; it learns its removal from that refusal. */
  const refusalReason = (id: string): RefusalReason => (store.isMember(selfId) ? removalOf(id) : null) ?? "not a member";

  const net = new PoolNet({
    endpoint, selfId, isMember: admits, refusalReason,
    onJoin: (conn) => handleJoin(conn, {
      store, selfId, cfg, endpoint,
      // The new member's row (with the address it joined from) is in the roster now: follow it.
      onAdmitted: () => {
        enforce();
        notify();
      },
    }),
    onError: (err) => {
      if (err instanceof PeerClosed) refused(err);
      else if (err instanceof DialFailed) {
        // A failed dial breaks a run of refusals: the next one starts counting again.
        refusals.delete(err.peerId);
        diagnose(err.message);
      }
      hooks.onError?.(err);
    },
  });
  net.onPeer((id, online) => {
    if (online) refusals.delete(id);
    notify();
  });

  /**
   * A member closed or refused this node's connection with code 1. A removal newer than this node's join makes it
   * leave. Any other refusal is logged once it persists past a redial: the first may come from a member that has not
   * yet heard of this node's join. One from a node this roster does not have as a member is not logged at all.
   */
  function refused(err: PeerClosed): void {
    if (learnRemoval(err) || !store.isMember(err.peerId)) return;
    const count = (refusals.get(err.peerId) ?? 0) + 1;
    refusals.set(err.peerId, count);
    if (count >= 2) diagnose(err.message);
  }

  /**
   * Another member closed or refused this node as removed: this node was removed while it could not hear of it. Only
   * a removal newer than this node's own row (its latest join) counts; an older one is a member that has not yet
   * merged this node's re-join, and the refused dial is simply retried. True when this node learned its removal.
   */
  function learnRemoval(err: PeerClosed): boolean {
    const removedAt = REMOVED_AT.exec(err.reason)?.[1];
    const self = store.row(selfId);
    if (removedAt === undefined || self?.status !== "member" || !store.isMember(err.peerId)) return false;
    if (!(removedAt > self.updatedAt)) return false;
    store.remove(selfId, removedAt);
    diagnose(`${shortId(err.peerId)} says this node was removed from the pool at ${removedAt}; it has left the pool`);
    enforce();
    notify();
    return true;
  }

  const sync = new PoolSync({
    cfg, store, net, selfId, settings, summary: liveSummary,
    onChange: () => {
      enforce();
      notify();
    },
    onError: (err) => {
      if (err instanceof HoldFailed) diagnose(err.message);
      hooks.onError?.(err);
    },
  });

  /**
   * Makes the connections follow the roster: every member (other than this node) is watched and offered its latest
   * known address; every other node is cut off (`removed`, or `not a member` when it is not in the roster at all).
   * When this node itself is not a member it leaves: every connection is closed (`bye`) and discovery stops.
   */
  function enforce(): void {
    if (stopped) return;
    const member = store.isMember(selfId);
    const rows = store.roster();
    const keep = new Map(member ? rows.filter((r) => r.status === "member" && r.nodeId !== selfId).map((r) => [r.nodeId, r]) : []);
    const cut = new Set([...followed.keys(), ...net.online(), ...rows.filter((r) => r.status !== "member").map((r) => r.nodeId)]);
    for (const id of cut) {
      if (id === selfId || keep.has(id)) continue;
      followed.delete(id);
      net.unwatch(id, !member ? "bye" : removalOf(id) ?? "not a member");
    }
    for (const [id, row] of keep) {
      const addr = row.lastAddr === null ? null : JSON.stringify(row.lastAddr);
      // The address goes first, so that the first dial to a newly watched member already has it.
      if (row.lastAddr !== null && followed.get(id) !== addr) net.offerAddress(row.lastAddr);
      if (!followed.has(id)) net.watch(id);
      followed.set(id, addr ?? followed.get(id) ?? null);
    }
    if (!member && !leftPool) {
      leftPool = true;
      discovery?.stop().catch(() => {});
    }
  }

  if (cfg.lighthouseUrl !== "") {
    discovery = new Discovery({
      endpoint, identity, pool: store.pool(),
      lighthouseUrl: () => discoveryLighthouseUrl(cfg, settings),
      pollMs: cfg.discoveryPollMs,
      onPeers: (peers: WireAddr[]) => {
        if (!store.isMember(selfId)) return;
        for (const p of peers) if (p.id !== selfId && store.isMember(p.id)) net.offerAddress(p);
      },
      onError: (message) => { if (!stopped) log(`meddle: discovery: ${message}`); },
    });
  }

  /** Resolves once `id` is offline, or after `ms`. */
  function offline(id: string, ms: number): Promise<void> {
    if (!net.isOnline(id)) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        off();
        resolve();
      };
      const timer = setTimeout(done, ms);
      const off = net.onPeer((peer, online) => { if (peer === id && !online) done(); });
    });
  }

  enforce();
  net.start();
  sync.start();
  if (!leftPool) discovery?.start();

  /** A ticket into this node's pool; a node removed from its pool has none to give. */
  const invite = () => {
    if (!store.isMember(selfId)) throw new Error("this node is not a member of a pool");
    return createInvite(store, endpoint);
  };

  async function join(ticket: string): Promise<{ poolId: string; members: number }> {
    const joined = await joinPool(decodeTicket(ticket), { endpoint, store, identity, summary: liveSummary });
    // Joining dropped the old pool's settings; the new pool's arrive by sync.
    settings.apply();
    leftPool = false;
    if (discovery !== null) await discovery.restart(store.pool());
    // The addresses first (offering one does not dial a node not yet watched), so the first dials have them.
    for (const addr of joined.addrs) net.offerAddress(addr);
    enforce();
    notify();
    // The admitting node recorded this one as hosting no tasks (it cannot tell); the pool hears the truth now, not at
    // the next periodic refresh: a move to this node is refused until then.
    await refresh();
    return { poolId: joined.poolId, members: joined.members };
  }

  async function remove(nodeId: string): Promise<void> {
    if (nodeId === selfId) throw new Error("a node cannot remove itself");
    if (store.row(nodeId) === null) throw new Error(`${shortId(nodeId)} is not in this pool`);
    store.remove(nodeId);
    // The removal goes out first (the removed node holds this node's PoolObject and sees itself removed) ...
    notify();
    await offline(nodeId, REMOVAL_GRACE_MS);
    // ... and the connection is cut once it closed it, or after the grace period.
    enforce();
  }

  async function tokenChanged(): Promise<void> {
    // Refreshing the self row tells the pool: the `token` cells re-read the token's metadata on the change.
    await sync.refreshSelf();
    notify();
  }

  /** A local change to the settings: applied here, then the `settings` cells re-read them and peers merge them. */
  async function settingsChanged(): Promise<void> {
    settings.apply();
    await sync.refreshSelf();
    notify();
  }

  async function setSetting(key: string, value: string): Promise<void> {
    settings.set(key, value);
    await settingsChanged();
  }

  async function unsetSetting(key: string): Promise<void> {
    settings.unset(key);
    await settingsChanged();
  }

  async function refresh(): Promise<void> {
    if (stopped) return;
    await sync.refreshSelf().catch((err: unknown) => { if (!stopped) hooks.onError?.(err); });
  }

  const changes: Subscribable<null> = { subscribe: (cb) => onChange(() => cb(null)) };

  async function peerRef<C extends AnyContract>(nodeId: string, contract: C): Promise<Ref<C>> {
    const view = sync.viewFor(nodeId);
    if (view === undefined) throw new Error(`not connected to ${shortId(nodeId)}`);
    // A peer that drops while the reference is being taken fails it at once, not after chord's ready timeout.
    return view.host.get(contract, {} as InputOf<C>, { signal: view.signal });
  }

  return {
    identity, store, net, endpoint, settings,
    objectDeps: {
      store, cfg, selfId, settings,
      isOnline: (id) => net.isOnline(id),
      liveSummary,
      invite,
      join,
      remove,
      tokenChanged,
      setSetting,
      unsetSetting,
      changes,
    },
    invite,
    join,
    remove,
    tokenChanged,
    setSetting,
    unsetSetting,
    refresh,
    onChange,
    peerRef,
    async stop() {
      if (stopped) return;
      stopped = true;
      // Nobody hears of the connections closing below: the node is shutting down.
      listeners.clear();
      await sync.stop();
      await discovery?.stop();
      await net.stop();
    },
  };
}
