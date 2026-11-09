// test/starts.test.ts — a project's start resolved on the node asked, where the revision is: a revision of its service
// repo, one a checkout pushed there, or the project's default branch as its rows compute it; a start writes the task's
// line row (held by that node, epoch 0) and applies it.
import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { git, initColocated, jj } from "../src/jj";
import { listLineRows, mergeBranchRows, writeBranchRow } from "../src/pool/rows";
import { addProjectFromFolder, setDefaultBranch } from "../src/projects/project";
import { startAt, type StartRequest } from "../src/projects/starts";
import { startPoolNode, type GitPoolNode } from "./pool-helpers";

/** `template` of `rev` in `repo`, read without a snapshot. */
const read = async (n: GitPoolNode, repo: string, rev: string, template = "commit_id") =>
  (await jj(["log", "--ignore-working-copy", "-r", rev, "--no-graph", "-T", template], repo, n.cfg)).trim();

/** Every line ref the service repo holds. */
const lineRefs = async (n: GitPoolNode, repo: string) =>
  (await git(["for-each-ref", "--format=%(refname)", "refs/remotes/meddle/task/"], repo, n.cfg)).split("\n").filter(Boolean);

const deps = (n: GitPoolNode) => ({ cfg: n.cfg, db: n.db, selfId: n.id, pool: n.pool });

/** A start of task `taskId` at `rev` (null: the default branch) in `mode`, asked from no checkout unless given. */
const start = (n: GitPoolNode, projectId: string, taskId: string, rev: string | null, mode: StartRequest["mode"], checkout: string | null = null) =>
  startAt(deps(n), { projectId, taskId, rev, mode, checkout });

/**
 * The node's folder project `a`: in its service repo `repo`, P (content, the default branch `main`) → W (content),
 * with the service repo's `@` an empty change on P.
 */
async function folder() {
  const n = await startPoolNode();
  const project = n.project;
  const repo = project.replica;
  const P = await read(n, repo, "main");
  await jj(["new", P], repo, n.cfg);
  await writeFile(`${repo}/w`, "w\n");
  await jj(["commit", "-m", "W"], repo, n.cfg);
  const W = await read(n, repo, "@-");
  await jj(["new", P], repo, n.cfg);
  return { n, repo, project, P, W, close: () => n.close() };
}

const refusal = async (p: Promise<unknown>): Promise<string> => {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(Error);
  return (err as Error).message;
};

test("no revision: a child start at the default branch; its line row is this node's at epoch 0, applied as the line's ref", async () => {
  const f = await folder();
  try {
    const s = await start(f.n, f.project.id, "t1", null, "child");
    expect(s).toEqual({ projectId: f.project.id, mode: "child", commit: f.P, base: [f.P] });
    expect(listLineRows(f.n.db, f.project.id)).toEqual([
      { project: f.project.id, task: "t1", name: "a", holder: f.n.id, epoch: 0, seq: 1, commit: f.P, base: [f.P], archived: false },
    ]);
    expect(await lineRefs(f.n, f.repo)).toEqual(["refs/remotes/meddle/task/t1/a"]);
    expect(await git(["rev-parse", "refs/remotes/meddle/task/t1/a"], f.repo, f.n.cfg)).toBe(`${f.P}\n`);
  } finally {
    await f.close();
  }
});

test("no revision follows set-default, as the branch's rows have it; refused when no row has the branch", async () => {
  const f = await folder();
  try {
    writeBranchRow(f.n.db, f.n.id, { project: f.project.id, branch: "dev", commit: f.W, drops: [] });
    setDefaultBranch(f.n.db, f.project.id, "dev");
    expect(await start(f.n, f.project.id, "t1", null, "child")).toMatchObject({ commit: f.W, base: [f.W] });
    setDefaultBranch(f.n.db, f.project.id, "nope");
    expect(await refusal(start(f.n, f.project.id, "t2", null, "child"))).toBe("no bookmark nope in a");
    expect(listLineRows(f.n.db, f.project.id).map((r) => r.task)).toEqual(["t1"]);
  } finally {
    await f.close();
  }
});

