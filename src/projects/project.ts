import { rm, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { Database } from "bun:sqlite";
import type { Subscribable } from "@earendil-works/chord";
import { paths, type NodeConfig } from "../config";
import { git, gitImport, initColocated, isJjRepo, jj, networkMs } from "../jj";
import { ensureMemoryReplica, importMemory } from "../memory";
import { writeBranchRow } from "../pool/rows";
import {
  getProjectRow, insertProject, listProjectRows, newId, setProjectDefaultBranchRow, type ProjectRow,
} from "../store/records";

export type Project = {
  id: string;
  name: string;
  source: { kind: "folder"; path: string } | { kind: "upstream"; url: string };
  /** This node's service repo of the project, where its tasks are workspaces; never the user's folder (a checkout). */
  replica: string;
  /** The node id of the project's home: the node whose repo is the project's, and that minted its id. */
  home: string;
  /**
   * The branch a task starts from when it names no revision: the folder's `main`, else `master`, or the upstream's
   * `HEAD` branch, when the project was added (`project set-default` changes it); null for none.
   */
  defaultBranch: string | null;
};

const listeners = new Set<(value: null) => void>();

/** Fires after any project is added or registered on this node. */
export const projectChanges: Subscribable<null> = {
  subscribe(cb) {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
  },
};

function changed(): void {
  for (const cb of [...listeners]) {
    try {
      cb(null);
    } catch {
      // A listener's failure is its own; the others still hear of the change.
    }
  }
}

function toProject(row: ProjectRow): Project {
  const source: Project["source"] = row.source_kind === "folder"
    ? { kind: "folder", path: row.source }
    : { kind: "upstream", url: row.source };
  return { id: row.id, name: row.name, source, replica: row.replica, home: row.home, defaultBranch: row.default_branch };
}

function save(db: Database, project: Project): Project {
  insertProject(db, {
    id: project.id,
    name: project.name,
    source_kind: project.source.kind,
    source: project.source.kind === "folder" ? project.source.path : project.source.url,
    replica: project.replica,
    created_at: new Date().toISOString(),
    home: project.home,
    default_branch: project.defaultBranch,
  });
  changed();
  return project;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Makes `dir` an empty service repo: a colocated jj repo whose git `HEAD` names no branch (`refs/jj/root`, which never
 * exists), so that git fetches and pushes into any branch, and jj leaves the default workspace's `@` on the root commit.
 */
export async function initServiceRepo(cfg: NodeConfig, dir: string): Promise<void> {
  await initColocated(dir, cfg);
  // `jj git init --colocate` leaves `HEAD` on an unborn `refs/heads/main`, and git refuses to fetch into it.
  await git(["symbolic-ref", "HEAD", "refs/jj/root"], dir, cfg);
}

/** Whether `path` exists. */
async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

/** The first of `branches` that the git repo at `url` has (`git ls-remote`, which only reads it); null for none. */
export async function firstBranch(cfg: NodeConfig, url: string, branches: string[]): Promise<string | null> {
  const out = await git(["ls-remote", url, ...branches.map((b) => `refs/heads/${b}`)], cfg.dataDir, cfg, { timeoutMs: networkMs(cfg) });
  const listed = out.split("\n").filter(Boolean).map((line) => line.split("\t")[1]);
  return branches.find((b) => listed.includes(`refs/heads/${b}`)) ?? null;
}

/**
 * Builds project `id`'s service repo at `paths(cfg).replica(id)` (`initServiceRepo`), holding branch `branch` of the
 * git repo at `url` (none when null): fetched into `refs/heads/<branch>` and imported, so that it is a bookmark.
 * Returns the repo and the branch's commit (null without a branch). A failure removes what it built.
 */
async function buildServiceRepo(cfg: NodeConfig, id: string, url: string, branch: string | null): Promise<{ replica: string; commit: string | null }> {
  const replica = paths(cfg).replica(id);
  let commit: string | null = null;
  try {
    await initServiceRepo(cfg, replica);
    if (branch !== null) {
      await git(["fetch", url, `${branch}:refs/heads/${branch}`], replica, cfg, { timeoutMs: networkMs(cfg) });
      await gitImport(replica, cfg);
      commit = (await git(["rev-parse", `refs/heads/${branch}`], replica, cfg)).trim();
    }
  } catch (err) {
    await rm(replica, { recursive: true, force: true });
    throw err;
  }
  return { replica, commit };
}

/**
 * Saves `project` with this node's (`home`'s) row for its default branch at `commit`, in one transaction: the row is
 * written only once the project is saved, so the applier that the row wakes finds the project (and a failed save
 * leaves no row).
 */
function saveWithBranch(db: Database, project: Project, commit: string | null): Project {
  return db.transaction(() => {
    const saved = save(db, project);
    if (project.defaultBranch !== null) {
      writeBranchRow(db, project.home, { project: project.id, branch: project.defaultBranch, commit, drops: [] });
    }
    return saved;
  })();
}

/**
 * Adds the project in `folder`, a colocated jj repo (read only: the folder is the user's checkout, attached by the CLI),
 * with its home `home` (this node). Its service repo holds the folder's default branch,
 * `main`, else `master` (none when it has neither). Rejects `not a directory: <folder>`, `<folder> is not a jj repo`
 * and `<folder> is a jj repo without a colocated git repo`.
 */
export async function addProjectFromFolder(
  cfg: NodeConfig, db: Database, folder: string, home: string, name?: string,
): Promise<Project> {
  const path = resolve(folder);
  if (!(await isDirectory(path))) throw new Error(`not a directory: ${folder}`);
  await checkColocated(path);
  const id = newId();
  const defaultBranch = await firstBranch(cfg, path, ["main", "master"]);
  const { replica, commit } = await buildServiceRepo(cfg, id, path, defaultBranch);
  await ensureMemoryReplica(cfg, id);
  await importMemory(cfg, id, path);
  return saveWithBranch(db, {
    id, name: name ?? basename(path), source: { kind: "folder", path }, replica, home, defaultBranch,
  }, commit);
}

/**
 * Rejects `<path> is not a jj repo` unless `path` is a jj repo, and `<path> is a jj repo without a colocated git repo`
 * unless git's repo is in it too. Reads only.
 */
export async function checkColocated(path: string): Promise<void> {
  if (!(await isJjRepo(path))) throw new Error(`${path} is not a jj repo`);
  if (!(await exists(join(path, ".git")))) throw new Error(`${path} is a jj repo without a colocated git repo`);
}

function upstreamName(url: string): string {
  const last = url.replace(/\/+$/, "").split(/[/:]/).pop() ?? url;
  return last.replace(/\.git$/, "");
}

/** The branch the upstream's `HEAD` names, or null when it names none (an empty repo). */
export async function upstreamDefaultBranch(url: string, cfg: NodeConfig): Promise<string | null> {
  const out = await git(["ls-remote", "--symref", url, "HEAD"], cfg.dataDir, cfg, { timeoutMs: networkMs(cfg) });
  const match = /^ref: refs\/heads\/(.+)\tHEAD$/m.exec(out);
  return match === null ? null : match[1]!;
}

/**
 * Adds a project from the upstream at `url`, with its home `home` (this node). Its service repo, in the replicas
 * directory, holds the upstream's default branch (its `HEAD`'s; none when it names none), and has the upstream as its
 * remote `origin`.
 */
export async function addProjectFromUpstream(
  cfg: NodeConfig, db: Database, url: string, home: string, name?: string,
): Promise<Project> {
  const id = newId();
  const defaultBranch = await upstreamDefaultBranch(url, cfg);
  const { replica, commit } = await buildServiceRepo(cfg, id, url, defaultBranch);
  // Where the service repo came from; nothing fetches from it after the add.
  await jj(["git", "remote", "add", "origin", url], replica, cfg);
  await ensureMemoryReplica(cfg, id);
  return saveWithBranch(db, {
    id, name: name ?? upstreamName(url), source: { kind: "upstream", url }, replica, home, defaultBranch,
  }, commit);
}

/**
 * Records another node's project: the id, name, home and default branch the home gave it (none when absent), with this node's service repo of it at `replica` (made by the caller), and
 * `meddle://<home>/project/<id>` as its source.
 */
export function registerReplica(
  db: Database,
  project: { id: string; name: string; home: string; replica: string; defaultBranch?: string | null },
): Project {
  const url = `meddle://${project.home}/project/${project.id}`;
  return save(db, { ...project, defaultBranch: project.defaultBranch ?? null, source: { kind: "upstream", url } });
}

export function listProjects(db: Database): Project[] {
  return listProjectRows(db).map(toProject);
}

export function getProject(db: Database, id: string): Project | null {
  const row = getProjectRow(db, id);
  return row ? toProject(row) : null;
}

/** Sets project `projectId`'s default branch to `branch`; null when this node has no such project. */
export function setDefaultBranch(db: Database, projectId: string, branch: string): Project | null {
  if (getProjectRow(db, projectId) === null) return null;
  setProjectDefaultBranchRow(db, projectId, branch);
  changed();
  return getProject(db, projectId);
}
