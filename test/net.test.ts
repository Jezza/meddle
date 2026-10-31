import { test, expect } from "bun:test";
import { randomBytes } from "node:crypto";
import { ALPN_POOL, writeLine } from "../src/pool/frames";
import { PoolNet, fromEndpoint, toEndpointAddr, type NetDeps, type PeerStream } from "../src/pool/net";
import { endpointPair, type TestNode } from "./pool-helpers";

const fast = { initialMs: 50, maxMs: 200 };

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(5);
  }
}

/** A PoolNet on `node` that records its peer events, streams and errors. */
function netOf(node: TestNode, deps: Partial<NetDeps> = {}) {
  const peers: [string, boolean][] = [];
  const streams: PeerStream[] = [];
  const errors: string[] = [];
  const net = new PoolNet({
    endpoint: node.endpoint, selfId: node.identity.id, isMember: () => true, onJoin: async () => {},
    onError: (err) => errors.push(String(err)), backoff: fast, ...deps,
  });
  net.onPeer((id, online) => peers.push([id, online]));
  net.onStream((s) => streams.push(s));
  return { net, peers, streams, errors, id: node.identity.id };
}

/** Both ends of a pair as PoolNets, `lo` the one with the smaller id (the dialer). */
async function poolPair(isMember: { lo?: (id: string) => boolean; hi?: (id: string) => boolean } = {}) {
  const pair = await endpointPair();
  const [loNode, hiNode] = pair.a.identity.id < pair.b.identity.id ? [pair.a, pair.b] : [pair.b, pair.a];
  const lo = netOf(loNode, isMember.lo ? { isMember: isMember.lo } : {});
  const hi = netOf(hiNode, isMember.hi ? { isMember: isMember.hi } : {});
  lo.net.start();
  hi.net.start();
  lo.net.offerAddress(fromEndpoint(hiNode.endpoint));
  lo.net.watch(hi.id);
  hi.net.watch(lo.id);
  await until(() => lo.net.isOnline(hi.id) && hi.net.isOnline(lo.id));
  return {
    lo, hi,
    async stop() { await Promise.all([lo.net.stop(), hi.net.stop()]); await pair.close(); },
  };
}

test("a member connects, the smaller id dials, streams carry headers both ways", async () => {
  const { lo, hi, stop } = await poolPair();
  try {
    expect(lo.peers).toEqual([[hi.id, true]]);
    expect(hi.peers).toEqual([[lo.id, true]]);
    expect(lo.net.online()).toEqual([hi.id]);
    expect(hi.net.online()).toEqual([lo.id]);

    const mine = await lo.net.openStream(hi.id, { stream: "x", n: 1 });
    expect(mine.peerId).toBe(hi.id);
    await until(() => hi.streams.length === 1);
    const theirs = hi.streams[0]!;
    expect(theirs.peerId).toBe(lo.id);
    expect(theirs.header).toEqual({ stream: "x", n: 1 });
    await writeLine(theirs.stream.send, "pong");
    expect(await mine.reader.readLine()).toBe("pong");

    const back = await hi.net.openStream(lo.id, { stream: "y" });
    await until(() => lo.streams.length === 1);
    expect(lo.streams[0]!.peerId).toBe(hi.id);
    expect(lo.streams[0]!.header).toEqual({ stream: "y" });
    await writeLine(back.stream.send, "ping");
    expect(await lo.streams[0]!.reader.readLine()).toBe("ping");

    let settled = false;
    void mine.closed.then(() => { settled = true; });
    void theirs.closed.then(() => { settled = true; });
    await Bun.sleep(50);
    expect(settled).toBe(false);
    expect(lo.peers).toEqual([[hi.id, true]]);
    expect(lo.errors).toEqual([]);
    expect(hi.errors).toEqual([]);
  } finally {
    await stop();
  }
});

test("a non-member is refused before any stream is read", async () => {
  const pair = await endpointPair();
  const b = netOf(pair.b, { isMember: (id) => id !== pair.a.identity.id });
  b.net.start();
  try {
    const conn = await pair.a.endpoint.connect(toEndpointAddr(fromEndpoint(pair.b.endpoint)), ALPN_POOL);
    await conn.openBi().then((s) => writeLine(s.send, '{"stream":"x"}')).catch(() => {});
    const reason = await conn.closed();
    expect(reason).toContain("not a member");
    expect(reason).toContain("(code 1)");
    await Bun.sleep(50);
    expect(b.peers).toEqual([]);
    expect(b.streams).toEqual([]);
    expect(b.net.online()).toEqual([]);
  } finally {
    await b.net.stop();
    await pair.close();
  }
});

test("unwatch closes the connection with the reason and the other side sees it", async () => {
  let hiAdmitsLo = true;
  const { lo, hi, stop } = await poolPair({ hi: () => hiAdmitsLo });
  try {
    const mine = await lo.net.openStream(hi.id, { stream: "x" });
    await hi.net.openStream(lo.id, { stream: "y" });
    await until(() => lo.streams.length === 1);
    const theirs = lo.streams[0]!;

    hiAdmitsLo = false;
    hi.net.unwatch(lo.id, "removed");
    expect(hi.peers).toEqual([[lo.id, true], [lo.id, false]]);
    expect(hi.net.isOnline(lo.id)).toBe(false);
    await until(() => lo.peers.length === 2);
    expect(lo.peers).toEqual([[hi.id, true], [hi.id, false]]);
    for (const s of [mine, theirs]) {
      const reason = await s.closed;
      expect(reason).toContain("removed");
      expect(reason).toContain("(code 1)");
    }

    await Bun.sleep(500);
    expect(lo.peers).toEqual([[hi.id, true], [hi.id, false]]);
    expect(hi.peers).toEqual([[lo.id, true], [lo.id, false]]);
    expect(lo.net.isOnline(hi.id)).toBe(false);
    expect(lo.errors.filter((e) => e.includes("not a member")).length).toBeGreaterThan(0);
  } finally {
    await stop();
  }
});

test("a dropped connection is noticed and redialled", async () => {
  const { lo, hi, stop } = await poolPair();
  try {
    hi.net.unwatch(lo.id, "removed");
    hi.net.watch(lo.id);
    await until(() => lo.peers.length === 3 && hi.peers.length === 3);
    expect(lo.peers).toEqual([[hi.id, true], [hi.id, false], [hi.id, true]]);
    expect(hi.peers).toEqual([[lo.id, true], [lo.id, false], [lo.id, true]]);
    expect(lo.net.isOnline(hi.id)).toBe(true);
    expect(hi.net.isOnline(lo.id)).toBe(true);
    const s = await lo.net.openStream(hi.id, { stream: "x" });
    await until(() => hi.streams.length === 1);
    expect(hi.streams[0]!.header).toEqual({ stream: "x" });
    void s;
  } finally {
    await stop();
  }
});

test("openStream on an offline peer rejects", async () => {
  const pair = await endpointPair();
  const a = netOf(pair.a);
  a.net.start();
  try {
    const unknown = randomBytes(32).toString("hex");
    await expect(a.net.openStream(unknown, { stream: "x" })).rejects.toThrow(`not connected to ${unknown.slice(0, 10)}`);
  } finally {
    await a.net.stop();
    await pair.close();
  }
});
