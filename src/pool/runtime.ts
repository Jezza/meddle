// The pool runtime: this node's identity, endpoint, pool secret, roster, peer connections, sync and discovery,
// composed, with membership enforced after every roster change.
import { hostname } from "node:os";
import type { Database } from "bun:sqlite";
import type { Endpoint } from "@number0/iroh";
import type { AnyContract, InputOf, Ref, Subscribable } from "@earendil-works/chord";
import type { NodeConfig } from "../config";
import { Discovery } from "./discovery";
import { loadOrCreateIdentity, shortId, type Identity } from "./identity";
import { DialFailed, PeerClosed, PoolNet, fromEndpoint, openEndpoint, type RefusalReason } from "./net";
import type { PoolObjectDeps } from "./object";
import { dedupe } from "./report";
import { poolKey, proofFor, verifyProof, type PoolKey } from "./secret";
import { PoolSettings, discoveryLighthouseUrl } from "./settings";
import { PoolStore, type NodeProject, type NodeSummary, type PoolIdentity, type WireAddr } from "./store";
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
  /**
   * The pool row or the roster changed under this node (the CLI set the secret, or added a peer): re-reads them. A new
   * secret re-keys the node: every connection is closed (every peer must prove the new secret), the roster is what the
   * CLI left (this node alone) and discovery moves to the new topic. Never rejects.
   */
  poolChanged(): Promise<void>;
  /**
   * Records `addr`'s node as a member here (unless it is removed: rejects) and dials it when this node is the one to
   * dial: the way in without a lighthouse.
   */
  addPeer(addr: WireAddr): Promise<void>;
  /** Removes a node from the pool and cuts it off; rejects "a node cannot remove itself". */
  remove(nodeId: string): Promise<void>;
  /** Makes a removed node a member again and tells the pool; rejects for this node, or one not in the roster. */
  allow(nodeId: string): Promise<void>;
  /** The tokens changed on this node (the CLI wrote them, or a turn marked one): tell the pool. */
  tokenChanged(): Promise<void>;
  /** Sets a pool setting here (rejects what `PoolSettings.set` refuses), applies it and tells the pool. */
  setSetting(key: string, value: string): Promise<void>;
  /** Unsets a pool setting here, applies it and tells the pool. */
  unsetSetting(key: string): Promise<void>;
  /**
   * This node's summary changed (a task was created, started or ended, a project added): tell the pool now rather than
   * at the next periodic refresh.
   * Never rejects.
   */
  refresh(): Promise<void>;
  /**
   * Fires whenever the roster, a peer's online state, the tokens or the settings changed, and on each self refresh.
   * Returns the unsubscribe.
   */
  onChange(cb: () => void): () => void;
  /**
   * A reference to `contract` (input `{}`) on the peer, over this node's client host for it; rejects
   * `not connected to <shortId>` when there is none. The caller releases it when done.
   */
  peerRef<C extends AnyContract>(nodeId: string, contract: C): Promise<Ref<C>>;
  stop(): Promise<void>;
};

/**
 * What this node reports about itself, apart from its hostname and its running limit (the pool settings'): `running`
 * counts its tasks in state `running` or `waiting`, `projects` lists every project it holds.
 */
export type PoolSummaryDeps = {
  version: string; claudeCodeVersion: string; hostsTasks(): Promise<boolean>; taskCount(): number;
  running(): number; projects(): NodeProject[];
};

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
/** How far ahead of this node's clock a removal's time may be and still count: beyond that it is not a date but a weapon. */
const MAX_REMOVAL_AHEAD_MS = 5 * 60_000;

/** The pool's key, or null while no secret is set. */
function keyOf(pool: PoolIdentity): PoolKey | null {
  return pool.poolSecret === "" ? null : poolKey(pool.poolName, pool.poolSecret);
}

/**
 * Starts this node's part in its pool: identity, endpoint, settings (applied to `cfg.poolEnv` before anything runs),
 * the pool secret (set with `meddle pool secret`; until then the node is alone: it dials nobody and admits nobody),
 * the connection to every member and to every node the lighthouse lists on the pool's topic (each proves the secret
 * to the other before it counts), sync, and lighthouse discovery unless `cfg.lighthouseUrl` is empty (the pool's
 * `lighthouse.url` applies live unless `MEDDLE_LIGHTHOUSE_URL` is set). Logs (`meddle: discovery: …` and
 * `meddle: pool: …`, each distinct message at most once a minute) discovery errors and why a member cannot be reached:
 * dial failures, admission timeouts, a peer that did not prove the secret, refusals that persist, a removal learned
 * from a refusal, and a peer's PoolObject that could not be held. A healthy pool logs nothing.
 */
