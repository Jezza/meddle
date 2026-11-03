// test/pool-helpers.ts — fixtures for tests of the pool transport.
import { mkdtemp, rm } from "node:fs/promises";
import { hostname } from "node:os";
import type { Database } from "bun:sqlite";
import { SecretKey, type Connection, type Endpoint } from "@number0/iroh";
import { createHost, memoryLinkPair, type Host, type Subscribable } from "@earendil-works/chord";
import { checkTaskRoot, ensureDataDirs, loadConfig, paths, type NodeConfig } from "../src/config";
import { writeHelperWrapper, writeUpdateHook } from "../src/git/scripts";
import { acceptGitStreams } from "../src/git/serve";
import { GitSocket } from "../src/git/socket";
import { acceptBlobStreams } from "../src/tasks/blob";
import { MetricsSampler, findTaskPids } from "../src/metrics";
import { hexOf, loadOrCreateIdentity, shortId, type Identity } from "../src/pool/identity";
import type { LinkTap } from "../src/pool/link";
import { PoolNet, fromEndpoint, openEndpoint, toEndpointAddr, type NetDeps } from "../src/pool/net";
import { servePool, type PoolObjectDeps } from "../src/pool/object";
import { DEFAULT_POOL_NAME, poolKey, proofFor, verifyProof, type PoolKey } from "../src/pool/secret";
import { PoolStore, type NodeSummary } from "../src/pool/store";
import { startPool, type PoolSummaryDeps } from "../src/pool/runtime";
import { PoolSettings } from "../src/pool/settings";
import { PoolSync, acceptPeerLinks } from "../src/pool/sync";
import { PeerObject } from "../src/state/contracts";
import { createNodeHost } from "../src/state/host";
import { openDb } from "../src/store/db";
import { listProjects } from "../src/projects/project";
import { countRunningTasks, listLiveTasks } from "../src/store/records";
import type { RunnerHooks } from "../src/tasks/durable";
import { VERSION, claudeCodeVersion } from "../src/version";
import { setupNode } from "./helpers";

export type TestNode = { endpoint: Endpoint; identity: Identity };

/** The pool secret every test node is given unless a test says otherwise. */
export const POOL_SECRET = "meddle-test-pool-secret";
/** The pool key of `POOL_SECRET` under the default name. */
export const POOL_KEY: PoolKey = poolKey(DEFAULT_POOL_NAME, POOL_SECRET);

/** `prove`, `verify` and `admit` (everyone) for a PoolNet of node `selfId` in the pool of `key`. */
export function proofDeps(selfId: string, key: PoolKey = POOL_KEY): Pick<NetDeps, "prove" | "verify" | "admit"> {
  return {
    prove: (peer) => proofFor(key, selfId, peer),
    verify: (peer, proof) => verifyProof(key.id, peer, selfId, proof),
    admit: () => true,
  };
}

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
  /** The node's pool settings, applied to `cfg.poolEnv`. */
  settings: PoolSettings;
  /** What this node reports about itself. */
  summary: NodeSummary;
  /** What `servePool` was given; `tokenChanged` refreshes the self row and tells the pool. */
  deps: PoolObjectDeps;
  /** Fires `deps.changes`, as the node does when its roster, a peer's online state or its tokens changed. */
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
  const summary: NodeSummary = { hostname: `host-${shortId(id)}`, version: "0.1.0", claudeCodeVersion: "2.0.0", hostsTasks: true, taskCount: 0, running: 0, limit: 0, projects: [] };
  store.setSecret({ nodeId: id, hostname: summary.hostname }, DEFAULT_POOL_NAME, POOL_SECRET);
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
    endpoint, selfId: id, ...proofDeps(id), admit: (peer) => store.ensureMember(peer, id) === "member", onError, backoff: fast,
  });
  net.onPeer(() => changed());
  const settings = new PoolSettings(db, cfg, id, () => {});
  settings.apply();
  const sync = new PoolSync({ cfg, db, store, net, selfId: id, settings, summary: () => summary, onChange: changed, onError, tap });
  const settingsChanged = async () => {
    settings.apply();
    await sync.refreshSelf();
  };
  const deps: PoolObjectDeps = {
    store, db, cfg, selfId: id,
    isOnline: (peer) => net.isOnline(peer),
    liveSummary: () => summary,
    poolChanged: async () => notInThisTest(),
    remove: async () => notInThisTest(),
    allow: async () => notInThisTest(),
    tokenChanged: () => sync.refreshSelf(),
    settings,
    setSetting: async (key, value) => {
      settings.set(key, value);
      await settingsChanged();
    },
    unsetSetting: async (key) => {
      settings.unset(key);
      await settingsChanged();
    },
    changes,
  };
  const host = createHost({ name: "node", self: "node", onError });
  servePool(host, deps);
  const stopAccepting = acceptPeerLinks(net, host, (peer) => store.isMember(peer));
  return { node: { id, identity, home, cfg, db, store, net, host, sync, settings, summary, deps, changed, errors }, frames, stopAccepting };
}

