// test/pool-state.test.ts — the pool runtime behind a node host: PoolObject, linking up, the tokens, removal and allowing again.
import { test, expect } from "bun:test";
import { hostname } from "node:os";
import { SecretKey } from "@number0/iroh";
import type { Host } from "@earendil-works/chord";
import { hexOf, shortId } from "../src/pool/identity";
import { PeerClosed, PoolNet } from "../src/pool/net";
import { fromEndpoint, openEndpoint } from "../src/pool/net";
import { PoolStore } from "../src/pool/store";
import { openDb } from "../src/store/db";
import { startPool, type PoolRuntime } from "../src/pool/runtime";
import { NodeObject, PeerObject, PoolObject } from "../src/state/contracts";
import { addToken, markToken, removeToken, tokenId, tokenValue } from "../src/token";
import { VERSION } from "../src/version";
import { initColocated } from "../src/jj";
import { addProjectFromFolder } from "../src/projects/project";
import { POOL_KEY, linkClient, linkNodes, peerReady, poolSummaryOf, proofDeps, startPoolNode, testNode, twoPoolNodes } from "./pool-helpers";
import { join as joinPath } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { paths } from "../src/config";
import { bookmarkList, jj } from "../src/jj";
import { getProject } from "../src/projects/project";
import { syncMemoryBefore } from "../src/projects/memory-sync";

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

/** Gives each node the other as a member with its address (both hold the test pool's secret). */
function join(a: Viewed, b: Viewed): Promise<void> {
  return linkNodes(a.node, b.node);
}

/** A `removed <updatedAt>` close or refusal from `peer`. */
function removedBy(errors: readonly unknown[], peer: string, how: "closed" | "refused"): PeerClosed[] {
  return errors.filter((e): e is PeerClosed => e instanceof PeerClosed && e.peerId === peer
    && e.message.includes(`${how} the connection`) && /^closed by peer: removed \S+ \(code 1\)$/.test(e.reason));
}

function onlineOn(viewer: Viewed, other: Viewed): Promise<unknown> {
  return until(viewer.pool.nodes, (rows) => rows.some((r) => r.nodeId === other.node.id && r.online));
}

test("PoolObject shows a pool of one, and a linked node that proved the secret appears online on both", async () => {
  await withNodes(2, async ([a, b]) => {
    const A = a!.node;
    const B = b!.node;
    const poolA = a!.pool;
    expect(poolA.self.value).toBe(A.identity.id);
    expect(poolA.nodes.value).toEqual([{
      nodeId: A.id, hostname: hostname(), status: "member", online: true, version: VERSION, claudeCodeVersion: "2.1.314",
      hostsTasks: true, taskCount: 0, running: 0, limit: 0, projects: [{ id: A.project.id, name: "a", home: A.id }],
      lastSeenAt: expect.any(String), gone: false, link: null,
    }]);
    const nodeA = await a!.client.get(NodeObject, {});
    expect(nodeA.nodeId.value).toBe(A.identity.id);

    expect(poolA.poolId.value).toBe(POOL_KEY.id);
    expect(poolA.poolName.value).toBe("default");
    await join(a!, b!);
    await onlineOn(a!, b!);
    await onlineOn(b!, a!);
    expect(A.store.pool().poolSecret).toBe(B.store.pool().poolSecret);
    expect(b!.pool.poolId.value).toBe(poolA.poolId.value);
    // Each learnt the other's hostname from the row it sends of itself.
    await until(poolA.nodes, (rows) => rows.some((r) => r.nodeId === B.id && r.hostname === hostname() && r.status === "member"));
    expect(A.store.row(B.id)).toMatchObject({ addedBy: B.id });
    expect(poolA.mixedVersions.value).toBe(false);
    // A healthy pool logs nothing.
    expect([...A.logs, ...B.logs]).toEqual([]);
  });
}, 15_000);

