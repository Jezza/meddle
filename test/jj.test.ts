// test/jj.test.ts
import { test, expect } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { loadConfig } from "../src/config";
import { initColocated, isJjRepo, workspaceAdd, workspaceForget, changeId, bookmarkList, bookmarkSet, fetch, jj, push, remoteAdd, track } from "../src/jj";
import { shortId } from "../src/pool/identity";
import { refreshTrunk } from "../src/projects/replicas";
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

test("listing bookmarks and resolving the home's trunk import git's refs and never snapshot the working copy", async () => {
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

  // the resolution sees git's newest main (moved again, behind jj's back) and sets `trunk` there, never snapshotting
  const three = git("commit-tree", `${one}^{tree}`, "-p", two, "-m", "three");
  git("update-ref", "refs/heads/main", three);
  const home = await mkdtemp("/tmp/meddle-jj-home-");
  const cfg = loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/d`, MEDDLE_TASK_ROOT: `${home}/t` });
  const threeChange = await refreshTrunk(cfg, repo);
  expect(threeChange).toBe((await jj(["log", "--ignore-working-copy", "-r", three, "--no-graph", "-T", "change_id"], repo)).trim());
  expect(await recorded()).not.toContain("edited.txt");
  // exported to git, for peers that fetch it
  expect(git("rev-parse", "refs/heads/trunk")).toBe(three);
  // and once `trunk` is there, a refresh adds no operation
  before = await ops();
  expect(await refreshTrunk(cfg, repo)).toBe(threeChange);
  expect(await ops()).toBe(before);
});

test("a peer's fetch and push against a home with an edit in its checkout never snapshot that checkout", async () => {
  const { A, B, close } = await twoPoolNodes();
  try {
    const home = A.project.replica;
    await Bun.write(`${home}/README`, "hello\n");
    await jj(["commit", "-m", "init"], home, A.cfg);
    // `main`, not `trunk`: the fetch below has the home set `trunk` itself.
    await bookmarkSet(home, "main", "@-", A.cfg);
    await Bun.write(`${home}/edited.txt`, "x\n");
    const opIds = async () => (await jj(["op", "log", "--ignore-working-copy", "--no-graph", "-T", 'id ++ "\\n"'], home, A.cfg)).split("\n").filter(Boolean);
    const known = new Set(await opIds());

    const shortA = shortId(A.id);
    const repo = `${B.home}/r`;
    await initColocated(repo, B.cfg);
    await remoteAdd(repo, shortA, `meddle://${A.id}/project/${A.project.id}`, B.cfg);
    await fetch(repo, shortA, ["trunk"], B.cfg);
    await jj(["new", `trunk@${shortA}`], repo, B.cfg);
    await Bun.write(`${repo}/work`, "from b\n");
    await jj(["commit", "-m", "work"], repo, B.cfg);
    await track(repo, "exact:meddle/task/t1/p", shortA, B.cfg);
    await bookmarkSet(repo, "meddle/task/t1/p", "@-", B.cfg);
    await push(repo, shortA, "exact:meddle/task/t1/p", B.cfg);
    // a second fetch finds `trunk` in place
    await fetch(repo, shortA, ["trunk"], B.cfg);

    const fresh = (await opIds()).filter((id) => !known.has(id));
    const described = await Promise.all(fresh.map(async (id) => (await jj(["op", "show", "--ignore-working-copy", id, "--no-graph", "-T", "description", "--no-op-diff"], home, A.cfg)).trim()));
    expect(described.filter((d) => d.startsWith("snapshot"))).toEqual([]);
    // the trunk set and the pushed bookmark's import, nothing else
    expect(fresh.length).toBeLessThanOrEqual(2);
    expect((await jj(["diff", "--ignore-working-copy", "-r", "@", "--name-only"], home, A.cfg)).split("\n")).not.toContain("edited.txt");
    expect((await bookmarkList(home, A.cfg)).map((b) => b.name).sort()).toEqual(["main", "meddle/task/t1/p", "trunk"]);
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
