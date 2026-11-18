// test/train-round.test.ts
import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { loadConfig } from "../src/config";
import { abandon, bookmarkSet, commitOf, commitsIn, initColocated, jj } from "../src/jj";
import type { LineRow } from "../src/pool/rows";
import type { Candidate } from "../src/train/batch";
import { describePrompt, mergeTitle, rebasePrompt } from "../src/train/prompts";
import { NodeOffline, runRound, type RoundDeps, type RoundStep } from "../src/train/round";
import type { TrainTurnKind, TrainTurnOutcome } from "../src/train/tools";

const DESCRIBE = "Add a description (4-7 words) to your revision(s).";
const LINES = ["one", "two", "three", "four", "five", "six", "seven"].map((l) => `${l}\n`);

/** `LINES` with line `n` (1-based) replaced by `text`. */
const edited = (n: number, text: string) => LINES.map((l, i) => (i === n - 1 ? `${text}\n` : l)).join("");

/** A task as the fake queue keeps it: its title and size, its base, and whether it is queued, archived or sitting out. */
type Task = { id: string; title: string; size: number; base: string[]; queued: boolean; archived: boolean; sitting: boolean };

/** What a train turn does in the repo, and how it ends (`done` when it says nothing). */
type Behaviour = (turn: { taskId: string; kind: TrainTurnKind; text: string }) => Promise<TrainTurnOutcome | void>;

/**
 * A colocated repo whose `main` is one commit `B` holding `f.txt` (`LINES`) and `g.txt`, a fake queue of tasks whose
 * lines are bookmarks (`meddle/task/<id>/p`) in it, and fake `RoundDeps` over both: candidates are the queued tasks that
 * are neither archived nor sitting out, `advance` moves `main` (refusing unless it is at `old`), the merge task is the
 * repo's `@` (`jj new` of its parents), and a train turn runs the task's behaviour (`act`; the merge task's is under
 * "merge", and by default describes the merge).
 */