test("tokenChanged replicates the tokens; remove propagates and the removed node is cut off", async () => {
  await withNodes(2, async ([a, b]) => {
    const A = a!.node;
    const B = b!.node;
    const poolA = a!.pool;
    const poolB = b!.pool;
    await join(a!, b!);
    await onlineOn(a!, b!);
    await onlineOn(b!, a!);

    // Each node has `tok` (set before they met, so first in order): it stays the active one.
    const tok = tokenId("tok");
    const added = await addToken(A.cfg, A.db, "tok2", { label: "second", setBy: A.id });
    await poolA.tokenChanged({});
    await until(poolA.tokens, (ts) => ts.some((t) => t.id === added.id));
    const listed = await until(poolB.tokens, (ts) => ts.some((t) => t.id === added.id && t.label === "second" && t.setBy === A.id));
    expect(listed.map((t) => t.id)).toEqual(poolA.tokens.value.map((t) => t.id));
    await eventually(() => poolB.tokens.value.length === 2);
    const deadline = Date.now() + WAIT_MS;
    while ((await tokenValue(B.cfg, added.id)) !== "tok2") {
      if (Date.now() > deadline) throw new Error("B never pulled the token");
      await Bun.sleep(20);
    }
    expect(poolA.activeTokenId.value).toBe(tok);
    expect(poolB.activeTokenId.value).toBe(tok);
    const nodeB = await b!.client.get(NodeObject, {});
    const first = poolB.tokens.value.find((t) => t.id === tok)!;
    await until(nodeB.token, (t) => t.present && t.expiresAt === first.expiresAt);

    await poolA.remove({ nodeId: B.id });
    expect(A.net.isOnline(B.id)).toBe(false);
    await until(poolA.nodes, (rows) => rows.some((r) => r.nodeId === B.id && r.status === "removed" && !r.online));
    await until(poolB.nodes, (rows) => rows.some((r) => r.nodeId === B.id && r.status === "removed"));
    expect(B.net.online()).toEqual([]);
    await expect(poolA.remove({ nodeId: A.id })).rejects.toThrow("a node cannot remove itself");
  });
}, 15_000);

test("the dashboard enables a token by its full id and the pool learns it; anything else is refused", async () => {
  await withNodes(2, async ([a, b]) => {
    const A = a!.node;
    const poolA = a!.pool;
    const poolB = b!.pool;
    await join(a!, b!);
    await onlineOn(a!, b!);
    await onlineOn(b!, a!);

    // `tok` exhausted on A, and the pool told: B lists it so and no node has a usable token
    const tok = tokenId("tok");
    markToken(A.db, tok, "exhausted", "2100-01-01T00:00:00.000Z", "five_hour");
    await poolA.tokenChanged({});
    await until(poolB.tokens, (ts) => ts.some((t) => t.id === tok && t.status === "exhausted"));
    await until(poolA.activeTokenId, (id) => id === null);

    await poolA.enableToken({ id: tok });
    await until(poolA.tokens, (ts) => ts.some((t) => t.id === tok && t.status === "ok" && t.until === null && t.detail === null));
    await until(poolA.activeTokenId, (id) => id === tok);
    await until(poolB.tokens, (ts) => ts.some((t) => t.id === tok && t.status === "ok"));

    // an unknown id, a label (the CLI's convenience, not the dashboard's) and a removed token are refused
    await expect(poolA.enableToken({ id: "0".repeat(16) })).rejects.toThrow(`no such token: ${"0".repeat(16)}`);
    const labelled = await addToken(A.cfg, A.db, "tok2", { label: "second", setBy: A.id });
    await expect(poolA.enableToken({ id: "second" })).rejects.toThrow(/: no such token$/);
    await expect(poolA.enableToken({ id: "x\u001b[2J" })).rejects.toThrow(/: no such token$/);
    await removeToken(A.cfg, A.db, labelled.id);
    await expect(poolA.enableToken({ id: labelled.id })).rejects.toThrow(`no such token: ${labelled.id}`);
  });
}, 15_000);

