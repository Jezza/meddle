// test/archive.test.ts — archiving an idle task without its folder, restoring it on the same node, deleting it.
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SendStream } from "@number0/iroh";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { paths } from "../src/config";
import { bookmarkList, git, jj, JjError, workspaceConfigPath } from "../src/jj";
import { shortId } from "../src/pool/ids";
import { listLineRows, writeBranchRow } from "../src/pool/rows";
import { NodeObject, SessionObject, TaskObject } from "../src/state/contracts";
import { listEvents } from "../src/store/events";
import { getTask, listArchivedTasks, listLiveTasks, updateTask } from "../src/store/records";
import { readArchive, sweepArchiveTemps, writeArchive } from "../src/tasks/archive";
import { ALPN_POOL, StreamReader } from "../src/pool/frames";
import { exportArchive, exportTask, importTask, type Receipt } from "../src/tasks/transfer";
import { taskKey } from "../src/tasks/durable";
import { serialised } from "../src/serial";
import { claudeCodeVersion } from "../src/version";
import { transcriptPath, type TaskManifest } from "../src/tasks/manifest";
import { createTask, setupNode } from "./helpers";
import { endpointPair, linkClient, peerReady, poolNodes, twoPoolNodes, type GitPoolNode } from "./pool-helpers";

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

/** Task `taskId`'s line refs in `repo` (`refs/remotes/meddle/task/<id>/*`, from its rows): `<ref> <commit>` each. */
async function lineRefs(node: GitPoolNode, repo: string, taskId: string): Promise<string[]> {
  return (await git(["for-each-ref", "--format=%(refname) %(objectname)", `refs/remotes/meddle/task/${taskId}`], repo, node.cfg)).split("\n").filter(Boolean);
}

async function changeAt(node: GitPoolNode, dir: string, rev: string): Promise<string> {
  return (await jj(["log", "-r", rev, "--no-graph", "-T", "change_id"], dir, node.cfg)).trim();
}

