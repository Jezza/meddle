import { expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { paths } from "../src/config";
import { bookmarkList, bookmarkRefs, commitOf, fetch, git, isJjRepo, jj, remoteList } from "../src/jj";
import { ensureMemoryReplica } from "../src/memory";
import { shortId } from "../src/pool/identity";
import { markRemoved } from "../src/pool/removed";
import { forgetProject, getProject, listProjects, type Project } from "../src/projects/project";
import { ensureRemote, ensureServiceRepo, rosterProjectIds, settled, type ReplicaDeps } from "../src/projects/replicas";
import { NodeObject } from "../src/state/contracts";
import { linkClient, linkNodes, peerReady, twoPoolNodes, type GitPoolNode } from "./pool-helpers";

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

test("ensureServiceRepo makes an empty service repo with the home's remote, and an empty memory repo of its own", async () => {
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
    // The scope sync fills it from the pool's heads: nothing is cloned, no remote.
    expect(await remoteList(memoryB, B.cfg)).toEqual([]);
    expect(await bookmarkList(memoryB, B.cfg)).not.toContainEqual(expect.objectContaining({ changeId: memoryChange }));

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

    // With the home offline, a service repo that is gone is made again all the same, and its memory repo with it.
    await rm(project.replica, { recursive: true, force: true });
    await rm(memoryB, { recursive: true, force: true });
    A.net.unwatch(B.id, "bye");
    B.net.unwatch(A.id, "bye");
    expect(await ensureServiceRepo(depsOf(B), id)).toEqual(project);
    expect(await isJjRepo(project.replica)).toBe(true);
    expect(await isJjRepo(memoryB)).toBe(true);
  } finally {
    await close();
  }
}, 15_000);

test("a default branch set on a node other than the home is set on the home, so the next sweep keeps it", async () => {
  const { A, B, close } = await twoPoolNodes();
  const link = linkClient(B.host);
  try {
    const id = A.project.id;
    await peerReady(B, A);
    await ensureServiceRepo(depsOf(B), id);
    const node = await link.client.get(NodeObject, {});
    try {
      expect((await node.setDefaultBranch({ projectId: id, branch: "dev" })).defaultBranch).toBe("dev");
      expect(getProject(A.db, id)!.defaultBranch).toBe("dev");
      expect(getProject(B.db, id)!.defaultBranch).toBe("dev");
      // B's sweep takes the home's: the same.
      expect((await ensureServiceRepo(depsOf(B), id)).defaultBranch).toBe("dev");
      // With the home offline it is refused, and nothing changes here.
      A.net.unwatch(B.id, "bye");
      B.net.unwatch(A.id, "bye");
      await expect(node.setDefaultBranch({ projectId: id, branch: "next" })).rejects.toThrow("is offline: its default branch is set there");
      expect(getProject(B.db, id)!.defaultBranch).toBe("dev");
    } finally {
      node.release();
    }
  } finally {
    await link.close();
    await close();
  }
}, 15_000);

test("a replica gets an empty memory repo of its own, for the scope sync to fill", async () => {
  const { A, B, close } = await twoPoolNodes();
  try {
    await peerReady(B, A);
    await ensureServiceRepo(depsOf(B), A.project.id);
    const repo = paths(B.cfg).memory(A.project.id);
    expect(await isJjRepo(repo)).toBe(true);
    // Not a clone of the home's: no remote, nothing fetched.
    expect((await jj(["git", "remote", "list"], repo, B.cfg)).trim()).toBe("");
  } finally {
    await close();
  }
}, 15_000);

test("a removed project is never rebuilt from a peer", async () => {
  const { A, B, close } = await twoPoolNodes();
  try {
    await makeMain(A);
    const id = A.project.id;
    await peerReady(B, A);
    const project = await ensureServiceRepo(depsOf(B), id);
    expect(await isJjRepo(project.replica)).toBe(true);

    // B removes it: the row and the repos go, the removed list keeps the id.
    forgetProject(B.db, id);
    await rm(project.replica, { recursive: true, force: true });
    await rm(paths(B.cfg).memory(id), { recursive: true, force: true });
    markRemoved(B.db, { id, name: "a", removedAt: "2026-11-23T10:00:00.000Z", removedBy: B.id });

    const deadline = Date.now() + 10_000;
    while (B.store.row(A.id)?.summary?.projects.some((p) => p.id === id) !== true) {
      if (Date.now() > deadline) throw new Error("A's summary never listed the project");
      await Bun.sleep(10);
    }
    await expect(ensureServiceRepo(depsOf(B), id)).rejects.toThrow(`project ${shortId(id)} was removed`);
    expect(rosterProjectIds(B.pool, B.db).has(id)).toBe(false);
    expect(rosterProjectIds(B.pool, B.db).has(B.project.id)).toBe(true);
    expect(getProject(B.db, id)).toBeNull();
    expect(await isJjRepo(project.replica)).toBe(false);
    expect(await isJjRepo(paths(B.cfg).memory(id))).toBe(false);
  } finally {
    await close();
  }
}, 15_000);

test("settled waits for a service repo being made, and resolves at once when none is", async () => {
  const { A, B, close } = await twoPoolNodes();
  try {
    const id = A.project.id;
    await peerReady(B, A);
    await settled(B.cfg, id);
    const making = ensureServiceRepo(depsOf(B), id, { memory: false });
    await settled(B.cfg, id);
    expect(getProject(B.db, id)).not.toBeNull();
    await making;
  } finally {
    await close();
  }
}, 15_000);
