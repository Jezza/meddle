import { test, expect } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BlobStore } from "../src/blobs/store";

async function* chunks(...parts: string[]) { for (const p of parts) yield new TextEncoder().encode(p); }
const sha = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

test("a blob is stored under its hash, once", async () => {
  const store = new BlobStore(join(await mkdtemp("/tmp/blobs-"), "blobs"));
  const a = await store.write(chunks("hel", "lo"));
  expect(a).toEqual({ hash: sha("hello"), size: 5 });
  expect(await store.write(chunks("hello"))).toEqual(a);
  expect(await readFile(store.path(a.hash), "utf8")).toBe("hello");
  expect((await readdir(store.dir)).sort()).toEqual([a.hash]);
  expect((await stat(store.dir)).mode & 0o777).toBe(0o700);
  expect((await stat(store.path(a.hash))).mode & 0o777).toBe(0o600);
});

test("too large, or not what was expected: refused, nothing left", async () => {
  const store = new BlobStore(join(await mkdtemp("/tmp/blobs-"), "blobs"));
  await expect(store.write(chunks("12345", "6"), { maxBytes: 5 })).rejects.toThrow("blob exceeds 5 bytes");
  await expect(store.write(chunks("hello"), { expect: { hash: sha("other"), size: 5 } })).rejects.toThrow(`blob does not match ${sha("other")}`);
  expect(await readdir(store.dir)).toEqual([]);
});

test("a stream that fails halfway leaves no temporary file", async () => {
  const store = new BlobStore(join(await mkdtemp("/tmp/blobs-"), "blobs"));
  async function* broken() { yield new Uint8Array([1]); throw new Error("cut off"); }
  await expect(store.write(broken())).rejects.toThrow("cut off");
  expect(await readdir(store.dir)).toEqual([]);
});

test("path refuses what is not a hash; sweepTemps removes what a crash left", async () => {
  const store = new BlobStore(join(await mkdtemp("/tmp/blobs-"), "blobs"));
  expect(() => store.path("../etc")).toThrow("not a blob hash: ../etc");
  await mkdir(store.dir, { recursive: true });
  await writeFile(join(store.dir, ".tmp-x"), "partial");
  expect(await store.sweepTemps()).toBe(1);
  expect(await readdir(store.dir)).toEqual([]);
});

test("has is true for a stored blob only, and false for what is not a hash", async () => {
  const store = new BlobStore(join(await mkdtemp("/tmp/blobs-"), "blobs"));
  expect(await store.has(sha("hello"))).toBe(false);
  await store.write(chunks("hello"));
  expect(await store.has(sha("hello"))).toBe(true);
  expect(await store.has(sha("other"))).toBe(false);
  expect(await store.has("../etc")).toBe(false);
});
