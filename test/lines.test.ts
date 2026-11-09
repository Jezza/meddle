// test/lines.test.ts — a task's lines as rows: its holder writes one per bookmark under `meddle/task/<id>/` as its
// agent works and at every turn end, and every node's applier keeps the refs from them (`task/<id>/<name>@meddle` where
// another node holds the line; `meddle/task/<id>/<name>@meddle` in a checkout's fetch).
import { expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { paths, type NodeConfig } from "../src/config";
import { bookmarkRefs, git, jj, JjError } from "../src/jj";
import { listLineRows, writeBranchRow, writeLineRow } from "../src/pool/rows";
import { applyProject } from "../src/projects/applier";
import { makeCheckout } from "../src/projects/checkouts";
import { reclaimLineRows, writeLineRows } from "../src/projects/lines";
import { openDb } from "../src/store/db";
import { shortId } from "../src/pool/ids";
import { PeerObject } from "../src/state/contracts";
import { readManifest, sideBookmark } from "../src/tasks/manifest";
import { createTask, setupNode } from "./helpers";
import { peerReady, poolNodes, twoPoolNodes, type GitPoolNode } from "./pool-helpers";

const log = (cfg: NodeConfig, repo: string, rev: string, template: string) =>
  jj(["log", "--ignore-working-copy", "-r", rev, "--no-graph", "-T", template], repo, cfg).then((s) => s.trim());

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

/** Gives `node`'s project's service repo a commit of the user's on `main`, and moves `main` to it; returns its id. */
async function userCommit(node: GitPoolNode): Promise<string> {
  const home = node.project.replica;
  await jj(["new", "main"], home, node.cfg);
  await writeFile(`${home}/mine`, "mine\n");
  await jj(["commit", "-m", "mine"], home, node.cfg);
  await jj(["bookmark", "set", "main", "-r", "@-"], home, node.cfg);
  const mine = await log(node.cfg, home, "main", "commit_id");
  // `main`'s row too: a start reads the branch from its rows, and an apply puts the bookmark back at its row's position.
  writeBranchRow(node.db, node.id, { project: node.project.id, branch: "main", commit: mine, drops: [] });
  return mine;
}

/** The git refs under `prefix` in `repo`, one `<ref> <commit>` each. */
async function refsIn(cfg: NodeConfig, repo: string, prefix: string): Promise<string[]> {
  return (await git(["for-each-ref", "--format=%(refname) %(objectname)", prefix], repo, cfg)).split("\n").filter(Boolean);
}

/** Polls `get` until it returns `want`; fails with the last value after `ms` (15 s). */
async function untilValue<T>(what: string, get: () => Promise<T> | T, want: T, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    const got = await get();
    if (JSON.stringify(got) === JSON.stringify(want)) return;
    if (Date.now() > end) throw new Error(`${what} is still ${JSON.stringify(got)}, not ${JSON.stringify(want)}`);
    await Bun.sleep(50);
  }
}

/** A PATH with `node`'s `<data>/bin` first: git finds the remote helper there. */
const helperEnv = (node: GitPoolNode) => ({ PATH: `${paths(node.cfg).bin}${delimiter}${process.env.PATH}` });

/** The task's line rows of `node`'s project on `on`, as `[name, holder, commit]`. */
const rowsOf = (on: GitPoolNode, projectId: string, taskId: string) =>
  listLineRows(on.db, projectId, taskId).map((r) => [r.name, r.holder, r.commit] as const);