test("the dashboard moves a token by full ids and the pool learns the order; anything else is refused", async () => {
  await withNodes(2, async ([a, b]) => {
    const A = a!.node;
    const poolA = a!.pool;
    const poolB = b!.pool;
    await join(a!, b!);
    await onlineOn(a!, b!);
    await onlineOn(b!, a!);

    const tok = tokenId("tok");
    const second = await addToken(A.cfg, A.db, "tok2", { label: "second", setBy: A.id });
    await poolA.tokenChanged({});
    const order = (ts: { id: string }[]) => ts.map((t) => t.id).join(",");
    await until(poolB.tokens, (ts) => order(ts) === `${tok},${second.id}`);

    await poolA.moveToken({ id: second.id, before: tok });
    await until(poolA.tokens, (ts) => order(ts) === `${second.id},${tok}`);
    await until(poolA.activeTokenId, (id) => id === second.id);
    await until(poolB.tokens, (ts) => order(ts) === `${second.id},${tok}`);

    await poolA.moveToken({ id: second.id, after: tok });
    await until(poolB.tokens, (ts) => order(ts) === `${tok},${second.id}`);

    // neither or both of before and after, labels, unknown ids, a token against itself and a removed token are refused
    await expect(poolA.moveToken({ id: second.id })).rejects.toThrow("give one of before and after");
    await expect(poolA.moveToken({ id: second.id, before: tok, after: tok })).rejects.toThrow("give one of before and after");
    await expect(poolA.moveToken({ id: "second", before: tok })).rejects.toThrow(/: no such token$/);
    await expect(poolA.moveToken({ id: second.id, before: "x\u001b[2J" })).rejects.toThrow(/: no such token$/);
    await expect(poolA.moveToken({ id: "0".repeat(16), before: tok })).rejects.toThrow(`no such token: ${"0".repeat(16)}`);
    await expect(poolA.moveToken({ id: tok, after: tok })).rejects.toThrow("cannot move a token before or after itself");
    await removeToken(A.cfg, A.db, second.id);
    await expect(poolA.moveToken({ id: second.id, before: tok })).rejects.toThrow(`no such token: ${second.id}`);
  });
}, 15_000);

test("the dashboard's settings show who set each one", async () => {
  await withNodes(2, async ([a, b]) => {
    const A = a!.node;
    await join(a!, b!);
    await onlineOn(a!, b!);
    await onlineOn(b!, a!);
    await a!.pool.setSetting({ key: "jj.user", value: "Lab" });
    const row = { key: "jj.user", value: "Lab", setBy: A.id, updatedAt: expect.any(String) };
    await until(a!.pool.settings, (rows) => rows.length === 1);
    expect(a!.pool.settings.value).toEqual([row]);
    await until(b!.pool.settings, (rows) => rows.length === 1);
    expect(b!.pool.settings.value).toEqual([row]);
    await b!.pool.unsetSetting({ key: "jj.user" });
    await until(a!.pool.settings, (rows) => rows.length === 0);
  });
}, 15_000);

