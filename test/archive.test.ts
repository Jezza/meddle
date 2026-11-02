// test/archive.test.ts — archiving an idle task without its folder, restoring it on the same node, deleting it.
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { paths } from "../src/config";
import { bookmarkList, jj } from "../src/jj";
import { shortId } from "../src/pool/ids";
import { NodeObject, SessionObject, TaskObject } from "../src/state/contracts";
import { listEvents } from "../src/store/events";
import { getTask, listArchivedTasks, listLiveTasks, updateTask } from "../src/store/records";
import { readArchive } from "../src/tasks/archive";
import { transcriptPath, type TaskManifest } from "../src/tasks/manifest";
import { linkClient, poolNodes, twoPoolNodes, type GitPoolNode } from "./pool-helpers";

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

/** Polls `get` until it returns `want`; fails with the last value after 5 s. */
async function until<T>(what: string, get: () => T, want: T): Promise<void> {
  const deadline = Date.now() + 5000;
  while (JSON.stringify(get()) !== JSON.stringify(want)) {
    if (Date.now() > deadline) throw new Error(`${what} is still ${JSON.stringify(get())}`);
    await Bun.sleep(20);
  }
}

function countRows(node: GitPoolNode, m: TaskManifest): { events: number; transcript: number } {
  const n = (sql: string, id: string) => (node.db.query(sql).get(id) as { n: number }).n;
  return {
    events: n("SELECT COUNT(*) AS n FROM events WHERE task_id = ?", m.id),
    transcript: n("SELECT COUNT(*) AS n FROM transcript WHERE session_id = ?", m.sessionId),
  };
}

async function workspaces(node: GitPoolNode, replica: string): Promise<string> {
  return jj(["workspace", "list", "-T", 'name ++ "\\n"'], replica, node.cfg);
}

/** The local bookmarks under task `taskId`'s namespace in `replica`, as `name changeId`, and whether any remote one is left. */
async function namespace(node: GitPoolNode, replica: string, taskId: string): Promise<{ local: string[]; remote: number }> {
  const all = (await bookmarkList(replica, node.cfg)).filter((b) => b.name.startsWith(`meddle/task/${taskId}/`));
  return {
    local: all.filter((b) => b.remote === null).map((b) => `${b.name} ${b.changeId}`).sort(),
    remote: all.filter((b) => b.remote !== null).length,
  };
}

async function changeAt(node: GitPoolNode, dir: string, rev: string): Promise<string> {
  return (await jj(["log", "-r", rev, "--no-graph", "-T", "change_id"], dir, node.cfg)).trim();
}