test("writeLineRows snapshots the task's workspace, writes a row per bookmark under its namespace as this node's, and releases a side bookmark the agent deleted, never the project's line", async () => {
  const { nodes, close } = await poolNodes(1);
  const A = nodes[0]!;
  try {
    const logs: string[] = [];
    const deps = { cfg: A.cfg, db: A.db, pool: A.pool, log: (line: string) => logs.push(line) };
    const repo = A.project.replica;
    const m = await createTask(A, { title: "t", projectIds: [A.project.id] });
    const [start] = listLineRows(A.db, A.project.id, m.id);
    expect(start).toMatchObject({ name: "a", holder: A.id, commit: m.projects[0]!.base[0]! });
    // A side bookmark, and one outside the namespace, on the start; then an edit no jj command has seen yet.
    await jj(["--ignore-working-copy", "bookmark", "create", sideBookmark(m.id, "a", "spike"), "spike", "-r", start!.commit!], repo, A.cfg);
    const workspace = join(paths(A.cfg).task(m.id), "a");
    await writeFile(join(workspace, "work"), "work\n");

    await writeLineRows(deps, m);
    const head = await log(A.cfg, repo, `meddle/task/${m.id}/a`, "commit_id");
    expect(await jj(["diff", "--ignore-working-copy", "-r", head, "--name-only"], repo, A.cfg)).toContain("work");
    expect(listLineRows(A.db, A.project.id, m.id)).toMatchObject([
      { name: "a", holder: A.id, epoch: start!.epoch, commit: head, base: start!.base, archived: false },
      { name: "a.spike", holder: A.id, epoch: start!.epoch, commit: start!.commit, base: [], archived: false },
    ]);
    // Nothing moved: nothing written.
    const seqs = listLineRows(A.db, A.project.id, m.id).map((r) => r.seq);
    await writeLineRows(deps, m);
    expect(listLineRows(A.db, A.project.id, m.id).map((r) => r.seq)).toEqual(seqs);

    // A side line another node released below the task's epoch is taken at it when the agent bookmarks it again.
    const other = "f".repeat(64);
    const spikeRow = listLineRows(A.db, A.project.id, m.id)[1]!;
    writeLineRow(A.db, { ...spikeRow, holder: other, epoch: start!.epoch - 1, commit: null });
    await writeLineRows(deps, m);
    expect(listLineRows(A.db, A.project.id, m.id)[1]).toMatchObject({ name: "a.spike", holder: A.id, epoch: start!.epoch, commit: start!.commit });

    // A line another node holds is not this node's to write: no snapshot, no bookmark moved, no row written.
    const held = writeLineRow(A.db, { ...start!, holder: other, epoch: start!.epoch + 1, commit: start!.commit });
    const before = listLineRows(A.db, A.project.id, m.id);
    await writeFile(join(workspace, "late"), "late\n");
    await jj(["--ignore-working-copy", "bookmark", "delete", `exact:${sideBookmark(m.id, "a", "spike")}`], repo, A.cfg);
    expect(logs).toEqual([]);
    await writeLineRows(deps, m);
    expect(listLineRows(A.db, A.project.id, m.id)).toEqual(before);
    expect(await log(A.cfg, repo, `meddle/task/${m.id}/a`, "commit_id")).toBe(head);
    expect(logs).toEqual([
      `meddle: line: ${m.id}'s line ${shortId(A.project.id)}/a is held by ${shortId(other)} at epoch ${held.epoch}; not written here`,
    ]);
    logs.length = 0;
    // Taken back here (as a rollback does), it is written again at its epoch.
    writeLineRow(A.db, { ...held, holder: A.id, epoch: held.epoch + 1 });
    await jj(["--ignore-working-copy", "bookmark", "create", sideBookmark(m.id, "a", "spike"), "-r", start!.commit!], repo, A.cfg);
    await writeLineRows(deps, m);
    const newHead = await log(A.cfg, repo, `meddle/task/${m.id}/a`, "commit_id");
    expect(newHead).not.toBe(head);
    expect(listLineRows(A.db, A.project.id, m.id)[0]).toMatchObject({ name: "a", holder: A.id, epoch: start!.epoch + 2, commit: newHead });

    // The agent deletes both its bookmarks: the side line is released (holder and epoch kept), the project's stays.
    await jj(["--ignore-working-copy", "bookmark", "delete", `exact:meddle/task/${m.id}/a`, `exact:${sideBookmark(m.id, "a", "spike")}`], repo, A.cfg);
    await writeLineRows(deps, m);
    expect(listLineRows(A.db, A.project.id, m.id)).toMatchObject([
      { name: "a", holder: A.id, commit: newHead },
      { name: "a.spike", holder: A.id, epoch: start!.epoch, commit: null },
    ]);
    expect(await log(A.cfg, repo, `meddle/task/${m.id}/a`, "commit_id")).toBe(newHead);
  } finally {
    await close();
  }
}, 60_000);

