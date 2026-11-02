// test/move.test.ts — moving a task between nodes: the receiving side.
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, type Harness } from "@earendil-works/pi-durable";
import { join } from "node:path";
import { loadConfig, paths } from "../src/config";
import { bookmarkList, jj } from "../src/jj";
import { shortId } from "../src/pool/identity";
import { NodeObject, PeerObject, TaskObject } from "../src/state/contracts";
import { listEvents } from "../src/store/events";
import { getTask, insertTask, updateTask } from "../src/store/records";
import { openDb } from "../src/store/db";
import type { PoolRuntime } from "../src/pool/runtime";
import { readArchive, runJanitor, writeArchive } from "../src/tasks/archive";
import { TaskRunner } from "../src/tasks/durable";
import { openHarness } from "../src/tasks/harness";
import { readManifest, sideBookmark, transcriptPath, type TaskManifest } from "../src/tasks/manifest";
import { MOVE_NOW_FOLLOW_UP } from "../src/tasks/move";
import { exportTask, receiptsMatch, type Receipt } from "../src/tasks/transfer";
import { claudeCodeVersion } from "../src/version";
import { replay, setupNode } from "./helpers";
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

// ─── the sending side: meddle.move ───

/** Polls the Harness until it holds no `meddle.move`; fails with the move's last state after 10 s. */
async function moveSettled(harness: Harness): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const { tasks } = await harness.inspect(BACKGROUND_CONTEXT);
    const move = tasks.find((t) => t.record.kind === "meddle.move");
    if (move === undefined) return;
    if (Date.now() > deadline) throw new Error(`the move is still ${JSON.stringify(move.state)} at ${JSON.stringify(move.record.state)}`);
    await Bun.sleep(25);
  }
}

/** Every state the task's runner tells from now on. */
function statesOf(node: GitPoolNode, taskId: string): string[] {
  const seen: string[] = [];
  node.runner.onState((id, s) => { if (id === taskId) seen.push(s); });
  return seen;
}

function countRows(node: GitPoolNode, m: TaskManifest): { events: number; transcript: number } {
  const n = (sql: string, id: string) => (node.db.query(sql).get(id) as { n: number }).n;
  return {
    events: n("SELECT COUNT(*) AS n FROM events WHERE task_id = ?", m.id),
    transcript: n("SELECT COUNT(*) AS n FROM transcript WHERE session_id = ?", m.sessionId),
  };
}

/** Resolves once `node` has emitted `state` for the task. */
function stateOn(node: GitPoolNode, taskId: string, state: string): Promise<void> {
  return new Promise<void>((res) => {
    const off = node.runner.onState((id, s) => { if (id === taskId && s === state) { off(); res(); } });
  });
}

test("an idle task moves to another node: the source keeps only its row and an archive, the target runs it", async () => {
  const { A, B, close } = await twoPoolNodes();
  const owner = linkClient(A.host);
  try {
    const m = await turnedTask(A);
    await peerReady(A, B);
    // A real transcript row travels and is archived too.
    A.db.query("INSERT INTO transcript (project_key, session_id, subpath, seq, uuid, ts, json) VALUES (?, ?, '', 1, NULL, 0, '{}')").run(m.primaryProjectId, m.sessionId);
    const before = countRows(A, m);
    const states = statesOf(A, m.id);
    const task = await owner.client.get(TaskObject, { id: m.id });
    try {
      const moves: unknown[] = [];
      task.move.subscribe((mv) => moves.push(mv));
      await task.moveTo({ nodeId: B.id, now: false });
      await moveSettled(A.harness.harness);
      await until("the task's state", () => task.state.value, "moved");
      await until("the task's movedTo", () => task.movedTo.value, B.id);
      expect(task.move.value).toBeNull();
      expect(moves).toContainEqual({ to: B.id, phase: "commit", error: null });
      // Rendered from the row: nothing else is left here.
      const again = await owner.client.get(TaskObject, { id: m.id });
      expect(again.manifest.value).toEqual(m);
      expect(again.state.value).toBe("moved");
      again.release();
    } finally {
      task.release();
    }
    expect(states).toEqual(["moving", "moved"]);
    expect(getTask(A.db, m.id)).toMatchObject({ state: "moved", moved_to: B.id, queued: null });
    expect(existsSync(paths(A.cfg).task(m.id))).toBe(false);
    expect(countRows(A, m)).toEqual({ events: 0, transcript: 0 });
    expect((await jj(["workspace", "list", "-T", 'name ++ "\\n"'], A.project.replica, A.cfg)).includes(m.id)).toBe(false);
    const file = paths(A.cfg).movedFile(m.id);
    expect(file).toBe(join(A.cfg.dataDir, "moved", `${m.id}.json.gz`));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(paths(A.cfg).moved)).mode & 0o777).toBe(0o700);
    // A move's leftover is not an archived task's archive.
    expect(existsSync(paths(A.cfg).archiveFile(m.id))).toBe(false);
    const archive = await readArchive(file);
    expect(archive.manifest).toEqual(m);
    expect({ events: archive.events.length, transcript: archive.transcript.length }).toEqual(before);
    expect(archive.files.map((f) => f.path)).toContain(`${m.primaryProjectId}/${m.sessionId}.jsonl`);
    // A is the project's home: its task bookmark stays as the backup.
    expect(await taskBookmark(A, A.project.replica, m.id)).toBeDefined();

    const moved = `task has moved to ${shortId(B.id)}`;
    await expect(A.runner.prompt(m.id, "hi")).rejects.toThrow(moved);
    await expect(A.runner.interrupt(m.id)).rejects.toThrow(moved);
    await expect(A.runner.setModel(m.id, "x")).rejects.toThrow(moved);
    await expect(A.runner.moveTo(m.id, B.id, false)).rejects.toThrow(moved);

    expect(B.runner.state(m.id)).toBe("idle");
    await promptAndWait(B, m.id, "Carry on.");
    const started = listEvents(B.db, m.id).filter((e) => (e.message as { subtype?: string }).subtype === "turn_started");
    expect(started.map((e) => (e.message as { resume: boolean }).resume)).toEqual([false, true]);
    // B's turn end pushed its change to the home: A's bookmark follows the task.
    const workspaceB = join(paths(B.cfg).task(m.id), "a");
    expect(await taskBookmark(A, A.project.replica, m.id)).toBe(await changeAt(B, workspaceB, "@"));
    expect(B.logs.filter((l) => l.includes("push"))).toEqual([]);
  } finally {
    await owner.close();
    await close();
  }
}, 15_000);

