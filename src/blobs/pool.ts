// Files between the nodes of the pool: serving one from the blob store by its hash, and fetching a missing one from
// whichever member has it.
import { open } from "node:fs/promises";
import type { PeerStream, PoolNet } from "../pool/net";
import { writeFrame, type StreamReader } from "../pool/frames";
import { isBlobHash, MAX_BLOB_BYTES } from "./attachment";
import type { BlobStore } from "./store";

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

/** The bytes of a file as the kind-1 frames `reader` has, until the stream ends. */
async function* fileBytes(reader: StreamReader): AsyncGenerator<Uint8Array> {
  for (let frame = await reader.readFrame(); frame !== null; frame = await reader.readFrame()) {
    if (frame.kind !== BYTES) throw new Error("not file bytes");
    yield frame.data;
  }
}

/** What a fetcher needs of the pool's net. */
type FetchNet = Pick<PoolNet, "online" | "openStream">;

/** Fetches the files a node lacks from the other members of its pool, into its blob store. */
export class BlobFetcher {
  #fetching = new Map<string, Promise<boolean>>();
  readonly #net: () => FetchNet | null;

  /**
   * `net` is null for a node without a pool: it has only what its store has. A function is asked for the net at each
   * fetch, for a node whose pool comes after the fetcher (`TaskRunner.attachPool`).
   */
  constructor(readonly store: BlobStore, net: FetchNet | null | (() => FetchNet | null)) {
    this.#net = typeof net === "function" ? net : () => net;
  }

  /**
   * Makes sure the blob with this hash is in the store: true when it is, or was fetched from a member (`prefer` first,
   * if it is online, then each other online member in turn); false when none has it. A member that cannot be reached,
   * resets, says it is missing the blob or sends bytes that are not it counts as not having it. Concurrent calls for
   * one hash share one fetch. Rejects only when the store itself cannot be read.
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

  /** Fetches the blob from one member; false when it fails in any way, leaving no stream open and no file kept. */
  async #fetchFrom(net: Pick<PoolNet, "openStream">, peerId: string, hash: string): Promise<boolean> {
    let s: PeerStream;
    try {
      s = await net.openStream(peerId, { stream: "blob", kind: "file", hash });
    } catch {
      return false;
    }
    try {
      await s.stream.send.finish();
      const head = await s.reader.readFrame();
      if (head === null || head.kind !== HEADER) return false;
      const answer = JSON.parse(decoder.decode(head.data)) as { size?: unknown };
      const size = answer.size;
      // A size is what the peer will be held to: a lying peer costs no more than it announced.
      if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 || size > MAX_BLOB_BYTES) return false;
      await this.store.write(fileBytes(s.reader), { maxBytes: size, expect: { hash, size } });
      return true;
    } catch {
      return false;
    } finally {
      await reset(s);
    }
  }
}
