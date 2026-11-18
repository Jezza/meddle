// Files between the nodes of the pool: serving one from the blob store by its hash, and fetching a missing one from
// whichever member has it.
import { open } from "node:fs/promises";
import type { PeerStream, PoolNet } from "../pool/net";
import { writeFrame, type StreamReader } from "../pool/frames";
import { STALL_MS, TimedOut, withTimeout } from "../pool/stall";
import { isBlobHash, MAX_BLOB_BYTES } from "./attachment";
import { BadBlob, type BlobStore } from "./store";

/*
 * A file moves on one `{ stream: "blob", kind: "file", hash }` stream. The serving side answers with one JSON frame
 * (kind 0), `{ size }` or `{ missing: true }`; after a size come the file's bytes as kind-1 frames, then the stream
 * finishes. The fetching side finishes its own half at once: it has nothing more to say.
 */

const HEADER = 0;
const BYTES = 1;
/** The most bytes one frame of a file carries. */
const CHUNK = 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Resets a stream both ways: the other side's writes and its wait for more fail. */
export async function reset(s: PeerStream): Promise<void> {
  await s.stream.send.reset(0n).catch(() => {});
  await s.stream.recv.stop(0n).catch(() => {});
}

/**
 * Answers the one request `s` is (its header's `hash`) from `store`: `{ size }` and the file's bytes as frames of at
 * most 1 MiB, or `{ missing: true }` when the store lacks it or the hash is not one; then finishes. Rejects when the
 * file cannot be read through, and leaves the stream for the caller to reset.
 */
export async function serveBlob(s: PeerStream, store: BlobStore): Promise<void> {
  const { send } = s.stream;
  const hash = s.header.hash;
  const file = typeof hash === "string" && isBlobHash(hash) ? await openBlob(store, hash) : null;
  if (file === null) {
    await writeFrame(send, HEADER, encoder.encode(JSON.stringify({ missing: true })));
    await send.finish();
    return;
  }
  try {
    const { size } = await file.stat();
    await writeFrame(send, HEADER, encoder.encode(JSON.stringify({ size })));
    const buf = new Uint8Array(CHUNK);
    for (let sent = 0; sent < size;) {
      const { bytesRead } = await file.read(buf, 0, Math.min(CHUNK, size - sent), sent);
      if (bytesRead === 0) throw new Error(`blob ${hash} is shorter than it was`);
      await writeFrame(send, BYTES, buf.subarray(0, bytesRead));
      sent += bytesRead;
    }
    await send.finish();
  } finally {
    await file.close();
  }
}

