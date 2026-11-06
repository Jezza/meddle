import { expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { paths } from "../src/config";
import { bookmarkList, bookmarkRefs, commitOf, fetch, git, initColocated, isJjRepo, jj, remoteList } from "../src/jj";
import { ensureMemoryReplica } from "../src/memory";
import { shortId } from "../src/pool/identity";
import { addProjectFromFolder, addProjectFromUpstream, checkSyncNames, getProject, listProjects, setProjectSync, type Project } from "../src/projects/project";
import { holdLines, homeLines } from "../src/projects/lines";
import { ensureRemote, ensureReplica, fetchBookmarks, fetchSync, pushBookmark, type ReplicaDeps } from "../src/projects/replicas";
import { taskGlob } from "../src/tasks/manifest";
import { peerReady, startPoolNode, twoPoolNodes, type GitPoolNode } from "./pool-helpers";

const depsOf = (n: GitPoolNode): ReplicaDeps => ({ cfg: n.cfg, db: n.db, pool: n.pool });

async function changeOf(node: GitPoolNode, repo: string, rev: string): Promise<string> {
  return (await jj(["log", "-r", rev, "--no-graph", "-T", "change_id"], repo, node.cfg)).trim();
}

/** Gives A's project a commit with a file and points `main` at it; returns its change id. */
async function makeMain(A: GitPoolNode): Promise<string> {
  const repo = A.project.replica;
  await writeFile(`${repo}/README`, "hello\n");
  await jj(["commit", "-m", "init"], repo, A.cfg);
  await jj(["bookmark", "set", "main", "-r", "@-"], repo, A.cfg);
  return changeOf(A, repo, "main");
}

/** A commit with `file` on top of `parent` in B's `repo`; returns its change id. */
async function commitOn(node: GitPoolNode, repo: string, parent: string, file: string): Promise<string> {
  await jj(["new", parent], repo, node.cfg);
  await writeFile(`${repo}/${file}`, `${file}\n`);
  await jj(["commit", "-m", file], repo, node.cfg);
  return changeOf(node, repo, "@-");
}

test("ensureReplica clones a project and its memory from home", async () => {
  const { A, B, close } = await twoPoolNodes();
  try {
    const main = await makeMain(A);
    const id = A.project.id;
    const shortA = shortId(A.id);
    const memoryA = paths(A.cfg).memory(id);
    await writeFile(`${memoryA}/MEMORY.md`, "- from a\n");
    await jj(["commit", "-m", "memory"], memoryA, A.cfg);
    await jj(["bookmark", "set", "memory", "-r", "@-"], memoryA, A.cfg);
    const memoryChange = await changeOf(A, memoryA, "memory");
    await peerReady(B, A);

    const project = await ensureReplica(depsOf(B), id);
    const url = `meddle://${A.id}/project/${id}`;
    expect(project).toEqual({ id, name: "a", source: { kind: "upstream", url }, replica: paths(B.cfg).replica(id), home: A.id, sync: [], upstream: false });
    expect(getProject(B.db, id)).toEqual(project);
    expect(await remoteList(project.replica, B.cfg)).toEqual([{ name: shortA, url }]);
    const memoryB = paths(B.cfg).memory(id);
    expect(await isJjRepo(memoryB)).toBe(true);
    expect(await remoteList(memoryB, B.cfg)).toEqual([{ name: shortA, url: `meddle://${A.id}/memory/${id}` }]);
    expect(await bookmarkList(memoryB, B.cfg)).toContainEqual({ name: "memory", remote: shortA, changeId: memoryChange, conflicted: false });

    // The clone brought the home's bookmarks, under the home's remote.
    expect(await bookmarkList(project.replica, B.cfg)).toContainEqual({ name: "main", remote: shortA, changeId: main, conflicted: false });

    // A second call is a no-op.
    expect(await ensureReplica(depsOf(B), id)).toEqual(project);
    expect(listProjects(B.db).map((p: Project) => p.id).sort()).toEqual([B.project.id, id].sort());

    // ensureRemote is idempotent and corrects a remote's url.
    const memoryUrl = `meddle://${A.id}/memory/${id}`;
    expect(await ensureRemote(B.cfg, memoryB, A.id, { kind: "memory", id })).toBe(shortA);
    await jj(["git", "remote", "set-url", shortA, url], memoryB, B.cfg);
    expect(await ensureRemote(B.cfg, memoryB, A.id, { kind: "memory", id })).toBe(shortA);
    expect(await remoteList(memoryB, B.cfg)).toEqual([{ name: shortA, url: memoryUrl }]);

    await expect(fetchBookmarks(B.cfg, project.replica, A.id, ["exact:nope"])).rejects.toThrow(`bookmark nope not found on ${shortA}`);

    // With the home offline, a replica that is gone cannot be cloned again.
    await rm(project.replica, { recursive: true, force: true });
    A.net.unwatch(B.id, "bye");
    B.net.unwatch(A.id, "bye");
    await expect(ensureReplica(depsOf(B), id)).rejects.toThrow(`home ${shortA} is offline`);
  } finally {
    await close();
  }
}, 15_000);

test("pushBookmark reaches the home fresh, over an untracked remote bookmark, and after the home's copy moved", async () => {
  const { A, B, close } = await twoPoolNodes();
  try {
    const shortA = shortId(A.id);
    // `memory` in the project's memory repo: the one bookmark a peer pushes into a home's own bookmarks.
    const home = await ensureMemoryReplica(A.cfg, A.project.id);
    await peerReady(B, A);
    await ensureReplica(depsOf(B), A.project.id);
    const repo = paths(B.cfg).memory(A.project.id);
    const onA = async () => (await bookmarkList(home, A.cfg)).find((b) => b.name === "memory" && b.remote === null)?.changeId;

    // 1. Fresh.
    const first = await commitOn(B, repo, "root()", "one");
    await pushBookmark(B.cfg, repo, A.id, "memory", first);
    expect(await onA()).toBe(first);

    // 2. `memory@<shortA>` is there but untracked.
    await jj(["bookmark", "untrack", "exact:memory", "--remote", `exact:${shortA}`], repo, B.cfg);
    expect((await bookmarkRefs(repo, "exact:memory", B.cfg)).find((r) => r.remote === shortA)?.tracked).toBe(false);
    const second = await commitOn(B, repo, first, "two");
    await pushBookmark(B.cfg, repo, A.id, "memory", second);
    expect(await onA()).toBe(second);

    // 3. A's copy moved ahead of what B last saw; B's push moves it sideways.
    const ahead = await commitOn(A, home, second, "ahead");
    await jj(["bookmark", "set", "memory", "-r", ahead], home, A.cfg);
    const third = await commitOn(B, repo, second, "three");
    await pushBookmark(B.cfg, repo, A.id, "memory", third);
    expect(await onA()).toBe(third);
    expect(A.logs.filter((l) => l.startsWith("meddle: git:"))).toEqual([]);
  } finally {
    await close();
  }
}, 15_000);

test("fetchBookmarks takes a glob: every match arrives, and no match is an error unless requireMatch is false", async () => {
  const { A, B, close } = await twoPoolNodes();
  try {
    const mainChange = await makeMain(A);
    const shortA = shortId(A.id);
    await peerReady(B, A);
    const project = await ensureReplica(depsOf(B), A.project.id);
    for (const name of ["meddle/task/t1/a", "meddle/task/t1/a.spike", "meddle/task/t2/a"]) {
      await jj(["bookmark", "set", name, "-r", "main"], A.project.replica, A.cfg);
    }
    await fetchBookmarks(B.cfg, project.replica, A.id, [taskGlob("t1")]);
    const fetched = (await bookmarkList(project.replica, B.cfg)).filter((b) => b.name.startsWith("meddle/task/"));
    expect(fetched).toEqual([
      { name: "meddle/task/t1/a", remote: shortA, changeId: mainChange, conflicted: false },
      { name: "meddle/task/t1/a.spike", remote: shortA, changeId: mainChange, conflicted: false },
    ]);
    // An exact pattern beside a glob; each is checked.
    await fetchBookmarks(B.cfg, project.replica, A.id, ["exact:meddle/task/t2/a", taskGlob("t1")]);
    await expect(fetchBookmarks(B.cfg, project.replica, A.id, [taskGlob("t9")])).rejects.toThrow(`no bookmark matching meddle/task/t9/* on ${shortA}`);
    await fetchBookmarks(B.cfg, project.replica, A.id, [taskGlob("t9")], { requireMatch: false });
    await expect(fetchBookmarks(B.cfg, project.replica, A.id, ["exact:meddle/task/t9/a"])).rejects.toThrow(`bookmark meddle/task/t9/a not found on ${shortA}`);
  } finally {
    await close();
  }
}, 15_000);

test("holdLines writes a task's bookmarks as its line: forced from another node, by update-ref on the home; the home's own bookmarks stay untouched", async () => {
  const { A, B, close } = await twoPoolNodes();
  try {
    const mainChange = await makeMain(A);
    await peerReady(B, A);
    const project = await ensureReplica(depsOf(B), A.project.id);
    const repo = project.replica;
    const home = A.project.replica;
    const refs = async (prefix: string) =>
      (await git(["for-each-ref", "--format=%(refname:lstrip=4) %(objectname)", prefix], home, A.cfg)).split("\n").filter(Boolean);
    // A bookmark of the task's in the home repo itself (one an older meddle pushed there): no line write touches it.
    await jj(["bookmark", "set", "meddle/task/t1/a", "-r", mainChange], home, A.cfg);
    const homeBookmarksBefore = await refs("refs/heads/meddle/task");
    expect(homeBookmarksBefore).toEqual([`t1/a ${await commitOf(home, mainChange, A.cfg)}`]);

    // Nothing under the task's namespace on B is nothing to push.
    await holdLines(B.cfg, B.id, repo, project, "t9");
    expect(await homeLines(A.cfg, home)).toEqual([]);

    // Two bookmarks on B become the line; then a rewrite of the project's bookmark goes over it, forced.
    const first = await commitOn(B, repo, mainChange, "one");
    await jj(["bookmark", "set", "meddle/task/t1/a", "meddle/task/t1/a.spike", "-r", first], repo, B.cfg);
    await holdLines(B.cfg, B.id, repo, project, "t1");
    const firstCommit = await commitOf(repo, first, B.cfg);
    expect(await homeLines(A.cfg, home, "t1")).toEqual([
      { taskId: "t1", name: "a", commitId: firstCommit },
      { taskId: "t1", name: "a.spike", commitId: firstCommit },
    ]);
    await jj(["describe", "-r", "meddle/task/t1/a", "-m", "one, reworded"], repo, B.cfg);
    const reworded = await commitOf(repo, "meddle/task/t1/a", B.cfg);
    await holdLines(B.cfg, B.id, repo, project, "t1");
    expect((await homeLines(A.cfg, home, "t1")).map((l) => l.commitId)).toEqual([reworded, reworded]);
    expect(await refs("refs/heads/meddle/task")).toEqual(homeBookmarksBefore);

    // On the home: its own bookmarks of a task are written to the line, under the same names.
    const onHome = await commitOn(A, home, mainChange, "home");
    await jj(["bookmark", "set", "meddle/task/t2/a", "-r", onHome], home, A.cfg);
    await holdLines(A.cfg, A.id, home, { ...A.project, home: A.id }, "t2");
    expect(await homeLines(A.cfg, home, "t2")).toEqual([{ taskId: "t2", name: "a", commitId: await commitOf(home, onHome, A.cfg) }]);
    expect(A.logs.filter((l) => l.startsWith("meddle: git:"))).toEqual([]);
  } finally {
    await close();
  }
}, 15_000);

/** A plain git repo at `dir` whose HEAD is `head`, with one commit on it and one on each of `others`; returns the commits. */
async function makeUpstream(dir: string, head: string, others: string[]): Promise<Record<string, string>> {
  const g = (...args: string[]) => git(["-c", "user.name=t", "-c", "user.email=t@t", ...args], dir);
  await Bun.$`mkdir -p ${dir}`;
  await g("init", "-b", head);
  const commits: Record<string, string> = {};
  for (const branch of [head, ...others]) {
    if (branch !== head) await g("checkout", "-b", branch, head);
    await writeFile(`${dir}/${branch.replace("/", "_")}`, `${branch}\n`);
    await g("add", ".");
    await g("commit", "-m", branch);
    commits[branch] = (await g("rev-parse", "HEAD")).trim();
  }
  await g("checkout", head);
  return commits;
}

/** The commit id of `rev` in `repo`. */
async function commitIdOf(node: GitPoolNode, repo: string, rev: string): Promise<string> {
  return (await jj(["log", "-r", rev, "--no-graph", "-T", "commit_id"], repo, node.cfg)).trim();
}

test("a url project's sync is the upstream's default branch then each --sync once; a folder project's is set by setProjectSync", async () => {
  const A = await startPoolNode();
  try {
    await makeUpstream(`${A.home}/up`, "master", ["dev"]);
    const url = await addProjectFromUpstream(A.cfg, A.db, `${A.home}/up`, A.id, "up", ["dev", "master"]);
    expect(url.sync).toEqual(["master", "dev"]);
    expect(getProject(A.db, url.id)!.sync).toEqual(["master", "dev"]);
    // An upstream with no commits has no default branch.
    await Bun.$`git init -b main ${A.home}/empty`.quiet();
    expect((await addProjectFromUpstream(A.cfg, A.db, `${A.home}/empty`, A.id, "empty", ["x"])).sync).toEqual(["x"]);

    expect(A.project.sync).toEqual([]);
    expect(setProjectSync(A.db, A.project.id, ["main", "release/1.2", "main"])!.sync).toEqual(["main", "release/1.2"]);
    expect(getProject(A.db, A.project.id)!.sync).toEqual(["main", "release/1.2"]);
    expect(setProjectSync(A.db, A.project.id, [])!.sync).toEqual([]);
    expect(setProjectSync(A.db, "nope", ["x"])).toBeNull();
    // An existing row (NULL) reads as none.
    A.db.query("UPDATE projects SET sync = NULL WHERE id = ?").run(url.id);
    expect(getProject(A.db, url.id)!.sync).toEqual([]);
  } finally {
    await A.close();
  }
}, 30_000);

test("a replica learns the sync list from the home; fetchSync gives the home's commit, then the last fetched copy, then rejects", async () => {
  const { A, B, close } = await twoPoolNodes();
  try {
    const repo = A.project.replica;
    await makeMain(A);
    const release = await commitOn(A, repo, "main", "release");
    await jj(["bookmark", "set", "release/1.2", "-r", release], repo, A.cfg);
    setProjectSync(A.db, A.project.id, ["main", "release/1.2"]);
    const onA = getProject(A.db, A.project.id)!;
    const wanted = await commitIdOf(A, repo, "release/1.2");
    // On the home a folder project's branch is its local bookmark.
    expect(await fetchSync(depsOf(A), onA, "release/1.2")).toBe(wanted);
    await expect(fetchSync(depsOf(A), onA, "other")).rejects.toThrow("other is not a sync branch of a");

    await peerReady(B, A);
    const replica = await ensureReplica(depsOf(B), A.project.id);
    expect(replica.sync).toEqual(["main", "release/1.2"]);
    const logs: string[] = [];
    const deps = { ...depsOf(B), log: (line: string) => logs.push(line) };
    expect(await fetchSync(deps, replica, "release/1.2")).toBe(wanted);
    expect(logs).toEqual([]);
    await expect(fetchSync(deps, replica, "other")).rejects.toThrow("other is not a sync branch of a");
    // A name the home listed is stored as it came; one that is no legal branch name never reaches git or jj.
    setProjectSync(B.db, A.project.id, ["main", "release/1.2", "--upload-pack=x", "a..b"]);
    const listed = getProject(B.db, A.project.id)!;
    await expect(fetchSync(deps, listed, "--upload-pack=x")).rejects.toThrow('invalid sync branch name "--upload-pack=x"');
    await expect(fetchSync(deps, listed, "a..b")).rejects.toThrow('invalid sync branch name "a..b"');

    // The home changes the list: the replica takes it on its next ensureReplica.
    setProjectSync(A.db, A.project.id, ["release/1.2"]);
    expect((await ensureReplica(depsOf(B), A.project.id)).sync).toEqual(["release/1.2"]);
    expect(getProject(B.db, A.project.id)!.sync).toEqual(["release/1.2"]);
    // A branch made after B cloned: B has no copy of it.
    await jj(["bookmark", "set", "late", "-r", release], repo, A.cfg);
    setProjectSync(A.db, A.project.id, ["main", "release/1.2", "late"]);
    await ensureReplica(depsOf(B), A.project.id);

    // The home goes away: the copy fetched last (the clone brought `main`, `release/1.2` too), and nothing for `late`.
    A.net.unwatch(B.id, "bye");
    B.net.unwatch(A.id, "bye");
    const deadline = Date.now() + 10_000;
    while (B.net.isOnline(A.id) || A.net.isOnline(B.id)) {
      if (Date.now() > deadline) throw new Error("the nodes never went offline");
      await Bun.sleep(20);
    }
    const stale = getProject(B.db, A.project.id)!;
    expect(await fetchSync(deps, stale, "release/1.2")).toBe(wanted);
    expect(logs).toEqual(["meddle: project a: home offline; starting from release/1.2 as fetched last"]);
    await expect(fetchSync(deps, stale, "late")).rejects.toThrow(`home ${shortId(A.id)} is offline`);
  } finally {
    await close();
  }
}, 30_000);

test("fetchSync on the home of a url project fetches the branch from the upstream", async () => {
  const A = await startPoolNode();
  try {
    const commits = await makeUpstream(`${A.home}/up`, "master", ["dev"]);
    const project = await addProjectFromUpstream(A.cfg, A.db, `${A.home}/up`, A.id, "up", ["dev"]);
    expect(await fetchSync(depsOf(A), project, "dev")).toBe(commits.dev!);
    // The upstream moves on; the next call sees it.
    await git(["checkout", "dev"], `${A.home}/up`);
    await writeFile(`${A.home}/up/more`, "more\n");
    await git(["add", "."], `${A.home}/up`);
    await git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "more"], `${A.home}/up`);
    const moved = (await git(["rev-parse", "HEAD"], `${A.home}/up`)).trim();
    expect(await fetchSync(depsOf(A), project, "dev")).toBe(moved);
    expect(await fetchSync(depsOf(A), project, "master")).toBe(commits.master!);
    setProjectSync(A.db, project.id, ["dev", "gone"]);
    await expect(fetchSync(depsOf(A), project, "gone")).rejects.toThrow("bookmark gone not found on origin");
  } finally {
    await A.close();
  }
}, 30_000);

test("sync branch names must be legal: empty, leading dash and malformed names are refused when added, not stored", async () => {
  const A = await startPoolNode();
  try {
    await checkSyncNames(A.cfg, ["main", "release/1.2", "feature-x"]);
    for (const bad of ["", "-x", "--flag", "a..b", "a b", "x.lock", "@{-1}", "a~1"]) {
      await expect(checkSyncNames(A.cfg, ["main", bad])).rejects.toThrow(`invalid sync branch name "${bad}"`);
    }
    const before = listProjects(A.db).length;
    await expect(addProjectFromFolder(A.cfg, A.db, `${A.home}/nope`, A.id, "n", ["-x"])).rejects.toThrow('invalid sync branch name "-x"');
    await makeUpstream(`${A.home}/up`, "master", []);
    await expect(addProjectFromUpstream(A.cfg, A.db, `${A.home}/up`, A.id, "u", ["a b"])).rejects.toThrow('invalid sync branch name "a b"');
    expect(listProjects(A.db).length).toBe(before);
  } finally {
    await A.close();
  }
}, 30_000);