test("reclaimLineRows takes a rolled-back task's live rows back above any epoch the target could have written", () => {
  const db = openDb(":memory:");
  try {
    const [self, target] = ["a".repeat(64), "b".repeat(64)];
    const [c1, c2] = ["1".repeat(40), "2".repeat(40)];
    const row = { project: "p", task: "t", base: [], archived: false };
    // A line still this node's (the target never activated), one the target took (its answer was lost), one released.
    writeLineRow(db, { ...row, name: "a", holder: self, epoch: 4, commit: c1 });
    writeLineRow(db, { ...row, name: "a.side", holder: target, epoch: 5, commit: c2 });
    writeLineRow(db, { ...row, name: "a.gone", holder: self, epoch: 4, commit: null });
    expect(reclaimLineRows(db, self, "t", true)).toEqual(["a", "a.side"]);
    expect(listLineRows(db, "p", "t").map((r) => [r.name, r.holder === self, r.epoch, r.commit, r.archived])).toEqual([
      ["a", true, 6, c1, true], ["a.gone", true, 4, null, false], ["a.side", true, 6, c2, true],
    ]);
  } finally {
    db.close();
  }
});

test("writeLineRows archives a conflicted bookmark's row too, keeping the commit it had", async () => {
  const { nodes, close } = await poolNodes(1);
  const A = nodes[0]!;
  try {
    const deps = { cfg: A.cfg, db: A.db, pool: A.pool };
    const repo = A.project.replica;
    const m = await createTask(A, { title: "t", projectIds: [A.project.id] });
    const spike = sideBookmark(m.id, "a", "spike");
    const base = m.projects[0]!.base[0]!;
    await jj(["--ignore-working-copy", "bookmark", "create", spike, "-r", base], repo, A.cfg);
    await writeLineRows(deps, m);
    expect(listLineRows(A.db, A.project.id, m.id)[1]).toMatchObject({ name: "a.spike", commit: base, archived: false });

    // Two operations from the same one set it apart: jj holds it conflicted.
    const op = (await jj(["op", "log", "--ignore-working-copy", "--no-graph", "-n", "1", "-T", "id"], repo, A.cfg)).trim();
    const other = await log(A.cfg, repo, `meddle/task/${m.id}/a`, "commit_id");
    await jj(["--ignore-working-copy", "bookmark", "set", spike, "-r", "root()", "--allow-backwards"], repo, A.cfg);
    await jj(["--ignore-working-copy", "--at-op", op, "bookmark", "set", spike, "-r", other], repo, A.cfg);
    expect((await bookmarkRefs(repo, `exact:${spike}`, A.cfg)).find((b) => b.remote === null)?.conflicted).toBe(true);

    await writeLineRows(deps, m, { archived: true });
    expect(listLineRows(A.db, A.project.id, m.id).map((r) => [r.name, r.commit, r.archived])).toEqual([
      ["a", other, true], ["a.spike", base, true],
    ]);
  } finally {
    await close();
  }
}, 60_000);

test("PeerObject.taskHeld says whether a node holds a task", async () => {
  const { A, B, close } = await twoPoolNodes();
  try {
    await peerReady(B, A);
    await peerReady(A, B);
    const m = await createTask(B, { title: "t", projectIds: [A.project.id] });
    const onB = await A.pool.peerRef(B.id, PeerObject);
    try {
      if (onB.variant !== "peer") throw new Error("expected the peer variant");
      expect(await onB.taskHeld({ id: m.id })).toBe(true);
      expect(await onB.taskHeld({ id: "nope" })).toBe(false);
    } finally {
      onB.release();
    }
  } finally {
    await close();
  }
}, 30_000);

test("a turn end on one node makes the task's line appear in a checkout's fetch on another, as meddle/task/<t>/<p>@meddle", async () => {
  const { A, B, close } = await twoPoolNodes();
  try {
    await peerReady(A, B);
    await peerReady(B, A);
    const co = await makeCheckout(A.cfg, A.id, A.project, `${A.home}/co`, helperEnv(A));
    const m = await createTask(B, { title: "t", projectIds: [A.project.id] });
    await writeFile(join(paths(B.cfg).task(m.id), "a", "work"), "work\n");
    await promptAndWait(B, m.id, "Reply with the single word ok.");
    const head = await log(B.cfg, paths(B.cfg).replica(A.project.id), `meddle/task/${m.id}/a`, "commit_id");
    expect(head).not.toBe(m.projects[0]!.base[0]!);

    await jj(["git", "fetch", "--remote", "meddle"], co, A.cfg);
    const fetched = (await bookmarkRefs(co, `exact:meddle/task/${m.id}/a`, A.cfg)).find((r) => r.remote === "meddle");
    expect(fetched).toMatchObject({ commitId: head, tracked: false });
    expect(await log(A.cfg, co, head, "immutable")).toBe("true");
    expect([...A.logs, ...B.logs].filter((l) => l.startsWith("meddle: git:") || l.startsWith("meddle: line"))).toEqual([]);
  } finally {
    await close();
  }
}, 60_000);