async function fixture() {
  const repo = await mkdtemp("/tmp/meddle-train-round-");
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

  const tasks = new Map<string, Task>();
  const line = (id: string) => `meddle/task/${id}/p`;
  const tipOf = (id: string) => commitOf(repo, line(id));
  /** Task `id`, titled `Task <id>` unless said otherwise, whose line is at `tip`; queued unless said otherwise. */
  const task = async (id: string, tip: string, over: Partial<Task> = {}) => {
    await bookmarkSet(repo, line(id), tip);
    tasks.set(id, { id, title: `Task ${id}`, size: 1, base: [B], queued: true, archived: false, sitting: false, ...over });
  };

  /** Every call that changes something, in order, as `<call> <task>`. */
  const log: string[] = [];
  const turns: Array<{ taskId: string; kind: TrainTurnKind; text: string }> = [];
  const created: Array<{ projectId: string; parents: string[]; title: string; batch: string[] }> = [];
  const discarded: string[] = [];
  const advances: Array<[string, string]> = [];
  const abandoned: Array<[string, string[]]> = [];
  const left: Array<[string, string]> = [];
  const satOut: Array<[string, string]> = [];
  const heldBack: Array<[string, string]> = [];
  const steps: RoundStep[] = [];
  /** The tasks whose node is offline, and its name: a call for them rejects. */
  const offline = new Map<string, string>();
  const behaviours = new Map<string, Behaviour>();
  behaviours.set("merge", async () => { await jj(["describe", "-m", "Merge the batch"], repo); });

  const deps: RoundDeps = {
    projectId: "p",
    branch: () => commitOf(repo, "main"),
    async candidates() {
      const out: Candidate[] = [];
      for (const t of tasks.values()) {
        if (!t.queued || t.archived || t.sitting) continue;
        out.push({ taskId: t.id, title: t.title, tip: await tipOf(t.id), base: t.base, workspace: null, size: t.size });
      }
      return out;
    },
    async lines() {
      const rows: LineRow[] = [];
      for (const t of tasks.values()) {
        rows.push({
          project: "p", task: t.id, name: "p", holder: "h", epoch: 0, seq: 1, commit: await tipOf(t.id), base: t.base,
          archived: t.archived, queuedAt: t.queued ? "2026-11-18T10:00:00.000Z" : null,
        });
      }
      return rows;
    },
    async title(taskId) {
      return tasks.get(taskId)?.title ?? taskId;
    },
    async createMergeTask(input) {
      created.push(input);
      log.push(`create m${created.length}`);
      await jj(["new", ...input.parents], repo);
      return { taskId: `m${created.length}`, nodeId: "home" };
    },
    async turn(taskId, kind, text) {
      log.push(`turn ${taskId}`);
      turns.push({ taskId, kind, text });
      const node = offline.get(taskId);
      if (node !== undefined) throw new NodeOffline(node);
      const behaviour = behaviours.get(kind === "merge" ? "merge" : taskId);
      const outcome = await behaviour?.({ taskId, kind, text });
      // Snapshot what the turn did to the files.
      await jj(["status"], repo);
      return outcome ?? { kind: "done" };
    },
    head: async () => (await commitsIn(repo, "@", cfg))[0]!,
    async discard(taskId) {
      log.push(`discard ${taskId}`);
      discarded.push(taskId);
    },
    async abandonLeftovers(taskId, commits) {
      log.push(`abandon ${taskId}`);
      const node = offline.get(taskId);
      if (node !== undefined) throw new NodeOffline(node);
      abandoned.push([taskId, commits]);
      await abandon(repo, commits.join(" | "));
    },
    async advance(old, next) {
      log.push("advance");
      const at = await commitOf(repo, "main");
      if (at !== old) throw new Error(`main is not at ${old}`);
      await bookmarkSet(repo, "main", next);
      advances.push([old, next]);
    },
    async leave(taskId, reason) {
      left.push([taskId, reason]);
      tasks.get(taskId)!.queued = false;
    },
    async sitOut(taskId, reason) {
      satOut.push([taskId, reason]);
      tasks.get(taskId)!.sitting = true;
    },
    async holdBack(taskId, notice) {
      heldBack.push([taskId, notice]);
    },
    async checkpoint(step) {
      steps.push(step);
    },
  };
  const run = (resume?: RoundStep) => runRound(deps, cfg, repo, DESCRIBE, resume);
  return {
    repo, cfg, B, on, task, tasks, tipOf, line, deps, run, log, turns, created, discarded, advances, abandoned, left, satOut,
    heldBack, steps, offline, act: (id: string, f: Behaviour) => behaviours.set(id, f),
    /** The merge task's head now (the repo's `@`). */
    head: async () => (await commitsIn(repo, "@", cfg))[0]!,
    /** Describes `commit` as `message`, as an agent would (its line's bookmark follows it). */
    describe: (commit: string, message: string) => jj(["describe", "-r", commit, "-m", message], repo),
  };
}

test("one task on top of main fast-forwards without a merge task", async () => {
  const { B, on, task, run, created, advances, turns, steps } = await fixture();
  const tip = await on(B, "add g", { "g.txt": "more g\n" });
  await task("t1", tip);

  expect(await run()).toEqual({ landed: tip, again: false, paused: null });
  expect(advances).toEqual([[B, tip]]);
  expect(created).toEqual([]);
  expect(turns).toEqual([]);
  expect(steps).toEqual([
    { step: "picking", batch: [], mergeTask: null },
    { step: "landing", batch: ["t1"], mergeTask: null },
  ]);
});

