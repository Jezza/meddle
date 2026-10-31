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

test("listing bookmarks and resolving the home's trunk never snapshot the working copy", async () => {
  const repo = await mkdtemp("/tmp/meddle-jj-");
  await initColocated(repo);
  await bookmarkSet(repo, "main", "@");
  const ops = async () => (await jj(["op", "log", "--ignore-working-copy", "--no-graph", "-T", 'id ++ "\\n"'], repo)).split("\n").filter(Boolean).length;
  const before = await ops();
  // an edit in the user's checkout, not snapshotted yet
  await Bun.write(`${repo}/edited.txt`, "x\n");
  const listed = await bookmarkList(repo);
  expect(listed.map((b) => `${b.name}@${b.remote}`)).toEqual(["main@null"]);
  expect(await ops()).toBe(before);
  // the resolution reads without a snapshot; only its `bookmark set` is an operation (which snapshots)
  const home = await mkdtemp("/tmp/meddle-jj-home-");
  const cfg = loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/d`, MEDDLE_TASK_ROOT: `${home}/t` });
  expect(await refreshTrunk(cfg, repo)).toBe(listed[0]!.changeId);
});