test("a removed node is cut off, sees itself removed, and comes back once it is allowed again", async () => {
  await withNodes(3, async ([a, b, c]) => {
    const [A, B, C] = [a!.node, b!.node, c!.node];
    await join(a!, b!);
    await join(a!, c!);
    const all = [A, B, C];
    const fullyLinked = () => all.every((n) => all.every((m) => m === n || n.net.isOnline(m.id)));
    await eventually(fullyLinked);
    // C may have dialled B before B heard of C's join: a refusal that does not persist is not logged.
    expect(all.flatMap((n) => n.logs)).toEqual([]);

    await a!.pool.remove({ nodeId: C.id });
    await eventually(() => B.store.row(C.id)?.status === "removed" && !B.net.isOnline(C.id) && !C.net.isOnline(B.id));
    await until(c!.pool.nodes, (rows) => rows.some((r) => r.nodeId === C.id && r.status === "removed"));
    expect(C.net.online()).toEqual([]);
    // B was not removed: it still counts itself a member and keeps its link with A.
    expect(B.store.isMember(B.id)).toBe(true);
    expect(B.net.isOnline(A.id)).toBe(true);

    await a!.pool.allow({ nodeId: C.id });
    await eventually(() => B.store.isMember(C.id) && C.store.isMember(C.id) && fullyLinked());
    await expect(a!.pool.allow({ nodeId: A.id })).rejects.toThrow("a node cannot allow itself");
    await expect(a!.pool.allow({ nodeId: "d".repeat(64) })).rejects.toThrow("is not in this pool");
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
    const logs: string[] = [];
    let back: PoolRuntime | undefined;
    try {
      back = await startPool(B.cfg, B.db, poolSummaryOf(B.cfg, B.db), { onError: (err) => errors.push(err), log: (line) => logs.push(line) });
      expect(back.identity.id).toBe(B.id);
      const refusals = () => errors.filter((e): e is PeerClosed => e instanceof PeerClosed && e.peerId === A.id);
      await eventually(() => B.store.row(B.id)?.status === "removed");
      expect(back.net.online()).toEqual([]);
      // Learnt from the first refusal; the knock after it may have been refused already.
      expect(refusals().length).toBeGreaterThanOrEqual(1);
      expect(refusals()[0]!.reason).toMatch(/^closed by peer: removed \S+ \(code 1\)$/);
      expect(logs).toEqual([`meddle: pool: ${shortId(A.id)} says this node was removed from the pool at ${B.store.row(B.id)!.updatedAt}; it has left the pool`]);
      // Past the 1 s and 2 s redial delays: B keeps knocking, and nothing more is logged.
      await Bun.sleep(2500);
      expect(refusals().length).toBeGreaterThanOrEqual(2);
      expect(logs).toHaveLength(1);
      expect(A.net.isOnline(B.id)).toBe(false);
      expect(A.store.isMember(A.id)).toBe(true);

      // Allowed again on A, B's next knock is admitted and the sync tells it so.
      await a.pool.allow({ nodeId: B.id });
      await eventually(() => back!.net.isOnline(A.id) && B.store.isMember(B.id));
      expect(logs).toHaveLength(1);
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

    // C holds the secret and is linked to A and B, but is only a bare connection manager: it never syncs, so it can
    // neither learn its removal nor leave on its own, and only the members can close its connections.
    const c = await testNode();
    const C = c.identity.id;
    const errors: unknown[] = [];
    const net = new PoolNet({
      endpoint: c.endpoint, selfId: C, ...proofDeps(C),
      onError: (err) => errors.push(err), backoff: { initialMs: 50, maxMs: 200 },
    });
    try {
      await A.pool.addPeer(fromEndpoint(c.endpoint));
      await B.pool.addPeer(fromEndpoint(c.endpoint));
      net.start();
      net.offerAddress(fromEndpoint(A.pool.endpoint));
      net.offerAddress(fromEndpoint(B.pool.endpoint));
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

test("a node allowed again, refused as removed by a member that has not merged that, stays a member", async () => {
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

    // B stops merging rosters, so it keeps C as removed while A allows C again.
    const merge = B.store.merge.bind(B.store);
    let paused = true;
    B.store.merge = (rows) => (paused ? false : merge(rows));
    const refusedByB = () => removedBy(C.errors, B.id, "refused").length;
    await a!.pool.allow({ nodeId: C.id });
    // C learns it is allowed again from A (its knock admitted, or A's dial), and is a member once more.
    await eventually(() => C.store.isMember(C.id) && C.net.isOnline(A.id));
    const before = refusedByB();
    await eventually(() => refusedByB() > before);
    // The refusal names a removal older than C's being allowed again: C stays a member and keeps its link with A.
    expect(C.store.isMember(C.id)).toBe(true);
    expect(C.net.isOnline(A.id)).toBe(true);
    expect(B.store.row(C.id)?.status).toBe("removed");

    paused = false;
    // A's refreshed row changes its roster, which B now merges, the allowing included; C's next dial is admitted.
    await a!.pool.tokenChanged({});
    await eventually(() => B.store.isMember(C.id) && B.net.isOnline(C.id) && C.net.isOnline(B.id));
    expect(C.store.isMember(C.id)).toBe(true);
  });
}, 15_000);

test("a removal refusal whose time is not an ISO time does not mark the node removed", async () => {
  const B = await startPoolNode();
  const x = await testNode();
  const X = x.identity.id;
  // X closes or refuses B as `removed zzz`, which sorts after any ISO time, and then as removed at a date far ahead
  // of B's clock; whichever of them dials.
  let reason: `removed ${string}` = "removed zzz";
  const net = new PoolNet({
    endpoint: x.endpoint, selfId: X, ...proofDeps(X), admit: () => false, refusalReason: () => reason,
    backoff: { initialMs: 50, maxMs: 200 },
  });
  // When X is the dialer: it closes B with the reason, then dials again a little later (unwatch stops the dial loop).
  net.onPeer((id, online) => {
    if (!online) return;
    net.unwatch(id, reason);
    setTimeout(() => net.watch(id), 200);
  });
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
    const refusals = (text: string) => B.errors.filter((e): e is PeerClosed => e instanceof PeerClosed && e.peerId === X && e.reason.includes(text));
    await eventually(() => refusals("removed zzz").length > 0);
    expect(B.store.isMember(B.id)).toBe(true);
    reason = "removed 2999-01-01T00:00:00.000Z";
    await eventually(() => refusals("removed 2999").length > 0);
    expect(B.store.isMember(B.id)).toBe(true);
  } finally {
    await net.stop();
    await B.close();
  }
}, 15_000);

/** A fresh node id that sorts after `id`, so that the node `id` dials it. */
function idAfter(id: string): { id: string; key: SecretKey } {
  for (;;) {
    const key = SecretKey.generate();
    const candidate = hexOf(key.public());
    if (candidate > id) return { id: candidate, key };
  }
}

test("a member that cannot be dialled is logged at once, and the same message once a minute", async () => {
  const B = await startPoolNode();
  try {
    // Y is a member B dials, with no address B could reach it at.
    const Y = idAfter(B.id).id;
    const now = new Date().toISOString();
    B.store.upsert({ nodeId: Y, hostname: "y", status: "member", updatedAt: now, addedBy: B.id, summary: null, lastSeenAt: null, lastAddr: null });
    await B.pool.tokenChanged();
    const failures = () => B.errors.filter((e) => e instanceof Error && e.message.startsWith(`dialing ${shortId(Y)}: `));
    await eventually(() => failures().length >= 2);
    expect(B.logs).toEqual([`meddle: pool: ${(failures()[0] as Error).message}`]);
  } finally {
    await B.close();
  }
}, 15_000);

test("a member that keeps refusing this node is logged once the refusal persists past a redial", async () => {
  const B = await startPoolNode();
  // X refuses every dial from B (B dials it: its id is the smaller).
  const { key } = idAfter(B.id);
  const identity = { id: hexOf(key.public()), secret: Uint8Array.from(key.toBytes()) };
  const x = { identity, endpoint: await openEndpoint({ irohPreset: "minimal", irohBind: "127.0.0.1:0" }, identity) };
  const X = identity.id;
  const net = new PoolNet({ endpoint: x.endpoint, selfId: X, ...proofDeps(X), admit: () => false });
  try {
    net.start();
    const now = new Date().toISOString();
    B.store.upsert({
      nodeId: X, hostname: "x", status: "member", updatedAt: now, addedBy: B.id,
      summary: null, lastSeenAt: now, lastAddr: fromEndpoint(x.endpoint),
    });
    await B.pool.tokenChanged();
    const refusals = () => B.errors.filter((e): e is PeerClosed => e instanceof PeerClosed && e.peerId === X);
    await eventually(() => refusals().length >= 1);
    expect(B.logs).toEqual([]);
    await eventually(() => refusals().length >= 2);
    const line = `meddle: pool: ${shortId(X)} refused the connection: closed by peer: not a member (code 1)`;
    expect(B.logs).toEqual([line]);
    await eventually(() => refusals().length >= 3);
    expect(B.logs).toEqual([line]);
    expect(B.store.isMember(B.id)).toBe(true);
  } finally {
    await net.stop();
    await B.close();
  }
}, 15_000);

test("a task created on one node shows in the other node's count at once", async () => {
  await withNodes(2, async ([a, b]) => {
    const A = a!.node;
    await join(a!, b!);
    await onlineOn(a!, b!);
    await onlineOn(b!, a!);
    // Past the refresh both nodes made on joining: the next periodic one is 15 s away.
    await until(b!.pool.nodes, (rows) => rows.some((r) => r.nodeId === A.id && r.taskCount === 0));
    const nodeA = await a!.client.get(NodeObject, {});
    const began = Date.now();
    await nodeA.createTask({ title: "t", projectIds: [A.project.id] });
    await until(b!.pool.nodes, (rows) => rows.some((r) => r.nodeId === A.id && r.taskCount === 1));
    expect(Date.now() - began).toBeLessThan(3000);
  });
}, 15_000);

test("a node holds a peer's PeerObject: its projects with their home, and projectInfo; a non-peer is refused", async () => {
  await withNodes(2, async ([a, b]) => {
    const A = a!.node;
    const B = b!.node;
    await join(a!, b!);
    await onlineOn(a!, b!);
    await onlineOn(b!, a!);
    // B's client host for A comes up just after A shows online.
    const end = Date.now() + WAIT_MS;
    let peer: Awaited<ReturnType<typeof B.pool.peerRef<typeof PeerObject>>> | null = null;
    let last: unknown = null;
    while (peer === null) {
      peer = await B.pool.peerRef(A.id, PeerObject).catch((err: unknown) => { last = err; return null; });
      if (peer === null && Date.now() > end) throw new Error(`no PeerObject of A: ${String(last)}`);
      if (peer === null) await Bun.sleep(20);
    }
    try {
      expect(peer.variant).toBe("peer");
      if (peer.variant !== "peer") return;
      expect(peer.projects.value).toEqual([{ id: A.project.id, name: A.project.name, home: A.id }]);
      expect(typeof peer.claudeCodeVersion.value).toBe("string");
      expect(peer.hostsTasks.value).toBe(true);

      const folder = `${A.home}/second`;
      await initColocated(folder);
      const added = await addProjectFromFolder(A.cfg, A.db, folder, A.id, "second");
      const projects = await until(peer.projects, (list) => list.some((p) => p.id === added.id));
      expect(projects.find((p) => p.id === added.id)).toEqual({ id: added.id, name: "second", home: A.id });
      expect(await peer.projectInfo({ id: added.id })).toEqual({ id: added.id, name: "second", home: A.id });
      expect(await peer.projectInfo({ id: "nope" })).toBeNull();
    } finally {
      peer.release();
    }

    const owner = linkClient(A.host);
    try {
      let refusal: unknown = null;
      await owner.client.get(PeerObject, {}).catch((err: unknown) => { refusal = err; });
      expect(refusal).toMatchObject({ code: "forbidden" });
      expect(String((refusal as Error).message)).toContain("peers only");
    } finally {
      await owner.close();
    }
  });
}, 15_000);

test("peerRef rejects for a node this node is not connected to", async () => {
  const B = await startPoolNode();
  try {
    await B.host.ready();
    const other = "c".repeat(64);
    await expect(B.pool.peerRef(other, PeerObject)).rejects.toThrow(`not connected to ${shortId(other)}`);
  } finally {
    await B.close();
  }
}, 15_000);

test("a task created for a project a node has never seen clones it from home, starts at the home's trunk, and its turn reaches the home", async () => {
  const { A, B, close } = await twoPoolNodes({ extraEnv: { MEDDLE_FIXTURE_MEMORY: "1" } });
  const linked = linkClient(B.host);
  try {
    const id = A.project.id;
    const repoA = A.project.replica;
    const changeOf = async (cfg: typeof A.cfg, repo: string, rev: string) =>
      (await jj(["log", "-r", rev, "--no-graph", "-T", "change_id"], repo, cfg)).trim();
    await writeFile(`${repoA}/README`, "hello\n");
    await jj(["commit", "-m", "init"], repoA, A.cfg);
    await jj(["bookmark", "set", "main", "-r", "@-"], repoA, A.cfg);
    const main = await changeOf(A.cfg, repoA, "main");
    await peerReady(B, A);
    expect(getProject(B.db, id)).toBeNull();

    const nodeB = await linked.client.get(NodeObject, {});
    // Here, on B: placement would pick the project's home.
    const { manifest, nodeId } = await nodeB.createTask({ title: "t", projectIds: [id], node: "here" });
    expect(nodeId).toBe(B.id);
    expect(getProject(B.db, id)?.home).toBe(A.id);
    const workspace = joinPath(paths(B.cfg).task(manifest.id), "a");
    expect(await changeOf(B.cfg, workspace, "@-")).toBe(main);

    const result = new Promise<any>((res) => B.runner.onEvent((tid, _s, msg: any) => { if (tid === manifest.id && msg.type === "result") res(msg); }));
    const idle = new Promise<void>((res) => B.runner.onState((tid, s) => { if (tid === manifest.id && s === "idle") res(); }));
    await B.runner.prompt(manifest.id, "remember this from b");
    expect((await result).subtype).toBe("success");
    await idle;
    const change = await changeOf(B.cfg, workspace, "@");
    const onA = (await bookmarkList(repoA, A.cfg)).find((b) => b.name === `meddle/task/${manifest.id}/a` && b.remote === null);
    expect(onA?.changeId).toBe(change);
    expect(B.logs.filter((l) => l.startsWith("meddle: git:"))).toEqual([]);

    // A's next sync before a turn brings B's memory line into A's working copy.
    await syncMemoryBefore({ cfg: A.cfg, db: A.db, pool: A.pool }, id, false, (line) => A.logs.push(line));
    expect(await readFile(`${paths(A.cfg).memory(id)}/MEMORY.md`, "utf8")).toContain("remember this from b");
    expect(A.logs.filter((l) => l.startsWith("meddle: git:"))).toEqual([]);
  } finally {
    await linked.close();
    await close();
  }
}, 15_000);
