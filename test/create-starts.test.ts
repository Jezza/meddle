// test/create-starts.test.ts — a new task is created from the starts each project's home resolves for it: the node asked
// mints the id, asks each home for its start, creates the task on the node placed, and releases the lines it had
// written when a later start or the creation certainly failed.
import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { paths } from "../src/config";
import { git, jj } from "../src/jj";
import { shortId } from "../src/pool/identity";
import { addProjectFromFolder, addProjectFromUpstream, getProject, setProjectSync } from "../src/projects/project";
import { NodeObject } from "../src/state/contracts";
import { listTasks } from "../src/store/records";
import { workspaceImmutableHeads } from "../src/tasks/provision";
import { linkClient, peerReady, twoPoolNodes, type GitPoolNode } from "./pool-helpers";

async function eventually(cond: () => boolean, what: () => string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting: ${what()}`);
    await Bun.sleep(10);
  }
}

/** `template` of `rev` in `repo` (a repo or a workspace), read without a snapshot. */
const read = async (n: GitPoolNode, repo: string, rev: string, template = "commit_id") =>
  (await jj(["log", "--ignore-working-copy", "-r", rev, "--no-graph", "-T", template], repo, n.cfg)).trim();

/** The line refs the home repo `repo` holds for task `taskId` (every task's when absent), each `<ref> <commit>`. */
const lineRefs = async (n: GitPoolNode, repo: string, taskId?: string) =>
  (await git(["for-each-ref", "--format=%(refname) %(objectname)", `refs/remotes/meddle/task${taskId === undefined ? "" : `/${taskId}`}`], repo, n.cfg))
    .split("\n").filter(Boolean);

/** The immutable heads the workspace `workspace` of a task is scoped to. */
const scopeOf = async (n: GitPoolNode, workspace: string) =>
  (await jj(["config", "get", 'revset-aliases."immutable_heads()"'], workspace, n.cfg)).trim();

/** A folder project `name` homed on `n`: one commit with content, and `@` empty on it. Returns it with that commit. */
async function folderProject(n: GitPoolNode, name: string) {
  const repo = `${n.home}/${name}`;
  await mkdir(repo, { recursive: true });
  const project = await addProjectFromFolder(n.cfg, n.db, repo, n.id, name);
  await writeFile(`${repo}/${name}`, `${name}\n`);
  await jj(["commit", "-m", name], repo, n.cfg);
  return { project, repo, fork: await read(n, repo, "@-") };
}

/** A and B in one pool: A is the home of `a` (its own project), B of `b`; each knows the other's projects. */
async function setup() {
  const { A, B, close } = await twoPoolNodes();
  const a = { project: A.project, repo: A.project.replica, fork: await read(A, A.project.replica, "@-") };
  const b = await folderProject(B, "b");
  await peerReady(A, B);
  await peerReady(B, A);
  const knows = (viewer: GitPoolNode, of: GitPoolNode, id: string) => eventually(
    () => viewer.store.row(of.id)?.summary?.projects.some((p) => p.id === id) === true,
    () => `${shortId(viewer.id)} to hear of ${shortId(of.id)}'s project ${id}`,
  );
  await knows(A, B, b.project.id);
  await knows(B, A, a.project.id);
  return { A, B, a, b, close };
}

/** `fn` with a NodeObject of `n`, as a client of its host. */
async function withNode<T>(n: GitPoolNode, fn: (node: Awaited<ReturnType<typeof getNode>>) => Promise<T>): Promise<T> {
  const linked = linkClient(n.host);
  try {
    const node = await getNode(linked.client);
    try {
      return await fn(node);
    } finally {
      node.release();
    }
  } finally {
    await linked.close();
  }
}
const getNode = (client: ReturnType<typeof linkClient>["client"]) => client.get(NodeObject, {});

const refusal = async (p: Promise<unknown>): Promise<string> => {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(Error);
  return (err as Error).message;
};

test("a task of a and b placed on B starts each on a child of its home's fork point; both lines are written on their homes", async () => {
  const { A, B, a, b, close } = await setup();
  try {
    const { manifest, nodeId } = await withNode(A, (node) => node.createTask({ title: "t", projects: [{ id: a.project.id }, { id: b.project.id }], node: B.id }));
    expect(nodeId).toBe(B.id);
    const id = manifest.id;
    expect(listTasks(B.db).map((t) => t.id)).toEqual([id]);
    expect(listTasks(A.db)).toEqual([]);
    expect(manifest.projects.map((p) => [p.name, p.base])).toEqual([["a", a.fork], ["b", b.fork]]);

    // Each line on its own home, at the start.
    expect(await lineRefs(A, a.repo)).toEqual([`refs/remotes/meddle/task/${id}/a ${a.fork}`]);
    expect(await lineRefs(B, b.repo)).toEqual([`refs/remotes/meddle/task/${id}/b ${b.fork}`]);

    // On B, each workspace is a new change on its start, scoped to its base.
    const task = paths(B.cfg).task(id);
    expect(await read(B, `${task}/a`, "@-")).toBe(a.fork);
    expect(await read(B, `${task}/b`, "@-")).toBe(b.fork);
    expect(await scopeOf(B, `${task}/a`)).toBe(workspaceImmutableHeads(id, a.fork));
    expect(await scopeOf(B, `${task}/b`)).toBe(workspaceImmutableHeads(id, b.fork));
  } finally {
    await close();
  }
}, 60_000);

