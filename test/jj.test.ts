// test/jj.test.ts
import { test, expect } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { initColocated, isJjRepo, workspaceAdd, workspaceForget, changeId, bookmarkSet } from "../src/jj";
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
