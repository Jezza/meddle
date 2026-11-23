// test/train.test.ts — the merge train's conductor: the project's home runs a round whenever something could change
// the outcome (a task queued, a queued task's turn ending, the branch moving, Resume or Retry), one at a time, as a
// durable `meddle.train` that a restart resumes; Pause holds landing across restarts; a push mid-round starts the round
// over against the new main; Retry brings a task that sat out back. The agents' turns are faked through the runner's
// `trainTurn` hook (the stand-in Claude Code runs no tools); everything the conductor does around them is real.
import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry } from "@earendil-works/pi-durable";
import { paths } from "../src/config";
import { commitOf, commitsIn, jj } from "../src/jj";
import { markRemoved } from "../src/pool/removed";
import { lineChanges, listBranchRows, listLineRows } from "../src/pool/rows";
import { makeCheckout } from "../src/projects/checkouts";
import { getProject } from "../src/projects/project";
import { defaultBranchCommit } from "../src/projects/starts";
import { createNodeHost } from "../src/state/host";
import { getTask, listTasks } from "../src/store/records";
import { TaskRunner, UNQUEUED_BY_INPUT, UNQUEUED_BY_USER } from "../src/tasks/durable";
import { openHarness } from "../src/tasks/harness";
import type { TaskManifest } from "../src/tasks/manifest";
import type { TrainTurnKind, TrainTurnOutcome } from "../src/train/tools";
import { forgetTrain, pauseTrain, retryTask, trainState } from "../src/train/train";
import { claudeCodeVersion } from "../src/version";
import { startApplier } from "../src/projects/applier";
import { createTask, replay } from "./helpers";
import { peerReady, poolNodes, twoPoolNodes, type GitPoolNode } from "./pool-helpers";

