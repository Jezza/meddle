// test/blob-pool.test.ts — a node fetching a file it lacks from another node of the pool, by its hash.
import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { MAX_BLOB_BYTES } from "../src/blobs/attachment";
import { BlobFetcher } from "../src/blobs/pool";
import { BlobStore } from "../src/blobs/store";
import { writeFrame, type StreamReader } from "../src/pool/frames";
import type { PeerStream, PoolNet } from "../src/pool/net";
import { acceptBlobStreams } from "../src/tasks/blob";
import { twoNodes, twoPoolNodes } from "./pool-helpers";

async function* chunks(...parts: string[]) { for (const p of parts) yield new TextEncoder().encode(p); }
const sha = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");
const text = (data: Uint8Array) => new TextDecoder().decode(data);
const encode = (s: string) => new TextEncoder().encode(s);
const noTasks = { importIncoming: async () => { throw new Error("no") } };

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(5);
  }
}

/** Two linked, online nodes, each with a blob store of its own; `b` serves its blobs unless `serve` is false. */
async function pair(serve = true) {
  const nodes = await twoNodes();
  const { a, b } = nodes;
  const dir = await mkdtemp("/tmp/blob-pool-");
  const sa = new BlobStore(join(dir, "a", "blobs"));
  const sb = new BlobStore(join(dir, "b", "blobs"));
  // Registered first, so that it sees every stream b's acceptor takes.
  const opened = countBlobStreams(b.net);
  const stops = [acceptBlobStreams(a.net, noTasks, sa)];
  if (serve) stops.push(acceptBlobStreams(b.net, noTasks, sb));
  // Both dial at first, and the connection the smaller id dialed is the one they keep: wait for that to be the one held.
  const settled = a.id < b.id ? a.id : b.id;
  await until(() => a.net.linkOf(b.id)?.dialer === settled && b.net.linkOf(a.id)?.dialer === settled);
  return {
    a, b, sa, sb, opened,
    async close() {
      for (const stop of stops) stop();
      await nodes.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** The `blob` streams `net` receives, counted by a listener that takes none of them (it must be registered first). */
function countBlobStreams(net: PoolNet) {
  const seen = { count: 0 };
  net.onStream((s) => {
    if (s.header.stream === "blob") seen.count += 1;
    return false;
  });
  return seen;
}

/** Answers every `file` stream `net` gets with `reply`, in place of serveBlob. */
function answerWith(net: PoolNet, reply: (s: PeerStream) => Promise<void>) {
  return net.onStream((s) => {
    if (s.header.stream !== "blob" || s.header.kind !== "file") return false;
    void reply(s);
    return true;
  });
}

async function frameOf(reader: StreamReader) {
  const frame = await reader.readFrame();
  if (frame === null) throw new Error("the stream ended");
  return frame;
}

test("a node fetches a blob another node has, and says false when none has it", async () => {
  const { a, sa, sb, close } = await pair();
  try {
    const { hash } = await sb.write(chunks("x".repeat(3 * 1024 * 1024)));
    const fetcher = new BlobFetcher(sa, a.net);
    expect(await fetcher.ensure(hash)).toBe(true);
    expect((await stat(sa.path(hash))).size).toBe(3 * 1024 * 1024);
    expect(await fetcher.ensure("0".repeat(64))).toBe(false);
    expect(await fetcher.ensure("not a hash")).toBe(false);
  } finally {
    await close();
  }
}, 20_000);

test("a blob that is here already is not fetched", async () => {
  const { a, sa, opened, close } = await pair();
  try {
    const { hash } = await sa.write(chunks("here"));
    expect(await new BlobFetcher(sa, a.net).ensure(hash)).toBe(true);
    expect(opened.count).toBe(0);
  } finally {
    await close();
  }
});

test("an empty blob is fetched as any other", async () => {
  const { a, sa, sb, close } = await pair();
  try {
    const { hash } = await sb.write(chunks());
    expect(await new BlobFetcher(sa, a.net).ensure(hash)).toBe(true);
    expect((await stat(sa.path(hash))).size).toBe(0);
  } finally {
    await close();
  }
});

test("two ensures of one hash fetch it once", async () => {
  const { a, sa, sb, opened, close } = await pair();
  try {
    const { hash } = await sb.write(chunks("shared"));
    const fetcher = new BlobFetcher(sa, a.net);
    const [x, y] = await Promise.all([fetcher.ensure(hash), fetcher.ensure(hash)]);
    expect([x, y]).toEqual([true, true]);
    expect(opened.count).toBe(1);
  } finally {
    await close();
  }
});

test("bytes that do not match the hash are not kept", async () => {
  const { a, b, sa, close } = await pair(false);
  try {
    answerWith(b.net, async (s) => {
      await writeFrame(s.stream.send, 0, encode(JSON.stringify({ size: 5 })));
      await writeFrame(s.stream.send, 1, encode("wrong"));
      await s.stream.send.finish();
    });
    expect(await new BlobFetcher(sa, a.net).ensure(sha("right"))).toBe(false);
    expect(await readdir(sa.dir).catch(() => [])).toEqual([]);
  } finally {
    await close();
  }
});

test("more bytes than announced are not kept", async () => {
  const { a, b, sa, close } = await pair(false);
  try {
    answerWith(b.net, async (s) => {
      await writeFrame(s.stream.send, 0, encode(JSON.stringify({ size: 5 })));
      await writeFrame(s.stream.send, 1, encode("rightand more"));
      await s.stream.send.finish();
    });
    expect(await new BlobFetcher(sa, a.net).ensure(sha("right"))).toBe(false);
    expect(await readdir(sa.dir).catch(() => [])).toEqual([]);
  } finally {
    await close();
  }
});

test("a size over the limit is refused without reading, and a reset stream counts as not having it", async () => {
  const { a, b, sa, close } = await pair(false);
  try {
    let asked = 0;
    let bytesWritten: Promise<unknown> = Promise.resolve();
    const stop = answerWith(b.net, async (s) => {
      asked += 1;
      if (asked === 1) {
        await writeFrame(s.stream.send, 0, encode(JSON.stringify({ size: MAX_BLOB_BYTES + 1 })));
        bytesWritten = writeFrame(s.stream.send, 1, encode("x")).catch(() => {});
        await s.stream.send.finish().catch(() => {});
      } else {
        await s.stream.send.reset(0n);
      }
    });
    const fetcher = new BlobFetcher(sa, a.net);
    expect(await fetcher.ensure(sha("big"))).toBe(false);
    expect(await fetcher.ensure(sha("reset"))).toBe(false);
    await bytesWritten;
    stop();
    expect(asked).toBe(2);
    expect(await readdir(sa.dir).catch(() => [])).toEqual([]);
  } finally {
    await close();
  }
});

test("a peer asked for what is not a hash says it is missing", async () => {
  const { a, b, close } = await pair();
  try {
    const s = await a.net.openStream(b.id, { stream: "blob", kind: "file", hash: "../etc/passwd" });
    const frame = await frameOf(s.reader);
    expect([frame.kind, JSON.parse(text(frame.data))]).toEqual([0, { missing: true }]);
    expect(await s.reader.readFrame()).toBeNull();
  } finally {
    await close();
  }
});

test("a peer serves a blob as a size, then frames of at most 1 MiB, then ends", async () => {
  const { a, b, sb, close } = await pair();
  try {
    const { hash } = await sb.write(chunks("y".repeat(2 * 1024 * 1024 + 7)));
    const s = await a.net.openStream(b.id, { stream: "blob", kind: "file", hash });
    const head = await frameOf(s.reader);
    expect([head.kind, JSON.parse(text(head.data))]).toEqual([0, { size: 2 * 1024 * 1024 + 7 }]);
    const sizes: number[] = [];
    for (let f = await s.reader.readFrame(); f !== null; f = await s.reader.readFrame()) {
      expect(f.kind).toBe(1);
      sizes.push(f.data.length);
    }
    expect(sizes).toEqual([1024 * 1024, 1024 * 1024, 7]);
  } finally {
    await close();
  }
});

test("a peer that lacks the blob is passed over for the next, the one preferred first", async () => {
  const { a, b, sa, sb, close } = await pair();
  try {
    const { hash } = await sb.write(chunks("from b"));
    const tried: string[] = [];
    const net = {
      online: () => ["down-1", b.id, "down-2"],
      openStream: (peerId: string, header: Parameters<PoolNet["openStream"]>[1]) => {
        tried.push(peerId);
        return peerId === b.id ? a.net.openStream(peerId, header) : Promise.reject(new Error("not connected"));
      },
    };
    expect(await new BlobFetcher(sa, net).ensure(hash, "down-2")).toBe(true);
    expect(tried).toEqual(["down-2", "down-1", b.id]);
    expect(await new BlobFetcher(new BlobStore(join(sa.dir, "..", "other")), net).ensure(hash, b.id)).toBe(true);
    expect(tried).toEqual(["down-2", "down-1", b.id, b.id]);
  } finally {
    await close();
  }
});

test("a runner given its pool after it was built fetches through it", async () => {
  // startPoolNode builds each runner without a pool and createNodeHost attaches it (`attachPool`).
  const { A, B, close } = await twoPoolNodes();
  try {
    const { hash } = await A.runner.blobs.store.write(chunks("from a"));
    expect(await B.runner.blobs.ensure(hash, A.id)).toBe(true);
    expect(await B.runner.blobs.store.has(hash)).toBe(true);
  } finally {
    await close();
  }
}, 30_000);

test("without a pool, ensure answers only from the store", async () => {
  const dir = await mkdtemp("/tmp/blob-pool-");
  try {
    const store = new BlobStore(join(dir, "blobs"));
    const { hash } = await store.write(chunks("kept"));
    expect(await new BlobFetcher(store, null).ensure("0".repeat(64))).toBe(false);
    expect(await new BlobFetcher(store, null).ensure(hash)).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
