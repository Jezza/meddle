// test/starts.test.ts — a project's start resolved on its home: a revision, the fork point of the folder's `@`, or a
// sync branch; a line start writes the task's line there and never touches the user's working copy.
import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { git, jj } from "../src/jj";
import { shortId } from "../src/pool/identity";
import { addProjectFromFolder, addProjectFromUpstream, registerReplica } from "../src/projects/project";
import { startAt } from "../src/projects/starts";
import { startPoolNode, type GitPoolNode } from "./pool-helpers";

/** `template` of `rev` in `repo`, read without a snapshot. */
const read = async (n: GitPoolNode, repo: string, rev: string, template = "commit_id") =>
  (await jj(["log", "--ignore-working-copy", "-r", rev, "--no-graph", "-T", template], repo, n.cfg)).trim();

/** Every line ref the home holds. */
const lineRefs = async (n: GitPoolNode, repo: string) =>
  (await git(["for-each-ref", "--format=%(refname)", "refs/remotes/meddle/"], repo, n.cfg)).split("\n").filter(Boolean);

const deps = (n: GitPoolNode) => ({ cfg: n.cfg, db: n.db, selfId: n.id });

/** A folder project `a` on a node: P (content) → W (content), with `@` an empty change on P (as after moving off W). */
async function folder() {
  const n = await startPoolNode();
  const repo = `${n.home}/a`;
  await Bun.$`mkdir -p ${repo}`;
  const project = await addProjectFromFolder(n.cfg, n.db, repo, n.id, "a");
  await writeFile(`${repo}/p`, "p\n");
  await jj(["commit", "-m", "P"], repo, n.cfg);
  const P = await read(n, repo, "@-");
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

test("no revision, `@` empty on P: a child start at P, the line written there", async () => {
  const f = await folder();
  try {
    const start = await startAt(deps(f.n), f.project.id, "t1", null, "child");
    expect(start).toEqual({ projectId: f.project.id, kind: "line", mode: "child", commit: f.P, base: f.P });
    expect(await lineRefs(f.n, f.repo)).toEqual(["refs/remotes/meddle/task/t1/a"]);
    expect(await git(["rev-parse", "refs/remotes/meddle/task/t1/a"], f.repo, f.n.cfg)).toBe(`${f.P}\n`);
  } finally {
    await f.close();
  }
});

test("no revision, `@` with content: refused, nothing written", async () => {
  const f = await folder();
  try {
    await writeFile(`${f.repo}/x`, "x\n");
    await jj(["describe", "-m", "X"], f.repo, f.n.cfg);
    expect(await refusal(startAt(deps(f.n), f.project.id, "t1", null, "child"))).toBe("@ has changes; move off it first");
    expect(await lineRefs(f.n, f.repo)).toEqual([]);
  } finally {
    await f.close();
  }
});

test("no revision, an unsnapshotted edit on disk: starts at the fork point of `@` as last snapshotted, the edit stays the user's", async () => {
  const f = await folder();
  try {
    await writeFile(`${f.repo}/mine`, "mine\n");
    const start = await startAt(deps(f.n), f.project.id, "t1", null, "child");
    expect(start).toMatchObject({ kind: "line", commit: f.P });
    const status = await jj(["status", "--ignore-working-copy"], f.repo, f.n.cfg);
    expect(status).not.toContain("mine");
    // jj has not snapshotted it: a snapshotting read sees it as the user's change in `@`.
    expect(await jj(["status"], f.repo, f.n.cfg)).toContain("A mine");
  } finally {
    await f.close();
  }
});

test("a url project starts from its first sync branch, or the one `rev` names; none is refused", async () => {
  const n = await startPoolNode();
  try {
    const up = `${n.home}/up`;
    const g = (...args: string[]) => git(["-c", "user.name=t", "-c", "user.email=t@t", ...args], up);
    await Bun.$`mkdir -p ${up}`;
    await g("init", "-b", "main");
    await writeFile(`${up}/m`, "m\n");
    await g("add", ".");
    await g("commit", "-m", "m");
    await g("branch", "dev");
    const project = await addProjectFromUpstream(n.cfg, n.db, up, n.id, "up", ["dev"]);
    expect(project.sync).toEqual(["main", "dev"]);
    expect(await startAt(deps(n), project.id, "t1", null, "child")).toEqual({ projectId: project.id, kind: "sync", branch: "main" });
    expect(await startAt(deps(n), project.id, "t1", "dev", "child")).toEqual({ projectId: project.id, kind: "sync", branch: "dev" });
    expect(await lineRefs(n, project.replica)).toEqual([]);
    // --edit takes a revision: a sync branch named with it is refused, not taken as a sync start.
    expect(await refusal(startAt(deps(n), project.id, "t1", "dev", "edit"))).toBe("--edit takes a revision, not the sync branch dev");
    expect(await lineRefs(n, project.replica)).toEqual([]);
  } finally {
    await n.close();
  }
});

test("a url project with no sync branch is refused", async () => {
  const f = await folder();
  try {
    // A replica row is a url project (source: meddle://...) that carries no sync branches.
    registerReplica(f.n.db, { id: "u1", name: "u", home: f.n.id, replica: f.repo });
    expect(await refusal(startAt(deps(f.n), "u1", "t1", null, "child"))).toBe("u has no sync branch");
    expect(await lineRefs(f.n, f.repo)).toEqual([]);
  } finally {
    await f.close();
  }
});

test("--edit W: a line at W with base P; --edit needs a revision", async () => {
  const f = await folder();
  try {
    const start = await startAt(deps(f.n), f.project.id, "t1", f.W, "edit");
    expect(start).toEqual({ projectId: f.project.id, kind: "line", mode: "edit", commit: f.W, base: f.P });
    expect(await git(["rev-parse", "refs/remotes/meddle/task/t1/a"], f.repo, f.n.cfg)).toBe(`${f.W}\n`);
    expect(await refusal(startAt(deps(f.n), f.project.id, "t2", null, "edit"))).toBe("--edit needs a revision");
  } finally {
    await f.close();
  }
});

test("each edit refusal, in order", async () => {
  const f = await folder();
  try {
    const id = (rev: string) => read(f.n, f.repo, rev, "change_id.short(12)");
    const edit = (rev: string) => refusal(startAt(deps(f.n), f.project.id, "t9", rev, "edit"));
    // The workspace's own working copy.
    await jj(["describe", "-m", "wc"], f.repo, f.n.cfg);
    await writeFile(`${f.repo}/wc`, "wc\n");
    await jj(["status"], f.repo, f.n.cfg);
    const wc = await id("@");
    expect(await edit("@")).toBe(`${wc} is default's working copy; move off it first`);
    // Held by another task's line: W (and P below it) are immutable.
    await startAt(deps(f.n), f.project.id, "t1", f.W, "edit");
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
    expect(await lineRefs(f.n, f.repo)).toEqual(["refs/remotes/meddle/task/t1/a"]);
  } finally {
    await f.close();
  }
});

test("no fork point below W, and W with two fork points", async () => {
  const f = await folder();
  try {
    const id = (rev: string) => read(f.n, f.repo, rev, "change_id.short(12)");
    const edit = (rev: string) => refusal(startAt(deps(f.n), f.project.id, "t9", rev, "edit"));
    await jj(["new", "root()", "-m", "R"], f.repo, f.n.cfg);
    await writeFile(`${f.repo}/r`, "r\n");
    await jj(["new", "root()"], f.repo, f.n.cfg);
    const R = await read(f.n, f.repo, 'description(exact:"R\n")');
    expect(await edit(R)).toBe(`no fork point below ${await id(R)}`);
    // A merge Z of P and R, with content, has two fork points.
    await jj(["new", f.P, R, "-m", "Z"], f.repo, f.n.cfg);
    await writeFile(`${f.repo}/z`, "z\n");
    await jj(["new", "root()"], f.repo, f.n.cfg);
    const Z = await read(f.n, f.repo, 'description(exact:"Z\n")');
    expect(await edit(Z)).toBe(`${await id(Z)} has 2 fork points`);
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
    const results = await Promise.allSettled([
      startAt(deps(f.n), f.project.id, "t1", V, "edit"),
      startAt(deps(f.n), f.project.id, "t2", V, "edit"),
    ]);
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
    const child = (rev: string) => refusal(startAt(deps(f.n), f.project.id, "t1", rev, "child"));
    expect(await child("root()")).toBe("cannot start a task on the root commit");
    expect(await child("nosuchrev")).toBe("no revision nosuchrev in a");
    expect(await child("@ | @-")).toBe("@ | @- names 2 revisions in a");
    expect(await lineRefs(f.n, f.repo)).toEqual([]);
  } finally {
    await f.close();
  }
});

test("asked of a node that is not the project's home", async () => {
  const f = await folder();
  try {
    const other = "b".repeat(64);
    const away = await addProjectFromFolder(f.n.cfg, f.n.db, f.repo, other, "away");
    expect(await refusal(startAt(deps(f.n), away.id, "t1", null, "child"))).toBe(`a task's start is resolved on its project's home, ${shortId(other)}`);
    expect(await lineRefs(f.n, f.repo)).toEqual([]);
  } finally {
    await f.close();
  }
});

test("a task id that is not one safe segment is refused before it names a ref", async () => {
  const f = await folder();
  try {
    for (const id of ["../x", "t1/a", "t*", ""]) {
      expect(await refusal(startAt(deps(f.n), f.project.id, id, null, "child"))).toBe(`invalid task id: ${id}`);
    }
    expect(await lineRefs(f.n, f.repo)).toEqual([]);
  } finally {
    await f.close();
  }
});
