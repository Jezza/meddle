// test/queue.test.ts — Accept queues a task on its project's train: its holder records `queuedAt` on the task's own line
// row. Input from the user that runs in the task afterwards (a prompt, a steer, Send now, Retry) takes it off the queue
// again; approvals, and the turn that was running when it was accepted ending, do not.
import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../src/config";
import { initColocated, jj } from "../src/jj";
import { listLineRows, setQueued, writeBranchRow } from "../src/pool/rows";
import { addProjectFromFolder, type Project } from "../src/projects/project";
import { TaskObject } from "../src/state/contracts";
import { listEvents } from "../src/store/events";
import { getTask, updateTask } from "../src/store/records";
import { pauseTrain } from "../src/train/train";
import { createTask } from "./helpers";
import { linkClient, poolNodes, type GitPoolNode } from "./pool-helpers";

/**
 * `poolNodes`, each node's train of its project paused: these tests queue tasks and drive their turns themselves, so no
 * round of the conductor's may take them.
 */
async function queueNodes(...args: Parameters<typeof poolNodes>): ReturnType<typeof poolNodes> {
  const made = await poolNodes(...args);
  for (const n of made.nodes) pauseTrain(n.db, n.project.id, "held by the test");
  return made;
}

type Queue = { queuedAt: string; project: string } | null;

/** Polls `get` until it returns `want`; fails with the last value after `ms` (20 s). */
async function until<T>(what: string, get: () => Promise<T> | T, want: T, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    const got = await get();
    if (JSON.stringify(got) === JSON.stringify(want)) return;
    if (Date.now() > end) throw new Error(`${what} is still ${JSON.stringify(got)}, not ${JSON.stringify(want)}`);
    await Bun.sleep(25);
  }
}

/** Sends `text` to the task on `node` and waits for the turn to end. */
async function promptAndWait(node: GitPoolNode, taskId: string, text: string): Promise<void> {
  const idle = new Promise<void>((res) => {
    let ran = false;
    const off = node.runner.onState((id, s) => {
      if (id !== taskId) return;
      if (s === "running") ran = true;
      else if (s === "idle" && ran) { off(); res(); }
    });
  });
  await node.runner.prompt(taskId, text);
  await idle;
}

/** When task `taskId`'s own line (of project `projectId`, named `a`) was queued, as `node`'s rows have it. */
const queuedAt = (node: GitPoolNode, projectId: string, taskId: string) =>
  listLineRows(node.db, projectId, taskId).find((r) => r.name === "a")?.queuedAt ?? null;

/** The writes of the queue of task `taskId` on `node` that `onQueue` tells of, as `queued` or the reason it left. */
function told(node: GitPoolNode, taskId: string): string[] {
  const out: string[] = [];
  node.runner.onQueue((id, queue, reason) => {
    if (id === taskId) out.push(queue === null ? `left: ${reason}` : `queued${reason === null ? "" : `: ${reason}`}`);
  });
  return out;
}

/** Gives the task work to land: a file in its workspace, written to the line's row. */
async function withWork(node: GitPoolNode, taskId: string, name = "a"): Promise<void> {
  await writeFile(join(paths(node.cfg).task(taskId), name, "work"), `${name}\n`);
  await node.runner.writeTaskLines(taskId);
}

/** A second folder project `name` homed on `node`, its `main` one commit. */
async function secondProject(node: GitPoolNode, name: string): Promise<Project> {
  const folder = `${node.home}/${name}`;
  await mkdir(folder, { recursive: true });
  await initColocated(folder, node.cfg);
  await writeFile(`${folder}/${name}`, `${name}\n`);
  await jj(["commit", "-m", name], folder, node.cfg);
  await jj(["bookmark", "set", "main", "-r", "@-"], folder, node.cfg);
  return addProjectFromFolder(node.cfg, node.db, folder, node.id, name);
}

