// test/train-batch.test.ts
import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { loadConfig } from "../src/config";
import { bookmarkSet, commitOf, initColocated, jj, workspaceAdd } from "../src/jj";
import type { LineRow } from "../src/pool/rows";
import { gitGraph } from "../src/projects/applier";
import { scopeWorkspace } from "../src/tasks/provision";
import { classify, mergeParents, pickBatch, sizeOf, type Candidate } from "../src/train/batch";

const LINES = ["one", "two", "three", "four", "five", "six", "seven"].map((l) => `${l}\n`);

/** `LINES` with line `n` (1-based) replaced by `text`. */
const edited = (n: number, text: string) => LINES.map((l, i) => (i === n - 1 ? `${text}\n` : l)).join("");

/**
 * A colocated repo whose `main` is one commit `B` holding `f.txt` (`LINES`) and `g.txt`, and helpers to build tasks'
 * work on it: `on` makes a commit, `task` gives a task a line (its bookmark and its row) and a workspace scoped to it.
 */
async function fixture() {
  const repo = await mkdtemp("/tmp/meddle-train-batch-");
  await initColocated(repo);
  const cfg = loadConfig({ HOME: repo, MEDDLE_DATA_DIR: `${repo}/d`, MEDDLE_TASK_ROOT: `${repo}/t` });
  /** A commit of `files` on `parent` (a revset: several parents make a merge), described `message`. */
  const on = async (parent: string, message: string, files: Record<string, string> = {}) => {
    await jj(["new", parent], repo);
    for (const [name, content] of Object.entries(files)) await Bun.write(`${repo}/${name}`, content);
    await jj(["commit", "-m", message], repo);
    return commitOf(repo, "@-");
  };
  const B = await on("root()", "init", { "f.txt": LINES.join(""), "g.txt": "g\n" });
  await bookmarkSet(repo, "main", B);
  const row = (task: string, commit: string, base: string[] = [B], archived = false): LineRow => ({
    project: "p", task, name: "p", holder: "h", epoch: 0, seq: 1, commit, base, archived, queuedAt: null,
  });
  /** Task `id`'s line at `tip` as a bookmark, and a workspace of it starting at the first of `base`, scoped as a task's is. */
  const task = async (id: string, tip: string, base: string[] = [B]) => {
    await bookmarkSet(repo, `meddle/task/${id}/p`, tip);
    const workspace = `${repo}-ws-${id}`;
    await workspaceAdd(repo, `ws-${id}`, workspace, base);
    await scopeWorkspace(cfg, workspace, id, base);
    return { row: row(id, tip, base), workspace };
  };
  const candidate = (taskId: string, tip: string, over: Partial<Candidate> = {}): Candidate =>
    ({ taskId, title: taskId, tip, base: [B], workspace: null, size: 1, ...over });
  return { repo, cfg, B, on, row, task, candidate };
}

test("classify finds leftovers, undescribed and conflicted commits", async () => {
  const { repo, cfg, B, on, task, candidate } = await fixture();
  const left = await on(B, "left", { "f.txt": edited(3, "L") });
  const empty = await on(left, "");
  const loose = await on(empty, "", { "g.txt": "loose\n" });
  const right = await on(B, "right", { "f.txt": edited(3, "R") });
  // jj calls a merge it left conflicted "empty": it is no leftover, and it needs fixing.
  const merge = await on(`${loose} | ${right}`, "");
  const { row, workspace } = await task("t1", merge);

  const expected = { leftovers: [empty], toFix: [loose, merge], conflicted: [merge], foreign: [], unfixable: [] };
  const c = candidate("t1", merge, { workspace });
  expect(await classify(cfg, repo, B, c, new Set(["t1"]), [row])).toEqual(expected);
  // A task on another node has no workspace here: what it may change is read from its scoped `immutable_heads()`.
  expect(await classify(cfg, repo, B, { ...c, workspace: null }, new Set(["t1"]), [row])).toEqual(expected);
});