test("a task moves to another node and back: the old row is replaced, and the non-home node forgets its bookmark", async () => {
  const { A, B, close } = await twoPoolNodes();
  try {
    const m = await turnedTask(A);
    await peerReady(A, B);
    await peerReady(B, A);
    await A.runner.moveTo(m.id, B.id, false);
    await moveSettled(A.harness.harness);
    await promptAndWait(B, m.id, "On B.");
    await B.runner.moveTo(m.id, A.id, false);
    await moveSettled(B.harness.harness);

    expect(getTask(B.db, m.id)).toMatchObject({ state: "moved", moved_to: A.id });
    const replicaB = paths(B.cfg).replica(A.project.id);
    expect((await bookmarkList(replicaB, B.cfg)).filter((b) => b.name.includes(m.id))).toEqual([]);
    expect(getTask(A.db, m.id)).toMatchObject({ state: "idle", moved_to: null, receiving_from: null, turns: 2 });
    expect(existsSync(paths(A.cfg).movedFile(m.id))).toBe(true);
    await promptAndWait(A, m.id, "Home again.");
    const started = listEvents(A.db, m.id).filter((e) => (e.message as { subtype?: string }).subtype === "turn_started");
    expect(started.map((e) => (e.message as { resume: boolean }).resume)).toEqual([false, true, true]);
  } finally {
    await close();
  }
}, 15_000);

test("every bookmark under the task's namespace travels with a move and is listed there; a non-home source forgets them", async () => {
  const { A, B, close } = await twoPoolNodes();
  const ownerA = linkClient(A.host);
  const ownerB = linkClient(B.host);
  try {
    const m = await turnedTask(A);
    await peerReady(A, B);
    await peerReady(B, A);
    const ns = `meddle/task/${m.id}/`;
    const primary = `${ns}a`;
    const local = async (node: GitPoolNode, replica: string) =>
      (await bookmarkList(replica, node.cfg)).filter((b) => b.remote === null).map((b) => [b.name, b.changeId] as const);
    // The agent on A (the home) commits a side branch and bookmarks it, in and outside the namespace.
    const workspaceA = join(paths(A.cfg).task(m.id), "a");
    await writeFile(join(workspaceA, "spike.txt"), "spike\n");
    await jj(["commit", "-m", "spike"], workspaceA, A.cfg);
    const spike = sideBookmark(m.id, "a", "spike");
    await jj(["bookmark", "create", spike, "-r", "@-"], workspaceA, A.cfg);
    await jj(["bookmark", "create", "elsewhere", "-r", "@-"], workspaceA, A.cfg);
    const spikeChange = await changeAt(A, workspaceA, "@-");

    await A.runner.moveTo(m.id, B.id, false);
    await moveSettled(A.harness.harness);
    const replicaB = paths(B.cfg).replica(A.project.id);
    expect(await local(B, replicaB)).toContainEqual([spike, spikeChange]);
    expect((await local(B, replicaB)).map(([name]) => name)).not.toContain("elsewhere");
    const onB = await ownerB.client.get(TaskObject, { id: m.id });
    try {
      expect(onB.bookmarks.value.map((b) => b.name)).toEqual([primary, spike]);
      expect(onB.bookmarks.value).toContainEqual({ project: A.project.id, name: spike, changeId: spikeChange });
    } finally {
      onB.release();
    }

    // On B, not the home: another side bookmark; the turn's end pushes the whole namespace to the home.
    const workspaceB = join(paths(B.cfg).task(m.id), "a");
    await writeFile(join(workspaceB, "extra.txt"), "extra\n");
    await jj(["commit", "-m", "extra"], workspaceB, B.cfg);
    const extra = sideBookmark(m.id, "a", "extra");
    await jj(["bookmark", "create", extra, "-r", "@-"], workspaceB, B.cfg);
    const extraChange = await changeAt(B, workspaceB, "@-");
    await promptAndWait(B, m.id, "On B.");
    expect(await local(A, A.project.replica)).toContainEqual([extra, extraChange]);
    expect(B.logs.filter((l) => l.includes("push"))).toEqual([]);

    await B.runner.moveTo(m.id, A.id, false);
    await moveSettled(B.harness.harness);
    expect((await bookmarkList(replicaB, B.cfg)).filter((b) => b.name.startsWith(ns))).toEqual([]);
    expect(await local(A, A.project.replica)).toContainEqual([spike, spikeChange]);
    expect(await local(A, A.project.replica)).toContainEqual([extra, extraChange]);
    const onA = await ownerA.client.get(TaskObject, { id: m.id });
    try {
      await until("A's listed bookmarks", () => onA.bookmarks.value.map((b) => b.name).join(" "), [primary, extra, spike].join(" "));
    } finally {
      onA.release();
    }
  } finally {
    await ownerA.close();
    await ownerB.close();
    await close();
  }
}, 20_000);