/** A node whose turns take `ms` to end, so that a task stays running, and one task of its project `a`. */
async function slowNode(ms = 4000) {
  const { nodes, close } = await queueNodes(1, { nodes: [{ extraEnv: { MEDDLE_FIXTURE_RESULTS_MS: String(ms) } }] });
  const A = nodes[0]!;
  const m = await createTask(A, { title: "t", projectIds: [A.project.id] });
  return { A, m, close };
}

/** Waits until the task's turn has its Claude Code process, which is what a steer goes into. */
const live = (node: GitPoolNode, taskId: string) => until("the live turn", () => node.runner.liveQuery(taskId) !== null, true);

test("accept queues an idle task with work: its own line row says when", async () => {
  const { nodes, close } = await queueNodes(1);
  const A = nodes[0]!;
  try {
    const P = A.project;
    const m = await createTask(A, { title: "t", projectIds: [P.id] });
    await withWork(A, m.id);
    const events = told(A, m.id);
    expect(A.runner.queue(m.id)).toBeNull();

    const before = new Date().toISOString();
    await A.runner.accept(m.id);

    const at = queuedAt(A, P.id, m.id);
    expect(typeof at).toBe("string");
    expect(at! >= before && at! <= new Date().toISOString()).toBe(true);
    expect(A.runner.queue(m.id)).toEqual({ queuedAt: at!, project: P.id });
    expect(events).toEqual(["queued"]);
    // It is still this node's line, at the same commit.
    expect(listLineRows(A.db, P.id, m.id)[0]).toMatchObject({ holder: A.id, archived: false });
    expect(getTask(A.db, m.id)?.state).toBe("idle");
  } finally {
    await close();
  }
}, 60_000);

test("accept is idempotent: a second call changes nothing", async () => {
  const { nodes, close } = await queueNodes(1);
  const A = nodes[0]!;
  try {
    const P = A.project;
    const m = await createTask(A, { title: "t", projectIds: [P.id] });
    await withWork(A, m.id);
    const events = told(A, m.id);
    await A.runner.accept(m.id);
    const first = listLineRows(A.db, P.id, m.id)[0]!;
    await Bun.sleep(20);

    await A.runner.accept(m.id);

    expect(listLineRows(A.db, P.id, m.id)[0]).toEqual(first);
    expect(events).toEqual(["queued"]);
    // And so is unqueue: a task not queued stays as it is.
    await A.runner.unqueue(m.id, "you unqueued it");
    const left = listLineRows(A.db, P.id, m.id)[0]!;
    await A.runner.unqueue(m.id, "you unqueued it");
    expect(left.queuedAt).toBeNull();
    expect(listLineRows(A.db, P.id, m.id)[0]).toEqual(left);
    expect(events).toEqual(["queued", "left: you unqueued it"]);
  } finally {
    await close();
  }
}, 60_000);

test("accept refuses a task with nothing to land", async () => {
  const { nodes, close } = await queueNodes(1);
  const A = nodes[0]!;
  try {
    const P = A.project;
    // A new task's line is main: no work of its own.
    const m = await createTask(A, { title: "t", projectIds: [P.id] });
    await expect(A.runner.accept(m.id)).rejects.toThrow("nothing to land: the task's work is already on main");
    // An empty change above main is no work either.
    await A.runner.writeTaskLines(m.id);
    await expect(A.runner.accept(m.id)).rejects.toThrow("nothing to land: the task's work is already on main");
    expect(queuedAt(A, P.id, m.id)).toBeNull();
  } finally {
    await close();
  }
}, 60_000);

test("accept refuses a running task whose work main already has", async () => {
  const { A, m, close } = await slowNode();
  try {
    const P = A.project;
    await withWork(A, m.id);
    await A.runner.prompt(m.id, "Reply with the single word ok.");
    await live(A, m.id);
    const head = listLineRows(A.db, P.id, m.id)[0]!.commit!;
    // You pushed main onto the task's line: its work is main's.
    writeBranchRow(A.db, A.id, { project: P.id, branch: "main", commit: head, drops: [] });
    await expect(A.runner.accept(m.id)).rejects.toThrow("nothing to land: the task's work is already on main");
    expect(queuedAt(A, P.id, m.id)).toBeNull();
  } finally {
    await close();
  }
}, 60_000);

