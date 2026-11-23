// test/removal.test.ts — `meddle project remove` on the nodes: the removal action's refusals, the cleanup each node runs
// once the project is on its removed list (its tasks stopped and archived, its train, row, repos and rows gone), and the
// sweep at start that finishes a cleanup a restart or a pool update's hold cut short. The helpers do not run `serve`, so
// each test starts `watchRemoved` on its nodes itself.
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { hostname } from "node:os";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry } from "@earendil-works/pi-durable";
import { paths } from "../src/config";
import { shortId } from "../src/pool/ids";
import { isRemoved, listRemoved, markRemoved, mergeRemoved } from "../src/pool/removed";
import { listLineRows } from "../src/pool/rows";
import { getProject } from "../src/projects/project";
import { cleanupRemoved, removeProject, sweepRemoved, watchRemoved, type RemovalDeps } from "../src/projects/removal";
import { createNodeHost } from "../src/state/host";
import { listEvents } from "../src/store/events";
import { getTask, queuedOf } from "../src/store/records";
import { TaskRunner } from "../src/tasks/durable";
import { openHarness } from "../src/tasks/harness";
import { pauseTrain } from "../src/train/train";
import { claudeCodeVersion } from "../src/version";
import { createTask, replay } from "./helpers";
import { peerReady, poolNodes, startPoolNode, twoPoolNodes, type GitPoolNode } from "./pool-helpers";