test("two clean tasks land as one checked merge", async () => {
  const { B, on, task, run, created, advances, turns, discarded, steps, head } = await fixture();
  const tip1 = await on(B, "first task", { "f.txt": edited(1, "ONE") });
  const tip2 = await on(B, "second task", { "f.txt": edited(7, "SEVEN") });
  await task("t1", tip1, { size: 2 });
  await task("t2", tip2);

  const result = await run();
  const L = await head();
  expect(result).toEqual({ landed: L.commitId, again: false, paused: null });
  expect(L.parents).toEqual([tip1, tip2]);
  expect(L.description.trim()).toBe("Merge the batch");
  expect(created).toEqual([{ projectId: "p", parents: [tip1, tip2], title: mergeTitle(["Task t1", "Task t2"]), batch: ["t1", "t2"] }]);
  expect(turns.map((t) => [t.taskId, t.kind])).toEqual([["m1", "merge"]]);
  expect(advances).toEqual([[B, L.commitId]]);
  // A merge task that landed is left to acceptance, which archives it.
  expect(discarded).toEqual([]);
  expect(steps).toEqual([
    { step: "picking", batch: [], mergeTask: null },
    { step: "checking", batch: ["t1", "t2"], mergeTask: null },
    { step: "checking", batch: ["t1", "t2"], mergeTask: "m1" },
    { step: "landing", batch: ["t1", "t2"], mergeTask: "m1" },
  ]);
});

/** A repo where `main` moved on (`M`, line 3 of f.txt) since `t2` started (`stale`, line 3 too), and `t1` is on `M`. */
async function movedOn() {
  const f = await fixture();
  const stale = await f.on(f.B, "mine", { "f.txt": edited(3, "mine") });
  const M = await f.on(f.B, "main moved", { "f.txt": edited(3, "main's") });
  await bookmarkSet(f.repo, "main", M);
  const fresh = await f.on(M, "add g", { "g.txt": "more g\n" });
  await f.task("t1", fresh, { base: [M] });
  await f.task("t2", stale, { size: 5 });
  return { ...f, stale, M, fresh };
}

test("a conflicting task gets a rebase turn after the batch lands", async () => {
  const { repo, on, line, run, log, turns, advances, satOut, steps, M, fresh, act } = await movedOn();
  let rebased = "";
  act("t2", async () => {
    // The agent rebases onto main and resolves the conflict its own way.
    rebased = await on(fresh, "mine, rebased", { "f.txt": edited(3, "mine, on main's") });
    await bookmarkSet(repo, line("t2"), rebased);
  });

  // The rebased task can go in the next round: another one starts.
  expect(await run()).toEqual({ landed: fresh, again: true, paused: null });
  expect(advances).toEqual([[M, fresh]]);
  expect(turns).toEqual([{ taskId: "t2", kind: "rebase", text: rebasePrompt(fresh) }]);
  expect(log).toEqual(["advance", "turn t2"]);
  expect(satOut).toEqual([]);
  expect(steps.at(-1)).toEqual({ step: "rebasing", batch: ["t2"], mergeTask: null });

  expect(await run()).toEqual({ landed: rebased, again: false, paused: null });
  expect(advances).toEqual([[M, fresh], [fresh, rebased]]);
});

test("a rebase turn that leaves the work conflicting sits the task out", async () => {
  const { run, turns, satOut, fresh } = await movedOn();

  expect(await run()).toEqual({ landed: fresh, again: false, paused: null });
  expect(turns.map((t) => [t.taskId, t.kind])).toEqual([["t2", "rebase"]]);
  expect(satOut).toEqual([["t2", expect.stringContaining("still doesn't merge cleanly")]]);
});

test("decline takes a task off", async () => {
  const { B, on, task, tasks, run, turns, left, satOut, advances, act } = await fixture();
  const draft = await on(B, "", { "f.txt": edited(1, "ONE") });
  const clean = await on(B, "add g", { "g.txt": "more g\n" });
  await task("t1", draft);
  await task("t2", clean);
  act("t1", async () => {
    // The holder takes the task off its queue as the decline is recorded.
    tasks.get("t1")!.queued = false;
    return { kind: "declined", reason: "main already does this" };
  });

  expect(await run()).toEqual({ landed: clean, again: false, paused: null });
  expect(turns).toEqual([{ taskId: "t1", kind: "describe", text: describePrompt(DESCRIBE, []) }]);
  expect(left).toEqual([["t1", "main already does this"]]);
  expect(satOut).toEqual([]);
  expect(advances).toEqual([[B, clean]]);
});

