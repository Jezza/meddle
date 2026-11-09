import { expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../src/config";
import { bookmarkRefs, changesIn, git, isJjRepo, jj, type BookmarkRef } from "../src/jj";
import { applyProject, catchUp, startApplier } from "../src/projects/applier";
import { ensureServiceRepo, type ReplicaDeps } from "../src/projects/replicas";
import { getProject } from "../src/projects/project";
import { listBranchRows, listLineRows, writeBranchRow, writeLineRow, type BranchRow, type LineRow } from "../src/pool/rows";
import type { PoolRuntime } from "../src/pool/runtime";
import { PeerObject } from "../src/state/contracts";
import { acceptGitStreams } from "../src/git/serve";
import { parseGitHeader, type Repo } from "../src/git/wire";
import type { PeerStream } from "../src/pool/net";
import { createTask } from "./helpers";
import { peerReady, poolNodes, type GitPoolNode } from "./pool-helpers";

const depsOf = (n: GitPoolNode): ReplicaDeps => ({ cfg: n.cfg, db: n.db, pool: n.pool, log: (line) => n.logs.push(line) });

/** A new commit on top of `parent` in `repo`, with the parent's tree: made by git alone, so no jj ref names it. */
async function commitOn(n: GitPoolNode, repo: string, parent: string, message: string): Promise<string> {
  const out = await git(
    ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit-tree", `${parent}^{tree}`, "-p", parent, "-m", message],
    repo, n.cfg,
  );
  return out.trim();
}

async function waitFor(what: string, cond: () => Promise<boolean> | boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

/** The service repo's bookmark entries, local and remote, by `name@remote` (local: `name`). */
async function bookmarksOf(n: GitPoolNode, repo: string): Promise<Map<string, BookmarkRef>> {
  const refs = await bookmarkRefs(repo, "glob:*", n.cfg);
  return new Map(refs.map((r) => [r.remote === null ? r.name : `${r.name}@${r.remote}`, r]));
}

/** The refs under `prefix` in `repo`, by name, with their commits. */
async function refsOf(n: GitPoolNode, repo: string, prefix: string): Promise<Map<string, string>> {
  const out = await git(["for-each-ref", "--format=%(refname) %(objectname)", prefix], repo, n.cfg);
  return new Map(out.split("\n").filter(Boolean).map((line) => line.split(" ") as [string, string]));
}

/** The view's refs as a checkout sees them (`refs/heads/…`, the namespace stripped). */
async function viewOf(n: GitPoolNode, repo: string): Promise<Map<string, string>> {
  const view = await refsOf(n, repo, "refs/namespaces/view/refs/heads/");
  return new Map([...view].map(([ref, commit]) => [ref.slice("refs/namespaces/view/".length), commit]));
}

/** Whether `commit` is a visible commit of the service repo. */
async function visible(n: GitPoolNode, repo: string, commit: string): Promise<boolean> {
  return (await changesIn(repo, `all() & present(${commit})`, n.cfg)).length > 0;
}

/** The commit of n1's own `main` row of its project. */
function mainRow(n: GitPoolNode): string {
  const row = listBranchRows(n.db, n.project.id, "main").find((r) => r.node === n.id);
  if (row?.commit == null) throw new Error("no main row");
  return row.commit;
}

/** Waits until `n` holds the row `match` picks among `project`'s branch rows. */
async function branchRowOn(n: GitPoolNode, project: string, match: (r: BranchRow) => boolean): Promise<void> {
  await waitFor("a branch row", () => listBranchRows(n.db, project).some(match));
}

async function lineRowOn(n: GitPoolNode, project: string, task: string, match: (r: LineRow) => boolean): Promise<void> {
  await waitFor(`the line row of ${task}`, () => listLineRows(n.db, project, task).some(match));
}

test("a branch row written on n1 gives n2 and n3 the commit and the bookmark", async () => {
  const { nodes, close } = await poolNodes(3);
  const stops: Array<() => void> = [];
  try {
    const [n1, n2, n3] = nodes as [GitPoolNode, GitPoolNode, GitPoolNode];
    await peerReady(n2, n1);
    await peerReady(n3, n1);
    const P = n1.project.id;
    for (const n of nodes) stops.push(startApplier(depsOf(n)));
    const x = await commitOn(n1, n1.project.replica, mainRow(n1), "x");
    writeBranchRow(n1.db, n1.id, { project: P, branch: "main", commit: x, drops: [] });
    for (const n of [n2, n3]) {
      await waitFor("main on the peer", async () => {
        const replica = getProject(n.db, P)?.replica;
        return replica !== undefined && (await bookmarksOf(n, replica).catch(() => new Map())).get("main")?.commitId === x;
      }, 30_000);
      expect(await visible(n, getProject(n.db, P)!.replica, x)).toBe(true);
    }
    // n1's own service repo follows its row too, and the commit no jj ref named is visible there now.
    await waitFor("main on n1", async () => (await bookmarksOf(n1, n1.project.replica)).get("main")?.commitId === x);
  } finally {
    for (const stop of stops) stop();
    await close();
  }
}, 60_000);

test("lines become remote refs and the view lists branches and live lines, with HEAD on the default branch", async () => {
  const { nodes, close } = await poolNodes(3);
  try {
    const [n1, n2] = nodes as [GitPoolNode, GitPoolNode, GitPoolNode];
    await peerReady(n2, n1);
    const P = n1.project.id;
    const m = mainRow(n1);
    const x = await commitOn(n1, n1.project.replica, m, "x");
    const y = await commitOn(n1, n1.project.replica, m, "y");
    writeLineRow(n1.db, { project: P, task: "t", name: "p", holder: n1.id, epoch: 0, commit: x, base: [m], archived: false });
    writeLineRow(n1.db, { project: P, task: "t2", name: "p", holder: n1.id, epoch: 0, commit: y, base: [m], archived: true });
    await lineRowOn(n2, P, "t", (r) => r.commit === x);
    await lineRowOn(n2, P, "t2", (r) => r.commit === y);

    // On n2, a line held elsewhere: `task/t/p@meddle`, untracked, with its base.
    expect(await applyProject(depsOf(n2), P)).toEqual({ pending: [] });
    const repo2 = getProject(n2.db, P)!.replica;
    const b2 = await bookmarksOf(n2, repo2);
    expect(b2.get("task/t/p@meddle")).toMatchObject({ commitId: x, tracked: false });
    expect(b2.get("base/t/p/0@meddle")).toMatchObject({ commitId: m, tracked: false });
    expect(b2.get("main")?.commitId).toBe(m);
    // An archived line is still applied to the service repo, but hidden from the view.
    expect(b2.get("task/t2/p@meddle")?.commitId).toBe(y);
    expect(await viewOf(n2, repo2)).toEqual(new Map([["refs/heads/main", m], ["refs/heads/meddle/task/t/p", x]]));
    const symref = await git(["--namespace=view", "ls-remote", "--symref", "."], repo2, n2.cfg);
    expect(symref.split("\n")).toContain("ref: refs/heads/main\tHEAD");

    // On n1, which holds the line but has no local bookmark for it yet: `task/t/p@meddle` makes the commit visible.
    await applyProject(depsOf(n1), P);
    const repo1 = n1.project.replica;
    expect((await bookmarksOf(n1, repo1)).get("task/t/p@meddle")?.commitId).toBe(x);
    expect(await visible(n1, repo1, x)).toBe(true);
    // Once the task's own bookmark exists, the remote ref goes (the local bookmark is the task's, left alone).
    await jj(["--ignore-working-copy", "bookmark", "set", "meddle/task/t/p", "-r", x], repo1, n1.cfg);
    await applyProject(depsOf(n1), P);
    const b1 = await bookmarksOf(n1, repo1);
    expect(b1.has("task/t/p@meddle")).toBe(false);
    expect(b1.get("meddle/task/t/p")?.commitId).toBe(x);
    expect(b1.get("base/t/p/0@meddle")?.commitId).toBe(m);
    expect(await visible(n1, repo1, x)).toBe(true);
  } finally {
    await close();
  }
}, 60_000);

test("a released line is forgotten, and its commit stays visible while a branch holds it", async () => {
  const { nodes, close } = await poolNodes(3);
  try {
    const [n1, n2] = nodes as [GitPoolNode, GitPoolNode, GitPoolNode];
    await peerReady(n2, n1);
    const P = n1.project.id;
    const m = mainRow(n1);
    const x = await commitOn(n1, n1.project.replica, m, "x");
    writeLineRow(n1.db, { project: P, task: "t", name: "p", holder: n1.id, epoch: 0, commit: x, base: [m], archived: false });
    writeBranchRow(n1.db, n1.id, { project: P, branch: "main", commit: x, drops: [] });
    await lineRowOn(n2, P, "t", (r) => r.commit === x);
    await branchRowOn(n2, P, (r) => r.node === n1.id && r.commit === x);
    await applyProject(depsOf(n2), P);
    const repo2 = getProject(n2.db, P)!.replica;
    expect((await bookmarksOf(n2, repo2)).get("task/t/p@meddle")?.commitId).toBe(x);

    // A base ref git has but jj never imported: forgotten all the same.
    await git(["update-ref", "refs/remotes/meddle/base/t/p/5", m], repo2, n2.cfg);
    writeLineRow(n1.db, { project: P, task: "t", name: "p", holder: n1.id, epoch: 0, commit: null, base: [], archived: false });
    await lineRowOn(n2, P, "t", (r) => r.commit === null);
    await applyProject(depsOf(n2), P);
    const b2 = await bookmarksOf(n2, repo2);
    expect(b2.has("task/t/p@meddle")).toBe(false);
    expect(b2.has("base/t/p/0@meddle")).toBe(false);
    expect(await refsOf(n2, repo2, "refs/remotes/meddle/")).toEqual(new Map());
    expect(b2.get("main")?.commitId).toBe(x);
    expect(await visible(n2, repo2, x)).toBe(true);
    expect(await viewOf(n2, repo2)).toEqual(new Map([["refs/heads/main", x]]));
  } finally {
    await close();
  }
}, 60_000);

test("a conflicted branch serves both siblings by id, and itself at their merge base", async () => {
  const { nodes, close } = await poolNodes(3);
  try {
    const [n1, n2, n3] = nodes as [GitPoolNode, GitPoolNode, GitPoolNode];
    await peerReady(n2, n1);
    const P = n1.project.id;
    const m = mainRow(n1);
    const x = await commitOn(n1, n1.project.replica, m, "x");
    const y = await commitOn(n1, n1.project.replica, m, "y");
    writeBranchRow(n1.db, n1.id, { project: P, branch: "main", commit: x, drops: [] });
    // n3 never had y: n2 asks n3 first, then fetches it from another member.
    writeBranchRow(n3.db, n3.id, { project: P, branch: "main", commit: y, drops: [] });
    await branchRowOn(n2, P, (r) => r.node === n1.id && r.commit === x);
    await branchRowOn(n2, P, (r) => r.node === n3.id && r.commit === y);

    expect(await applyProject(depsOf(n2), P)).toEqual({ pending: [] });
    const repo2 = getProject(n2.db, P)!.replica;
    expect(await viewOf(n2, repo2)).toEqual(new Map([
      ["refs/heads/main", m],
      [`refs/heads/meddle/conflict/main/${x.slice(0, 12)}`, x],
      [`refs/heads/meddle/conflict/main/${y.slice(0, 12)}`, y],
    ]));
    expect((await bookmarksOf(n2, repo2)).get("main")?.commitId).toBe(m);

    // Deleted, dropping both siblings' rows: gone from the service repo and the view, its commits still visible.
    await branchRowOn(n1, P, (r) => r.node === n3.id && r.commit === y);
    const live = listBranchRows(n1.db, P, "main").map((r) => ({ node: r.node, seq: r.seq }));
    const deleted = writeBranchRow(n1.db, n1.id, { project: P, branch: "main", commit: null, drops: live });
    await branchRowOn(n2, P, (r) => r.node === n1.id && r.commit === null && r.seq === deleted.seq);
    expect(await applyProject(depsOf(n2), P)).toEqual({ pending: [] });
    expect((await bookmarksOf(n2, repo2)).has("main")).toBe(false);
    expect(await viewOf(n2, repo2)).toEqual(new Map());
    expect(await visible(n2, repo2, m)).toBe(true);
  } finally {
    await close();
  }
}, 60_000);

test("Review Focus 4: with the writer gone after one peer fetched, a third node gets the commit from that peer", async () => {
  const { nodes, close } = await poolNodes(3);
  try {
    const [n1, n2, n3] = nodes as [GitPoolNode, GitPoolNode, GitPoolNode];
    await peerReady(n2, n1);
    await peerReady(n3, n1);
    const P = n1.project.id;
    // n3 keeps the project too, made while its home is still there.
    await ensureServiceRepo(depsOf(n3), P);
    const x = await commitOn(n1, n1.project.replica, mainRow(n1), "x");
    writeBranchRow(n1.db, n1.id, { project: P, branch: "main", commit: x, drops: [] });
    await branchRowOn(n2, P, (r) => r.node === n1.id && r.commit === x);
    await branchRowOn(n3, P, (r) => r.node === n1.id && r.commit === x);
    await applyProject(depsOf(n2), P);
    expect((await bookmarksOf(n2, getProject(n2.db, P)!.replica)).get("main")?.commitId).toBe(x);

    // n1 goes: closed here, and no longer one of the nodes `close()` walks.
    await n1.close();
    n1.db.close();
    await rm(n1.home, { recursive: true, force: true });
    nodes.splice(nodes.indexOf(n1), 1);
    await waitFor("n1 offline to n3", () => !n3.net.isOnline(n1.id));

    expect(await applyProject(depsOf(n3), P)).toEqual({ pending: [] });
    const repo3 = getProject(n3.db, P)!.replica;
    expect((await bookmarksOf(n3, repo3)).get("main")?.commitId).toBe(x);
    expect((await viewOf(n3, repo3)).get("refs/heads/main")).toBe(x);
  } finally {
    await close();
  }
}, 60_000);

test("with the home stopped, a node that never had the project gets its service repo and the branch from another peer's rows", async () => {
  const { nodes, close } = await poolNodes(3);
  const stops: Array<() => void> = [];
  try {
    const [n1, n2, n3] = nodes as [GitPoolNode, GitPoolNode, GitPoolNode];
    await peerReady(n2, n1);
    const P = n1.project.id;
    const x = await commitOn(n1, n1.project.replica, mainRow(n1), "x");
    writeBranchRow(n1.db, n1.id, { project: P, branch: "main", commit: x, drops: [] });
    await branchRowOn(n2, P, (r) => r.node === n1.id && r.commit === x);
    await applyProject(depsOf(n2), P);
    const repo2 = getProject(n2.db, P)!.replica;
    // n2's summary lists the project from now on: the roster tells n3 of it.
    await n2.pool.refresh();
    await waitFor("n2's summary listing the project on n3", () => n3.store.row(n2.id)?.summary?.projects.some((p) => p.id === P) === true);

    // The home goes: closed here, and no longer one of the nodes `close()` walks.
    await n1.close();
    n1.db.close();
    await rm(n1.home, { recursive: true, force: true });
    nodes.splice(nodes.indexOf(n1), 1);
    await waitFor("n1 offline", () => !n2.net.isOnline(n1.id) && !n3.net.isOnline(n1.id));
    expect(getProject(n3.db, P)).toBeNull();

    // A row only n2 writes, after the home is gone: it reaches n3 from n2.
    const y = await commitOn(n2, repo2, x, "y");
    writeBranchRow(n2.db, n2.id, { project: P, branch: "main", commit: y, drops: [] });
    await branchRowOn(n3, P, (r) => r.node === n2.id && r.commit === y);

    stops.push(startApplier(depsOf(n3)));
    await waitFor("main on n3", async () => {
      const replica = getProject(n3.db, P)?.replica;
      return replica !== undefined && (await bookmarksOf(n3, replica).catch(() => new Map())).get("main")?.commitId === y;
    }, 30_000);
    const project = getProject(n3.db, P)!;
    expect(project.home).toBe(n1.id);
    expect(project.defaultBranch).toBe("main");
    expect(await visible(n3, project.replica, y)).toBe(true);
    expect((await viewOf(n3, project.replica)).get("refs/heads/main")).toBe(y);
    // The memory stays home-based: not cloned while the home is away.
    expect(await isJjRepo(paths(n3.cfg).memory(P))).toBe(false);
  } finally {
    for (const stop of stops) stop();
    await close();
  }
}, 60_000);

test("catchUp asks every reachable peer for a project's rows, and returns within its budget with one peer unreachable", async () => {
  const { nodes, close } = await poolNodes(3);
  try {
    const [n1, n2, n3] = nodes as [GitPoolNode, GitPoolNode, GitPoolNode];
    await peerReady(n2, n1);
    const P = n1.project.id;
    const x = await commitOn(n1, n1.project.replica, mainRow(n1), "x");
    writeBranchRow(n1.db, n1.id, { project: P, branch: "main", commit: x, drops: [] });
    await branchRowOn(n2, P, (r) => r.node === n1.id && r.commit === x);
    await applyProject(depsOf(n2), P);
    const repo2 = getProject(n2.db, P)!.replica;
    expect((await bookmarksOf(n2, repo2)).get("main")?.commitId).toBe(x);
    // Made by the applier, the service repo comes without the memory: no home is waited on to apply rows.
    expect(await isJjRepo(paths(n2.cfg).memory(P))).toBe(false);

    // A line at a commit n2 has: catchUp has it applied when it returns, whether sync or rowsOf brought its row.
    writeLineRow(n1.db, { project: P, task: "t", name: "p", holder: n1.id, epoch: 0, commit: x, base: [], archived: false });

    // rowsOf: a peer's rows of one project.
    const ref = await n2.pool.peerRef(n1.id, PeerObject);
    try {
      if (ref.variant !== "peer") throw new Error("not a peer");
      const rows = await ref.rowsOf({ projectId: P });
      expect(rows.branchRows).toContainEqual(expect.objectContaining({ node: n1.id, branch: "main", commit: x }));
      expect(rows.lineRows).toEqual([expect.objectContaining({ task: "t", name: "p", commit: x })]);
      expect(rows.branchRows.every((r) => r.project === P)).toBe(true);
    } finally {
      ref.release();
    }

    // n3 is online, but never answers.
    const pool: PoolRuntime = new Proxy(n2.pool, {
      get(target, key, receiver) {
        if (key === "peerRef") {
          return (nodeId: string, contract: typeof PeerObject) => (nodeId === n3.id ? new Promise(() => {}) : target.peerRef(nodeId, contract));
        }
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const started = Date.now();
    await catchUp({ ...depsOf(n2), pool }, P);
    expect(Date.now() - started).toBeLessThan(6000);
    expect((await bookmarksOf(n2, repo2)).get("task/t/p@meddle")?.commitId).toBe(x);
  } finally {
    await close();
  }
}, 60_000);

/**
 * Makes `n`'s git streams for the repos `stalls` picks hang: taken, and never answered until `release` resets them.
 * Register it before any other git acceptor of `n` (`serveGit: false` in `poolNodes`).
 */
function stallGit(n: GitPoolNode, stalls: (repo: Repo) => boolean): { held: PeerStream[]; release(): Promise<void> } {
  const held: PeerStream[] = [];
  const stop = n.net.onStream((s) => {
    if (s.header.stream !== "git") return false;
    let repo: Repo;
    try {
      repo = parseGitHeader(s.header).repo;
    } catch {
      return false;
    }
    if (!stalls(repo)) return false;
    held.push(s);
    return true;
  });
  return {
    held,
    async release() {
      stop();
      for (const s of held) {
        await s.stream.send.reset(0n).catch(() => {});
        await s.stream.recv.stop(0n).catch(() => {});
      }
    },
  };
}

test("catchUp keeps its budget when it joins a background fetch from a member that stalls", async () => {
  const { nodes, close } = await poolNodes(3, { nodes: [{}, {}, { serveGit: false }] });
  const n3Stall = stallGit(nodes[2]!, () => true);
  try {
    const [n1, n2, n3] = nodes as [GitPoolNode, GitPoolNode, GitPoolNode];
    await peerReady(n2, n1);
    const P = n1.project.id;
    await ensureServiceRepo(depsOf(n2), P);
    // n3 writes the row, so it is asked first; its git never answers.
    const x = await commitOn(n1, n1.project.replica, mainRow(n1), "x");
    writeBranchRow(n3.db, n3.id, { project: P, branch: "main", commit: x, drops: [] });
    await branchRowOn(n2, P, (r) => r.node === n3.id && r.commit === x);

    const background = applyProject(depsOf(n2), P);
    await waitFor("the background fetch to stall on n3", () => n3Stall.held.length > 0);
    const started = Date.now();
    await catchUp(depsOf(n2), P);
    expect(Date.now() - started).toBeLessThan(6000);

    // Once n3 lets go, the background pass gets x from n1.
    await n3Stall.release();
    expect(await background).toEqual({ pending: [] });
    expect((await bookmarksOf(n2, getProject(n2.db, P)!.replica)).get("main")?.commitId).toBe(x);
  } finally {
    await n3Stall.release();
    await close();
  }
}, 60_000);

test("the applier applies a new project's rows without waiting for its home's memory", async () => {
  const { nodes, close } = await poolNodes(3, { nodes: [{}, {}, { serveGit: false }] });
  const [n1, , n3] = nodes as [GitPoolNode, GitPoolNode, GitPoolNode];
  // n3, the home of Q, serves Q but never answers for its memory.
  const memoryStall = stallGit(n3, (repo) => repo.kind === "memory");
  const stopServing = acceptGitStreams(n3.net, {
    db: n3.db, cfg: n3.cfg, pool: n3.pool, selfId: n3.id, isMember: (id) => n3.store.isMember(id), log: (line) => n3.logs.push(line),
  });
  const stops: Array<() => void> = [];
  try {
    await peerReady(n1, n3);
    const Q = n3.project.id;
    const m = mainRow(n3);
    await waitFor("n3's summary listing Q on n1", () => n1.store.row(n3.id)?.summary?.projects.some((p) => p.id === Q) === true);
    stops.push(startApplier(depsOf(n1)));
    await waitFor("Q's main on n1", async () => {
      const replica = getProject(n1.db, Q)?.replica;
      return replica !== undefined && (await bookmarksOf(n1, replica).catch(() => new Map())).get("main")?.commitId === m;
    }, 15_000);
    // The memory clone is still waiting on n3.
    expect(memoryStall.held.length).toBeGreaterThan(0);
    expect((await viewOf(n1, getProject(n1.db, Q)!.replica)).get("refs/heads/main")).toBe(m);
  } finally {
    for (const stop of stops) stop();
    await memoryStall.release();
    stopServing();
    await close();
  }
}, 60_000);

test("a branch bookmark jj holds conflicted is put back at its position", async () => {
  const { nodes, close } = await poolNodes(2);
  try {
    const [n1, n2] = nodes as [GitPoolNode, GitPoolNode];
    await peerReady(n2, n1);
    const P = n1.project.id;
    const m = mainRow(n1);
    await applyProject(depsOf(n2), P);
    const repo2 = getProject(n2.db, P)!.replica;
    // An agent's `bookmark set main` races the applier's write: git's main is at m again, jj's main is conflicted.
    const c0 = await commitOn(n2, repo2, m, "c0");
    const c2 = await commitOn(n2, repo2, m, "c2");
    await git(["update-ref", "refs/heads/other", c2], repo2, n2.cfg);
    await git(["update-ref", "refs/heads/main", c0], repo2, n2.cfg);
    await jj(["--ignore-working-copy", "git", "import"], repo2, n2.cfg);
    await git(["update-ref", "refs/heads/main", m], repo2, n2.cfg);
    await jj(["--ignore-working-copy", "bookmark", "set", "main", "-r", c2, "--allow-backwards"], repo2, n2.cfg);
    await jj(["--ignore-working-copy", "git", "import"], repo2, n2.cfg);
    expect((await bookmarksOf(n2, repo2)).get("main")?.conflicted).toBe(true);
    expect((await git(["rev-parse", "refs/heads/main"], repo2, n2.cfg)).trim()).toBe(m);

    await applyProject(depsOf(n2), P);
    expect((await bookmarksOf(n2, repo2)).get("main")).toMatchObject({ commitId: m, conflicted: false });
  } finally {
    await close();
  }
}, 60_000);

test("a branch bookmark a task's agent moves is back at its row after the turn end, and the view's never moved (Review Focus 2)", async () => {
  const { nodes, close } = await poolNodes(1);
  try {
    const [n1] = nodes as [GitPoolNode];
    const P = n1.project.id;
    const repo = n1.project.replica;
    const row = mainRow(n1);
    await applyProject(depsOf(n1), P);
    expect((await viewOf(n1, repo)).get("refs/heads/main")).toBe(row);
    const m = await createTask(n1, { title: "t", projectIds: [P] });
    const workspace = join(paths(n1.cfg).task(m.id), "a");

    // The agent moves `main` onto its own work: jj lets it, immutable or not.
    await writeFile(join(workspace, "work"), "work\n");
    await jj(["bookmark", "set", "main", "-r", "@", "--allow-backwards"], workspace, n1.cfg);
    expect((await bookmarksOf(n1, repo)).get("main")?.commitId).not.toBe(row);
    expect((await viewOf(n1, repo)).get("refs/heads/main")).toBe(row);

    const idle = new Promise<void>((res) => n1.runner.onState((tid, s) => { if (tid === m.id && s === "idle") res(); }));
    await n1.runner.prompt(m.id, "Reply with the single word ok.");
    await idle;
    expect((await bookmarksOf(n1, repo)).get("main")).toMatchObject({ commitId: row, conflicted: false });
    expect((await viewOf(n1, repo)).get("refs/heads/main")).toBe(row);
    expect(mainRow(n1)).toBe(row);
  } finally {
    await close();
  }
}, 60_000);