test("a conflicted default branch is refused with the exact text, writing nothing", async () => {
  const f = await folder();
  try {
    // S, a sibling of P on the root, is where another node put `main`: two heads.
    await jj(["new", "root()", "-m", "S"], f.repo, f.n.cfg);
    await writeFile(`${f.repo}/s`, "s\n");
    await jj(["new", f.P], f.repo, f.n.cfg);
    const S = await read(f.n, f.repo, 'description(exact:"S\n")');
    mergeBranchRows(f.n.db, [{ project: f.project.id, branch: "main", node: "f".repeat(64), seq: 1, commit: S, drops: [] }]);
    expect(await refusal(start(f.n, f.project.id, "t1", null, "child"))).toBe("main is conflicted; push a merge of its siblings");
    expect(listLineRows(f.n.db, f.project.id)).toEqual([]);
    expect(await lineRefs(f.n, f.repo)).toEqual([]);
  } finally {
    await f.close();
  }
});

test("no revision and no default branch: refused, nothing written", async () => {
  const n = await startPoolNode();
  try {
    // A folder with neither `main` nor `master`.
    const dir = `${n.home}/bare`;
    await mkdir(dir);
    await initColocated(dir, n.cfg);
    await writeFile(`${dir}/x`, "x\n");
    await jj(["commit", "-m", "x"], dir, n.cfg);
    const project = await addProjectFromFolder(n.cfg, n.db, dir, n.id, "bare");
    expect(project.defaultBranch).toBeNull();
    expect(await refusal(start(n, project.id, "t1", null, "child"))).toBe("bare has no default branch; name a revision");
    expect(listLineRows(n.db, project.id)).toEqual([]);
  } finally {
    await n.close();
  }
});

test("--edit W: a line at W whose base is W's parents; --edit needs a revision", async () => {
  const f = await folder();
  try {
    const s = await start(f.n, f.project.id, "t1", f.W, "edit");
    expect(s).toEqual({ projectId: f.project.id, mode: "edit", commit: f.W, base: [f.P] });
    expect(listLineRows(f.n.db, f.project.id)).toMatchObject([{ task: "t1", commit: f.W, base: [f.P], holder: f.n.id, epoch: 0 }]);
    expect(await git(["rev-parse", "refs/remotes/meddle/task/t1/a"], f.repo, f.n.cfg)).toBe(`${f.W}\n`);
    expect(await refusal(start(f.n, f.project.id, "t2", null, "edit"))).toBe("--edit needs a revision");
  } finally {
    await f.close();
  }
});

test("each edit refusal, in order, in the service repo and its workspaces", async () => {
  const f = await folder();
  try {
    const id = (rev: string) => read(f.n, f.repo, rev, "change_id.short(12)");
    const edit = (rev: string) => refusal(start(f.n, f.project.id, "t9", rev, "edit"));
    // The workspace's own working copy.
    await jj(["describe", "-m", "wc"], f.repo, f.n.cfg);
    await writeFile(`${f.repo}/wc`, "wc\n");
    await jj(["status"], f.repo, f.n.cfg);
    const wc = await id("@");
    expect(await edit("@")).toBe(`${wc} is default's working copy; move off it first`);
    // Held by another task's line: W (and P below it) are immutable.
    await start(f.n, f.project.id, "t1", f.W, "edit");
    expect(await edit(f.P)).toBe(`${await id(f.P)} is immutable`);
    expect(await edit(f.W)).toBe(`${await id(f.W)} is immutable`);
    // A mutable change with a revision on top, and one with no changes.
    await jj(["new", "root()", "-m", "M"], f.repo, f.n.cfg);
    await writeFile(`${f.repo}/m`, "m\n");
    await jj(["new", "-m", "top"], f.repo, f.n.cfg);
    const M = await id("@-");
    expect(await edit(M)).toBe(`${M} has revisions on top of it`);
    await jj(["new", "root()", "-m", "E"], f.repo, f.n.cfg);
    const E = await id("@");
    await jj(["new", "root()"], f.repo, f.n.cfg);
    expect(await edit(E)).toBe(`nothing to hand off: ${E} has no changes`);
    expect(listLineRows(f.n.db, f.project.id).map((r) => r.task)).toEqual(["t1"]);
    expect(await lineRefs(f.n, f.repo)).toEqual(["refs/remotes/meddle/task/t1/a"]);
  } finally {
    await f.close();
  }
});