test("a failed describe sits the task out", async () => {
  const { B, on, task, run, turns, satOut, left, advances, act } = await fixture();
  const draft = await on(B, "", { "f.txt": edited(1, "ONE") });
  await task("t1", draft);
  act("t1", async () => ({ kind: "failed", reason: "the agent crashed" }));

  expect(await run()).toEqual({ landed: null, again: false, paused: null });
  expect(turns.map((t) => [t.taskId, t.kind])).toEqual([["t1", "describe"]]);
  expect(satOut).toEqual([["t1", expect.stringContaining("the agent crashed")]]);
  expect(left).toEqual([]);
  expect(advances).toEqual([]);
});

test("a describe turn that leaves a revision undescribed sits the task out", async () => {
  const { B, on, task, run, satOut, advances } = await fixture();
  const draft = await on(B, "", { "f.txt": edited(1, "ONE") });
  await task("t1", draft);

  expect(await run()).toEqual({ landed: null, again: false, paused: null });
  expect(satOut).toEqual([["t1", expect.stringContaining("still undescribed or conflicted")]]);
  expect(advances).toEqual([]);
});


test("a described task lands in the round that described it, told which changes conflict", async () => {
  const { repo, B, on, task, line, tipOf, run, turns, steps, advances, describe, act } = await fixture();
  const draft = await on(B, "", { "g.txt": "more g\n" });
  const left = await on(draft, "left", { "f.txt": edited(3, "L") });
  const right = await on(B, "right", { "f.txt": edited(3, "R") });
  const merge = await on(`${left} | ${right}`, "both sides");
  await task("t1", merge);
  const [conflicted] = await commitsIn(repo, merge);
  expect(conflicted!.conflict).toBe(true);
  act("t1", async () => {
    // The agent describes its draft and resolves the merge's conflict.
    await describe(draft, "Add more g");
    await jj(["edit", line("t1")], repo);
    await Bun.write(`${repo}/f.txt`, edited(3, "L and R"));
  });

  const result = await run();
  const tip = await tipOf("t1");
  expect(result).toEqual({ landed: tip, again: false, paused: null });
  expect(turns).toEqual([{ taskId: "t1", kind: "describe", text: describePrompt(DESCRIBE, [conflicted!.changeId]) }]);
  expect(steps[0]).toEqual({ step: "describing", batch: ["t1"], mergeTask: null });
  expect(advances).toEqual([[B, tip]]);
});

test("the train abandons a task's empty leftovers itself", async () => {
  const { B, on, task, tipOf, run, abandoned, turns, advances } = await fixture();
  const first = await on(B, "first", { "g.txt": "first\n" });
  const empty = await on(first, "");
  const second = await on(empty, "second", { "f.txt": edited(2, "TWO") });
  await task("t1", second);

  const result = await run();
  const tip = await tipOf("t1");
  expect(abandoned).toEqual([["t1", [empty]]]);
  expect(turns).toEqual([]);
  expect(tip).not.toBe(second);
  expect(result).toEqual({ landed: tip, again: false, paused: null });
  expect(advances).toEqual([[B, tip]]);
});

test("an offline node sits out and the rest lands", async () => {
  const { B, on, task, run, offline, turns, satOut, advances } = await fixture();
  const draft = await on(B, "", { "f.txt": edited(1, "ONE") });
  const clean = await on(B, "add g", { "g.txt": "more g\n" });
  await task("t1", draft, { size: 9 });
  await task("t2", clean);
  // t1's node went offline after the round read the queue.
  offline.set("t1", "laptop");

  expect(await run()).toEqual({ landed: clean, again: false, paused: null });
  expect(turns.map((t) => t.taskId)).toEqual(["t1"]);
  expect(satOut).toEqual([["t1", "waiting for laptop"]]);
  expect(advances).toEqual([[B, clean]]);
});