/**
 * Two pool nodes in temp homes (presetMinimal on 127.0.0.1:0), both with `POOL_SECRET` and each a member of the
 * other's roster, with a chord host serving PoolObject, `acceptPeerLinks` and a `PoolSync` whose frames
 * `framesOf(node)` collects. The node with the smaller id is offered the other's address unless `offerAddresses:
 * false` (then only discovery can connect them). Started unless `start: false` (then call `start()`); `close()` stops
 * everything and removes the homes.
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
  b.store.upsert({ ...b.store.row(b.id)!, nodeId: a.id, hostname: a.summary.hostname });
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

/** The environment a pool node in a test reads: loopback only, no relays, no lighthouse. */
export const POOL_ENV = { MEDDLE_IROH_PRESET: "minimal", MEDDLE_IROH_BIND: "127.0.0.1:0", MEDDLE_LIGHTHOUSE_URL: "" };

/**
 * What a test node reports to its pool, as `serve` does: this meddle, the pinned Claude Code, its task root, tasks, running
 * tasks and projects.
 */
export function poolSummaryOf(cfg: NodeConfig, db: Database): PoolSummaryDeps {
  return {
    version: VERSION,
    claudeCodeVersion: claudeCodeVersion(),
    hostsTasks: async () => (await checkTaskRoot(cfg)).ok,
    taskCount: () => listLiveTasks(db).length,
    running: () => countRunningTasks(db),
    projects: () => listProjects(db).map((p) => ({ id: p.id, name: p.name, home: p.home })),
  };
}

/**
 * A whole node (see `setupNode`, `extraEnv` added to its environment) with its pool runtime started and its chord
 * host (`createNodeHost`, which gives the runner the pool) serving it; the metrics sampler is not started; what the
 * runtime and the runner log is collected in `logs`; `hooks` are the runner's test hooks, set them at will; `token` is
 * `setupNode`'s (default `"tok"`, `null` for none); `secret` is the pool secret set before the pool starts (default
 * `POOL_SECRET`, `null` for none). `close()` stops the pool, the host and the harness.
 */
export async function startPoolNode(fixture?: string, extraEnv: Record<string, string> = {}, options: { token?: string | null; secret?: string | null } = {}) {
  /** The lines the runtime and the runner logged (instead of printing them). */
  const logs: string[] = [];
  const hooks: RunnerHooks = {};
  const node = await setupNode(fixture, { ...POOL_ENV, ...extraEnv }, {
    log: (line) => logs.push(line), hooks, ...(options.token === undefined ? {} : { token: options.token }),
  });
  const { cfg, db, runner } = node;
  const secret = options.secret === undefined ? POOL_SECRET : options.secret;
  if (secret !== null) {
    const { id } = await loadOrCreateIdentity(cfg);
    new PoolStore(db).setSecret({ nodeId: id, hostname: hostname() }, DEFAULT_POOL_NAME, secret);
  }
  const metrics = new MetricsSampler({ taskPids: () => findTaskPids(cfg.taskRoot), intervalMs: 60_000, dataDir: cfg.dataDir });
  /** Everything the runtime's net and sync reported. */
  const errors: unknown[] = [];
  const pool = await startPool(cfg, db, poolSummaryOf(cfg, db), { onError: (err) => errors.push(err), log: (line) => logs.push(line) });
  const host = createNodeHost({ cfg, db, runner, metrics, claudeCodeVersion: claudeCodeVersion(), pool });
  return {
    ...node, metrics, pool, host, errors, logs, hooks,
    id: pool.identity.id, identity: pool.identity, store: pool.store, net: pool.net,
    async close() {
      metrics.stop();
      await pool.stop();
      await host.close();
      await node.harness.close();
    },
  };
}

/** A client host linked to `host` over a memory link, as principal `owner`. */
export function linkClient(host: Host): { client: Host; close(): Promise<void> } {
  const [down, up] = memoryLinkPair();
  host.accept(down, { principal: "owner", kind: "client" });
  const client = createHost({ name: "client", self: "client", kind: "client", upstream: { link: up, principal: "node" } });
  return { client, close: () => client.close() };
}

/** A pool node of `twoPoolNodes`: `startPoolNode` serving git and moved tasks, its `git` refusals logged to `logs`. */
export type GitPoolNode = Awaited<ReturnType<typeof startPoolNode>>;

/**
 * What one node of `poolNodes` runs its turns with, on top of the options for all; `serveGit: false` leaves its `git`
 * streams to the test (no `acceptGitStreams`); `token` is `startPoolNode`'s (default `"tok"`, `null` for none).
 */
