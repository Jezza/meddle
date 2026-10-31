// test/pool-helpers.ts — fixtures for tests of the pool transport.
import { mkdtemp, rm } from "node:fs/promises";
import type { Database } from "bun:sqlite";
import { SecretKey, type Connection, type Endpoint } from "@number0/iroh";
import { createHost, type Host, type Subscribable } from "@earendil-works/chord";
import { ensureDataDirs, loadConfig, paths, type NodeConfig } from "../src/config";
import { hexOf, shortId, type Identity } from "../src/pool/identity";
import type { LinkTap } from "../src/pool/link";
import { PoolNet, fromEndpoint, openEndpoint, toEndpointAddr } from "../src/pool/net";
import { servePool, type PoolObjectDeps } from "../src/pool/object";
import { PoolStore, type NodeSummary } from "../src/pool/store";
import { PoolSync, acceptPeerLinks } from "../src/pool/sync";
import { openDb } from "../src/store/db";

export type TestNode = { endpoint: Endpoint; identity: Identity };

function freshIdentity(): Identity {
  const key = SecretKey.generate();
  return { id: hexOf(key.public()), secret: Uint8Array.from(key.toBytes()) };
}

/** One endpoint with presetMinimal on 127.0.0.1:0 and a fresh identity. */
export async function testNode(): Promise<TestNode> {
  const identity = freshIdentity();
  return { endpoint: await openEndpoint({ irohPreset: "minimal", irohBind: "127.0.0.1:0" }, identity), identity };
}

/**
 * Two endpoints with presetMinimal on 127.0.0.1:0 and fresh identities. `connect(alpn)` dials b from a and accepts
 * on b, returning both ends; do not use it once something else runs b's accept loop.
 */
export async function endpointPair(): Promise<{
  a: TestNode; b: TestNode;
  connect(alpn: number[]): Promise<{ a: Connection; b: Connection }>;
  close(): Promise<void>;
}> {
  const a = await testNode();
  const b = await testNode();
  return {
    a, b,
    async connect(alpn) {
      const accepted = (async () => {
        const incoming = await b.endpoint.acceptNext();
        if (!incoming) throw new Error("b's endpoint is closed");
        return (await incoming.accept()).connect();
      })();
      const dialed = await a.endpoint.connect(toEndpointAddr(fromEndpoint(b.endpoint)), alpn);
      return { a: dialed, b: await accepted };
    },
    async close() {
      for (const n of [a, b]) if (!n.endpoint.isClosed()) await n.endpoint.close();
    },
  };
}

/** A frame line one node's sync links sent (`out`) or received (`in`). */
export type TappedFrame = { direction: "in" | "out"; text: string };

/** One pool node of `twoNodes`: its store, net, chord host (serving PoolObject) and sync. */
export type PoolNode = {
  id: string; identity: Identity; home: string; cfg: NodeConfig; db: Database; store: PoolStore; net: PoolNet; host: Host; sync: PoolSync;
  /** What this node reports about itself. */
  summary: NodeSummary;
  /** What `servePool` was given; `tokenChanged` refreshes the self row and tells the pool. */
  deps: PoolObjectDeps;
  /** Fires `deps.changes`, as the node does when its roster, a peer's online state or its token changed. */
  changed(): void;
  /** Everything reported to the net's, the sync's and the host's `onError`. */
  errors: unknown[];
};

const fast = { initialMs: 50, maxMs: 200 };

function notInThisTest(): never {
  throw new Error("not in this test");
}

