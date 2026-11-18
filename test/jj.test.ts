// test/jj.test.ts
import { test, expect } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import {
  abandon, changeId, bookmarkList, bookmarkSet, commitOf, commitsIn, configSetWorkspace, fetch, initColocated, isJjRepo, jj, push,
  remoteAdd, track, workspaceAdd, workspaceForget,
} from "../src/jj";
import { shortId } from "../src/pool/identity";
import { twoPoolNodes } from "./pool-helpers";
test("init, workspace add, change id, bookmark, forget", async () => {
  const repo = await mkdtemp("/tmp/meddle-jj-");
  await initColocated(repo);
  expect(await isJjRepo(repo)).toBe(true);
  const ws = `${repo}-ws`;
  await workspaceAdd(repo, "task1", ws, "root()");
  const id = await changeId(ws);
  expect(id).toMatch(/^[k-z]{32}$/);
  expect(await Bun.file(`${ws}/.git`).exists()).toBe(true); // colocated: a Git worktree file
  await bookmarkSet(repo, "meddle/task/1/p", id);
  await workspaceForget(repo, "task1");
});
test("jj errors carry stderr", async () => {
  const { jj } = await import("../src/jj");
  await expect(jj(["log"], "/tmp")).rejects.toMatchObject({ code: expect.any(Number) });
});
test("bookmarkDelete removes exactly the named bookmark", async () => {
  const { bookmarkDelete, jj } = await import("../src/jj");
  const repo = await mkdtemp("/tmp/meddle-jj-");
  await initColocated(repo);
  await bookmarkSet(repo, "meddle/task/1/p", "@");
  await bookmarkSet(repo, "meddle/task/1/px", "@");
  await bookmarkDelete(repo, "meddle/task/1/p");
  const names = (await jj(["bookmark", "list", "-T", 'name ++ "\\n"'], repo)).trim().split("\n");
  expect(names).toEqual(["meddle/task/1/px"]);
});

