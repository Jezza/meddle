// test/graph.test.ts
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureDataDirs, loadConfig } from "../src/config";
import { bookmarkSet, commitOf, git, initColocated, jj } from "../src/jj";
import { graphProbe, olderGraph, projectGraph, type GraphCommit } from "../src/projects/graph";

/**
 * A replica of project `a` with `main` on c1←c2←c3; off c2, task t1's line (two commits), its side line `a.before-1`,
 * task t2's line held elsewhere (`task/t2/a@meddle`) and archived task t3's line; off c3, the local branch `spike`.
 */
async function graphRepo() {
  const home = await mkdtemp("/tmp/meddle-graph-");
  const cfg = loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/data`, MEDDLE_TASK_ROOT: `${home}/tasks` });
  await ensureDataDirs(cfg);
  const replica = `${home}/replica`;
  await initColocated(replica, cfg);
  let n = 0;
  const commit = async (parent: string | null, message: string) => {
    if (parent !== null) await jj(["new", parent], replica, cfg);
    await writeFile(join(replica, `f${n++}`), `${message}\n`);
    await jj(["commit", "-m", message], replica, cfg);
    return commitOf(replica, "@-", cfg);
  };
  const c1 = await commit(null, "c1");
  const c2 = await commit(null, "c2");
  const c3 = await commit(null, "c3\n\nmore words");
  await bookmarkSet(replica, "main", c3, cfg);
  const t1a = await commit(c2, "t1 one");
  const t1b = await commit(null, "t1 two");
  await bookmarkSet(replica, "meddle/task/t1/a", t1b, cfg);
  const before = await commit(c2, "t1 before");
  await bookmarkSet(replica, "meddle/task/t1/a.before-1", before, cfg);
  const t2 = await commit(c2, "t2");
  await git(["update-ref", "refs/remotes/meddle/task/t2/a", t2], replica, cfg);
  await jj(["git", "import"], replica, cfg);
  const t3 = await commit(c2, "t3");
  await bookmarkSet(replica, "meddle/task/t3/a", t3, cfg);
  const spike = await commit(c3, "spike");
  await bookmarkSet(replica, "spike", spike, cfg);
  const archived = new Set(["t3"]);
  return { cfg, replica, archived, c1, c2, c3, t1a, t1b, before, t2, t3, spike, close: () => rm(home, { recursive: true, force: true }) };
}

const ids = (commits: GraphCommit[]) => commits.map((c) => c.commit);

const ROOT = "0".repeat(40);

/** Whether every commit comes before its parents in `commits` (newest first). */
function newestFirst(commits: GraphCommit[]): boolean {
  const at = new Map(commits.map((c, i) => [c.commit, i]));
  return commits.every((c, i) => c.parents.every((p) => (at.get(p) ?? Infinity) > i));
}

test("graphProbe counts branches and live task lines", async () => {
  const { cfg, replica, archived, c3, t1b, t2, t3, spike, close } = await graphRepo();
  try {
    const probe = await graphProbe(cfg, replica, "a", archived);
    expect(probe.heads).toEqual([
      { bookmark: { kind: "branch", name: "main" }, commit: c3 },
      { bookmark: { kind: "branch", name: "spike" }, commit: spike },
      { bookmark: { kind: "task", task: "t1" }, commit: t1b },
      { bookmark: { kind: "task", task: "t2" }, commit: t2 },
    ]);
    // t3's line is left out only for being archived.
    expect((await graphProbe(cfg, replica, "a", new Set())).heads).toContainEqual({ bookmark: { kind: "task", task: "t3" }, commit: t3 });
    // The same bookmarks give the same key; a moved one another.
    expect((await graphProbe(cfg, replica, "a", archived)).key).toBe(probe.key);
    await bookmarkSet(replica, "spike", c3, cfg, { ignoreWorkingCopy: true });
    expect((await graphProbe(cfg, replica, "a", archived)).key).not.toBe(probe.key);
    // Another project's lines are not this one's.
    expect((await graphProbe(cfg, replica, "b", archived)).heads.map((h) => h.bookmark.kind)).toEqual(["branch", "branch"]);
  } finally {
    await close();
  }
});

test("projectGraph reads from the default branch's parent up", async () => {
  const { cfg, replica, archived, c1, c2, c3, t1a, t1b, t2, spike, close } = await graphRepo();
  try {
    const probe = await graphProbe(cfg, replica, "a", archived);
    const graph = await projectGraph(cfg, replica, probe, "main");
    expect(ids(graph).toSorted()).toEqual([t1a, t1b, t2, spike, c3, c2].toSorted());
    expect(newestFirst(graph)).toBe(true);
    const byId = new Map(graph.map((c) => [c.commit, c]));
    expect(byId.get(c3)).toMatchObject({ description: "c3", parents: [c2], bookmarks: [{ kind: "branch", name: "main" }] });
    expect(byId.get(c2)).toMatchObject({ immutable: true, parents: [c1], bookmarks: [] });
    expect(byId.get(t1b)).toMatchObject({ description: "t1 two", immutable: false, parents: [t1a], bookmarks: [{ kind: "task", task: "t1" }] });
    expect(byId.get(t2)!.bookmarks).toEqual([{ kind: "task", task: "t2" }]);
    const change = (await jj(["--ignore-working-copy", "log", "-r", c3, "--no-graph", "-T", "change_id"], replica, cfg)).trim();
    expect(byId.get(c3)!.change).toBe(change);
    const time = Date.parse((await jj(["--ignore-working-copy", "log", "-r", c3, "--no-graph", "-T", 'committer.timestamp().format("%+")'], replica, cfg)).trim());
    expect(byId.get(c3)!.time).toBe(time);

    // Without a default branch (or with one it does not have), down to c1, never the root.
    const all = [c1, c2, c3, t1a, t1b, t2, spike].toSorted();
    expect(ids(await projectGraph(cfg, replica, probe, null)).toSorted()).toEqual(all);
    expect(ids(await projectGraph(cfg, replica, probe, "trunk")).toSorted()).toEqual(all);
    // The newest two.
    const two = await projectGraph(cfg, replica, probe, "main", 2);
    expect(ids(two)).toEqual(ids(graph).slice(0, 2));
    expect(two[0]!.bookmarks).not.toEqual([]);
    expect(await projectGraph(cfg, replica, { key: "", heads: [] }, "main")).toEqual([]);

    // A bookmark named like `main`'s commit id is not that commit: read as one, `main--` would be the root, and c1 in.
    await bookmarkSet(replica, c3, c2, cfg, { ignoreWorkingCopy: true });
    const named = await graphProbe(cfg, replica, "a", archived);
    expect(ids(await projectGraph(cfg, replica, named, "main")).toSorted()).toEqual(ids(graph).toSorted());
  } finally {
    await close();
  }
});

test("projectGraph reads a branch below the default branch's parent, with its bookmark", async () => {
  const { cfg, replica, archived, c1, c2, close } = await graphRepo();
  try {
    await bookmarkSet(replica, "release", c1, cfg, { ignoreWorkingCopy: true });
    const probe = await graphProbe(cfg, replica, "a", archived);
    const graph = await projectGraph(cfg, replica, probe, "main");
    expect(graph.find((c) => c.commit === c1)).toMatchObject({ parents: [], bookmarks: [{ kind: "branch", name: "release" }] });
    // Only its own commit: what lies between it and the range is for Older.
    expect(ids(graph)).toContain(c2);
    expect(newestFirst(graph)).toBe(true);
  } finally {
    await close();
  }
});

test("olderGraph reads past the default branch's parent", async () => {
  const { cfg, replica, archived, c1, close } = await graphRepo();
  try {
    const probe = await graphProbe(cfg, replica, "a", archived);
    const older = await olderGraph(cfg, replica, probe, 400);
    expect(ids(older)).toContain(c1);
    expect(ids(older)).not.toContain(ROOT);
    // Nor is it c1's parent.
    expect(older.find((c) => c.commit === c1)!.parents).toEqual([]);
    expect(newestFirst(older)).toBe(true);
    expect(await olderGraph(cfg, replica, probe, 3)).toHaveLength(3);
  } finally {
    await close();
  }
});

test("projectGraph labels every target of a conflicted bookmark", async () => {
  const { cfg, replica, archived, c2, c3, close } = await graphRepo();
  try {
    const op = (await jj(["--ignore-working-copy", "op", "log", "-n", "1", "--no-graph", "-T", "id"], replica, cfg)).trim();
    await bookmarkSet(replica, "spike", c3, cfg, { ignoreWorkingCopy: true });
    await jj(["--ignore-working-copy", "--at-op", op, "bookmark", "set", "spike", "-r", c2, "--allow-backwards"], replica, cfg);

    const probe = await graphProbe(cfg, replica, "a", archived);
    const byId = new Map((await projectGraph(cfg, replica, probe, "main")).map((c) => [c.commit, c]));
    expect(byId.get(c3)!.bookmarks).toContainEqual({ kind: "branch", name: "spike" });
    expect(byId.get(c3)!.bookmarks).toContainEqual({ kind: "branch", name: "main" });
    expect(byId.get(c2)!.bookmarks).toEqual([{ kind: "branch", name: "spike" }]);
  } finally {
    await close();
  }
});

test("graph reads write nothing to the replica", async () => {
  const { cfg, replica, archived, close } = await graphRepo();
  try {
    const opId = async () => (await jj(["--ignore-working-copy", "op", "log", "-n", "1", "--no-graph", "-T", "id"], replica, cfg)).trim();
    const op = await opId();
    // A file the working copy has not seen: a snapshot would record it.
    await writeFile(join(replica, "unseen"), "x\n");
    const probe = await graphProbe(cfg, replica, "a", archived);
    await projectGraph(cfg, replica, probe, "main");
    await olderGraph(cfg, replica, probe, 10);
    expect(await opId()).toBe(op);
  } finally {
    await close();
  }
});
