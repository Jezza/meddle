// test/accept.test.ts — a task's work is accepted by a push: once a branch's computed position contains the task's line
// head, for every project of it, the task's holder archives it (at once when idle, at its turn's end when mid-turn),
// its lines released. Some projects only is "partly accepted"; a conflicted branch accepts nothing.
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { paths, type NodeConfig } from "../src/config";
import { git, initColocated, jj } from "../src/jj";
import { shortId } from "../src/pool/ids";
import { listLineRows, mergeBranchRows, writeBranchRow } from "../src/pool/rows";
import { startApplier } from "../src/projects/applier";
import { makeCheckout } from "../src/projects/checkouts";
import { addProjectFromFolder, type Project } from "../src/projects/project";
import { TaskObject } from "../src/state/contracts";
import { getTask } from "../src/store/records";
import { acceptance } from "../src/tasks/accept";
import { createTask } from "./helpers";
import { linkClient, peerReady, poolNodes, twoPoolNodes, type GitPoolNode } from "./pool-helpers";

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

/** Polls `get` until it returns `want`; fails with the last value after `ms` (20 s). */
async function until<T>(what: string, get: () => Promise<T> | T, want: T, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    const got = await get();
    if (JSON.stringify(got) === JSON.stringify(want)) return;
    if (Date.now() > end) throw new Error(`${what} is still ${JSON.stringify(got)}, not ${JSON.stringify(want)}`);
    await Bun.sleep(50);
  }
}

const read = async (cfg: NodeConfig, repo: string, rev: string, template = "commit_id") =>
  (await jj(["log", "--ignore-working-copy", "-r", rev, "--no-graph", "-T", template], repo, cfg)).trim();

/** A PATH with `node`'s `<data>/bin` first: git finds the remote helper there. */
const helperEnv = (node: GitPoolNode) => ({ PATH: `${paths(node.cfg).bin}${delimiter}${process.env.PATH}` });

/** The commit of task `taskId`'s line `name` of project `projectId` as `node`'s rows have it. */
const lineHead = (node: GitPoolNode, projectId: string, taskId: string, name: string) =>
  listLineRows(node.db, projectId, taskId).find((r) => r.name === name)?.commit ?? null;

/** Task `taskId`'s line rows on `node`, as `name commit`. */
const linesOf = (node: GitPoolNode, taskId: string) =>
  listLineRows(node.db, undefined, taskId).map((r) => `${r.name} ${r.commit}`);

/** Task `taskId`'s line refs in `repo` (`refs/remotes/meddle/task/<id>/*`) and in its view. */
async function lineRefs(node: GitPoolNode, repo: string, taskId: string): Promise<string[]> {
  const out = await git(["for-each-ref", "--format=%(refname)", `refs/remotes/meddle/task/${taskId}`, `refs/namespaces/view/refs/heads/meddle/task/${taskId}`], repo, node.cfg);
  return out.split("\n").filter(Boolean);
}

/**
 * Fast-forwards `main` of `project` onto `commit` in a checkout of it on `node` (made the first time) and pushes it:
 * what you do to accept a task's work.
 */
