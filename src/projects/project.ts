import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { Database } from "bun:sqlite";
import type { Subscribable } from "@earendil-works/chord";
import { paths, type NodeConfig } from "../config";
import { cloneColocated, initColocated, isJjRepo } from "../jj";
import { ensureMemoryReplica, importMemory } from "../memory";
import { refreshTrunk } from "./replicas";
import { getProjectRow, insertProject, listProjectRows, newId, type ProjectRow } from "../store/records";

export type Project = {
  id: string;
  name: string;
  source: { kind: "folder"; path: string } | { kind: "upstream"; url: string };
  replica: string;
  /** The node id of the project's home: the node whose `trunk` is the project's, and that minted its id. */
  home: string;
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
  return { id: row.id, name: row.name, source, replica: row.replica, home: row.home ?? "" };
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
 * Adds the project in `folder` (made a colocated jj repo when it is not one), with its home `home` (this node); its
 * `trunk` bookmark follows its latest trunk-like revision (`refreshTrunk`).
 */
export async function addProjectFromFolder(cfg: NodeConfig, db: Database, folder: string, home: string, name?: string): Promise<Project> {
  const path = resolve(folder);
  if (!(await isDirectory(path))) throw new Error(`not a directory: ${folder}`);
  const id = newId();
  if (!(await isJjRepo(path))) await initColocated(path, cfg);
  await refreshTrunk(cfg, path);
  await ensureMemoryReplica(cfg, id);
  await importMemory(cfg, id, path);
  return save(db, { id, name: name ?? basename(path), source: { kind: "folder", path }, replica: path, home });
}

function upstreamName(url: string): string {
  const last = url.replace(/\/+$/, "").split(/[/:]/).pop() ?? url;
  return last.replace(/\.git$/, "");
}

/**
 * Adds a project cloned from `url` into the replicas directory, with its home `home` (this node); its `trunk`
 * bookmark follows the upstream's trunk (`refreshTrunk`).
 */
export async function addProjectFromUpstream(cfg: NodeConfig, db: Database, url: string, home: string, name?: string): Promise<Project> {
  const id = newId();
  const replica = paths(cfg).replica(id);
  await cloneColocated(url, replica, cfg);
  await refreshTrunk(cfg, replica);
  await ensureMemoryReplica(cfg, id);
  return save(db, { id, name: name ?? upstreamName(url), source: { kind: "upstream", url }, replica, home });
}

/**
 * Records a replica of another node's project: the id, name and home the home gave it, cloned (by the caller) into
 * `replica` from `meddle://<home>/project/<id>`, which is its source.
 */
export function registerReplica(db: Database, project: { id: string; name: string; home: string; replica: string }): Project {
  const url = `meddle://${project.home}/project/${project.id}`;
  return save(db, { ...project, source: { kind: "upstream", url } });
}

export function listProjects(db: Database): Project[] {
  return listProjectRows(db).map(toProject);
}

export function getProject(db: Database, id: string): Project | null {
  const row = getProjectRow(db, id);
  return row ? toProject(row) : null;
}