test("a revision of a edited on B: B's workspace edits it, scoped to its fork point, and A holds the line at it", async () => {
  const { A, B, a, close } = await setup();
  try {
    // W (content) on the fork point, `@` back on the fork point.
    await writeFile(`${a.repo}/w`, "w\n");
    await jj(["commit", "-m", "W"], a.repo, A.cfg);
    const W = await read(A, a.repo, "@-");
    await jj(["new", a.fork], a.repo, A.cfg);

    const { manifest } = await withNode(A, (node) => node.createTask({ title: "t", projects: [{ id: a.project.id, rev: W, mode: "edit" }], node: B.id }));
    const workspace = `${paths(B.cfg).task(manifest.id)}/a`;
    expect(await read(B, workspace, "@")).toBe(W);
    expect(manifest.projects[0]!.base).toBe(a.fork);
    expect(await scopeOf(B, workspace)).toBe(workspaceImmutableHeads(manifest.id, a.fork));
    expect(await lineRefs(A, a.repo)).toEqual([`refs/remotes/meddle/task/${manifest.id}/a ${W}`]);
  } finally {
    await close();
  }
}, 60_000);

test("B refuses b's start: a's line on A is released and no task exists anywhere", async () => {
  const { A, B, a, b, close } = await setup();
  try {
    // `@` of b's folder has content: its fork point is `@` itself.
    await writeFile(`${b.repo}/x`, "x\n");
    await jj(["describe", "-m", "X"], b.repo, B.cfg);
    const message = await refusal(withNode(B, (node) => node.createTask({ title: "t", projects: [{ id: a.project.id }, { id: b.project.id }], node: "here" })));
    expect(message).toContain("project b: @ has changes; move off it first");
    expect(await lineRefs(A, a.repo)).toEqual([]);
    expect(await lineRefs(B, b.repo)).toEqual([]);
    expect(listTasks(A.db)).toEqual([]);
    expect(listTasks(B.db)).toEqual([]);
    // Released through jj: nothing of it is left as a bookmark either.
    expect(await jj(["bookmark", "list", "--ignore-working-copy", "--all-remotes", "glob:task/*"], a.repo, A.cfg)).toBe("");
  } finally {
    await close();
  }
}, 60_000);

test("a creation the target certainly refuses releases the lines its starts wrote: the target says it has no such task", async () => {
  const { rm } = await import("node:fs/promises");
  const { A, B, a, b, close } = await setup();
  try {
    // B refuses any create: it has no task root.
    await rm(B.cfg.taskRoot, { recursive: true, force: true });
    const message = await refusal(withNode(A, (node) => node.createTask({ title: "t", projects: [{ id: a.project.id }, { id: b.project.id }], node: B.id })));
    expect(message).toContain(`task root ${B.cfg.taskRoot} does not exist`);
    expect(message).not.toContain("all the same");
    expect(message).not.toContain("may have task");
    expect(listTasks(A.db)).toEqual([]);
    expect(listTasks(B.db)).toEqual([]);
    expect(await lineRefs(A, a.repo)).toEqual([]);
    expect(await lineRefs(B, b.repo)).toEqual([]);
    expect(await jj(["bookmark", "list", "--ignore-working-copy", "--all-remotes", "glob:task/*"], a.repo, A.cfg)).toBe("");
    // Nor is a's line left fetched into B's replica of a.
    expect(await git(["for-each-ref", "refs/heads/meddle/task/"], getProject(B.db, a.project.id)!.replica, B.cfg)).toBe("");
  } finally {
    await close();
  }
}, 60_000);

test("a creation whose answer is lost while the target holds the task keeps the lines", async () => {
  const { A, B, a, b, close } = await setup();
  try {
    B.hooks.afterCreate = () => { throw new Error("the answer was lost"); };
    const message = await refusal(withNode(A, (node) => node.createTask({ title: "t", projects: [{ id: a.project.id }, { id: b.project.id }], node: B.id })));
    const [held] = listTasks(B.db);
    expect(held).toBeDefined();
    const id = held!.id;
    expect(message).toContain("the answer was lost");
    expect(message).toContain(`${shortId(B.id)} has task ${id} all the same`);
    expect(await lineRefs(A, a.repo)).toEqual([`refs/remotes/meddle/task/${id}/a ${a.fork}`]);
    expect(await lineRefs(B, b.repo)).toEqual([`refs/remotes/meddle/task/${id}/b ${b.fork}`]);
  } finally {
    await close();
  }
}, 60_000);

