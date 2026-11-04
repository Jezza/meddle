// src/claude-code.ts — the single binary's Claude Code: the version `bun run build` pinned it to, installed once per
// version at `<data dir>/bin/claude-<version>`, from the binary itself (a build with --embed-claude) or downloaded from
// the npm registry, and in either case checked against the SHA-256 the Agent SDK's manifest gives for it.
import { chmod, mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

/** The Claude Code a build pinned: the Agent SDK's manifest entry for the build's platform. */
export type ClaudePin = {
  /** Claude Code's version (`2.1.314`), from the manifest. */
  version: string;
  /** The Agent SDK's version (`0.3.314`): its platform package, which carries Claude Code, has the same. */
  sdkVersion: string;
  /** The manifest's platform key and the platform package's suffix (`linux-x64`, `linux-arm64-musl`, …). */
  platform: string;
  /** The binary's file name in the package (`claude`, `claude.exe`). */
  binary: string;
  /** Its SHA-256, hex, and size in bytes. */
  checksum: string;
  size: number;
};

/** Where `pin`'s Claude Code is installed under the data directory. */
export function claudePath(pin: Pick<ClaudePin, "version">, dataDir: string): string {
  return join(dataDir, "bin", `claude-${pin.version}`);
}

/** The platform package's tarball on `registry`. */
export function tarballUrl(pin: Pick<ClaudePin, "platform" | "sdkVersion">, registry: string): string {
  const name = `claude-agent-sdk-${pin.platform}`;
  return `${registry}/@anthropic-ai/${name}/-/${name}-${pin.sdkVersion}.tgz`;
}

/** Reads a byte stream in exact amounts, or as pieces of up to an amount, as a tar reader needs. */
class ByteReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  #chunks: Uint8Array[] = [];
  #buffered = 0;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.#reader = stream.getReader();
  }

  /** Buffers at least `n` bytes; false when the stream ends first. */
  async #fill(n: number): Promise<boolean> {
    while (this.#buffered < n) {
      const { done, value } = await this.#reader.read();
      if (done) return false;
      this.#chunks.push(value);
      this.#buffered += value.length;
    }
    return true;
  }

  /** Takes up to `n` buffered bytes off the front, without copying when one chunk holds them. */
  #take(n: number): Uint8Array {
    const first = this.#chunks[0]!;
    const k = Math.min(first.length, n);
    if (k === first.length) this.#chunks.shift();
    else this.#chunks[0] = first.subarray(k);
    this.#buffered -= k;
    return first.subarray(0, k);
  }

  /** Exactly `n` bytes, or null when the stream ends before them. */
  async exact(n: number): Promise<Uint8Array | null> {
    if (!(await this.#fill(n))) return null;
    const out = new Uint8Array(n);
    for (let at = 0; at < n; ) {
      const piece = this.#take(n - at);
      out.set(piece, at);
      at += piece.length;
    }
    return out;
  }

  /** The next `n` bytes as they arrive; throws when the stream ends first. */
  async *pieces(n: number): AsyncGenerator<Uint8Array> {
    for (let left = n; left > 0; ) {
      if (this.#buffered === 0 && !(await this.#fill(1))) throw new Error("the archive ended early");
      const piece = this.#take(left);
      left -= piece.length;
      yield piece;
    }
  }

  async skip(n: number): Promise<void> {
    for await (const _ of this.pieces(n));
  }

  cancel(): void {
    void this.#reader.cancel().catch(() => {});
  }
}

const decoder = new TextDecoder();

/** A NUL-terminated string field of a tar header. */
function field(header: Uint8Array, at: number, length: number): string {
  const bytes = header.subarray(at, at + length);
  const end = bytes.indexOf(0);
  return decoder.decode(end === -1 ? bytes : bytes.subarray(0, end));
}

/** The `path` record of a pax extended header, if it has one. */
function paxPath(data: Uint8Array): string | null {
  for (const record of decoder.decode(data).split("\n")) {
    const m = /^\d+ path=(.*)$/.exec(record);
    if (m !== null) return m[1]!;
  }
  return null;
}

/**
 * The bytes of the file `name` in the (uncompressed) tar archive `archive`, as they arrive; throws when the archive
 * has no such file or ends early. Reads ustar headers, with pax (`x`) and GNU (`L`) long names.
 */
export async function* tarFile(archive: ReadableStream<Uint8Array>, name: string): AsyncGenerator<Uint8Array> {
  const reader = new ByteReader(archive);
  try {
    let longName: string | null = null;
    for (;;) {
      const header = await reader.exact(512);
      if (header === null || header.every((b) => b === 0)) throw new Error(`the archive has no ${name}`);
      const size = parseInt(field(header, 124, 12).trim() || "0", 8);
      if (!Number.isFinite(size) || size < 0) throw new Error("the archive has a malformed header");
      const padded = Math.ceil(size / 512) * 512;
      const type = String.fromCharCode(header[156]!);
      if (type === "x" || type === "L") {
        const data = await reader.exact(padded);
        if (data === null) throw new Error("the archive ended early");
        longName = type === "x" ? paxPath(data.subarray(0, size)) : field(data, 0, size);
        continue;
      }
      const prefix = field(header, 257, 6) === "ustar" ? field(header, 345, 155) : "";
      const path = longName ?? (prefix === "" ? field(header, 0, 100) : `${prefix}/${field(header, 0, 100)}`);
      longName = null;
      if (path === name && (type === "0" || type === "\0")) {
        yield* reader.pieces(size);
        return;
      }
      await reader.skip(padded);
    }
  } finally {
    reader.cancel();
  }
}

/**
 * Writes `bytes` to `pin`'s place under `dataDir` (mode 755): through a temporary file, hashed as it is written and
 * renamed into place only when its size and SHA-256 are the pin's, so that nothing unverified is ever at that path.
 */
async function installVerified(pin: ClaudePin, dataDir: string, bytes: AsyncIterable<Uint8Array>): Promise<string> {
  const target = claudePath(pin, dataDir);
  await mkdir(join(dataDir, "bin"), { recursive: true, mode: 0o700 });
  const partial = `${target}.${process.pid}.partial`;
  const hash = new Bun.CryptoHasher("sha256");
  let size = 0;
  const file = await open(partial, "w", 0o700);
  try {
    try {
      for await (const piece of bytes) {
        hash.update(piece);
        size += piece.length;
        if (size > pin.size) throw new Error(`more than the ${pin.size} bytes expected`);
        await file.write(piece);
      }
    } finally {
      await file.close();
    }
    if (size !== pin.size) throw new Error(`${size} bytes, not the ${pin.size} expected`);
    const checksum = hash.digest("hex");
    if (checksum !== pin.checksum) throw new Error(`SHA-256 ${checksum}, not the ${pin.checksum} the Agent SDK's manifest gives`);
    await chmod(partial, 0o755);
    await rename(partial, target);
  } catch (err) {
    await unlink(partial).catch(() => {});
    throw err;
  }
  return target;
}

export type InstallDeps = {
  /** The npm registry to download from (`NodeConfig.npmRegistry`). */
  registry: string;
  /** Claude Code inside the binary itself (a build with --embed-claude), or null to download it. */
  embedded: string | null;
  log(line: string): void;
  fetch?: typeof fetch;
};

/** How long a download may take in all before it is given up. */
const DOWNLOAD_MS = 15 * 60_000;

/**
 * The path of `pin`'s Claude Code, installing it first when it is not there yet (a file of the pin's size at its
 * path counts as installed: only a verified file is ever renamed there). From the binary when it embeds Claude Code,
 * else from the platform package's tarball on the registry, streamed, unpacked and verified as it arrives.
 */
export async function ensureClaude(pin: ClaudePin, dataDir: string, deps: InstallDeps): Promise<string> {
  const target = claudePath(pin, dataDir);
  const existing = await stat(target).catch(() => null);
  if (existing?.isFile() && existing.size === pin.size) return target;
  if (deps.embedded !== null) {
    try {
      return await installVerified(pin, dataDir, Bun.file(deps.embedded).stream());
    } catch (err) {
      throw new Error(`cannot install the embedded Claude Code ${pin.version}: ${(err as Error).message}`);
    }
  }
  const url = tarballUrl(pin, deps.registry);
  deps.log(`meddle: downloading Claude Code ${pin.version} (${pin.platform}) from ${url}`);
  try {
    const response = await (deps.fetch ?? fetch)(url, { signal: AbortSignal.timeout(DOWNLOAD_MS) });
    if (!response.ok || response.body === null) throw new Error(`HTTP ${response.status}`);
    const archive = response.body.pipeThrough(new DecompressionStream("gzip"));
    const path = await installVerified(pin, dataDir, tarFile(archive, `package/${pin.binary}`));
    deps.log(`meddle: Claude Code ${pin.version} installed at ${path} (SHA-256 verified)`);
    return path;
  } catch (err) {
    throw new Error(
      `cannot download Claude Code ${pin.version} (${pin.platform}) from ${url}: ${(err as Error).message}; ` +
        "set MEDDLE_NPM_REGISTRY to a mirror, or use a binary built with --embed-claude",
    );
  }
}
