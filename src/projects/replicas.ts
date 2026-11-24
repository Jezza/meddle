// Service repos of projects homed on other nodes, with the home's remote named after its shortId, and their memory
// replicas. A task's lines and a project's branches travel as rows (`lines.ts`, `applier.ts`), a memory repo's heads as
// head rows (`src/scopes/`); nothing is pushed.
import { rm } from "node:fs/promises";
import type { Database } from "bun:sqlite";
import { paths, type NodeConfig } from "../config";
import { repoName, type Repo } from "../git/wire";
import { isJjRepo, remoteEnsure } from "../jj";
import { ensureMemoryReplica } from "../memory";
import { shortId } from "../pool/ids";
import { isRemoved, removedIds } from "../pool/removed";
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

/** Asks each online member's PeerObject about `projectId` until one knows it; null when none does, and for a removed project. */
export async function findProject(pool: PoolRuntime, db: Database, projectId: string): Promise<ProjectInfo | null> {
  if (isRemoved(db, projectId)) return null;
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
 * its home (when online) gives now. Then, unless `memory` is false, the project's memory repo is made here when there
 * is none (`ensureMemory`); the scope sync fills it. Rejects `no online node holds project <shortId>` when nobody knows the
 * project, and `project <shortId> was removed` for one on the removed list, whatever this node holds of it.
 */
export async function ensureServiceRepo(deps: ReplicaDeps, projectId: string, opts: { memory?: boolean } = {}): Promise<Project> {
  if (isRemoved(deps.db, projectId)) throw new Error(`project ${shortId(projectId)} was removed`);
  const key = `${deps.cfg.dataDir}\0${projectId}`;
  let work = making.get(key);
  if (work === undefined) {
    const made = makeServiceRepo(deps, projectId).finally(() => making.delete(key));
    making.set(key, made);
    work = made;
  }
  const project = await work;
  if (opts.memory !== false) await ensureMemory(deps, project);
  return project;
}

/** What the roster's summaries say of project `projectId`, or null when none lists it (and for a removed project). */
export function rosterProject(pool: PoolRuntime, db: Database, projectId: string): ProjectInfo | null {
  if (isRemoved(db, projectId)) return null;
  for (const m of pool.store.members()) {
    const found = m.summary?.projects.find((p) => p.id === projectId && p.home !== "");
    if (found !== undefined) return found;
  }
  return null;
}

/**
 * Resolves once the `ensureServiceRepo` making project `projectId`'s service repo, if any is in flight on this data dir,
 * has settled, fulfilled or not: what a removal waits for before it deletes the project's repos.
 */
export async function settled(cfg: NodeConfig, projectId: string): Promise<void> {
  await Promise.allSettled([making.get(`${cfg.dataDir}\0${projectId}`)]);
}

/**
 * Makes the memory repo of `project` here when there is none (an empty one: the scope sync fills it from the pool's
 * heads), unless the project is removed.
 */
async function ensureMemory(deps: ReplicaDeps, project: Project): Promise<void> {
  if (isRemoved(deps.db, project.id)) return;
  await serialised(repoKey(paths(deps.cfg).memory(project.id)), () => ensureMemoryReplica(deps.cfg, project.id));
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
  const info = row ?? rosterProject(pool, db, projectId) ?? (await findProject(pool, db, projectId));
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
  // A removal that came in while the repo was made: what was built goes, and nothing is registered.
  if (isRemoved(db, projectId)) {
    await rm(replica, { recursive: true, force: true });
    throw new Error(`project ${shortId(projectId)} was removed`);
  }
  return row ?? registerReplica(db, {
    id: projectId, name: info.name, home, replica, defaultBranch: info.defaultBranch ?? null,
  });
}

/**
 * Every member keeps every project: `ensureServiceRepo` for each project a member of the pool reports holding, all
 * at once (this node's own included, which also takes what their homes say of them now, and their memory once their
 * homes are online), but never a removed one. One that cannot be made now is logged and left for the next call.
 * Returns the ids of the projects held.
 */
export async function ensureServiceRepos(deps: ReplicaDeps): Promise<string[]> {
  const held = await Promise.all([...rosterProjectIds(deps.pool, deps.db)].map(async (id) => {
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

/** The ids of every project a member of the pool reports holding, but those on this node's removed list. */
export function rosterProjectIds(pool: PoolRuntime, db: Database): Set<string> {
  const removed = removedIds(db);
  const ids = new Set<string>();
  for (const member of pool.store.members()) for (const p of member.summary?.projects ?? []) if (!removed.has(p.id)) ids.add(p.id);
  return ids;
}

/**
 * Makes sure `replica` has a remote named `shortId(nodeId)` for `repo` on that node (correcting its url when it
 * names something else); returns the remote's name.
 */
export async function ensureRemote(cfg: NodeConfig, replica: string, nodeId: string, repo: Repo): Promise<string> {
  const name = shortId(nodeId);
  await remoteEnsure(replica, name, meddleUrl(nodeId, repo), cfg);
  return name;
}