export type NodeOptions = { fixture?: string; extraEnv?: Record<string, string>; serveGit?: boolean; token?: string | null };

/** Gives each of the two nodes the other as a member with its address, so that they connect (no lighthouse needed). */
export async function linkNodes(a: GitPoolNode, b: GitPoolNode): Promise<void> {
  await a.pool.addPeer(fromEndpoint(b.net.endpoint));
  await b.pool.addPeer(fromEndpoint(a.net.endpoint));
}

/**
 * `count` whole nodes (`startPoolNode`, with `extraEnv` and the node's own `nodes[i]`), all with `POOL_SECRET`, linked
 * to each other (`linkNodes`) and all online to each other, each with the git remote helper's wrapper and the update
 * hook written, a `GitSocket` started, `acceptGitStreams` (logging to the node's `logs`) and `acceptBlobStreams`
 * registered. `close()` stops the acceptors, the sockets and the nodes, and removes the homes.
 */
export async function poolNodes(
  count: number,
  options: { extraEnv?: Record<string, string>; nodes?: NodeOptions[] } = {},
): Promise<{ nodes: GitPoolNode[]; close(): Promise<void> }> {
  const nodes: GitPoolNode[] = [];
  const stops: Array<() => Promise<void>> = [];
  const close = async () => {
    for (const stop of stops.reverse()) await stop().catch(() => {});
    for (const n of nodes) {
      await n.close();
      n.db.close();
      await rm(n.home, { recursive: true, force: true });
    }
  };
  try {
    for (let i = 0; i < count; i++) {
      const own = options.nodes?.[i] ?? {};
      const node = await startPoolNode(own.fixture, { ...options.extraEnv, ...own.extraEnv }, own.token === undefined ? {} : { token: own.token });
      nodes.push(node);
      await writeHelperWrapper(node.cfg);
      await writeUpdateHook(node.cfg);
      const socket = new GitSocket(node.cfg, node.net);
      await socket.start();
      stops.push(() => socket.stop());
      if (own.serveGit !== false) {
        const stopAccepting = acceptGitStreams(node.net, {
          db: node.db, cfg: node.cfg, selfId: node.id, isMember: (id) => node.store.isMember(id), log: (line) => node.logs.push(line),
        });
        stops.push(async () => stopAccepting());
      }
      const stopBlobs = acceptBlobStreams(node.net, node.runner);
      stops.push(async () => stopBlobs());
    }
    for (const [i, a] of nodes.entries()) for (const b of nodes.slice(i + 1)) await linkNodes(a, b);
    const deadline = Date.now() + 10_000;
    const offline = () => nodes.flatMap((a) => nodes.filter((b) => b !== a && !a.net.isOnline(b.id)).map((b) => `${shortId(a.id)} sees ${shortId(b.id)} offline`));
    while (offline().length > 0) {
      if (Date.now() > deadline) throw new Error(`the nodes never came online to each other: ${offline().join(", ")}`);
      await Bun.sleep(10);
    }
    // A move checks what its node last heard of the target's summary.
    const unheard = () => nodes.flatMap((a) => nodes.filter((b) => b !== a && a.store.row(b.id)?.summary?.hostsTasks !== true).map((b) => `${shortId(a.id)} has ${shortId(b.id)} hosting no tasks`));
    while (unheard().length > 0) {
      if (Date.now() > deadline) throw new Error(`the nodes never heard each other's summaries: ${unheard().join(", ")}`);
      await Bun.sleep(10);
    }
    return { nodes, close };
  } catch (err) {
    await close();
    throw err;
  }
}

/** Two nodes of `poolNodes`: A and B in one pool. */
export async function twoPoolNodes(
  options: { extraEnv?: Record<string, string>; nodes?: NodeOptions[] } = {},
): Promise<{ A: GitPoolNode; B: GitPoolNode; close(): Promise<void> }> {
  const { nodes, close } = await poolNodes(2, options);
  const [A, B] = nodes as [GitPoolNode, GitPoolNode];
  return { A, B, close };
}

/** Waits until `from` holds `to`'s PeerObject (its client host comes up just after `to` shows online). */
export async function peerReady(from: GitPoolNode, to: GitPoolNode): Promise<void> {
  const deadline = Date.now() + 10_000;
  let last: unknown = null;
  for (;;) {
    const ref = await from.pool.peerRef(to.id, PeerObject).catch((err: unknown) => { last = err; return null; });
    if (ref !== null) {
      ref.release();
      return;
    }
    if (Date.now() > deadline) throw new Error(`no PeerObject of ${shortId(to.id)}: ${String(last)}`);
    await Bun.sleep(20);
  }
}