test("a move without `now` waits for the running turn; prompts sent meanwhile run on the target one turn each, in order", async () => {
  const { A, B, close } = await twoPoolNodes({ nodes: [{ fixture: "approval.jsonl" }, {}] });
  try {
    const m = await A.runner.create({ title: "t", projectIds: [A.project.id] });
    await peerReady(A, B);
    const waiting = stateOn(A, m.id, "waiting");
    await A.runner.prompt(m.id, "Run: echo hi");
    await waiting;
    const states = statesOf(A, m.id);
    await A.runner.moveTo(m.id, B.id, false);
    await expect(A.runner.moveTo(m.id, B.id, false)).rejects.toThrow("task is moving");
    await until("A's row", () => getTask(A.db, m.id)!.state, "moving");
    await expect(A.runner.interrupt(m.id)).rejects.toThrow("task is moving");
    await expect(A.runner.setEffort(m.id, "low")).rejects.toThrow("task is moving");
    await expect(A.runner.retry(m.id)).rejects.toThrow("task is moving");
    await A.runner.prompt(m.id, "first while moving");
    await A.runner.prompt(m.id, "second while moving");
    expect(JSON.parse(getTask(A.db, m.id)!.queued!)).toEqual(["first while moving", "second while moving"]);
    await Bun.sleep(300);
    // Still waiting for the turn, which keeps running.
    expect(getTask(A.db, m.id)!.state).toBe("moving");
    expect(A.runner.liveQuery(m.id)).not.toBeNull();

    const { done } = watchTurns(B, m.id, 2);
    for (const q of A.runner.approvals.pending(m.id)) A.runner.approvals.answer(q.requestId, { behavior: "allow", updatedInput: q.input });
    await moveSettled(A.harness.harness);
    await done;
    // The turn's own ending (running, idle) never reached the row or the listeners.
    expect(states).toEqual(["moving", "moved"]);
    expect(getTask(A.db, m.id)!.turns).toBe(1);
    expect(turnMarks(listEvents(B.db, m.id)).slice(-6)).toEqual([
      "start", "user:first while moving", "result", "start", "user:second while moving", "result",
    ]);
    expect(getTask(B.db, m.id)).toMatchObject({ state: "idle", queued: null, turns: 3 });
  } finally {
    await close();
  }
}, 15_000);

test("a move `now` interrupts the running turn, and the target's first turn carries on with the follow-up", async () => {
  const { A, B, close } = await twoPoolNodes({ nodes: [{ extraEnv: { MEDDLE_FIXTURE_STALL: "1" } }, {}] });
  try {
    const m = await A.runner.create({ title: "t", projectIds: [A.project.id] });
    await peerReady(A, B);
    const initialised = new Promise<void>((res) => A.runner.onEvent((id, _s, msg) => { if (id === m.id && msg.type === "system" && msg.subtype === "init") res(); }));
    await A.runner.prompt(m.id, "Reply with the single word ok.");
    await initialised;
    const { done } = watchTurns(B, m.id, 1);
    await A.runner.moveTo(m.id, B.id, true);
    await moveSettled(A.harness.harness);
    await done;
    expect(getTask(A.db, m.id)!.state).toBe("moved");
    const events = listEvents(B.db, m.id);
    // A's turn ended with the interrupted turn's result; B's first turn is a resumed, fresh one with the follow-up.
    expect(turnMarks(events)).toEqual(["start", "user:Reply with the single word ok.", "result", "start", `user:${MOVE_NOW_FOLLOW_UP}`, "result"]);
    const results = events.filter((e) => (e.message as { type?: string }).type === "result").map((e) => (e.message as { subtype: string }).subtype);
    expect(results[0]).toBe("error_during_execution");
    const started = events.filter((e) => (e.message as { subtype?: string }).subtype === "turn_started");
    expect(started.map((e) => (e.message as { resume: boolean }).resume)).toEqual([false, true]);
  } finally {
    await close();
  }
}, 15_000);

test("a target that fails between the receipt and activation rolls the move back (Review Focus 2)", async () => {
  const { A, B, close } = await twoPoolNodes();
  const owner = linkClient(A.host);
  try {
    const m = await turnedTask(A);
    await peerReady(A, B);
    let calls = 0;
    B.hooks.beforeActivate = () => {
      calls += 1;
      if (calls === 1) throw new Error("activation broke");
    };
    const before = countRows(A, m);
    await A.runner.moveTo(m.id, B.id, false);
    await moveSettled(A.harness.harness);

    expect(calls).toBe(1);
    expect(getTask(A.db, m.id)).toMatchObject({ state: "idle", moved_to: null });
    expect(existsSync(paths(A.cfg).taskManifest(m.id))).toBe(true);
    expect(countRows(A, m)).toEqual(before);
    expect(getTask(B.db, m.id)).toBeNull();
    expect(existsSync(paths(B.cfg).task(m.id))).toBe(false);
    const failed = A.logs.filter((l) => l.startsWith(`meddle: move: ${m.id} failed at commit: `));
    expect(failed).toHaveLength(1);
    const node = await owner.client.get(NodeObject, {});
    try {
      const moves = () => node.notifications.value.filter((n) => n.kind === "move" && n.taskId === m.id);
      await until("the move notifications", () => moves().length, 1);
      expect(moves()[0]!.text.startsWith(`Move to ${shortId(B.id)} failed at commit: `)).toBe(true);
    } finally {
      node.release();
    }
    // The task is A's again.
    await promptAndWait(A, m.id, "Again.");
    expect(getTask(A.db, m.id)!.turns).toBe(2);
  } finally {
    await owner.close();
    await close();
  }
}, 15_000);