test("accept refuses while prompts wait: queued for a later turn, or steered into the running turn", async () => {
  const { A, m, close } = await slowNode();
  try {
    const P = A.project;
    await withWork(A, m.id);
    updateTask(A.db, m.id, { queued: JSON.stringify([{ text: "later", attachments: [] }]) });
    await expect(A.runner.accept(m.id)).rejects.toThrow("send or clear the waiting prompts first");
    expect(await A.runner.takeBackQueued(m.id)).toEqual([{ text: "later", attachments: [] }]);

    await A.runner.prompt(m.id, "Reply with the single word ok.");
    await live(A, m.id);
    expect(await A.runner.prompt(m.id, "and more")).toBe("queued");
    await expect(A.runner.accept(m.id)).rejects.toThrow("send or clear the waiting prompts first");
    expect(queuedAt(A, P.id, m.id)).toBeNull();
    // Cleared, it can be accepted.
    await A.runner.takeBackQueued(m.id);
    await A.runner.accept(m.id);
    expect(queuedAt(A, P.id, m.id)).not.toBeNull();
  } finally {
    await close();
  }
}, 60_000);

test("accept refuses two projects, a merge task, and a task that is archived", async () => {
  const { nodes, close } = await queueNodes(1);
  const A = nodes[0]!;
  try {
    const a = A.project;
    const b = await secondProject(A, "b");
    const two = await createTask(A, { title: "two", projectIds: [a.id, b.id] });
    await withWork(A, two.id, "a");
    await withWork(A, two.id, "b");
    await expect(A.runner.accept(two.id)).rejects.toThrow("accept handles one project for now; push to land the rest");
    expect(queuedAt(A, a.id, two.id)).toBeNull();

    const merge = await createTask(A, { title: "merge", projectIds: [a.id] });
    await withWork(A, merge.id);
    const row = getTask(A.db, merge.id)!;
    updateTask(A.db, merge.id, { manifest: JSON.stringify({ ...JSON.parse(row.manifest), merge: { project: a.id, batch: [two.id] } }) });
    await expect(A.runner.accept(merge.id)).rejects.toThrow("a merge task lands with its train");
    expect(queuedAt(A, a.id, merge.id)).toBeNull();

    const gone = await createTask(A, { title: "gone", projectIds: [a.id] });
    await withWork(A, gone.id);
    await A.runner.archive(gone.id);
    await expect(A.runner.accept(gone.id)).rejects.toThrow(`task is archived: ${gone.id}`);
    await expect(A.runner.unqueue(gone.id, "you unqueued it")).rejects.toThrow(`task is archived: ${gone.id}`);
  } finally {
    await close();
  }
}, 60_000);

test("a prompt after accept unqueues the task once its turn has started", async () => {
  const { nodes, close } = await queueNodes(1);
  const A = nodes[0]!;
  try {
    const P = A.project;
    const m = await createTask(A, { title: "t", projectIds: [P.id] });
    await withWork(A, m.id);
    await A.runner.accept(m.id);
    const events = told(A, m.id);
    expect(queuedAt(A, P.id, m.id)).not.toBeNull();

    await promptAndWait(A, m.id, "Reply with the single word ok.");

    expect(queuedAt(A, P.id, m.id)).toBeNull();
    expect(A.runner.queue(m.id)).toBeNull();
    expect(events).toEqual(["left: you sent it a prompt"]);
    // It can be accepted again, as it is now.
    await A.runner.accept(m.id);
    expect(queuedAt(A, P.id, m.id)).not.toBeNull();
  } finally {
    await close();
  }
}, 60_000);

