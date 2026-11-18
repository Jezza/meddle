// src/update/channel.ts — the rollout channel over the pool's iroh links: its own streams, apart from PoolObject's sync,
// so that nodes on different builds keep exchanging rollout state (see ./wire.ts for what keeps it readable).
//
// - `{ stream: "rollout", v }`: an exchange. The opener writes its view as one JSON line (`RolloutMessage`), the
//   acceptor answers with its own (after merging the opener's), and both finish.
// - `{ stream: "rollout-binary", v, build, platform, sha256 }`: a binary of a rollout. The acceptor answers one JSON
//   line, `{ ok: true, size }` then the file's bytes raw, or `{ ok: false, reason }` when it does not have it. The
//   bytes stream (a binary is ~150 MB, far over a frame); the fetcher checks size and SHA-256 before it keeps them.
import { open, rename, rm, chmod, type FileHandle } from "node:fs/promises";
import { writeLine } from "../pool/frames";
import { shortId } from "../pool/identity";
import type { PeerStream } from "../pool/net";
import { STALL_MS, withTimeout } from "../pool/stall";
import { messageOf, parseMessage, ROLLOUT_V, type RolloutMessage, type RolloutView } from "./wire";

/** What the channel needs of the pool's net (`PoolNet` has it). */
export type ChannelNet = {
  openStream(peerId: string, header: { stream: string } & Record<string, unknown>): Promise<PeerStream>;
  onStream(cb: (s: PeerStream) => boolean): () => void;
};

/** The longest message line read, in bytes: ten rollouts and a pool's records are a few kB. */
const MAX_MESSAGE = 4 * 1024 * 1024;
/** How long an exchange may take before it is given up. */
export const EXCHANGE_MS = 15_000;
/** How much of a binary is written to the stream at a time. */
const SEND_CHUNK = 256 * 1024;

/** Resets a stream both ways: the other side's reads and writes fail. */
async function reset(s: PeerStream): Promise<void> {
  await s.stream.send.reset(0n).catch(() => {});
  await s.stream.recv.stop(0n).catch(() => {});
}

/** What the accepting side does: merge a peer's message and answer with its view; find a binary it can serve. */
export type ChannelHandlers = {
  isMember(id: string): boolean;
  /** Merges a peer's message; returns this node's view after the merge, to answer with. */
  received(from: string, msg: RolloutMessage): RolloutView;
  /**
   * The binary of `build` for `platform` (hashing to `sha256`) this node can serve, opened (the channel streams it from
   * its start and closes it), or null.
   */
  binaryFor(build: string, platform: string, sha256: string): Promise<FileHandle | null>;
  onError?(err: unknown): void;
};

/** Takes the `rollout` and `rollout-binary` streams members open to this node. Returns the unsubscribe. */
export function acceptRolloutStreams(net: ChannelNet, h: ChannelHandlers): () => void {
  return net.onStream((s) => {
    const kind = s.header.stream;
    if (kind !== "rollout" && kind !== "rollout-binary") return false;
    if (!h.isMember(s.peerId)) {
      void reset(s);
      return true;
    }
    const serve = kind === "rollout" ? answerExchange(s, h) : serveBinary(s, h);
    void serve.catch((err: unknown) => {
      h.onError?.(err);
      return reset(s);
    });
    return true;
  });
}

async function answerExchange(s: PeerStream, h: ChannelHandlers): Promise<void> {
  const line = await withTimeout(s.reader.readLine(MAX_MESSAGE), EXCHANGE_MS, "reading a rollout message");
  const msg = line === null ? null : parseMessage(line);
  if (msg === null) throw new Error(`a bad rollout message from ${shortId(s.peerId)}`);
  const view = h.received(s.peerId, msg);
  await writeLine(s.stream.send, JSON.stringify(messageOf(view)));
  await s.stream.send.finish();
}

async function serveBinary(s: PeerStream, h: ChannelHandlers): Promise<void> {
  const { build, platform, sha256 } = s.header;
  const ok = typeof build === "string" && typeof platform === "string" && typeof sha256 === "string";
  const handle = ok ? await h.binaryFor(build, platform, sha256) : null;
  if (handle === null) {
    await writeLine(s.stream.send, JSON.stringify({ ok: false, reason: "not here" }));
    await s.stream.send.finish();
    return;
  }
  try {
    const { size } = await handle.stat();
    await writeLine(s.stream.send, JSON.stringify({ ok: true, size }));
    const buf = Buffer.alloc(SEND_CHUNK);
    for (let at = 0; ;) {
      const { bytesRead } = await handle.read(buf, 0, SEND_CHUNK, at);
      if (bytesRead === 0) break;
      at += bytesRead;
      await s.stream.send.writeAll(Array.from(buf.subarray(0, bytesRead)));
    }
    await s.stream.send.finish();
  } finally {
    await handle.close();
  }
}