test("an idle task archived keeps its rows and its lines, held here and out of the view, serves its window read-only, restores here and resumes, and deletes", async () => {
  const { nodes, close } = await poolNodes(1);
  const A = nodes[0]!;
  const owner = linkClient(A.host);
  try {
    const m = await createTask(A, { title: "t", projectIds: [A.project.id] });
    await promptAndWait(A, m.id, "Reply with the single word ok.");
    // A real transcript row is kept with the events.
    A.db.query("INSERT INTO transcript (project_key, session_id, subpath, seq, uuid, ts, json) VALUES (?, ?, '', 1, NULL, 0, '{}')").run(m.primaryProjectId, m.sessionId);
    const before = countRows(A, m);
    const bookmarksBefore = await namespace(A, A.project.replica, m.id);
    expect(bookmarksBefore.local).toHaveLength(1);
    const head = (await jj(["log", "--ignore-working-copy", "-r", `meddle/task/${m.id}/a`, "--no-graph", "-T", "commit_id"], A.project.replica, A.cfg)).trim();
    const node = await owner.client.get(NodeObject, {});
    const task = await owner.client.get(TaskObject, { id: m.id });
    try {
      expect(task.archivedOn.value).toBeNull();
      expect(node.archivedIds.value).toEqual([]);
      await expect(task.restore({ node: null })).rejects.toThrow("task is idle");
      await task.archive({});

      expect(existsSync(paths(A.cfg).task(m.id))).toBe(false);
      expect((await workspaces(A, A.project.replica)).includes(m.id)).toBe(false);
      // Its bookmarks go with its folder; its line stays, a row held here and archived, which the repo keeps as a ref.
      expect(await namespace(A, A.project.replica, m.id)).toEqual({ local: [], remote: 0 });
      expect(listLineRows(A.db, A.project.id, m.id)).toMatchObject([{ name: "a", holder: A.id, commit: head, archived: true }]);
      expect(await lineRefs(A, A.project.replica, m.id)).toEqual([`refs/remotes/meddle/task/${m.id}/a ${head}`]);
      expect(await git(["for-each-ref", `refs/namespaces/view/refs/heads/meddle/task/${m.id}`], A.project.replica, A.cfg)).toBe("");
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
      await expect(task.restore({ node: "f".repeat(64) })).rejects.toThrow("ffffffffff is not a member of this pool");

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
      // Its bookmark is back, and its row is live again: the line is the bookmark here, and in the view.
      expect(await namespace(A, A.project.replica, m.id)).toEqual(bookmarksBefore);
      expect(listLineRows(A.db, A.project.id, m.id)).toMatchObject([{ name: "a", holder: A.id, commit: head, archived: false }]);
      expect(await lineRefs(A, A.project.replica, m.id)).toEqual([]);
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

test("a restored task keeps the meddle context captured at its start, not one its agent committed into its line", async () => {
  const { nodes, close } = await poolNodes(1);
  const A = nodes[0]!;
  try {
    const m = await createTask(A, { title: "t", projectIds: [A.project.id] });
    expect(m.projects[0]!.context).toBeNull();
    // The agent writes a context.toml that would fail a turn; its turn end puts it in the task's line.
    const workspace = join(paths(A.cfg).task(m.id), "a");
    await mkdir(join(workspace, ".meddle"), { recursive: true });
    await writeFile(join(workspace, ".meddle", "context.toml"), "[claude]\nallwo = []\n");
    await promptAndWait(A, m.id, "Reply with the single word ok.");
    await A.runner.archive(m.id);
    await A.runner.restoreHere(m.id);
    expect(existsSync(join(workspace, ".meddle", "context.toml"))).toBe(true);
    expect((JSON.parse(getTask(A.db, m.id)!.manifest) as TaskManifest).projects[0]!.context).toBeNull();
    await promptAndWait(A, m.id, "Again.");
    const messages = listEvents(A.db, m.id).map((e) => e.message as { type?: string; subtype?: string });
    expect(messages.filter((msg) => msg.subtype === "turn_failed")).toEqual([]);
    expect(messages.filter((msg) => msg.type === "result").map((msg) => msg.subtype)).toEqual(["success", "success"]);
  } finally {
    await close();
  }
}, 30_000);

test("deleting an archived task releases its line and its workspace config, and the commit under it is mutable and visible again", async () => {
  const { nodes, close } = await poolNodes(1);
  const A = nodes[0]!;
  try {
    const home = A.project.replica;
    const log = async (rev: string, template: string) =>
      (await jj(["log", "--ignore-working-copy", "-r", rev, "--no-graph", "-T", template], home, A.cfg)).trim();
    await jj(["new", "main"], home, A.cfg);
    await writeFile(join(home, "mine"), "mine\n");
    await jj(["commit", "-m", "mine"], home, A.cfg);
    await jj(["bookmark", "set", "main", "-r", "@-"], home, A.cfg);
    const mine = await log("main", "commit_id");
    // `main`'s row too: a start reads the branch from its rows.
    writeBranchRow(A.db, A.id, { project: A.project.id, branch: "main", commit: mine, drops: [] });
    const m = await createTask(A, { title: "t", projectIds: [A.project.id] });
    const workspace = join(paths(A.cfg).task(m.id), "a");
    const config = await workspaceConfigPath(workspace, A.cfg);
    expect(existsSync(config)).toBe(true);
    await writeFile(join(workspace, "work"), "work\n");
    await promptAndWait(A, m.id, "Reply with the single word ok.");
    const head = await log(`meddle/task/${m.id}/a`, "commit_id");
    expect(await log(`${head}-`, "commit_id")).toBe(mine);

    await A.runner.archive(m.id);
    expect(await lineRefs(A, home, m.id)).toEqual([`refs/remotes/meddle/task/${m.id}/a ${head}`]);
    expect(await log(mine, "immutable")).toBe("true");
    const refused = await jj(["--ignore-working-copy", "describe", "-r", mine, "-m", "mine, reworded"], home, A.cfg).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(JjError);
    await A.runner.deleteTask(m.id);
    expect(getTask(A.db, m.id)).toBeNull();
    expect(await lineRefs(A, home, m.id)).toEqual([]);
    expect(listLineRows(A.db, A.project.id, m.id).map((r) => r.commit)).toEqual([null]);
    expect(existsSync(config)).toBe(false);
    expect(await namespace(A, home, m.id)).toEqual({ local: [], remote: 0 });
    // Nothing was abandoned: the user's commit and the task's work are still there, and the user's is theirs again.
    expect(await log(`${mine} | ${head}`, 'commit_id ++ " " ++ immutable ++ "\\n"')).toBe(`${head} false\n${mine} false`);
    expect(await log(`visible_heads() & ${head}`, "commit_id")).toBe(head);
    await jj(["--ignore-working-copy", "describe", "-r", mine, "-m", "mine, reworded"], home, A.cfg);
    expect(A.logs.filter((l) => l.startsWith("meddle: delete:"))).toEqual([]);
  } finally {
    await close();
  }
}, 30_000);

test("a task without a project archives and restores here with its transcript in this node's slot", async () => {
  const { nodes, close } = await poolNodes(1);
  const A = nodes[0]!;
  try {
    const m = await createTask(A, { title: "loose", projectIds: [] });
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

test("archive, restore and delete work with every other node offline: the lines are rows held here", async () => {
  const { A, B, close } = await twoPoolNodes();
  try {
    // The project was added on A; the task lives on B, which made a change and a side bookmark no turn end has written.
    const P = A.project.id;
    const m = await createTask(B, { title: "t", projectIds: [P] });
    const replicaB = paths(B.cfg).replica(P);
    const workspaceB = join(paths(B.cfg).task(m.id), "a");
    await writeFile(join(workspaceB, "note.txt"), "made on B\n");
    await jj(["bookmark", "create", `meddle/task/${m.id}/a.spike`, "-r", "@"], workspaceB, B.cfg);
    const change = await changeAt(B, workspaceB, "@");
    const commit = (await jj(["log", "--ignore-working-copy", "-r", change, "--no-graph", "-T", "commit_id"], replicaB, B.cfg)).trim();
    A.net.unwatch(B.id, "bye");
    B.net.unwatch(A.id, "bye");
    await until("A online to B", () => B.net.isOnline(A.id), false);

    await B.runner.archive(m.id);
    expect(getTask(B.db, m.id)).toMatchObject({ state: "archived", archived_on: B.id });
    expect(existsSync(paths(B.cfg).task(m.id))).toBe(false);
    // Its lines are its rows, held by B and archived; B's repo keeps them as refs.
    expect(listLineRows(B.db, P, m.id).map((r) => [r.name, r.holder, r.commit, r.archived])).toEqual([
      ["a", B.id, commit, true], ["a.spike", B.id, commit, true],
    ]);
    expect(await namespace(B, replicaB, m.id)).toEqual({ local: [], remote: 0 });
    expect(await lineRefs(B, replicaB, m.id)).toEqual([`refs/remotes/meddle/task/${m.id}/a ${commit}`, `refs/remotes/meddle/task/${m.id}/a.spike ${commit}`]);

    // Restored on B: the task's bookmarks come back from its rows, and the workspace starts on the archived change.
    await B.runner.restoreHere(m.id);
    expect(await changeAt(B, workspaceB, "@-")).toBe(change);
    expect(await Bun.file(join(workspaceB, "note.txt")).text()).toBe("made on B\n");
    expect((await namespace(B, replicaB, m.id)).local).toEqual([`meddle/task/${m.id}/a ${change}`, `meddle/task/${m.id}/a.spike ${change}`]);
    expect(getTask(B.db, m.id)).toMatchObject({ state: "idle", archived_on: null });
    expect(listLineRows(B.db, P, m.id).map((r) => r.archived)).toEqual([false, false]);

    // Archived again and deleted: every line released, its refs gone, the work still there.
    await B.runner.archive(m.id);
    await B.runner.deleteTask(m.id);
    expect(getTask(B.db, m.id)).toBeNull();
    expect(listLineRows(B.db, P, m.id).map((r) => [r.name, r.commit])).toEqual([["a", null], ["a.spike", null]]);
    expect(await lineRefs(B, replicaB, m.id)).toEqual([]);
    expect(await namespace(B, replicaB, m.id)).toEqual({ local: [], remote: 0 });
    expect(B.logs.filter((l) => l.startsWith("meddle: delete:") || l.startsWith("meddle: archive:") || l.startsWith("meddle: apply:"))).toEqual([]);
  } finally {
    await close();
  }
}, 45_000);

test("archiving is refused while a turn runs, while prompts are queued, and while the task moves", async () => {
  const { nodes, close } = await poolNodes(1, { nodes: [{ extraEnv: { MEDDLE_FIXTURE_STALL: "1" } }] });
  const A = nodes[0]!;
  try {
    const m = await createTask(A, { title: "t", projectIds: [A.project.id] });
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

test("writeArchive returns with the archive whole and readable and no partial write left; serve's sweep removes a stray partial write", async () => {
  const node = await setupNode();
  try {
    const m = await createTask(node, { title: "t", projectIds: [node.project.id] });
    const dir = paths(node.cfg).archives;
    const file = await writeArchive(node.cfg, node.db, m.id, paths(node.cfg).archiveFile(m.id));
    expect(await readdir(dir)).toEqual([`${m.id}.json.gz`]);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await readArchive(file)).manifest).toEqual(m);
    // What a crash mid-write leaves is swept; the archive stays.
    await writeFile(`${file}.123.1.tmp`, "half");
    await mkdir(paths(node.cfg).moved, { recursive: true });
    await writeFile(join(paths(node.cfg).moved, "other.json.gz.9.1.tmp"), "half");
    expect(await sweepArchiveTemps(node.cfg)).toBe(1);
    expect(await readdir(dir)).toEqual([`${m.id}.json.gz`]);
    expect(await sweepArchiveTemps(node.cfg)).toBe(0);
  } finally {
    await node.harness.close();
    node.db.close();
    await rm(node.home, { recursive: true, force: true });
  }
});

test("deleting an archived task whose archive stopped before its folder was removed takes the folder and workspace too", async () => {
  const { nodes, close } = await poolNodes(1);
  const A = nodes[0]!;
  try {
    const m = await createTask(A, { title: "t", projectIds: [A.project.id] });
    // The state an archive leaves when the node stops between the row update and `releaseFolder`.
    await writeArchive(A.cfg, A.db, m.id, paths(A.cfg).archiveFile(m.id));
    updateTask(A.db, m.id, { state: "archived", archived_on: A.id, archived_at: new Date().toISOString() });
    expect(existsSync(join(paths(A.cfg).task(m.id), "a"))).toBe(true);
    expect((await workspaces(A, A.project.replica)).includes(`meddle-${m.id}`)).toBe(true);
    expect((await namespace(A, A.project.replica, m.id)).local).toHaveLength(1);

    await A.runner.deleteTask(m.id);
    expect(getTask(A.db, m.id)).toBeNull();
    expect(existsSync(paths(A.cfg).task(m.id))).toBe(false);
    expect((await workspaces(A, A.project.replica)).includes(m.id)).toBe(false);
    expect(existsSync(paths(A.cfg).archiveFile(m.id))).toBe(false);
    // The task is gone: on the project's home too, its bookmarks go with it.
    expect(await namespace(A, A.project.replica, m.id)).toEqual({ local: [], remote: 0 });
  } finally {
    await close();
  }
}, 20_000);

// ─── restore anywhere (Task 8) ───

/** Sends a task with `exporter` over a fresh stream into `to` (`importTask`); the sender's receipt and the receiver's. */
async function transferInto(
  to: Awaited<ReturnType<typeof setupNode>>, taskId: string, exporter: (send: SendStream) => Promise<Receipt>,
): Promise<{ sent: Receipt; got: Receipt }> {
  const pair = await endpointPair();
  try {
    await mkdir(paths(to.cfg).taskConfig(taskId), { recursive: true });
    const { a, b } = await pair.connect(ALPN_POOL);
    const out = await a.openBi();
    const sending = exporter(out.send);
    const reader = new StreamReader((await b.acceptBi()).recv);
    const got = await importTask(to.cfg, to.db, reader, { taskId });
    return { sent: await sending, got: got.receipt };
  } finally {
    await pair.close();
  }
}

async function closeNode(n: Awaited<ReturnType<typeof setupNode>>): Promise<void> {
  await n.harness.close();
  n.db.close();
  await rm(n.home, { recursive: true, force: true });
}

/** Polls until `harness` has no `meddle.move` left (done, failed or aborted). */
async function moveSettled(node: GitPoolNode): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const { tasks } = await node.harness.harness.inspect(BACKGROUND_CONTEXT);
    const move = tasks.find((t) => t.record.kind === "meddle.move");
    if (move === undefined) return;
    if (Date.now() > deadline) throw new Error(`the move is still ${JSON.stringify(move.state)} at ${JSON.stringify(move.record.state)}`);
    await Bun.sleep(25);
  }
}

function statesOf(node: GitPoolNode, taskId: string): string[] {
  const seen: string[] = [];
  node.runner.onState((id, s) => { if (id === taskId) seen.push(s); });
  return seen;
}

function resumes(node: GitPoolNode, taskId: string): boolean[] {
  return listEvents(node.db, taskId)
    .filter((e) => (e.message as { subtype?: string }).subtype === "turn_started")
    .map((e) => (e.message as { resume: boolean }).resume);
}

test("exportArchive sends an archived task as exportTask sent it before: importTask takes the frames and the receipts match, hash included", async () => {
  const { nodes, close } = await poolNodes(1);
  const A = nodes[0]!;
  const R1 = await setupNode();
  const R2 = await setupNode();
  try {
    const m = await createTask(A, { title: "t", projectIds: [A.project.id] });
    await promptAndWait(A, m.id, "Reply with the single word ok.");
    A.db.query("INSERT INTO transcript (project_key, session_id, subpath, seq, uuid, ts, json) VALUES (?, ?, '', 1, NULL, 0, '{}')").run(m.primaryProjectId, m.sessionId);
    A.db.query("INSERT INTO transcript (project_key, session_id, subpath, seq, uuid, ts, json) VALUES (?, ?, 'subagents/x', 1, 'u', 0, '{\"a\":1}')").run(m.primaryProjectId, m.sessionId);
    await A.runner.setModel(m.id, "claude-test");
    const before = await transferInto(R1, m.id, (send) => exportTask(A.cfg, A.db, m.id, send));
    expect(before.got).toEqual(before.sent);
    expect(before.sent).toMatchObject({ transcript: 2 });
    expect(before.sent.files).toBeGreaterThan(0);

    await A.runner.archive(m.id);
    const archive = await readArchive(paths(A.cfg).archiveFile(m.id));
    const after = await transferInto(R2, m.id, (send) => exportArchive(A.cfg, archive, send));
    expect(after.sent).toEqual(before.sent);
    expect(after.got).toEqual(after.sent);
    expect(after.sent.sha256).toBe(before.sent.sha256);
  } finally {
    await closeNode(R1);
    await closeNode(R2);
    await close();
  }
}, 30_000);

test("restore with no node named lands a task archived off its project's home on the home through a move: the target takes its lines from their rows, the archive becomes the leftover, and it resumes there", async () => {
  const { A, B, close } = await twoPoolNodes();
  const owner = linkClient(A.host);
  try {
    // B is the project's home; the task ran and is archived on A.
    const m = await createTask(A, { title: "t", projectIds: [B.project.id] });
    await promptAndWait(A, m.id, "Reply with the single word ok.");
    const replicaA = paths(A.cfg).replica(B.project.id);
    const workspaceA = join(paths(A.cfg).task(m.id), "a");
    const change = await changeAt(A, workspaceA, "@");
    await A.runner.archive(m.id);
    expect(await namespace(A, replicaA, m.id)).toEqual({ local: [], remote: 0 });
    await peerReady(A, B);
    // A stray bookmark of the task's here, with no row: it never travels, and goes with the archived copy.
    await jj(["bookmark", "create", `meddle/task/${m.id}/a.stale`, "-r", "@"], replicaA, A.cfg);
    const stale = [`meddle/task/${m.id}/a.stale ${await changeAt(A, replicaA, `meddle/task/${m.id}/a.stale`)}`];

    let staged: { local: string[]; remote: number } | null = null;
    B.hooks.beforeReceive = async () => { staged = await namespace(A, replicaA, m.id); };
    const states = statesOf(A, m.id);
    const task = await owner.client.get(TaskObject, { id: m.id });
    try {
      expect(await task.restore({ node: null })).toEqual({ nodeId: B.id });
    } finally {
      task.release();
    }
    await moveSettled(A);

    // Nothing was staged here for B: it took the lines from their rows.
    expect(staged).not.toBeNull();
    expect(staged!.local).toEqual(stale);
    expect(states).toEqual(["moving", "moved"]);
    expect(getTask(A.db, m.id)).toMatchObject({ state: "moved", moved_to: B.id });
    expect(await namespace(A, replicaA, m.id)).toEqual({ local: [], remote: 0 });
    expect(countRows(A, m)).toEqual({ events: 0, transcript: 0 });
    expect(existsSync(paths(A.cfg).archiveFile(m.id))).toBe(false);
    expect((await readdir(paths(A.cfg).archives)).filter((f) => f.startsWith(m.id))).toEqual([]);
    const leftover = paths(A.cfg).movedFile(m.id);
    expect((await readArchive(leftover)).manifest).toEqual(m);
    expect(Date.now() - (await stat(leftover)).mtimeMs).toBeLessThan(60_000);
    expect(A.logs.filter((l) => l.startsWith("meddle: move:"))).toEqual([]);

    expect(getTask(B.db, m.id)).toMatchObject({ state: "idle", archived_on: null, receiving_from: null, turns: 1 });
    expect((await namespace(B, B.project.replica, m.id)).local).toEqual([`meddle/task/${m.id}/a ${change}`]);
    expect(await changeAt(B, join(paths(B.cfg).task(m.id), "a"), "@-")).toBe(change);
    await promptAndWait(B, m.id, "Carry on.");
    expect(resumes(B, m.id)).toEqual([false, true]);
  } finally {
    await owner.close();
    await close();
  }
}, 45_000);

test("restore on a named node takes the task's side lines there from their rows, and the source forgets nothing it needs", async () => {
  const { A, B, close } = await twoPoolNodes();
  try {
    // The project was added on A; the task lives on B, with a side bookmark, and is archived there.
    const m = await createTask(B, { title: "t", projectIds: [A.project.id] });
    const replicaB = paths(B.cfg).replica(A.project.id);
    const workspaceB = join(paths(B.cfg).task(m.id), "a");
    await writeFile(join(workspaceB, "note.txt"), "made on B\n");
    await jj(["bookmark", "create", `meddle/task/${m.id}/a.spike`, "-r", "@"], workspaceB, B.cfg);
    const change = await changeAt(B, workspaceB, "@");
    await B.runner.archive(m.id);
    const both = [`meddle/task/${m.id}/a ${change}`, `meddle/task/${m.id}/a.spike ${change}`];
    expect((await namespace(A, A.project.replica, m.id)).local).toEqual([]);
    expect(await namespace(B, replicaB, m.id)).toEqual({ local: [], remote: 0 });
    await peerReady(B, A);
    await peerReady(A, B);

    expect(await B.runner.restore(m.id, A.id)).toEqual({ nodeId: A.id });
    await moveSettled(B);

    expect(await namespace(B, replicaB, m.id)).toEqual({ local: [], remote: 0 });
    expect(getTask(B.db, m.id)).toMatchObject({ state: "moved", moved_to: A.id });
    expect(existsSync(paths(B.cfg).archiveFile(m.id))).toBe(false);
    expect(existsSync(paths(B.cfg).movedFile(m.id))).toBe(true);
    // A has them from the rows now, holds them, and the task runs there on the archived change.
    expect((await namespace(A, A.project.replica, m.id)).local).toEqual(both);
    expect(getTask(A.db, m.id)).toMatchObject({ state: "idle", receiving_from: null });
    await until("A's rows", () => listLineRows(A.db, A.project.id, m.id).map((r) => [r.name, r.holder, r.archived]), [["a", A.id, false], ["a.spike", A.id, false]]);
    const workspaceA = join(paths(A.cfg).task(m.id), "a");
    expect(await changeAt(A, workspaceA, "@-")).toBe(change);
    expect(await Bun.file(join(workspaceA, "note.txt")).text()).toBe("made on B\n");
  } finally {
    await close();
  }
}, 45_000);

test("restoring on a third node a task archived on the first gives that node the next epoch as it activates; one it refuses at activation leaves the first two epochs up, still archived", async () => {
  const { nodes, close } = await poolNodes(3);
  const [A, B, C] = nodes as [GitPoolNode, GitPoolNode, GitPoolNode];
  try {
    const P = A.project.id;
    const m = await createTask(A, { title: "t", projectIds: [P] });
    await promptAndWait(A, m.id, "Reply with the single word ok.");
    await A.runner.archive(m.id);
    const row = listLineRows(A.db, P, m.id)[0]!;
    const rows = (n: GitPoolNode) => listLineRows(n.db, P, m.id).map((r) => `${r.name} ${r.holder} ${r.epoch} ${r.archived}`).join();
    expect(rows(A)).toBe(`a ${A.id} ${row.epoch} true`);
    for (const [from, to] of [[A, C], [C, A]] as const) await peerReady(from, to);

    // C refuses the activation: the move rolls back, the task archived on A again, its rows above any C could write.
    let atActivation: string[] = [];
    let refuse = true;
    C.hooks.beforeActivate = () => {
      atActivation.push(rows(C));
      if (refuse) throw new Error("activation broke");
    };
    await A.runner.restore(m.id, C.id);
    await moveSettled(A);
    expect(getTask(A.db, m.id)).toMatchObject({ state: "archived", archived_on: A.id });
    expect(getTask(C.db, m.id)).toBeNull();
    expect(atActivation).toEqual([`a ${A.id} ${row.epoch} true`]);
    const back = `a ${A.id} ${row.epoch + 2} true`;
    expect(rows(A)).toBe(back);
    for (const n of [B, C]) await until("the line's row", () => rows(n), back);

    // Now C takes it: one epoch up from A's, live again, on every node.
    refuse = false;
    atActivation = [];
    expect(await A.runner.restore(m.id, C.id)).toEqual({ nodeId: C.id });
    await moveSettled(A);
    expect(getTask(C.db, m.id)).toMatchObject({ state: "idle", receiving_from: null });
    expect(atActivation).toEqual([back]);
    const taken = `a ${C.id} ${row.epoch + 3} false`;
    expect(rows(C)).toBe(taken);
    for (const n of [A, B]) await until("the line's row", () => rows(n), taken);
  } finally {
    await close();
  }
}, 60_000);

test("a restore-move the target refuses leaves the task archived on the source with its archive, nothing staged; one to an offline node is refused with the move's message", async () => {
  const { A, B, close } = await twoPoolNodes();
  try {
    // B is the project's home; the task is archived on A.
    const m = await createTask(A, { title: "t", projectIds: [B.project.id] });
    await promptAndWait(A, m.id, "Reply with the single word ok.");
    await A.runner.archive(m.id);
    const replicaA = paths(A.cfg).replica(B.project.id);
    const file = paths(A.cfg).archiveFile(m.id);
    const archived = await readArchive(file);
    await peerReady(A, B);
    await expect(A.runner.restore(m.id, "nope")).rejects.toThrow("nope is not a member of this pool");

    // B's task root is gone: its receiveTask refuses.
    await rm(B.cfg.taskRoot, { recursive: true, force: true });
    const states = statesOf(A, m.id);
    await A.runner.restore(m.id, B.id);
    await moveSettled(A);
    expect(states).toEqual(["moving", "archived"]);
    expect(getTask(A.db, m.id)).toMatchObject({ state: "archived", archived_on: A.id, moved_to: null });
    expect(A.runner.moveState(m.id)).toBeNull();
    expect(A.logs.filter((l) => l.startsWith(`meddle: move: ${m.id} failed at handoff: `))).toEqual([
      `meddle: move: ${m.id} failed at handoff: this node does not host tasks: task root ${B.cfg.taskRoot} does not exist`,
    ]);
    expect((await readArchive(file)).events).toEqual(archived.events);
    expect(await namespace(A, replicaA, m.id)).toEqual({ local: [], remote: 0 });
    expect(existsSync(paths(A.cfg).task(m.id))).toBe(false);
    expect(getTask(B.db, m.id)).toBeNull();
    expect(listArchivedTasks(A.db).map((t) => t.id)).toEqual([m.id]);
    await expect(A.runner.prompt(m.id, "hi")).rejects.toThrow("task is archived");

    // B offline: refused before anything starts, and the task stays archived.
    A.net.unwatch(B.id, "bye");
    B.net.unwatch(A.id, "bye");
    await until("B online to A", () => A.net.isOnline(B.id), false);
    await expect(A.runner.restore(m.id, B.id)).rejects.toThrow(`${shortId(B.id)} is offline`);
    expect(getTask(A.db, m.id)).toMatchObject({ state: "archived", archived_on: A.id });
    expect(existsSync(file)).toBe(true);
  } finally {
    await close();
  }
}, 45_000);

test("while a task is being restored here, a restore elsewhere is refused; the task ends idle here with no move", async () => {
  const { A, B, close } = await twoPoolNodes();
  try {
    const m = await createTask(A, { title: "t", projectIds: [A.project.id] });
    await A.runner.archive(m.id);
    await peerReady(A, B);
    // The restore here is reserved at once and then waits for the task's key, held here.
    const gate = Promise.withResolvers<void>();
    const held = serialised(taskKey(m.id), () => gate.promise);
    const here = A.runner.restoreHere(m.id);
    await expect(A.runner.restore(m.id, B.id)).rejects.toThrow("task is being restored");
    await expect(A.runner.restore(m.id, null)).rejects.toThrow("task is being restored");
    await expect(A.runner.moveTo(m.id, B.id, false, true)).rejects.toThrow("task is being restored");
    await expect(A.runner.restoreHere(m.id)).rejects.toThrow("task is being restored");
    gate.resolve();
    await held;
    await here;
    expect(getTask(A.db, m.id)).toMatchObject({ state: "idle", archived_on: null, moved_to: null });
    const { tasks } = await A.harness.harness.inspect(BACKGROUND_CONTEXT);
    expect(tasks.filter((t) => t.record.kind === "meddle.move")).toEqual([]);
    expect(getTask(B.db, m.id)).toBeNull();
    expect(A.runner.moveState(m.id)).toBeNull();
  } finally {
    await close();
  }
}, 30_000);

test("automatic placement for a restore leaves out a node running another Claude Code version: the task restores here, not on its project's home", async () => {
  const { A, B, close } = await twoPoolNodes();
  try {
    // B is the project's home, which placement would pick; A's roster says B runs another Claude Code.
    const m = await createTask(A, { title: "t", projectIds: [B.project.id] });
    await A.runner.archive(m.id);
    const summary = A.store.row(B.id)!.summary!;
    A.db.query("UPDATE roster SET summary = ? WHERE node_id = ?").run(JSON.stringify({ ...summary, claudeCodeVersion: "0.0.1-other" }), B.id);
    await expect(A.runner.restore(m.id, B.id)).rejects.toThrow(`claude code ${claudeCodeVersion()} here, 0.0.1-other there`);
    expect(await A.runner.restore(m.id, null)).toEqual({ nodeId: A.id });
    expect(getTask(A.db, m.id)).toMatchObject({ state: "idle", archived_on: null });
    expect(existsSync(join(paths(A.cfg).task(m.id), "a"))).toBe(true);
    expect(getTask(B.db, m.id)).toBeNull();
  } finally {
    await close();
  }
}, 30_000);