test("a source that stops after the receipt finishes the move when it starts again (Review Focus 3)", async () => {
  const { A, B, close } = await twoPoolNodes();
  let reopened: { close(): Promise<void> } | undefined;
  try {
    const m = await turnedTask(A);
    await peerReady(A, B);
    let calls = 0;
    // A stops while its first activation is in flight; B activates once A has gone.
    const stopped = Promise.withResolvers<void>();
    B.hooks.beforeActivate = async () => {
      calls += 1;
      if (calls === 1) {
        await A.harness.close();
        stopped.resolve();
      }
    };
    await A.runner.moveTo(m.id, B.id, false);
    await stopped.promise;
    await until("B's row", () => getTask(B.db, m.id)?.state, "idle");
    expect(getTask(A.db, m.id)!.state).toBe("moving");
    expect(existsSync(paths(A.cfg).task(m.id))).toBe(true);

    const harness = await openHarness(A.cfg, createRegistry());
    reopened = harness;
    new TaskRunner(A.cfg, A.db, harness.harness, {
      claudePath: replay, claudeRuntime: "bun", extraEnv: { MEDDLE_FIXTURE: `${import.meta.dir}/fixtures/hello.jsonl` },
      pool: A.pool, log: (line) => A.logs.push(line),
    });
    await moveSettled(harness.harness);
    // The commit ran again: a second, no-op activation, then the cleanup.
    expect(calls).toBe(2);
    expect(getTask(A.db, m.id)).toMatchObject({ state: "moved", moved_to: B.id });
    expect(existsSync(paths(A.cfg).task(m.id))).toBe(false);
    expect(existsSync(paths(A.cfg).movedFile(m.id))).toBe(true);
    expect(getTask(B.db, m.id)).toMatchObject({ state: "idle", receiving_from: null, turns: 1 });
    expect(A.logs.filter((l) => l.startsWith("meddle: move:"))).toEqual([]);
  } finally {
    await reopened?.close();
    await close();
  }
}, 15_000);

test("a target that stops answering after the receipt is asked again until it answers; the move never rolls back meanwhile", async () => {
  const { A, B, close } = await twoPoolNodes();
  try {
    const m = await turnedTask(A);
    await peerReady(A, B);
    let calls = 0;
    const cut = Promise.withResolvers<void>();
    B.hooks.beforeActivate = async () => {
      calls += 1;
      if (calls > 1) return;
      // The link goes while B handles the first activation: whatever B answers, A hears nothing.
      A.net.unwatch(B.id, "bye");
      B.net.unwatch(A.id, "bye");
      while (A.net.isOnline(B.id) || B.net.isOnline(A.id)) await Bun.sleep(10);
      cut.resolve();
      throw new Error("not activated this time");
    };
    await A.runner.moveTo(m.id, B.id, false);
    await cut.promise;
    await Bun.sleep(3000);
    expect(getTask(A.db, m.id)!.state).toBe("moving");
    expect(A.runner.moveState(m.id)).toEqual({ to: B.id, phase: "commit", error: null });
    expect(existsSync(paths(A.cfg).taskManifest(m.id))).toBe(true);
    expect(A.logs.filter((l) => l.includes(" failed at "))).toEqual([]);
    expect(A.logs.some((l) => l.startsWith(`meddle: move: ${m.id} waits for ${shortId(B.id)} to activate it: `))).toBe(true);
    expect(getTask(B.db, m.id)).toMatchObject({ state: "receiving", receiving_from: A.id });

    // B is back: the next attempt activates the task, and the move completes.
    A.net.watch(B.id);
    B.net.watch(A.id);
    B.net.offerAddress(B.pool.store.row(A.id)!.lastAddr!);
    A.net.offerAddress(A.pool.store.row(B.id)!.lastAddr!);
    await moveSettled(A.harness.harness);
    expect(calls).toBe(2);
    expect(getTask(A.db, m.id)).toMatchObject({ state: "moved", moved_to: B.id });
    expect(existsSync(paths(A.cfg).task(m.id))).toBe(false);
    expect(getTask(B.db, m.id)).toMatchObject({ state: "idle", receiving_from: null });
  } finally {
    await close();
  }
}, 15_000);

test("a target that activated the task and moved it on since still answers ok: the source completes, never rolls back", async () => {
  const { A, B, close } = await twoPoolNodes();
  try {
    const m = await turnedTask(A);
    await peerReady(A, B);
    let calls = 0;
    B.hooks.beforeActivate = () => { calls += 1; };
    const lost = Promise.withResolvers<void>();
    B.hooks.afterActivate = async () => {
      if (calls > 1) return;
      // B has activated the task; its answer is lost on the way back.
      A.net.unwatch(B.id, "bye");
      B.net.unwatch(A.id, "bye");
      while (A.net.isOnline(B.id) || B.net.isOnline(A.id)) await Bun.sleep(10);
      lost.resolve();
    };
    await A.runner.moveTo(m.id, B.id, false);
    await lost.promise;
    // Meanwhile B moved the task on to a third node.
    updateTask(B.db, m.id, { state: "moved", moved_to: "c".repeat(64) });
    A.net.watch(B.id);
    B.net.watch(A.id);
    B.net.offerAddress(B.pool.store.row(A.id)!.lastAddr!);
    A.net.offerAddress(A.pool.store.row(B.id)!.lastAddr!);
    await moveSettled(A.harness.harness);
    expect(calls).toBe(2);
    expect(getTask(A.db, m.id)).toMatchObject({ state: "moved", moved_to: B.id });
    expect(existsSync(paths(A.cfg).task(m.id))).toBe(false);
    expect(A.logs.filter((l) => l.includes(" failed at "))).toEqual([]);
  } finally {
    await close();
  }
}, 15_000);

