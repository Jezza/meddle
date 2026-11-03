import { test, expect } from "bun:test";
import { randomBytes } from "node:crypto";
import type { Connection } from "@number0/iroh";
import { ALPN_POOL, StreamReader, writeLine } from "../src/pool/frames";
import { PeerClosed, PoolNet, fromEndpoint, toEndpointAddr, type NetDeps, type PeerStream } from "../src/pool/net";
import { poolKey, proofFor, verifyProof } from "../src/pool/secret";
import { POOL_KEY, endpointPair, proofDeps, type TestNode } from "./pool-helpers";

const fast = { initialMs: 50, maxMs: 200 };

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(5);
  }
}

/** A PoolNet on `node` that records its peer events, streams (those `claims` takes; all by default) and errors. */
function netOf(node: TestNode, deps: Partial<NetDeps> = {}, claims: (s: PeerStream) => boolean = () => true) {
  const peers: [string, boolean][] = [];
  const streams: PeerStream[] = [];
  const errors: string[] = [];
  const raw: unknown[] = [];
  const net = new PoolNet({
    endpoint: node.endpoint, selfId: node.identity.id, ...proofDeps(node.identity.id),
    onError: (err) => { raw.push(err); errors.push(String(err)); }, backoff: fast, ...deps,
  });
  net.onPeer((id, online) => peers.push([id, online]));
  net.onStream((s) => {
    if (!claims(s)) return false;
    streams.push(s);
    return true;
  });
  return { net, peers, streams, errors, raw, id: node.identity.id };
}

