// test/move.test.ts — moving a task between nodes: the receiving side.
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../src/config";
import { bookmarkList, jj } from "../src/jj";
import { shortId } from "../src/pool/identity";
import { NodeObject, PeerObject } from "../src/state/contracts";
import { listEvents } from "../src/store/events";
import { getTask } from "../src/store/records";
import { readManifest, transcriptPath, type TaskManifest } from "../src/tasks/manifest";
import { exportTask, receiptsMatch, type Receipt } from "../src/tasks/transfer";
import { claudeCodeVersion } from "../src/version";
import { setupNode } from "./helpers";
import { linkClient, peerReady, poolNodes, twoPoolNodes, type GitPoolNode } from "./pool-helpers";

/** A task on `node`'s own project after one replayed turn. */
async function turnedTask(node: GitPoolNode): Promise<TaskManifest> {
  const m = await node.runner.create({ title: "t", projectIds: [node.project.id] });
  await promptAndWait(node, m.id, "Reply with the single word ok.");
  return m;
}

/** Sends `text` to the task on `node` and waits for the turn to end. */
async function promptAndWait(node: GitPoolNode, taskId: string, text: string): Promise<void> {
  const idle = idleOn(node, taskId);
  await node.runner.prompt(taskId, text);
  await idle;
}

/** Resolves when the task's next turn has run and the task is idle again. */
function idleOn(node: GitPoolNode, taskId: string): Promise<void> {
  return new Promise<void>((res) => {
    let ran = false;
    const off = node.runner.onState((id, s) => {
      if (id !== taskId) return;
      if (s === "running") ran = true;
      else if (s === "idle" && ran) { off(); res(); }
    });
  });
}

/** `from`'s PeerObject on `to`. */
async function peerOn(from: GitPoolNode, to: GitPoolNode) {
  await peerReady(from, to);
  const ref = await from.pool.peerRef(to.id, PeerObject);
  if (ref.variant !== "peer") throw new Error(`variant ${ref.variant}`);
  return ref;
}

/** Sends task `taskId` from `from` to `to` over a blob stream; the sender's receipt and the one `to` answered. */
async function sendTask(from: GitPoolNode, to: GitPoolNode, taskId: string): Promise<{ sent: Receipt | null; got: Receipt | null }> {
  const s = await from.net.openStream(to.id, { stream: "blob", kind: "task", taskId });
  // A refused stream may fail the export's writes.
  const sent = await exportTask(from.cfg, from.db, taskId, s.stream.send).catch(() => null);
  const line = await s.reader.readLine().catch(() => null);
  return { sent, got: line === null ? null : (JSON.parse(line) as Receipt) };
}

async function changeAt(node: GitPoolNode, dir: string, rev: string): Promise<string> {
  return (await jj(["log", "-r", rev, "--no-graph", "-T", "change_id"], dir, node.cfg)).trim();
}

/** The change the local task bookmark of project `a` points at on `node`, or undefined. */
async function taskBookmark(node: GitPoolNode, replica: string, taskId: string): Promise<string | undefined> {
  return (await bookmarkList(replica, node.cfg)).find((b) => b.name === `meddle/task/${taskId}/a` && b.remote === null)?.changeId;
}