test("an Edit the agent makes mid-turn moves its line within 6 s, before the turn ends", async () => {
  // The stand-in calls the PostToolUse hooks for an Edit before its `result`, which it then holds back 12 s.
  const { nodes, close } = await poolNodes(1, { nodes: [{ extraEnv: { MEDDLE_FIXTURE_TOOL_USE: "Edit", MEDDLE_FIXTURE_RESULTS_MS: "12000" } }] });
  const A = nodes[0]!;
  try {
    const m = await createTask(A, { title: "t", projectIds: [A.project.id] });
    const start = listLineRows(A.db, A.project.id, m.id)[0]!.commit;
    await writeFile(join(paths(A.cfg).task(m.id), "a", "work"), "work\n");
    // The last message before the hook: the stand-in calls it right after, as it reaches its `result`.
    let lastEvent = 0;
    let result = false;
    const offEvents = A.runner.onEvent((id, _seq, msg) => {
      if (id !== m.id) return;
      lastEvent = Date.now();
      if (msg.type === "result") result = true;
    });
    const idle = new Promise<void>((res) => {
      const off = A.runner.onState((id, s) => { if (id === m.id && s === "idle") { off(); res(); } });
    });
    await A.runner.prompt(m.id, "Reply with the single word ok.");
    const deadline = Date.now() + 20_000;
    let moved: string | null = start;
    while (moved === start) {
      if (Date.now() > deadline) throw new Error("the line never moved mid-turn");
      await Bun.sleep(25);
      moved = listLineRows(A.db, A.project.id, m.id)[0]!.commit;
    }
    const after = Date.now() - lastEvent;
    offEvents();
    // Moved by the hook's write, not the turn end's: the turn has had no `result` yet.
    expect(result).toBe(false);
    expect(A.runner.state(m.id)).toBe("running");
    expect(after).toBeLessThan(6000);
    expect(await jj(["diff", "--ignore-working-copy", "-r", moved!, "--name-only"], A.project.replica, A.cfg)).toContain("work");
    await idle;
  } finally {
    await close();
  }
}, 60_000);

test("a side bookmark the agent deleted is released on the other node at the next turn end, and the project's line is kept", async () => {
  const { A, B, close } = await twoPoolNodes();
  try {
    await peerReady(B, A);
    await peerReady(A, B);
    const P = A.project.id;
    const m = await createTask(B, { title: "t", projectIds: [P] });
    const workspace = join(paths(B.cfg).task(m.id), "a");
    await writeFile(join(workspace, "spike"), "spike\n");
    await jj(["commit", "-m", "spike"], workspace, B.cfg);
    await jj(["bookmark", "create", sideBookmark(m.id, "a", "spike"), "-r", "@-"], workspace, B.cfg);
    const spike = await log(B.cfg, workspace, "@-", "commit_id");
    await promptAndWait(B, m.id, "Reply with the single word ok.");
    const head = await log(B.cfg, workspace, "@", "commit_id");
    // On A, from B's rows: both lines, held by B, as remote refs once applied.
    await untilValue("B's rows on A", () => rowsOf(A, P, m.id), [["a", B.id, head], ["a.spike", B.id, spike]]);
    await applyProject({ cfg: A.cfg, db: A.db, pool: A.pool }, P, 10_000);
    expect(await refsIn(A.cfg, A.project.replica, `refs/remotes/meddle/task/${m.id}`)).toEqual([
      `refs/remotes/meddle/task/${m.id}/a ${head}`,
      `refs/remotes/meddle/task/${m.id}/a.spike ${spike}`,
    ]);

    await jj(["bookmark", "delete", `exact:${sideBookmark(m.id, "a", "spike")}`], workspace, B.cfg);
    await promptAndWait(B, m.id, "Again.");
    await untilValue("B's rows on A", () => rowsOf(A, P, m.id), [["a", B.id, head], ["a.spike", B.id, null]]);
    await applyProject({ cfg: A.cfg, db: A.db, pool: A.pool }, P, 10_000);
    expect(await refsIn(A.cfg, A.project.replica, `refs/remotes/meddle/task/${m.id}`)).toEqual([`refs/remotes/meddle/task/${m.id}/a ${head}`]);
    // Released through jj: the spike's commit is still there.
    expect(await log(A.cfg, A.project.replica, spike, "commit_id")).toBe(spike);
  } finally {
    await close();
  }
}, 60_000);