test("classify passes a pushable task, and a whitespace-only description counts as none", async () => {
  const { repo, cfg, B, on, task, candidate } = await fixture();
  const one = await on(B, "one change", { "g.txt": "one\n" });
  const two = await on(one, "two changes", { "g.txt": "two\n" });
  const { row, workspace } = await task("t1", two);
  const c = candidate("t1", two, { workspace });
  const clean = { leftovers: [], toFix: [], conflicted: [], foreign: [], unfixable: [] };
  expect(await classify(cfg, repo, B, c, new Set(["t1"]), [row])).toEqual(clean);

  const blank = await on(two, " \n\n", { "g.txt": "three\n" });
  const moved = await task("t2", blank);
  const result = await classify(cfg, repo, B, candidate("t2", blank, { workspace: moved.workspace }), new Set(["t2"]), [moved.row]);
  expect(result).toEqual({ ...clean, toFix: [blank] });
});

test("classify lets the starting revision land", async () => {
  const { repo, cfg, B, on, task, candidate } = await fixture();
  // The user's own revisions, from a feature branch: below the task's base, not on main.
  const feature1 = await on(B, "feature, first", { "g.txt": "f1\n" });
  const feature2 = await on(feature1, "feature, second", { "h.txt": "f2\n" });
  const work = await on(feature2, "the task's work", { "i.txt": "i\n" });
  const { row, workspace } = await task("t1", work, [feature2]);
  const c = candidate("t1", work, { base: [feature2], workspace });
  const clean = { leftovers: [], toFix: [], conflicted: [], foreign: [], unfixable: [] };
  expect(await classify(cfg, repo, B, c, new Set(["t1"]), [row])).toEqual(clean);
  expect(await classify(cfg, repo, B, { ...c, workspace: null }, new Set(["t1"]), [row])).toEqual(clean);

  // They still have to be pushable, and the task can't change them (they are its base).
  const draft = await on(B, "", { "g.txt": "draft\n" });
  const built = await on(draft, "built on a draft", { "i.txt": "i\n" });
  const drafted = await task("t2", built, [draft]);
  const result = await classify(cfg, repo, B, candidate("t2", built, { base: [draft], workspace: drafted.workspace }), new Set(["t2"]), [drafted.row]);
  expect(result.toFix).toEqual([]);
  expect(result.unfixable).toEqual([{ commit: draft, reason: expect.stringContaining("no description") }]);
});

test("classify flags another task's work as foreign", async () => {
  const { repo, cfg, B, on, task, candidate } = await fixture();
  const mine = await on(B, "mine", { "g.txt": "mine\n" });
  const theirs = await on(B, "theirs", { "h.txt": "theirs\n" });
  // The agent of t1 merged t2's line into its own.
  const merged = await on(`${mine} | ${theirs}`, "merge theirs");
  const t1 = await task("t1", merged);
  const t2 = await task("t2", theirs);
  const lines = [t1.row, t2.row];
  const c = candidate("t1", merged, { workspace: t1.workspace });

  expect((await classify(cfg, repo, B, c, new Set(["t1", "t2"]), lines)).foreign).toEqual([{ taskId: "t2", queued: true }]);
  expect((await classify(cfg, repo, B, c, new Set(["t1"]), lines)).foreign).toEqual([{ taskId: "t2", queued: false }]);
  expect((await classify(cfg, repo, B, { ...c, workspace: null }, new Set(["t1"]), lines)).foreign).toEqual([{ taskId: "t2", queued: false }]);
  // t2 is the contained side: t1's line has all of t2's work in it, and it is still t2's own, so it holds nothing foreign.
  const contained = candidate("t2", theirs, { workspace: t2.workspace });
  const clean = { leftovers: [], toFix: [], conflicted: [], foreign: [], unfixable: [] };
  expect(await classify(cfg, repo, B, contained, new Set(["t2"]), lines)).toEqual(clean);
  expect(await classify(cfg, repo, B, contained, new Set(["t1", "t2"]), lines)).toEqual(clean);
  expect(await classify(cfg, repo, B, { ...contained, workspace: null }, new Set(["t2"]), lines)).toEqual(clean);
  // A task released or archived is no one's work to wait for.
  expect((await classify(cfg, repo, B, c, new Set(["t1"]), [t1.row, { ...t2.row, archived: true }])).foreign).toEqual([]);
  // Nor is a line whose commit this repo lacks (not fetched yet): it names no commits.
  expect((await classify(cfg, repo, B, c, new Set(["t1"]), [t1.row, { ...t2.row, commit: "f".repeat(40) }])).foreign).toEqual([]);

  // A task started on t2's line: t2's commits are below its base, and still not its own.
  const next = await on(theirs, "next", { "i.txt": "next\n" });
  const t3 = await task("t3", next, [theirs]);
  const started = candidate("t3", next, { base: [theirs], workspace: t3.workspace });
  expect((await classify(cfg, repo, B, started, new Set(["t3"]), [t2.row, t3.row])).foreign).toEqual([{ taskId: "t2", queued: false }]);

  // Another task's commits are its to describe, not this task's: they are never in this one's lists.
  const draft = await on(B, "", { "h.txt": "draft\n" });
  const uses = await on(`${mine} | ${draft}`, "merge a draft");
  const t4 = await task("t4", uses);
  const t5 = await task("t5", draft);
  const result = await classify(cfg, repo, B, candidate("t4", uses, { workspace: t4.workspace }), new Set(["t4"]), [t4.row, t5.row]);
  expect(result).toEqual({ leftovers: [], toFix: [], conflicted: [], foreign: [{ taskId: "t5", queued: false }], unfixable: [] });
});

