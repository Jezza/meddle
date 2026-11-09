import { test, expect } from "bun:test";
import { openDb } from "../src/store/db";
import { poolKey } from "../src/pool/secret";
import { PROVISIONAL_AT, PoolStore, type NodeSummary, type RosterRow, type WireAddr } from "../src/pool/store";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const D = "d".repeat(64);
const t1 = "2026-10-31T01:00:00.000Z";
const t2 = "2026-10-31T02:00:00.000Z";
const t3 = "2026-10-31T03:00:00.000Z";
const t4 = "2026-10-31T04:00:00.000Z";

function row(nodeId: string, status: RosterRow["status"], updatedAt: string, extra: Partial<RosterRow> = {}): RosterRow {
  return { nodeId, hostname: `host-${nodeId[0]}`, status, updatedAt, addedBy: A, summary: null, lastSeenAt: null, lastAddr: null,
    reachedAt: null, reachedAddr: null, ...extra };
}

function summary(hostname: string, taskCount: number): NodeSummary {
  return { hostname, version: "0.1.0", claudeCodeVersion: "2.1.0", hostsTasks: true, taskCount, running: 0, limit: 0, projects: [] };
}

test("ensurePool makes an empty pool (no secret) with this node alone, and is idempotent", () => {
  const store = new PoolStore(openDb(":memory:"));
  const pool = store.ensurePool({ nodeId: A, hostname: "alpha" }, t1);
  expect(pool).toEqual({ poolId: "", poolName: "default", poolSecret: "", createdAt: t1 });
  expect(store.hasSecret()).toBe(false);
  expect(store.ensurePool({ nodeId: A, hostname: "alpha" }, t2)).toEqual(pool);
  expect(store.members().map((r) => r.nodeId)).toEqual([A]);
  expect(store.row(A)).toMatchObject({ hostname: "alpha", status: "member", addedBy: A, updatedAt: t1 });
});

test("a pool row of an older meddle (no name) is reset to an empty pool", () => {
  const db = openDb(":memory:");
  db.query("INSERT INTO pool (pool_id, pool_secret, created_at) VALUES ('0123', 'old-secret', ?)").run(t1);
  const store = new PoolStore(db);
  expect(store.ensurePool({ nodeId: A, hostname: "alpha" }, t2)).toEqual({ poolId: "", poolName: "default", poolSecret: "", createdAt: t2 });
});

const SECRET = "correct-horse-battery-staple";

test("setSecret derives the pool id from the name and the secret and starts the roster over with this node", () => {
  const store = new PoolStore(openDb(":memory:"));
  store.ensurePool({ nodeId: A, hostname: "alpha" }, t1);
  store.upsert(row(B, "member", t1));
  store.upsert(row(C, "removed", t1));
  // Even this node's own row starts over: it is a member of the new pool from now, whatever the old pool said.
  store.remove(A, t1);
  const pool = store.setSecret({ nodeId: A, hostname: "alpha" }, "lab", SECRET, t2);
  expect(pool).toEqual({ poolId: poolKey("lab", SECRET).id, poolName: "lab", poolSecret: SECRET, createdAt: t2 });
  expect(pool.poolId).toMatch(/^[0-9a-f]{64}$/);
  expect(store.hasSecret()).toBe(true);
  expect(store.roster().map((r) => r.nodeId)).toEqual([A]);
  expect(store.row(A)).toMatchObject({ hostname: "alpha", status: "member", updatedAt: t2, addedBy: A });
  // The same name and secret give the same id anywhere; another secret another id.
  expect(new PoolStore(openDb(":memory:")).setSecret({ nodeId: B, hostname: "beta" }, "lab", SECRET, t3).poolId).toBe(pool.poolId);
  // The same secret again changes nothing: the roster stays.
  store.upsert(row(B, "member", t3));
  expect(store.setSecret({ nodeId: A, hostname: "alpha" }, "lab", SECRET, t4)).toEqual(pool);
  expect(store.roster().map((r) => r.nodeId)).toEqual([A, B]);
  expect(store.setSecret({ nodeId: A, hostname: "alpha" }, "lab", "other-secret-of-sixteen", t3).poolId).not.toBe(pool.poolId);
  expect(store.roster().map((r) => r.nodeId)).toEqual([A]);
  // On a database with no pool row yet (the CLI before the first serve), setSecret makes one.
  const fresh = new PoolStore(openDb(":memory:"));
  expect(fresh.setSecret({ nodeId: A, hostname: "alpha" }, "lab", SECRET, t2)).toEqual(pool);
  expect(fresh.row(A)).toMatchObject({ status: "member", updatedAt: t2 });
});

