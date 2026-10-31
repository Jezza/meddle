// The pool runtime: this node's identity, endpoint, roster, peer connections, sync and discovery, composed, with
// membership enforced after every roster change.
import { hostname } from "node:os";
import type { Database } from "bun:sqlite";
import type { Endpoint } from "@number0/iroh";
import type { Subscribable } from "@earendil-works/chord";
import type { NodeConfig } from "../config";
import { Discovery } from "./discovery";
import { loadOrCreateIdentity, shortId, type Identity } from "./identity";
import { createInvite, decodeTicket, handleJoin, joinPool } from "./invite";
import { PeerClosed, PoolNet, fromEndpoint, openEndpoint, type RefusalReason } from "./net";
import type { PoolObjectDeps } from "./object";
import { PoolStore, type NodeSummary, type WireAddr } from "./store";
import { PoolSync } from "./sync";

export type PoolRuntime = {
  readonly identity: Identity;
  readonly store: PoolStore;
  readonly net: PoolNet;
  readonly endpoint: Endpoint;
  /** What `servePool` needs; `createNodeHost` passes it on. */
  readonly objectDeps: PoolObjectDeps;
  /** A new invite ticket; throws "this node is not a member of a pool" once this node was removed. */
  invite(): string;
  join(ticket: string): Promise<{ poolId: string; members: number }>;
  /** Removes a node from the pool and cuts it off; rejects "a node cannot remove itself". */
  remove(nodeId: string): Promise<void>;
  /** The token file changed on this node: tell the pool. */
  tokenChanged(): Promise<void>;
  /** Fires whenever the roster, a peer's online state or the token changed. Returns the unsubscribe. */
  onChange(cb: () => void): () => void;
  stop(): Promise<void>;
};

/** What this node reports about itself, apart from its hostname. */
export type PoolSummaryDeps = { version: string; claudeCodeVersion: string; hostsTasks(): Promise<boolean>; taskCount(): number };

/** Optional: `onError` sees every error the net and the sync report, after the runtime acted on it (tests). */
export type PoolHooks = { onError?(err: unknown): void };

/** How long `remove` waits for the removed node to see its removal and close its connection before cutting it off. */
const REMOVAL_GRACE_MS = 1000;
/**
 * What `closed()` resolves to when a peer closed or refused this node as removed at the captured `updatedAt`, an ISO
 * time as the store writes it: anything else (`removed zzz`) is not a removal this node can date, and is ignored.
 */
const REMOVED_AT = /^closed by peer: removed (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) \(code 1\)$/;

/**
 * Starts this node's part in its pool (a pool of one on first start): identity, endpoint, roster, the connection
 * to every member, sync, and lighthouse discovery unless `cfg.lighthouseUrl` is empty. Logs only discovery errors.
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
  let stopped = false;
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
      if (err instanceof PeerClosed) learnRemoval(err);
      hooks.onError?.(err);
    },
  });
  net.onPeer(() => notify());

  /**
   * Another member closed or refused this node as removed: this node was removed while it could not hear of it. Only
   * a removal newer than this node's own row (its latest join) counts; an older one is a member that has not yet
   * merged this node's re-join, and the refused dial is simply retried.
   */
  function learnRemoval(err: PeerClosed): void {
    const removedAt = REMOVED_AT.exec(err.reason)?.[1];
    const self = store.row(selfId);
    if (removedAt === undefined || self?.status !== "member" || !store.isMember(err.peerId)) return;
    if (!(removedAt > self.updatedAt)) return;
    store.remove(selfId, removedAt);
    enforce();
    notify();
  }

  const sync = new PoolSync({
    cfg, store, net, selfId, summary: liveSummary,
    onChange: () => {
      enforce();
      notify();
    },
    onError: (err) => hooks.onError?.(err),
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
      if (!followed.has(id)) {
        followed.set(id, null);
        net.watch(id);
      }
      const addr = row.lastAddr === null ? null : JSON.stringify(row.lastAddr);
      if (row.lastAddr !== null && followed.get(id) !== addr) {
        followed.set(id, addr);
        net.offerAddress(row.lastAddr);
      }
    }
    if (!member && !leftPool) {
      leftPool = true;
      discovery?.stop().catch(() => {});
    }
  }

  if (cfg.lighthouseUrl !== "") {
    discovery = new Discovery({
      endpoint, identity, pool: store.pool(),
      lighthouseUrl: () => cfg.lighthouseUrl,
      pollMs: cfg.discoveryPollMs,
      onPeers: (peers: WireAddr[]) => {
        if (!store.isMember(selfId)) return;
        for (const p of peers) if (p.id !== selfId && store.isMember(p.id)) net.offerAddress(p);
      },
      onError: (message) => console.error(`meddle: discovery: ${message}`),
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
    leftPool = false;
    if (discovery !== null) await discovery.restart(store.pool());
    enforce();
    for (const addr of joined.addrs) net.offerAddress(addr);
    notify();
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

  const changes: Subscribable<null> = { subscribe: (cb) => onChange(() => cb(null)) };

  return {
    identity, store, net, endpoint,
    objectDeps: {
      store, cfg, selfId,
      isOnline: (id) => net.isOnline(id),
      liveSummary,
      invite,
      join,
      remove,
      tokenChanged,
      changes,
    },
    invite,
    join,
    remove,
    tokenChanged,
    onChange,
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