test("with a's home offline: a sync branch starts from the copy B fetched last, with no line; no revision is refused", async () => {
  const { A, B, a, close } = await setup();
  try {
    // a's sync branch `main` at M1, fetched by B as it creates a first task from it.
    setProjectSync(A.db, a.project.id, ["main"]);
    await jj(["bookmark", "set", "main", "-r", a.fork], a.repo, A.cfg);
    const first = await withNode(B, (node) => node.createTask({ title: "first", projects: [{ id: a.project.id, rev: "main" }], node: "here" }));
    expect(await read(B, `${paths(B.cfg).task(first.manifest.id)}/a`, "@-")).toBe(a.fork);
    // A moves `main` on to M2, which B never fetches.
    await writeFile(`${a.repo}/m2`, "m2\n");
    await jj(["commit", "-m", "M2"], a.repo, A.cfg);
    await jj(["bookmark", "set", "main", "-r", "@-"], a.repo, A.cfg);

    await A.net.stop();
    await eventually(() => !B.net.isOnline(A.id), () => "B to see A offline");
    const second = await withNode(B, (node) => node.createTask({ title: "second", projects: [{ id: a.project.id, rev: "main" }], node: "here" }));
    const workspace = `${paths(B.cfg).task(second.manifest.id)}/a`;
    expect(await read(B, workspace, "@-")).toBe(a.fork);
    expect(second.manifest.projects[0]!.base).toBe(a.fork);
    expect(await scopeOf(B, workspace)).toBe(workspaceImmutableHeads(second.manifest.id, a.fork));
    expect(B.logs).toContain("meddle: project a: home offline; starting from main as fetched last");
    // A sync start writes no line: the task's first turn end does.
    expect(await lineRefs(A, a.repo)).toEqual([]);

    expect(await refusal(withNode(B, (node) => node.createTask({ title: "t", projects: [{ id: a.project.id }], node: "here" }))))
      .toContain(`project a: home ${shortId(A.id)} is offline`);
    expect(await refusal(withNode(B, (node) => node.createTask({ title: "t", projects: [{ id: a.project.id, rev: "main", mode: "edit" }], node: "here" }))))
      .toContain("project a: --edit takes a revision, not the sync branch main");
    expect(listTasks(B.db).map((t) => t.id).sort()).toEqual([first.manifest.id, second.manifest.id].sort());
  } finally {
    await close();
  }
}, 60_000);

test("with a url project's home offline and no revision, it starts from its first sync branch as B fetched it last, with no line", async () => {
  const { A, B, close } = await setup();
  try {
    // An upstream git repo whose default branch `main` is at M; `u` is added from it on A.
    const up = `${A.home}/up`;
    await mkdir(up, { recursive: true });
    const g = (...args: string[]) => git(["-c", "user.name=t", "-c", "user.email=t@t", ...args], up);
    await g("init", "-b", "main");
    await writeFile(`${up}/m`, "m\n");
    await g("add", ".");
    await g("commit", "-m", "m");
    const M = (await g("rev-parse", "HEAD")).trim();
    const u = await addProjectFromUpstream(A.cfg, A.db, up, A.id, "u");
    expect(u.sync).toEqual(["main"]);
    await eventually(
      () => B.store.row(A.id)?.summary?.projects.some((p) => p.id === u.id && p.upstream === true) === true,
      () => "B to hear of u as a url project",
    );
    // B fetches `main` as it creates a first task with no revision: the home resolves it to the sync branch.
    const first = await withNode(B, (node) => node.createTask({ title: "first", projects: [{ id: u.id }], node: "here" }));
    expect(first.manifest.projects[0]!.base).toBe(M);
    expect(getProject(B.db, u.id)?.upstream).toBe(true);

    await A.net.stop();
    await eventually(() => !B.net.isOnline(A.id), () => "B to see A offline");
    const second = await withNode(B, (node) => node.createTask({ title: "second", projects: [{ id: u.id }], node: "here" }));
    expect(second.manifest.projects[0]!.base).toBe(M);
    expect(await read(B, `${paths(B.cfg).task(second.manifest.id)}/u`, "@-")).toBe(M);
    expect(B.logs).toContain("meddle: project u: home offline; starting from main as fetched last");
    expect(await lineRefs(A, u.replica)).toEqual([]);

    // With no sync branch left, a url project has no default start.
    setProjectSync(B.db, u.id, []);
    expect(await refusal(withNode(B, (node) => node.createTask({ title: "t", projects: [{ id: u.id }], node: "here" }))))
      .toContain("project u: u has no sync branch");
  } finally {
    await close();
  }
}, 60_000);

test("a task with no projects starts as it always did: no workspace, no start, no line", async () => {
  const { A, a, close } = await setup();
  try {
    const { manifest, nodeId } = await withNode(A, (node) => node.createTask({ title: "loose", projects: [], node: "here" }));
    expect(nodeId).toBe(A.id);
    expect(manifest.projects).toEqual([]);
    expect(manifest.primaryProjectId).toBeNull();
    expect(await lineRefs(A, a.repo)).toEqual([]);
  } finally {
    await close();
  }
}, 60_000);