test("a task is received, imported, activated and resumed", async () => {
  const { A, B, close } = await twoPoolNodes();
  try {
    const m = await turnedTask(A);
    const atA = await taskBookmark(A, A.project.replica, m.id);
    expect(atA).toBeDefined();
    const ref = await peerOn(A, B);
    try {
      expect(await ref.receiveTask({ manifest: await readManifest(A.cfg, m.id), claudeCodeVersion: claudeCodeVersion() })).toEqual({ ok: true });

      const row = getTask(B.db, m.id)!;
      expect(row.state).toBe("receiving");
      expect(row.receiving_from).toBe(A.id);
      const replicaB = paths(B.cfg).replica(A.project.id);
      const manifestB = await readManifest(B.cfg, m.id);
      expect(manifestB).toEqual({
        ...m,
        projects: [{ ...m.projects[0]!, replica: replicaB, parent: atA! }],
      });
      // The workspace starts on A's change; B's own task bookmark points at it.
      const workspace = join(paths(B.cfg).task(m.id), "a");
      expect(await changeAt(B, workspace, "@-")).toBe(atA!);
      expect(await taskBookmark(B, replicaB, m.id)).toBe(atA!);
      expect(B.runner.state(m.id)).toBe("receiving");
      await expect(B.runner.prompt(m.id, "hi")).rejects.toThrow("task is being received");
      await expect(B.runner.setEffort(m.id, "high")).rejects.toThrow("task is being received");
      await expect(B.runner.interrupt(m.id)).rejects.toThrow("task is being received");

      const { sent, got } = await sendTask(A, B, m.id);
      expect(got).not.toBeNull();
      expect(receiptsMatch(sent!, got!)).toBe(true);
      expect(getTask(B.db, m.id)!.turns).toBe(1);
      expect(existsSync(transcriptPath(B.cfg, manifestB))).toBe(true);

      expect(await ref.activateTask({ taskId: m.id, followUp: null })).toEqual({ ok: true });
      expect(B.runner.state(m.id)).toBe("idle");
      expect(getTask(B.db, m.id)!.receiving_from).toBeNull();
      // A rerun of the source's commit step.
      expect(await ref.activateTask({ taskId: m.id, followUp: null })).toEqual({ ok: true });

      await promptAndWait(B, m.id, "Carry on.");
      const started = listEvents(B.db, m.id).filter((e) => (e.message as { subtype?: string }).subtype === "turn_started");
      expect(started.map((e) => (e.message as { resume: boolean }).resume)).toEqual([false, true]);
      // The replayer appended its prompt to the session it was told to resume: A's line and B's.
      expect((await readFile(transcriptPath(B.cfg, manifestB), "utf8")).trim().split("\n")).toHaveLength(2);
      expect(getTask(B.db, m.id)!.turns).toBe(2);
    } finally {
      ref.release();
    }
  } finally {
    await close();
  }
}, 15_000);

/** What a turn's events come to: `start`, `user:<text>` for a prompt, `result`. */
function turnMarks(events: Array<{ message: unknown }>): string[] {
  return events.flatMap(({ message }) => {
    const e = message as { type?: string; subtype?: string; message?: { content?: unknown } };
    if (e.subtype === "turn_started") return ["start"];
    if (e.type === "result") return ["result"];
    if (e.type === "user" && typeof e.message?.content === "string") return [`user:${e.message.content}`];
    return [];
  });
}

/** Records `queued` at each `running` of the task and resolves once `turns` turns have run and it is idle again. */
function watchTurns(node: GitPoolNode | Awaited<ReturnType<typeof setupNode>>, taskId: string, turns: number) {
  const queuedAtStart: string[][] = [];
  const done = new Promise<void>((res) => {
    let runs = 0;
    const off = node.runner.onState((id, s) => {
      if (id !== taskId) return;
      if (s === "running") {
        runs += 1;
        const q = getTask(node.db, taskId)!.queued;
        queuedAtStart.push(q === null ? [] : (JSON.parse(q) as string[]));
      } else if (s === "idle" && runs === turns) {
        off();
        res();
      }
    });
  });
  return { queuedAtStart, done };
}

test("activation replays the follow-up and the queued prompts as one turn each, in order", async () => {
  const { A, B, close } = await twoPoolNodes();
  try {
    const m = await turnedTask(A);
    A.db.query("UPDATE tasks SET queued = ? WHERE id = ?").run(JSON.stringify(["first queued", "second queued"]), m.id);
    const ref = await peerOn(A, B);
    try {
      expect(await ref.receiveTask({ manifest: m, claudeCodeVersion: claudeCodeVersion() })).toMatchObject({ ok: true });
      const { got } = await sendTask(A, B, m.id);
      expect(got).not.toBeNull();
      expect(JSON.parse(getTask(B.db, m.id)!.queued!)).toEqual(["first queued", "second queued"]);
      const before = listEvents(B.db, m.id).length;

      const texts = ["carry on after the move", "first queued", "second queued"];
      const { queuedAtStart, done } = watchTurns(B, m.id, 3);
      expect(await ref.activateTask({ taskId: m.id, followUp: texts[0]! })).toEqual({ ok: true });
      await done;
      const events = listEvents(B.db, m.id).slice(before);
      expect(turnMarks(events)).toEqual(texts.flatMap((t) => ["start", `user:${t}`, "result"]));
      expect(events.filter((e) => (e.message as { subtype?: string }).subtype === "turn_started").map((e) => (e.message as { resume: boolean }).resume))
        .toEqual([true, true, true]);
      // A text leaves the queue only once its own turn exists, never before: at the k-th turn's start the queue still
      // holds every later text, and the k-th text at most.
      expect(queuedAtStart).toHaveLength(3);
      queuedAtStart.forEach((q, k) => expect([texts.slice(k), texts.slice(k + 1)]).toContainEqual(q));
      expect(getTask(B.db, m.id)!.queued).toBeNull();
      expect(getTask(B.db, m.id)!.turns).toBe(4);
    } finally {
      ref.release();
    }
  } finally {
    await close();
  }
}, 15_000);

