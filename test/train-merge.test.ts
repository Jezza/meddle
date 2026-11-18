// test/train-merge.test.ts
import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { loadConfig } from "../src/config";
import { bookmarkSet, commitOf, commitsIn, initColocated, jj } from "../src/jj";
import { checkBatch, type MergeDeps } from "../src/train/merge";
import type { Candidate } from "../src/train/batch";
import { mergePrompt, mergeTitle } from "../src/train/prompts";
import type { TrainTurnKind, TrainTurnOutcome } from "../src/train/tools";

const DESCRIBE = "Add a description (4-7 words) to your revision(s).";
const LINES = ["one", "two", "three", "four", "five", "six", "seven"].map((l) => `${l}\n`);

/** `LINES` with line `n` (1-based) replaced by `text`. */
const edited = (n: number, text: string) => LINES.map((l, i) => (i === n - 1 ? `${text}\n` : l)).join("");

type Turn = { taskId: string; kind: TrainTurnKind; text: string };

/**
 * A colocated repo whose `main` is one commit `B`, two tasks' tips on it (`t1` edits line 1 of f.txt, `t2` line 7: they
 * merge cleanly), and fake `MergeDeps` that run the merge task in that repo: `createMergeTask` is `jj new` of the parents
 * (the merge is the repo's `@`), `head` reads `@`, and `turn` runs `act` on the repo, answering `outcome`.
 */
async function fixture() {
  const repo = await mkdtemp("/tmp/meddle-train-merge-");
  await initColocated(repo);
  const cfg = loadConfig({ HOME: repo, MEDDLE_DATA_DIR: `${repo}/d`, MEDDLE_TASK_ROOT: `${repo}/t` });
  const on = async (parent: string, message: string, files: Record<string, string>) => {
    await jj(["new", parent], repo);
    for (const [name, content] of Object.entries(files)) await Bun.write(`${repo}/${name}`, content);
    await jj(["commit", "-m", message], repo);
    return commitOf(repo, "@-");
  };
  const B = await on("root()", "init", { "f.txt": LINES.join(""), "g.txt": "g\n" });
  await bookmarkSet(repo, "main", B);
  const tip1 = await on(B, "first task", { "f.txt": edited(1, "ONE") });
  const tip2 = await on(B, "second task", { "f.txt": edited(7, "SEVEN") });
  const batch: Candidate[] = [
    { taskId: "t1", title: "Fix one", tip: tip1, base: [B], workspace: null, size: 2 },
    { taskId: "t2", title: "Fix seven", tip: tip2, base: [B], workspace: null, size: 1 },
  ];

  const turns: Turn[] = [];
  const created: Array<{ projectId: string; parents: string[]; title: string; batch: string[] }> = [];
  const discarded: string[] = [];
  const head = async () => (await commitsIn(repo, "@", cfg))[0]!;
  const describe = (message: string) => jj(["describe", "-m", message], repo);
  /** What the merge agent does in its turn `n` (1-based) in the repo, and how that turn ends. */
  let behaviour: (n: number) => Promise<TrainTurnOutcome | void> = async () => {};
  const deps: MergeDeps = {
    async createMergeTask(input) {
      created.push(input);
      await jj(["new", ...input.parents], repo);
      return { taskId: `m${created.length}`, nodeId: "home" };
    },
    async turn(taskId, kind, text) {
      turns.push({ taskId, kind, text });
      const outcome = await behaviour(turns.length);
      // Snapshot what the turn did to the files.
      await jj(["status"], repo);
      return outcome ?? { kind: "done" };
    },
    head,
    async discard(taskId) {
      discarded.push(taskId);
    },
  };
  const run = (over: Partial<{ B: string; batch: Candidate[] }> = {}) =>
    checkBatch(deps, cfg, repo, { projectId: "p", B, batch, prompt: DESCRIBE, ...over });
  return {
    repo, cfg, B, tip1, tip2, batch, turns, created, discarded, head, describe, run, deps,
    act: (f: typeof behaviour) => { behaviour = f; },
  };
}

test("a described clean merge is ready", async () => {
  const { tip1, tip2, turns, created, discarded, head, describe, run, act } = await fixture();
  act(async () => { await describe("Merge two fixes"); });

  const verdict = await run();
  const merge = await head();
  expect(verdict).toEqual({ kind: "ready", mergeTask: "m1", L: merge.commitId });
  expect(merge.parents).toEqual([tip1, tip2]);
  // B is below both tips, so it is no parent; the merge task is made once, with the tips and the batch's titles.
  expect(created).toEqual([{ projectId: "p", parents: [tip1, tip2], title: mergeTitle(["Fix one", "Fix seven"]), batch: ["t1", "t2"] }]);
  // One turn, with the spec's prompt: the tasks as the agent can name them, and the change the merge is.
  expect(turns).toEqual([{
    taskId: "m1", kind: "merge",
    text: mergePrompt(["Fix one (t1)", "Fix seven (t2)"], merge.changeId, DESCRIBE),
  }]);
  expect(discarded).toEqual([]);
});

test("a changed file is caught", async () => {
  const { repo, turns, discarded, run, act } = await fixture();
  act(async (n) => {
    await Bun.write(`${repo}/g.txt`, `tweak ${n}\n`);
    await jj(["describe", "-m", "Merge two fixes"], repo);
  });

  const verdict = await run();
  expect(verdict).toEqual({ kind: "stuck", reason: expect.stringContaining("g.txt"), mergeTask: "m1" });
  // The first turn and three follow-ups, the second to fourth naming the file.
  expect(turns.map((t) => t.kind)).toEqual(["merge", "merge", "merge", "merge"]);
  for (const t of turns.slice(1)) expect(t.text).toContain("g.txt");
  // A stuck merge task stays, for the user to open and Retry to carry on with: the verdict names it.
  expect(discarded).toEqual([]);
});

