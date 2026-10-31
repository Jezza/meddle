// test/pool-state.test.ts — the pool runtime behind a node host: PoolObject, joining, the token and removal.
import { test, expect } from "bun:test";
import { hostname } from "node:os";
import type { Host } from "@earendil-works/chord";
import { decodeTicket, joinPool } from "../src/pool/invite";
import { PeerClosed, PoolNet } from "../src/pool/net";
import { fromEndpoint } from "../src/pool/net";
import { PoolStore } from "../src/pool/store";
import { openDb } from "../src/store/db";
import { startPool, type PoolRuntime } from "../src/pool/runtime";
import { NodeObject, PoolObject } from "../src/state/contracts";
import { getToken, setToken } from "../src/token";
import { VERSION } from "../src/version";
import { linkClient, poolSummaryOf, startPoolNode, testNode } from "./pool-helpers";

type Node = Awaited<ReturnType<typeof startPoolNode>>;

const WAIT_MS = 10_000;

/** Resolves with the first value of `readable` (the current one included) that satisfies `pred`; rejects after 10 s. */
function until<T>(readable: { readonly value: T; subscribe(cb: (value: T) => void): () => void }, pred: (value: T) => boolean): Promise<T> {
  return new Promise((resolve, reject) => {
    let done = false;
    let stop: (() => void) | undefined;
    const timer = setTimeout(() => {
      done = true;
      stop?.();
      reject(new Error(`timed out waiting; last value ${JSON.stringify(readable.value)}`));
    }, WAIT_MS);
    stop = readable.subscribe((value) => {
      if (done || !pred(value)) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
      stop?.();
    });
    if (done) stop();
  });
}

async function eventually(cond: () => boolean, ms = WAIT_MS): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(10);
  }
}

/** The `default` variant of the node's PoolObject, as a dashboard holds it. */
async function poolOf(client: Host) {
  const pool = await client.get(PoolObject, {});
  if (pool.variant !== "default") throw new Error("expected the default variant");
  return pool;
}

type Viewed = { node: Node; client: Host; pool: Awaited<ReturnType<typeof poolOf>> };

/** `count` pool nodes, each with a client holding its PoolObject; `run` gets them and everything is stopped after. */
async function withNodes(count: number, run: (nodes: Viewed[]) => Promise<void>): Promise<void> {
  const started: Node[] = [];
  const clients: { close(): Promise<void> }[] = [];
  try {
    const viewed: Viewed[] = [];
    for (let i = 0; i < count; i++) {
      const node = await startPoolNode();
      started.push(node);
      const linked = linkClient(node.host);
      clients.push(linked);
      viewed.push({ node, client: linked.client, pool: await poolOf(linked.client) });
    }
    await run(viewed);
  } finally {
    for (const c of clients) await c.close();
    for (const n of started) await n.close();
  }
}

/** `joiner` joins the pool of `inviter` through their PoolObjects. */
async function join(inviter: Viewed, joiner: Viewed): Promise<{ poolId: string; members: number }> {
  const { ticket } = await inviter.pool.invite({});
  return joiner.pool.join({ ticket });
}

/** A `removed <updatedAt>` close or refusal from `peer`. */
function removedBy(errors: readonly unknown[], peer: string, how: "closed" | "refused"): PeerClosed[] {
  return errors.filter((e): e is PeerClosed => e instanceof PeerClosed && e.peerId === peer
    && e.message.includes(`${how} the connection`) && /^closed by peer: removed \S+ \(code 1\)$/.test(e.reason));
}

function onlineOn(viewer: Viewed, other: Viewed): Promise<unknown> {
  return until(viewer.pool.nodes, (rows) => rows.some((r) => r.nodeId === other.node.id && r.online));
}

test("PoolObject shows a pool of one, invites, and a joined node appears online on both", async () => {
  await withNodes(2, async ([a, b]) => {
    const A = a!.node;
    const B = b!.node;
    const poolA = a!.pool;
    expect(poolA.self.value).toBe(A.identity.id);
    expect(poolA.nodes.value).toEqual([{
      nodeId: A.id, hostname: hostname(), status: "member", online: true, version: VERSION, claudeCodeVersion: "2.1.314",
      hostsTasks: true, taskCount: 0, lastSeenAt: expect.any(String),
    }]);
    const nodeA = await a!.client.get(NodeObject, {});
    expect(nodeA.nodeId.value).toBe(A.identity.id);

    expect(await join(a!, b!)).toEqual({ poolId: poolA.poolId.value, members: 2 });
    await onlineOn(a!, b!);
    await onlineOn(b!, a!);
    expect(A.store.pool().poolSecret).toBe(B.store.pool().poolSecret);
    expect(b!.pool.poolId.value).toBe(poolA.poolId.value);
    expect(poolA.mixedVersions.value).toBe(false);
  });
}, 15_000);