test("a prompt to an idle task with queued prompts runs after them", async () => {
  const node = await setupNode();
  try {
    const m = await node.runner.create({ title: "t", projectIds: [node.project.id] });
    node.db.query("UPDATE tasks SET queued = ? WHERE id = ?").run(JSON.stringify(["queued first"]), m.id);
    const { done } = watchTurns(node, m.id, 2);
    await node.runner.prompt(m.id, "sent later");
    await done;
    expect(turnMarks(listEvents(node.db, m.id))).toEqual(["start", "user:queued first", "result", "start", "user:sent later", "result"]);
    expect(getTask(node.db, m.id)!.queued).toBeNull();
  } finally {
    await node.harness.close();
    node.db.close();
    await rm(node.home, { recursive: true, force: true });
  }
}, 15_000);

test("a receiving task is abandoned or replaced and leaves nothing behind", async () => {
  const { A, B, close } = await twoPoolNodes();
  try {
    const m = await turnedTask(A);
    const ref = await peerOn(A, B);
    const replicaB = paths(B.cfg).replica(A.project.id);
    const task = paths(B.cfg).task(m.id);
    const leftovers = async () => ({
      row: getTask(B.db, m.id),
      folder: existsSync(task),
      events: B.db.query("SELECT COUNT(*) AS n FROM events WHERE task_id = ?").get(m.id),
      transcript: B.db.query("SELECT COUNT(*) AS n FROM transcript WHERE session_id = ?").get(m.sessionId),
      workspaces: (await jj(["workspace", "list", "-T", 'name ++ "\\n"'], replicaB, B.cfg)).split("\n").filter((n) => n.includes(m.id)),
      bookmarks: (await bookmarkList(replicaB, B.cfg)).filter((b) => b.name.includes(m.id)),
    });
    const nothing = { row: null, folder: false, events: { n: 0 }, transcript: { n: 0 }, workspaces: [], bookmarks: [] };
    try {
      expect(await ref.receiveTask({ manifest: m, claudeCodeVersion: claudeCodeVersion() })).toEqual({ ok: true });
      const { got } = await sendTask(A, B, m.id);
      expect(got).not.toBeNull();
      // A partial copy (a stray file) is replaced by a second receive from the same node: the rerun of a handoff.
      const stray = join(paths(B.cfg).taskConfig(m.id), "projects", "stray");
      await writeFile(stray, "x");
      expect(await ref.receiveTask({ manifest: m, claudeCodeVersion: claudeCodeVersion() })).toEqual({ ok: true });
      expect(existsSync(stray)).toBe(false);
      expect(getTask(B.db, m.id)!.state).toBe("receiving");
      expect(B.db.query("SELECT COUNT(*) AS n FROM events WHERE task_id = ?").get(m.id)).toEqual({ n: 0 });

      await ref.abandonTask({ taskId: m.id });
      expect(await leftovers()).toEqual(nothing);

      // An orphan of a move that never finished is abandoned at start.
      expect(await ref.receiveTask({ manifest: m, claudeCodeVersion: claudeCodeVersion() })).toEqual({ ok: true });
      await sendTask(A, B, m.id);
      await B.runner.abandonOrphans();
      expect(await leftovers()).toEqual(nothing);
    } finally {
      ref.release();
    }
  } finally {
    await close();
  }
}, 15_000);

