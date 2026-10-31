import { test, expect } from "bun:test";
import { openDb } from "../src/store/db";
import { PoolStore, type NodeSummary, type RosterRow, type WireAddr } from "../src/pool/store";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const D = "d".repeat(64);
const t1 = "2026-10-31T01:00:00.000Z";
const t2 = "2026-10-31T02:00:00.000Z";
const t3 = "2026-10-31T03:00:00.000Z";
const t4 = "2026-10-31T04:00:00.000Z";

function row(nodeId: string, status: RosterRow["status"], updatedAt: string, extra: Partial<RosterRow> = {}): RosterRow {
  return { nodeId, hostname: `host-${nodeId[0]}`, status, updatedAt, addedBy: A, summary: null, lastSeenAt: null, lastAddr: null, ...extra };
}

function summary(hostname: string, taskCount: number): NodeSummary {
  return { hostname, version: "0.1.0", claudeCodeVersion: "2.1.0", hostsTasks: true, taskCount };
}

test("ensurePool makes a pool of one and is idempotent", () => {
  const store = new PoolStore(openDb(":memory:"));
  const pool = store.ensurePool({ nodeId: A, hostname: "alpha" });
  expect(pool.poolId).toMatch(/^[0-9a-f]{32}$/);
  expect(pool.poolSecret).toMatch(/^[0-9a-f]{64}$/);
  expect(store.ensurePool({ nodeId: A, hostname: "alpha" })).toEqual(pool);
  expect(store.members().map((r) => r.nodeId)).toEqual([A]);
  expect(store.row(A)).toMatchObject({ hostname: "alpha", status: "member", addedBy: A });
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

test("replacePool swaps the identity and the roster wholesale", () => {
  const store = new PoolStore(openDb(":memory:"));
  store.ensurePool({ nodeId: A, hostname: "alpha" }, t1);
  store.upsert(row(C, "member", t1));
  const stale = store.createInvite();
  store.replacePool({ poolId: "p2", poolSecret: "s2", createdAt: t2 }, [row(A, "member", t2), row(B, "member", t2)]);
  expect(store.pool()).toEqual({ poolId: "p2", poolSecret: "s2", createdAt: t2 });
  expect(store.pool().poolId).toBe("p2");
  expect(store.roster()).toHaveLength(2);
  expect(store.row(C)).toBeNull();
  expect(store.consumeInvite(stale.code)).toBe(false);
});

test("invites are single use and expire after 24 hours", () => {
  const store = new PoolStore(openDb(":memory:"));
  const { code, expiresAt } = store.createInvite(new Date("2026-10-31T00:00:00Z"));
  expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(expiresAt).toBe("2026-11-01T00:00:00.000Z");
  expect(store.consumeInvite(code, new Date("2026-10-31T01:00:00Z"))).toBe(true);
  expect(store.consumeInvite(code, new Date("2026-10-31T01:00:00Z"))).toBe(false);
  const late = store.createInvite(new Date("2026-10-31T00:00:00Z"));
  expect(store.consumeInvite(late.code, new Date("2026-11-01T00:00:01Z"))).toBe(false);
  expect(store.consumeInvite("nope")).toBe(false);
});
