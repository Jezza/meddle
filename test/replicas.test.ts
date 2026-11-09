import { expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { paths } from "../src/config";
import { bookmarkList, bookmarkRefs, commitOf, fetch, git, isJjRepo, jj, remoteList } from "../src/jj";
import { ensureMemoryReplica } from "../src/memory";
import { shortId } from "../src/pool/identity";
import { getProject, listProjects, type Project } from "../src/projects/project";
import { ensureRemote, ensureServiceRepo, pushBookmark, type ReplicaDeps } from "../src/projects/replicas";
import { linkNodes, peerReady, twoPoolNodes, type GitPoolNode } from "./pool-helpers";

const depsOf = (n: GitPoolNode): ReplicaDeps => ({ cfg: n.cfg, db: n.db, pool: n.pool });

async function changeOf(node: GitPoolNode, repo: string, rev: string): Promise<string> {
  return (await jj(["log", "-r", rev, "--no-graph", "-T", "change_id"], repo, node.cfg)).trim();
}

/** Gives A's project a commit with a file on `main` and points `main` at it; returns its change id. */
async function makeMain(A: GitPoolNode): Promise<string> {
  const repo = A.project.replica;
  await jj(["new", "main"], repo, A.cfg);
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

test("ensureServiceRepo makes an empty service repo with the home's remote, and clones the memory from home", async () => {
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

    const project = await ensureServiceRepo(depsOf(B), id);
    const url = `meddle://${A.id}/project/${id}`;
    expect(project).toEqual({
      id, name: "a", source: { kind: "upstream", url }, replica: paths(B.cfg).replica(id), home: A.id, defaultBranch: "main",
    });
    expect(getProject(B.db, id)).toEqual(project);
    expect(await remoteList(project.replica, B.cfg)).toEqual([{ name: shortA, url }]);
    const memoryB = paths(B.cfg).memory(id);
    expect(await isJjRepo(memoryB)).toBe(true);
    expect(await remoteList(memoryB, B.cfg)).toEqual([{ name: shortA, url: `meddle://${A.id}/memory/${id}` }]);
    expect(await bookmarkList(memoryB, B.cfg)).toContainEqual({ name: "memory", remote: shortA, changeId: memoryChange, conflicted: false });

    // Not a clone: no bookmark of the home's yet, `@` on the root commit, git's `HEAD` on no branch.
    expect(await bookmarkList(project.replica, B.cfg)).toEqual([]);
    expect(await commitOf(project.replica, "@-", B.cfg)).toBe(await commitOf(project.replica, "root()", B.cfg));
    expect((await git(["symbolic-ref", "HEAD"], project.replica, B.cfg)).trim()).toBe("refs/jj/root");
    // The home's bookmarks come when fetched.
    await fetch(project.replica, shortA, ["exact:main"], B.cfg);
    expect(await bookmarkList(project.replica, B.cfg)).toContainEqual({ name: "main", remote: shortA, changeId: main, conflicted: false });

    // A second call is a no-op.
    expect(await ensureServiceRepo(depsOf(B), id)).toEqual(project);
    expect(listProjects(B.db).map((p: Project) => p.id).sort()).toEqual([B.project.id, id].sort());

    // ensureRemote is idempotent and corrects a remote's url.
    const memoryUrl = `meddle://${A.id}/memory/${id}`;
    expect(await ensureRemote(B.cfg, memoryB, A.id, { kind: "memory", id })).toBe(shortA);
    await jj(["git", "remote", "set-url", shortA, url], memoryB, B.cfg);
    expect(await ensureRemote(B.cfg, memoryB, A.id, { kind: "memory", id })).toBe(shortA);
    expect(await remoteList(memoryB, B.cfg)).toEqual([{ name: shortA, url: memoryUrl }]);

    // With the home offline, a service repo that is gone is made again all the same; its memory waits for the home.
    await rm(project.replica, { recursive: true, force: true });
    await rm(memoryB, { recursive: true, force: true });
    A.net.unwatch(B.id, "bye");
    B.net.unwatch(A.id, "bye");
    expect(await ensureServiceRepo(depsOf(B), id)).toEqual(project);
    expect(await isJjRepo(project.replica)).toBe(true);
    expect(await isJjRepo(memoryB)).toBe(false);
    // Once the home is back, the next call clones the memory.
    A.net.watch(B.id);
    B.net.watch(A.id);
    await linkNodes(A, B);
    const back = Date.now() + 10_000;
    while (!B.net.isOnline(A.id)) {
      if (Date.now() > back) throw new Error("the home never came back");
      await Bun.sleep(10);
    }
    await peerReady(B, A);
    await ensureServiceRepo(depsOf(B), id);
    expect(await bookmarkList(memoryB, B.cfg)).toContainEqual({ name: "memory", remote: shortA, changeId: memoryChange, conflicted: false });
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
    await ensureServiceRepo(depsOf(B), A.project.id);
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
