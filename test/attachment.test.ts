import { test, expect } from "bun:test";
import {
  type Attachment, IMAGE_BUDGET_BASE64, INLINE_IMAGE_TYPES, MAX_BLOB_BYTES, MAX_IMAGE_BASE64,
  attachmentProblem, base64Length, cleanName, inlined, isBlobHash, pastedName, promptOf, queueEntry,
} from "../src/blobs/attachment";

const att = (over: Partial<Attachment> = {}): Attachment =>
  ({ hash: "a".repeat(64), name: "shot.png", type: "image/png", size: 1000, ...over });

test("the limits are 64 MB a file, and 5 MiB then 10 MiB of base64 for inline images", () => {
  expect(MAX_BLOB_BYTES).toBe(64 * 1024 * 1024);
  expect(MAX_IMAGE_BASE64).toBe(5 * 1024 * 1024);
  expect(IMAGE_BUDGET_BASE64).toBe(10 * 1024 * 1024);
  expect(INLINE_IMAGE_TYPES).toEqual(["image/png", "image/jpeg", "image/gif", "image/webp"]);
});
test("a hash is 64 lowercase hex characters", () => {
  expect(isBlobHash("0f".repeat(32))).toBe(true);
  expect(isBlobHash("0F".repeat(32))).toBe(false);
  expect(isBlobHash("../" + "a".repeat(61))).toBe(false);
  expect(isBlobHash("a".repeat(64) + "\n")).toBe(false);
  expect(isBlobHash("a".repeat(63))).toBe(false);
});
test("base64 is four characters for each three bytes, rounded up", () => {
  expect([0, 1, 3, 4, 3_500_000].map(base64Length)).toEqual([0, 4, 4, 8, 4_666_668]);
});
test("cleanName keeps a base name", () => {
  expect(cleanName("../../x")).toBe("_.._x");
  expect(cleanName(".bashrc")).toBe("bashrc");
  expect(cleanName("a/b.png")).toBe("a_b.png");
  expect(cleanName("a\\b.png")).toBe("a_b.png");
  expect(cleanName("...")).toBe("file");
  expect(cleanName("")).toBe("file");
  expect(cleanName("shot.png")).toBe("shot.png");
  const long = cleanName("x".repeat(300) + ".png");
  expect(long.length).toBe(200);
  expect(long.endsWith(".png")).toBe(true);
});
test("cleanName cuts a long name without splitting a character, and a long extension with it", () => {
  const emoji = cleanName("😀".repeat(150) + ".png");
  expect(emoji.length).toBeLessThanOrEqual(200);
  expect(emoji.endsWith("😀.png")).toBe(true);
  expect(emoji).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  expect(cleanName("a." + "x".repeat(300))).toBe(("a." + "x".repeat(300)).slice(0, 200));
});
test("everything cleanName returns is a name attachmentProblem accepts", () => {
  for (const name of ["../../x", ".bashrc", "...", "", "x".repeat(300) + ".png", "a\\b/c", "😀".repeat(300), "😀." + "x".repeat(199)]) {
    expect(attachmentProblem(att({ name: cleanName(name) }))).toBeNull();
  }
});
test("pastedName names a clipboard image by its time", () => {
  expect(pastedName("image/png", new Date(2026, 10, 17, 9, 5, 3))).toBe("pasted-20261117-090503.png");
  expect(pastedName("image/jpeg", new Date(2026, 0, 2, 3, 4, 5))).toBe("pasted-20260102-030405.jpg");
  expect(pastedName("image/gif", new Date(2026, 0, 2, 3, 4, 5))).toBe("pasted-20260102-030405.gif");
  expect(pastedName("image/webp", new Date(2026, 0, 2, 3, 4, 5))).toBe("pasted-20260102-030405.webp");
  expect(pastedName("image/heic", new Date(2026, 0, 2, 3, 4, 5))).toBe("pasted-20260102-030405.bin");
});
test("attachmentProblem refuses what a node must not write", () => {
  expect(attachmentProblem(att())).toBeNull();
  expect(attachmentProblem(att({ hash: "zz" }))).not.toBeNull();
  for (const name of ["../x", ".bashrc", "a/b", "a\\b", "", "x".repeat(201)]) expect(attachmentProblem(att({ name }))).not.toBeNull();
  expect(attachmentProblem(att({ name: "x".repeat(200) }))).toBeNull();
  expect(attachmentProblem(att({ size: -1 }))).not.toBeNull();
  expect(attachmentProblem(att({ size: 1.5 }))).not.toBeNull();
  expect(attachmentProblem(att({ size: 0 }))).toBeNull();
  expect(attachmentProblem({ hash: "a".repeat(64) })).not.toBeNull();
  expect(attachmentProblem(null)).not.toBeNull();
  expect(attachmentProblem("a")).not.toBeNull();
});
test("attachmentProblem says which part is wrong", () => {
  expect(attachmentProblem(att({ hash: "zz" }))).toStartWith("hash");
  expect(attachmentProblem(att({ name: "a/b" }))).toStartWith("name");
  expect(attachmentProblem(att({ size: -1 }))).toStartWith("size");
  expect(attachmentProblem({ ...att(), type: 1 })).toStartWith("type");
});
test("a queue entry is a string for text alone, and either shape reads back", () => {
  expect(queueEntry({ text: "hi", attachments: [] })).toBe("hi");
  expect(promptOf("hi")).toEqual({ text: "hi", attachments: [] });
  const p = { text: "", attachments: [att()] };
  expect(promptOf(queueEntry(p))).toEqual(p);
  expect(() => promptOf({ text: 1 })).toThrow("bad queued prompt");
});
test("a queued prompt reads back with each attachment as its four fields only", () => {
  const entry = { text: "x", attachments: [{ ...att(), data: "AAAA", note: { deep: true } }], extra: 1 };
  expect(promptOf(entry)).toEqual({ text: "x", attachments: [att()] });
  expect(Object.keys(promptOf(entry).attachments[0]!)).toEqual(["hash", "name", "type", "size"]);
});
test("a queued prompt that would write somewhere it must not is refused", () => {
  expect(() => promptOf({ text: "x", attachments: [att({ name: "../x" })] })).toThrow("bad queued prompt");
  expect(() => promptOf({ text: "x", attachments: "none" })).toThrow("bad queued prompt");
  expect(() => promptOf(null)).toThrow("bad queued prompt");
  expect(() => promptOf(7)).toThrow("bad queued prompt");
});
test("inlined takes supported images under 5 MiB of base64 until 10 MiB together", () => {
  const big = 3_500_000; // 4_666_668 base64
  expect(inlined([att({ size: big }), att({ size: big }), att({ size: big })])).toEqual([true, true, false]);
  expect(inlined([att({ size: 4_000_000 })])).toEqual([false]); // 5_333_336 base64
  expect(inlined([att({ type: "image/svg+xml" }), att({ type: "image/heic" }), att({ type: "text/plain" })])).toEqual([false, false, false]);
});
test("inlined skips what does not fit and goes on, so a later smaller image can still be inline", () => {
  const big = 3_500_000; // 4_666_668 base64
  const small = 300_000; // 400_000 base64
  expect(inlined([att({ size: big }), att({ size: big }), att({ size: big }), att({ size: small })])).toEqual([true, true, false, true]);
  // over the limit is skipped without using any budget
  expect(inlined([att({ size: 4_000_000 }), att({ size: small })])).toEqual([false, true]);
  expect(inlined([])).toEqual([]);
});
test("inlined never inlines an empty image: an empty image block would likely fail the turn", () => {
  expect(inlined([att({ size: 0 })])).toEqual([false]);
  expect(inlined([att({ size: 0 }), att({ size: 1 })])).toEqual([false, true]);
});