test("classify keeps a contained task's own commits its own", async () => {
  const { repo, cfg, B, on, task, candidate } = await fixture();
  const mine = await on(B, "mine", { "g.txt": "mine\n" });
  // L's `draft` is undescribed, and U merged L's line.
  const draft = await on(B, "", { "h.txt": "draft\n" });
  const merged = await on(`${mine} | ${draft}`, "merge a draft");
  const U = await task("tu", merged);
  const L = await task("tl", draft);
  const lines = [U.row, L.row];
  const contained = candidate("tl", draft, { workspace: L.workspace });
  const containing = candidate("tu", merged, { workspace: U.workspace });

  // L owns `draft`, but U's line has built on it, so it is frozen in L's workspace: the task can't fix it, and it is
  // never nobody's. L has nothing of U's, whether or not U is queued.
  const unfixable = [{ commit: draft, reason: expect.stringContaining("no description") }];
  for (const queued of [new Set(["tl"]), new Set(["tu", "tl"])]) {
    const expected = { leftovers: [], toFix: [], conflicted: [], foreign: [], unfixable };
    expect(await classify(cfg, repo, B, contained, queued, lines)).toEqual(expected);
    expect(await classify(cfg, repo, B, { ...contained, workspace: null }, queued, lines)).toEqual(expected);
  }
  // U reports L as foreign (queued or not), and leaves `draft` to L.
  const stacked = (queued: boolean) => ({ leftovers: [], toFix: [], conflicted: [], foreign: [{ taskId: "tl", queued }], unfixable: [] });
  expect(await classify(cfg, repo, B, containing, new Set(["tu", "tl"]), lines)).toEqual(stacked(true));
  expect(await classify(cfg, repo, B, containing, new Set(["tu"]), lines)).toEqual(stacked(false));
  expect(await classify(cfg, repo, B, { ...containing, workspace: null }, new Set(["tu"]), lines)).toEqual(stacked(false));
});

test("classify keeps what a contained task made after it was merged", async () => {
  const { repo, cfg, B, on, task, candidate } = await fixture();
  const first = await on(B, "first", { "g.txt": "first\n" });
  const mine = await on(B, "mine", { "h.txt": "mine\n" });
  const merged = await on(`${mine} | ${first}`, "merge first");
  // L moved on after U merged its line, with a commit of its own that no description has yet.
  const newer = await on(first, "", { "i.txt": "newer\n" });
  const U = await task("tu", merged);
  const L = await task("tl", newer);
  const result = await classify(cfg, repo, B, candidate("tl", newer, { workspace: L.workspace }), new Set(["tl"]), [U.row, L.row]);
  // `first` is in both lines, and which task made it can't be told from the graph: U is held to account for it. `newer`
  // is in U's line not at all, and L's to fix.
  expect(result).toEqual({ leftovers: [], toFix: [newer], conflicted: [], foreign: [{ taskId: "tu", queued: false }], unfixable: [] });
});

