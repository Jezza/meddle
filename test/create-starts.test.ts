// test/create-starts.test.ts — a new task is created from the starts the node asked resolves for it, where the
// revision is: that node mints the id, resolves each start (writing its line row), creates the task on the node placed,
// which takes the lines one epoch up, and releases the rows it wrote when a later start or the creation certainly
// failed.
import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { paths } from "../src/config";
import { git, initColocated, jj } from "../src/jj";
import { shortId } from "../src/pool/identity";
import { listLineRows } from "../src/pool/rows";
import { addProjectFromFolder, setDefaultBranch } from "../src/projects/project";
import { NodeObject, PeerObject } from "../src/state/contracts";
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

/** The line refs the service repo `repo` holds, each `<ref> <commit>`. */
const lineRefs = async (n: GitPoolNode, repo: string) =>
  (await git(["for-each-ref", "--format=%(refname) %(objectname)", "refs/remotes/meddle/task"], repo, n.cfg))
    .split("\n").filter(Boolean);

/** The line rows node `n` has of task `taskId`, by name, each as `[name, holder, epoch, commit, base]`. */
const rowsOf = (n: GitPoolNode, taskId: string) =>
  listLineRows(n.db, undefined, taskId).sort((x, y) => x.name.localeCompare(y.name)).map((r) => [r.name, r.holder, r.epoch, r.commit, r.base]);

/** The immutable heads the workspace `workspace` of a task is scoped to. */
const scopeOf = async (n: GitPoolNode, workspace: string) =>
  (await jj(["config", "get", 'revset-aliases."immutable_heads()"'], workspace, n.cfg)).trim();

/**
 * A folder project `name` homed on `n`, from a folder with one commit with content, its default branch `main`. Returns
 * it with its service repo and that commit.
 */
async function folderProject(n: GitPoolNode, name: string) {
  const folder = `${n.home}/${name}`;
  await mkdir(folder, { recursive: true });
  await initColocated(folder, n.cfg);
  await writeFile(`${folder}/${name}`, `${name}\n`);
  await jj(["commit", "-m", name], folder, n.cfg);
  await jj(["bookmark", "set", "main", "-r", "@-"], folder, n.cfg);
  const project = await addProjectFromFolder(n.cfg, n.db, folder, n.id, name);
  return { project, repo: project.replica, fork: await read(n, project.replica, "main") };
}