async function openBlob(store: BlobStore, hash: string) {
  try {
    return await open(store.path(hash), "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** A fault of the member a file is fetched from: its stream failed or stalled, or it sent what is not the file. */
class PeerFault extends Error {}

type Frame = Awaited<ReturnType<StreamReader["readFrame"]>>;

/** The bytes of a file as the kind-1 frames `reader` has, until the stream ends; each read goes through `peer`. */
async function* fileBytes(reader: StreamReader, peer: (read: Promise<Frame>) => Promise<Frame>): AsyncGenerator<Uint8Array> {
  for (let frame = await peer(reader.readFrame()); frame !== null; frame = await peer(reader.readFrame())) {
    if (frame.kind !== BYTES) throw new PeerFault("not file bytes");
    yield frame.data;
  }
}

/** The size a member's answer announces, or null when it has none (the member is missing the file) or is not one. */
function announcedSize(data: Uint8Array): number | null {
  let size: unknown;
  try {
    size = (JSON.parse(decoder.decode(data)) as { size?: unknown } | null)?.size;
  } catch {
    return null;
  }
  // A size is what the peer will be held to: a lying peer costs no more than it announced.
  return typeof size === "number" && Number.isSafeInteger(size) && size >= 0 && size <= MAX_BLOB_BYTES ? size : null;
}

/** What a fetcher needs of the pool's net. */
type FetchNet = Pick<PoolNet, "online" | "openStream">;

/** Fetches the files a node lacks from the other members of its pool, into its blob store. */
export class BlobFetcher {
  #fetching = new Map<string, Promise<boolean>>();
  readonly #net: () => FetchNet | null;
  readonly #stallMs: number;

  /**
   * `net` is null for a node without a pool: it has only what its store has. A function is asked for the net at each
   * fetch, for a node whose pool comes after the fetcher (`TaskRunner.attachPool`). `stallMs`: how long a member may
   * keep a fetch waiting at any one step (the stream opening, its answer, each piece of the file).
   */
  constructor(readonly store: BlobStore, net: FetchNet | null | (() => FetchNet | null), stallMs = STALL_MS) {
    this.#net = typeof net === "function" ? net : () => net;
    this.#stallMs = stallMs;
  }

  /**
   * Makes sure the blob with this hash is in the store: true when it is, or was fetched from a member (`prefer` first,
   * if it is online, then each other online member in turn); false when none has it. A member that cannot be reached,
   * resets, keeps a step waiting past the stall time, says it is missing the blob or sends bytes that are not it counts
   * as not having it. Concurrent calls for one hash share one fetch. Rejects only when this node's store cannot be read
   * or written (no space, no permission), which no other member would change.
   */
  ensure(hash: string, prefer?: string): Promise<boolean> {
    if (!isBlobHash(hash)) return Promise.resolve(false);
    let pending = this.#fetching.get(hash);
    if (pending === undefined) {
      pending = this.#obtain(hash, prefer).finally(() => this.#fetching.delete(hash));
      this.#fetching.set(hash, pending);
    }
    return pending;
  }

  async #obtain(hash: string, prefer: string | undefined): Promise<boolean> {
    if (await this.store.has(hash)) return true;
    const net = this.#net();
    if (net === null) return false;
    const online = net.online();
    const peers = prefer !== undefined && online.includes(prefer) ? [prefer, ...online.filter((id) => id !== prefer)] : online;
    for (const peerId of peers) {
      if (await this.#fetchFrom(net, peerId, hash)) return true;
    }
    return false;
  }

  /**
   * Fetches the blob from one member; false when the member fails in any way (a step kept waiting past the stall time
   * included) or what it sends is not the blob, leaving no file kept and its stream reset. Rejects when this node
   * cannot store the blob.
   */
  async #fetchFrom(net: Pick<PoolNet, "openStream">, peerId: string, hash: string): Promise<boolean> {
    let stalled = false;
    /** A step the member takes: any failure of it, its stall included, is the member's. */
    const peer = <T>(step: Promise<T>, what: string): Promise<T> => withTimeout(step, this.#stallMs, what).catch((err: unknown) => {
      if (err instanceof TimedOut) stalled = true;
      throw new PeerFault(`${what}: ${err instanceof Error ? err.message : String(err)}`);
    });
    const opening = net.openStream(peerId, { stream: "blob", kind: "file", hash });
    let s: PeerStream;
    try {
      s = await peer(opening, "opening a stream");
    } catch {
      // A stream that opens after all is reset as it comes.
      void opening.then(reset, () => {});
      return false;
    }
    try {
      await peer(s.stream.send.finish(), "asking for the file");
      const head = await peer(s.reader.readFrame(), "asking for the file");
      const size = head === null || head.kind !== HEADER ? null : announcedSize(head.data);
      if (size === null) return false;
      const bytes = fileBytes(s.reader, (read) => peer(read, "reading the file"));
      await this.store.write(bytes, { maxBytes: size, expect: { hash, size } });
      return true;
    } catch (err) {
      // The member's fault, or bytes that are not the blob (more than it announced included): another member may
      // have it. Any other fault is this node's own store's.
      if (err instanceof PeerFault || err instanceof BadBlob) return false;
      throw err;
    } finally {
      // A read that stalled holds the stream's receiving half until the peer or the connection ends it, and stopping
      // that half waits for it: the reset is not waited for then.
      if (stalled) void reset(s);
      else await reset(s);
    }
  }
}
