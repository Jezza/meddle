// test/changes.test.ts
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureDataDirs, loadConfig, paths } from "../src/config";
import { bookmarkSet, changeId, commitOf, initColocated, jj, workspaceAdd } from "../src/jj";
import { changeDiff, changeFile, taskChanges, workspaceFile } from "../src/tasks/changes";
import type { ManifestProject } from "../src/tasks/manifest";

const TASK = "t1";

/**
 * A project's replica with an other line `B` (the task's base) then `C` (bookmark `other`) and, with `main`, a first
 * commit bookmarked `main` under them and the bookmark `feature` on `B`; a task workspace made on `B` as
 * `provisionTask` makes one (child mode), with two committed changes and a non-empty working copy, and the task's
 * bookmark on that working copy as `writeLineRows` leaves it.
 */
async function taskRepo(options: { main: boolean }) {
  const home = await mkdtemp("/tmp/meddle-changes-");
  const cfg = loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/data`, MEDDLE_TASK_ROOT: `${home}/tasks` });
  await ensureDataDirs(cfg);
  const replica = `${home}/replica`;
  await initColocated(replica, cfg);
  const commit = async (repo: string, file: string, text: string, message: string) => {
    await writeFile(join(repo, file), text);
    await jj(["commit", "-m", message], repo, cfg);
    return { change: (await jj(["log", "-r", "@-", "--no-graph", "-T", "change_id"], repo, cfg)).trim(), commit: await commitOf(repo, "@-", cfg) };
  };
  const init = options.main ? await commit(replica, "README", "a\n", "init") : null;
  if (options.main) await bookmarkSet(replica, "main", "@-", cfg);
  const base = await commit(replica, "other.txt", "b\n", "base");
  if (options.main) await bookmarkSet(replica, "feature", "@-", cfg);
  const other = await commit(replica, "other.txt", "c\n", "other line");
  await bookmarkSet(replica, "other", "@-", cfg);

  const task = paths(cfg).task(TASK);
  await mkdir(task, { recursive: true });
  const ws = join(task, "a");
  await workspaceAdd(replica, `meddle-${TASK}`, ws, base.commit, cfg);
  const line = `meddle/task/${TASK}/a`;
  await bookmarkSet(replica, line, await commitOf(ws, "@", cfg), cfg, { ignoreWorkingCopy: true });
  const first = await commit(ws, "a.txt", "one\n", "first");
  await writeFile(join(ws, "b.txt"), "bee\n");
  const second = await commit(ws, "a.txt", "one\ntwo\n", "second\n\nmore words");
  await writeFile(join(ws, "a.txt"), "one\ntwo\nthree\n");
  await bookmarkSet(replica, line, await changeId(ws, cfg), cfg, { ignoreWorkingCopy: true });

  const project: ManifestProject = { id: "p1", name: "a", replica, workspace: "a", parent: base.commit, base: [base.commit], context: null };
  return { home, cfg, replica, ws, project, init, base, other, first, second, close: () => rm(home, { recursive: true, force: true }) };
}

test("taskChanges lists only the task's own work", async () => {
  for (const main of [true, false]) {
    const { cfg, replica, project, init, base, other, first, second, close } = await taskRepo({ main });
    try {
      const listed = await taskChanges(cfg, project, TASK);
      const short = (await jj(["--ignore-working-copy", "log", "-r", base.commit, "--no-graph", "-T", "change_id.short(8)"], replica, cfg)).trim();
      expect(listed).toMatchObject({ project: "p1", name: "a", start: main ? "feature" : short });
      expect(listed.changes.map((c) => c.description)).toEqual(["", "second", "first"]);
      expect(listed.changes.map((c) => c.workingCopy)).toEqual([true, false, false]);
      const [wc, two, one] = listed.changes;
      expect(wc).toMatchObject({ files: 1, added: 1, removed: 0, empty: false, conflicted: false });
      expect(two).toMatchObject({ change: second.change, commit: second.commit, files: 2, added: 2, removed: 0, empty: false, conflicted: false });
      expect(one).toMatchObject({ change: first.change, commit: first.commit, files: 1, added: 1, removed: 0 });
      const commits = listed.changes.map((c) => c.commit);
      for (const outside of [base, other, ...(init === null ? [] : [init])]) expect(commits).not.toContain(outside.commit);

      // The project's default branch wins over the other bookmarks on the base.
      if (main) {
        await bookmarkSet(replica, "zz", base.commit, cfg);
        expect((await taskChanges(cfg, project, TASK)).start).toBe("feature");
        expect((await taskChanges(cfg, project, TASK, { defaultBranch: "zz" })).start).toBe("zz");
      }
      // No line here: no changes.
      expect(await taskChanges(cfg, project, "t2")).toMatchObject({ start: main ? "feature" : short, changes: [] });
    } finally {
      await close();
    }
  }
});

test("changeDiff gives one change or the whole range", async () => {
  const { cfg, project, first, close } = await taskRepo({ main: true });
  try {
    const one = await changeDiff(cfg, project, TASK, first.change);
    expect(one).toContain("diff --git a/a.txt b/a.txt");
    expect(one).toContain("+one");
    expect(one).not.toContain("b.txt");

    const all = await changeDiff(cfg, project, TASK, "all");
    expect(all).toContain("diff --git a/a.txt b/a.txt");
    expect(all).toContain("diff --git a/b.txt b/b.txt");
    expect(all).toContain("+three");
    expect(all).not.toContain("other.txt");

    expect(await changeDiff(cfg, project, "t2", "all")).toBe("");
    for (const bad of ["@", "all()", `${first.change} | root()`, `${first.change}--`]) {
      await expect(changeDiff(cfg, project, TASK, bad)).rejects.toThrow(/^bad-id: /);
    }
  } finally {
    await close();
  }
});

test("changeFile reads a revision and the parent form", async () => {
  const { cfg, project, base, first, second, close } = await taskRepo({ main: true });
  try {
    expect(await changeFile(cfg, project, second.change, "a.txt")).toBe("one\ntwo\n");
    expect(await changeFile(cfg, project, `${second.change}-`, "a.txt")).toBe("one\n");
    expect(await changeFile(cfg, project, `${first.change}-`, "a.txt")).toBeNull();
    expect(await changeFile(cfg, project, base.commit, "other.txt")).toBe("b\n");
    expect(await changeFile(cfg, project, second.change, "nope.txt")).toBeNull();
    await expect(changeFile(cfg, project, "@", "a.txt")).rejects.toThrow(/^bad-id: /);
  } finally {
    await close();
  }
});

test("workspaceFile stays inside the workspace", async () => {
  const { home, cfg, ws, project, close } = await taskRepo({ main: true });
  try {
    expect(await workspaceFile(cfg, [project], TASK, join(ws, "a.txt"))).toBe("one\ntwo\nthree\n");
    expect(await workspaceFile(cfg, [project], TASK, join(ws, "gone.txt"))).toBeNull();

    await writeFile(join(home, "tasks", TASK, "x"), "outside\n");
    await expect(workspaceFile(cfg, [project], TASK, `${ws}/../x`)).rejects.toThrow(/^outside: /);
    await writeFile(join(home, "secret"), "secret\n");
    await symlink(join(home, "secret"), join(ws, "link"));
    await expect(workspaceFile(cfg, [project], TASK, join(ws, "link"))).rejects.toThrow(/^outside: /);
    await expect(workspaceFile(cfg, [project], TASK, "a.txt")).rejects.toThrow(/^outside: /);

    await mkdir(join(ws, "dir"));
    await expect(workspaceFile(cfg, [project], TASK, join(ws, "dir"))).rejects.toThrow(/^not-a-file: /);
    await writeFile(join(ws, "big"), Buffer.alloc(3 * 1024 * 1024, "x"));
    await expect(workspaceFile(cfg, [project], TASK, join(ws, "big"))).rejects.toThrow(/^too-large: /);
  } finally {
    await close();
  }
});

test("reads write nothing to the replica", async () => {
  const { cfg, replica, ws, project, first, close } = await taskRepo({ main: true });
  try {
    await writeFile(join(ws, "c.txt"), "unsnapshotted\n");
    await writeFile(join(replica, "d.txt"), "the user's\n");
    const op = () => jj(["--ignore-working-copy", "op", "log", "-n", "1", "--no-graph", "-T", "id"], replica, cfg);
    const before = await op();
    await taskChanges(cfg, project, TASK);
    await changeDiff(cfg, project, TASK, "all");
    await changeDiff(cfg, project, TASK, first.change);
    await changeFile(cfg, project, first.change, "a.txt");
    await workspaceFile(cfg, [project], TASK, join(ws, "c.txt"));
    expect(await op()).toBe(before);
  } finally {
    await close();
  }
});