/** A and B in one pool: A is the home of `a` (its own project), B of `b`; each knows the other's projects. */
async function setup() {
  const { A, B, close } = await twoPoolNodes();
  const a = { project: A.project, repo: A.project.replica, fork: await read(A, A.project.replica, "main") };
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

test("PeerObject has no startAt and no releaseLines: a start is resolved on the node asked", () => {
  const methods = Object.keys(PeerObject.def.variants.peer.methods);
  expect(methods).not.toContain("startAt");
  expect(methods).not.toContain("releaseLines");
  expect(methods).toContain("createTaskAt");
});

test("a task of a and b asked of A and placed on B: A resolves both starts, and B takes the lines with epoch 1", async () => {
  const { A, B, a, b, close } = await setup();
  try {
    const { manifest, nodeId } = await withNode(A, (node) => node.createTask({ title: "t", projects: [{ id: a.project.id }, { id: b.project.id }], node: B.id }));
    expect(nodeId).toBe(B.id);
    const id = manifest.id;
    expect(listTasks(B.db).map((t) => t.id)).toEqual([id]);
    expect(listTasks(A.db)).toEqual([]);
    expect(manifest.projects.map((p) => [p.name, p.base])).toEqual([["a", [a.fork]], ["b", [b.fork]]]);

    // A wrote each line at epoch 0 (and applied a's); B took them both, one epoch up.
    expect(rowsOf(B, id)).toEqual([["a", B.id, 1, a.fork, [a.fork]], ["b", B.id, 1, b.fork, [b.fork]]]);
    expect(await lineRefs(A, a.repo)).toEqual([`refs/remotes/meddle/task/${id}/a ${a.fork}`]);

    // On B, each workspace is a new change on its start, scoped to its base; the task's own bookmark holds each line,
    // so its remote ref is gone there.
    const task = paths(B.cfg).task(id);
    expect(await read(B, `${task}/a`, "@-")).toBe(a.fork);
    expect(await read(B, `${task}/b`, "@-")).toBe(b.fork);
    expect(await scopeOf(B, `${task}/a`)).toBe(workspaceImmutableHeads(id, [a.fork]));
    expect(await scopeOf(B, `${task}/b`)).toBe(workspaceImmutableHeads(id, [b.fork]));
    expect(await lineRefs(B, b.repo)).toEqual([]);
  } finally {
    await close();
  }
}, 60_000);

test("a revision of a edited on B: B's workspace edits it, its base W's parents, and A holds the line at it", async () => {
  const { A, B, a, close } = await setup();
  try {
    // W (content) on the fork point, `@` back on the fork point.
    await jj(["new", a.fork], a.repo, A.cfg);
    await writeFile(`${a.repo}/w`, "w\n");
    await jj(["commit", "-m", "W"], a.repo, A.cfg);
    const W = await read(A, a.repo, "@-");
    await jj(["new", a.fork], a.repo, A.cfg);

    const { manifest } = await withNode(A, (node) => node.createTask({ title: "t", projects: [{ id: a.project.id, rev: W, mode: "edit" }], node: B.id }));
    const workspace = `${paths(B.cfg).task(manifest.id)}/a`;
    expect(await read(B, workspace, "@")).toBe(W);
    expect(manifest.projects[0]!.base).toEqual([a.fork]);
    expect(await scopeOf(B, workspace)).toBe(workspaceImmutableHeads(manifest.id, [a.fork]));
    expect(rowsOf(B, manifest.id)).toEqual([["a", B.id, 1, W, [a.fork]]]);
    expect(await lineRefs(A, a.repo)).toEqual([`refs/remotes/meddle/task/${manifest.id}/a ${W}`]);
  } finally {
    await close();
  }
}, 60_000);

test("two projects where the second refuses: the first's line row is released and no task exists anywhere", async () => {
  const { A, B, a, b, close } = await setup();
  try {
    // b's default branch names a branch no row has.
    setDefaultBranch(B.db, b.project.id, "nope");
    const message = await refusal(withNode(B, (node) => node.createTask({ title: "t", projects: [{ id: a.project.id }, { id: b.project.id }], node: "here" })));
    expect(message).toContain("project b: no bookmark nope in b");
    const rows = listLineRows(B.db, a.project.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "a", holder: B.id, epoch: 0, commit: null });
    expect(listLineRows(B.db, b.project.id)).toEqual([]);
    expect(listTasks(A.db)).toEqual([]);
    expect(listTasks(B.db)).toEqual([]);
  } finally {
    await close();
  }
}, 60_000);

test("a creation the target certainly refuses releases the line rows its starts wrote", async () => {
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
    const released = listLineRows(A.db).map((r) => [r.name, r.holder, r.commit]).sort((x, y) => String(x[0]).localeCompare(String(y[0])));
    expect(released).toEqual([["a", A.id, null], ["b", A.id, null]]);
    // Nor is a bookmark of the task left in B's service repo of b.
    expect(await git(["for-each-ref", "refs/heads/meddle/task/"], b.repo, B.cfg)).toBe("");
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
    expect(rowsOf(B, id)).toEqual([["a", B.id, 1, a.fork, [a.fork]], ["b", B.id, 1, b.fork, [b.fork]]]);
    expect(listLineRows(A.db, undefined, id).every((r) => r.commit !== null)).toBe(true);
  } finally {
    await close();
  }
}, 60_000);

test("with a's home offline, B still starts a task of a from a's default branch as its rows have it", async () => {
  const { A, B, a, close } = await setup();
  try {
    // A first task of a on B brings a's rows and commits to B.
    const first = await withNode(B, (node) => node.createTask({ title: "first", projects: [{ id: a.project.id }], node: "here" }));
    expect(first.manifest.projects[0]!.base).toEqual([a.fork]);

    await A.net.stop();
    await eventually(() => !B.net.isOnline(A.id), () => "B to see A offline");
    const second = await withNode(B, (node) => node.createTask({ title: "second", projects: [{ id: a.project.id }], node: "here" }));
    const workspace = `${paths(B.cfg).task(second.manifest.id)}/a`;
    expect(await read(B, workspace, "@-")).toBe(a.fork);
    expect(second.manifest.projects[0]!.base).toEqual([a.fork]);
    expect(rowsOf(B, second.manifest.id)).toEqual([["a", B.id, 1, a.fork, [a.fork]]]);
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
    expect(listLineRows(A.db)).toEqual([]);
    expect(await lineRefs(A, a.repo)).toEqual([]);
  } finally {
    await close();
  }
}, 60_000);