test("listing bookmarks imports git's refs and never snapshots the working copy", async () => {
  const repo = await mkdtemp("/tmp/meddle-jj-");
  await initColocated(repo);
  await Bun.write(`${repo}/a.txt`, "a\n");
  await jj(["commit", "-m", "one"], repo);
  await bookmarkSet(repo, "main", "@-");
  const ops = async () => (await jj(["op", "log", "--ignore-working-copy", "--no-graph", "-T", 'id ++ "\\n"'], repo)).split("\n").filter(Boolean).length;
  /** The files `@` changes, as jj last recorded them (no snapshot). */
  const recorded = async () => (await jj(["diff", "--ignore-working-copy", "-r", "@", "--name-only"], repo)).split("\n").filter(Boolean);
  const git = (...args: string[]) => {
    const proc = Bun.spawnSync(["git", ...args], {
      cwd: repo,
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid" },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (!proc.success) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
    return proc.stdout.toString().trim();
  };

  // nothing changed in git: no operation at all, and an edit in the user's checkout stays unsnapshotted
  await Bun.write(`${repo}/edited.txt`, "x\n");
  let before = await ops();
  expect((await bookmarkList(repo)).map((b) => `${b.name}@${b.remote}`)).toEqual(["main@null"]);
  expect(await ops()).toBe(before);
  expect(await recorded()).not.toContain("edited.txt");

  // behind jj's back (a git user, a peer's push into .git): main moves on, a task bookmark appears
  const one = git("rev-parse", "refs/heads/main");
  const two = git("commit-tree", `${one}^{tree}`, "-p", one, "-m", "two");
  git("update-ref", "refs/heads/main", two);
  git("branch", "meddle/task/x", two);
  before = await ops();
  const listed = await bookmarkList(repo);
  expect(listed.map((b) => b.name).sort()).toEqual(["main", "meddle/task/x"]);
  const twoChange = (await jj(["log", "--ignore-working-copy", "-r", two, "--no-graph", "-T", "change_id"], repo)).trim();
  expect(listed.find((b) => b.name === "main")!.changeId).toBe(twoChange);
  // the import's own operation, and no snapshot
  expect(await ops()).toBeLessThanOrEqual(before + 1);
  expect(await recorded()).not.toContain("edited.txt");
});

test("a peer's fetch from a repo with an edit in its working copy never snapshots it, and writes nothing there", async () => {
  const { A, B, close } = await twoPoolNodes();
  try {
    const home = A.project.replica;
    await Bun.write(`${home}/README`, "hello\n");
    await jj(["commit", "-m", "init"], home, A.cfg);
    await bookmarkSet(home, "main", "@-", A.cfg);
    await Bun.write(`${home}/edited.txt`, "x\n");
    const opIds = async () => (await jj(["op", "log", "--ignore-working-copy", "--no-graph", "-T", 'id ++ "\\n"'], home, A.cfg)).split("\n").filter(Boolean);
    const known = new Set(await opIds());

    const shortA = shortId(A.id);
    const repo = `${B.home}/r`;
    await initColocated(repo, B.cfg);
    await remoteAdd(repo, shortA, `meddle://${A.id}/project/${A.project.id}`, B.cfg);
    await fetch(repo, shortA, ["main"], B.cfg);
    // a second fetch changes nothing either
    await fetch(repo, shortA, ["main"], B.cfg);

    const fresh = (await opIds()).filter((id) => !known.has(id));
    const described = await Promise.all(fresh.map(async (id) => (await jj(["op", "show", "--ignore-working-copy", id, "--no-graph", "-T", "description", "--no-op-diff"], home, A.cfg)).trim()));
    expect(described.filter((d) => d.startsWith("snapshot"))).toEqual([]);
    // a fetch writes nothing there
    expect(fresh).toEqual([]);
    expect((await jj(["diff", "--ignore-working-copy", "-r", "@", "--name-only"], home, A.cfg)).split("\n")).not.toContain("edited.txt");
    expect((await bookmarkList(home, A.cfg)).map((b) => `${b.name}@${b.remote ?? ""}`).sort()).toEqual(["main@"]);
    expect(A.logs.filter((l) => l.startsWith("meddle: git:"))).toEqual([]);
  } finally {
    await close();
  }
}, 15_000);

test("push, track and bookmarkForget take jj string patterns: a task's glob selects its side bookmarks, nothing outside", async () => {
  const { bookmarkForget } = await import("../src/jj");
  const { taskGlob } = await import("../src/tasks/manifest");
  const dir = await mkdtemp("/tmp/meddle-jj-");
  const remote = `${dir}/remote.git`;
  Bun.spawnSync(["git", "init", "-q", "--bare", remote]);
  const repo = `${dir}/repo`;
  await initColocated(repo);
  await remoteAdd(repo, "r", remote);
  await Bun.write(`${repo}/a.txt`, "a\n");
  await jj(["commit", "-m", "one"], repo);
  for (const name of ["meddle/task/t1/p", "meddle/task/t1/p.spike", "meddle/task/t2/p", "spike"]) await bookmarkSet(repo, name, "@-");
  const onRemote = () => Bun.spawnSync(["git", "--git-dir", remote, "for-each-ref", "--format=%(refname)"]).stdout.toString().trim().split("\n").filter(Boolean);

  // A task with no bookmarks: nothing to track or push, no error.
  await track(repo, taskGlob("t9"), "r");
  await push(repo, "r", taskGlob("t9"));
  await track(repo, taskGlob("t1"), "r");
  await push(repo, "r", taskGlob("t1"));
  expect(onRemote()).toEqual(["refs/heads/meddle/task/t1/p", "refs/heads/meddle/task/t1/p.spike"]);
  // Pushed again: already there, no error.
  await push(repo, "r", taskGlob("t1"));
  await track(repo, "exact:meddle/task/t2/p", "r");
  await push(repo, "r", "exact:meddle/task/t2/p");
  expect(onRemote()).toEqual(["refs/heads/meddle/task/t1/p", "refs/heads/meddle/task/t1/p.spike", "refs/heads/meddle/task/t2/p"]);

  await bookmarkForget(repo, taskGlob("t1"));
  await bookmarkForget(repo, taskGlob("t9"));
  expect((await bookmarkList(repo)).map((b) => `${b.name}@${b.remote ?? ""}`).sort()).toEqual(["meddle/task/t2/p@", "meddle/task/t2/p@r", "spike@"]);
});

test("a task's namespace, its glob and a side bookmark's name", async () => {
  const { sideBookmark, taskGlob, taskNamespace } = await import("../src/tasks/manifest");
  expect(taskNamespace("abc")).toBe("meddle/task/abc/");
  expect(taskGlob("abc")).toBe("glob:meddle/task/abc/*");
  expect(sideBookmark("abc", "proj", "spike")).toBe("meddle/task/abc/proj.spike");
});

/** Commits `files` on top of `parent` in `repo` as `message` (a commit that `parent` is the parent of); its commit id. */
async function commitOn(repo: string, parent: string, message: string, files: Record<string, string>): Promise<string> {
  await jj(["new", parent], repo);
  for (const [name, content] of Object.entries(files)) await Bun.write(`${repo}/${name}`, content);
  await jj(["commit", "-m", message], repo);
  return commitOf(repo, "@-");
}

test("workspaceAdd with two revisions makes a merge: the new working copy's parents equal both", async () => {
  const repo = await mkdtemp("/tmp/meddle-jj-");
  await initColocated(repo);
  const base = await commitOn(repo, "root()", "base", { "f.txt": "a\nb\nc\n" });
  const left = await commitOn(repo, base, "left", { "l.txt": "l\n" });
  const right = await commitOn(repo, base, "right", { "r.txt": "r\n" });
  const parents = async (ws: string) => (await jj(["log", "--ignore-working-copy", "-r", "@", "--no-graph", "-T", 'parents.map(|c| c.commit_id()).join(",")'], ws)).trim().split(",");

  const merge = `${repo}-merge`;
  await workspaceAdd(repo, "merge", merge, [left, right]);
  expect(await parents(merge)).toEqual([left, right]);
  // The merge has both sides' files.
  expect(await Bun.file(`${merge}/l.txt`).text()).toBe("l\n");
  expect(await Bun.file(`${merge}/r.txt`).text()).toBe("r\n");

  // One revision, as a string or a list of one, is an ordinary start.
  const one = `${repo}-one`;
  await workspaceAdd(repo, "one", one, left);
  expect(await parents(one)).toEqual([left]);
  const alone = `${repo}-alone`;
  await workspaceAdd(repo, "alone", alone, [right]);
  expect(await parents(alone)).toEqual([right]);
});

test("abandon drops empty leftovers", async () => {
  const repo = await mkdtemp("/tmp/meddle-jj-");
  await initColocated(repo);
  const base = await commitOn(repo, "root()", "base", { "f.txt": "a\n" });
  const tip = await commitOn(repo, base, "tip", { "g.txt": "g\n" });
  await jj(["new", base], repo);
  const leftover = await commitOf(repo, "@");
  // (A revset naming an abandoned commit by its id still finds it: look in everything visible.)
  const alive = async (commit: string) => (await commitsIn(repo, "all()")).some((c) => c.commitId === commit);
  expect(await alive(leftover)).toBe(true);

  await abandon(repo, leftover);
  expect(await alive(leftover)).toBe(false);
  // What it did not select stays.
  expect(await alive(tip)).toBe(true);
  expect(await alive(base)).toBe(true);
  // A revset selecting nothing is no error.
  await abandon(repo, `${leftover} & ${tip}`);
  expect(await alive(tip)).toBe(true);
});

test("abandon moves a bookmark on a leftover to its parent instead of deleting it", async () => {
  const repo = await mkdtemp("/tmp/meddle-jj-");
  await initColocated(repo);
  const base = await commitOn(repo, "root()", "base", { "f.txt": "a\n" });
  const leftover = await commitOn(repo, base, "", {});
  await bookmarkSet(repo, "meddle/task/t/p", leftover);
  await abandon(repo, leftover);
  const [line] = await bookmarkList(repo);
  expect(line).toMatchObject({ name: "meddle/task/t/p", remote: null, conflicted: false });
  expect((await commitsIn(repo, "meddle/task/t/p")).map((c) => c.commitId)).toEqual([base]);
});

test("abandon with ignoreWorkingCopy never snapshots the working copy", async () => {
  const repo = await mkdtemp("/tmp/meddle-jj-");
  await initColocated(repo);
  const base = await commitOn(repo, "root()", "base", { "f.txt": "a\n" });
  const leftover = await commitOn(repo, base, "", {});
  const other = await commitOn(repo, base, "", {});
  await jj(["new", base], repo);
  const recorded = async () => (await jj(["diff", "--ignore-working-copy", "-r", "@", "--name-only"], repo)).split("\n").filter(Boolean);
  await Bun.write(`${repo}/edited.txt`, "x\n");
  await abandon(repo, leftover, undefined, { ignoreWorkingCopy: true });
  expect((await commitsIn(repo, "all()")).map((c) => c.commitId)).not.toContain(leftover);
  expect(await recorded()).not.toContain("edited.txt");
  // Without the option, the edit is snapshotted.
  await abandon(repo, other);
  expect(await recorded()).toContain("edited.txt");
});

test("commitsIn reports empty, conflict, description and mutability", async () => {
  const repo = await mkdtemp("/tmp/meddle-jj-");
  await initColocated(repo);
  const base = await commitOn(repo, "root()", "base", { "f.txt": "a\nb\nc\n" });
  const described = await commitOn(repo, base, "one line\n\nthe body of it", { "g.txt": "g\n" });
  const bare = await commitOn(repo, described, "", {});
  const left = await commitOn(repo, base, "left", { "f.txt": "L\nb\nc\n" });
  const right = await commitOn(repo, base, "right", { "f.txt": "R\nb\nc\n" });
  const merge = await commitOn(repo, `${left} | ${right}`, "both", {});
  // The root has no description and no parents.
  const [root] = await commitsIn(repo, "root()");
  expect(root).toMatchObject({ parents: [], empty: true, conflict: false, description: "", mutable: false });

  const [d] = await commitsIn(repo, described);
  expect(d).toMatchObject({ commitId: described, parents: [base], empty: false, conflict: false, mutable: true });
  expect(d!.description.trimEnd()).toBe("one line\n\nthe body of it");
  expect(d!.changeId).toMatch(/^[k-z]{32}$/);

  const [b] = await commitsIn(repo, bare);
  expect(b).toMatchObject({ commitId: bare, parents: [described], empty: true, conflict: false, description: "", mutable: true });

  const [m] = await commitsIn(repo, merge);
  expect(m).toMatchObject({ commitId: merge, conflict: true, description: "both\n" });
  expect(m!.parents.sort()).toEqual([left, right].sort());

  // Several commits come in `jj log` order (the newest first) and the revset may select any.
  expect((await commitsIn(repo, `${base} | ${described} | ${bare}`)).map((c) => c.commitId)).toEqual([bare, described, base]);
  expect(await commitsIn(repo, `${merge} & ~conflicts()`)).toEqual([]);
  expect((await commitsIn(repo, `${merge} & conflicts()`)).map((c) => c.commitId)).toEqual([merge]);

  // `mutable` is the view of the directory it runs in: a task workspace's own `immutable_heads()` makes its base so.
  const ws = `${repo}-ws`;
  await workspaceAdd(repo, "ws", ws, [described]);
  await configSetWorkspace(ws, 'revset-aliases."immutable_heads()"', `present(${described})`);
  const view = async (cwd: string) => Object.fromEntries((await commitsIn(cwd, `${base} | ${described} | ${bare}`)).map((c) => [c.commitId, c.mutable]));
  expect(await view(repo)).toEqual({ [base]: true, [described]: true, [bare]: true });
  expect(await view(ws)).toEqual({ [base]: false, [described]: false, [bare]: true });
});
