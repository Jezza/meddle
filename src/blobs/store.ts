// A node's file store: content-addressed, so a file is kept once under the SHA-256 of its bytes. Files are never
// deleted; the directory is private to this user (700) and each file 600.
import { open, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { ensurePrivateDir } from "../paths";
import { isBlobHash, MAX_BLOB_BYTES } from "./attachment";

/** What a file being written is called until its hash is known: `.tmp-<uuid>`. */
const TEMP_PREFIX = ".tmp-";

export class BlobStore {
  constructor(readonly dir: string) {}

  /** Where the blob with this hash is (or would be) kept. Throws `not a blob hash: <s>` for anything but a hash. */
  path(hash: string): string {
    if (!isBlobHash(hash)) throw new Error(`not a blob hash: ${hash}`);
    return join(this.dir, hash);
  }

  /** Whether the blob is stored; false for a string that is not a hash. */
  async has(hash: string): Promise<boolean> {
    if (!isBlobHash(hash)) return false;
    try {
      return (await stat(this.path(hash))).isFile();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }

  /**
   * Stores the bytes `chunks` yields under their hash, and says which and how many they were; bytes already stored are
   * kept as they are. Rejects `blob exceeds <maxBytes> bytes` once more than `maxBytes` (by default the 64 MB limit) have
   * come, and `blob does not match <hash>` when `expect` names another hash or size than the bytes have. However it
   * fails, even in the source, no temporary file is left.
   */
  async write(
    chunks: AsyncIterable<Uint8Array>,
    options: { maxBytes?: number; expect?: { hash: string; size: number } } = {},
  ): Promise<{ hash: string; size: number }> {
    const maxBytes = options.maxBytes ?? MAX_BLOB_BYTES;
    await ensurePrivateDir(this.dir);
    const temp = join(this.dir, `${TEMP_PREFIX}${crypto.randomUUID()}`);
    const handle = await open(temp, "wx", 0o600);
    try {
      const hasher = new Bun.CryptoHasher("sha256");
      let size = 0;
      try {
        for await (const chunk of chunks) {
          size += chunk.byteLength;
          if (size > maxBytes) throw new Error(`blob exceeds ${maxBytes} bytes`);
          hasher.update(chunk);
          await handle.writeFile(chunk);
        }
        // A rename of bytes still in the cache could, after a crash, leave a hash that names an empty file for good.
        await handle.sync();
      } finally {
        await handle.close();
      }
      const hash = hasher.digest("hex");
      const { expect } = options;
      if (expect !== undefined && (expect.hash !== hash || expect.size !== size)) {
        throw new Error(`blob does not match ${expect.hash}`);
      }
      if (await this.has(hash)) await rm(temp, { force: true });
      else await rename(temp, this.path(hash));
      return { hash, size };
    } catch (err) {
      await rm(temp, { force: true });
      throw err;
    }
  }

  /**
   * Removes what a crash can leave here: a half-written `.tmp-*` (never read: a blob is renamed into place whole).
   * `serve` runs it at start, before anything writes a blob; how many it removed.
   */
  async sweepTemps(): Promise<number> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw err;
    }
    let removed = 0;
    for (const name of names) {
      if (!name.startsWith(TEMP_PREFIX)) continue;
      await rm(join(this.dir, name), { force: true });
      removed += 1;
    }
    return removed;
  }
}
