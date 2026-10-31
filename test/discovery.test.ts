import { test, expect } from "bun:test";
import { Discovery, fromLighthouseAddr, toLighthouseAddr, topicFor } from "../src/pool/discovery";
import type { PoolIdentity } from "../src/pool/store";
import { startFakeLighthouse, type FakeLighthouse } from "./fake-lighthouse";
import { endpointPair, twoNodes } from "./pool-helpers";

const A = "a".repeat(64);
const POOL: PoolIdentity = { poolId: "0".repeat(32), poolSecret: "1".repeat(64), createdAt: "2026-10-31T00:00:00.000Z" };

async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(10);
  }
}

test("address conversions round-trip", () => {
  const w = { id: A, relay: "https://r.example/", direct: ["127.0.0.1:1", "[::1]:2"] };
  expect(fromLighthouseAddr(toLighthouseAddr(w))).toEqual(w);
  expect(toLighthouseAddr(w).addrs).toEqual([{ Ip: "127.0.0.1:1" }, { Ip: "[::1]:2" }, { Relay: "https://r.example/" }]);
  const bare = { id: A, relay: null, direct: [] };
  expect(toLighthouseAddr(bare)).toEqual({ id: A, addrs: [] });
  expect(fromLighthouseAddr(toLighthouseAddr(bare))).toEqual(bare);
});

test("two nodes find each other through the lighthouse and connect without being given addresses", async () => {
  const lighthouse = await startFakeLighthouse();
  const { a, b, close } = await twoNodes({ offerAddresses: false });
  const discoveries: Discovery[] = [];
  const errors: string[] = [];
  try {
    await Bun.sleep(300);
    expect(a.net.isOnline(b.id) || b.net.isOnline(a.id)).toBe(false);

    const pool = a.store.pool();
    expect(b.store.pool()).toEqual(pool);
    for (const n of [a, b]) {
      const d = new Discovery({
        endpoint: n.net.endpoint, identity: n.identity, pool,
        lighthouseUrl: () => lighthouse.url,
        pollMs: 1000,
        onPeers: (peers) => { for (const p of peers) n.net.offerAddress(p); },
        onError: (message) => { errors.push(message); },
      });
      discoveries.push(d);
      d.start();
    }
    await until(() => a.net.isOnline(b.id) && b.net.isOnline(a.id));
    expect(discoveries.every((d) => d.joined)).toBe(true);

    const topic = topicFor(pool).id;
    const topics = lighthouse.topics();
    expect([...topics.keys()]).toEqual([topic]);
    expect([...topics.get(topic)!.keys()].sort()).toEqual([a.id, b.id].sort());

    await Promise.all(discoveries.map((d) => d.stop()));
    expect(lighthouse.topics().get(topic)?.size ?? 0).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await Promise.all(discoveries.map((d) => d.stop()));
    await close();
    lighthouse.stop();
  }
}, 15_000);

test("an unreachable lighthouse does not stop the node and is retried; a hanging one times out", async () => {
  const pair = await endpointPair();
  const lighthouses: FakeLighthouse[] = [];
  const discoveries: Discovery[] = [];
  try {
    let url = "http://127.0.0.1:1";
    const errors: string[] = [];
    const down = new Discovery({
      endpoint: pair.a.endpoint, identity: pair.a.identity, pool: POOL,
      lighthouseUrl: () => url,
      pollMs: 500,
      onPeers: () => {},
      onError: (message) => { errors.push(message); },
      backoff: { initialMs: 50, maxMs: 100 },
    });
    discoveries.push(down);
    const began = Date.now();
    down.start();
    expect(Date.now() - began).toBeLessThan(50);
    await Bun.sleep(300);
    expect(down.joined).toBe(false);
    expect(errors).toHaveLength(1);

    const up = await startFakeLighthouse();
    lighthouses.push(up);
    url = up.url;
    await until(() => down.joined);
    expect(errors).toHaveLength(1);

    const hanging = await startFakeLighthouse({ hang: true });
    lighthouses.push(hanging);
    const timeouts: string[] = [];
    const stuck = new Discovery({
      endpoint: pair.b.endpoint, identity: pair.b.identity, pool: POOL,
      lighthouseUrl: () => hanging.url,
      pollMs: 500,
      onPeers: () => {},
      onError: (message) => { timeouts.push(message); },
      backoff: { initialMs: 50, maxMs: 100 },
      requestTimeoutMs: 200,
    });
    discoveries.push(stuck);
    stuck.start();
    await Bun.sleep(600);
    expect(stuck.joined).toBe(false);
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]).toContain("timed out");
  } finally {
    await Promise.all(discoveries.map((d) => d.stop()));
    await pair.close();
    for (const l of lighthouses) l.stop();
  }
});

test("a lighthouse that grants a malformed ttl is not re-announced to in a loop", async () => {
  const pair = await endpointPair();
  const lighthouses = [await startFakeLighthouse({ grantedTtl: "zzz" }), await startFakeLighthouse({ grantedTtl: undefined })];
  const discoveries: Discovery[] = [];
  try {
    for (const [i, lighthouse] of lighthouses.entries()) {
      const node = i === 0 ? pair.a : pair.b;
      const d = new Discovery({
        endpoint: node.endpoint, identity: node.identity, pool: POOL,
        lighthouseUrl: () => lighthouse.url,
        pollMs: 60_000,
        onPeers: () => {},
        backoff: { initialMs: 50, maxMs: 100 },
      });
      discoveries.push(d);
      d.start();
    }
    await until(() => discoveries.every((d) => d.joined));
    await Bun.sleep(500);
    expect(lighthouses.map((l) => l.announces())).toEqual([1, 1]);
  } finally {
    await Promise.all(discoveries.map((d) => d.stop()));
    await pair.close();
    for (const l of lighthouses) l.stop();
  }
});
