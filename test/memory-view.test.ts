// test/memory-view.test.ts
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { ensureDataDirs, loadConfig } from "../src/config";
import { bookmarkSet, initColocated, jj } from "../src/jj";
import { memoryDiff, memoryEntries, memoryFile, memoryHistory, parseFrontmatter } from "../src/projects/memory-view";

/** A memory repo in a temp home, and a `commit` that commits what is on disk and points `memory` at it as `importMemory` does. */
async function memoryRepo() {
  const home = await mkdtemp("/tmp/meddle-memview-");
  const cfg = loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/data`, MEDDLE_TASK_ROOT: home });
  await ensureDataDirs(cfg);
  const repo = `${home}/mem`;
  await initColocated(repo, cfg);
  const commit = async (message: string) => {
    await jj(["commit", "-m", message], repo, cfg);
    await bookmarkSet(repo, "memory", "@-", cfg);
    return (await jj(["log", "-r", "@-", "--no-graph", "-T", "change_id"], repo, cfg)).trim();
  };
  return { home, cfg, repo, commit, close: () => rm(home, { recursive: true, force: true }) };
}

const entry = (name: string, description: string, type: string, body = "body\n") =>
  `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  type: ${type}\n---\n${body}`;

test("parseFrontmatter reads name, description and metadata.type", () => {
  expect(parseFrontmatter("---\nname: terse-ui-labels\ndescription: \"one word\"\nmetadata:\n  type: feedback\n---\nbody"))
    .toEqual({ name: "terse-ui-labels", description: "one word", type: "feedback" });
  expect(parseFrontmatter("# just a heading\nname: not frontmatter\n")).toEqual({ name: null, description: null, type: null });
  expect(parseFrontmatter("---\nname: p\ntype: project\n---\n")).toEqual({ name: "p", description: null, type: "project" });
});

test("memoryEntries lists MEMORY.md first and reads what is on disk", async () => {
  const { cfg, repo, commit, close } = await memoryRepo();
  try {
    await writeFile(`${repo}/MEMORY.md`, "- [b](b.md)\n");
    await writeFile(`${repo}/b.md`, entry("b-entry", "the b one", "project"));
    await commit("memory from abc123: task t1");
    const a = entry("a-entry", "'the a one'", "feedback");
    await writeFile(`${repo}/a.md`, a);
    await writeFile(`${repo}/notes.txt`, "not memory\n");
    await mkdir(`${repo}/sub`);
    await writeFile(`${repo}/sub/c.md`, entry("c-entry", "nested", "user"));

    const entries = await memoryEntries(cfg, repo);
    expect(entries.map((e) => e.path)).toEqual(["MEMORY.md", "a.md", "b.md"]);
    const [index, onlyOnDisk, committed] = entries;
    expect(index).toMatchObject({ name: null, description: null, type: null });
    expect(onlyOnDisk).toMatchObject({ name: "a-entry", description: "the a one", type: "feedback", last: null });
    expect(onlyOnDisk!.size).toBe(Buffer.byteLength(a));
    expect(onlyOnDisk!.hash).toBe(createHash("sha256").update(await readFile(`${repo}/a.md`)).digest("hex"));
    expect(committed).toMatchObject({ name: "b-entry", type: "project", last: { kind: "task", node: "abc123", task: "t1" } });
  } finally {
    await close();
  }
});

test("memoryHistory names who changed memory", async () => {
  const { cfg, repo, commit, close } = await memoryRepo();
  try {
    await writeFile(`${repo}/MEMORY.md`, "- one\n");
    const imported = await commit("import memory from -home-x-proj");
    await writeFile(`${repo}/b.md`, "b\n");
    const dashboard = await commit("memory: dashboard");
    await writeFile(`${repo}/MEMORY.md`, "- one\n- two\n");
    const node = await commit("memory from abc123");
    await writeFile(`${repo}/b.md`, "b2\n");
    const task = await commit("memory from abc123: task t9");

    const all = await memoryHistory(cfg, repo, { limit: 10 });
    expect(all.map((c) => c.kind)).toEqual(["task", "node", "dashboard", "import"]);
    expect(all.map((c) => c.change)).toEqual([task, node, dashboard, imported]);
    expect(all[0]).toMatchObject({ node: "abc123", task: "t9", description: "memory from abc123: task t9", files: ["b.md"], added: 1, removed: 1 });
    expect(all[1]).toMatchObject({ node: "abc123", task: null, files: ["MEMORY.md"], added: 1, removed: 0 });
    expect(all[2]).toMatchObject({ node: null, task: null, files: ["b.md"], added: 1, removed: 0 });
    expect(all[3]).toMatchObject({ node: null, task: null, files: ["MEMORY.md"], added: 1, removed: 0 });
    expect(new Date(all[0]!.at).toISOString()).toBe(all[0]!.at);

    expect((await memoryHistory(cfg, repo, { limit: 2 })).map((c) => c.change)).toEqual([task, node]);
    expect((await memoryHistory(cfg, repo, { before: node, limit: 10 })).map((c) => c.change)).toEqual([dashboard, imported]);
    expect((await memoryHistory(cfg, repo, { path: "b.md", limit: 10 })).map((c) => c.change)).toEqual([task, dashboard]);
  } finally {
    await close();
  }
});

test("memoryFile and memoryDiff read a change", async () => {
  const { cfg, repo, commit, close } = await memoryRepo();
  try {
    await writeFile(`${repo}/b.md`, "first\n");
    const first = await commit("memory from abc123");
    await writeFile(`${repo}/b.md`, "second\n");
    const second = await commit("memory from abc123");
    await writeFile(`${repo}/b.md`, "on disk\n");

    expect(await memoryFile(cfg, repo, "b.md")).toBe("on disk\n");
    expect(await memoryFile(cfg, repo, "b.md", first)).toBe("first\n");
    expect(await memoryFile(cfg, repo, "b.md", second)).toBe("second\n");
    expect(await memoryFile(cfg, repo, "nope.md")).toBeNull();
    expect(await memoryFile(cfg, repo, "nope.md", first)).toBeNull();
    // Only the repo's top folder is memory.
    expect(await memoryFile(cfg, repo, "../mem/b.md")).toBeNull();

    const diff = await memoryDiff(cfg, repo, second);
    expect(diff).toContain("diff --git a/b.md b/b.md");
    expect(diff).toContain("-first");
    expect(diff).toContain("+second");
  } finally {
    await close();
  }
});

test("reads leave the working copy alone", async () => {
  const { cfg, repo, commit, close } = await memoryRepo();
  try {
    await writeFile(`${repo}/b.md`, "b\n");
    const first = await commit("memory from abc123: task t1");
    await writeFile(`${repo}/a.md`, entry("a-entry", "uncommitted", "user"));
    const at = async () => jj(["--ignore-working-copy", "log", "-r", "@", "--no-graph", "-T", "commit_id"], repo, cfg);
    const before = await at();

    await memoryEntries(cfg, repo);
    await memoryHistory(cfg, repo, { limit: 10 });
    await memoryHistory(cfg, repo, { limit: 10, path: "a.md" });
    await memoryFile(cfg, repo, "b.md", first);
    await memoryFile(cfg, repo, "a.md", first);
    await memoryDiff(cfg, repo, first);

    expect(await at()).toBe(before);
    expect(await jj(["--ignore-working-copy", "diff", "-r", "@", "--name-only"], repo, cfg)).toBe("");
    // A snapshot now picks a.md up: it was still uncommitted.
    expect(await jj(["diff", "-r", "@", "--name-only"], repo, cfg)).toBe("a.md\n");
  } finally {
    await close();
  }
});
