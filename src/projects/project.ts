import { randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { paths, type NodeConfig } from "../config";
import { cloneColocated, initColocated, isJjRepo } from "../jj";
import { ensureMemoryReplica, importMemory } from "../memory";
import { getProjectRow, insertProject, listProjectRows, type ProjectRow } from "../store/records";

export type Project = {
  id: string;
  name: string;
  source: { kind: "folder"; path: string } | { kind: "upstream"; url: string };
  replica: string;
};

function newId(): string {
  return randomBytes(6).toString("hex");
}

function toProject(row: ProjectRow): Project {
  const source: Project["source"] = row.source_kind === "folder"
    ? { kind: "folder", path: row.source }
    : { kind: "upstream", url: row.source };
  return { id: row.id, name: row.name, source, replica: row.replica };
}

function save(db: Database, project: Project): Project {
  insertProject(db, {
    id: project.id,
    name: project.name,
    source_kind: project.source.kind,
    source: project.source.kind === "folder" ? project.source.path : project.source.url,
    replica: project.replica,
    created_at: new Date().toISOString(),
  });
  return project;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export async function addProjectFromFolder(cfg: NodeConfig, db: Database, folder: string, name?: string): Promise<Project> {
  const path = resolve(folder);
  if (!(await isDirectory(path))) throw new Error(`not a directory: ${folder}`);
  const id = newId();
  if (!(await isJjRepo(path))) await initColocated(path);
  await ensureMemoryReplica(cfg, id);
  await importMemory(cfg, id, path);
  return save(db, { id, name: name ?? basename(path), source: { kind: "folder", path }, replica: path });
}

function upstreamName(url: string): string {
  const last = url.replace(/\/+$/, "").split(/[/:]/).pop() ?? url;
  return last.replace(/\.git$/, "");
}

export async function addProjectFromUpstream(cfg: NodeConfig, db: Database, url: string, name?: string): Promise<Project> {
  const id = newId();
  const replica = paths(cfg).replica(id);
  await cloneColocated(url, replica);
  await ensureMemoryReplica(cfg, id);
  return save(db, { id, name: name ?? upstreamName(url), source: { kind: "upstream", url }, replica });
}

export function listProjects(db: Database): Project[] {
  return listProjectRows(db).map(toProject);
}

export function getProject(db: Database, id: string): Project | null {
  const row = getProjectRow(db, id);
  return row ? toProject(row) : null;
}
