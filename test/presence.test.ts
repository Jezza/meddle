// test/presence.test.ts — last heard of, gone, link reports and address gossip.
import { test, expect } from "bun:test";
import { fromEndpoint } from "../src/pool/net";
import { Presence, type Clocks } from "../src/pool/presence";
import { startPool, type PoolRuntime } from "../src/pool/runtime";
import { PoolStore, newestAddr, type RosterRow } from "../src/pool/store";
import { PoolSettings } from "../src/pool/settings";
import { loadConfig } from "../src/config";
import { openDb } from "../src/store/db";
import { linkNodes, poolSummaryOf, startPoolNode } from "./pool-helpers";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

/** Clocks a test moves by hand: `advance` moves both, `sleep` only the wall clock (as a suspended machine sees it). */
function fakeClocks(start = Date.parse("2026-11-04T00:00:00.000Z")) {
  let wall = start;
  let mono = 0;
  const clocks: Clocks = { now: () => wall, monotonic: () => mono };
  return {
    clocks,
    advance(ms: number) { wall += ms; mono += ms; },
    sleep(ms: number) { wall += ms; },
    iso: () => new Date(wall).toISOString(),
  };
}

const at = (reachedAt: string | null, nodeId = B) => ({ nodeId, reachedAt });
const MIN = 60_000;

test("a member is gone once nothing was heard of it for the threshold, and never while connected", () => {
  const t = fakeClocks();
  const p = new Presence(t.clocks);
  p.know([B]);
  const heard = t.iso();
  t.advance(10 * MIN);
  p.tick(true);
  expect(p.gone(at(heard), false, 15 * MIN)).toBe(false);
  t.advance(6 * MIN);
  p.tick(true);
  expect(p.gone(at(heard), false, 15 * MIN)).toBe(true);
  expect(p.gone(at(heard), true, 15 * MIN)).toBe(false);
  // A fresher report of a link to it, or no threshold at all, and it is not gone.
  expect(p.gone(at(t.iso()), false, 15 * MIN)).toBe(false);
  expect(p.gone(at(heard), false, null)).toBe(false);
});

test("a member never heard of is not gone until the threshold after this process first knew of it", () => {
  const t = fakeClocks();
  const p = new Presence(t.clocks);
  t.advance(30 * MIN);
  p.know([C]);
  p.tick(true);
  expect(p.gone(at(null, C), false, 15 * MIN)).toBe(false);
  t.advance(16 * MIN);
  p.tick(true);
  expect(p.gone(at(null, C), false, 15 * MIN)).toBe(true);
});

test("a lighthouse listing counts as hearing of a member", () => {
  const t = fakeClocks();
  const p = new Presence(t.clocks);
  p.know([B]);
  t.advance(20 * MIN);
  p.listedNow([B]);
  expect(p.gone(at(null), false, 15 * MIN)).toBe(false);
  expect(p.lastHeard(at(null), false)).toBe(t.clocks.now());
  t.advance(16 * MIN);
  p.tick(true);
  expect(p.gone(at(null), false, 15 * MIN)).toBe(true);
});

test("a node cut off from everyone forgets nobody: the clock runs only while it hears of the pool", () => {
  const t = fakeClocks();
  const p = new Presence(t.clocks);
  p.know([B]);
  const heard = t.iso();
  t.advance(MIN);
  p.tick(true);
  // Alone for an hour: no connection, no lighthouse.
  for (let i = 0; i < 60; i++) {
    t.advance(MIN);
    p.tick(false);
  }
  expect(p.gone(at(heard), false, 15 * MIN)).toBe(false);
  // Back in touch (another member reachable), and B still unheard of: the threshold runs from the last contact.
  p.tick(true);
  expect(p.gone(at(heard), false, 15 * MIN)).toBe(true);
});

test("after the machine slept, nobody is gone until the threshold has passed awake", () => {
  const t = fakeClocks();
  const p = new Presence(t.clocks);
  p.know([B]);
  const heard = t.iso();
  t.sleep(8 * 60 * MIN);
  p.tick(true);
  expect(p.gone(at(heard), false, 15 * MIN)).toBe(false);
  t.advance(16 * MIN);
  p.tick(true);
  expect(p.gone(at(heard), false, 15 * MIN)).toBe(true);
});