test("a foreign unqueued task holds back with the notice", async () => {
  const { B, on, task, run, heldBack, turns, advances, created } = await fixture();
  const mine = await on(B, "mine", { "g.txt": "mine\n" });
  const theirs = await on(B, "theirs", { "h.txt": "theirs\n" });
  // t1's agent merged t2's line, and t2 isn't queued.
  const merged = await on(`${mine} | ${theirs}`, "merge theirs");
  const clean = await on(B, "fix one", { "f.txt": edited(1, "ONE") });
  await task("t1", merged, { title: "Add mine", size: 9 });
  await task("t2", theirs, { title: "Add theirs", queued: false });
  await task("t3", clean);

  expect(await run()).toEqual({ landed: clean, again: false, paused: null });
  expect(heldBack).toEqual([["t1", "Add mine includes work from Add theirs, which isn't queued"]]);
  expect(turns).toEqual([]);
  expect(created).toEqual([]);
  expect(advances).toEqual([[B, clean]]);
});

test("a stacked pair lands once", async () => {
  const { B, on, task, run, created, advances, heldBack, turns } = await fixture();
  const lower = await on(B, "lower", { "f.txt": edited(2, "TWO") });
  // The upper task started on the lower one's line.
  const upper = await on(lower, "upper", { "g.txt": "upper\n" });
  await task("tl", lower, { size: 2 });
  await task("tu", upper, { size: 4, base: [lower] });

  expect(await run()).toEqual({ landed: upper, again: false, paused: null });
  // One move of the branch, to the upper tip, which carries the lower one: no merge task.
  expect(advances).toEqual([[B, upper]]);
  expect(created).toEqual([]);
  expect(turns).toEqual([]);
  expect(heldBack).toEqual([]);
});

test("blame drops the culprit and lands the rest", async () => {
  const { repo, B, on, task, run, created, discarded, advances, turns, log, head, act } = await fixture();
  const tip1 = await on(B, "first", { "f.txt": edited(1, "ONE") });
  const tip2 = await on(B, "second", { "f.txt": edited(4, "FOUR") });
  const tip3 = await on(B, "third", { "g.txt": "third\n" });
  await task("t1", tip1, { size: 3 });
  await task("t2", tip2, { size: 2 });
  await task("t3", tip3);
  act("merge", async ({ taskId }) => {
    if (taskId === "m1") return { kind: "blamed", task: "Task t2", reason: "test four fails" };
    await jj(["describe", "-m", "Merge first and third"], repo);
  });

  const result = await run();
  const L = await head();
  // The culprit's fix turn ends: it can go in the next round.
  expect(result).toEqual({ landed: L.commitId, again: true, paused: null });
  expect(created.map((c) => [c.batch, c.parents])).toEqual([[["t1", "t2", "t3"], [tip1, tip2, tip3]], [["t1", "t3"], [tip1, tip3]]]);
  expect(discarded).toEqual(["m1"]);
  expect(advances).toEqual([[B, L.commitId]]);
  expect(L.parents).toEqual([tip1, tip3]);
  // The fix turn opens with what the merge agent reported, and asks for a rebase onto the main that landed.
  expect(turns.at(-1)).toEqual({ taskId: "t2", kind: "fix", text: rebasePrompt(L.commitId, "test four fails") });
  expect(log).toEqual(["create m1", "turn m1", "discard m1", "create m2", "turn m2", "advance", "turn t2"]);
});