/**
 * Exchanges views with `peerId`: sends `view`, and returns the peer's (null when it sent nothing readable). Rejects
 * when the stream fails or the exchange takes longer than `EXCHANGE_MS`.
 */
export async function exchange(net: ChannelNet, peerId: string, view: RolloutView): Promise<RolloutMessage | null> {
  const s = await net.openStream(peerId, { stream: "rollout", v: ROLLOUT_V });
  try {
    return await withTimeout((async () => {
      await writeLine(s.stream.send, JSON.stringify(messageOf(view)));
      await s.stream.send.finish();
      const line = await s.reader.readLine(MAX_MESSAGE);
      return line === null ? null : parseMessage(line);
    })(), EXCHANGE_MS, `the rollout exchange with ${shortId(peerId)}`);
  } catch (err) {
    await reset(s);
    throw err;
  }
}

/** The binary a fetch asks for. */
export type BinaryWant = { build: string; platform: string; sha256: string; size: number };

/** The peer could not give the binary: it does not have it, or the stream failed or stalled. Another member may. */
export class Unavailable extends Error {}
/** What the peer sent is not the binary the rollout names (its size or its SHA-256). Another member may have it. */
export class BadBinary extends Error {}

/**
 * Fetches a binary from `peerId` into `dest` (by way of `<dest>.part`, made executable): streamed to disk, its size and
 * SHA-256 checked before it is kept. Rejects with why: `Unavailable` (the peer does not have it, the stream failed, or
 * nothing came for `stallMs`), `BadBinary` (a size or hash that is not the one asked for), or the error of this
 * node's own file (no space, no permission), which another peer would not change. Nothing is left at `dest` then.
 */
export async function fetchBinary(net: ChannelNet, peerId: string, want: BinaryWant, dest: string, stallMs = STALL_MS): Promise<void> {
  const who = shortId(peerId);
  /** The peer's part of the fetch: a failure of it is the peer's, not this node's. */
  const peer = <T>(step: Promise<T>, what: string): Promise<T> =>
    withTimeout(step, stallMs, what).catch((err: unknown) => {
      throw err instanceof Unavailable ? err : new Unavailable(`${who}: ${(err as Error).message ?? String(err)}`);
    });
  const s = await peer(net.openStream(peerId, { stream: "rollout-binary", v: ROLLOUT_V, build: want.build, platform: want.platform, sha256: want.sha256 }), "opening a stream");
  const part = `${dest}.part`;
  try {
    await peer(s.stream.send.finish(), "asking for the binary");
    const head = await peer(s.reader.readLine(), "asking for the binary");
    let answer: { ok?: unknown; size?: unknown } | null = null;
    try {
      answer = head === null ? null : (JSON.parse(head) as { ok?: unknown; size?: unknown });
    } catch {
      // Not an answer: the peer does not have it, as far as this node can tell.
    }
    if (answer?.ok !== true) throw new Unavailable(`${who} does not have it`);
    if (answer.size !== want.size) throw new BadBinary(`${who} has it at ${String(answer.size)} bytes, not ${want.size}`);
    const hasher = new Bun.CryptoHasher("sha256");
    const out = await open(part, "w", 0o700);
    let got = 0;
    try {
      for (;;) {
        const chunk = await peer(s.reader.readChunk(), `reading the binary (${got} of ${want.size} bytes)`);
        if (chunk === null) break;
        got += chunk.length;
        if (got > want.size) throw new BadBinary(`${who} sent more than ${want.size} bytes`);
        hasher.update(chunk);
        await out.write(chunk);
      }
    } finally {
      await out.close();
    }
    if (got !== want.size) throw new Unavailable(`the binary from ${who} ended at ${got} of ${want.size} bytes`);
    const sha = hasher.digest("hex");
    if (sha !== want.sha256) throw new BadBinary(`the binary from ${who} has SHA-256 ${sha.slice(0, 16)}…, not ${want.sha256.slice(0, 16)}…`);
    await chmod(part, 0o755);
    await rename(part, dest);
  } catch (err) {
    await rm(part, { force: true });
    await reset(s);
    throw err;
  }
}
