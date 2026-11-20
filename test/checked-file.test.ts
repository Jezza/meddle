import { afterEach, test, expect } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Refused, writeChecked } from "../src/checked-file";

async function* chunks(...parts: string[]) { for (const p of parts) yield new TextEncoder().encode(p); }
const sha = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

/** The directories the test made, removed after it. */
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "checked-"));
  dirs.push(dir);
  return dir;
}

/** What `writeChecked` rejected with, or null when it wrote. */
const refusal = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

test("the bytes are written to the file, hashed, and left there with the mode asked for", async () => {
  const dir = await tempDir();
  const temp = join(dir, "t");
  expect(await writeChecked(chunks("hel", "lo"), temp, { maxBytes: 5, mode: 0o755 })).toEqual({ hash: sha("hello"), size: 5 });
  expect(await readFile(temp, "utf8")).toBe("hello");
  // Whatever the umask: a binary must be executable by all, a blob private.
  expect((await stat(temp)).mode & 0o777).toBe(0o755);
  const priv = join(dir, "p");
  await writeChecked(chunks("hello"), priv, { maxBytes: 5, mode: 0o600, expect: { hash: sha("hello"), size: 5 } });
  expect((await stat(priv)).mode & 0o777).toBe(0o600);
});

test("bytes that are too many, too few or other are refused for why, with what came, and no file is left", async () => {
  const dir = await tempDir();
  const temp = join(dir, "t");
  const expect5 = { hash: sha("hello"), size: 5 };
  const cases: Array<[AsyncIterable<Uint8Array>, number, Refused["why"], Refused["got"]]> = [
    [chunks("12345", "6"), 5, "over", { hash: null, size: 6 }],
    [chunks("hel"), 5, "short", { hash: sha("hel"), size: 3 }],
    [chunks("world"), 5, "mismatch", { hash: sha("world"), size: 5 }],
    // More than expected but within the limit: not the bytes asked for.
    [chunks("hello!"), 10, "mismatch", { hash: sha("hello!"), size: 6 }],
  ];
  for (const [bytes, maxBytes, why, got] of cases) {
    const err = await refusal(writeChecked(bytes, temp, { maxBytes, mode: 0o600, expect: expect5 }));
    expect(err).toBeInstanceOf(Refused);
    expect(err).toMatchObject({ why, got });
    expect(await readdir(dir)).toEqual([]);
  }
});

test("a source that fails rejects with its own error, and no file is left", async () => {
  const dir = await tempDir();
  async function* failing() {
    yield new TextEncoder().encode("hel");
    throw new Error("the peer went away");
  }
  const err = await refusal(writeChecked(failing(), join(dir, "t"), { maxBytes: 5, mode: 0o600 }));
  expect(err).not.toBeInstanceOf(Refused);
  expect((err as Error).message).toBe("the peer went away");
  expect(await readdir(dir)).toEqual([]);
});

test("a file already at the temporary path is not written over, nor removed", async () => {
  const dir = await tempDir();
  const temp = join(dir, "t");
  await writeFile(temp, "someone else's");
  expect(((await refusal(writeChecked(chunks("hello"), temp, { maxBytes: 5, mode: 0o600 }))) as NodeJS.ErrnoException).code).toBe("EEXIST");
  expect(await readFile(temp, "utf8")).toBe("someone else's");
});