async function pushMain(node: GitPoolNode, project: Pick<Project, "id" | "name">, commit: string): Promise<void> {
  const co = `${node.home}/co-${project.name}`;
  if (!existsSync(co)) await makeCheckout(node.cfg, node.id, project, co, helperEnv(node));
  else await jj(["git", "fetch", "--remote", "meddle"], co, node.cfg);
  await jj(["bookmark", "set", "main", "-r", commit], co, node.cfg);
  await jj(["git", "push", "--remote", "meddle", "-b", "main"], co, node.cfg);
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

test("a push of main onto an idle task's line archives the task on its holder, and its lines are released on every node", async () => {
  const { A, B, close } = await twoPoolNodes();
  const stops = [A, B].map((n) => startApplier({ cfg: n.cfg, db: n.db, pool: n.pool, log: (line) => n.logs.push(line) }));
  try {
    await peerReady(A, B);
    await peerReady(B, A);
    const P = A.project;
    await until("A's project in B's roster", () => B.store.row(A.id)?.summary?.projects.some((p) => p.id === P.id) === true, true);
    const m = await createTask(A, { title: "t", projectIds: [P.id] });
    // A new task's line starts where main is: that is no work of its own, and nothing is accepted.
    expect(lineHead(A, P.id, m.id, "a")).toBe(await read(A.cfg, P.replica, "main"));
    expect(await acceptance({ cfg: A.cfg, db: A.db, pool: A.pool }, m)).toBe("no");
    await writeFile(join(paths(A.cfg).task(m.id), "a", "work"), "work\n");
    await promptAndWait(A, m.id, "Reply with the single word ok.");
    const head = lineHead(A, P.id, m.id, "a")!;
    expect(await read(A.cfg, P.replica, `${head}-`)).toBe(await read(A.cfg, P.replica, "main"));
    expect(A.runner.acceptance(m.id)).toBe("no");
    const replicaB = paths(B.cfg).replica(P.id);
    // B has the line as A's: a row, and a ref its checkout fetches.
    await until("the line's view ref on B", async () => (await lineRefs(B, replicaB, m.id)).length, 2);

    // You fast-forward main onto the task's line in a checkout on B, and push it.
    await pushMain(B, P, head);

    await until("the task's state on A", () => getTask(A.db, m.id)?.state, "archived");
    expect(getTask(A.db, m.id)).toMatchObject({ state: "archived", archived_on: A.id });
    // Released, not kept: every row of the task's lines, on both nodes, and the refs they made.
    await until("A's line rows", () => linesOf(A, m.id), ["a null"]);
    expect(existsSync(paths(A.cfg).task(m.id))).toBe(false);
    await until("B's line rows", () => linesOf(B, m.id), ["a null"]);
    await until("A's line refs", () => lineRefs(A, P.replica, m.id), []);
    await until("B's line refs", () => lineRefs(B, replicaB, m.id), []);
    // The work is main's now.
    expect(await read(A.cfg, P.replica, "main")).toBe(head);
    expect(A.logs.filter((l) => l.startsWith("meddle: accept:"))).toEqual([]);
  } finally {
    for (const stop of stops) stop();
    await close();
  }
}, 90_000);

test("the same push mid-turn archives the task only as its turn ends", async () => {
  const { nodes, close } = await poolNodes(1, { nodes: [{ extraEnv: { MEDDLE_FIXTURE_RESULTS_MS: "6000" } }] });
  const A = nodes[0]!;
  try {
    const P = A.project;
    const m = await createTask(A, { title: "t", projectIds: [P.id] });
    const ended = new Promise<void>((res) => {
      let ran = false;
      const off = A.runner.onState((id, s) => {
        if (id !== m.id) return;
        if (s === "running") ran = true;
        else if (s !== "waiting" && ran) { off(); res(); }
      });
    });
    await A.runner.prompt(m.id, "Reply with the single word ok.");
    await until("the task's state", () => A.runner.state(m.id), "running");
    // The agent's work, written mid-turn as its tool calls write it.
    await writeFile(join(paths(A.cfg).task(m.id), "a", "work"), "work\n");
    await A.runner.writeTaskLines(m.id);
    const head = lineHead(A, P.id, m.id, "a")!;

    await pushMain(A, P, head);
    // Seen as accepted, and still running: nothing is archived mid-turn.
    await until("the task's acceptance", () => A.runner.acceptance(m.id), "accepted");
    expect(A.runner.state(m.id)).toBe("running");
    expect(linesOf(A, m.id)).toEqual([`a ${head}`]);
    expect(existsSync(paths(A.cfg).task(m.id))).toBe(true);

    await ended;
    await until("the task's state", () => getTask(A.db, m.id)?.state, "archived");
    await until("A's line rows", () => linesOf(A, m.id), ["a null"]);
    await until("A's line refs", () => lineRefs(A, P.replica, m.id), []);
  } finally {
    await close();
  }
}, 60_000);

test("a two-project task with one project pushed is partly accepted, shown so, and stays live until the other is pushed too", async () => {
  const { nodes, close } = await poolNodes(1);
  const A = nodes[0]!;
  const owner = linkClient(A.host);
  try {
    const a = A.project;
    const b = await secondProject(A, "b");
    const m = await createTask(A, { title: "t", projectIds: [a.id, b.id] });
    for (const p of m.projects) await writeFile(join(paths(A.cfg).task(m.id), p.workspace, "work"), `${p.name}\n`);
    await promptAndWait(A, m.id, "Reply with the single word ok.");
    const headA = lineHead(A, a.id, m.id, "a")!;
    const headB = lineHead(A, b.id, m.id, "b")!;
    const task = await owner.client.get(TaskObject, { id: m.id });
    try {
      expect(task.acceptance.value).toBe("no");
      await pushMain(A, a, headA);
      await until("the task's acceptance", () => task.acceptance.value, "partly");
      expect(A.runner.acceptance(m.id)).toBe("partly");
      expect(await acceptance({ cfg: A.cfg, db: A.db, pool: A.pool }, m)).toBe("partly");
      expect(A.runner.state(m.id)).toBe("idle");
      expect(linesOf(A, m.id).sort()).toEqual([`a ${headA}`, `b ${headB}`]);

      await pushMain(A, b, headB);
      await until("the task's state", () => getTask(A.db, m.id)?.state, "archived");
      await until("A's line rows", () => linesOf(A, m.id).sort(), ["a null", "b null"]);
    } finally {
      task.release();
    }
  } finally {
    await owner.close();
    await close();
  }
}, 60_000);

test("a conflicted branch containing the task's line archives nothing, until it is resolved", async () => {
  const { nodes, close } = await poolNodes(1);
  const A = nodes[0]!;
  try {
    const P = A.project;
    const repo = P.replica;
    const init = await read(A.cfg, repo, "main");
    const m = await createTask(A, { title: "t", projectIds: [P.id] });
    await writeFile(join(paths(A.cfg).task(m.id), "a", "work"), "work\n");
    await promptAndWait(A, m.id, "Reply with the single word ok.");
    const head = lineHead(A, P.id, m.id, "a")!;
    // Another node's push of main to a sibling of the task's work: main is at the sibling.
    await jj(["new", init], repo, A.cfg);
    await writeFile(`${repo}/theirs`, "theirs\n");
    await jj(["commit", "-m", "theirs"], repo, A.cfg);
    const theirs = await read(A.cfg, repo, "@-");
    const other = "f".repeat(64);
    mergeBranchRows(A.db, [{ project: P.id, branch: "main", node: other, seq: 1, commit: theirs, drops: [] }]);
    // This node's push of main onto the task's line, not having seen that one: main is conflicted.
    writeBranchRow(A.db, A.id, { project: P.id, branch: "main", commit: head, drops: [] });
    const deps = { cfg: A.cfg, db: A.db, pool: A.pool };
    expect(await acceptance(deps, m)).toBe("no");
    await Bun.sleep(2000);
    expect(A.runner.acceptance(m.id)).toBe("no");
    expect(getTask(A.db, m.id)?.state).toBe("idle");
    expect(linesOf(A, m.id)).toEqual([`a ${head}`]);

    // The sibling dropped: main is the task's line, and the task is accepted.
    writeBranchRow(A.db, A.id, { project: P.id, branch: "main", commit: head, drops: [{ node: other, seq: 1 }] });
    await until("the task's state", () => getTask(A.db, m.id)?.state, "archived");
    await until("A's line rows", () => linesOf(A, m.id), ["a null"]);
  } finally {
    await close();
  }
}, 60_000);

/** Task `taskId`'s line rows on `node`, as `name commit holder archived`, by name. */
const heldOf = (node: GitPoolNode, taskId: string) =>
  listLineRows(node.db, undefined, taskId).map((r) => `${r.name} ${r.commit} ${r.holder === node.id ? "here" : r.holder} ${r.archived}`).sort();

test("a two-project task with work in one project only is accepted once that one is pushed; the untouched project's line, which main contains, is released too", async () => {
  const { nodes, close } = await poolNodes(1);
  const A = nodes[0]!;
  try {
    const a = A.project;
    const b = await secondProject(A, "b");
    const m = await createTask(A, { title: "t", projectIds: [a.id, b.id] });
    // The agent works in a only; b's line is the empty change a turn end leaves on top of its start.
    await writeFile(join(paths(A.cfg).task(m.id), "a", "work"), "a\n");
    await promptAndWait(A, m.id, "Reply with the single word ok.");
    const headA = lineHead(A, a.id, m.id, "a")!;
    const headB = lineHead(A, b.id, m.id, "b")!;
    expect(await read(A.cfg, b.replica, `${headB}-`)).toBe(await read(A.cfg, b.replica, "main"));
    expect(await acceptance({ cfg: A.cfg, db: A.db, pool: A.pool }, m)).toBe("no");

    await pushMain(A, a, headA);
    await until("the task's state", () => getTask(A.db, m.id)?.state, "archived");
    // b's line is main's start under an empty change: main holds all of it, so it goes like a's.
    await until("A's line rows", () => heldOf(A, m.id), ["a null here true", "b null here true"]);
    await until("a's line refs", () => lineRefs(A, a.replica, m.id), []);
    await until("b's line refs", () => lineRefs(A, b.replica, m.id), []);
  } finally {
    await close();
  }
}, 60_000);

test("a side line the pushed branch does not contain keeps its archived row and its ref after acceptance", async () => {
  const { nodes, close } = await poolNodes(1);
  const A = nodes[0]!;
  try {
    const P = A.project;
    const m = await createTask(A, { title: "t", projectIds: [P.id] });
    const workspace = join(paths(A.cfg).task(m.id), "a");
    // A spike the agent keeps on a side line, and its work on the task's line beside it.
    await writeFile(join(workspace, "spike"), "spike\n");
    await jj(["commit", "-m", "spike"], workspace, A.cfg);
    await jj(["bookmark", "create", `meddle/task/${m.id}/a.spike`, "-r", "@-"], workspace, A.cfg);
    await jj(["new", "@--"], workspace, A.cfg);
    await writeFile(join(workspace, "work"), "work\n");
    await promptAndWait(A, m.id, "Reply with the single word ok.");
    const head = lineHead(A, P.id, m.id, "a")!;
    const spike = lineHead(A, P.id, m.id, "a.spike")!;
    expect(await read(A.cfg, P.replica, `${spike} & ::${head}`)).toBe("");

    await pushMain(A, P, head);
    await until("the task's state", () => getTask(A.db, m.id)?.state, "archived");
    await until("A's line rows", () => heldOf(A, m.id), ["a null here true", `a.spike ${spike} here true`]);
    await until("A's line refs", () => lineRefs(A, P.replica, m.id), [`refs/remotes/meddle/task/${m.id}/a.spike`]);
    expect(await read(A.cfg, P.replica, `task/${m.id}/a.spike@meddle`)).toBe(spike);
  } finally {
    await close();
  }
}, 60_000);

/** A commit of yours on `main` of `project`, made in a checkout of it on `node` and pushed; returns its id. */
async function userCommit(node: GitPoolNode, project: Pick<Project, "id" | "name">): Promise<string> {
  const co = `${node.home}/co-${project.name}`;
  if (!existsSync(co)) await makeCheckout(node.cfg, node.id, project, co, helperEnv(node));
  else await jj(["git", "fetch", "--remote", "meddle"], co, node.cfg);
  await jj(["new", "main"], co, node.cfg);
  await writeFile(`${co}/yours`, "yours\n");
  await jj(["commit", "-m", "yours"], co, node.cfg);
  const commit = await read(node.cfg, co, "@-");
  await pushMain(node, project, commit);
  return commit;
}

test("an untouched project whose line is rebased onto a moved main counts as contained, the task partly accepted until the other is pushed", async () => {
  const { nodes, close } = await poolNodes(1);
  const A = nodes[0]!;
  try {
    const a = A.project;
    const b = await secondProject(A, "b");
    const m = await createTask(A, { title: "t", projectIds: [a.id, b.id] });
    await writeFile(join(paths(A.cfg).task(m.id), "a", "work"), "a\n");
    await promptAndWait(A, m.id, "Reply with the single word ok.");
    const headA = lineHead(A, a.id, m.id, "a")!;
    // You move b's main on, and the agent rebases its untouched line onto it.
    const moved = await userCommit(A, b);
    await jj(["rebase", "-r", "@", "-d", moved], join(paths(A.cfg).task(m.id), "b"), A.cfg);
    await A.runner.writeTaskLines(m.id);
    const headB = lineHead(A, b.id, m.id, "b")!;
    expect(await read(A.cfg, b.replica, `${headB}-`)).toBe(moved);
    // b's line, an empty change on the moved main, is above its base and main contains it; a's is not pushed.
    const deps = { cfg: A.cfg, db: A.db, pool: A.pool };
    expect(await acceptance(deps, m)).toBe("partly");
    await until("the task's acceptance", () => A.runner.acceptance(m.id), "partly");

    await pushMain(A, a, headA);
    await until("the task's state", () => getTask(A.db, m.id)?.state, "archived");
    await until("A's line rows", () => heldOf(A, m.id), ["a null here true", "b null here true"]);
  } finally {
    await close();
  }
}, 60_000);

test("a line with an empty change above its committed work is accepted when main is fast-forwarded onto the committed work", async () => {
  const { nodes, close } = await poolNodes(1);
  const A = nodes[0]!;
  try {
    const P = A.project;
    const m = await createTask(A, { title: "t", projectIds: [P.id] });
    const workspace = join(paths(A.cfg).task(m.id), "a");
    await writeFile(join(workspace, "work"), "work\n");
    await jj(["commit", "-m", "work"], workspace, A.cfg);
    await promptAndWait(A, m.id, "Reply with the single word ok.");
    const head = lineHead(A, P.id, m.id, "a")!;
    const work = await read(A.cfg, P.replica, `${head}-`);
    expect(await read(A.cfg, P.replica, head, "empty")).toBe("true");

    await pushMain(A, P, work);
    await until("the task's state", () => getTask(A.db, m.id)?.state, "archived");
    await until("A's line rows", () => linesOf(A, m.id), ["a null"]);
  } finally {
    await close();
  }
}, 60_000);

test("an agent that starts over with jj new main keeps its earlier attempt as a side line, which stays archived with its ref once the task is accepted", async () => {
  const { nodes, close } = await poolNodes(1);
  const A = nodes[0]!;
  try {
    const P = A.project;
    const m = await createTask(A, { title: "t", projectIds: [P.id] });
    const workspace = join(paths(A.cfg).task(m.id), "a");
    await writeFile(join(workspace, "attempt"), "attempt\n");
    await promptAndWait(A, m.id, "Reply with the single word ok.");
    const attempt = lineHead(A, P.id, m.id, "a")!;
    // You move main on; the agent drops its attempt and starts again from main.
    const moved = await userCommit(A, P);
    await jj(["new", "main"], workspace, A.cfg);
    await A.runner.writeTaskLines(m.id);
    expect(A.logs).toContain(`meddle: line: ${m.id}'s line ${shortId(P.id)}/a moved off its work at ${attempt.slice(0, 12)}; kept as a.before-1`);

    // Its line is an empty change on main: main contains it, and the task is accepted. The attempt is not lost.
    await until("the task's state", () => getTask(A.db, m.id)?.state, "archived");
    await until("A's line rows", () => heldOf(A, m.id), ["a null here true", `a.before-1 ${attempt} here true`]);
    await until("A's line refs", () => lineRefs(A, P.replica, m.id), [`refs/remotes/meddle/task/${m.id}/a.before-1`]);
    expect(await read(A.cfg, P.replica, `task/${m.id}/a.before-1@meddle`)).toBe(attempt);
    expect(await read(A.cfg, P.replica, "main")).toBe(moved);
  } finally {
    await close();
  }
}, 60_000);

test("a line rebased onto a moved main, or squashed into its own commit, keeps no .before- side line", async () => {
  const { nodes, close } = await poolNodes(1);
  const A = nodes[0]!;
  try {
    const P = A.project;
    const m = await createTask(A, { title: "t", projectIds: [P.id] });
    const workspace = join(paths(A.cfg).task(m.id), "a");
    await writeFile(join(workspace, "work"), "work\n");
    await jj(["commit", "-m", "work"], workspace, A.cfg);
    await writeFile(join(workspace, "more"), "more\n");
    await promptAndWait(A, m.id, "Reply with the single word ok.");
    // You move main on; the agent rebases its work onto it.
    const moved = await userCommit(A, P);
    await jj(["rebase", "-b", "@", "-d", "main"], workspace, A.cfg);
    await A.runner.writeTaskLines(m.id);
    const rebased = lineHead(A, P.id, m.id, "a")!;
    expect(await read(A.cfg, P.replica, `${rebased}--`)).toBe(moved);
    // Then it squashes its last change into the commit below: that change's id is gone, its work is not.
    await jj(["squash"], workspace, A.cfg);
    await A.runner.writeTaskLines(m.id);
    expect(await read(A.cfg, P.replica, `${lineHead(A, P.id, m.id, "a")!}--`)).toBe(moved);
    expect(linesOf(A, m.id).map((l) => l.split(" ")[0])).toEqual(["a"]);
    expect(A.logs.filter((l) => l.startsWith("meddle: line:"))).toEqual([]);
  } finally {
    await close();
  }
}, 60_000);