test("classify reports frozen undescribed commits as unfixable", async () => {
  const { repo, cfg, B, on, task, candidate } = await fixture();
  const frozen = await on(B, "", { "g.txt": "frozen\n" });
  const top = await on(frozen, "top", { "h.txt": "top\n" });
  const loose = await on(top, "", { "i.txt": "loose\n" });
  const t1 = await task("t1", loose);
  // t2 started on t1's line at `top`, freezing everything up to it in t1's workspace.
  const above = await on(top, "above", { "j.txt": "j\n" });
  const t2 = await task("t2", above, [top]);

  const expected = {
    leftovers: [], toFix: [loose], conflicted: [], foreign: [],
    unfixable: [{ commit: frozen, reason: expect.stringContaining("no description") }],
  };
  const c = candidate("t1", loose, { workspace: t1.workspace });
  expect(await classify(cfg, repo, B, c, new Set(["t1", "t2"]), [t1.row, t2.row])).toEqual(expected);
  expect(await classify(cfg, repo, B, { ...c, workspace: null }, new Set(["t1", "t2"]), [t1.row, t2.row])).toEqual(expected);
});

test("classify reports a frozen conflicted commit as unfixable too", async () => {
  const { repo, cfg, B, on, task, candidate } = await fixture();
  const left = await on(B, "left", { "f.txt": edited(3, "L") });
  const right = await on(B, "right", { "f.txt": edited(3, "R") });
  const merge = await on(`${left} | ${right}`, "both");
  const top = await on(merge, "top", { "g.txt": "top\n" });
  const t1 = await task("t1", top);
  // Another task builds on the conflicted merge.
  const above = await on(merge, "above", { "h.txt": "h\n" });
  const t2 = await task("t2", above, [merge]);

  const result = await classify(cfg, repo, B, candidate("t1", top, { workspace: t1.workspace }), new Set(["t1"]), [t1.row, t2.row]);
  expect(result.unfixable).toEqual([{ commit: merge, reason: expect.stringContaining("conflicts") }]);
  // Its child carries the conflict on (nothing resolved it), and that one is the task's.
  expect(result.toFix).toEqual([top]);
  expect(result.conflicted).toEqual([top]);
});

test("pickBatch takes biggest first", async () => {
  const { repo, cfg, B, on, candidate } = await fixture();
  const small = candidate("small", await on(B, "small", { "g.txt": "s\n" }), { size: 2 });
  const big = candidate("big", await on(B, "big", { "f.txt": edited(1, "ONE") }), { size: 40 });
  const middle = candidate("middle", await on(B, "middle", { "h.txt": "m\n" }), { size: 10 });
  const tied = candidate("tied", await on(B, "tied", { "i.txt": "t\n" }), { size: 10 });
  const { batch, rebase, later } = await pickBatch(cfg, repo, B, [small, middle, big, tied]);
  // Equal sizes keep their queue order.
  expect(batch.map((c) => c.taskId)).toEqual(["big", "middle", "tied", "small"]);
  expect(rebase).toEqual([]);
  expect(later).toEqual([]);
  expect(await pickBatch(cfg, repo, B, [])).toEqual({ batch: [], rebase: [], later: [] });
});

test("pickBatch marks a conflict with B for rebase", async () => {
  const { repo, cfg, B, on, candidate } = await fixture();
  // The task started from the old main, which has moved on since.
  const stale = await on(B, "stale", { "f.txt": edited(3, "mine") });
  const moved = await on(B, "main moved", { "f.txt": edited(3, "main's") });
  const fine = await on(B, "fine", { "g.txt": "fine\n" });
  const result = await pickBatch(cfg, repo, moved, [candidate("stale", stale, { size: 9 }), candidate("fine", fine, { size: 1 })]);
  expect(result.rebase.map((c) => c.taskId)).toEqual(["stale"]);
  expect(result.batch.map((c) => c.taskId)).toEqual(["fine"]);
  expect(result.later).toEqual([]);
});

