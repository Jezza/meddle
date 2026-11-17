import { test, expect, beforeEach } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BlobStore } from "../src/blobs/store";
import { materialize, promptContent } from "../src/blobs/content";
import type { Attachment } from "../src/blobs/attachment";

async function* chunks(...parts: (string | Uint8Array)[]) {
  for (const p of parts) yield typeof p === "string" ? new TextEncoder().encode(p) : p;
}
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]); // a few bytes are enough; nothing decodes them

let store: BlobStore;
let dir: string;
let shot: Attachment;
let text: Attachment;
beforeEach(async () => {
  const home = await mkdtemp("/tmp/blob-content-");
  store = new BlobStore(join(home, "blobs"));
  dir = join(home, "task", ".meddle", "attachments");
  const png = await store.write(chunks(PNG_BYTES));
  const log = await store.write(chunks("line\n"));
  shot = { hash: png.hash, name: "shot.png", type: "image/png", size: png.size };
  text = { hash: log.hash, name: "server.log", type: "text/plain", size: log.size };
});

test("images go inline, every file goes as a path", async () => {
  const content = await promptContent(store, dir, { text: "look", attachments: [shot, text] });
  expect(content).toEqual([
    { type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from(PNG_BYTES).toString("base64") } },
    { type: "text", text: `look\n\nAttached files:\n- shot.png: ${dir}/${shot.hash}/shot.png\n- server.log: ${dir}/${text.hash}/server.log` },
  ]);
  expect(await readFile(`${dir}/${text.hash}/server.log`, "utf8")).toBe("line\n");
  expect(new Uint8Array(await readFile(`${dir}/${shot.hash}/shot.png`))).toEqual(PNG_BYTES);
});
test("an image alone, no text, still says where its file is", async () => {
  const content = await promptContent(store, dir, { text: "  ", attachments: [shot] });
  expect((content as any[])[1]).toEqual({ type: "text", text: `Attached files:\n- shot.png: ${dir}/${shot.hash}/shot.png` });
});
test("text alone stays a string; writing a file twice is harmless", async () => {
  expect(await promptContent(store, dir, { text: "hi", attachments: [] })).toBe("hi");
  const p = await materialize(store, dir, shot);
  expect(p).toBe(`${dir}/${shot.hash}/shot.png`);
  expect(await materialize(store, dir, shot)).toBe(p);
});
test("a file that is not an inline image has no image block, and neither has an empty image", async () => {
  const empty = await store.write(chunks(""));
  const emptyPng = { hash: empty.hash, name: "x.png", type: "image/png", size: 0 };
  const content = await promptContent(store, dir, { text: "", attachments: [text, emptyPng] });
  expect(content).toEqual([
    { type: "text", text: `Attached files:\n- server.log: ${dir}/${text.hash}/server.log\n- x.png: ${dir}/${empty.hash}/x.png` },
  ]);
  expect(await readFile(`${dir}/${empty.hash}/x.png`, "utf8")).toBe("");
});
test("the same bytes under two names are two files, and each image block keeps its order", async () => {
  const again = { ...shot, name: "again.png" };
  const content = (await promptContent(store, dir, { text: "two", attachments: [again, shot] })) as any[];
  expect(content.map((b) => b.type)).toEqual(["image", "image", "text"]);
  expect(content[2].text).toBe(`two\n\nAttached files:\n- again.png: ${dir}/${shot.hash}/again.png\n- shot.png: ${dir}/${shot.hash}/shot.png`);
});
test("an existing file at the path is kept, not replaced", async () => {
  await mkdir(`${dir}/${text.hash}`, { recursive: true });
  await writeFile(`${dir}/${text.hash}/server.log`, "mine");
  expect(await materialize(store, dir, text)).toBe(`${dir}/${text.hash}/server.log`);
  expect(await readFile(`${dir}/${text.hash}/server.log`, "utf8")).toBe("mine");
});
test("a file is a hard link to the blob", async () => {
  const p = await materialize(store, dir, text);
  expect((await stat(p)).ino).toBe((await stat(store.path(text.hash))).ino);
  expect((await stat(p)).mode & 0o777).toBe(0o600);
});
// A directory on another filesystem than the blob store's, where link fails with EXDEV and a copy is written.
const otherFs = existsSync("/dev/shm") && statSync("/dev/shm").dev !== statSync("/tmp").dev;
test.skipIf(!otherFs)("a file is a copy where it cannot be linked", async () => {
  const root = await mkdtemp("/dev/shm/blob-content-");
  try {
    const q = await materialize(store, join(root, "attachments"), text);
    expect(await readFile(q, "utf8")).toBe("line\n");
    expect((await stat(q)).ino).not.toBe((await stat(store.path(text.hash))).ino);
    expect((await stat(q)).mode & 0o777).toBe(0o600);
    expect(await materialize(store, join(root, "attachments"), text)).toBe(q);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("a blob not in the store fails", async () => {
  await expect(materialize(store, dir, { ...shot, hash: "0".repeat(64) })).rejects.toThrow("attachment shot.png is not here");
  await expect(promptContent(store, dir, { text: "x", attachments: [{ ...shot, hash: "0".repeat(64) }] })).rejects.toThrow("attachment shot.png is not here");
});