test("blame discards the merge task", async () => {
  const { turns, discarded, run, act } = await fixture();
  act(async () => ({ kind: "blamed", task: "t2", reason: "typecheck fails in f.txt" }));

  expect(await run()).toEqual({ kind: "blamed", task: "t2", reason: "typecheck fails in f.txt" });
  expect(turns).toHaveLength(1);
  expect(discarded).toEqual(["m1"]);
});

test("blame may name a task by its title, its id or as the prompt does", async () => {
  for (const named of ["Fix seven", "t2", "Fix seven (t2)", "  fix SEVEN "]) {
    const { discarded, run, act } = await fixture();
    act(async () => ({ kind: "blamed", task: named, reason: "it fails" }));
    expect(await run()).toEqual({ kind: "blamed", task: "t2", reason: "it fails" });
    expect(discarded).toEqual(["m1"]);
  }
});

test("blaming no task of the batch gets a follow-up", async () => {
  const { turns, discarded, run, act } = await fixture();
  act(async (n) => {
    if (n === 1) return { kind: "blamed", task: "someone else", reason: "it fails" };
    if (n === 2) return { kind: "blamed", task: "Fix one", reason: "it fails after all" };
  });

  expect(await run()).toEqual({ kind: "blamed", task: "t1", reason: "it fails after all" });
  expect(turns).toHaveLength(2);
  expect(turns[1]!.text).toContain("someone else");
  expect(turns[1]!.text).toContain("Fix one (t1)");
  expect(discarded).toEqual(["m1"]);
});

test("a missing description gets a follow-up", async () => {
  const { turns, discarded, head, describe, run, act } = await fixture();
  act(async (n) => { if (n === 2) await describe("Merge two fixes"); });

  const verdict = await run();
  expect(verdict).toEqual({ kind: "ready", mergeTask: "m1", L: (await head()).commitId });
  expect(turns).toHaveLength(2);
  expect(turns[1]!.kind).toBe("merge");
  // It says what is wrong, and gives the describe prompt.
  expect(turns[1]!.text).toContain("no description");
  expect(turns[1]!.text).toContain(DESCRIBE);
  expect(discarded).toEqual([]);
});

test("a description of only whitespace is none", async () => {
  const { turns, describe, run, act } = await fixture();
  act(async (n) => { await describe(n === 1 ? " \n" : "Merge two fixes"); });

  expect((await run()).kind).toBe("ready");
  expect(turns).toHaveLength(2);
  expect(turns[1]!.text).toContain("no description");
});

test("a head that moved off the merge gets a follow-up naming the change and the parents", async () => {
  const { repo, turns, head, describe, run, act } = await fixture();
  let merge = "";
  act(async (n) => {
    if (n === 1) {
      merge = (await head()).changeId;
      await describe("Merge two fixes");
      // The agent starts a new revision on top: the line's head is no longer the merge.
      await jj(["new"], repo);
    } else if (n === 2) {
      await jj(["edit", merge], repo);
    }
  });

  const verdict = await run();
  expect(verdict).toEqual({ kind: "ready", mergeTask: "m1", L: (await head()).commitId });
  expect(turns).toHaveLength(2);
  expect(turns[1]!.text).toContain(merge);
  expect(turns[1]!.text).toContain("parents");
});

test("a conflicted merge is caught", async () => {
  const { turns, deps, head, describe, run, act } = await fixture();
  act(async () => { await describe("Merge two fixes"); });
  // jj reports the head as conflicted after the first turn only.
  deps.head = async () => ({ ...(await head()), conflict: turns.length === 1 });

  expect((await run()).kind).toBe("ready");
  expect(turns).toHaveLength(2);
  expect(turns[1]!.text).toContain("conflicts");
});

test("a failed turn is stuck with its reason, and a decline too", async () => {
  for (const outcome of [{ kind: "failed", reason: "the agent crashed" }, { kind: "declined", reason: "no thanks" }] as const) {
    const { turns, discarded, run, act } = await fixture();
    act(async () => outcome);
    expect(await run()).toEqual({ kind: "stuck", reason: expect.stringContaining(outcome.reason), mergeTask: "m1" });
    expect(turns).toHaveLength(1);
    expect(discarded).toEqual([]);
  }
});

test("a batch that doesn't merge cleanly is stuck, with no merge task made", async () => {
  const { repo, B, batch, created, run } = await fixture();
  const clash = await commitOfClash(repo, B);
  const clashing: Candidate = { taskId: "t3", title: "Clash", tip: clash, base: [B], workspace: null, size: 1 };

  const verdict = await run({ batch: [...batch, clashing] });
  expect(verdict).toEqual({ kind: "stuck", reason: expect.stringContaining("f.txt"), mergeTask: null });
  expect(created).toEqual([]);
});

test("a batch with one head is no merge", async () => {
  const { batch, created, run } = await fixture();
  expect(await run({ batch: [batch[0]!] })).toEqual({ kind: "stuck", reason: expect.stringContaining("no merge"), mergeTask: null });
  expect(created).toEqual([]);
});

/** A commit on `B` that changes line 1 of f.txt another way than the fixture's first task. */
async function commitOfClash(repo: string, B: string): Promise<string> {
  await jj(["new", B], repo);
  await Bun.write(`${repo}/f.txt`, edited(1, "CLASH"));
  await jj(["commit", "-m", "clash"], repo);
  return commitOf(repo, "@-");
}