async function poolNode(name: string): Promise<{ node: PoolNode; frames: TappedFrame[]; stopAccepting: () => void }> {
  const home = await mkdtemp(`/tmp/meddle-pool-${name}-`);
  const cfg = loadConfig({
    HOME: home, MEDDLE_DATA_DIR: `${home}/d`, MEDDLE_TASK_ROOT: `${home}/t`,
    MEDDLE_IROH_PRESET: "minimal", MEDDLE_IROH_BIND: "127.0.0.1:0", MEDDLE_LIGHTHOUSE_URL: "",
  });
  await ensureDataDirs(cfg);
  const db = openDb(paths(cfg).db);
  const store = new PoolStore(db);
  const identity = freshIdentity();
  const id = identity.id;
  const summary: NodeSummary = { hostname: `host-${shortId(id)}`, version: "0.1.0", claudeCodeVersion: "2.0.0", hostsTasks: true, taskCount: 0 };
  store.ensurePool({ nodeId: id, hostname: summary.hostname });
  const endpoint = await openEndpoint(cfg, identity);
  const errors: unknown[] = [];
  const frames: TappedFrame[] = [];
  const onError = (err: unknown) => { errors.push(err); };
  const tap: LinkTap = (direction, text) => { frames.push({ direction, text }); };

  const listeners = new Set<(value: null) => void>();
  const changes: Subscribable<null> = {
    subscribe(cb) {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
  };
  const changed = () => { for (const cb of [...listeners]) cb(null); };

  const net = new PoolNet({
    endpoint, selfId: id, isMember: (peer) => store.isMember(peer), onError, backoff: fast,
    onJoin: async (conn) => conn.close(0n, []),
  });
  net.onPeer(() => changed());
  const sync = new PoolSync({ cfg, store, net, selfId: id, summary: () => summary, onChange: changed, onError, tap });
  const deps: PoolObjectDeps = {
    store, cfg, selfId: id,
    isOnline: (peer) => net.isOnline(peer),
    liveSummary: () => summary,
    invite: notInThisTest,
    join: async () => notInThisTest(),
    remove: async () => notInThisTest(),
    tokenChanged: () => sync.refreshSelf(),
    changes,
  };
  const host = createHost({ name: "node", self: "node", onError });
  servePool(host, deps);
  const stopAccepting = acceptPeerLinks(net, host, (peer) => store.isMember(peer));
  return { node: { id, identity, home, cfg, db, store, net, host, sync, summary, deps, changed, errors }, frames, stopAccepting };
}

/**
 * Two pool nodes in temp homes (presetMinimal on 127.0.0.1:0), each a member of the other's roster in one pool, with a
 * chord host serving PoolObject, `acceptPeerLinks` and a `PoolSync` whose frames `framesOf(node)` collects. The node
 * with the smaller id is offered the other's address unless `offerAddresses: false` (then only discovery can connect
 * them). Started unless `start: false` (then call `start()`); `close()` stops everything and removes the homes.
 */
export async function twoNodes(options: { start?: boolean; offerAddresses?: boolean } = {}): Promise<{
  a: PoolNode; b: PoolNode;
  framesOf(node: PoolNode): TappedFrame[];
  start(): void;
  close(): Promise<void>;
}> {
  const made = [await poolNode("a"), await poolNode("b")] as const;
  const [a, b] = [made[0].node, made[1].node];
  a.store.upsert({ ...a.store.row(a.id)!, nodeId: b.id, hostname: b.summary.hostname });
  b.store.replacePool(a.store.pool(), a.store.roster());
  for (const [self, other] of [[a, b], [b, a]] as const) {
    self.net.watch(other.id);
    if (options.offerAddresses !== false && self.id < other.id) self.net.offerAddress(fromEndpoint(other.net.endpoint));
  }
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    for (const n of [a, b]) {
      n.net.start();
      n.sync.start();
    }
  };
  if (options.start !== false) start();
  return {
    a, b, start,
    framesOf: (node) => (node === a ? made[0].frames : made[1].frames),
    async close() {
      await Promise.all([a.sync.stop(), b.sync.stop()]);
      for (const m of made) m.stopAccepting();
      await Promise.all([a.host.close(), b.host.close()]);
      await Promise.all([a.net.stop(), b.net.stop()]);
      for (const n of [a, b]) {
        if (!n.net.endpoint.isClosed()) await n.net.endpoint.close();
        n.db.close();
        await rm(n.home, { recursive: true, force: true });
      }
    },
  };
}