test("link reports merge newest first; a report from the future or of no time is dropped; newestAddr picks the newer word", () => {
  const store = new PoolStore(openDb(":memory:"));
  store.ensurePool({ nodeId: A, hostname: "alpha" });
  store.ensureMember(B, A);
  const old = { id: B, relay: null, direct: ["10.0.0.2:1000"] };
  const moved = { id: B, relay: null, direct: ["10.0.0.2:2000"] };
  expect(store.reached(B, "2026-11-04T00:00:00.000Z", old)).toBe(true);
  expect(store.reached(B, "2026-11-03T00:00:00.000Z", moved)).toBe(false);
  expect(store.row(B)?.reachedAddr).toEqual(old);
  // A report with no address keeps the address but moves the time.
  expect(store.reached(B, "2026-11-04T00:01:00.000Z", { id: B, relay: null, direct: [] })).toBe(true);
  expect(store.row(B)).toMatchObject({ reachedAt: "2026-11-04T00:01:00.000Z", reachedAddr: old });

  const now = Date.parse("2026-11-04T00:05:00.000Z");
  const remote = (reachedAt: string, reachedAddr = moved): RosterRow => ({ ...store.row(B)!, reachedAt, reachedAddr });
  expect(store.merge([remote("2026-11-04T00:00:30.000Z")], now)).toBe(false);
  expect(store.merge([remote("2026-11-04T00:02:00.000Z")], now)).toBe(true);
  expect(store.row(B)).toMatchObject({ reachedAt: "2026-11-04T00:02:00.000Z", reachedAddr: moved });
  expect(store.merge([remote("2027-01-01T00:00:00.000Z", old)], now)).toBe(false);
  expect(store.merge([remote("yesterday", old)], now)).toBe(false);
  expect(store.row(B)?.reachedAddr).toEqual(moved);

  const self = { id: B, relay: null, direct: ["10.0.0.2:3000"] };
  expect(newestAddr({ lastSeenAt: "2026-11-04T00:03:00.000Z", lastAddr: self, reachedAt: "2026-11-04T00:02:00.000Z", reachedAddr: moved })).toEqual(self);
  expect(newestAddr({ lastSeenAt: "2026-11-04T00:01:00.000Z", lastAddr: self, reachedAt: "2026-11-04T00:02:00.000Z", reachedAddr: moved })).toEqual(moved);
  expect(newestAddr({ lastSeenAt: null, lastAddr: null, reachedAt: null, reachedAddr: null })).toBeNull();
});

test("roster.forget: 0 never forgets, at least 60 s otherwise; MEDDLE_FORGET_MS wins", () => {
  const db = openDb(":memory:");
  const cfg = loadConfig({ HOME: "/nonexistent" });
  const settings = new PoolSettings(db, cfg, A, () => {});
  expect(settings.forgetAfterMs()).toBe(900_000);
  settings.set("roster.forget", "120");
  expect(settings.forgetAfterMs()).toBe(120_000);
  settings.set("roster.forget", "0");
  expect(settings.forgetAfterMs()).toBeNull();
  expect(() => settings.set("roster.forget", "30")).toThrow("roster.forget must be 0 or at least 60 (seconds)");
  expect(() => settings.set("roster.forget", "soon")).toThrow("roster.forget must be 0 or at least 60 (seconds)");
  const quick = new PoolSettings(db, loadConfig({ HOME: "/nonexistent", MEDDLE_FORGET_MS: "1500" }), A, () => {});
  expect(quick.forgetAfterMs()).toBe(1500);
});

async function eventually(cond: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(20);
  }
}

test("a node back at a new address is found through one member; one gone past roster.forget is not dialled, and rejoins by proving the secret", async () => {
  const env = { MEDDLE_FORGET_MS: "1500" };
  const [a, b, c] = [await startPoolNode(undefined, env), await startPoolNode(undefined, env), await startPoolNode(undefined, env)];
  let c2: PoolRuntime | null = null;
  try {
    await linkNodes(a, b);
    await linkNodes(a, c);
    await linkNodes(b, c);
    await eventually(() => [a, b, c].every((x) => [a, b, c].every((y) => x === y || x.net.isOnline(y.id))));

    // C goes away and comes back on a new port, knowing only A's address: it reaches A, A reports where it sees C,
    // and B, which only had C's old address, finds C at the new one.
    const oldAddr = fromEndpoint(c.net.endpoint);
    await c.pool.stop();
    c.db.query("UPDATE roster SET last_addr = NULL, reached_addr = NULL WHERE node_id = ?").run(b.id);
    c2 = await startPool(c.cfg, c.db, poolSummaryOf(c.cfg, c.db), { log: () => {} });
    const newAddr = fromEndpoint(c2.endpoint);
    expect(newAddr.direct).not.toEqual(oldAddr.direct);
    await eventually(() => a.net.isOnline(c.id) && b.net.isOnline(c.id) && c2!.net.isOnline(b.id), 15_000);
    // What A reports is every address its endpoint knows for C (iroh keeps the old one too): the new one among them.
    expect(a.store.row(c.id)?.reachedAddr?.direct).toEqual(expect.arrayContaining(newAddr.direct));
    expect(newestAddr(b.store.row(c.id)!)?.direct).toEqual(expect.arrayContaining(newAddr.direct));

    // C goes away for good: once unheard of for 1.5 s, A and B count it gone and stop dialling it.
    await c2.stop();
    await eventually(async () => {
      await a.pool.refresh();
      await b.pool.refresh();
      return a.pool.isGone(c.id) && b.pool.isGone(c.id);
    });
    expect(a.net.isWatched(c.id)).toBe(false);
    expect(b.net.isWatched(c.id)).toBe(false);
    // Still in the roster, as a member: tasks, projects and placement keep its id.
    expect(a.store.row(c.id)?.status).toBe("member");

    // It comes back: it dials the members it knows, proves the secret, and is online and not gone.
    c2 = await startPool(c.cfg, c.db, poolSummaryOf(c.cfg, c.db), { log: () => {} });
    await eventually(() => a.net.isOnline(c.id) && b.net.isOnline(c.id), 15_000);
    await a.pool.refresh();
    expect(a.pool.isGone(c.id)).toBe(false);
    expect(a.net.isWatched(c.id)).toBe(true);
  } finally {
    await c2?.stop();
    for (const n of [a, b, c]) await n.close();
  }
}, 60_000);