test("only the sending node may import, activate or abandon a receiving task", async () => {
  const { nodes, close } = await poolNodes(3);
  const [A, B, C] = nodes as [GitPoolNode, GitPoolNode, GitPoolNode];
  try {
    const m = await turnedTask(A);
    const fromA = await peerOn(A, B);
    const fromC = await peerOn(C, B);
    try {
      expect(await fromA.receiveTask({ manifest: m, claudeCodeVersion: claudeCodeVersion() })).toEqual({ ok: true });
      const refusal = `not receiving ${m.id} from ${shortId(C.id)}`;
      await expect(fromC.activateTask({ taskId: m.id, followUp: null })).rejects.toMatchObject({ code: "forbidden", message: expect.stringContaining(refusal) });
      await expect(fromC.abandonTask({ taskId: m.id })).rejects.toMatchObject({ code: "forbidden", message: expect.stringContaining(refusal) });
      expect(await fromC.receiveTask({ manifest: m, claudeCodeVersion: claudeCodeVersion() })).toEqual({ ok: false, reason: `task ${m.id} already exists here` });
      // C's copy of the task (a fresh export of A's rows) is reset with no receipt.
      await copyTask(A, C, m.id);
      const { got } = await sendTask(C, B, m.id);
      expect(got).toBeNull();
      expect(B.db.query("SELECT COUNT(*) AS n FROM events WHERE task_id = ?").get(m.id)).toEqual({ n: 0 });
      expect(getTask(B.db, m.id)).toMatchObject({ state: "receiving", receiving_from: A.id });
      // A's own stream is still accepted.
      const { sent, got: fromAReceipt } = await sendTask(A, B, m.id);
      expect(receiptsMatch(sent!, fromAReceipt!)).toBe(true);
    } finally {
      fromA.release();
      fromC.release();
    }
  } finally {
    await close();
  }
}, 15_000);

/** Copies task `taskId`'s row and events from `from` into `to`'s database, so `to` can export it as its own. */
async function copyTask(from: GitPoolNode, to: GitPoolNode, taskId: string): Promise<void> {
  const row = getTask(from.db, taskId)!;
  to.db.query("INSERT INTO tasks (id, title, state, session_id, manifest, started, turns, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(row.id, row.title, "idle", row.session_id, row.manifest, row.started, row.turns, row.created_at, row.updated_at);
  for (const e of from.db.query<{ seq: number; json: string }, [string]>("SELECT seq, json FROM events WHERE task_id = ?").all(taskId)) {
    to.db.query("INSERT INTO events (task_id, seq, json) VALUES (?, ?, ?)").run(taskId, e.seq, e.json);
  }
}

/** Polls `get` until it returns `want`; fails with the last value after 5 s. */
async function until<T>(what: string, get: () => T, want: T): Promise<void> {
  const deadline = Date.now() + 5000;
  while (get() !== want) {
    if (Date.now() > deadline) throw new Error(`${what} is still ${String(get())}`);
    await Bun.sleep(20);
  }
}

test("a receive is refused for another Claude Code version, an unknown one, an unsafe id, or a node that hosts no tasks; hostsTasks follows the task root", async () => {
  const { A, B, close } = await twoPoolNodes();
  try {
    const ours = claudeCodeVersion();
    const manifest: TaskManifest = {
      id: "0123456789ab", title: "t", sessionId: crypto.randomUUID(), primaryProjectId: A.project.id, createdAt: new Date().toISOString(),
      projects: [{ id: A.project.id, name: "a", replica: A.project.replica, workspace: "a", parent: "root()" }],
    };
    const ref = await peerOn(A, B);
    try {
      expect(await ref.receiveTask({ manifest, claudeCodeVersion: "0.0.1" })).toEqual({ ok: false, reason: `claude code ${ours} here, 0.0.1 there` });
      expect(await ref.receiveTask({ manifest, claudeCodeVersion: "unknown" })).toEqual({ ok: false, reason: `claude code ${ours} here, unknown there` });
      expect(await ref.receiveTask({ manifest: { ...manifest, id: "../x" }, claudeCodeVersion: ours })).toEqual({ ok: false, reason: "invalid task id: ../x" });
      await rm(B.cfg.taskRoot, { recursive: true, force: true });
      expect(await ref.receiveTask({ manifest, claudeCodeVersion: ours })).toEqual({ ok: false, reason: "this node does not host tasks" });
      await until("the peer's hostsTasks", () => ref.hostsTasks.value, false);
      // Each metrics sample re-reads the task root, for peers and for the dashboard: it can go and come back.
      const owner = linkClient(B.host);
      try {
        const node = await owner.client.get(NodeObject, {});
        const sample = () => { B.metrics.stop(); B.metrics.start(); };
        sample();
        await until("the node's hostsTasks", () => node.hostsTasks.value, false);
        await mkdir(B.cfg.taskRoot, { recursive: true });
        sample();
        await until("the node's hostsTasks", () => node.hostsTasks.value, true);
        await until("the peer's hostsTasks", () => ref.hostsTasks.value, true);
        node.release();
      } finally {
        await owner.close();
      }
      expect(getTask(B.db, manifest.id)).toBeNull();
    } finally {
      ref.release();
    }
  } finally {
    await close();
  }
}, 15_000);
