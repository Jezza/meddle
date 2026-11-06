import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { Database } from "bun:sqlite";
import type { Subscribable } from "@earendil-works/chord";
import { paths, type NodeConfig } from "../config";
import { cloneColocated, git, initColocated, isJjRepo, networkMs } from "../jj";
import { ensureMemoryReplica, importMemory } from "../memory";
import { getProjectRow, insertProject, listProjectRows, newId, setProjectSyncRow, setProjectUpstreamRow, type ProjectRow } from "../store/records";

export type Project = {
  id: string;
  name: string;
  source: { kind: "folder"; path: string } | { kind: "upstream"; url: string };
  replica: string;
  /** The node id of the project's home: the node whose repo is the project's, and that minted its id. */
  home: string;
  /** The sync branches, in order: bookmarks of the project a task can start from. The first is a url project's default. */
  sync: string[];
  /**
   * Whether the project was added from an upstream URL on its home, so that its default start is its first sync branch
   * (Decision 4); a replica holds what its home said.
   */
  upstream: boolean;
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
  // A row from before `upstream`: a replica's source is its home's `meddle://` url, and reads as a folder project.
  const upstream = row.upstream === null ? row.source_kind === "upstream" && !row.source.startsWith("meddle://") : row.upstream === 1;
  return { id: row.id, name: row.name, source, replica: row.replica, home: row.home ?? "", sync: parseSync(row.sync), upstream };
}

/** The names in a stored sync list; NULL, or anything that is not a JSON array of strings, is none. */
function parseSync(stored: string | null): string[] {
  if (stored === null) return [];
  try {
    const list: unknown = JSON.parse(stored);
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Rejects `invalid sync branch name "<name>"` for the first of `names` that is empty, starts with `-`, or is not a
 * legal git branch name (`git check-ref-format --branch`).
 */
export async function checkSyncNames(cfg: NodeConfig, names: readonly string[]): Promise<void> {
  for (const name of names) {
    const legal = name !== "" && !name.startsWith("-") && await git(["check-ref-format", "--branch", name], cfg.dataDir, cfg).then((out) => out.trim() === name, () => false);
    if (!legal) throw new Error(`invalid sync branch name "${name}"`);
  }
}

/** `names` once each, in order. */
function distinct(names: readonly string[]): string[] {
  return [...new Set(names)];
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
    sync: project.sync.length === 0 ? null : JSON.stringify(project.sync),
    upstream: project.upstream ? 1 : 0,
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
 * Adds the project in `folder` (made a colocated jj repo when it is not one), with its home `home` (this node) and
 * the sync branches `sync`.
 */
export async function addProjectFromFolder(
  cfg: NodeConfig, db: Database, folder: string, home: string, name?: string, sync: string[] = [],
): Promise<Project> {
  const path = resolve(folder);
  await checkSyncNames(cfg, sync);
  if (!(await isDirectory(path))) throw new Error(`not a directory: ${folder}`);
  const id = newId();
  if (!(await isJjRepo(path))) await initColocated(path, cfg);
  await ensureMemoryReplica(cfg, id);
  await importMemory(cfg, id, path);
  return save(db, { id, name: name ?? basename(path), source: { kind: "folder", path }, replica: path, home, sync: distinct(sync), upstream: false });
}

function upstreamName(url: string): string {
  const last = url.replace(/\/+$/, "").split(/[/:]/).pop() ?? url;
  return last.replace(/\.git$/, "");
}

/** The branch the upstream's `HEAD` names, or null when it names none (an empty repo). */
async function upstreamDefaultBranch(url: string, cfg: NodeConfig): Promise<string | null> {
  const out = await git(["ls-remote", "--symref", url, "HEAD"], cfg.dataDir, cfg, { timeoutMs: networkMs(cfg) });
  const match = /^ref: refs\/heads\/(.+)\tHEAD$/m.exec(out);
  return match === null ? null : match[1]!;
}

/**
 * Adds a project cloned from `url` into the replicas directory, with its home `home` (this node). Its sync branches are
 * the upstream's default branch (when it has one), then `sync`, each once.
 */
export async function addProjectFromUpstream(
  cfg: NodeConfig, db: Database, url: string, home: string, name?: string, sync: string[] = [],
): Promise<Project> {
  await checkSyncNames(cfg, sync);
  const id = newId();
  const defaultBranch = await upstreamDefaultBranch(url, cfg);
  const replica = paths(cfg).replica(id);
  await cloneColocated(url, replica, cfg);
  await ensureMemoryReplica(cfg, id);
  return save(db, { id, name: name ?? upstreamName(url), source: { kind: "upstream", url }, replica, home, sync: distinct([...(defaultBranch === null ? [] : [defaultBranch]), ...sync]), upstream: true });
}

/**
 * Records a replica of another node's project: the id, name, home, sync branches and `upstream` the home gave it
 * (none and false when absent), cloned (by the caller) into `replica` from `meddle://<home>/project/<id>`, which is its
 * source.
 */
export function registerReplica(
  db: Database, project: { id: string; name: string; home: string; replica: string; sync?: string[]; upstream?: boolean },
): Project {
  const url = `meddle://${project.home}/project/${project.id}`;
  return save(db, { ...project, sync: project.sync ?? [], upstream: project.upstream ?? false, source: { kind: "upstream", url } });
}

export function listProjects(db: Database): Project[] {
  return listProjectRows(db).map(toProject);
}

export function getProject(db: Database, id: string): Project | null {
  const row = getProjectRow(db, id);
  return row ? toProject(row) : null;
}

/** Records whether project `projectId`'s default start is its first sync branch; null when this node has no such project. */
export function setProjectUpstream(db: Database, projectId: string, upstream: boolean): Project | null {
  if (getProjectRow(db, projectId) === null) return null;
  setProjectUpstreamRow(db, projectId, upstream);
  changed();
  return getProject(db, projectId);
}

/** Replaces project `projectId`'s sync branches with `sync` (each once); null when this node has no such project. */
export function setProjectSync(db: Database, projectId: string, sync: string[]): Project | null {
  if (getProjectRow(db, projectId) === null) return null;
  const names = distinct(sync);
  setProjectSyncRow(db, projectId, names.length === 0 ? null : JSON.stringify(names));
  changed();
  return getProject(db, projectId);
}