/** Both ends of a pair as PoolNets, `lo` the one with the smaller id (the dialer). */
async function poolPair(admit: { lo?: (id: string) => boolean; hi?: (id: string) => boolean } = {}, claims?: (s: PeerStream) => boolean) {
  const pair = await endpointPair();
  const [loNode, hiNode] = pair.a.identity.id < pair.b.identity.id ? [pair.a, pair.b] : [pair.b, pair.a];
  const lo = netOf(loNode, admit.lo ? { admit: admit.lo } : {}, claims);
  const hi = netOf(hiNode, admit.hi ? { admit: admit.hi } : {}, claims);
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

test("a dialer that proved the secret but is not admitted gets the acceptor's proof and the verdict, and no stream is read", async () => {
  const pair = await endpointPair();
  const b = netOf(pair.b, { admit: (id) => id !== pair.a.identity.id });
  b.net.start();
  try {
    const conn = await pair.a.endpoint.connect(toEndpointAddr(fromEndpoint(pair.b.endpoint)), ALPN_POOL);
    const proof = await conn.openUni();
    await writeLine(proof, proofFor(POOL_KEY, pair.a.identity.id, pair.b.identity.id));
    await proof.finish();
    await conn.openBi().then((s) => writeLine(s.send, '{"stream":"x"}')).catch(() => {});
    const answer = new StreamReader(await conn.acceptUni());
    const theirs = await answer.readLine();
    expect(verifyProof(POOL_KEY.id, pair.b.identity.id, pair.a.identity.id, theirs ?? "")).toBe(true);
    expect(await answer.readLine()).toBe("not a member");
    // The acceptor waits for the dialer's close before its own, so that the verdict is read.
    await Bun.sleep(100);
    expect(b.net.online()).toEqual([]);
    conn.close(0n, Array.from(new TextEncoder().encode("bye")));
    await Bun.sleep(50);
    expect(b.peers).toEqual([]);
    expect(b.streams).toEqual([]);
    expect(b.net.online()).toEqual([]);
  } finally {
    await b.net.stop();
    await pair.close();
  }
});

test("a dialer that sends no proof, or another pool's, is refused as bad proof; so is an acceptor of another pool", async () => {
  const pair = await endpointPair();
  const b = netOf(pair.b, { admitTimeoutMs: 300 });
  b.net.start();
  try {
    // No proof at all: refused once the bound passes.
    const silent = await pair.a.endpoint.connect(toEndpointAddr(fromEndpoint(pair.b.endpoint)), ALPN_POOL);
    expect(await silent.closed()).toBe("closed by peer: bad proof (code 1)");

    // A proof of another pool's secret.
    const other = poolKey("default", "another-pool-secret");
    const wrong = await pair.a.endpoint.connect(toEndpointAddr(fromEndpoint(pair.b.endpoint)), ALPN_POOL);
    const proof = await wrong.openUni();
    await writeLine(proof, proofFor(other, pair.a.identity.id, pair.b.identity.id));
    await proof.finish();
    expect(await wrong.closed()).toBe("closed by peer: bad proof (code 1)");
    expect(b.peers).toEqual([]);
    expect(b.net.online()).toEqual([]);
  } finally {
    await b.net.stop();
    await pair.close();
  }

  // The dialer checks the acceptor too: one that admits anyone but proves another pool's secret is closed `bad proof`
  // and reported, and never online on the dialer's side.
  const pair2 = await endpointPair();
  const [loNode, hiNode] = ordered(pair2);
  const lo = netOf(loNode, { admitTimeoutMs: 300 });
  const other = poolKey("default", "another-pool-secret");
  const hi = netOf(hiNode, { prove: (peer) => proofFor(other, hiNode.identity.id, peer), verify: () => true, admitTimeoutMs: 300 });
  lo.net.start();
  hi.net.start();
  try {
    lo.net.offerAddress(fromEndpoint(hiNode.endpoint));
    lo.net.watch(hi.id);
    await until(() => lo.errors.filter((e) => e.includes("did not prove the pool secret")).length >= 2);
    expect(lo.peers).toEqual([]);
    expect(lo.net.isOnline(hi.id)).toBe(false);
    // The acceptor had admitted the dialer and seen it go: its close carries the dialer's verdict.
    await until(() => hi.peers.length >= 2);
    expect(hi.peers.slice(0, 2)).toEqual([[lo.id, true], [lo.id, false]]);
    expect(hi.net.isOnline(lo.id)).toBe(false);
  } finally {
    await Promise.all([lo.net.stop(), hi.net.stop()]);
    await pair2.close();
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

test("unwatch with bye closes with code 0 and reports nothing; a code-1 refusal is reported naming the peer", async () => {
  let hiAdmitsLo = true;
  const { lo, hi, stop } = await poolPair({ hi: () => hiAdmitsLo });
  try {
    const s = await lo.net.openStream(hi.id, { stream: "x" });
    hiAdmitsLo = false;
    hi.net.unwatch(lo.id, "bye");
    expect(await s.closed).toBe("closed by peer: bye (code 0)");
    await until(() => lo.raw.some((e) => e instanceof PeerClosed));
    expect(lo.errors.some((e) => e.includes("bye"))).toBe(false);
    const refusal = lo.raw.find((e) => e instanceof PeerClosed) as PeerClosed;
    expect(refusal.peerId).toBe(hi.id);
    expect(refusal.reason).toBe("closed by peer: not a member (code 1)");
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

/** `pair`'s nodes ordered so that `lo` has the smaller id (the dialer). */
function ordered(pair: { a: TestNode; b: TestNode }): [TestNode, TestNode] {
  return pair.a.identity.id < pair.b.identity.id ? [pair.a, pair.b] : [pair.b, pair.a];
}

test("a dialer refused before the acceptor proved itself reports a failed dial, never the peer's word", async () => {
  // A node that holds no secret (it cannot prove itself) refuses every dial with `no pool secret`.
  const pair = await endpointPair();
  const [loNode, hiNode] = ordered(pair);
  const lo = netOf(loNode, { admitTimeoutMs: 300 });
  const hi = netOf(hiNode, { prove: () => null });
  lo.net.start();
  hi.net.start();
  try {
    lo.net.offerAddress(fromEndpoint(hiNode.endpoint));
    lo.net.watch(hi.id);
    await until(() => lo.errors.filter((e) => e.includes("before proving the pool secret")).length >= 2);
    expect(lo.raw.some((e) => e instanceof PeerClosed)).toBe(false);
    expect(lo.errors[0]).toContain("closed by peer: no pool secret (code 1)");
    expect(lo.peers).toEqual([]);
  } finally {
    await Promise.all([lo.net.stop(), hi.net.stop()]);
    await pair.close();
  }
});

test("an admit that throws closes the connection and the dialer stays offline", async () => {
  const pair = await endpointPair();
  const [loNode, hiNode] = ordered(pair);
  const lo = netOf(loNode);
  const hi = netOf(hiNode, { admit: () => { throw new Error("roster unavailable"); } });
  lo.net.start();
  hi.net.start();
  try {
    lo.net.offerAddress(fromEndpoint(hiNode.endpoint));
    lo.net.watch(hi.id);
    await until(() => lo.errors.filter((e) => e.includes("not a member")).length >= 2);
    expect(hi.errors.some((e) => e.includes("roster unavailable"))).toBe(true);
    expect(lo.peers).toEqual([]);
    expect(hi.peers).toEqual([]);
    expect(lo.net.isOnline(hi.id)).toBe(false);
  } finally {
    await Promise.all([lo.net.stop(), hi.net.stop()]);
    await pair.close();
  }
});

test("an acceptor that neither admits nor closes is given up on within the bound and redialled", async () => {
  const pair = await endpointPair();
  const [loNode, hiNode] = ordered(pair);
  const held: Connection[] = [];
  const holding = (async () => {
    for (;;) {
      const incoming = await hiNode.endpoint.acceptNext();
      if (!incoming) return;
      held.push(await (await incoming.accept()).connect());
    }
  })();
  const lo = netOf(loNode, { admitTimeoutMs: 200 });
  lo.net.start();
  try {
    const started = Date.now();
    lo.net.offerAddress(fromEndpoint(hiNode.endpoint));
    lo.net.watch(hiNode.identity.id);
    await until(() => held.length >= 2);
    expect(Date.now() - started).toBeLessThan(1500);
    const reason = await held[0]!.closed();
    expect(reason).toContain("(code 0)");
    expect(lo.errors.some((e) => e.includes("did not admit the connection within 200 ms"))).toBe(true);
    expect(lo.peers).toEqual([]);
  } finally {
    await lo.net.stop();
    await pair.close();
    await holding;
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

test("a stream of a kind nobody takes is reset: the opener fails at once instead of waiting", async () => {
  // A listener that looks at every stream but takes only the kinds it knows; holding on to the stream keeps it from
  // being dropped (and so finished) by the garbage collector.
  const looked: PeerStream[] = [];
  const { lo, hi, stop } = await poolPair({}, (s) => {
    looked.push(s);
    return s.header.stream !== "unknown";
  });
  try {
    const s = await lo.net.openStream(hi.id, { stream: "unknown" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      s.reader.readLine().then((line) => line, () => "rejected"),
      new Promise<string>((resolve) => { timer = setTimeout(() => resolve("still waiting"), 1000); }),
    ]);
    clearTimeout(timer);
    expect(outcome === null || outcome === "rejected").toBe(true);
    expect(looked.map((x) => x.header)).toEqual([{ stream: "unknown" }]);
    expect(hi.streams).toEqual([]);
    // Only the stream was reset: the connection stays and a known kind still gets through.
    expect(lo.net.isOnline(hi.id)).toBe(true);
    await lo.net.openStream(hi.id, { stream: "x" });
    await until(() => hi.streams.length === 1);
    expect(hi.errors).toEqual([]);
  } finally {
    await stop();
  }
});