test("a queued prompt unqueues the task as its turn starts, not before", async () => {
  const { nodes, close } = await queueNodes(1);
  const A = nodes[0]!;
  try {
    const P = A.project;
    const m = await createTask(A, { title: "t", projectIds: [P.id] });
    await withWork(A, m.id);
    await A.runner.accept(m.id);
    const events = told(A, m.id);
    // A prompt that waited (a restart, a hold) and now starts.
    updateTask(A.db, m.id, { queued: JSON.stringify([{ text: "Reply with the single word ok.", attachments: [] }]) });
    expect(queuedAt(A, P.id, m.id)).not.toBeNull();

    await A.runner.startQueued(m.id);

    expect(queuedAt(A, P.id, m.id)).toBeNull();
    expect(events).toEqual(["left: you sent it a prompt"]);
    await until("the task's state", () => A.runner.state(m.id), "idle");
  } finally {
    await close();
  }
}, 60_000);

test("a steer into the running turn after accept unqueues the task", async () => {
  const { A, m, close } = await slowNode();
  try {
    const P = A.project;
    await withWork(A, m.id);
    await A.runner.prompt(m.id, "Reply with the single word ok.");
    await live(A, m.id);
    await A.runner.accept(m.id);
    expect(queuedAt(A, P.id, m.id)).not.toBeNull();
    const events = told(A, m.id);

    expect(await A.runner.prompt(m.id, "Also say why.")).toBe("queued");

    expect(queuedAt(A, P.id, m.id)).toBeNull();
    expect(events).toEqual(["left: you sent it a prompt"]);
  } finally {
    await close();
  }
}, 60_000);

test("Send now unqueues a task whose steer it delivers, and does nothing without one", async () => {
  const { nodes, close } = await queueNodes(1, { nodes: [{ extraEnv: { MEDDLE_FIXTURE_STALL: "1" } }] });
  const A = nodes[0]!;
  try {
    const P = A.project;
    const idle = await createTask(A, { title: "idle", projectIds: [P.id] });
    await withWork(A, idle.id);
    await A.runner.accept(idle.id);
    // Nothing runs, so nothing waits: Send now delivers nothing, and the task stays queued.
    expect(await A.runner.sendNow(idle.id)).toBe("nothing_waiting");
    expect(queuedAt(A, P.id, idle.id)).not.toBeNull();

    const m = await createTask(A, { title: "t", projectIds: [P.id] });
    await withWork(A, m.id);
    await A.runner.prompt(m.id, "Reply with the single word ok.");
    await until("its first reply", () => listEvents(A.db, m.id).some((e) => (e.message as { type?: string }).type === "assistant"), true);
    // The steer takes it off the queue as it is sent; queued again, Send now takes it off for the steer it delivers.
    await A.runner.prompt(m.id, "Stop that, and say why instead.");
    expect(queuedAt(A, P.id, m.id)).toBeNull();
    setQueued(A.db, P.id, m.id, "a", new Date().toISOString());
    const events = told(A, m.id);
    expect(await A.runner.sendNow(m.id)).toBe("stopped");
    expect(queuedAt(A, P.id, m.id)).toBeNull();
    expect(events).toEqual(["left: you sent it a prompt"]);
  } finally {
    await close();
  }
}, 60_000);

test("Retry unqueues an accepted task whose turn it runs again", async () => {
  const { nodes, close } = await queueNodes(1);
  const A = nodes[0]!;
  try {
    const P = A.project;
    const m = await createTask(A, { title: "t", projectIds: [P.id] });
    await withWork(A, m.id);
    await promptAndWait(A, m.id, "Reply with the single word ok.");
    await A.runner.accept(m.id);
    const events = told(A, m.id);

    await A.runner.retry(m.id);

    expect(queuedAt(A, P.id, m.id)).toBeNull();
    expect(events).toEqual(["left: you sent it a prompt"]);
    await until("the task's state", () => A.runner.state(m.id), "idle");
  } finally {
    await close();
  }
}, 60_000);

