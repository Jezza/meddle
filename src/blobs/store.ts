// A node's file store: content-addressed, so a file is kept once under the SHA-256 of its bytes. Files are never
// deleted; the directory is private to this user (700) and each file 600.
import { readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Refused, writeChecked } from "../checked-file";
import { ensurePrivateDir } from "../paths";
import { isBlobHash, MAX_BLOB_BYTES } from "./attachment";

/** What a file being written is called until its hash is known: `.tmp-<uuid>`. */
const TEMP_PREFIX = ".tmp-";

/** Bytes a write refuses for what they are: more than it takes, or not the blob it expects. */
export class BadBlob extends Error {}

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
   * come, and `blob does not match <hash>` when `expect` names another hash or size than the bytes have (both
   * `BadBlob`). However it fails, even in the source, no temporary file is left.
   */
  async write(
    chunks: AsyncIterable<Uint8Array>,
    options: { maxBytes?: number; expect?: { hash: string; size: number } } = {},
  ): Promise<{ hash: string; size: number }> {
    const maxBytes = options.maxBytes ?? MAX_BLOB_BYTES;
    await ensurePrivateDir(this.dir);
    const temp = join(this.dir, `${TEMP_PREFIX}${crypto.randomUUID()}`);
    const got = await writeChecked(chunks, temp, { maxBytes, mode: 0o600, expect: options.expect }).catch((err: unknown) => {
      if (!(err instanceof Refused)) throw err;
      throw new BadBlob(err.why === "over" ? `blob exceeds ${maxBytes} bytes` : `blob does not match ${options.expect?.hash}`);
    });
    try {
      if (await this.has(got.hash)) await rm(temp, { force: true });
      else await rename(temp, this.path(got.hash));
      return got;
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
