import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { loadConfig } from "../src/config";
import { commitOf, git, initColocated, jj } from "../src/jj";
import { trialMerge, treeOf } from "../src/git/merge-tree";

const LINES = ["one", "two", "three", "four", "five", "six", "seven"].map((l) => `${l}\n`);

/** `LINES` with line `n` (1-based) replaced by `text`. */
const edited = (n: number, text: string) => LINES.map((l, i) => (i === n - 1 ? `${text}\n` : l)).join("");

/** A colocated repo with one commit `base` holding `f.txt` (`LINES`) and `g.txt`; its commits are made by `on`. */
async function repoWithBase() {
  const dir = await mkdtemp("/tmp/meddle-merge-tree-");
  await initColocated(dir);
  const cfg = loadConfig({ HOME: dir, MEDDLE_DATA_DIR: `${dir}/d`, MEDDLE_TASK_ROOT: `${dir}/t` });
  await Bun.write(`${dir}/f.txt`, LINES.join(""));
  await Bun.write(`${dir}/g.txt`, "g\n");
  await jj(["commit", "-m", "base"], dir);
  const base = await commitOf(dir, "@-");
  /** A commit of `files` on `base`. */
  const on = async (message: string, files: Record<string, string>) => {
    await jj(["new", base], dir);
    for (const [name, content] of Object.entries(files)) await Bun.write(`${dir}/${name}`, content);
    await jj(["commit", "-m", message], dir);
    return commitOf(dir, "@-");
  };
  const show = (tree: string, file: string) => git(["cat-file", "-p", `${tree}:${file}`], dir);
  return { dir, cfg, base, on, show };
}

test("treeOf reads a commit's tree", async () => {
  const { dir, cfg, base, on } = await repoWithBase();
  const commit = await on("edit", { "f.txt": edited(1, "ONE") });
  expect(await treeOf(cfg, dir, commit)).toBe((await git(["rev-parse", `${commit}^{tree}`], dir)).trim());
  expect(await treeOf(cfg, dir, commit)).not.toBe(await treeOf(cfg, dir, base));
  expect(await treeOf(cfg, dir, commit)).toMatch(/^[0-9a-f]{40}$/);
  await expect(treeOf(cfg, dir, "0".repeat(40))).rejects.toThrow();
});

test("trialMerge of two disjoint edits gives the merged tree", async () => {
  const { dir, cfg, on, show } = await repoWithBase();
  const a = await on("top", { "f.txt": edited(1, "ONE") });
  const b = await on("bottom", { "f.txt": edited(7, "SEVEN") });
  const result = await trialMerge(cfg, dir, [a, b]);
  expect(result.conflicts).toEqual([]);
  expect(result.tree).toMatch(/^[0-9a-f]{40}$/);
  expect(await show(result.tree!, "f.txt")).toBe(LINES.map((l, i) => (i === 0 ? "ONE\n" : i === 6 ? "SEVEN\n" : l)).join(""));
  // Order does not matter for what comes out, and nothing in the repo moved.
  expect(await trialMerge(cfg, dir, [b, a])).toEqual(result);
  expect((await jj(["st"], dir)).includes("Working copy changes")).toBe(false);
});

test("trialMerge of two edits of one line conflicts, naming the path", async () => {
  const { dir, cfg, on } = await repoWithBase();
  const a = await on("mine", { "f.txt": edited(3, "THREE") });
  const b = await on("yours", { "f.txt": edited(3, "tres"), "g.txt": "g2\n" });
  expect(await trialMerge(cfg, dir, [a, b])).toEqual({ tree: null, conflicts: ["f.txt"] });
});

test("trialMerge folds three commits left to right, and a conflict anywhere in the fold conflicts", async () => {
  const { dir, cfg, on, show } = await repoWithBase();
  const a = await on("a", { "f.txt": edited(1, "ONE") });
  const b = await on("b", { "f.txt": edited(4, "FOUR") });
  const c = await on("c", { "f.txt": edited(7, "SEVEN"), "h.txt": "h\n" });
  const merged = await trialMerge(cfg, dir, [a, b, c]);
  expect(merged.conflicts).toEqual([]);
  expect(await show(merged.tree!, "f.txt")).toBe(["ONE\n", "two\n", "three\n", "FOUR\n", "five\n", "six\n", "SEVEN\n"].join(""));
  expect(await show(merged.tree!, "h.txt")).toBe("h\n");

  // The third conflicts with the first, not with the second.
  const d = await on("d", { "f.txt": edited(1, "uno"), "g.txt": "g2\n" });
  expect(await trialMerge(cfg, dir, [a, b, d])).toEqual({ tree: null, conflicts: ["f.txt"] });
  // Each conflicting path once, and only the conflicting ones.
  const e = await on("e", { "f.txt": edited(1, "eins"), "g.txt": "g3\n" });
  const f = await on("f", { "f.txt": edited(1, "un"), "g.txt": "g4\n", "h.txt": "other\n" });
  const result = await trialMerge(cfg, dir, [e, f]);
  expect(result.tree).toBeNull();
  expect([...result.conflicts].sort()).toEqual(["f.txt", "g.txt"]);
});

test("trialMerge of one commit is its tree, of none is an error", async () => {
  const { dir, cfg, on } = await repoWithBase();
  const a = await on("a", { "f.txt": edited(2, "TWO") });
  expect(await trialMerge(cfg, dir, [a])).toEqual({ tree: await treeOf(cfg, dir, a), conflicts: [] });
  await expect(trialMerge(cfg, dir, [])).rejects.toThrow("no commits");
});

test("trialMerge of commits git cannot merge is an error, not a conflict", async () => {
  const { dir, cfg, on } = await repoWithBase();
  const a = await on("a", { "f.txt": edited(2, "TWO") });
  await expect(trialMerge(cfg, dir, [a, "0".repeat(40)])).rejects.toThrow();
});

test("a path with odd characters is named as it is", async () => {
  const { dir, cfg, on } = await repoWithBase();
  const a = await on("a", { "odd nameé.txt": "a\n" });
  const b = await on("b", { "odd nameé.txt": "b\n" });
  expect(await trialMerge(cfg, dir, [a, b])).toEqual({ tree: null, conflicts: ["odd nameé.txt"] });
});