test("resetRoster leaves this node alone, a member from now; an older meddle's pool row reads as no secret", () => {
  const db = openDb(":memory:");
  const store = new PoolStore(db);
  store.ensurePool({ nodeId: A, hostname: "alpha" }, t1);
  store.upsert(row(B, "member", t1));
  store.remove(A, t2);
  store.resetRoster({ nodeId: A, hostname: "alpha" }, t3);
  expect(store.roster()).toEqual([{ ...row(A, "member", t3), hostname: "alpha" }]);
  const old = openDb(":memory:");
  old.query("INSERT INTO pool (pool_id, pool_secret, created_at) VALUES ('0123', 'old-secret', ?)").run(t1);
  expect(new PoolStore(old).pool()).toEqual({ poolId: "", poolName: "default", poolSecret: "", createdAt: t1 });
  expect(new PoolStore(old).hasSecret()).toBe(false);
});

test("ensureMember gives an unknown node a provisional member row that any row it sends of itself replaces", () => {
  const store = new PoolStore(openDb(":memory:"));
  store.ensurePool({ nodeId: A, hostname: "alpha" }, t1);
  expect(store.ensureMember(B, A)).toBe("member");
  expect(store.row(B)).toEqual({
    nodeId: B, hostname: B.slice(0, 10), status: "member", updatedAt: PROVISIONAL_AT, addedBy: A,
    summary: null, lastSeenAt: null, lastAddr: null, reachedAt: null, reachedAddr: null,
  });
  expect(store.ensureMember(B, A)).toBe("member");
  expect(store.merge([row(B, "member", t1, { hostname: "beta" })])).toBe(true);
  expect(store.row(B)).toMatchObject({ hostname: "beta", updatedAt: t1 });
  store.remove(B, t2);
  expect(store.ensureMember(B, A)).toBe("removed");
  expect(store.row(B)!.status).toBe("removed");
});

test("allow makes a removed node a member again, never older than its removal", () => {
  const store = new PoolStore(openDb(":memory:"));
  store.ensurePool({ nodeId: A, hostname: "alpha" }, t1);
  expect(store.allow(B, t2)).toBe(false);
  store.upsert(row(B, "member", t1));
  store.remove(B, t3);
  expect(store.allow(B, t2)).toBe(true);
  expect(store.row(B)).toMatchObject({ status: "member", updatedAt: "2026-10-31T03:00:00.001Z" });
  // The removal row, sent back by a peer, cannot undo it.
  expect(store.merge([row(B, "removed", t3)])).toBe(false);
  expect(store.isMember(B)).toBe(true);
  expect(store.allow(B, t4)).toBe(true);
  expect(store.row(B)!.updatedAt).toBe(t4);
});

