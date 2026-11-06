// Replicas of projects homed on other nodes: cloned from the home over the pool's git transport, with the home's
// remote named after its shortId; a project's sync branches, fetched as a task starts from one. A task's bookmarks
// reach the home as its line (`lines.ts`).
import { rm } from "node:fs/promises";
import type { Database } from "bun:sqlite";
import { paths, type NodeConfig } from "../config";
import { repoName, type Repo } from "../git/wire";
import { bookmarkList, bookmarkSet, cloneColocated, commitOf, fetch, gitImport, isJjRepo, jj, push, remoteAdd, remoteList, track } from "../jj";
import { cloneMemoryReplica } from "../memory";
import { shortId } from "../pool/ids";
import { repoKey, serialised } from "../serial";
import type { PoolRuntime } from "../pool/runtime";
import { PeerObject } from "../state/contracts";
import { checkSyncNames, getProject, registerReplica, setProjectSync, setProjectUpstream, type Project } from "./project";

export type ReplicaDeps = { cfg: NodeConfig; db: Database; pool: PoolRuntime; log?: (line: string) => void };

/**
 * The project a peer reports holding: its id, name, home, sync branches, and whether its default start is its first
 * sync branch (`upstream`; absent from an older node, read as false).
 */
export type ProjectInfo = { id: string; name: string; home: string; sync?: string[]; upstream?: boolean };

/** The URL of `repo` on node `nodeId`. */
export function meddleUrl(nodeId: string, repo: Repo): string {
  return `meddle://${nodeId}/${repoName(repo)}`;
}

/** Asks each online member's PeerObject about `projectId` until one knows it; null when none does. */
export async function findProject(pool: PoolRuntime, projectId: string): Promise<ProjectInfo | null> {
  for (const member of pool.store.members()) {
    if (member.nodeId === pool.identity.id || !pool.net.isOnline(member.nodeId)) continue;
    const info = await askProject(pool, member.nodeId, projectId);
    if (info !== null && info.home !== "") return info;
  }
  return null;
}

/** What node `nodeId` says of project `projectId`; null when it holds none or cannot be asked. */
async function askProject(pool: PoolRuntime, nodeId: string, projectId: string): Promise<ProjectInfo | null> {
  let ref: Awaited<ReturnType<typeof pool.peerRef<typeof PeerObject>>>;
  try {
    ref = await pool.peerRef(nodeId, PeerObject);
  } catch {
    return null;
  }
  try {
    if (ref.variant !== "peer") return null;
    return await ref.projectInfo({ id: projectId }).catch(() => null);
  } finally {
    ref.release();
  }
}

/** One `ensureReplica` at a time per project and data dir: a second caller waits for the first. */
const cloning = new Map<string, Promise<Project>>();

/**
 * The project `projectId` on this node. When this node has no working replica of it, clones it and its memory from
 * the home (named by the project row, or else by any online member that holds the project), naming the home's
 * remote `shortId(home)`, and registers the replica. A replica already here takes the sync branches and `upstream` its
 * home (when online) gives now. Rejects `home <shortId> is offline` when the home cannot be
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
  if (row !== null && (await isJjRepo(row.replica))) {
    if (row.home === pool.identity.id || !pool.net.isOnline(row.home)) return row;
    const info = await askProject(pool, row.home, projectId);
    if (info === null) return row;
    let now = row;
    const upstream = info.upstream ?? false;
    if (upstream !== now.upstream) now = setProjectUpstream(db, projectId, upstream) ?? now;
    const sync = info.sync ?? [];
    if (sync.join("\0") !== now.sync.join("\0")) now = setProjectSync(db, projectId, sync) ?? now;
    return now;
  }
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
  return row ?? registerReplica(db, { id: projectId, name: info.name, home, replica, sync: info.sync ?? [], upstream: info.upstream ?? false });
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
 * Whether `name` matches jj glob `glob`, as far as meddle uses globs: `*` is any run of characters (`/` too), `?` one
 * character, anything else itself.
 */
