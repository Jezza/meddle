// Service repos of projects homed on other nodes, with the home's remote named after its shortId, and their memory
// replicas. A task's lines and a project's branches travel as rows (`lines.ts`, `applier.ts`), never pushed; only a
// memory repo's `memory` bookmark is pushed, to the project's home (`pushBookmark`).
import { rm } from "node:fs/promises";
import type { Database } from "bun:sqlite";
import { paths, type NodeConfig } from "../config";
import { repoName, type Repo } from "../git/wire";
import { bookmarkSet, fetch, isJjRepo, jj, push, remoteAdd, remoteList, track } from "../jj";
import { cloneMemoryReplica } from "../memory";
import { shortId } from "../pool/ids";
import { repoKey, serialised } from "../serial";
import type { PoolRuntime } from "../pool/runtime";
import { PeerObject } from "../state/contracts";
import { getProject, initServiceRepo, registerReplica, setDefaultBranch, type Project } from "./project";

export type ReplicaDeps = { cfg: NodeConfig; db: Database; pool: PoolRuntime; log?: (line: string) => void };

/** The project a peer reports holding: its id, name, home, and default branch (absent from an older node, read as none). */
export type ProjectInfo = { id: string; name: string; home: string; defaultBranch?: string | null };

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

/** One `ensureServiceRepo` at a time per project and data dir: a second caller waits for the first. */
const making = new Map<string, Promise<Project>>();

/**
 * The project `projectId` on this node. When this node has no service repo of it, makes an empty one
 * (`initServiceRepo`: never a clone of a peer's) with the home's remote `shortId(home)`, and registers it, from the
 * project row, else what the roster's summaries list, else what an online member says of the project; the home need
 * not be online, since rows and their commits come from any member. A project already here takes the default branch
 * its home (when online) gives now. Then, unless `memory` is false, the project's
 * memory, which stays home-based, is cloned from the home best effort (`cloneMemory`), so a later call (the applier's
 * sweep, when a peer comes online) retries it. Rejects `no online node holds project <shortId>` when nobody knows the
 * project.
 */
export async function ensureServiceRepo(deps: ReplicaDeps, projectId: string, opts: { memory?: boolean } = {}): Promise<Project> {
  const key = `${deps.cfg.dataDir}\0${projectId}`;
  let work = making.get(key);
  if (work === undefined) {
    const made = makeServiceRepo(deps, projectId).finally(() => making.delete(key));
    making.set(key, made);
    work = made;
  }
  const project = await work;
  if (opts.memory !== false) await cloneMemory(deps, project);
  return project;
}

/** What the roster's summaries say of project `projectId`, or null when none lists it. */
function rosterProject(pool: PoolRuntime, projectId: string): ProjectInfo | null {
  for (const m of pool.store.members()) {
    const found = m.summary?.projects.find((p) => p.id === projectId && p.home !== "");
    if (found !== undefined) return found;
  }
  return null;
}

/** The memory clones in flight, by data dir and project. */
const cloning = new Map<string, Promise<void>>();

/**
 * Clones the memory of `project` from its home (`cloneMemoryReplica`, which keeps a replica already here and gives it
 * the home's remote) when the home is another node and online; a failure is logged, and the next call tries again.
 */
async function cloneMemory(deps: ReplicaDeps, project: Project): Promise<void> {
  const { cfg, pool } = deps;
  if (project.home === pool.identity.id || !pool.net.isOnline(project.home)) return;
  // One clone at a time per memory replica: a second caller waits for the first.
  const key = `${cfg.dataDir}\0${project.id}`;
  let work = cloning.get(key);
  if (work === undefined) {
    const made = cloneMemoryReplica(cfg, project.id, project.home).then(() => {}, (err: unknown) => {
      (deps.log ?? ((line) => console.error(line)))(
        `meddle: project ${project.name}: memory not cloned from ${shortId(project.home)}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }).finally(() => cloning.delete(key));
    cloning.set(key, made);
    work = made;
  }
  await work;
}

async function makeServiceRepo(deps: ReplicaDeps, projectId: string): Promise<Project> {
  const { cfg, db, pool } = deps;
  const row = getProject(db, projectId);
  if (row !== null && (await isJjRepo(row.replica))) {
    if (row.home === pool.identity.id || !pool.net.isOnline(row.home)) return row;
    const info = await askProject(pool, row.home, projectId);
    if (info === null) return row;
    const defaultBranch = info.defaultBranch ?? null;
    if (defaultBranch !== null && defaultBranch !== row.defaultBranch) return setDefaultBranch(db, projectId, defaultBranch) ?? row;
    return row;
  }
  if (row !== null && row.home === pool.identity.id) throw new Error(`the service repo of project ${shortId(projectId)} is missing`);
  // The roster first: it needs no peer to answer.
  const info = row ?? rosterProject(pool, projectId) ?? (await findProject(pool, projectId));
  if (info === null) throw new Error(`no online node holds project ${shortId(projectId)}`);
  const home = info.home;

  const replica = row?.replica ?? paths(cfg).replica(projectId);
  // What a failed attempt left behind: this node has no row (or no repo) for it.
  await rm(replica, { recursive: true, force: true });
  try {
    await initServiceRepo(cfg, replica);
    await ensureRemote(cfg, replica, home, { kind: "project", id: projectId });
  } catch (err) {
    await rm(replica, { recursive: true, force: true });
    throw err;
  }
  return row ?? registerReplica(db, {
    id: projectId, name: info.name, home, replica, defaultBranch: info.defaultBranch ?? null,
  });
}

/**
 * Every member keeps every project: `ensureServiceRepo` for each project a member of the pool reports holding, all
 * at once (this node's own included, which also takes what their homes say of them now, and their memory once their
 * homes are online). One that cannot be made now is logged and left for the next call. Returns the ids of the projects
 * held.
 */
export async function ensureServiceRepos(deps: ReplicaDeps): Promise<string[]> {
  const held = await Promise.all([...rosterProjectIds(deps.pool)].map(async (id) => {
    try {
      await ensureServiceRepo(deps, id);
      return id;
    } catch (err) {
      (deps.log ?? ((line) => console.error(line)))(`meddle: project ${shortId(id)}: no service repo yet: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }));
  return held.filter((id) => id !== null);
}

/** The ids of every project a member of the pool reports holding. */
export function rosterProjectIds(pool: PoolRuntime): Set<string> {
  const ids = new Set<string>();
  for (const member of pool.store.members()) for (const p of member.summary?.projects ?? []) ids.add(p.id);
  return ids;
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
 * Points `bookmark` of `replica` at `changeId` and pushes it to node `home` (what a memory replica does with `memory`:
 * the project's home holds the memory repo): fetch it from there (nothing when it has none), track
 * `<bookmark>@<shortId(home)>`, set the bookmark (backwards or sideways too), push. jj refuses a push over an untracked
 * or stale remote bookmark, or a new one while the bookmark tracks another remote; this order survives all three. One push at a time per repo (`repoKey`): overlapping ones would clash on git's ref locks.
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