test("a frozen task that needs a rebase leaves", async () => {
  const { repo, B, on, task, run, left, turns, advances } = await fixture();
  const lower = await on(B, "lower", { "f.txt": edited(3, "lower") });
  // Another task (not queued) started on the lower task's line, which freezes it in the lower task's workspace.
  const upper = await on(lower, "upper", { "g.txt": "upper\n" });
  await task("tl", lower);
  await task("tu", upper, { base: [lower], queued: false });
  // main moved on, conflicting with the lower task.
  const M = await on(B, "main moved", { "f.txt": edited(3, "main's") });
  await bookmarkSet(repo, "main", M);

  expect(await run()).toEqual({ landed: null, again: false, paused: null });
  expect(left).toEqual([["tl", "another task builds on this work, so it can't rebase"]]);
  expect(turns).toEqual([]);
  expect(advances).toEqual([]);
});

test("a task archived or unqueued mid-round leaves and the round restarts", async () => {
  for (const gone of ["unqueued", "archived"] as const) {
    const { repo, B, on, task, tasks, run, created, discarded, advances, act } = await fixture();
    const tip1 = await on(B, "first", { "f.txt": edited(1, "ONE") });
    const tip2 = await on(B, "second", { "f.txt": edited(7, "SEVEN") });
    await task("t1", tip1, { size: 2 });
    await task("t2", tip2);
    act("merge", async () => {
      // While the batch is checked, the user unqueues t2, or it is archived.
      if (gone === "unqueued") tasks.get("t2")!.queued = false;
      else tasks.get("t2")!.archived = true;
      await jj(["describe", "-m", "Merge the batch"], repo);
    });

    // Nothing stale lands: the merge task is discarded, and the round starts over.
    expect(await run()).toEqual({ landed: null, again: true, paused: null });
    expect(discarded).toEqual(["m1"]);
    expect(advances).toEqual([]);

    // Without t2: t1 is a single head, landed as it is.
    expect(await run()).toEqual({ landed: tip1, again: false, paused: null });
    expect(advances).toEqual([[B, tip1]]);
    expect(created).toHaveLength(1);
  }
});

test("a branch that moved before landing starts the round over", async () => {
  const { repo, B, on, task, run, discarded, advances, act } = await fixture();
  const tip1 = await on(B, "first", { "f.txt": edited(1, "ONE") });
  const tip2 = await on(B, "second", { "f.txt": edited(7, "SEVEN") });
  await task("t1", tip1, { size: 2 });
  await task("t2", tip2);
  const pushed = await on(B, "pushed", { "g.txt": "pushed\n" });
  act("merge", async () => {
    await jj(["describe", "-m", "Merge the batch"], repo);
    // Someone pushes to main meanwhile.
    await bookmarkSet(repo, "main", pushed);
  });

  expect(await run()).toEqual({ landed: null, again: true, paused: null });
  expect(advances).toEqual([]);
  expect(discarded).toEqual(["m1"]);
});

test("a stuck check pauses, and the round resumed from it checks afresh", async () => {
  const { repo, B, on, task, run, created, discarded, advances, steps, head, act } = await fixture();
  const tip1 = await on(B, "first", { "f.txt": edited(1, "ONE") });
  const tip2 = await on(B, "second", { "f.txt": edited(7, "SEVEN") });
  await task("t1", tip1, { size: 2 });
  await task("t2", tip2);
  act("merge", async () => ({ kind: "failed", reason: "the agent crashed" }));

  expect(await run()).toEqual({ landed: null, again: false, paused: expect.stringContaining("the agent crashed") });
  // The stuck merge task is left for the user to open; the checkpoint names it.
  expect(discarded).toEqual([]);
  const last = steps.at(-1)!;
  expect(last).toEqual({ step: "checking", batch: ["t1", "t2"], mergeTask: "m1" });

  // Retry: the round resumed from that checkpoint discards it and checks with a fresh one.
  act("merge", async () => { await jj(["describe", "-m", "Merge the batch"], repo); });
  const result = await run(last);
  const L = await head();
  expect(result).toEqual({ landed: L.commitId, again: false, paused: null });
  expect(discarded).toEqual(["m1"]);
  expect(created).toHaveLength(2);
  expect(advances).toEqual([[B, L.commitId]]);
});