async function waitFor(what: string, cond: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

/** What a removal of node `n` runs with, its log lines going to `n.logs`. */
function removal(n: GitPoolNode): RemovalDeps {
  return { cfg: n.cfg, db: n.db, pool: n.pool, runner: n.runner, log: (line) => n.logs.push(line) };
}

/** What node `n` holds of project `P`. */
function leftOf(n: GitPoolNode, P: string) {
  const count = (table: string) => (n.db.query(`SELECT COUNT(*) AS n FROM ${table} WHERE project = ?`).get(P) as { n: number }).n;
  return {
    row: getProject(n.db, P) !== null,
    replica: existsSync(paths(n.cfg).replica(P)),
    memory: existsSync(paths(n.cfg).memory(P)),
    lines: count("line_rows"),
    branches: count("branch_rows"),
    waiting: count("branch_rows_waiting"),
    trains: count("trains"),
  };
}

const NOTHING = { row: false, replica: false, memory: false, lines: 0, branches: 0, waiting: 0, trains: 0 };

/** Sends task `taskId` on `n` a prompt the stand-in (`MEDDLE_FIXTURE_STALL`) stalls on, and waits for its init. */
async function stall(n: GitPoolNode, taskId: string): Promise<void> {
  const initialised = new Promise<void>((res) => {
    const off = n.runner.onEvent((id, _seq, msg) => {
      if (id === taskId && msg.type === "system" && (msg as { subtype?: string }).subtype === "init") { off(); res(); }
    });
  });
  await n.runner.prompt(taskId, "Stall.");
  await initialised;
}

/** Sends `text` to task `taskId` on `n` and waits for the turn to end. */
async function promptAndWait(n: GitPoolNode, taskId: string, text: string): Promise<void> {
  const idle = new Promise<void>((res) => {
    let ran = false;
    const off = n.runner.onState((id, s) => {
      if (id !== taskId) return;
      if (s === "running") ran = true;
      else if (s === "idle" && ran) { off(); res(); }
    });
  });
  await n.runner.prompt(taskId, text);
  await idle;
}

/** The `meddle.turn` records of task `taskId` that `n`'s Harness lists (not those it has finished). */
async function turnsOf(n: GitPoolNode, taskId: string) {
  const { tasks } = await n.harness.harness.inspect(BACKGROUND_CONTEXT);
  return tasks.filter((t) => t.record.kind === "meddle.turn" && (t.record.input as { taskId: string }).taskId === taskId).map((t) => t.record);
}

/** The state of record `id` in `n`'s Harness. */
async function stateOf(n: GitPoolNode, id: number) {
  return (await n.harness.harness.getTask(id as never, BACKGROUND_CONTEXT))?.state;
}

/** The cleanup failures `n` logged. */
const cleanupFailures = (n: GitPoolNode) => n.logs.filter((l) => l.includes(": cleanup: "));

/**
 * Restarts node `n`'s durable side, as a process restart would (see `train.test.ts`): its Harness, its runner (whose
 * stand-in still stalls) and its chord host go, and new ones open on the same database and pool; the Harness reruns
 * the turns it holds as it opens. With `held`, the node starts as on a build a pool update holds (`serve`): the Harness
 * paused, and the runner holding turns, work and hosting. `n` is updated in place.
 */
async function restart(n: GitPoolNode, options: { held?: boolean } = {}): Promise<void> {
  await n.harness.close();
  await n.host.close();
  n.runner.close();
  const harness = await openHarness(n.cfg, createRegistry(), { hold: options.held === true });
  const runner = new TaskRunner(n.cfg, n.db, harness.harness, {
    claudePath: replay, claudeRuntime: "bun",
    extraEnv: { MEDDLE_FIXTURE: `${import.meta.dir}/fixtures/hello.jsonl`, MEDDLE_FIXTURE_STALL: "1" },
    pool: n.pool, log: (line) => n.logs.push(line), hooks: n.hooks,
  });
  if (options.held === true) runner.setHolds({ turns: "update in progress", work: "update in progress", hosting: "update in progress" });
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

test("removing a project clears it from every node", async () => {
  const { A, B, close } = await twoPoolNodes();
  const stops: Array<() => void> = [];
  try {
    await peerReady(A, B);
    await peerReady(B, A);
    const P = A.project.id;
    await waitFor("A's project in B's roster", () => B.store.row(A.id)?.summary?.projects?.some((p) => p.id === P) === true);
    // An archived task of A's project on B: B holds the project's service repo, and A the task's lines.
    const m = await createTask(B, { title: "t", projectIds: [P] });
    await promptAndWait(B, m.id, "Hello");
    const logged = listEvents(B.db, m.id).length;
    expect(logged).toBeGreaterThan(0);
    await B.runner.archive(m.id);
    await waitFor("A to hold the task's lines archived", () => {
      const rows = listLineRows(A.db, P).filter((r) => r.task === m.id);
      return rows.length > 0 && rows.every((r) => r.archived);
    });
    pauseTrain(A.db, P, "a trains row");
    for (const n of [A, B]) expect(leftOf(n, P)).toMatchObject({ row: true, replica: true, memory: true, lines: 1, branches: 1 });
    expect(leftOf(A, P).trains).toBe(1);
    stops.push(watchRemoved(removal(A)), watchRemoved(removal(B)));
    await waitFor("each node to hold the other's removed list", () => A.pool.removedSupport(B.id) === "held" && B.pool.removedSupport(A.id) === "held");

    const entry = await removeProject(removal(A), P);
    expect(entry).toMatchObject({ id: P, name: A.project.name, removedBy: A.id });
    expect(leftOf(A, P)).toEqual(NOTHING);
    await waitFor("B to clear the project", () => JSON.stringify(leftOf(B, P)) === JSON.stringify(NOTHING));
    expect(listRemoved(B.db)).toEqual([entry]);
    // The archived task stays as it was, and cannot be restored.
    expect(getTask(B.db, m.id)?.state).toBe("archived");
    expect(listEvents(B.db, m.id).length).toBe(logged);
    await expect(B.runner.restore(m.id, null)).rejects.toThrow(`project ${A.project.name} was removed`);
    for (const n of [A, B]) expect(cleanupFailures(n)).toEqual([]);
  } finally {
    for (const stop of stops) stop();
    await close();
  }
}, 120_000);

test("a live task blocks removal", async () => {
  const { A, B, close } = await twoPoolNodes();
  try {
    await peerReady(A, B);
    await peerReady(B, A);
    const P = A.project.id;
    await waitFor("A's project in B's roster", () => B.store.row(A.id)?.summary?.projects?.some((p) => p.id === P) === true);
    await waitFor("each node to hold the other's removed list", () => A.pool.removedSupport(B.id) === "held" && B.pool.removedSupport(A.id) === "held");
    const m = await createTask(B, { title: "t", projectIds: [P] });
    await waitFor("A to hold the task's lines", () => listLineRows(A.db, P).some((r) => r.task === m.id));
    await expect(removeProject(removal(A), P)).rejects.toThrow(`project ${A.project.name} is used by ${m.id}`);
    // A member that does not hold the removed list (an older meddle, or one not answered yet) refuses it first.
    const older: RemovalDeps = { ...removal(A), pool: { ...A.pool, removedSupport: () => "older" } };
    await expect(removeProject(older, P)).rejects.toThrow(`${shortId(B.id)} (${hostname()}) runs an older meddle`);
    const pending: RemovalDeps = { ...removal(A), pool: { ...A.pool, removedSupport: () => "pending" } };
    await expect(removeProject(pending, P)).rejects.toThrow(`${shortId(B.id)} (${hostname()}) runs an older meddle`);
    expect(isRemoved(A.db, P)).toBe(false);
    expect(leftOf(A, P)).toMatchObject({ row: true, replica: true });
  } finally {
    await close();
  }
}, 120_000);

test("removing twice answers the same", async () => {
  const { nodes, close } = await poolNodes(1);
  const A = nodes[0]!;
  const stop = watchRemoved(removal(A));
  try {
    const P = A.project.id;
    await expect(removeProject(removal(A), "0123456789ab")).rejects.toThrow("unknown project: 0123456789ab");
    const first = await removeProject(removal(A), P);
    expect(first).toEqual({ id: P, name: A.project.name, removedAt: expect.any(String), removedBy: A.id });
    expect(leftOf(A, P)).toEqual(NOTHING);
    // No row any more, nor a summary listing it: the entry answers all the same, and nothing is added.
    expect(await removeProject(removal(A), P)).toEqual(first);
    expect(listRemoved(A.db)).toEqual([first]);
    expect(cleanupFailures(A)).toEqual([]);
  } finally {
    stop();
    await close();
  }
}, 60_000);

test("a node receiving a removal force-archives its busy task", async () => {
  const { A, B, close } = await twoPoolNodes({ nodes: [{}, { extraEnv: { MEDDLE_FIXTURE_STALL: "1" } }] });
  const stops: Array<() => void> = [];
  try {
    const P = B.project.id;
    const m = await createTask(B, { title: "t", projectIds: [P] });
    await stall(B, m.id);
    expect(await B.runner.prompt(m.id, "later")).toBe("queued");
    const logged = listEvents(B.db, m.id).length;
    stops.push(watchRemoved(removal(A)), watchRemoved(removal(B)));
    // As sync merges an entry a node offline at the time hears of on its return: no refusal for the task it runs.
    mergeRemoved(B.db, [{ id: P, name: B.project.name, removedAt: new Date().toISOString(), removedBy: A.id }]);
    await waitFor("B to archive the task", () => getTask(B.db, m.id)?.state === "archived");
    await waitFor("B to clear the project", () => JSON.stringify(leftOf(B, P)) === JSON.stringify(NOTHING));
    expect(queuedOf(getTask(B.db, m.id)!)).toEqual([]);
    expect(B.runner.queued(m.id)).toEqual([]);
    expect(listEvents(B.db, m.id).length).toBeGreaterThanOrEqual(logged);
    expect(await turnsOf(B, m.id)).toEqual([]);
    // A keeps its own project.
    expect(leftOf(A, A.project.id)).toMatchObject({ row: true, replica: true });
    for (const n of [A, B]) expect(cleanupFailures(n)).toEqual([]);
  } finally {
    for (const stop of stops) stop();
    await close();
  }
}, 120_000);

test("a restart finishes an interrupted cleanup", async () => {
  const { nodes, close } = await poolNodes(1, { nodes: [{ extraEnv: { MEDDLE_FIXTURE_STALL: "1" } }] });
  const A = nodes[0]!;
  try {
    const P = A.project.id;
    const m = await createTask(A, { title: "t", projectIds: [P] });
    await stall(A, m.id);
    // The entry written, and the node gone before its cleanup ran.
    markRemoved(A.db, { id: P, name: A.project.name, removedAt: new Date().toISOString(), removedBy: A.id });
    const [turn] = await turnsOf(A, m.id);
    await restart(A);
    await waitFor("the Harness to rerun the turn", async () => (await stateOf(A, turn!.id))?.status === "running");
    await sweepRemoved(removal(A));
    expect(leftOf(A, P)).toEqual(NOTHING);
    expect(getTask(A.db, m.id)?.state).toBe("archived");
    expect(await stateOf(A, turn!.id)).toMatchObject({ status: "terminal", outcome: { status: "aborted" } });
    expect(await turnsOf(A, m.id)).toEqual([]);
    expect(cleanupFailures(A)).toEqual([]);
  } finally {
    await close();
  }
}, 60_000);

test("a held boot defers cleanup until the hold lifts", async () => {
  const { nodes, close } = await poolNodes(1, { nodes: [{ extraEnv: { MEDDLE_FIXTURE_STALL: "1" } }] });
  const A = nodes[0]!;
  let stop = () => {};
  try {
    const P = A.project.id;
    const m = await createTask(A, { title: "t", projectIds: [P] });
    await stall(A, m.id);
    const [turn] = await turnsOf(A, m.id);
    markRemoved(A.db, { id: P, name: A.project.name, removedAt: new Date().toISOString(), removedBy: A.id });
    // The node starts on a held build: its Harness reruns nothing, and the turn's abort is only marked.
    await restart(A, { held: true });
    stop = watchRemoved(removal(A));
    await sweepRemoved(removal(A));
    expect(leftOf(A, P)).toMatchObject({ row: true, replica: true });
    expect(getTask(A.db, m.id)?.state).not.toBe("archived");
    expect((await stateOf(A, turn!.id))?.status).not.toBe("terminal");
    // The updater lifts the hold as `serve` has it do: the holds, then the Harness.
    A.runner.setHolds({ turns: null, work: null, hosting: null });
    A.runner.resumeHarness();
    await waitFor("the project gone once the hold lifts", () => JSON.stringify(leftOf(A, P)) === JSON.stringify(NOTHING));
    expect(getTask(A.db, m.id)?.state).toBe("archived");
    expect(await stateOf(A, turn!.id)).toMatchObject({ status: "terminal", outcome: { status: "aborted" } });
    expect(cleanupFailures(A)).toEqual([]);
  } finally {
    stop();
    await close();
  }
}, 60_000);

test("a removal on another node in the process does nothing here", async () => {
  const A = await startPoolNode();
  const B = await startPoolNode();
  const stops = [watchRemoved(removal(A)), watchRemoved(removal(B))];
  try {
    // A and B are not linked: only A's list has B's project.
    markRemoved(A.db, { id: B.project.id, name: B.project.name, removedAt: new Date().toISOString(), removedBy: A.id });
    await cleanupRemoved(removal(B), B.project.id);
    await Bun.sleep(300);
    expect(isRemoved(B.db, B.project.id)).toBe(false);
    expect(leftOf(B, B.project.id)).toMatchObject({ row: true, replica: true });
    for (const n of [A, B]) expect(cleanupFailures(n)).toEqual([]);
  } finally {
    for (const stop of stops) stop();
    for (const n of [A, B]) {
      await n.close();
      n.db.close();
      await rm(n.home, { recursive: true, force: true });
    }
  }
}, 60_000);
