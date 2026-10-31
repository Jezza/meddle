// Replicas of projects homed on other nodes: cloned from the home over the pool's git transport, with the home's
// remote named after its shortId; task bookmarks pushed to the home; the parent of a new task (the home's `trunk`).
import { rm } from "node:fs/promises";
import type { Database } from "bun:sqlite";
import { paths, type NodeConfig } from "../config";
import { repoName, type Repo } from "../git/wire";
import { bookmarkList, bookmarkSet, cloneColocated, fetch, isJjRepo, jj, push, remoteAdd, remoteList, track } from "../jj";
import { cloneMemoryReplica } from "../memory";
import { shortId } from "../pool/ids";
import { repoKey, serialised } from "../serial";
import type { PoolRuntime } from "../pool/runtime";
import { PeerObject } from "../state/contracts";
import { getProject, registerReplica, type Project } from "./project";

export type ReplicaDeps = { cfg: NodeConfig; db: Database; pool: PoolRuntime };

/** The project a peer reports holding: its id, name and home. */
type ProjectInfo = { id: string; name: string; home: string };

/** The URL of `repo` on node `nodeId`. */
export function meddleUrl(nodeId: string, repo: Repo): string {
  return `meddle://${nodeId}/${repoName(repo)}`;
}

/** Asks each online member's PeerObject about `projectId` until one knows it; null when none does. */
async function findProject(pool: PoolRuntime, projectId: string): Promise<ProjectInfo | null> {
  for (const member of pool.store.members()) {
    if (member.nodeId === pool.identity.id || !pool.net.isOnline(member.nodeId)) continue;
    let ref: Awaited<ReturnType<typeof pool.peerRef<typeof PeerObject>>>;
    try {
      ref = await pool.peerRef(member.nodeId, PeerObject);
    } catch {
      continue;
    }
    try {
      if (ref.variant !== "peer") continue;
      const info = await ref.projectInfo({ id: projectId }).catch(() => null);
      if (info !== null && info.home !== "") return info;
    } finally {
      ref.release();
    }
  }
  return null;
}

/** One `ensureReplica` at a time per project and data dir: a second caller waits for the first. */
const cloning = new Map<string, Promise<Project>>();

/**
 * The project `projectId` on this node. When this node has no working replica of it, clones it and its memory from
 * the home (named by the project row, or else by any online member that holds the project), naming the home's
 * remote `shortId(home)`, and registers the replica. Rejects `home <shortId> is offline` when the home cannot be
 * reached, and `no online node holds project <shortId>` when nobody knows the project.
 */
export async function ensureReplica(deps: ReplicaDeps, projectId: string): Promise<Project> {
  const key = `${deps.cfg.dataDir}\0${projectId}`;
  const running = cloning.get(key);
  if (running !== undefined) return running;
  const work = replicate(deps, projectId).finally(() => cloning.delete(key));
  cloning.set(key, work);
  return work;
}

async function replicate(deps: ReplicaDeps, projectId: string): Promise<Project> {
  const { cfg, db, pool } = deps;
  const row = getProject(db, projectId);
  if (row !== null && (await isJjRepo(row.replica))) return row;
  if (row !== null && row.home === pool.identity.id) throw new Error(`the replica of project ${shortId(projectId)} is missing`);
  const info = row ?? (await findProject(pool, projectId));
  if (info === null) throw new Error(`no online node holds project ${shortId(projectId)}`);
  const home = info.home;
  if (!pool.net.isOnline(home)) throw new Error(`home ${shortId(home)} is offline`);

  const replica = row?.replica ?? paths(cfg).replica(projectId);
  // What a failed clone left behind: this node has no row (or no repo) for it.
  await rm(replica, { recursive: true, force: true });
  await cloneColocated(meddleUrl(home, { kind: "project", id: projectId }), replica, cfg, shortId(home));
  await cloneMemoryReplica(cfg, projectId, home);
  return row ?? registerReplica(db, { id: projectId, name: info.name, home, replica });
}

/**
 * Makes sure `replica` has a remote named `shortId(nodeId)` for `repo` on that node (correcting its url when it
 * names something else); returns the remote's name.
 */
export async function ensureRemote(cfg: NodeConfig, replica: string, nodeId: string, repo: Repo): Promise<string> {
  const name = shortId(nodeId);
  const url = meddleUrl(nodeId, repo);
  const existing = (await remoteList(replica, cfg)).find((r) => r.name === name);
  if (existing === undefined) await remoteAdd(replica, name, url, cfg);
  else if (existing.url !== url) await jj(["git", "remote", "set-url", name, url], replica, cfg);
  return name;
}