test("approving doesn't unqueue", async () => {
  const { nodes, close } = await queueNodes(1, { nodes: [{ fixture: "approval.jsonl" }] });
  const A = nodes[0]!;
  try {
    const P = A.project;
    const m = await createTask(A, { title: "t", projectIds: [P.id] });
    await withWork(A, m.id);
    await A.runner.prompt(m.id, "Run: echo hi");
    await until("the approval", () => A.runner.approvals.pending(m.id).length, 1);
    // Accepted while the turn waits for the user.
    await A.runner.accept(m.id);
    const events = told(A, m.id);
    expect(A.runner.state(m.id)).toBe("waiting");

    const [req] = A.runner.approvals.pending(m.id);
    A.runner.approvals.answer(req!.requestId, { behavior: "allow", updatedInput: req!.input });
    await until("the task's state", () => A.runner.state(m.id), "idle");

    expect(queuedAt(A, P.id, m.id)).not.toBeNull();
    expect(events).toEqual([]);
  } finally {
    await close();
  }
}, 60_000);

test("archiving unqueues, and so does deleting what an archive left queued", async () => {
  const { nodes, close } = await queueNodes(1);
  const A = nodes[0]!;
  try {
    const P = A.project;
    const m = await createTask(A, { title: "t", projectIds: [P.id] });
    await withWork(A, m.id);
    await A.runner.accept(m.id);
    const events = told(A, m.id);

    await A.runner.archive(m.id);

    expect(getTask(A.db, m.id)?.state).toBe("archived");
    expect(queuedAt(A, P.id, m.id)).toBeNull();
    expect(events).toEqual(["left: archived"]);

    // A queue an older archive left behind goes with the task's lines.
    setQueued(A.db, P.id, m.id, "a", new Date().toISOString());
    expect(queuedAt(A, P.id, m.id)).not.toBeNull();
    await A.runner.deleteTask(m.id);
    expect(listLineRows(A.db, P.id, m.id).map((r) => `${r.name} ${r.commit} ${r.queuedAt}`)).toEqual(["a null null"]);
    expect(events).toEqual(["left: archived", "left: archived"]);
  } finally {
    await close();
  }
}, 60_000);

test("accepting a running task keeps it queued until its turn ends, and after", async () => {
  const { A, m, close } = await slowNode(1500);
  try {
    const P = A.project;
    await withWork(A, m.id);
    await A.runner.prompt(m.id, "Reply with the single word ok.");
    await until("the task's state", () => A.runner.state(m.id), "running");
    const events = told(A, m.id);

    await A.runner.accept(m.id);
    expect(A.runner.state(m.id)).toBe("running");
    const at = queuedAt(A, P.id, m.id);
    expect(at).not.toBeNull();

    await until("the task's state", () => A.runner.state(m.id), "idle");
    // The turn's end wrote the line again; the queue is as it was.
    await Bun.sleep(300);
    expect(queuedAt(A, P.id, m.id)).toBe(at);
    expect(A.runner.queue(m.id)).toEqual({ queuedAt: at!, project: P.id });
    expect(events).toEqual(["queued"]);
  } finally {
    await close();
  }
}, 60_000);

test("the task serves its queue, and Accept and Unqueue, to a client", async () => {
  const { nodes, close } = await queueNodes(1);
  const A = nodes[0]!;
  const owner = linkClient(A.host);
  try {
    const P = A.project;
    const m = await createTask(A, { title: "t", projectIds: [P.id] });
    const task = await owner.client.get(TaskObject, { id: m.id });
    try {
      expect(task.queue.value).toBeNull();
      await expect(task.accept({})).rejects.toThrow("nothing to land");
      await withWork(A, m.id);

      await task.accept({});
      await until("the task's queue", () => task.queue.value, { queuedAt: queuedAt(A, P.id, m.id)!, project: P.id } as Queue);

      await task.unqueue({});
      await until("the task's queue", () => task.queue.value, null as Queue);
      expect(queuedAt(A, P.id, m.id)).toBeNull();

      await task.accept({});
      await until("the task's queue", () => task.queue.value !== null, true);
      await promptAndWait(A, m.id, "Reply with the single word ok.");
      await until("the task's queue", () => task.queue.value, null as Queue);
    } finally {
      task.release();
    }
  } finally {
    await owner.close();
    await close();
  }
}, 60_000);
