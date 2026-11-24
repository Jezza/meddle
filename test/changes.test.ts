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
      expect(listed).toMatchObject({ project: "p1", name: "a", start: main ? "feature" : short, conflicted: false });
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
      expect(await taskChanges(cfg, project, "t2")).toMatchObject({ start: main ? "feature" : short, conflicted: false, changes: [] });

      // Without the default branch on the base, a bookmark that is not a task's line wins over one that is.
      if (!main) {
        await bookmarkSet(replica, "meddle/task/x/a", base.commit, cfg);
        expect((await taskChanges(cfg, project, TASK, { defaultBranch: "main" })).start).toBe("meddle/task/x/a");
        await bookmarkSet(replica, "trunk", base.commit, cfg);
        expect((await taskChanges(cfg, project, TASK, { defaultBranch: "main" })).start).toBe("trunk");
      }
    } finally {
      await close();
    }
  }
});

test("taskChanges leaves out what the default branch has", async () => {
  const { cfg, replica, project, base, first, second, close } = await taskRepo({ main: true });
  try {
    const line = `meddle/task/${TASK}/a`;
    const lineAt = () => commitOf(replica, JSON.stringify(line), cfg);
    // `main` moves on past the task's start with a file of its own, and the task's line is rebased onto it.
    await jj(["new", base.commit], replica, cfg);
    await writeFile(join(replica, "up.txt"), "up\n");
    await jj(["commit", "-m", "upstream"], replica, cfg);
    const upstream = await commitOf(replica, "@-", cfg);
    await bookmarkSet(replica, "main", upstream, cfg, { ignoreWorkingCopy: true });
    await jj(["--ignore-working-copy", "rebase", "-s", first.commit, "-d", upstream], replica, cfg);
    expect((await taskChanges(cfg, project, TASK)).changes.map((c) => c.description)).toEqual(["", "second", "first", "upstream"]);
    const rebased = await taskChanges(cfg, project, TASK, { defaultBranch: "main" });
    // The line is on `main` now, not on the base it started on.
    expect(rebased).toMatchObject({ start: "main", conflicted: false });
    expect(rebased.changes.map((c) => c.description)).toEqual(["", "second", "first"]);
    expect(rebased.changes.map((c) => c.workingCopy)).toEqual([true, false, false]);
    expect(rebased.changes[0]!.commit).toBe(await lineAt());
    expect(rebased.changes[1]!.change).toBe(second.change);
    // `All changes` is diffed from where the line leaves `main`, so `main`'s file is not in it.
    expect(rebased.from).toBe(upstream);
    const all = await changeDiff(cfg, project, rebased.changes[0]!.commit, rebased.from!);
    expect(all).toContain("diff --git a/a.txt b/a.txt");
    expect(all).not.toContain("up.txt");
    // Without the default branch, from the task's base: `main`'s file is in it.
    const plain = await taskChanges(cfg, project, TASK);
    expect(plain).toMatchObject({ start: "feature", from: base.commit });
    expect(await changeDiff(cfg, project, plain.changes[0]!.commit, plain.from!)).toContain("up.txt");

    // `main` moves on again: the line is on a commit no bookmark is on, named by its short change id.
    await writeFile(join(replica, "later.txt"), "later\n");
    await jj(["commit", "-m", "later"], replica, cfg);
    await bookmarkSet(replica, "main", "@-", cfg);
    const short = (await jj(["--ignore-working-copy", "log", "-r", upstream, "--no-graph", "-T", "change_id.short(8)"], replica, cfg)).trim();
    expect(await taskChanges(cfg, project, TASK, { defaultBranch: "main" })).toMatchObject({ start: short, from: upstream });

    // The line merged into `main`: none left.
    await bookmarkSet(replica, "main", await lineAt(), cfg, { ignoreWorkingCopy: true });
    expect(await taskChanges(cfg, project, TASK, { defaultBranch: "main" })).toMatchObject({ start: "main", from: await lineAt(), changes: [] });
  } finally {
    await close();
  }
});