/**
 * Fetches `bookmarks` (exact names) from node `nodeId`'s remote (`shortId(nodeId)`, which must exist), then checks
 * each arrived: rejects `bookmark <b> not found on <shortId>` for one the node does not have.
 */
export async function fetchBookmarks(cfg: NodeConfig, replica: string, nodeId: string, bookmarks: string[]): Promise<void> {
  const remote = shortId(nodeId);
  await fetch(replica, remote, bookmarks.map((b) => `exact:${b}`), cfg);
  const present = new Set((await bookmarkList(replica, cfg)).filter((b) => b.remote === remote).map((b) => b.name));
  for (const b of bookmarks) if (!present.has(b)) throw new Error(`bookmark ${b} not found on ${remote}`);
}

/**
 * Points `bookmark` at `changeId` and pushes it to the home: fetch it from the home (nothing when the home has none),
 * track `<bookmark>@<shortId(home)>`, set the bookmark (backwards or sideways too), push. jj refuses a push over an
 * untracked or stale remote bookmark, or a new one while the bookmark tracks another remote; this order survives all
 * three. One push at a time per repo (`repoKey`): overlapping ones would clash on git's ref locks.
 */
export async function pushBookmark(cfg: NodeConfig, replica: string, home: string, bookmark: string, changeId: string): Promise<void> {
  const remote = shortId(home);
  await serialised(repoKey(replica), async () => {
    await fetch(replica, remote, [`exact:${bookmark}`], cfg);
    await track(replica, bookmark, remote, cfg);
    await bookmarkSet(replica, bookmark, changeId, cfg);
    await push(replica, remote, bookmark, cfg);
  });
}

/** The remote bookmarks `replica` knows, with the change each points at ("" and `conflicted` when conflicted). */
export async function remoteHeads(cfg: NodeConfig, replica: string): Promise<Array<{ name: string; remote: string; changeId: string; conflicted: boolean }>> {
  const heads: Array<{ name: string; remote: string; changeId: string; conflicted: boolean }> = [];
  for (const b of await bookmarkList(replica, cfg)) {
    if (b.remote !== null) heads.push({ name: b.name, remote: b.remote, changeId: b.changeId, conflicted: b.conflicted });
  }
  return heads;
}

/**
 * The home's latest trunk-like revision: jj's `trunk()` (a remote's main/master/trunk) or a local `trunk`, `main` or
 * `master` bookmark.
 */
const HOME_TRUNK = 'latest(trunk() ~ root() | bookmarks(exact:"trunk") | bookmarks(exact:"main") | bookmarks(exact:"master"))';

/**
 * On a project's home: points the local `trunk` bookmark at the latest trunk-like revision (`HOME_TRUNK`), so that
 * other nodes, which fetch only `trunk`, start tasks where the home would. Returns that change id, or null (and
 * leaves the bookmarks alone) when nothing resolves.
 */
export async function refreshTrunk(cfg: NodeConfig, replica: string): Promise<string | null> {
  const [change] = (await jj(["log", "-r", HOME_TRUNK, "--no-graph", "-T", 'change_id ++ "\\n"'], replica, cfg)).split("\n");
  if (change === undefined || change === "") return null;
  await bookmarkSet(replica, "trunk", change, cfg);
  return change;
}

/**
 * The revision a new task of `project` starts from: on the home, the change `refreshTrunk` resolves (`root()` when
 * nothing does); elsewhere `trunk@<shortId(home)>` after fetching it (`root()` when the home has no `trunk`).
 * Rejects `home <shortId> is offline` on another node while the home cannot be reached.
 */
export async function trunkFor(deps: ReplicaDeps, project: Project): Promise<string> {
  const { cfg, pool } = deps;
  if (project.home === pool.identity.id) return (await refreshTrunk(cfg, project.replica)) ?? "root()";
  const remote = shortId(project.home);
  if (!pool.net.isOnline(project.home)) throw new Error(`home ${remote} is offline`);
  try {
    await fetchBookmarks(cfg, project.replica, project.home, ["trunk"]);
  } catch (err) {
    if (err instanceof Error && err.message === `bookmark trunk not found on ${remote}`) return "root()";
    throw err;
  }
  return `trunk@${remote}`;
}
