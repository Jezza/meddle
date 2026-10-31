import { expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { paths } from "../src/config";
import { bookmarkList, fetch, initColocated, isJjRepo, jj, remoteList } from "../src/jj";
import { shortId } from "../src/pool/identity";
import { addProjectFromFolder, getProject, listProjects, type Project } from "../src/projects/project";
import { ensureRemote, ensureReplica, fetchBookmarks, pushBookmark, remoteHeads, trunkFor, type ReplicaDeps } from "../src/projects/replicas";
import { peerReady, startPoolNode, twoPoolNodes, type GitPoolNode } from "./pool-helpers";

const depsOf = (n: GitPoolNode): ReplicaDeps => ({ cfg: n.cfg, db: n.db, pool: n.pool });

async function changeOf(node: GitPoolNode, repo: string, rev: string): Promise<string> {
  return (await jj(["log", "-r", rev, "--no-graph", "-T", "change_id"], repo, node.cfg)).trim();
}

/** Gives A's project a commit with a file and points `main` (not `trunk`) at it; returns its change id. */
async function makeMain(A: GitPoolNode): Promise<string> {
  const repo = A.project.replica;
  await writeFile(`${repo}/README`, "hello\n");
  await jj(["commit", "-m", "init"], repo, A.cfg);
  await jj(["bookmark", "set", "main", "-r", "@-"], repo, A.cfg);
  return changeOf(A, repo, "main");
}

/** The change A's local bookmark `name` points at, or undefined. */
async function localOn(node: GitPoolNode, repo: string, name: string): Promise<string | undefined> {
  return (await bookmarkList(repo, node.cfg)).find((b) => b.name === name && b.remote === null)?.changeId;
}

/** A commit with `file` on top of `parent` in B's `repo`; returns its change id. */
async function commitOn(node: GitPoolNode, repo: string, parent: string, file: string): Promise<string> {
  await jj(["new", parent], repo, node.cfg);
  await writeFile(`${repo}/${file}`, `${file}\n`);
  await jj(["commit", "-m", file], repo, node.cfg);
  return changeOf(node, repo, "@-");
}

test("ensureReplica clones a project and its memory from home, and trunkFor follows the home's trunk", async () => {
  const { A, B, close } = await twoPoolNodes();
  try {
    const trunk = await makeMain(A);
    // A's project has `main` and no `trunk`: a peer's fetch makes the home point `trunk` at it first.
    expect(await localOn(A, A.project.replica, "trunk")).toBeUndefined();
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
    expect(project).toEqual({ id, name: "a", source: { kind: "upstream", url }, replica: paths(B.cfg).replica(id), home: A.id });
    expect(getProject(B.db, id)).toEqual(project);
    expect(await remoteList(project.replica, B.cfg)).toEqual([{ name: shortA, url }]);
    const memoryB = paths(B.cfg).memory(id);
    expect(await isJjRepo(memoryB)).toBe(true);
    expect(await remoteList(memoryB, B.cfg)).toEqual([{ name: shortA, url: `meddle://${A.id}/memory/${id}` }]);
    expect(await bookmarkList(memoryB, B.cfg)).toContainEqual({ name: "memory", remote: shortA, changeId: memoryChange, conflicted: false });

    // On B the trunk is the home's, fetched; on A it is the local `trunk` bookmark, not root.
    const onB = await trunkFor(depsOf(B), project);
    expect(onB).toBe(`trunk@${shortA}`);
    expect(await changeOf(B, project.replica, onB)).toBe(trunk);
    expect(await localOn(A, A.project.replica, "trunk")).toBe(trunk);
    expect(await trunkFor(depsOf(A), A.project)).toBe(trunk);
    // A moves `main` on; B's next trunkFor sees it.
    const next = await commitOn(A, A.project.replica, "main", "next");
    await jj(["bookmark", "set", "main", "-r", next], A.project.replica, A.cfg);
    expect(await changeOf(B, project.replica, await trunkFor(depsOf(B), project))).toBe(next);
    // A folder project with no commits starts at root.
    expect(await trunkFor(depsOf(B), B.project)).toBe("root()");
    expect(await remoteHeads(B.cfg, project.replica)).toContainEqual({ name: "trunk", remote: shortA, changeId: next, conflicted: false });

    // A second call is a no-op.
    expect(await ensureReplica(depsOf(B), id)).toEqual(project);
    expect(listProjects(B.db).map((p: Project) => p.id).sort()).toEqual([B.project.id, id].sort());

    // ensureRemote is idempotent and corrects a remote's url.
    const memoryUrl = `meddle://${A.id}/memory/${id}`;
    expect(await ensureRemote(B.cfg, memoryB, A.id, { kind: "memory", id })).toBe(shortA);
    await jj(["git", "remote", "set-url", shortA, url], memoryB, B.cfg);
    expect(await ensureRemote(B.cfg, memoryB, A.id, { kind: "memory", id })).toBe(shortA);
    expect(await remoteList(memoryB, B.cfg)).toEqual([{ name: shortA, url: memoryUrl }]);

    await expect(fetchBookmarks(B.cfg, project.replica, A.id, ["nope"])).rejects.toThrow(`bookmark nope not found on ${shortA}`);

    // With the home offline, a replica that is gone cannot be cloned again.
    await rm(project.replica, { recursive: true, force: true });
    A.net.unwatch(B.id, "bye");
    B.net.unwatch(A.id, "bye");
    await expect(ensureReplica(depsOf(B), id)).rejects.toThrow(`home ${shortA} is offline`);
    await expect(trunkFor(depsOf(B), project)).rejects.toThrow(`home ${shortA} is offline`);
  } finally {
    await close();
  }
}, 15_000);

test("pushBookmark reaches the home fresh, over an untracked remote bookmark, and after the home's copy moved", async () => {
  const { A, B, close } = await twoPoolNodes();
  try {
    const trunk = await makeMain(A);
    const shortA = shortId(A.id);
    await peerReady(B, A);
    const project = await ensureReplica(depsOf(B), A.project.id);
    const repo = project.replica;
    const onA = async (name: string) => (await bookmarkList(A.project.replica, A.cfg)).find((b) => b.name === name && b.remote === null);

    // 1. Fresh.
    const first = await commitOn(B, repo, trunk, "one");
    await pushBookmark(B.cfg, repo, A.id, "meddle/task/t1/a", first);
    expect(await onA("meddle/task/t1/a")).toEqual({ name: "meddle/task/t1/a", remote: null, changeId: first, conflicted: false });

    // 2. A fetch left an untracked `meddle/task/t2/a@<shortA>`.
    await jj(["bookmark", "set", "meddle/task/t2/a", "-r", "main"], A.project.replica, A.cfg);
    await fetch(repo, shortA, ["glob:meddle/task/*"], B.cfg);
    expect(await bookmarkList(repo, B.cfg)).toContainEqual({ name: "meddle/task/t2/a", remote: shortA, changeId: trunk, conflicted: false });
    const second = await commitOn(B, repo, trunk, "two");
    await pushBookmark(B.cfg, repo, A.id, "meddle/task/t2/a", second);
    expect((await onA("meddle/task/t2/a"))?.changeId).toBe(second);

    // 3. A's copy of t1 moved ahead of what B last saw; B's push moves it sideways.
    const ahead = await commitOn(A, A.project.replica, first, "ahead");
    await jj(["bookmark", "set", "meddle/task/t1/a", "-r", ahead], A.project.replica, A.cfg);
    const third = await commitOn(B, repo, first, "three");
    await pushBookmark(B.cfg, repo, A.id, "meddle/task/t1/a", third);
    expect((await onA("meddle/task/t1/a"))?.changeId).toBe(third);
    expect(A.logs.filter((l) => l.startsWith("meddle: git:"))).toEqual([]);
  } finally {
    await close();
  }
}, 15_000);

test("on the home, trunk follows the newest of trunk and main, and a project added on main gets a trunk", async () => {
  const A = await startPoolNode();
  try {
    const deps: ReplicaDeps = { cfg: A.cfg, db: A.db, pool: A.pool };
    const folder = `${A.home}/onmain`;
    await initColocated(folder, A.cfg);
    await writeFile(`${folder}/README`, "hello\n");
    await jj(["commit", "-m", "init"], folder, A.cfg);
    await jj(["bookmark", "set", "main", "-r", "@-"], folder, A.cfg);
    const main = (await jj(["log", "-r", "main", "--no-graph", "-T", "change_id"], folder, A.cfg)).trim();
    const project = await addProjectFromFolder(A.cfg, A.db, folder, A.id, "onmain");
    const local = async (name: string) => (await bookmarkList(folder, A.cfg)).find((b) => b.name === name && b.remote === null)?.changeId;
    expect(await local("trunk")).toBe(main);
    expect(await trunkFor(deps, project)).toBe(main);

    const commit = async (parent: string, file: string) => {
      await jj(["new", parent], folder, A.cfg);
      await writeFile(`${folder}/${file}`, `${file}\n`);
      await jj(["commit", "-m", file], folder, A.cfg);
      return (await jj(["log", "-r", "@-", "--no-graph", "-T", "change_id"], folder, A.cfg)).trim();
    };
    // `trunk` ahead of `main`: trunk stays.
    const ahead = await commit(main, "ahead");
    await jj(["bookmark", "set", "trunk", "-r", ahead], folder, A.cfg);
    expect(await trunkFor(deps, project)).toBe(ahead);
    expect(await local("trunk")).toBe(ahead);
    expect(await local("main")).toBe(main);
    // `main` ahead of `trunk`: trunk follows main.
    const newer = await commit(ahead, "newer");
    await jj(["bookmark", "set", "main", "-r", newer], folder, A.cfg);
    expect(await trunkFor(deps, project)).toBe(newer);
    expect(await local("trunk")).toBe(newer);
  } finally {
    await A.close();
    A.db.close();
    await rm(A.home, { recursive: true, force: true });
  }
}, 15_000);