async function waitFor(what: string, cond: () => boolean | Promise<boolean>, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

/** Project `P`'s default branch on node `n`, as its rows have it. */
async function mainOf(n: GitPoolNode, P: string): Promise<string> {
  return defaultBranchCommit({ cfg: n.cfg, db: n.db, selfId: n.id }, getProject(n.db, P)!);
}

/** The task's workspace of its (one) project on node `n`. */
function workspaceOf(n: GitPoolNode, taskId: string): string {
  const manifest = JSON.parse(getTask(n.db, taskId)!.manifest) as TaskManifest;
  return join(paths(n.cfg).task(taskId), manifest.projects[0]!.workspace);
}

/**
 * A task of project `P` on node `on` whose work adds `file`: committed with a description (its tip the commit), or with
 * `undescribed` left in its working copy without one (its tip the working copy). Its lines are written, as a turn end
 * would.
 */
async function taskWithWork(on: GitPoolNode, P: string, file: string, options: { undescribed?: boolean } = {}) {
  const m = await createTask(on, { title: `Add ${file}`, projectIds: [P] });
  const ws = workspaceOf(on, m.id);
  await Bun.write(join(ws, file), `${file}\n`);
  if (options.undescribed === true) await jj(["status"], ws, on.cfg);
  else await jj(["commit", "-m", `Add ${file}`], ws, on.cfg);
  await on.runner.writeTaskLines(m.id);
  const tip = await commitOf(ws, options.undescribed === true ? "@" : "@-", on.cfg);
  return { id: m.id, ws, tip };
}

/** The merge tasks live on node `n` (not archived, moved or deleted). */
function liveMergeTasks(n: GitPoolNode): string[] {
  return listTasks(n.db)
    .filter((t) => t.state !== "archived" && t.state !== "moved" && (JSON.parse(t.manifest) as TaskManifest).merge !== undefined)
    .map((t) => t.id);
}

/**
 * Fakes the merge agent on node `n` (through the runner's `trainTurn` hook): it describes the merge in the merge task's
 * workspace and writes the task's lines, as a turn end would. With `stall`, the first merge turn waits for `release()`
 * once it has `reached` that point; with `blame`, the first merge turn blames that task. Records each merge task it ran
 * for (`tasks`), its merge's parents (`parents`), and the merge tasks live on `n` as it ran (`alive`). Turns of other
 * kinds go to `others` (else the real turn runs).
 */
function fakeMerge(
  n: GitPoolNode,
  options: { stall?: boolean; blame?: string; others?: (taskId: string, kind: TrainTurnKind, text: string) => Promise<TrainTurnOutcome | undefined> } = {},
) {
  const reached = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const tasks: string[] = [];
  const parents: string[][] = [];
  const alive: string[][] = [];
  n.hooks.trainTurn = async (taskId, kind, text) => {
    if (kind !== "merge") return options.others?.(taskId, kind, text);
    tasks.push(taskId);
    alive.push(liveMergeTasks(n));
    if (options.stall === true && tasks.length === 1) {
      reached.resolve();
      await gate.promise;
    }
    if (options.blame !== undefined && tasks.length === 1) return { kind: "blamed", task: options.blame, reason: "its test fails" };
    // A merge task discarded meanwhile (its node restarted under it) has nothing left to describe.
    if (getTask(n.db, taskId)?.state !== "idle") return { kind: "failed", reason: "the merge task is gone" };
    const ws = workspaceOf(n, taskId);
    parents.push((await commitsIn(ws, "@", n.cfg))[0]!.parents);
    await jj(["describe", "-m", "Merge the batch"], ws, n.cfg);
    await n.runner.writeTaskLines(taskId);
    return { kind: "done" };
  };
  return { reached: reached.promise, release: () => gate.resolve(), tasks, parents, alive };
}

/**
 * Restarts node `n`'s durable side, as a process restart would: its Harness (closed first, as `serve` shuts down), its
 * runner and its chord host (whose close stops the conductor) go, and new ones open on the same database and pool, the
 * conductor starting with the host. `n` is updated in place, so its `close` stops the new ones.
 */
async function restart(n: GitPoolNode): Promise<void> {
  await n.harness.close();
  await n.host.close();
  n.runner.close();
  const harness = await openHarness(n.cfg, createRegistry());
  const runner = new TaskRunner(n.cfg, n.db, harness.harness, {
    claudePath: replay, claudeRuntime: "bun", extraEnv: { MEDDLE_FIXTURE: `${import.meta.dir}/fixtures/hello.jsonl` },
    pool: n.pool, log: (line) => n.logs.push(line), hooks: n.hooks,
  });
  const host = createNodeHost({ cfg: n.cfg, db: n.db, runner, metrics: n.metrics, claudeCodeVersion: claudeCodeVersion(), pool: n.pool });
  Object.assign(n, {
    harness, runner, host,
    async close() {
      n.metrics.stop();
      runner.close();
      await n.pool.stop();
      await harness.close();
      await host.close();
    },
  });
}

/**
 * Accepts `taskIds` on node `n`, all before a round of project `P`'s train can pick any of them: the train is paused
 * meanwhile, then resumed.
 */
async function acceptAll(n: GitPoolNode, P: string, taskIds: string[]): Promise<void> {
  pauseTrain(n.db, P, "accepting");
  for (const id of taskIds) await n.runner.accept(id);
  pauseTrain(n.db, P, null);
}

/** The `meddle.train` tasks live in node `n`'s Harness. */
async function liveTrains(n: GitPoolNode): Promise<unknown[]> {
  const { tasks } = await n.harness.harness.inspect(BACKGROUND_CONTEXT);
  return tasks.filter((t) => t.record.kind === "meddle.train").map((t) => t.record.input);
}

/**
 * Starts each node's applier, as `serve` runs it: a node admits another's row for main once it has its commit, and its
 * acceptance sees the branch move. Started once the tests' tasks have their work (jj in their workspaces then never
 * runs alongside an apply of their project's repo). Returns the stops.
 */
function appliers(...nodes: GitPoolNode[]): Array<() => void> {
  return nodes.map((n) => startApplier({ cfg: n.cfg, db: n.db, pool: n.pool, log: (line) => n.logs.push(line) }));
}

/** `PATH` with this node's `<data>/bin` first: what `makeCheckout` checks for the helper. */
const helperEnv = (n: GitPoolNode) => ({ PATH: `${paths(n.cfg).bin}${delimiter}${process.env.PATH}` });

test("a queued task triggers a round on the home only", async () => {
  const { A, B, close } = await twoPoolNodes();
  const stops: Array<() => void> = [];
  try {
    await peerReady(A, B);
    await peerReady(B, A);
    const P = A.project.id;
    await waitFor("A's project in B's roster", () => B.store.row(A.id)?.summary?.projects?.some((p) => p.id === P) === true);
    // A task on B, of A's project: B holds its line and its queue, A runs the train.
    const t = await taskWithWork(B, P, "x.txt");
    await B.runner.accept(t.id);
    stops.push(...appliers(A, B));
    await waitFor("A to move main onto the task's work", async () => (await mainOf(A, P)) === t.tip);
    // The branch row is A's; B, the task's holder, archives the task once its work is on main.
    expect(listBranchRows(A.db, P, "main").map((r) => r.node)).toEqual([A.id]);
    await waitFor("B to archive the landed task", () => getTask(B.db, t.id)?.state === "archived");
    expect(trainState(A.db, P)).toEqual({ paused: null, round: null, queued: [] });
    // B ran no train of A's project: no branch row of its own, nothing recorded, nothing in its Harness.
    expect(listBranchRows(B.db, P).filter((r) => r.node === B.id)).toEqual([]);
    expect(B.db.query("SELECT project FROM trains WHERE project = ?").all(P)).toEqual([]);
    expect(await liveTrains(B)).toEqual([]);
  } finally {
    for (const stop of stops) stop();
    await close();
  }
}, 180_000);

test("pause holds landing and survives a restart", async () => {
  const { nodes, close } = await poolNodes(1);
  const n = nodes[0]!;
  try {
    const P = n.project.id;
    const before = await mainOf(n, P);
    const merge = fakeMerge(n, { stall: true });
    const t1 = await taskWithWork(n, P, "x.txt");
    const t2 = await taskWithWork(n, P, "y.txt");
    await acceptAll(n, P, [t1.id, t2.id]);
    await merge.reached;
    // Paused while the merge agent checks: its turn finishes, and nothing lands.
    pauseTrain(n.db, P, "you paused it");
    merge.release();
    await waitFor("the round to end without landing", async () => (await liveTrains(n)).length === 0 && liveMergeTasks(n).length === 0);
    expect(await mainOf(n, P)).toBe(before);
    expect(trainState(n.db, P).paused).toBe("you paused it");
    // A paused train keeps no update waiting.
    expect(await n.runner.busyTasks()).toEqual([]);

    // Still paused after a restart: no round starts, nothing lands.
    await restart(n);
    await Bun.sleep(2000);
    expect(await liveTrains(n)).toEqual([]);
    expect(await mainOf(n, P)).toBe(before);
    expect(merge.tasks).toHaveLength(1);
    expect(trainState(n.db, P).paused).toBe("you paused it");
    expect(trainState(n.db, P).queued.map((q) => q.taskId).sort()).toEqual([t1.id, t2.id].sort());

    // Resume: the round checks again, with a fresh merge task, and lands.
    pauseTrain(n.db, P, null);
    await waitFor("main to move", async () => (await mainOf(n, P)) !== before);
    const landed = (await commitsIn(n.project.replica, await mainOf(n, P), n.cfg))[0]!;
    expect(landed.parents.sort()).toEqual([t1.tip, t2.tip].sort());
    expect(merge.tasks).toHaveLength(2);
    await waitFor("both tasks and the merge task archived", () =>
      [t1.id, t2.id, merge.tasks[1]!].every((id) => getTask(n.db, id)?.state === "archived"));
    expect(trainState(n.db, P)).toEqual({ paused: null, round: null, queued: [] });
  } finally {
    await close();
  }
}, 180_000);

test("a restart mid-round leaves at most one live merge task", async () => {
  const { nodes, close } = await poolNodes(1);
  const n = nodes[0]!;
  const merge = fakeMerge(n, { stall: true });
  try {
    const P = n.project.id;
    const t1 = await taskWithWork(n, P, "x.txt");
    const t2 = await taskWithWork(n, P, "y.txt");
    await acceptAll(n, P, [t1.id, t2.id]);
    await merge.reached;
    const first = merge.tasks[0]!;
    const round = trainState(n.db, P).round!;
    expect({ ...round, batch: [...round.batch].sort() }).toEqual({ step: "checking", batch: [t1.id, t2.id].sort(), mergeTask: first });
    expect(trainState(n.db, P).queued.map((q) => q.state)).toEqual(["in the batch", "in the batch"]);
    expect(liveMergeTasks(n)).toEqual([first]);
    // A round in flight is what an update drains.
    expect(await n.runner.busyTasks()).toEqual([`train:${P}`]);

    // The node restarts while the merge agent checks the batch.
    await restart(n);
    await waitFor("main to land the merge", async () => (await commitsIn(n.project.replica, await mainOf(n, P), n.cfg))[0]!.parents.length === 2);
    // The round resumed from its checkpoint: it discarded the merge task the restart cut off, then a fresh one checked
    // the batch. Two were made over time, never two alive at once.
    expect(merge.tasks).toHaveLength(2);
    expect(merge.tasks[1]).not.toBe(first);
    expect(merge.alive[1]).toEqual([merge.tasks[1]!]);
    expect(getTask(n.db, first)).toBeNull();
    await waitFor("both tasks and the merge task archived", () =>
      [t1.id, t2.id, merge.tasks[1]!].every((id) => getTask(n.db, id)?.state === "archived"));
    expect(liveMergeTasks(n)).toEqual([]);
    expect(trainState(n.db, P)).toEqual({ paused: null, round: null, queued: [] });
    await waitFor("the round to end", async () => (await n.runner.busyTasks()).length === 0);
  } finally {
    merge.release();
    await close();
  }
}, 180_000);

test("a push during checking restarts the round against the new main", async () => {
  const { nodes, close } = await poolNodes(1);
  const n = nodes[0]!;
  try {
    const P = n.project.id;
    const co = await makeCheckout(n.cfg, n.id, n.project, `${n.home}/co`, helperEnv(n));
    const merge = fakeMerge(n, { stall: true });
    const t1 = await taskWithWork(n, P, "x.txt");
    const t2 = await taskWithWork(n, P, "y.txt");
    await acceptAll(n, P, [t1.id, t2.id]);
    await merge.reached;

    // Someone pushes to main from a checkout while the merge agent checks the batch.
    await jj(["new", "main"], co, n.cfg);
    await Bun.write(join(co, "z.txt"), "z\n");
    await jj(["commit", "-m", "Add z"], co, n.cfg);
    const z = await commitOf(co, "@-", n.cfg);
    await jj(["bookmark", "set", "main", "-r", z], co, n.cfg);
    await jj(["git", "push", "--remote", "meddle", "-b", "main"], co, n.cfg);
    expect(await mainOf(n, P)).toBe(z);
    merge.release();

    // The landing is refused (main is not where the round read it), and the round starts over on z: a fresh merge task
    // checks the batch merged with it, and that lands.
    await waitFor("main to move past z", async () => (await mainOf(n, P)) !== z);
    expect(merge.tasks).toHaveLength(2);
    expect(merge.parents[1]!.sort()).toEqual([t1.tip, t2.tip, z].sort());
    const landed = (await commitsIn(n.project.replica, await mainOf(n, P), n.cfg))[0]!;
    expect(landed.parents.sort()).toEqual([t1.tip, t2.tip, z].sort());
    expect(getTask(n.db, merge.tasks[0]!)).toBeNull();
    await waitFor("both tasks and the merge task archived", () =>
      [t1.id, t2.id, merge.tasks[1]!].every((id) => getTask(n.db, id)?.state === "archived"));
  } finally {
    await close();
  }
}, 180_000);

/** The merge task live on node `n` whose turn runs there, once there is one. */
function runningMergeTask(n: GitPoolNode): string | undefined {
  return liveMergeTasks(n).find((id) => n.runner.state(id) === "running");
}

test("unqueueing a batch task stops the check at once", async () => {
  // Every turn's stand-in Claude Code stalls before its `result` until it is interrupted: the merge agent's turn never
  // ends by itself.
  const { nodes, close } = await poolNodes(1, { extraEnv: { MEDDLE_FIXTURE_STALL: "1" } });
  const n = nodes[0]!;
  try {
    const P = n.project.id;
    const t1 = await taskWithWork(n, P, "x.txt");
    const t2 = await taskWithWork(n, P, "y.txt");
    await acceptAll(n, P, [t1.id, t2.id]);
    await waitFor("the merge agent's turn", () => runningMergeTask(n) !== undefined);
    const m = runningMergeTask(n)!;
    expect(trainState(n.db, P).round).toMatchObject({ step: "checking", mergeTask: m });

    await n.runner.unqueue(t1.id, UNQUEUED_BY_USER);
    // The check stops at once: the merge agent's turn is interrupted, and the merge task discarded.
    await waitFor("the merge task discarded", () => getTask(n.db, m) === null, 20_000);
    // Nothing paused, and the round starts over without t1: t2, on main, is a single head and lands as it is.
    await waitFor("t2 to land", async () => (await mainOf(n, P)) === t2.tip, 30_000);
    expect(trainState(n.db, P).paused).toBeNull();
    expect(liveMergeTasks(n)).toEqual([]);
    await waitFor("t2 archived", () => getTask(n.db, t2.id)?.state === "archived");
    expect(trainState(n.db, P)).toEqual({ paused: null, round: null, queued: [] });
    // t1 is off the train, nothing of it landed, and it doesn't sit out.
    expect(n.runner.queue(t1.id)).toBeNull();
    expect(getTask(n.db, t1.id)?.state).toBe("idle");
  } finally {
    await close();
  }
}, 180_000);

test("a message to a batch task during the check stops it too", async () => {
  const { nodes, close } = await poolNodes(1, { extraEnv: { MEDDLE_FIXTURE_STALL: "1" } });
  const n = nodes[0]!;
  const left: Array<[string, string | null]> = [];
  let t1: { id: string } | null = null;
  try {
    const P = n.project.id;
    n.runner.onQueue((taskId, queue, reason) => { if (queue === null) left.push([taskId, reason]); });
    t1 = await taskWithWork(n, P, "x.txt");
    const t2 = await taskWithWork(n, P, "y.txt");
    await acceptAll(n, P, [t1.id, t2.id]);
    await waitFor("the merge agent's turn", () => runningMergeTask(n) !== undefined);
    const m = runningMergeTask(n)!;

    // The message runs at once, which takes t1 off the queue, and the check stops.
    expect(await n.runner.prompt(t1.id, "Also handle z.")).toBe("turn");
    expect(left).toEqual([[t1.id, UNQUEUED_BY_INPUT]]);
    await waitFor("the merge task discarded", () => getTask(n.db, m) === null, 20_000);
    await waitFor("t2 to land", async () => (await mainOf(n, P)) === t2.tip, 30_000);
    expect(trainState(n.db, P).paused).toBeNull();
    expect(liveMergeTasks(n)).toEqual([]);
    await waitFor("t2 archived", () => getTask(n.db, t2.id)?.state === "archived");
    expect(trainState(n.db, P)).toEqual({ paused: null, round: null, queued: [] });
    expect(n.runner.state(t1.id)).toBe("running");
  } finally {
    if (t1 !== null) await n.runner.interrupt(t1.id).catch(() => {});
    await close();
  }
}, 180_000);

test("a batch task that leaves just as the merge turn fails by itself pauses nothing", async () => {
  const { nodes, close } = await poolNodes(1);
  const n = nodes[0]!;
  try {
    const P = n.project.id;
    const t1 = await taskWithWork(n, P, "x.txt");
    const t2 = await taskWithWork(n, P, "y.txt");
    const merges: string[] = [];
    // The user unqueues t1 as the merge agent's turn fails.
    n.hooks.trainTurn = async (taskId, kind) => {
      if (kind !== "merge") return undefined;
      merges.push(taskId);
      await n.runner.unqueue(t1.id, UNQUEUED_BY_USER);
      return { kind: "failed", reason: "the agent crashed" };
    };
    await acceptAll(n, P, [t1.id, t2.id]);
    // No stuck pause: the round starts over without t1, and t2 lands as it is.
    await waitFor("t2 to land", async () => (await mainOf(n, P)) === t2.tip);
    expect(trainState(n.db, P).paused).toBeNull();
    expect(merges).toHaveLength(1);
    await waitFor("the merge task discarded", () => getTask(n.db, merges[0]!) === null);
    await waitFor("t2 archived", () => getTask(n.db, t2.id)?.state === "archived");
    expect(trainState(n.db, P)).toEqual({ paused: null, round: null, queued: [] });
  } finally {
    await close();
  }
}, 180_000);

test("unqueueing a batch task stops a check on another node too", async () => {
  // B's turns stall until interrupted; the home, A, hosts no tasks, so its merge tasks go to B.
  const { A, B, close } = await twoPoolNodes({ nodes: [{}, { extraEnv: { MEDDLE_FIXTURE_STALL: "1" } }] });
  const stops: Array<() => void> = [];
  try {
    await peerReady(A, B);
    await peerReady(B, A);
    const P = A.project.id;
    await waitFor("A's project in B's roster", () => B.store.row(A.id)?.summary?.projects?.some((p) => p.id === P) === true);
    await rm(A.cfg.taskRoot, { recursive: true, force: true });
    pauseTrain(A.db, P, "accepting");
    const t1 = await taskWithWork(B, P, "x.txt");
    const t2 = await taskWithWork(B, P, "y.txt");
    await B.runner.accept(t1.id);
    await B.runner.accept(t2.id);
    stops.push(...appliers(A, B));
    await waitFor("both queued on A", () => trainState(A.db, P).queued.length === 2);
    pauseTrain(A.db, P, null);
    await waitFor("the merge agent's turn on B", () => runningMergeTask(B) !== undefined);
    const m = runningMergeTask(B)!;

    // Unqueued on B, its holder: the home hears of it, and B interrupts the merge turn and discards the merge task.
    await B.runner.unqueue(t1.id, UNQUEUED_BY_USER);
    await waitFor("B to drop the merge task", () => getTask(B.db, m) === null, 30_000);
    await waitFor("t2 to land", async () => (await mainOf(A, P)) === t2.tip, 30_000);
    expect(trainState(A.db, P).paused).toBeNull();
    await waitFor("B to archive t2", () => getTask(B.db, t2.id)?.state === "archived");
    expect(liveMergeTasks(B)).toEqual([]);
    expect(B.runner.queue(t1.id)).toBeNull();
  } finally {
    for (const stop of stops) stop();
    await close();
  }
}, 180_000);

test("retry brings a sitting-out task back", async () => {
  const { nodes, close } = await poolNodes(1);
  const n = nodes[0]!;
  try {
    const P = n.project.id;
    const describes: string[] = [];
    let described = "";
    // Its first describe turn fails; the next describes its work, as the agent would.
    n.hooks.trainTurn = async (taskId, kind, text) => {
      if (kind !== "describe") return undefined;
      describes.push(text);
      if (describes.length === 1) return { kind: "failed", reason: "the agent gave up" };
      const ws = workspaceOf(n, taskId);
      await jj(["describe", "-m", "Add x"], ws, n.cfg);
      described = await commitOf(ws, "@", n.cfg);
      await n.runner.writeTaskLines(taskId);
      return { kind: "done" };
    };
    const t = await taskWithWork(n, P, "x.txt", { undescribed: true });
    const before = await mainOf(n, P);
    await n.runner.accept(t.id);
    await waitFor("the task to sit out", () => trainState(n.db, P).queued[0]?.state === "sitting out");
    expect(trainState(n.db, P).queued).toEqual([{ taskId: t.id, state: "sitting out", reason: "its describe turn failed: the agent gave up" }]);
    // Nothing brings it back by itself: no second describe turn, nothing lands.
    await Bun.sleep(2500);
    expect(describes).toHaveLength(1);
    expect(await mainOf(n, P)).toBe(before);

    retryTask(n.db, P, t.id);
    await waitFor("main to move", async () => (await mainOf(n, P)) !== before);
    expect(describes).toHaveLength(2);
    expect(await mainOf(n, P)).toBe(described);
    await waitFor("the task archived", () => getTask(n.db, t.id)?.state === "archived");
    expect(trainState(n.db, P)).toEqual({ paused: null, round: null, queued: [] });
  } finally {
    await close();
  }
}, 180_000);

test("a task accepted again before the train hears of its decline stays queued: the train only records it", async () => {
  const { nodes, close } = await poolNodes(1);
  const n = nodes[0]!;
  try {
    const P = n.project.id;
    const left: string[] = [];
    n.runner.onQueue((_, queue, reason) => { if (queue === null) left.push(String(reason)); });
    let turns = 0;
    // The agent declines, which takes the task off on its holder as it is logged; then the user accepts it again, all
    // before the round hears how the turn went. The train is paused then, so no round asks it again.
    n.hooks.trainTurn = async (taskId, kind) => {
      if (kind !== "describe") return undefined;
      turns++;
      await n.runner.unqueue(taskId, "main already does this");
      await n.runner.accept(taskId);
      pauseTrain(n.db, P, "held by the test");
      return { kind: "declined", reason: "main already does this" };
    };
    const t = await taskWithWork(n, P, "x.txt", { undescribed: true });
    await n.runner.accept(t.id);
    await waitFor("the round to end", async () => turns === 1 && (await liveTrains(n)).length === 0);
    expect(n.runner.queue(t.id)).not.toBeNull();
    expect(left).toEqual(["main already does this"]);
    expect(trainState(n.db, P).queued.map((q) => [q.taskId, q.reason])).toEqual([[t.id, null]]);
  } finally {
    await close();
  }
}, 180_000);

const HELD = "update in progress (build 1ee71ee71ee7)";
const NO_HOLDS = { turns: null, work: null, hosting: null };

test("a pool update that holds turns before the merge turn holds the round up: no pause, no merge task, until it lifts", async () => {
  const { nodes, close } = await poolNodes(1);
  const n = nodes[0]!;
  try {
    const P = n.project.id;
    const before = await mainOf(n, P);
    const described = Promise.withResolvers<void>();
    // The update's hold comes while t2's describe turn runs: the merge task and its turn would be next.
    const merge = fakeMerge(n, {
      others: async (taskId, kind) => {
        if (kind !== "describe") return undefined;
        n.runner.setHolds({ turns: HELD, work: null, hosting: null });
        await jj(["describe", "-m", "Add y"], workspaceOf(n, taskId), n.cfg);
        await n.runner.writeTaskLines(taskId);
        described.resolve();
        return { kind: "done" };
      },
    });
    const t1 = await taskWithWork(n, P, "x.txt");
    const t2 = await taskWithWork(n, P, "y.txt", { undescribed: true });
    await acceptAll(n, P, [t1.id, t2.id]);
    await described.promise;
    await waitFor("the round to end", async () => (await liveTrains(n)).length === 0);
    // Held up: not paused, nothing sitting out, no merge task made, and nothing keeps the update's drain waiting.
    expect(trainState(n.db, P)).toEqual({
      paused: null, round: null,
      queued: [{ taskId: t1.id, state: "queued", reason: null }, { taskId: t2.id, state: "queued", reason: null }],
    });
    expect(merge.tasks).toEqual([]);
    expect(liveMergeTasks(n)).toEqual([]);
    expect(await n.runner.busyTasks()).toEqual([]);
    // No round starts while the hold lasts.
    await Bun.sleep(1500);
    expect(await liveTrains(n)).toEqual([]);
    expect(await mainOf(n, P)).toBe(before);

    // The hold lifts: a round starts by itself, checks the batch and lands it.
    n.runner.setHolds(NO_HOLDS);
    await waitFor("main to land the merge", async () => (await commitsIn(n.project.replica, await mainOf(n, P), n.cfg))[0]!.parents.length === 2);
    expect(merge.tasks).toHaveLength(1);
    await waitFor("both tasks archived", () => [t1.id, t2.id].every((id) => getTask(n.db, id)?.state === "archived"));
  } finally {
    await close();
  }
}, 180_000);

test("a turn a pool update's hold refuses sits no task out, and the round carries on by itself once it lifts", async () => {
  const { nodes, close } = await poolNodes(1);
  const n = nodes[0]!;
  try {
    const P = n.project.id;
    const t1 = await taskWithWork(n, P, "x.txt");
    const t2 = await taskWithWork(n, P, "y.txt");
    const others: string[] = [];
    // The merge agent blames t1, which gets a fix turn after t2 lands; the update's hold comes during the check.
    const merge = fakeMerge(n, { stall: true, blame: t1.id, others: async (_id, kind) => { others.push(kind); return { kind: "done" }; } });
    await acceptAll(n, P, [t1.id, t2.id]);
    await merge.reached;
    n.runner.setHolds({ turns: HELD, work: null, hosting: null });
    merge.release();
    await waitFor("t2 to land alone", async () => (await mainOf(n, P)) === t2.tip);
    await waitFor("the round to end", async () => (await liveTrains(n)).length === 0);
    // Only the update's turns are held: acceptance still archives what landed.
    await waitFor("t2 archived", () => getTask(n.db, t2.id)?.state === "archived");
    // t1's fix turn was refused by the hold: it never ran, and t1 does not sit out for it; nothing is paused.
    expect(others).toEqual([]);
    expect(trainState(n.db, P)).toEqual({ paused: null, round: null, queued: [{ taskId: t1.id, state: "queued", reason: null }] });
    expect(liveMergeTasks(n)).toEqual([]);
    expect(await n.runner.busyTasks()).toEqual([]);

    // The hold lifts: t1 is checked against main and lands, without a Retry.
    n.runner.setHolds(NO_HOLDS);
    await waitFor("main to land t1", async () => (await commitsIn(n.project.replica, await mainOf(n, P), n.cfg))[0]!.parents.sort().join() === [t1.tip, t2.tip].sort().join());
    await waitFor("t1 archived", () => getTask(n.db, t1.id)?.state === "archived");
  } finally {
    await close();
  }
}, 180_000);

test("a holder whose turns a pool update holds refuses the train's turn as held: the task does not sit out, and the round comes back", async () => {
  const { A, B, close } = await twoPoolNodes();
  const stops: Array<() => void> = [];
  try {
    await peerReady(A, B);
    await peerReady(B, A);
    const P = A.project.id;
    await waitFor("A's project in B's roster", () => B.store.row(A.id)?.summary?.projects?.some((p) => p.id === P) === true);
    let asked = 0;
    // B's describe turns describe the work, once B no longer holds turns; meanwhile the real `trainTurn` refuses.
    B.hooks.trainTurn = async (taskId, kind) => {
      if (kind !== "describe") return undefined;
      asked += 1;
      if (B.runner.holds().turns !== null) return undefined;
      await jj(["describe", "-m", "Add x"], workspaceOf(B, taskId), B.cfg);
      await B.runner.writeTaskLines(taskId);
      return { kind: "done" };
    };
    const t = await taskWithWork(B, P, "x.txt", { undescribed: true });
    B.runner.setHolds({ turns: HELD, work: null, hosting: null });
    await B.runner.accept(t.id);
    stops.push(...appliers(A, B));
    // A's rounds ask, are refused as held, and ask again by themselves (paced): t never sits out.
    await waitFor("A to ask B twice", () => asked >= 2);
    expect(trainState(A.db, P)).toMatchObject({ paused: null, queued: [{ taskId: t.id, state: "queued", reason: null }] });

    B.runner.setHolds(NO_HOLDS);
    await waitFor("main to move onto t's work", async () => (await commitsIn(A.project.replica, await mainOf(A, P), A.cfg))[0]!.description === "Add x\n");
    await waitFor("B to archive t", () => getTask(B.db, t.id)?.state === "archived");
  } finally {
    for (const stop of stops) stop();
    await close();
  }
}, 180_000);

test("a merge task placed on another node is reached there, whatever the home's rows of it say, a resumed round's too", async () => {
  const { A, B, close } = await twoPoolNodes();
  const stops: Array<() => void> = [];
  const offLines: Array<() => void> = [];
  try {
    await peerReady(A, B);
    await peerReady(B, A);
    const P = A.project.id;
    await waitFor("A's project in B's roster", () => B.store.row(A.id)?.summary?.projects?.some((p) => p.id === P) === true);
    // The home hosts no tasks: its merge tasks go to B.
    await rm(A.cfg.taskRoot, { recursive: true, force: true });
    pauseTrain(A.db, P, "accepting");
    const t1 = await taskWithWork(B, P, "x.txt");
    const t2 = await taskWithWork(B, P, "y.txt");
    await B.runner.accept(t1.id);
    await B.runner.accept(t2.id);
    stops.push(...appliers(A, B));
    await waitFor("both queued on A", () => trainState(A.db, P).queued.length === 2);
    const merge = fakeMerge(B);

    // B's rows of the first merge task never reach A: A's only row of it is the start A wrote, held by A.
    let first: string | null = null;
    const block = (taskId: string) => {
      for (const op of ["INSERT", "UPDATE"]) {
        A.db.exec(`CREATE TEMP TRIGGER hold_${op.toLowerCase()} BEFORE ${op} ON line_rows WHEN NEW.task = '${taskId}' AND NEW.holder = '${B.id}' BEGIN SELECT RAISE(IGNORE); END`);
      }
    };
    offLines.push(lineChanges.subscribe(({ project, task }) => {
      if (first !== null || project !== P || task === t1.id || task === t2.id) return;
      if (!listLineRows(A.db, P, task).some((r) => r.holder === A.id && r.epoch === 0)) return;
      first = task;
      block(task);
    }));
    pauseTrain(A.db, P, null);
    // The round cannot read the merge's head (its line never comes), so it discards the merge task, on B, and pauses.
    await waitFor("the train to pause", () => trainState(A.db, P).paused !== null);
    expect(trainState(A.db, P).paused).toStartWith("the batch's check failed: ");
    expect(first).not.toBeNull();
    expect(listLineRows(A.db, P, first!).map((r) => r.holder)).toEqual([A.id]);
    await waitFor("B to drop the merge task", () => getTask(B.db, first!) === null);
    expect(liveMergeTasks(B)).toEqual([]);
    // Where the round is says where its merge task went, for a round resumed after a restart of the home too.
    expect(trainState(A.db, P).round).toEqual({ step: "checking", batch: expect.any(Array), mergeTask: first });
    const kept = A.db.query<{ round: string }, [string]>("SELECT round FROM trains WHERE project = ?").get(P)!;
    expect(JSON.parse(kept.round)).toMatchObject({ mergeTask: first, mergeNode: B.id });

    // Its rows come through again; Retry: the round resumes, a fresh merge task on B checks the batch, and it lands.
    A.db.exec("DROP TRIGGER hold_insert");
    A.db.exec("DROP TRIGGER hold_update");
    pauseTrain(A.db, P, null);
    await waitFor("main to land the merge", async () => (await commitsIn(A.project.replica, await mainOf(A, P), A.cfg))[0]!.parents.length === 2);
    expect(merge.tasks).toHaveLength(1);
    expect(merge.tasks[0]).not.toBe(first);
    expect(getTask(A.db, merge.tasks[0]!)).toBeNull();
    await waitFor("B to archive both tasks and the merge task", () =>
      [t1.id, t2.id, merge.tasks[0]!].every((id) => getTask(B.db, id)?.state === "archived"));
  } finally {
    for (const off of offLines) off();
    for (const stop of stops) stop();
    await close();
  }
}, 180_000);

test("a hold that starts during a step of several turns refuses each of the rest: none sits out or counts as asked", async () => {
  const { nodes, close } = await poolNodes(1);
  const n = nodes[0]!;
  try {
    const P = n.project.id;
    const before = await mainOf(n, P);
    const described: string[] = [];
    // Three describe turns start together; the update's hold comes as the first of them runs, so the other two are
    // refused, the second as the hold is found and the third once the round is held up.
    const merge = fakeMerge(n, {
      others: async (taskId, kind) => {
        if (kind !== "describe") return undefined;
        if (described.length === 0) n.runner.setHolds({ turns: HELD, work: null, hosting: null });
        described.push(taskId);
        await jj(["describe", "-m", `Describe ${taskId}`], workspaceOf(n, taskId), n.cfg);
        await n.runner.writeTaskLines(taskId);
        return { kind: "done" };
      },
    });
    const tasks = [
      await taskWithWork(n, P, "x.txt", { undescribed: true }),
      await taskWithWork(n, P, "y.txt", { undescribed: true }),
      await taskWithWork(n, P, "z.txt", { undescribed: true }),
    ];
    const ids = tasks.map((t) => t.id);
    await acceptAll(n, P, ids);
    await waitFor("the first describe turn", () => described.length === 1);
    await waitFor("the round to end", async () => (await liveTrains(n)).length === 0);
    // Only the turn that ran counts as asked; the two refused ones neither sit out nor count.
    expect(described).toHaveLength(1);
    const state = trainState(n.db, P);
    expect(state.paused).toBeNull();
    expect(state.round).toEqual({ step: "describing", batch: described, mergeTask: null });
    expect(state.queued.map((q) => q.taskId).sort()).toEqual([...ids].sort());
    expect(state.queued.filter((q) => q.taskId !== described[0]).map((q) => q.state)).toEqual(["queued", "queued"]);
    expect(state.queued.some((q) => q.state === "sitting out")).toBe(false);
    expect(await n.runner.busyTasks()).toEqual([]);
    await Bun.sleep(1500);
    expect(described).toHaveLength(1);
    expect(await mainOf(n, P)).toBe(before);

    // The hold lifts: the round resumes by itself, the two refused tasks get their describe turns, and the batch lands.
    n.runner.setHolds(NO_HOLDS);
    await waitFor("main to land the batch", async () => (await commitsIn(n.project.replica, await mainOf(n, P), n.cfg))[0]!.parents.length === 3);
    expect([...described].sort()).toEqual([...ids].sort());
    expect(merge.tasks).toHaveLength(1);
    await waitFor("every task archived", () => ids.every((id) => getTask(n.db, id)?.state === "archived"));
  } finally {
    await close();
  }
}, 180_000);

/** Project `P` on the removed list, as `meddle project remove` leaves it. */
function remove(n: GitPoolNode, P: string): void {
  markRemoved(n.db, { id: P, name: getProject(n.db, P)!.name, removedAt: new Date().toISOString(), removedBy: n.id });
}

/** The ids of the `meddle.train` tasks live in node `n`'s Harness. */
async function liveTrainIds(n: GitPoolNode): Promise<number[]> {
  const { tasks } = await n.harness.harness.inspect(BACKGROUND_CONTEXT);
  return tasks.filter((t) => t.record.kind === "meddle.train").map((t) => t.record.id);
}

/** The state of the task `id` in node `n`'s Harness, live or settled. */
async function stateOf(n: GitPoolNode, id: number) {
  return (await n.harness.harness.getTask(id as never, BACKGROUND_CONTEXT))?.state;
}

test("forgetting a project's train aborts its round and keeps its row gone", async () => {
  const { nodes, close } = await poolNodes(1);
  const n = nodes[0]!;
  try {
    const P = n.project.id;
    const merge = fakeMerge(n, { stall: true });
    const t1 = await taskWithWork(n, P, "x.txt");
    const t2 = await taskWithWork(n, P, "y.txt");
    await acceptAll(n, P, [t1.id, t2.id]);
    await merge.reached;
    const [round] = await liveTrainIds(n);
    expect(round).toBeDefined();
    expect(n.db.query("SELECT project FROM trains WHERE project = ?").all(P)).not.toEqual([]);

    remove(n, P);
    await forgetTrain(n.harness.harness, n.db, P);
    // The Harness marks the abort and runs the task's abort handler after.
    await waitFor("the round aborted", async () => (await stateOf(n, round!))?.status === "terminal");
    expect(await stateOf(n, round!)).toMatchObject({ status: "terminal", outcome: { status: "aborted" } });
    expect(n.db.query("SELECT * FROM trains WHERE project = ?").all(P)).toEqual([]);

    // The round's would-be end, and the user's Pause, write nothing back.
    merge.release();
    await Bun.sleep(1_000);
    pauseTrain(n.db, P, "x");
    await Bun.sleep(500);
    expect(n.db.query("SELECT * FROM trains WHERE project = ?").all(P)).toEqual([]);
    expect(await liveTrainIds(n)).toEqual([]);
  } finally {
    await close();
  }
}, 180_000);

test("a removed project starts no new round", async () => {
  const { nodes, close } = await poolNodes(1);
  const n = nodes[0]!;
  try {
    const P = n.project.id;
    const before = await mainOf(n, P);
    const t = await taskWithWork(n, P, "x.txt");
    // Queued while the train is paused, so that no round starts; the pause is lifted behind the train's back.
    pauseTrain(n.db, P, "accepting");
    await n.runner.accept(t.id);
    expect(listLineRows(n.db, P).some((r) => r.task === t.id && r.queuedAt !== null)).toBe(true);
    n.db.query("UPDATE trains SET paused = NULL WHERE project = ?").run(P);
    remove(n, P);
    // Something kicks the train (a Resume, a line row change): no round starts for it.
    const started = new Set<number>();
    const watch = setInterval(() => void liveTrainIds(n).then((ids) => ids.forEach((id) => started.add(id))), 25);
    pauseTrain(n.db, P, null);
    await Bun.sleep(1_500);
    clearInterval(watch);
    expect([...started]).toEqual([]);
    // A round would have landed the queued task.
    expect(await mainOf(n, P)).toBe(before);
    expect(getTask(n.db, t.id)?.state).toBe("idle");
  } finally {
    await close();
  }
}, 180_000);