test("tokenChanged replicates the token; remove propagates and the removed node is cut off", async () => {
  await withNodes(2, async ([a, b]) => {
    const A = a!.node;
    const B = b!.node;
    const poolA = a!.pool;
    const poolB = b!.pool;
    await join(a!, b!);
    await onlineOn(a!, b!);
    await onlineOn(b!, a!);

    await setToken(A.cfg, "tok2", { setBy: A.id });
    await poolA.tokenChanged({});
    await until(poolA.token, (t) => t.setBy === A.id);
    await until(poolB.token, (t) => t.setBy === A.id);
    expect((await getToken(B.cfg)) === "tok2").toBe(true);
    expect(poolB.token.value.setAt).toBe(poolA.token.value.setAt);
    const nodeB = await b!.client.get(NodeObject, {});
    await until(nodeB.token, (t) => t.expiresAt === poolB.token.value.expiresAt);

    await poolA.remove({ nodeId: B.id });
    expect(A.net.isOnline(B.id)).toBe(false);
    await until(poolA.nodes, (rows) => rows.some((r) => r.nodeId === B.id && r.status === "removed" && !r.online));
    await until(poolB.nodes, (rows) => rows.some((r) => r.nodeId === B.id && r.status === "removed"));
    expect(B.net.online()).toEqual([]);
    await expect(poolA.remove({ nodeId: A.id })).rejects.toThrow("a node cannot remove itself");
  });
}, 15_000);

test("a removed node is cut off, sees itself removed, and may join again", async () => {
  await withNodes(3, async ([a, b, c]) => {
    const [A, B, C] = [a!.node, b!.node, c!.node];
    await join(a!, b!);
    expect(await join(a!, c!)).toEqual({ poolId: a!.pool.poolId.value, members: 3 });
    const all = [A, B, C];
    const fullyLinked = () => all.every((n) => all.every((m) => m === n || n.net.isOnline(m.id)));
    await eventually(fullyLinked);

    await a!.pool.remove({ nodeId: C.id });
    await eventually(() => B.store.row(C.id)?.status === "removed" && !B.net.isOnline(C.id) && !C.net.isOnline(B.id));
    await until(c!.pool.nodes, (rows) => rows.some((r) => r.nodeId === C.id && r.status === "removed"));
    expect(C.net.online()).toEqual([]);
    // B was not removed: it still counts itself a member and keeps its link with A.
    expect(B.store.isMember(B.id)).toBe(true);
    expect(B.net.isOnline(A.id)).toBe(true);

    expect(await join(a!, c!)).toEqual({ poolId: a!.pool.poolId.value, members: 3 });
    await eventually(() => B.store.isMember(C.id) && fullyLinked());
  });
}, 15_000);

test("a node removed while it was offline learns it from the refusal when it comes back", async () => {
  await withNodes(2, async (nodes) => {
    // The smaller id dials: the removed node must be the smaller one to come back and ask the other.
    const [b, a] = [...nodes].sort((x, y) => (x.node.id < y.node.id ? -1 : 1)) as [Viewed, Viewed];
    const [A, B] = [a.node, b.node];
    await join(a, b);
    await onlineOn(a, b);
    await onlineOn(b, a);

    await B.pool.stop();
    await until(a.pool.nodes, (rows) => rows.some((r) => r.nodeId === B.id && !r.online));
    await a.pool.remove({ nodeId: B.id });
    expect(B.store.isMember(B.id)).toBe(true);

    // B comes back (same identity, same store) and dials A, which refuses it as removed.
    const errors: unknown[] = [];
    let back: PoolRuntime | undefined;
    try {
      back = await startPool(B.cfg, B.db, poolSummaryOf(B.cfg, B.db), { onError: (err) => errors.push(err) });
      expect(back.identity.id).toBe(B.id);
      const refusals = () => errors.filter((e): e is PeerClosed => e instanceof PeerClosed && e.peerId === A.id);
      await eventually(() => B.store.row(B.id)?.status === "removed");
      expect(back.net.online()).toEqual([]);
      expect(refusals()).toHaveLength(1);
      expect(refusals()[0]!.reason).toMatch(/^closed by peer: removed \S+ \(code 1\)$/);
      // Past the 1 s and 2 s redial delays: B stopped dialing A.
      await Bun.sleep(2500);
      expect(refusals()).toHaveLength(1);
      expect(A.net.isOnline(B.id)).toBe(false);
      expect(A.store.isMember(A.id)).toBe(true);
    } finally {
      await back?.stop();
    }
  });
}, 15_000);