test("receiveTask has no time limit, while an activateTask slower than the limit counts as no answer", async () => {
  const { A, B, close } = await twoPoolNodes();
  try {
    const m = await turnedTask(A);
    await peerReady(A, B);
    A.hooks.callMs = 1000;
    B.hooks.beforeReceive = () => Bun.sleep(3000);
    let calls = 0;
    B.hooks.beforeActivate = async () => {
      calls += 1;
      if (calls === 1) await Bun.sleep(1500);
    };
    await A.runner.moveTo(m.id, B.id, false);
    await moveSettled(A.harness.harness);
    expect(getTask(A.db, m.id)).toMatchObject({ state: "moved", moved_to: B.id });
    expect(getTask(B.db, m.id)).toMatchObject({ state: "idle", receiving_from: null });
    expect(calls).toBe(2);
    expect(A.logs.filter((l) => l.startsWith(`meddle: move: ${m.id} waits for ${shortId(B.id)} to activate it: `))).toEqual([
      `meddle: move: ${m.id} waits for ${shortId(B.id)} to activate it: ${shortId(B.id)} did not answer within 1 s`,
    ]);
  } finally {
    await close();
  }
}, 15_000);

test("a rollback that cannot tell the task's turn state still leaves the task idle and the move ended", async () => {
  const { A, B, close } = await twoPoolNodes();
  try {
    const m = await turnedTask(A);
    await peerReady(A, B);
    B.hooks.beforeActivate = () => { throw new Error("activation broke"); };
    A.hooks.beforeRestore = () => { throw new Error("inspect broke"); };
    const states = statesOf(A, m.id);
    await A.runner.moveTo(m.id, B.id, false);
    await moveSettled(A.harness.harness);
    expect(getTask(A.db, m.id)!.state).toBe("idle");
    expect(states.at(-1)).toBe("idle");
    expect(A.runner.moveState(m.id)).toBeNull();
    expect(A.logs).toContain(`meddle: move: could not tell whether ${m.id} has a turn running: inspect broke`);
    expect(A.logs.filter((l) => l.startsWith(`meddle: move: ${m.id} failed at commit: `))).toHaveLength(1);
    expect(getTask(B.db, m.id)).toBeNull();
  } finally {
    await close();
  }
}, 15_000);

test("a task left moving with no move in progress is live again when its node starts, and its queued prompts run", async () => {
  const { nodes, close } = await poolNodes(1);
  const A = nodes[0]!;
  let reopened: { close(): Promise<void> } | undefined;
  try {
    const m = await A.runner.create({ title: "t", projectIds: [A.project.id] });
    updateTask(A.db, m.id, { state: "moving", queued: JSON.stringify(["after the stuck move"]) });
    await A.harness.close();
    const harness = await openHarness(A.cfg, createRegistry());
    reopened = harness;
    const runner = new TaskRunner(A.cfg, A.db, harness.harness, {
      claudePath: replay, claudeRuntime: "bun", extraEnv: { MEDDLE_FIXTURE: `${import.meta.dir}/fixtures/hello.jsonl` },
      pool: A.pool, log: (line) => A.logs.push(line),
    });
    const { done } = watchTurns({ runner, db: A.db } as unknown as GitPoolNode, m.id, 1);
    await done;
    expect(getTask(A.db, m.id)).toMatchObject({ state: "idle", queued: null, turns: 1 });
    expect(turnMarks(listEvents(A.db, m.id))).toEqual(["start", "user:after the stuck move", "result"]);
    expect(A.logs).toContain(`meddle: move: ${m.id} was left moving with no move in progress; it is live here again`);
  } finally {
    await reopened?.close();
    await close();
  }
}, 15_000);

/**
 * A runner with a pool on a stand-in Harness whose `inspect` reports `tasks`: what it was asked to abort, the turns it
 * created and the lines it logged. Its rows are in an in-memory database.
 */
