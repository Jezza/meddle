// A file written from a stream of bytes, hashed (SHA-256) as they come and checked before anything relies on it: the
// blob store's files, and a rollout's binary. Where it then goes is the caller's: a blob under its hash, a binary beside
// the one it replaces.
import { open, rm } from "node:fs/promises";

/** Why bytes were refused: more than the limit, fewer than expected, or other bytes. `got` is what came. */
export class Refused extends Error {
  constructor(readonly why: "over" | "short" | "mismatch", readonly got: { hash: string | null; size: number }) {
    super(`bytes refused: ${why}`);
  }
}

/**
 * Writes the bytes `chunks` yields to `temp` (a new file, made `mode`), hashing them, and flushes it to disk. Throws
 * `Refused` once more than `maxBytes` have come, or at the end when `expect` names another size (`short` when fewer
 * came) or hash. However it fails, an error of `chunks` included (rethrown as it is), `temp` is removed; a file already
 * at `temp` is neither written over nor removed. On success `temp` is left whole, for the caller to rename into place.
 */
export async function writeChecked(
  chunks: AsyncIterable<Uint8Array>,
  temp: string,
  options: { maxBytes: number; mode: number; expect?: { hash: string; size: number } },
): Promise<{ hash: string; size: number }> {
  const handle = await open(temp, "wx", options.mode);
  try {
    const hasher = new Bun.CryptoHasher("sha256");
    let size = 0;
    try {
      for await (const chunk of chunks) {
        size += chunk.byteLength;
        if (size > options.maxBytes) throw new Refused("over", { hash: null, size });
        hasher.update(chunk);
        await handle.writeFile(chunk);
      }
      // The umask may have taken bits `open` was given.
      await handle.chmod(options.mode);
      // A rename of bytes still in the cache could, after a crash, leave a name that holds an empty file for good.
      await handle.sync();
    } finally {
      await handle.close();
    }
    const hash = hasher.digest("hex");
    const { expect } = options;
    if (expect !== undefined && size < expect.size) throw new Refused("short", { hash, size });
    if (expect !== undefined && (size !== expect.size || hash !== expect.hash)) throw new Refused("mismatch", { hash, size });
    return { hash, size };
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
}