test("a task whose work can't be trial merged sits out, and the rest lands", async () => {
  const { B, on, task, run, satOut, advances } = await fixture();
  // Work with no history in common with main.
  const unrelated = await on("root()", "unrelated", { "x.txt": "x\n" });
  const clean = await on(B, "add g", { "g.txt": "more g\n" });
  await task("t1", unrelated, { size: 9, base: [] });
  await task("t2", clean);

  expect(await run()).toEqual({ landed: clean, again: false, paused: null });
  expect(satOut).toEqual([["t1", expect.stringContaining("could not be trial merged")]]);
  expect(advances).toEqual([[B, clean]]);
});

test("a task already on main is left out of the round", async () => {
  const { repo, B, on, task, run, created, advances, head } = await fixture();
  const landed = await on(B, "add g", { "g.txt": "more g\n" });
  const tip2 = await on(B, "fix one", { "f.txt": edited(1, "ONE") });
  const tip3 = await on(B, "fix seven", { "f.txt": edited(7, "SEVEN") });
  await task("t1", landed);
  await task("t2", tip2);
  await task("t3", tip3);
  // t1 landed, and its holder hasn't archived it yet: it is still queued.
  await bookmarkSet(repo, "main", landed);

  const result = await run();
  const L = await head();
  expect(result).toEqual({ landed: L.commitId, again: false, paused: null });
  expect(created).toEqual([{ projectId: "p", parents: [tip2, tip3, landed], title: mergeTitle(["Task t2", "Task t3"]), batch: ["t2", "t3"] }]);
  expect(advances).toEqual([[landed, L.commitId]]);
});

test("a task holding the work of one that left in the round is held back", async () => {
  const { B, on, task, run, left, heldBack, advances } = await fixture();
  const mine = await on(B, "mine", { "g.txt": "mine\n" });
  // tl's draft is undescribed, and tu merged tl's line, which freezes the draft in tl's workspace.
  const draft = await on(B, "", { "h.txt": "draft\n" });
  const merged = await on(`${mine} | ${draft}`, "merge a draft");
  await task("tu", merged, { title: "Use the draft", size: 9 });
  await task("tl", draft, { title: "Draft" });

  expect(await run()).toEqual({ landed: null, again: false, paused: null });
  expect(left).toEqual([["tl", expect.stringContaining("has no description, and it is not the task's to change")]]);
  // tu would land tl's undescribed draft.
  expect(heldBack).toEqual([["tu", "Use the draft includes work from Draft, which isn't queued"]]);
  expect(advances).toEqual([]);
});

test("blaming a contained task drops the task holding its work too", async () => {
  const { B, on, task, run, created, advances, left, turns, act } = await fixture();
  const lower = await on(B, "lower", { "f.txt": edited(2, "TWO") });
  const upper = await on(lower, "upper", { "g.txt": "upper\n" });
  const apart = await on(B, "apart", { "f.txt": edited(6, "SIX") });
  await task("tu", upper, { size: 4, base: [lower] });
  await task("tl", lower, { size: 2 });
  await task("tx", apart);
  act("merge", async () => ({ kind: "blamed", task: "Task tl", reason: "test two fails" }));

  expect(await run()).toEqual({ landed: apart, again: false, paused: null });
  // The lower tip is in the upper one: the merge's parents are the upper tip and the other task's.
  expect(created.map((c) => [c.batch, c.parents])).toEqual([[["tu", "tl", "tx"], [upper, apart]]]);
  // The upper task would land the blamed work: it waits, and the rest is one head.
  expect(advances).toEqual([[B, apart]]);
  // tl can't rebase what tu has built on: it leaves rather than get its fix turn.
  expect(left).toEqual([["tl", "another task builds on this work, so it can't rebase"]]);
  expect(turns.map((t) => t.taskId)).toEqual(["m1"]);
});