async function standInRunner(tasks: unknown[]) {
  const home = await mkdtemp("/tmp/meddle-move-");
  const cfg = loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/d`, MEDDLE_TASK_ROOT: `${home}/t` });
  const db = openDb(":memory:");
  const aborted: string[] = [];
  const created: unknown[] = [];
  const logs: string[] = [];
  const harness = {
    inspect: async () => ({ tasks }),
    abortTask: async (id: string) => { aborted.push(id); return "marked"; },
    root: async () => ({ commit: async (fn: (tx: unknown) => unknown) => fn({ createTask: (_def: unknown, input: unknown) => { created.push(input); } }) }),
  } as unknown as Harness;
  const start = () => new TaskRunner(cfg, db, harness, { pool: {} as PoolRuntime, log: (line) => logs.push(line) });
  return { home, db, aborted, created, logs, start };
}

/** Polls until `get()` is `want`, printing the last value after 10 s. */
async function eventually<T>(what: string, get: () => T, want: T): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const got = get();
    if (Bun.deepEquals(got, want)) return;
    if (Date.now() > deadline) throw new Error(`${what} is ${JSON.stringify(got)}, not ${JSON.stringify(want)}`);
    await Bun.sleep(10);
  }
}

test("a move parked before the receipt is released when its node starts; one parked in commit, or a turn rerunning, is not flipped to idle", async () => {
  const to = "b".repeat(64);
  const moveIn = (taskId: string, phase: string) => ({
    record: { id: `move-${taskId}`, kind: "meddle.move", input: { taskId, to, now: false }, state: { status: "pending", checkpoint: { phase } } },
    state: { kind: "blocked", reason: "restart_limit" },
  });
  const turn = { record: { id: "turn-rerun", kind: "meddle.turn", input: { taskId: "rerun", prompt: "p" } }, state: { kind: "ready", migrates: false } };
  const node = await standInRunner([moveIn("prepare", "prepare"), moveIn("handoff", "handoff"), moveIn("commit", "commit"), turn]);
  try {
    for (const id of ["prepare", "handoff", "commit", "rerun"]) {
      insertTask(node.db, { id, title: id, state: "moving", session_id: `s-${id}`, manifest: "{}", started: 1, turns: 1 });
      updateTask(node.db, id, { queued: JSON.stringify([`after ${id}`]) });
    }
    const runner = node.start();
    const short = shortId(to);
    await eventually("the logged lines", () => [...node.logs].sort(), [
      `meddle: move: handoff to ${short} at handoff parked; released`,
      `meddle: move: prepare to ${short} at prepare parked; released`,
      "meddle: move: rerun was left moving with no move in progress; it is live here again",
    ]);
    // Released: live here again, the move aborted, the queued prompt started as a turn.
    expect(node.aborted.sort()).toEqual(["move-handoff", "move-prepare"]);
    for (const id of ["prepare", "handoff"]) expect(getTask(node.db, id)).toMatchObject({ state: "idle", queued: null });
    // The commit may have reached the target: untouched.
    expect(getTask(node.db, "commit")).toMatchObject({ state: "moving", queued: JSON.stringify(["after commit"]) });
    // A turn the Harness reruns keeps the task running: no second turn for its session.
    expect(getTask(node.db, "rerun")).toMatchObject({ state: "running", queued: JSON.stringify(["after rerun"]) });
    await expect(runner.prompt("rerun", "hi")).rejects.toThrow("task is resuming");
    expect(node.created).toHaveLength(2);
    expect(node.created).toContainEqual({ taskId: "prepare", prompt: "after prepare" });
    expect(node.created).toContainEqual({ taskId: "handoff", prompt: "after handoff" });
  } finally {
    node.db.close();
    await rm(node.home, { recursive: true, force: true });
  }
});

test("a handoff run again after its move was rolled back here, with the task live again, rolls back instead of handing it over", async () => {
  const { A, B, close } = await twoPoolNodes();
  let reopened: { close(): Promise<void> } | undefined;
  try {
    const m = await turnedTask(A);
    await peerReady(A, B);
    // A stops during its handoff: the move stays at `handoff`, and B keeps the copy it was sent.
    const stopped = Promise.withResolvers<void>();
    B.hooks.beforeReceive = async () => {
      await A.harness.close();
      stopped.resolve();
    };
    await A.runner.moveTo(m.id, B.id, false);
    await stopped.promise;
    await until("B's row", () => getTask(B.db, m.id)?.state, "receiving");
    // As a rollback whose end was never recorded leaves it: the task live on A again.
    updateTask(A.db, m.id, { state: "idle" });

    const harness = await openHarness(A.cfg, createRegistry());
    reopened = harness;
    const runner = new TaskRunner(A.cfg, A.db, harness.harness, {
      claudePath: replay, claudeRuntime: "bun", extraEnv: { MEDDLE_FIXTURE: `${import.meta.dir}/fixtures/hello.jsonl` },
      pool: A.pool, log: (line) => A.logs.push(line),
    });
    // A turn of the live task, against the handoff running again.
    await runner.prompt(m.id, "Live again.");
    await moveSettled(harness.harness);
    await until("A's turns", () => getTask(A.db, m.id)!.turns, 2);
    await until("A's row", () => getTask(A.db, m.id)!.state, "idle");
    expect(A.logs.filter((l) => l.startsWith(`meddle: move: ${m.id} failed at `))).toEqual([
      `meddle: move: ${m.id} failed at handoff: task is no longer moving`,
    ]);
    expect(getTask(A.db, m.id)).toMatchObject({ state: "idle", moved_to: null, turns: 2 });
    expect(existsSync(paths(A.cfg).taskManifest(m.id))).toBe(true);
    // Nothing was sent: B's partial copy was dropped.
    await until("B's row", () => getTask(B.db, m.id), null);
  } finally {
    await reopened?.close();
    await close();
  }
}, 15_000);

test("a commit run again after its move was rolled back here never asks the target to activate the task", async () => {
  const { A, B, close } = await twoPoolNodes();
  let reopened: { close(): Promise<void> } | undefined;
  try {
    const m = await turnedTask(A);
    await peerReady(A, B);
    // A stops during its first activation, which B refuses.
    let calls = 0;
    const stopped = Promise.withResolvers<void>();
    B.hooks.beforeActivate = async () => {
      calls += 1;
      await A.harness.close();
      stopped.resolve();
      throw new Error("not activated");
    };
    await A.runner.moveTo(m.id, B.id, false);
    await stopped.promise;
    // As a rollback whose end was never recorded leaves it: the task live on A again.
    updateTask(A.db, m.id, { state: "idle" });

    const harness = await openHarness(A.cfg, createRegistry());
    reopened = harness;
    new TaskRunner(A.cfg, A.db, harness.harness, {
      claudePath: replay, claudeRuntime: "bun", extraEnv: { MEDDLE_FIXTURE: `${import.meta.dir}/fixtures/hello.jsonl` },
      pool: A.pool, log: (line) => A.logs.push(line),
    });
    await moveSettled(harness.harness);
    expect(calls).toBe(1);
    expect(A.logs.filter((l) => l.startsWith(`meddle: move: ${m.id} failed at `))).toEqual([
      `meddle: move: ${m.id} failed at commit: task is no longer moving`,
    ]);
    expect(getTask(A.db, m.id)).toMatchObject({ state: "idle", moved_to: null });
    expect(existsSync(paths(A.cfg).taskManifest(m.id))).toBe(true);
    await until("B's row", () => getTask(B.db, m.id), null);
  } finally {
    await reopened?.close();
    await close();
  }
}, 15_000);

test("a move is refused for this node, an offline target, one that hosts no tasks, or another or unknown Claude Code version", async () => {
  const { A, B, close } = await twoPoolNodes();
  try {
    const m = await A.runner.create({ title: "t", projectIds: [A.project.id] });
    await peerReady(A, B);
    const ours = claudeCodeVersion();
    const short = shortId(B.id);
    const row = A.store.row(B.id)!;
    // What A last heard of B, dated later than anything B sends meanwhile.
    const heard = (summary: Partial<NonNullable<typeof row.summary>>) => A.store.seen(B.id, "9999-01-01T00:00:00.000Z", { ...row.summary!, ...summary }, row.lastAddr);
    heard({ claudeCodeVersion: "0.0.1" });
    await expect(A.runner.moveTo(m.id, B.id, false)).rejects.toThrow(`claude code ${ours} here, 0.0.1 there`);
    heard({ claudeCodeVersion: "unknown" });
    await expect(A.runner.moveTo(m.id, B.id, false)).rejects.toThrow(`claude code ${ours} here, unknown there`);
    heard({ hostsTasks: false });
    await expect(A.runner.moveTo(m.id, B.id, false)).rejects.toThrow(`${short} does not host tasks`);
    heard({});
    await expect(A.runner.moveTo(m.id, A.id, false)).rejects.toThrow("the task is already on this node");
    A.net.unwatch(B.id, "bye");
    B.net.unwatch(A.id, "bye");
    await until("B online to A", () => A.net.isOnline(B.id), false);
    await expect(A.runner.moveTo(m.id, B.id, false)).rejects.toThrow(`${short} is offline`);
    expect(getTask(A.db, m.id)!.state).toBe("idle");
    expect(A.runner.moveState(m.id)).toBeNull();
    expect(getTask(B.db, m.id)).toBeNull();
    const { tasks } = await A.harness.harness.inspect(BACKGROUND_CONTEXT);
    expect(tasks.filter((t) => t.record.kind === "meddle.move")).toEqual([]);
  } finally {
    await close();
  }
}, 15_000);

test("the janitor deletes move leftovers older than seven days, sweeps the old archive directory until it is empty and removes it, and never touches archives", async () => {
  const node = await setupNode();
  try {
    const p = paths(node.cfg);
    const legacy = join(node.cfg.dataDir, "archive");
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const put = async (dir: string, name: string, age: number) => {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, name), "x");
      const at = new Date(now - age * day);
      await utimes(join(dir, name), at, at);
    };
    for (const [name, age] of [["old.json.gz", 8], ["new.json.gz", 6], ["other.txt", 30]] as const) await put(p.moved, name, age);
    for (const [name, age] of [["gone.json.gz", 9], ["kept.json.gz", 2]] as const) await put(legacy, name, age);
    await put(p.archives, "archived.json.gz", 30);
    expect(await runJanitor(node.cfg, now)).toBe(2);
    expect((await readdir(p.moved)).sort()).toEqual(["new.json.gz", "other.txt"]);
    expect(await readdir(legacy)).toEqual(["kept.json.gz"]);
    expect(await readdir(p.archives)).toEqual(["archived.json.gz"]);
    // Once its last leftover is old enough, the old directory goes too.
    await utimes(join(legacy, "kept.json.gz"), new Date(now - 8 * day), new Date(now - 8 * day));
    expect(await runJanitor(node.cfg, now)).toBe(1);
    expect(existsSync(legacy)).toBe(false);
    expect(await runJanitor(node.cfg, now)).toBe(0);
    expect(await readdir(p.archives)).toEqual(["archived.json.gz"]);
  } finally {
    await node.harness.close();
    node.db.close();
    await rm(node.home, { recursive: true, force: true });
  }
});

test("an archive is written once per stay: kept on a rerun, replaced after the task changed", async () => {
  const node = await setupNode();
  try {
    const m = await node.runner.create({ title: "t", projectIds: [node.project.id] });
    const file = await writeArchive(node.cfg, node.db, m.id, paths(node.cfg).movedFile(m.id));
    expect(file).toBe(paths(node.cfg).movedFile(m.id));
    const first = (await readArchive(file)).archivedAt;
    await Bun.sleep(5);
    expect(await writeArchive(node.cfg, node.db, m.id, file)).toBe(file);
    expect((await readArchive(file)).archivedAt).toBe(first);
    // A later stay of the task here (its row changed since): archived anew.
    await Bun.sleep(5);
    updateTask(node.db, m.id, { turns: 3 });
    await writeArchive(node.cfg, node.db, m.id, file);
    const second = await readArchive(file);
    expect(second.archivedAt > first).toBe(true);
    expect(second.row.turns).toBe(3);
  } finally {
    await node.harness.close();
    node.db.close();
    await rm(node.home, { recursive: true, force: true });
  }
});

test("a task without a project moves to another node, its transcript lands in the target's slot, and it resumes there", async () => {
  const { realpathSync } = await import("node:fs");
  const { claudeSlot } = await import("../src/memory");
  const { A, B, close } = await twoPoolNodes();
  try {
    const m = await A.runner.create({ title: "loose", projectIds: [] });
    expect(m.primaryProjectId).toBeNull();
    await promptAndWait(A, m.id, "Reply with the single word ok.");
    expect(existsSync(transcriptPath(A.cfg, m))).toBe(true);
    // A store row under A's slot travels, and is filed under B's.
    const slotA = claudeSlot(realpathSync(paths(A.cfg).task(m.id)));
    A.db.query("INSERT INTO transcript (project_key, session_id, subpath, seq, uuid, ts, json) VALUES (?, ?, '', 1, NULL, 0, '{}')").run(slotA, m.sessionId);
    await peerReady(A, B);
    await A.runner.moveTo(m.id, B.id, false);
    await moveSettled(A.harness.harness);
    await until("the task's state on A", () => getTask(A.db, m.id)?.state, "moved");
    expect(B.runner.state(m.id)).toBe("idle");
    const onB = await readManifest(B.cfg, m.id);
    expect(onB).toEqual(m);
    const slotB = claudeSlot(realpathSync(paths(B.cfg).task(m.id)));
    expect(slotB).not.toBe(slotA);
    expect(existsSync(transcriptPath(B.cfg, onB))).toBe(true);
    expect(await readdir(join(paths(B.cfg).taskConfig(m.id), "projects"))).toEqual([slotB]);
    const keys = B.db.query("SELECT DISTINCT project_key AS k FROM transcript WHERE session_id = ?").all(m.sessionId) as Array<{ k: string }>;
    expect(keys.map((r) => r.k)).toEqual([slotB]);
    await promptAndWait(B, m.id, "Carry on.");
    const started = listEvents(B.db, m.id).filter((e) => (e.message as { subtype?: string }).subtype === "turn_started");
    expect(started.map((e) => (e.message as { resume: boolean }).resume)).toEqual([false, true]);
    // No project: nothing to push, no memory to sync, on either node.
    expect([...A.logs, ...B.logs].filter((l) => /push|memory/.test(l))).toEqual([]);
  } finally {
    await close();
  }
}, 30_000);

test("a restart during a restore-move's handoff ends with the task moved (or archived), never idle", async () => {
  const { A, B, close } = await twoPoolNodes();
  let reopened: { close(): Promise<void> } | undefined;
  try {
    const m = await turnedTask(A);
    await A.runner.archive(m.id);
    await peerReady(A, B);
    // A stops during its handoff: the move stays at `handoff`, and B keeps the copy it was sent.
    const stopped = Promise.withResolvers<void>();
    let calls = 0;
    B.hooks.beforeReceive = async () => {
      calls += 1;
      if (calls > 1) return;
      await A.harness.close();
      stopped.resolve();
    };
    await A.runner.restore(m.id, B.id);
    await stopped.promise;
    expect(getTask(A.db, m.id)!.state).toBe("moving");

    const harness = await openHarness(A.cfg, createRegistry());
    reopened = harness;
    const runner = new TaskRunner(A.cfg, A.db, harness.harness, {
      claudePath: replay, claudeRuntime: "bun", extraEnv: { MEDDLE_FIXTURE: `${import.meta.dir}/fixtures/hello.jsonl` },
      pool: A.pool, log: (line) => A.logs.push(line),
    });
    const states: string[] = [];
    runner.onState((id, s) => { if (id === m.id) states.push(s); });
    await moveSettled(harness.harness);
    expect(states).not.toContain("idle");
    expect(["archived", "moved"]).toContain(getTask(A.db, m.id)!.state);
    // The handoff ran again and finished the move.
    expect(calls).toBe(2);
    expect(getTask(A.db, m.id)).toMatchObject({ state: "moved", moved_to: B.id });
    expect(existsSync(paths(A.cfg).archiveFile(m.id))).toBe(false);
    expect(existsSync(paths(A.cfg).movedFile(m.id))).toBe(true);
    expect(getTask(B.db, m.id)).toMatchObject({ state: "idle", receiving_from: null, turns: 1 });
  } finally {
    await reopened?.close();
    await close();
  }
}, 30_000);

test("a restore-move whose node stops after marking the task moving and before prepare's checkpoint runs prepare again and still completes", async () => {
  const { A, B, close } = await twoPoolNodes();
  let reopened: { close(): Promise<void> } | undefined;
  try {
    const m = await turnedTask(A);
    await A.runner.archive(m.id);
    await peerReady(A, B);
    const stopped = Promise.withResolvers<void>();
    let calls = 0;
    A.hooks.afterEnterMove = async (_id, signal) => {
      calls += 1;
      if (calls > 1) return;
      void A.harness.close().then(() => stopped.resolve());
      // The step stops as the Harness closes, before its checkpoint.
      if (!signal.aborted) await new Promise((res) => signal.addEventListener("abort", res, { once: true }));
      throw new Error("stopped");
    };
    await A.runner.restore(m.id, B.id);
    await stopped.promise;
    expect(getTask(A.db, m.id)).toMatchObject({ state: "moving", archived_on: A.id });
    expect(getTask(B.db, m.id)).toBeNull();

    const harness = await openHarness(A.cfg, createRegistry());
    reopened = harness;
    new TaskRunner(A.cfg, A.db, harness.harness, {
      claudePath: replay, claudeRuntime: "bun", extraEnv: { MEDDLE_FIXTURE: `${import.meta.dir}/fixtures/hello.jsonl` },
      pool: A.pool, log: (line) => A.logs.push(line), hooks: A.hooks,
    });
    await moveSettled(harness.harness);
    expect(calls).toBe(2);
    expect(getTask(A.db, m.id)).toMatchObject({ state: "moved", moved_to: B.id });
    expect(existsSync(paths(A.cfg).movedFile(m.id))).toBe(true);
    expect(getTask(B.db, m.id)).toMatchObject({ state: "idle", receiving_from: null });
    expect(A.logs.filter((l) => l.startsWith("meddle: move:"))).toEqual([]);
  } finally {
    await reopened?.close();
    await close();
  }
}, 30_000);