test("two concurrent edit starts of W: the second is refused as immutable", async () => {
  const f = await folder();
  try {
    await jj(["new", f.W, "-m", "V"], f.repo, f.n.cfg);
    await writeFile(`${f.repo}/v`, "v\n");
    await jj(["new", "root()"], f.repo, f.n.cfg);
    const V = await read(f.n, f.repo, `description(exact:"V\n")`);
    const results = await Promise.allSettled([start(f.n, f.project.id, "t1", V, "edit"), start(f.n, f.project.id, "t2", V, "edit")]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    expect(((results[1] as PromiseRejectedResult).reason as Error).message).toMatch(/ is immutable$/);
    expect(await lineRefs(f.n, f.repo)).toEqual(["refs/remotes/meddle/task/t1/a"]);
  } finally {
    await f.close();
  }
});

test("a child at the root, an unknown revision and a revset of two revisions are refused", async () => {
  const f = await folder();
  try {
    const child = (rev: string) => refusal(start(f.n, f.project.id, "t1", rev, "child"));
    expect(await child("root()")).toBe("cannot start a task on the root commit");
    expect(await child("nosuchrev")).toBe("no revision nosuchrev in a");
    expect(await child("@ | @-")).toBe("@ | @- names 2 revisions in a");
    expect(listLineRows(f.n.db, f.project.id)).toEqual([]);
  } finally {
    await f.close();
  }
});

test("a commit a checkout pushed, which jj does not know yet: an edit start takes its parents from git, and the push's ref goes", async () => {
  const f = await folder();
  try {
    // X, a child of P, only in the view's incoming refs: nothing jj imports names it.
    const g = (...args: string[]) => git(["-c", "user.name=t", "-c", "user.email=t@t", ...args], f.repo, f.n.cfg);
    const tree = (await g("rev-parse", `${f.P}^{tree}`)).trim();
    const X = (await g("commit-tree", tree, "-p", f.P, "-m", "X")).trim();
    const incoming = `refs/namespaces/view/refs/meddle/incoming/${X}`;
    await g("update-ref", incoming, X);
    expect(await jj(["log", "--ignore-working-copy", "-r", `present(${X})`, "--no-graph", "-T", "commit_id"], f.repo, f.n.cfg)).toBe("");

    const s = await start(f.n, f.project.id, "t1", X, "edit", "/a/checkout");
    expect(s).toEqual({ projectId: f.project.id, mode: "edit", commit: X, base: [f.P] });
    expect(await read(f.n, f.repo, X)).toBe(X);
    expect(await git(["for-each-ref", incoming], f.repo, f.n.cfg)).toBe("");
    // One the node does not have is refused.
    const missing = "e".repeat(40);
    expect(await refusal(start(f.n, f.project.id, "t2", missing, "child", "/a/checkout"))).toBe(`no revision ${missing} in a`);
    // A pushed commit whose start is refused leaves no ref behind either: X is t1's line now.
    await g("update-ref", incoming, X);
    expect(await refusal(start(f.n, f.project.id, "t3", X, "edit", "/a/checkout"))).toMatch(/ is immutable$/);
    expect(await git(["for-each-ref", incoming], f.repo, f.n.cfg)).toBe("");
  } finally {
    await f.close();
  }
});

test("a task id that is not one safe segment is refused before it names a ref", async () => {
  const f = await folder();
  try {
    for (const id of ["../x", "t1/a", "t*", ""]) {
      expect(await refusal(start(f.n, f.project.id, id, null, "child"))).toBe(`invalid task id: ${id}`);
    }
    expect(listLineRows(f.n.db, f.project.id)).toEqual([]);
  } finally {
    await f.close();
  }
});
