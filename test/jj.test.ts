// test/jj.test.ts
import { test, expect } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { loadConfig } from "../src/config";
import { initColocated, isJjRepo, workspaceAdd, workspaceForget, changeId, bookmarkList, bookmarkSet, jj } from "../src/jj";
import { refreshTrunk } from "../src/projects/replicas";
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

  // the resolution sees git's newest main (moved again, behind jj's back); only its `bookmark set` snapshots
  const three = git("commit-tree", `${one}^{tree}`, "-p", two, "-m", "three");
  git("update-ref", "refs/heads/main", three);
  const home = await mkdtemp("/tmp/meddle-jj-home-");
  const cfg = loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/d`, MEDDLE_TASK_ROOT: `${home}/t` });
  const threeChange = await refreshTrunk(cfg, repo);
  expect(threeChange).toBe((await jj(["log", "--ignore-working-copy", "-r", three, "--no-graph", "-T", "change_id"], repo)).trim());
});