test("a member that did not do the removing closes the removed node's live connection", async () => {
  await withNodes(2, async ([a, b]) => {
    const [A, B] = [a!.node, b!.node];
    await join(a!, b!);
    await onlineOn(a!, b!);
    await onlineOn(b!, a!);

    // C joins through A but is only a bare connection manager: it never syncs, so it can neither learn its removal
    // nor leave on its own, and only the members can close its connections.
    const c = await testNode();
    const C = c.identity.id;
    const store = new PoolStore(openDb(":memory:"));
    store.ensurePool({ nodeId: C, hostname: "bare-c" });
    const errors: unknown[] = [];
    const net = new PoolNet({
      endpoint: c.endpoint, selfId: C, isMember: () => true, onJoin: async (conn) => conn.close(0n, []),
      onError: (err) => errors.push(err), backoff: { initialMs: 50, maxMs: 200 },
    });
    try {
      const { ticket } = await a!.pool.invite({});
      const joined = await joinPool(decodeTicket(ticket), {
        endpoint: c.endpoint, store, identity: c.identity,
        summary: () => ({ hostname: "bare-c", version: VERSION, claudeCodeVersion: "2.1.314", hostsTasks: false, taskCount: 0 }),
      });
      net.start();
      for (const addr of joined.addrs) net.offerAddress(addr);
      net.watch(A.id);
      net.watch(B.id);
      await eventually(() => net.isOnline(A.id) && net.isOnline(B.id) && B.net.isOnline(C));

      await a!.pool.remove({ nodeId: C });
      await eventually(() => removedBy(errors, B.id, "closed").length > 0);
      expect(B.store.row(C)?.status).toBe("removed");
      expect(B.net.isOnline(C)).toBe(false);
      expect(net.isOnline(B.id)).toBe(false);
    } finally {
      await net.stop();
    }
  });
}, 15_000);

test("a re-joined node refused as removed by a member that has not merged the re-join stays a member", async () => {
  await withNodes(3, async ([a, x, y]) => {
    // C dials B (the smaller id dials), so C's dial can reach B before B hears of the re-join.
    const [c, b] = [x!, y!].sort((p, q) => (p.node.id < q.node.id ? -1 : 1)) as [Viewed, Viewed];
    const [A, B, C] = [a!.node, b.node, c.node];
    const all = [A, B, C];
    const fullyLinked = () => all.every((n) => all.every((m) => m === n || n.net.isOnline(m.id)));
    await join(a!, b);
    await join(a!, c);
    await eventually(fullyLinked);
    await a!.pool.remove({ nodeId: C.id });
    await eventually(() => B.store.row(C.id)?.status === "removed" && !C.store.isMember(C.id) && C.net.online().length === 0);

    // B stops merging rosters, so it keeps C as removed while C re-joins through A.
    const merge = B.store.merge.bind(B.store);
    let paused = true;
    B.store.merge = (rows) => (paused ? false : merge(rows));
    const refusedByB = () => removedBy(C.errors, B.id, "refused").length;
    const before = refusedByB();
    expect(await join(a!, c)).toEqual({ poolId: a!.pool.poolId.value, members: 3 });
    await eventually(() => refusedByB() > before);
    // The refusal names a removal older than C's re-join: C stays a member and keeps its link with A.
    expect(C.store.isMember(C.id)).toBe(true);
    await eventually(() => C.net.isOnline(A.id));
    expect(B.store.row(C.id)?.status).toBe("removed");

    paused = false;
    // A's refreshed row changes its roster, which B now merges, re-join included; C's next dial is admitted.
    await a!.pool.tokenChanged({});
    await eventually(() => B.store.isMember(C.id) && B.net.isOnline(C.id) && C.net.isOnline(B.id));
    expect(C.store.isMember(C.id)).toBe(true);
  });
}, 15_000);

test("a removal refusal whose time is not an ISO time does not mark the node removed", async () => {
  const B = await startPoolNode();
  const x = await testNode();
  const X = x.identity.id;
  // X closes or refuses B as `removed zzz`, which sorts after any ISO time; whichever of them dials.
  const net = new PoolNet({
    endpoint: x.endpoint, selfId: X, isMember: () => false, refusalReason: () => "removed zzz",
    onJoin: async (conn) => conn.close(0n, []), backoff: { initialMs: 50, maxMs: 200 },
  });
  net.onPeer((id, online) => { if (online) net.unwatch(id, "removed zzz"); });
  try {
    const now = new Date().toISOString();
    B.store.upsert({
      nodeId: X, hostname: "x", status: "member", updatedAt: now, addedBy: B.id,
      summary: null, lastSeenAt: now, lastAddr: fromEndpoint(x.endpoint),
    });
    net.start();
    net.offerAddress(fromEndpoint(B.pool.endpoint));
    net.watch(B.id);
    // Refreshing B's self row makes B follow X.
    await B.pool.tokenChanged();
    const refusals = () => B.errors.filter((e): e is PeerClosed => e instanceof PeerClosed && e.peerId === X && e.reason.includes("removed zzz"));
    await eventually(() => refusals().length > 0);
    expect(B.store.isMember(B.id)).toBe(true);
  } finally {
    await net.stop();
    await B.close();
  }
}, 15_000);