export async function startPool(cfg: NodeConfig, db: Database, summary: PoolSummaryDeps, hooks: PoolHooks = {}): Promise<PoolRuntime> {
  const identity = await loadOrCreateIdentity(cfg);
  const selfId = identity.id;
  const endpoint = await openEndpoint(cfg, identity);
  const store = new PoolStore(db);
  let stopped = false;
  const log = hooks.log ?? ((line: string) => console.error(line));
  const settings = new PoolSettings(db, cfg, selfId, log);
  settings.apply();
  const liveSummary = async (): Promise<NodeSummary> => ({
    hostname: hostname(),
    version: summary.version,
    claudeCodeVersion: summary.claudeCodeVersion,
    hostsTasks: await summary.hostsTasks(),
    taskCount: summary.taskCount(),
    running: summary.running(),
    limit: settings.runningLimit(),
    projects: summary.projects(),
  });
  let key: PoolKey | null;
  try {
    key = keyOf(store.ensurePool({ nodeId: selfId, hostname: hostname() }));
    store.seen(selfId, new Date().toISOString(), await liveSummary(), fromEndpoint(endpoint));
  } catch (err) {
    await endpoint.close();
    throw err;
  }

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
  /** Nodes the lighthouse lists on the pool's topic that are not members here yet: dialled so that they prove the secret. */
  const discovered = new Set<string>();
  /** Whether this node counted itself a member at the last `enforce`: the moment that changes, it drops its connections. */
  let wasMember = store.isMember(selfId);
  let discovery: Discovery | null = null;

  /** `removed <updatedAt>` for a node the roster has as removed: the refused node can tell how recent that is. */
  const removalOf = (id: string): RefusalReason | null => {
    const row = store.row(id);
    return row?.status === "removed" ? `removed ${row.updatedAt}` : null;
  };
  /**
   * A dialer that proved the secret is let in unless this roster has it as removed; one never heard of becomes a
   * member here (its own row replaces the provisional one at the first sync). A node removed from the pool still admits
   * a member that dials it: that member's roster has it allowed again, and the sync over that connection is how it
   * learns so.
   */
  const admits = (id: string): boolean => key !== null && store.ensureMember(id, selfId) === "member";
  /** A dialer this node has as removed is told so; it learns its removal from that refusal. */
  const refusalReason = (id: string): RefusalReason => (key === null ? "no pool secret" : removalOf(id) ?? "not a member");

  const net = new PoolNet({
    endpoint, selfId,
    prove: (peer) => (key === null ? null : proofFor(key, selfId, peer)),
    verify: (peer, proof) => key !== null && verifyProof(key.id, peer, selfId, proof),
    admit: admits,
    refusalReason,
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
    if (online) {
      refusals.delete(id);
      // A node this node dialled on the lighthouse's word proved the secret: it is a member here from now on.
      if (key !== null) store.ensureMember(id, selfId);
      enforce();
    }
    notify();
  });

  /**
   * A member closed or refused this node's connection with code 1. A removal newer than this node's row makes it
   * leave. Any other refusal is logged once it persists past a redial: the first may come from a member that has not
   * yet heard of this node. One from a node this roster does not have as a member is not logged at all, nor any
   * while this node knows itself removed: it keeps knocking (see `enforce`), and the members refuse it by design.
   */
  function refused(err: PeerClosed): void {
    if (learnRemoval(err) || !store.isMember(err.peerId) || !store.isMember(selfId)) return;
    const count = (refusals.get(err.peerId) ?? 0) + 1;
    refusals.set(err.peerId, count);
    if (count >= 2) diagnose(err.message);
  }

  /**
   * Another member (one that proved the secret: a `PeerClosed` comes from no other) closed or refused this node as
   * removed: this node was removed while it could not hear of it. Only a removal newer than this node's own row
   * counts, and none dated more than five minutes ahead of this node's clock; an older one is a member that has not
   * yet merged this node's being allowed again, and the refused dial is simply retried. True when this node learned
   * its removal.
   */
  function learnRemoval(err: PeerClosed): boolean {
    const removedAt = REMOVED_AT.exec(err.reason)?.[1];
    const self = store.row(selfId);
    if (removedAt === undefined || self?.status !== "member" || !store.isMember(err.peerId)) return false;
    if (!(removedAt > self.updatedAt) || removedAt > new Date(Date.now() + MAX_REMOVAL_AHEAD_MS).toISOString()) return false;
    store.remove(selfId, removedAt);
    diagnose(`${shortId(err.peerId)} says this node was removed from the pool at ${removedAt}; it has left the pool`);
    enforce();
    notify();
    return true;
  }

  const sync = new PoolSync({
    cfg, db, store, net, selfId, settings, summary: liveSummary, log,
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
   * known address; a member no longer (removed, or gone with a new secret) is cut off, with `removed <updatedAt>`
   * when this roster has it removed. A node that knows itself removed keeps watching the members all the same: they
   * refuse it (quietly, see `refused`) until one allows it again, and that member's admission is how it learns so
   * without a restart. Without a secret nothing is watched.
   */
  function enforce(): void {
    if (stopped) return;
    const rows = store.roster();
    const keep = new Map(key !== null ? rows.filter((r) => r.status === "member" && r.nodeId !== selfId).map((r) => [r.nodeId, r]) : []);
    for (const id of [...followed.keys()]) {
      if (keep.has(id)) continue;
      followed.delete(id);
      net.unwatch(id, removalOf(id) ?? "bye");
    }
    const member = store.isMember(selfId);
    if (wasMember && !member) {
      // Just learnt of its removal: it leaves every member now (they would cut it anyway), then knocks again.
      for (const id of [...followed.keys()]) {
        followed.delete(id);
        net.unwatch(id, "bye");
      }
    }
    wasMember = member;
    if (key === null) {
      for (const id of discovered) net.unwatch(id, "bye");
      discovered.clear();
    }
    for (const row of rows) if (row.status === "removed" && row.nodeId !== selfId) net.unwatch(row.nodeId, `removed ${row.updatedAt}`);
    for (const [id, row] of keep) {
      const addr = row.lastAddr === null ? null : JSON.stringify(row.lastAddr);
      // The address goes first, so that the first dial to a newly watched member already has it.
      if (row.lastAddr !== null && followed.get(id) !== addr) net.offerAddress(row.lastAddr);
      if (!followed.has(id)) net.watch(id);
      followed.set(id, addr ?? followed.get(id) ?? null);
    }
  }

  /**
   * The nodes the lighthouse lists on the pool's topic: each gets its address offered, and one that is not a member
   * here yet is dialled (when this node dials it), so that the two prove the secret to each other; one that left the
   * topic before it proved anything is dropped again. A node this roster has as removed is left alone.
   */
  function onPeers(peers: WireAddr[]): void {
    if (stopped || key === null) return;
    const listed = new Set(peers.map((p) => p.id));
    for (const id of [...discovered]) {
      if (listed.has(id)) continue;
      discovered.delete(id);
      if (!followed.has(id)) net.unwatch(id, "bye");
    }
    for (const p of peers) {
      if (p.id === selfId || store.row(p.id)?.status === "removed") continue;
      // A connected member's address is the one that works; the lighthouse's word is for reaching the others.
      if (!net.isOnline(p.id)) net.offerAddress(p);
      if (followed.has(p.id) || discovered.has(p.id)) continue;
      discovered.add(p.id);
      net.watch(p.id);
    }
  }

  /** Starts discovery on the pool's topic, once there is a secret and a lighthouse to use. */
  function startDiscovery(): void {
    if (stopped || discovery !== null || key === null || cfg.lighthouseUrl === "") return;
    discovery = new Discovery({
      endpoint, identity, topic: key.topic,
      lighthouseUrl: () => discoveryLighthouseUrl(cfg, settings),
      pollMs: cfg.discoveryPollMs,
      onPeers,
      onError: (message) => { if (!stopped) log(`meddle: discovery: ${message}`); },
    });
    discovery.start();
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
  startDiscovery();

  async function poolChanged(): Promise<void> {
    if (stopped) return;
    const next = keyOf(store.pool());
    if ((next?.id ?? null) !== (key?.id ?? null)) {
      key = next;
      // Every connection goes: whoever is in the new pool proves its secret afresh.
      for (const id of new Set([...followed.keys(), ...discovered, ...net.online()])) net.unwatch(id, "bye");
      followed.clear();
      discovered.clear();
      refusals.clear();
      // The roster again, now that no old connection can merge the old pool's rows back into it.
      store.resetRoster({ nodeId: selfId, hostname: hostname() });
      if (key === null) {
        const old = discovery;
        discovery = null;
        await old?.stop();
      } else if (discovery !== null) {
        await discovery.restart(key.topic);
      } else {
        startDiscovery();
      }
    }
    enforce();
    notify();
    await refresh();
  }

  async function addPeer(addr: WireAddr): Promise<void> {
    if (addr.id === selfId) throw new Error("that is this node");
    if (store.ensureMember(addr.id, selfId, addr) === "removed") throw new Error(`${shortId(addr.id)} was removed from the pool; allow it first`);
    net.offerAddress(addr);
    enforce();
    notify();
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

  async function allow(nodeId: string): Promise<void> {
    if (nodeId === selfId) throw new Error("a node cannot allow itself");
    if (!store.allow(nodeId)) throw new Error(`${shortId(nodeId)} is not in this pool`);
    refusals.delete(nodeId);
    enforce();
    notify();
  }

  async function tokenChanged(): Promise<void> {
    // Refreshing the self row tells the pool: the `tokens` and `activeTokenId` cells re-read the tokens on the change.
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
      store, db, cfg, selfId, settings,
      isOnline: (id) => net.isOnline(id),
      liveSummary,
      poolChanged,
      remove,
      allow,
      tokenChanged,
      setSetting,
      unsetSetting,
      changes,
    },
    poolChanged,
    addPeer,
    remove,
    allow,
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