test("changeDiff gives one change or the whole range", async () => {
  const { cfg, project, first, close } = await taskRepo({ main: true });
  try {
    const one = await changeDiff(cfg, project, first.change);
    expect(one).toContain("diff --git a/a.txt b/a.txt");
    expect(one).toContain("+one");
    expect(one).not.toContain("b.txt");

    const listed = await taskChanges(cfg, project, TASK);
    const all = await changeDiff(cfg, project, listed.changes[0]!.commit, listed.from!);
    expect(all).toContain("diff --git a/a.txt b/a.txt");
    expect(all).toContain("diff --git a/b.txt b/b.txt");
    expect(all).toContain("+three");
    expect(all).not.toContain("other.txt");

    for (const bad of ["@", "all()", `${first.change} | root()`, `${first.change}--`]) {
      await expect(changeDiff(cfg, project, bad)).rejects.toThrow(/^bad-id: /);
      await expect(changeDiff(cfg, project, first.change, bad)).rejects.toThrow(/^bad-id: /);
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
    // A task with no project works in its own folder.
    expect(await workspaceFile(cfg, [], TASK, join(home, "tasks", TASK, "x"))).toBe("outside\n");
    await expect(workspaceFile(cfg, [], TASK, join(home, "secret"))).rejects.toThrow(/^outside: /);
    await expect(workspaceFile(cfg, [], "t2", join(home, "tasks", TASK, "x"))).rejects.toThrow(/^outside: /);
    // Nor its own files: its transcripts are there.
    await mkdir(join(home, "tasks", TASK, ".meddle"), { recursive: true });
    await writeFile(join(home, "tasks", TASK, ".meddle", "t.jsonl"), "{}\n");
    await expect(workspaceFile(cfg, [], TASK, join(home, "tasks", TASK, ".meddle", "t.jsonl"))).rejects.toThrow(/^outside: /);
    // Absent there too: outside, not absent.
    await expect(workspaceFile(cfg, [], TASK, join(home, "tasks", TASK, ".meddle", "gone.jsonl"))).rejects.toThrow(/^outside: /);
    await symlink(join(home, "tasks", TASK, ".meddle", "t.jsonl"), join(home, "tasks", TASK, "y"));
    await expect(workspaceFile(cfg, [], TASK, join(home, "tasks", TASK, "y"))).rejects.toThrow(/^outside: /);

    await mkdir(join(ws, "dir"));
    await expect(workspaceFile(cfg, [project], TASK, join(ws, "dir"))).rejects.toThrow(/^not-a-file: /);
    await writeFile(join(ws, "big"), Buffer.alloc(3 * 1024 * 1024, "x"));
    await expect(workspaceFile(cfg, [project], TASK, join(ws, "big"))).rejects.toThrow(/^too-large: /);

    // A FIFO is no file, and reading it must not wait for a writer.
    const fifo = join(ws, "fifo");
    const made = await Bun.spawn(["mkfifo", fifo], { stdout: "ignore", stderr: "ignore" }).exited.catch(() => 1);
    if (made === 0) await expect(workspaceFile(cfg, [project], TASK, fifo)).rejects.toThrow(/^not-a-file: /);
    else console.warn("mkfifo unavailable: FIFO case skipped");
  } finally {
    await close();
  }
});

test("reads write nothing to the replica", async () => {
  const { cfg, replica, ws, project, base, first, close } = await taskRepo({ main: true });
  try {
    await writeFile(join(ws, "c.txt"), "unsnapshotted\n");
    await writeFile(join(replica, "d.txt"), "the user's\n");
    const op = () => jj(["--ignore-working-copy", "op", "log", "-n", "1", "--no-graph", "-T", "id"], replica, cfg);
    const before = await op();
    await taskChanges(cfg, project, TASK);
    await changeDiff(cfg, project, first.change, base.commit);
    await changeDiff(cfg, project, first.change);
    await changeFile(cfg, project, first.change, "a.txt");
    await workspaceFile(cfg, [project], TASK, join(ws, "c.txt"));
    expect(await op()).toBe(before);
  } finally {
    await close();
  }
});

test("a conflicted line is reported, not listed", async () => {
  const { cfg, replica, project, first, second, close } = await taskRepo({ main: true });
  try {
    const line = `meddle/task/${TASK}/a`;
    const op = (await jj(["--ignore-working-copy", "op", "log", "-n", "1", "--no-graph", "-T", "id"], replica, cfg)).trim();
    await bookmarkSet(replica, line, first.commit, cfg, { ignoreWorkingCopy: true });
    await jj(["--ignore-working-copy", "--at-op", op, "bookmark", "set", line, "-r", second.commit, "--allow-backwards"], replica, cfg);

    expect(await taskChanges(cfg, project, TASK)).toEqual({ project: "p1", name: "a", start: "feature", conflicted: true, from: null, changes: [] });
  } finally {
    await close();
  }
});

test("a base missing from the replica fails loudly", async () => {
  const { cfg, project, close } = await taskRepo({ main: true });
  try {
    const unknown = { ...project, base: ["f".repeat(40)] };
    await expect(taskChanges(cfg, unknown, TASK)).rejects.toThrow();
  } finally {
    await close();
  }
});
