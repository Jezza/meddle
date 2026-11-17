import { test, expect, beforeEach } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readdir, readFile, stat, writeFile, mkdir } from "node:fs/promises";
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
test("a file is a copy, so editing it leaves the blob as it was", async () => {
  const p = await materialize(store, dir, text);
  expect((await stat(p)).ino).not.toBe((await stat(store.path(text.hash))).ino);
  expect((await stat(p)).nlink).toBe(1);
  expect((await stat(p)).mode & 0o777).toBe(0o600);
  await writeFile(p, "edited by the agent");
  expect(await readFile(p, "utf8")).toBe("edited by the agent");
  expect(await readFile(store.path(text.hash), "utf8")).toBe("line\n");
  expect(await store.has(text.hash)).toBe(true);
});
test("a file is written whole under its own name, with no temporary file left", async () => {
  await materialize(store, dir, text);
  await materialize(store, dir, text);
  expect(await readdir(`${dir}/${text.hash}`)).toEqual(["server.log"]);
});
test("a file that cannot be copied leaves nothing behind", async () => {
  if (process.getuid?.() === 0) return; // root reads whatever the mode says
  await chmod(store.path(text.hash), 0o000);
  try {
    await expect(materialize(store, dir, text)).rejects.toThrow();
  } finally {
    await chmod(store.path(text.hash), 0o600);
  }
  expect(await readdir(`${dir}/${text.hash}`)).toEqual([]);
});
test("an attachment that is not safe to write is refused before anything is written", async () => {
  await expect(materialize(store, dir, { ...text, name: "../x" })).rejects.toThrow(/^bad attachment: name /);
  await expect(materialize(store, dir, { ...text, name: ".bashrc" })).rejects.toThrow("bad attachment: name");
  await expect(materialize(store, dir, { ...text, hash: "../" + "a".repeat(61) })).rejects.toThrow("bad attachment: hash");
  await expect(promptContent(store, dir, { text: "x", attachments: [{ ...text, name: "a/b" }] })).rejects.toThrow("bad attachment: name");
  await expect(readdir(dir)).rejects.toThrow("ENOENT");
  expect(existsSync(join(dir, "x"))).toBe(false);
});
test("a blob not in the store fails", async () => {
  await expect(materialize(store, dir, { ...shot, hash: "0".repeat(64) })).rejects.toThrow("attachment shot.png is not here");
  await expect(promptContent(store, dir, { text: "x", attachments: [{ ...shot, hash: "0".repeat(64) }] })).rejects.toThrow("attachment shot.png is not here");
});