test("merge is last-writer-wins per node and never resurrects a removed node", () => {
  const store = new PoolStore(openDb(":memory:"));
  store.ensurePool({ nodeId: A, hostname: "alpha" }, t1);
  store.upsert(row(B, "member", t2));
  store.upsert(row(C, "removed", t3));
  const remote = [row(B, "removed", t1), row(C, "member", t2), row(D, "member", t1)];
  expect(store.merge(remote)).toBe(true);
  expect(store.row(B)!.status).toBe("member");
  expect(store.row(C)!.status).toBe("removed");
  expect(store.row(D)!.status).toBe("member");
  expect(store.merge(remote)).toBe(false);
  expect(store.merge([{ ...store.row(B)!, status: "removed", updatedAt: t4 }])).toBe(true);
  expect(store.isMember(B)).toBe(false);
  expect(store.merge([{ ...store.row(B)!, status: "member", updatedAt: t4 }])).toBe(false);
  expect(store.isMember(B)).toBe(false);
  expect(store.roster().map((r) => r.nodeId)).toEqual([A, B, C, D]);
  expect(store.members().map((r) => r.nodeId)).toEqual([A, D]);
});

test("remove marks a node removed at the given time", () => {
  const store = new PoolStore(openDb(":memory:"));
  store.ensurePool({ nodeId: A, hostname: "alpha" }, t1);
  store.upsert(row(B, "member", t1));
  store.remove(B, t2);
  expect(store.row(B)).toMatchObject({ status: "removed", updatedAt: t2 });
  expect(store.isMember(B)).toBe(false);
  expect(store.row(C)).toBeNull();
});

test("a removal is never older than the row it removes", () => {
  const store = new PoolStore(openDb(":memory:"));
  store.ensurePool({ nodeId: A, hostname: "alpha" }, t1);
  // B's row was stamped by a node whose clock is ahead of this one's.
  store.upsert(row(B, "member", t3));
  store.remove(B, t2);
  expect(store.row(B)).toMatchObject({ status: "removed", updatedAt: "2026-10-31T03:00:00.001Z" });
  // So the member row it removed, sent back by a peer, cannot resurrect it.
  expect(store.merge([row(B, "member", t3)])).toBe(false);
  expect(store.isMember(B)).toBe(false);
});

test("seen updates summary, lastSeenAt and lastAddr without touching updatedAt; merge takes the newer lastSeenAt", () => {
  const store = new PoolStore(openDb(":memory:"));
  store.ensurePool({ nodeId: A, hostname: "alpha" }, t1);
  store.upsert(row(B, "member", t1));
  const addr: WireAddr = { id: B, relay: null, direct: ["127.0.0.1:4000"] };
  store.seen(B, t3, summary("beta", 2), addr);
  expect(store.row(B)).toEqual({ ...row(B, "member", t1), summary: summary("beta", 2), lastSeenAt: t3, lastAddr: addr });
  const before = store.row(B)!;
  expect(store.merge([{ ...before, lastSeenAt: t2, summary: summary("beta", 9) }])).toBe(false);
  expect(store.row(B)).toEqual(before);
  expect(store.merge([{ ...before, lastSeenAt: t4, summary: summary("beta", 9), lastAddr: null }])).toBe(true);
  expect(store.row(B)).toEqual({ ...before, lastSeenAt: t4, summary: summary("beta", 9), lastAddr: null });
});

test("a stored or received summary's projects read as they came, with no sync branches added", () => {
  const db = openDb(":memory:");
  const store = new PoolStore(db);
  store.ensurePool({ nodeId: A, hostname: "alpha" }, t1);
  store.upsert(row(B, "member", t1));
  const stored = JSON.stringify({ ...summary("beta", 2), projects: [{ id: "p1", name: "x", home: B }] });
  db.query("UPDATE roster SET summary = ? WHERE node_id = ?").run(stored, B);
  expect(store.row(B)!.summary!.projects).toEqual([{ id: "p1", name: "x", home: B }]);
  const received = { ...summary("beta", 3), projects: [{ id: "p2", name: "y", home: B, defaultBranch: "main" }] };
  store.seen(B, t3, received, null);
  expect(store.row(B)!.summary!.projects).toEqual([{ id: "p2", name: "y", home: B, defaultBranch: "main" }]);
});