function globMatches(glob: string, name: string): boolean {
  const re = glob.split("").map((c) => (c === "*" ? ".*" : c === "?" ? "." : c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("");
  return new RegExp(`^${re}$`).test(name);
}

/**
 * Fetches the bookmarks `patterns` select (jj string patterns, passed as they are: `exact:<b>` or `glob:<g>`) from
 * node `nodeId`'s remote (`shortId(nodeId)`, which must exist), then checks they arrived: rejects
 * `bookmark <b> not found on <shortId>` for an `exact:` one the node does not have, and, with `requireMatch` (the
 * default), `no bookmark matching <g> on <shortId>` for a `glob:` one that selects nothing there.
 */
export async function fetchBookmarks(
  cfg: NodeConfig, replica: string, nodeId: string, patterns: string[], opts: { requireMatch?: boolean } = {},
): Promise<void> {
  const remote = shortId(nodeId);
  const requireMatch = opts.requireMatch ?? true;
  for (const p of patterns) if (!p.startsWith("exact:") && !p.startsWith("glob:")) throw new Error(`bookmark pattern ${p} is neither exact: nor glob:`);
  await fetch(replica, remote, patterns, cfg);
  const checked = patterns.filter((p) => p.startsWith("exact:") || requireMatch);
  if (checked.length === 0) return;
  const present = (await bookmarkList(replica, cfg)).filter((b) => b.remote === remote).map((b) => b.name);
  for (const p of checked) {
    if (p.startsWith("exact:")) {
      const b = p.slice("exact:".length);
      if (!present.includes(b)) throw new Error(`bookmark ${b} not found on ${remote}`);
    } else {
      const g = p.slice("glob:".length);
      if (!present.some((name) => globMatches(g, name))) throw new Error(`no bookmark matching ${g} on ${remote}`);
    }
  }
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
    await track(replica, `exact:${bookmark}`, remote, cfg);
    await bookmarkSet(replica, bookmark, changeId, cfg);
    await push(replica, remote, `exact:${bookmark}`, cfg);
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

/** `name` as a jj string literal. */
function quoted(name: string): string {
  return `"${name.replace(/[\\"]/g, "\\$&")}"`;
}

/**
 * The commit of bookmark `branch` on `remote` (the local bookmark when `remote` is null) in `replica`, read without
 * snapshotting the working copy; null when there is none.
 */
async function bookmarkCommit(cfg: NodeConfig, replica: string, branch: string, remote: string | null): Promise<string | null> {
  await gitImport(replica, cfg);
  const revset = remote === null
    ? `bookmarks(exact:${quoted(branch)})`
    : `remote_bookmarks(exact:${quoted(branch)}, exact:${quoted(remote)})`;
  try {
    return await commitOf(replica, revset, cfg);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("no revision ")) return null;
    throw err;
  }
}

/**
 * Fetches `branches` from the `origin` of a url project's replica and makes each a local bookmark at the upstream's
 * commit (tracking `<b>@origin`, so that a node cloning from this replica sees it as a branch). Rejects
 * `bookmark <b> not found on origin` for one the upstream lacks. Only for a replica meddle cloned itself.
 */
export async function fetchFromUpstream(cfg: NodeConfig, replica: string, branches: string[]): Promise<void> {
  if (branches.length === 0) return;
  const patterns = branches.map((b) => `exact:${b}`);
  await serialised(repoKey(replica), async () => {
    await fetch(replica, "origin", patterns, cfg);
    const present = (await bookmarkList(replica, cfg)).filter((b) => b.remote === "origin").map((b) => b.name);
    const missing = branches.find((b) => !present.includes(b));
    for (const b of branches.filter((x) => present.includes(x))) await track(replica, `exact:${b}`, "origin", cfg);
    if (missing !== undefined) throw new Error(`bookmark ${missing} not found on origin`);
  });
}

/**
 * The commit sync branch `branch` of `project` (one of its `sync`; rejects `<branch> is not a sync branch of <project>`,
 * and `invalid sync branch name "<branch>"` for one `checkSyncNames` refuses) points at for a task created now. On the
 * home: for a url project, after fetching it from `origin`; for a folder project, the local bookmark. Elsewhere `<branch>@<shortId(home)>` after fetching it from the home, or, with the home
 * offline, the copy fetched last (logged `meddle: project <name>: home offline; starting from <branch> as fetched
 * last`); rejects `home <shortId> is offline` when there is none.
 */
export async function fetchSync(deps: ReplicaDeps, project: Project, branch: string): Promise<string> {
  const { cfg, pool } = deps;
  const sync = getProject(deps.db, project.id)?.sync ?? project.sync;
  if (!sync.includes(branch)) throw new Error(`${branch} is not a sync branch of ${project.name}`);
  // A replica stores the names its home lists as they came: none reaches git or jj unless it is a legal branch name.
  await checkSyncNames(cfg, [branch]);
  if (project.home === pool.identity.id) {
    if (project.source.kind === "upstream") await fetchFromUpstream(cfg, project.replica, [branch]);
    const commit = await bookmarkCommit(cfg, project.replica, branch, null);
    if (commit === null) throw new Error(`no bookmark ${branch} in ${project.name}`);
    return commit;
  }
  const remote = shortId(project.home);
  if (!pool.net.isOnline(project.home)) {
    const last = await bookmarkCommit(cfg, project.replica, branch, remote);
    if (last === null) throw new Error(`home ${remote} is offline`);
    (deps.log ?? ((line) => console.error(line)))(`meddle: project ${project.name}: home offline; starting from ${branch} as fetched last`);
    return last;
  }
  await fetchBookmarks(cfg, project.replica, project.home, [`exact:${branch}`]);
  const commit = await bookmarkCommit(cfg, project.replica, branch, remote);
  if (commit === null) throw new Error(`bookmark ${branch} not found on ${remote}`);
  return commit;
}