test("an idle task archived on its project's home keeps its rows and bookmarks, serves its window read-only, restores here and resumes, and deletes", async () => {
  const { nodes, close } = await poolNodes(1);
  const A = nodes[0]!;
  const owner = linkClient(A.host);
  try {
    const m = await A.runner.create({ title: "t", projectIds: [A.project.id] });
    await promptAndWait(A, m.id, "Reply with the single word ok.");
    // A real transcript row is kept with the events.
    A.db.query("INSERT INTO transcript (project_key, session_id, subpath, seq, uuid, ts, json) VALUES (?, ?, '', 1, NULL, 0, '{}')").run(m.primaryProjectId, m.sessionId);
    const before = countRows(A, m);
    const bookmarksBefore = await namespace(A, A.project.replica, m.id);
    expect(bookmarksBefore.local).toHaveLength(1);
    const node = await owner.client.get(NodeObject, {});
    const task = await owner.client.get(TaskObject, { id: m.id });
    try {
      expect(task.archivedOn.value).toBeNull();
      expect(node.archivedIds.value).toEqual([]);
      await expect(task.restore({ node: null })).rejects.toThrow("task is idle");
      await task.archive({});

      expect(existsSync(paths(A.cfg).task(m.id))).toBe(false);
      expect((await workspaces(A, A.project.replica)).includes(m.id)).toBe(false);
      // The home keeps the task's bookmarks: they are the backup.
      expect(await namespace(A, A.project.replica, m.id)).toEqual(bookmarksBefore);
      expect(countRows(A, m)).toEqual(before);
      expect(getTask(A.db, m.id)).toMatchObject({ state: "archived", archived_on: A.id });
      expect(Date.parse(getTask(A.db, m.id)!.archived_at!)).toBeGreaterThan(Date.now() - 60_000);
      expect(listLiveTasks(A.db).map((t) => t.id)).not.toContain(m.id);
      expect(listArchivedTasks(A.db).map((t) => t.id)).toEqual([m.id]);
      const file = paths(A.cfg).archiveFile(m.id);
      expect(dirname(file)).toBe(paths(A.cfg).archives);
      expect(paths(A.cfg).archives).toBe(join(A.cfg.dataDir, "archives"));
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      const archive = await readArchive(file);
      expect(archive.manifest).toEqual(m);
      expect(archive.files.map((f) => f.path)).toContain(`${m.primaryProjectId}/${m.sessionId}.jsonl`);
      expect(existsSync(paths(A.cfg).movedFile(m.id))).toBe(false);

      await until("the task's state", () => task.state.value, "archived");
      await until("the task's archivedOn", () => task.archivedOn.value, A.id);
      await until("the node's archivedIds", () => node.archivedIds.value, [m.id]);
      await until("the node's taskIds", () => node.taskIds.value.includes(m.id), false);

      // Its thread is still there, from the rows.
      const session = await owner.client.get(SessionObject, { taskId: m.id });
      try {
        expect(session.window.value.at(-1)!.seq).toBe(task.lastSeq.value);
        expect((session.window.value.at(-1)!.message as { type?: string }).type).toBe("result");
      } finally {
        session.release();
      }
      await expect(task.prompt({ text: "hi" })).rejects.toThrow("task is archived");
      await expect(A.runner.moveTo(m.id, "0".repeat(64), false)).rejects.toThrow("task is archived");
      await expect(task.interrupt({})).rejects.toThrow("task is archived");
      await expect(task.archive({})).rejects.toThrow("task is archived");
      await expect(task.restore({ node: "f".repeat(64) })).rejects.toThrow("restore to another node is not available yet");

      // Restored here: folder, workspace and transcript back, the archive gone, and the next turn resumes the session.
      expect(await task.restore({ node: "here" })).toEqual({ nodeId: A.id });
      expect(existsSync(join(paths(A.cfg).task(m.id), "a"))).toBe(true);
      expect((await workspaces(A, A.project.replica)).includes(`meddle-${m.id}`)).toBe(true);
      expect(existsSync(transcriptPath(A.cfg, m))).toBe(true);
      expect(existsSync(file)).toBe(false);
      expect(getTask(A.db, m.id)).toMatchObject({ state: "idle", archived_on: null });
      await until("the task's state", () => task.state.value, "idle");
      await until("the task's archivedOn", () => task.archivedOn.value, null);
      await until("the node's archivedIds", () => node.archivedIds.value, []);
      await until("the node's taskIds", () => node.taskIds.value.includes(m.id), true);
      await promptAndWait(A, m.id, "Again.");
      const events = listEvents(A.db, m.id);
      const started = events.filter((e) => (e.message as { subtype?: string }).subtype === "turn_started");
      expect(started.map((e) => (e.message as { resume: boolean }).resume)).toEqual([false, true]);
      expect(events.filter((e) => (e.message as { type?: string }).type === "result").map((e) => (e.message as { subtype?: string }).subtype))
        .toEqual(["success", "success"]);

      // Delete: only an archived (or moved) task; its rows and archive go.
      await expect(task.delete({})).rejects.toThrow("task is idle");
      await A.runner.archive(m.id);
      await until("the node's archivedIds", () => node.archivedIds.value, [m.id]);
      await task.delete({});
      expect(getTask(A.db, m.id)).toBeNull();
      expect(countRows(A, m)).toEqual({ events: 0, transcript: 0 });
      expect(existsSync(file)).toBe(false);
      await until("the node's archivedIds", () => node.archivedIds.value, []);
    } finally {
      task.release();
      node.release();
    }
  } finally {
    await owner.close();
    await close();
  }
}, 30_000);

test("a task without a project archives and restores here with its transcript in this node's slot", async () => {
  const { nodes, close } = await poolNodes(1);
  const A = nodes[0]!;
  try {
    const m = await A.runner.create({ title: "loose", projectIds: [] });
    await promptAndWait(A, m.id, "Reply with the single word ok.");
    await A.runner.archive(m.id);
    expect(existsSync(paths(A.cfg).task(m.id))).toBe(false);
    await A.runner.restoreHere(m.id);
    expect(existsSync(transcriptPath(A.cfg, m))).toBe(true);
    await promptAndWait(A, m.id, "Again.");
    const started = listEvents(A.db, m.id).filter((e) => (e.message as { subtype?: string }).subtype === "turn_started");
    expect(started.map((e) => (e.message as { resume: boolean }).resume)).toEqual([false, true]);
  } finally {
    await close();
  }
}, 20_000);

