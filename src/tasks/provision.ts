import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { NodeConfig } from "../config";
import { checkTaskRoot, ensurePrivateDir, paths } from "../paths";
import { bookmarkDelete, bookmarkSet, changeId, workspaceAdd, workspaceForget } from "../jj";
import { ensurePlugins, linkProfile, seedProfile } from "../profile";
import { ensureMemoryReplica, linkMemory } from "../memory";
import { getProject, type Project } from "../projects/project";
import { refreshTrunk } from "../projects/replicas";
import { insertTask, newId } from "../store/records";
import { writeManifest, type TaskManifest } from "./manifest";

export type SettingSource = "user" | "project" | "local";

export function generatedClaudeMd(m: TaskManifest, projects: Project[]): string {
  const lines = projects.map((p) => `- ${p.name}/: jj workspace of project ${p.name}`);
  return [
    `# Task: ${m.title}`,
    "",
    ...lines,
    "",
    "This folder is a meddle task. Each project is a jj workspace; commit with jj.",
    "",
  ].join("\n");
}

export function cwdFor(
  m: TaskManifest,
  cfg: NodeConfig,
): { cwd: string; projectConfigRoot?: string; settingSources: SettingSource[] } {
  const task = paths(cfg).task(m.id);
  const [only] = m.projects;
  if (m.projects.length === 1 && only) {
    return { cwd: join(task, only.workspace), projectConfigRoot: only.replica, settingSources: ["user", "project", "local"] };
  }
  return { cwd: task, settingSources: ["user"] };
}

function resolveProjects(db: Database, projectIds: string[]): Project[] {
  if (projectIds.length === 0) throw new Error("a task needs at least one project");
  const projects: Project[] = [];
  const names = new Set<string>();
  for (const id of projectIds) {
    const project = getProject(db, id);
    if (!project) throw new Error(`unknown project: ${id}`);
    const { name } = project;
    if (name.includes("/") || name === "." || name === "..") throw new Error(`invalid project name: ${name}`);
    if (names.has(name)) throw new Error(`duplicate project name in task: ${name}`);
    names.add(name);
    projects.push(project);
  }
  return projects;
}

export async function provisionTask(
  cfg: NodeConfig,
  db: Database,
  input: { title: string; projectIds: string[]; parents?: Record<string, string> },
): Promise<TaskManifest> {
  const root = await checkTaskRoot(cfg);
  if (!root.ok) throw new Error(root.reason);
  const projects = resolveProjects(db, input.projectIds);
  await seedProfile(cfg);
  await ensurePlugins(cfg);

  const p = paths(cfg);
  const id = newId();
  const task = p.task(id);
  const workspaceName = `meddle-${id}`;
  const added: string[] = [];
  const bookmarks: Array<{ replica: string; name: string }> = [];
  try {
    const configDir = p.taskConfig(id);
    await mkdir(task, { recursive: true });
    await ensurePrivateDir(p.taskMeta(id)); // the transcripts live under it
    await mkdir(configDir, { recursive: true });
    const entries: TaskManifest["projects"] = [];
    for (const project of projects) {
      const workspace = join(task, project.name);
      // The caller (a runner with a pool) passes the home's trunk; on its own, the project's trunk here (decision 5).
      const parent = input.parents?.[project.id] ?? (await refreshTrunk(cfg, project.replica)) ?? "root()";
      added.push(project.replica);
      await workspaceAdd(project.replica, workspaceName, workspace, parent, cfg);
      const bookmark = `meddle/task/${id}/${project.name}`;
      await bookmarkSet(project.replica, bookmark, await changeId(workspace, cfg), cfg);
      bookmarks.push({ replica: project.replica, name: bookmark });
      entries.push({ id: project.id, name: project.name, replica: project.replica, workspace: project.name, parent });
    }
    await linkProfile(configDir, cfg);
    const primary = projects[0]!;
    await ensureMemoryReplica(cfg, primary.id);
    await linkMemory(configDir, cfg, primary.id);
    const manifest: TaskManifest = {
      id,
      title: input.title,
      sessionId: crypto.randomUUID(),
      projects: entries,
      primaryProjectId: primary.id,
      createdAt: new Date().toISOString(),
    };
    await writeFile(join(task, "CLAUDE.md"), generatedClaudeMd(manifest, projects));
    await writeManifest(cfg, manifest);
    insertTask(db, {
      id,
      title: input.title,
      state: "idle",
      session_id: manifest.sessionId,
      manifest: JSON.stringify(manifest),
      started: 0,
      turns: 0,
    });
    return manifest;
  } catch (err) {
    for (const { replica, name } of bookmarks) await bookmarkDelete(replica, name, cfg).catch(() => {});
    for (const replica of added) await workspaceForget(replica, workspaceName, cfg).catch(() => {});
    await rm(task, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}