test("pickBatch defers a conflict with the batch", async () => {
  const { repo, cfg, B, on, candidate } = await fixture();
  const first = await on(B, "first", { "f.txt": edited(3, "first") });
  const second = await on(B, "second", { "f.txt": edited(3, "second") });
  const apart = await on(B, "apart", { "g.txt": "apart\n" });
  const result = await pickBatch(cfg, repo, B, [
    candidate("second", second, { size: 5 }), candidate("apart", apart, { size: 1 }), candidate("first", first, { size: 8 }),
  ]);
  // Each merges with B alone; `second` is the one that doesn't merge with what the bigger `first` brought.
  expect(result.batch.map((c) => c.taskId)).toEqual(["first", "apart"]);
  expect(result.later.map((c) => c.taskId)).toEqual(["second"]);
  expect(result.rebase).toEqual([]);
});

test("pickBatch lets a stacked task join the one it contains", async () => {
  const { repo, cfg, B, on, candidate } = await fixture();
  const lower = await on(B, "lower", { "f.txt": edited(2, "TWO") });
  const upper = await on(lower, "upper", { "g.txt": "upper\n" });
  const result = await pickBatch(cfg, repo, B, [candidate("lower", lower, { size: 2 }), candidate("upper", upper, { size: 4 })]);
  expect(result.batch.map((c) => c.taskId)).toEqual(["upper", "lower"]);
});

test("mergeParents drops B and contained tips", async () => {
  const { repo, cfg, B, on } = await fixture();
  const g = gitGraph(cfg, repo);
  const a = await on(B, "a", { "g.txt": "a\n" });
  const d = await on(B, "d", { "h.txt": "d\n" });
  // C is stacked on A: it merged A's line, so A's tip is part of it.
  const c = await on(a, "c", { "i.txt": "c\n" });

  // B is below every tip: dropped; the tips come in the order they were given.
  expect(await mergeParents(g, B, [a, d])).toEqual([a, d]);
  expect(await mergeParents(g, B, [d, a])).toEqual([d, a]);
  // A is contained in C: dropped, and C stays where A was not.
  expect(await mergeParents(g, B, [a, d, c])).toEqual([d, c]);
  expect(await mergeParents(g, B, [c, a])).toEqual([c]);
  // One task on top of B: a single head.
  expect(await mergeParents(g, B, [a])).toEqual([a]);
  // No duplicates, whatever is given twice.
  expect(await mergeParents(g, B, [a, a, d, d])).toEqual([a, d]);
  expect(await mergeParents(g, B, [B, B])).toEqual([B]);
  expect(await mergeParents(g, B, [])).toEqual([B]);
});

test("mergeParents keeps a moved-on parent", async () => {
  const { repo, cfg, B, on } = await fixture();
  const g = gitGraph(cfg, repo);
  const a1 = await on(B, "a1", { "g.txt": "a1\n" });
  // C merged A's line at a1, and A has moved on since: its newer commit is in no other tip.
  const c = await on(a1, "c", { "i.txt": "c\n" });
  const a2 = await on(a1, "a2", { "h.txt": "a2\n" });
  expect(await mergeParents(g, B, [a2, c])).toEqual([a2, c]);
  expect(await mergeParents(g, B, [c, a2])).toEqual([c, a2]);

  // B stays when a tip doesn't descend from it (main moved on): after the tips.
  const main = await on(B, "main moved", { "f.txt": edited(1, "ONE") });
  expect(await mergeParents(g, main, [a2, c])).toEqual([a2, c, main]);
  expect(await mergeParents(g, main, [main])).toEqual([main]);
  // And it goes once a tip has it below.
  const caught = await on(`${a2} | ${main}`, "caught up");
  expect(await mergeParents(g, main, [c, caught])).toEqual([c, caught]);
});

test("sizeOf counts the lines changed between B and a tip", async () => {
  const { repo, cfg, B, on } = await fixture();
  // One line replaced (an insertion and a deletion), and a new file of three lines.
  const tip = await on(B, "tip", { "f.txt": edited(1, "ONE"), "h.txt": "x\ny\nz\n" });
  expect(await sizeOf(cfg, repo, B, tip)).toBe(5);
  // A deletion alone, and no change at all.
  const shorter = await on(tip, "shorter", { "h.txt": "x\n" });
  expect(await sizeOf(cfg, repo, tip, shorter)).toBe(2);
  expect(await sizeOf(cfg, repo, tip, tip)).toBe(0);
  expect(await sizeOf(cfg, repo, B, B)).toBe(0);
});