test("archiving on a node that is not the project's home pushes the task's namespace to the home first, and is refused while the home is offline", async () => {
  const { A, B, close } = await twoPoolNodes();
  try {
    // A is the home; the task lives on B, which made a change and a side bookmark no turn end has pushed yet.
    const m = await B.runner.create({ title: "t", projectIds: [A.project.id] });
    const replicaB = paths(B.cfg).replica(A.project.id);
    const workspaceB = join(paths(B.cfg).task(m.id), "a");
    await writeFile(join(workspaceB, "note.txt"), "made on B\n");
    await jj(["bookmark", "create", `meddle/task/${m.id}/a.spike`, "-r", "@"], workspaceB, B.cfg);
    const change = await changeAt(B, workspaceB, "@");
    expect((await namespace(A, A.project.replica, m.id)).local).toEqual([]);

    await B.runner.archive(m.id);
    expect((await namespace(A, A.project.replica, m.id)).local).toEqual([`meddle/task/${m.id}/a ${change}`, `meddle/task/${m.id}/a.spike ${change}`]);
    expect(await namespace(B, replicaB, m.id)).toEqual({ local: [], remote: 0 });
    expect(existsSync(paths(B.cfg).task(m.id))).toBe(false);
    expect(getTask(B.db, m.id)).toMatchObject({ state: "archived", archived_on: B.id });

    // Restored on B: the task's bookmarks come back from the home, and the workspace starts on the archived change.
    await B.runner.restoreHere(m.id);
    expect(await changeAt(B, workspaceB, "@-")).toBe(change);
    expect(await Bun.file(join(workspaceB, "note.txt")).text()).toBe("made on B\n");
    expect((await namespace(B, replicaB, m.id)).local).toEqual([`meddle/task/${m.id}/a ${change}`, `meddle/task/${m.id}/a.spike ${change}`]);
    expect(getTask(B.db, m.id)).toMatchObject({ state: "idle", archived_on: null });

    // With the home offline, the archive is refused and nothing changes.
    const other = await B.runner.create({ title: "u", projectIds: [A.project.id] });
    A.net.unwatch(B.id, "bye");
    B.net.unwatch(A.id, "bye");
    await until("A online to B", () => B.net.isOnline(A.id), false);
    await expect(B.runner.archive(other.id)).rejects.toThrow(`cannot archive: home ${shortId(A.id)} of a is offline`);
    expect(existsSync(join(paths(B.cfg).task(other.id), "a"))).toBe(true);
    expect(getTask(B.db, other.id)).toMatchObject({ state: "idle", archived_on: null });
    expect(existsSync(paths(B.cfg).archiveFile(other.id))).toBe(false);
  } finally {
    await close();
  }
}, 30_000);

test("archiving is refused while a turn runs, while prompts are queued, and while the task moves", async () => {
  const { nodes, close } = await poolNodes(1, { nodes: [{ extraEnv: { MEDDLE_FIXTURE_STALL: "1" } }] });
  const A = nodes[0]!;
  try {
    const m = await A.runner.create({ title: "t", projectIds: [A.project.id] });
    // By its init, the stand-in has read the prompt and stalls before its result until interrupted.
    const initialised = new Promise<void>((res) => {
      const off = A.runner.onEvent((id, _seq, msg) => {
        if (id === m.id && msg.type === "system" && (msg as { subtype?: string }).subtype === "init") { off(); res(); }
      });
    });
    await A.runner.prompt(m.id, "Stall.");
    await expect(A.runner.archive(m.id)).rejects.toThrow("task is running");
    await initialised;
    await expect(A.runner.archive(m.id)).rejects.toThrow("task is running");
    const idle = new Promise<void>((res) => {
      const off = A.runner.onState((id, s) => { if (id === m.id && s === "idle") { off(); res(); } });
    });
    await A.runner.interrupt(m.id);
    await idle;
    await until("the live turn", () => A.runner.liveQuery(m.id) === null, true);

    updateTask(A.db, m.id, { queued: JSON.stringify(["later"]) });
    await expect(A.runner.archive(m.id)).rejects.toThrow("task has queued prompts");
    updateTask(A.db, m.id, { queued: null, state: "moving" });
    await expect(A.runner.archive(m.id)).rejects.toThrow("task is moving");
    updateTask(A.db, m.id, { state: "idle" });
    expect(existsSync(join(paths(A.cfg).task(m.id), "a"))).toBe(true);
    expect(getTask(A.db, m.id)!.archived_on).toBeNull();
  } finally {
    await close();
  }
}, 20_000);
