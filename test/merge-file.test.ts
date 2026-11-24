import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeFile, mergeJson, mergeKind, mergeLines, mergeWhole } from "../src/scopes/merge-file";
import { repoRoot } from "./helpers";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

test("both sides' appended lines are kept, the first parent's first", () => {
  expect(mergeLines("a\nb\n", "a\nb\nx\n", "a\nb\ny\n")).toBe("a\nb\nx\ny\n");
});

test("a line both sides already hold is kept once", () => {
  // Both merged "p" in by different routes at different places: no duplicate.
  expect(mergeLines("a\n", "a\np\nx\n", "p\na\ny\n").split("\n").filter((l) => l === "p")).toHaveLength(1);
});

test("blank lines are not capped", () => {
  expect(mergeLines("a\n", "a\n\nx\n", "a\n\ny\n")).toBe("a\n\nx\n\ny\n");
});

test("one-sided edits merge cleanly", () => {
  expect(mergeLines("a\nb\nc\n", "A\nb\nc\n", "a\nb\nC\n")).toBe("A\nb\nC\n");
});

test("the same line edited on both sides keeps both versions", () => {
  expect(mergeLines("a\nb\n", "a\nB1\n", "a\nB2\n")).toBe("a\nB1\nB2\n");
});

test("the same edit on both sides is kept once", () => {
  expect(mergeLines("a\nb\n", "a\nB\n", "a\nB\n")).toBe("a\nB\n");
});

test("a file without a final newline merges", () => {
  expect(mergeLines("a", "a\nx", "a\ny")).toBe("a\nx\ny");
});

test("a line deleted on one side and kept on the other goes", () => {
  expect(mergeLines("a\nb\nc\n", "a\nc\n", "a\nb\nc\nd\n")).toBe("a\nc\nd\n");
});

test("json: keys changed on one side each, both kept", () => {
  expect(JSON.parse(mergeJson('{"a":1}', '{"a":1,"b":2}', '{"a":1,"c":3}'))).toEqual({ a: 1, b: 2, c: 3 });
});

test("json: a key changed to different values on both sides takes the second parent's", () => {
  expect(JSON.parse(mergeJson('{"m":"x"}', '{"m":"y"}', '{"m":"z"}'))).toEqual({ m: "z" });
});

test("json: arrays changed on both sides are the first's items then the second's new ones", () => {
  expect(JSON.parse(mergeJson('{"l":["a"]}', '{"l":["a","b"]}', '{"l":["a","c"]}'))).toEqual({ l: ["a", "b", "c"] });
});

test("json: nested objects merge per key; a key deleted on one side and untouched on the other goes", () => {
  expect(JSON.parse(mergeJson('{"p":{"x":1,"y":2}}', '{"p":{"x":1}}', '{"p":{"x":1,"y":2,"z":3}}'))).toEqual({ p: { x: 1, z: 3 } });
});

test("json: an unparseable side loses to the parseable one", () => {
  expect(mergeJson('{"a":1}', '{"a":', '{"a":2}')).toBe('{\n  "a": 2\n}\n');
});

test("json: output is two-space indented with a final newline", () => {
  expect(mergeJson("{}", '{"a":1}', "{}")).toBe('{\n  "a": 1\n}\n');
});

test("whole: changed on both sides, the second parent's wins", () => {
  expect(mergeWhole(enc("a"), enc("b"), enc("c"))).toEqual(enc("c"));
});

test("whole: changed on one side only, that side's", () => {
  expect(mergeWhole(enc("a"), enc("b"), enc("a"))).toEqual(enc("b"));
  expect(mergeWhole(enc("a"), enc("a"), enc("c"))).toEqual(enc("c"));
});

test("mergeFile picks the rule by name", () => {
  expect(mergeKind("MEMORY.md")).toBe("lines");
  expect(mergeKind("notes.txt")).toBe("lines");
  expect(mergeKind("settings.json")).toBe("json");
  expect(mergeKind("hooks/run.sh")).toBe("whole");
  expect(dec(mergeFile("MEMORY.md", enc("a\n"), enc("a\nx\n"), enc("a\ny\n")))).toBe("a\nx\ny\n");
});

test("mergeFile treats bytes that are not UTF-8 as a whole file", () => {
  const bad = new Uint8Array([0xff, 0xfe, 0x00]);
  expect(mergeFile("x.md", enc("a\n"), enc("b\n"), bad)).toEqual(bad);
});

test("every rule is deterministic", () => {
  let s = 7;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const lines = () => Array.from({ length: Math.floor(rand() * 8) }, () => ["a", "b", "c", "", "- [x](x.md)"][Math.floor(rand() * 5)]).join("\n");
  for (let i = 0; i < 200; i++) {
    const [b, o, t] = [lines(), lines(), lines()];
    expect(mergeLines(b, o, t)).toBe(mergeLines(b, o, t));
    const js = () => JSON.stringify({ k: lines().split("\n"), [lines() || "z"]: rand() < 0.5 });
    const [jb, jo, jt] = [js(), js(), js()];
    const merged = mergeJson(jb, jo, jt);
    expect(merged).toBe(mergeJson(jb, jo, jt));
    expect(() => JSON.parse(merged)).not.toThrow();
  }
});

test("the driver command merges a file in place", async () => {
  const dir = await mkdtemp(join(tmpdir(), "meddle-driver-"));
  try {
    const [o, a, b] = ["o", "a", "b"].map((n) => join(dir, n)) as [string, string, string];
    await writeFile(o, "a\n");
    await writeFile(a, "a\nx\n");
    await writeFile(b, "a\ny\n");
    const proc = Bun.spawn([process.execPath, join(repoRoot, "src/scopes/merge-driver-main.ts"), "merge-driver", o, a, b, "MEMORY.md"], { stderr: "pipe" });
    expect(await proc.exited).toBe(0);
    expect(await readFile(a, "utf8")).toBe("a\nx\ny\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