test("a turn end and an applier pass leave a checkout's operation log and git refs byte-identical (Review Focus 5)", async () => {
  const { nodes, close } = await poolNodes(1);
  const A = nodes[0]!;
  try {
    const co = await makeCheckout(A.cfg, A.id, A.project, `${A.home}/co`, helperEnv(A));
    // An edit no jj command has seen yet: any snapshot of the checkout would record it.
    await writeFile(join(co, "edited.txt"), "mine\n");
    const state = async () => ({
      ops: await jj(["op", "log", "--ignore-working-copy", "--no-graph", "-T", 'id ++ "\\n"'], co, A.cfg),
      refs: await git(["show-ref"], co, A.cfg),
    });
    const before = await state();

    const m = await createTask(A, { title: "t", projectIds: [A.project.id] });
    await writeFile(join(paths(A.cfg).task(m.id), "a", "work"), "work\n");
    await promptAndWait(A, m.id, "Reply with the single word ok.");
    await applyProject({ cfg: A.cfg, db: A.db, pool: A.pool }, A.project.id, 10_000);
    expect(await state()).toEqual(before);
  } finally {
    await close();
  }
}, 60_000);

test("the agent's workspace can describe its line's head but not its base", async () => {
  const { A, close } = await twoPoolNodes();
  try {
    const home = A.project.replica;
    const mine = await userCommit(A);
    const m = await createTask(A, { title: "t", projectIds: [A.project.id] });
    expect((await readManifest(A.cfg, m.id)).projects[0]!.base).toEqual([mine]);
    const workspace = join(paths(A.cfg).task(m.id), "a");
    await writeFile(join(workspace, "work"), "work\n");
    await promptAndWait(A, m.id, "Reply with the single word ok.");
    const head = await log(A.cfg, home, `meddle/task/${m.id}/a`, "commit_id");
    expect(await log(A.cfg, workspace, "@", "commit_id")).toBe(head);
    expect(await log(A.cfg, workspace, "@-", "commit_id")).toBe(mine);

    await jj(["describe", "-r", head, "-m", "by the agent"], workspace, A.cfg);
    expect(await log(A.cfg, workspace, "@", "description")).toBe("by the agent");
    const refused = await jj(["describe", "-r", mine, "-m", "not the agent's"], workspace, A.cfg).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(JjError);
    expect((refused as JjError).stderr).toContain(`Commit ${mine.slice(0, 12)} is immutable`);
    expect(await log(A.cfg, home, mine, "description")).toBe("mine");
  } finally {
    await close();
  }
}, 30_000);

test("setting a task's bookmarks never snapshots the service repo's own working copy", async () => {
  const node = await setupNode();
  try {
    const { cfg, project, runner } = node;
    const repo = project.replica;
    const m = await createTask(node, { title: "t", projectIds: [project.id] });
    // An edit in the service repo's working copy that no jj command has seen yet.
    await writeFile(`${repo}/edited.txt`, "mine\n");
    await writeFile(join(paths(cfg).task(m.id), "a", "work"), "work\n");
    await runner.setTaskBookmarks(await readManifest(cfg, m.id));
    // The task's own working copy was snapshotted into its bookmark; the service repo's was not.
    expect(await jj(["diff", "--ignore-working-copy", "-r", `meddle/task/${m.id}/a`, "--name-only"], repo, cfg)).toContain("work");
    expect(await jj(["diff", "--ignore-working-copy", "-r", "default@", "--name-only"], repo, cfg)).not.toContain("edited.txt");
  } finally {
    await node.harness.close();
    await rm(node.home, { recursive: true, force: true });
  }
}, 30_000);
