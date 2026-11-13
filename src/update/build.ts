// src/update/build.ts — which build a binary is: the build id (the jj commit of the source it was built from, the same
// for every platform built from one source) and the platform it runs on. `bun run build` embeds both in the binary as
// a mark, plain text between two sentinels, so that `meddle update` can read them from a binary for another machine
// without running it.
import { open, stat, type FileHandle } from "node:fs/promises";
import { embedded } from "../embedded";

export type BuildInfo = {
  /** The jj commit id of the source (12 hex digits), or `checkout` for a node run from a checkout. */
  buildId: string;
  /** The platform the binary runs on, as the Agent SDK names it (`linux-x64`, `linux-arm64`, `linux-x64-musl`, …). */
  platform: string;
};

/** The build id a node run from a checkout reports: it is never updated, and never counts as mismatched. */
export const CHECKOUT_BUILD = "checkout";

/**
 * The sentinels around a build's mark. Joined at run time, so that the code which scans for them carries no copy of
 * the opening one for the scan to find.
 */
const MARK_OPEN = ["@@meddle", "build@@"].join("-");
const MARK_CLOSE = "@@end@@";
/** The longest a mark's JSON may be, in bytes: anything longer between the sentinels is not a mark. */
const MAX_MARK = 1024;
/** A build id as `bun run build` writes it: hex, or a name given in `MEDDLE_BUILD_ID` (letters, digits, `.`, `_`, `-`). */
const BUILD_ID = /^[A-Za-z0-9._-]{1,64}$/;
const PLATFORM = /^[a-z0-9]+-[a-z0-9]+(-[a-z0-9]+)?$/;

/** The mark `bun run build` embeds: the build's info as JSON between the sentinels. */
export function buildMark(info: BuildInfo): string {
  if (!BUILD_ID.test(info.buildId) || info.buildId === CHECKOUT_BUILD) throw new Error(`not a build id: ${info.buildId}`);
  if (!PLATFORM.test(info.platform)) throw new Error(`not a platform: ${info.platform}`);
  return `${MARK_OPEN}${JSON.stringify({ buildId: info.buildId, platform: info.platform })}${MARK_CLOSE}`;
}

/** The info in a mark (the JSON between the sentinels), or null when it is not one. */
export function parseMarkBody(body: string): BuildInfo | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  const { buildId, platform } = (value ?? {}) as { buildId?: unknown; platform?: unknown };
  if (typeof buildId !== "string" || typeof platform !== "string") return null;
  if (!BUILD_ID.test(buildId) || buildId === CHECKOUT_BUILD || !PLATFORM.test(platform)) return null;
  return { buildId, platform };
}

/** The info in a whole mark, sentinels included, or null. */
export function parseBuildMark(mark: string): BuildInfo | null {
  if (!mark.startsWith(MARK_OPEN) || !mark.endsWith(MARK_CLOSE)) return null;
  return parseMarkBody(mark.slice(MARK_OPEN.length, -MARK_CLOSE.length));
}

/**
 * This node's build: the binary's mark, or `checkout` when it runs from a checkout (its platform then `<os>-<arch>`,
 * shown and never used: a checkout is never updated).
 */
export function buildInfo(): BuildInfo {
  const packed = embedded();
  const info = packed?.build === undefined ? null : parseBuildMark(packed.build);
  if (info !== null) return info;
  return { buildId: CHECKOUT_BUILD, platform: packed?.claudeCode.platform ?? `${process.platform}-${process.arch}` };
}

/** What `meddle update` reads from a binary: its mark, and the SHA-256 and size of the whole file. */
export type BinaryInfo = BuildInfo & { sha256: string; size: number };

/** How much of the file is read at a time while scanning and hashing it. */
const CHUNK = 1024 * 1024;

/**
 * Reads a binary's build info without running it: scans the whole file for the mark (the first opening sentinel
 * followed by a valid mark wins; the CLI's own code holds no copy of the sentinel, but a stray one is skipped) and
 * hashes it in the same pass. Throws `<path> is not a meddle binary` when it has no mark.
 */
export async function readBinary(path: string): Promise<BinaryInfo> {
  const handle = await open(path, "r");
  const hasher = new Bun.CryptoHasher("sha256");
  const open_ = Buffer.from(MARK_OPEN);
  let size = 0;
  let found: BuildInfo | null = null;
  // The tail of the previous chunk, so that a mark across a chunk boundary is still found.
  let carry = Buffer.alloc(0);
  try {
    const buf = Buffer.alloc(CHUNK);
    for (;;) {
      const { bytesRead } = await handle.read(buf, 0, CHUNK, null);
      if (bytesRead === 0) break;
      const chunk = buf.subarray(0, bytesRead);
      hasher.update(chunk);
      size += bytesRead;
      if (found !== null) continue;
      const window = Buffer.concat([carry, chunk]);
      let at = window.indexOf(open_);
      while (at >= 0 && found === null) {
        const end = window.indexOf(MARK_CLOSE, at + open_.length);
        if (end < 0 && window.length - at < open_.length + MAX_MARK + MARK_CLOSE.length) break;
        if (end >= 0 && end - at - open_.length <= MAX_MARK) {
          found = parseMarkBody(window.subarray(at + open_.length, end).toString("utf8"));
        }
        if (found === null) at = window.indexOf(open_, at + 1);
      }
      // Kept: everything from an opening sentinel whose close may be in the next chunk, else enough for a split one.
      const keepFrom = found === null && at >= 0 ? at : Math.max(0, window.length - open_.length - MAX_MARK - MARK_CLOSE.length);
      carry = Buffer.from(window.subarray(keepFrom));
    }
  } finally {
    await handle.close();
  }
  if (found === null) throw new Error(`${path} is not a meddle binary (it has no build mark)`);
  return { ...found, sha256: hasher.digest("hex"), size };
}

/** The SHA-256 (hex) and size of a file, read in chunks. */
export async function hashFile(path: string): Promise<{ sha256: string; size: number }> {
  const handle = await open(path, "r");
  try {
    return await hashHandle(handle);
  } finally {
    await handle.close();
  }
}

/** The SHA-256 (hex) and size of an open file, read from its start at explicit offsets: its position is left as it was. */
export async function hashHandle(handle: FileHandle): Promise<{ sha256: string; size: number }> {
  const hasher = new Bun.CryptoHasher("sha256");
  let size = 0;
  const buf = Buffer.alloc(CHUNK);
  for (;;) {
    const { bytesRead } = await handle.read(buf, 0, CHUNK, size);
    if (bytesRead === 0) break;
    hasher.update(buf.subarray(0, bytesRead));
    size += bytesRead;
  }
  return { sha256: hasher.digest("hex"), size };
}

/** What tells cheaply whether a file was replaced or written: its inode, size and change times. */
export async function statMark(path: string): Promise<string> {
  const s = await stat(path);
  return `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
}
