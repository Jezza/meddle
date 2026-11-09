import { mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Database } from "bun:sqlite";
import type { NodeConfig } from "../config";
import { checkTaskRoot, ensurePrivateDir, paths } from "../paths";
import {
  bookmarkForget, bookmarkList, bookmarkSet, commitOf, configSetWorkspace, editIn, isJjRepo, workspaceAdd,
  workspaceConfigPath, workspaceForget,
} from "../jj";
import { ensurePlugins, linkProfile, seedProfile } from "../profile";
import { ensureMemoryReplica, linkMemory } from "../memory";
import { contextTextAt } from "../projects/context";
import { getProject, type Project } from "../projects/project";
import { getTask, insertTask } from "../store/records";
import { repoKey, serialised } from "../serial";
import type { TaskState } from "./durable";
import { taskNamespace, writeManifest, type Start, type TaskManifest } from "./manifest";

export type SettingSource = "user" | "project" | "local";

export function generatedClaudeMd(m: TaskManifest, projects: Project[]): string {
  if (projects.length === 0) {
    return [
      "This task has no project attached. This folder is scratch space; it travels with the task.",
      "",
    ].join("\n");
  }
  const lines = projects.map((p) => `- ${p.name}/: jj workspace of project ${p.name}`);
  return [
    ...lines,
    "",
    "This folder is a meddle task. Each project is a jj workspace; commit with jj.",
    "",
    `To keep a side branch, give it a bookmark named meddle/task/${m.id}/<project>.<label> (for example meddle/task/${m.id}/<project>.spike). Bookmarks outside that namespace are not backed up and do not travel, and git refuses a name with a slash after the project name.`,
    "",
  ].join("\n");
}

/**
 * Where a task's Claude Code runs: one project → its workspace, which is also where its project settings are read
 * (the project's files as of the task's start, never the service repo's empty working copy); several → the task folder,
 * user settings only (each project's settings are composed in); none → the task folder, user settings only and no
 * project config root.
 */
export function cwdFor(
  m: TaskManifest,
  cfg: NodeConfig,
): { cwd: string; projectConfigRoot?: string | null; settingSources: SettingSource[] } {
  const task = paths(cfg).task(m.id);
  const [only] = m.projects;
  if (m.projects.length === 1 && only) {
    const workspace = join(task, only.workspace);
    return { cwd: workspace, projectConfigRoot: workspace, settingSources: ["user", "project", "local"] };
  }
  if (m.projects.length === 0) return { cwd: task, projectConfigRoot: null, settingSources: ["user"] };
  return { cwd: task, settingSources: ["user"] };
}

/**
 * What a task's workspace takes as `immutable_heads()` (Decision 2): each commit of `base` and everything below it;
 * every local bookmark but task `taskId`'s own (`meddle/task/<id>/*`): the branches and this node's other tasks'
 * lines; and every line held elsewhere (`task/<t>/*@meddle`) but the task's own, which it has before provisioning and
 * on a receiver before activation. Its agent may rewrite its own line and anything else. The remote term picks lines by
 * bookmark name, so a commit another node's line also holds stays immutable to it. The local term is a difference of
 * commit sets: a branch's commit (or another local line's) is protected only while the task's own bookmark is not on it
 * too. A branch the agent drags along that way is put back at turn end (`applyProject`), and checkouts only ever see
 * branches as their rows say, never the service repo's bookmarks.
 */
export function workspaceImmutableHeads(taskId: string, base: string[]): string {
  return [
    ...base.map((commit) => `present(${commit})`),
    `(bookmarks() ~ bookmarks(glob:"meddle/task/${taskId}/*"))`,
    `untracked_remote_bookmarks(~glob:"task/${taskId}/*", remote=exact:"meddle")`,
  ].join(" | ");
}

/**
 * Scopes the workspace `workspace` of task `taskId` to its own line (`workspaceImmutableHeads`), in its own jj config,
 * and notes where jj keeps workspace configs on this node (`jjWorkspacesNote`), for `unscopeWorkspace`.
 */
export async function scopeWorkspace(cfg: NodeConfig, workspace: string, taskId: string, base: string[]): Promise<void> {
  await configSetWorkspace(workspace, 'revset-aliases."immutable_heads()"', workspaceImmutableHeads(taskId, base), cfg);
  const file = await workspaceConfigPath(workspace, cfg);
  if (jjWorkspaceConfig(file)) await writeFile(paths(cfg).jjWorkspacesNote, dirname(dirname(file))).catch(() => {});
}

/** Whether `file` is where jj keeps a workspace's own config: `…/jj/workspaces/<id>/config.toml`. */
function jjWorkspaceConfig(file: string): boolean {
  const workspaces = dirname(dirname(file));
  return basename(file) === "config.toml" && basename(workspaces) === "workspaces" && basename(dirname(workspaces)) === "jj";
}

/**
 * The folder `<id>` under `workspaces` (jj's `…/jj/workspaces`) whose `metadata.binpb` names the workspace at
 * `workspace` (its `.jj`, the one string field jj writes there), or null when none does.
 */
async function configFolderNaming(workspaces: string, workspace: string): Promise<string | null> {
  const wanted = new Set([join(resolve(workspace), ".jj")]);
  try {
    wanted.add(join(await realpath(dirname(workspace)), basename(workspace), ".jj"));
  } catch {
    // Its parent is gone too: the path as given.
  }
  let entries: string[];
  try {
    entries = await readdir(workspaces);
  } catch {
    return null;
  }
  for (const entry of entries) {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(join(workspaces, entry, "metadata.binpb")));
    } catch {
      continue;
    }
    // Field 1, length-delimited: 0x0a, the length as a varint, the path.
    if (bytes[0] !== 0x0a) continue;
    let length = 0;
    let shift = 0;
    let at = 1;
    while (at < bytes.length && shift < 35) {
      const byte = bytes[at++]!;
      length |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    if (at + length !== bytes.length) continue;
    if (wanted.has(new TextDecoder().decode(bytes.subarray(at)))) return join(workspaces, entry);
  }
  return null;
}

/**
 * Removes the jj config `scopeWorkspace` wrote for the workspace at `workspace`: jj keeps it outside the workspace and
 * `jj workspace forget` leaves it, so this runs first. When the file is where jj keeps a workspace's config,
 * `…/jj/workspaces/<id>/config.toml`, the folder `<id>` that workspace alone has goes with it (beside it, jj's note of
 * where the workspace is); any other file, only itself. When the workspace's folder is gone (never asking a repo jj
 * would find above it), the folder in the `jjWorkspacesNote` dir whose note names the workspace goes instead. None is
 * no error.
 */
export async function unscopeWorkspace(cfg: NodeConfig, workspace: string): Promise<void> {
  if (!(await isJjRepo(workspace))) {
    const workspaces = await readFile(paths(cfg).jjWorkspacesNote, "utf8").catch(() => null);
    if (workspaces === null || basename(workspaces) !== "workspaces" || basename(dirname(workspaces)) !== "jj") return;
    const folder = await configFolderNaming(workspaces, workspace);
    if (folder !== null) await rm(folder, { recursive: true, force: true });
    return;
  }
  const file = await workspaceConfigPath(workspace, cfg);
  await rm(jjWorkspaceConfig(file) ? dirname(file) : file, { recursive: true, force: true });
}

/** `unscopeWorkspace`, then `workspaceForget`, each best effort: what is already gone is no error. */
export async function dropWorkspace(cfg: NodeConfig, repo: string, workspaceName: string, workspace: string): Promise<void> {
  await unscopeWorkspace(cfg, workspace).catch(() => {});
  await workspaceForget(repo, workspaceName, cfg).catch(() => {});
}

/** The projects `projectIds` name, in order (none for a task without a project). */
function resolveProjects(db: Database, projectIds: string[]): Project[] {
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

/**
 * Provisions task `taskId` from `starts`, the starts resolved for its projects, in order (the first the primary; none
 * for a task without a project). Each project gets a jj workspace in its service repo here at its start's commit,
 * which jj there must know (the task's line brought it), editing it in `edit` mode or a new change on it in `child`
 * mode. Each workspace is scoped to the task's line from its base (`scopeWorkspace`), and the task's bookmark
 * `meddle/task/<id>/<project>` points at its working copy, set without snapshotting the repo's own. On failure, removes
 * what it made.
 */
export async function provisionTask(
  cfg: NodeConfig,
  db: Database,
  input: { title: string; taskId: string; starts: Start[] },
): Promise<TaskManifest> {
  const root = await checkTaskRoot(cfg);
  if (!root.ok) throw new Error(root.reason);
  const { taskId: id, starts } = input;
  // The id names folders here, and a failed provision removes the task's folder: never an existing task's.
  if (!SAFE_ID.test(id)) throw new Error(`invalid task id: ${id}`);
  if (getTask(db, id) !== null) throw new Error(`task ${id} exists here`);
  const projects = resolveProjects(db, starts.map((s) => s.projectId));
  // Each goes into a revset, and a base into the workspace's jj config: nothing but a commit id.
  for (const start of starts) {
    for (const c of [start.commit, ...start.base]) if (!COMMIT_ID.test(c)) throw new Error(`invalid commit: ${c}`);
  }
  await seedProfile(cfg);
  await ensurePlugins(cfg);

  const p = paths(cfg);
  const task = p.task(id);
  const workspaceName = `meddle-${id}`;
  const added: Array<{ replica: string; workspace: string }> = [];
  const bookmarks: Array<{ replica: string; name: string }> = [];
  try {
    const configDir = p.taskConfig(id);
    await mkdir(task, { recursive: true });
    await ensurePrivateDir(p.taskMeta(id)); // the transcripts live under it
    await mkdir(configDir, { recursive: true });
    const entries: TaskManifest["projects"] = [];
    for (const [i, project] of projects.entries()) {
      const start = starts[i]!;
      const parent = start.commit;
      const base = [...start.base];
      const workspace = join(task, project.name);
      added.push({ replica: project.replica, workspace });
      await workspaceAdd(project.replica, workspaceName, workspace, parent, cfg);
      // Scoped first: on the home, the task's own line holds the commit an edit start works on.
      await scopeWorkspace(cfg, workspace, id, base);
      if (start.mode === "edit") await editIn(workspace, parent, cfg);
      const bookmark = `${taskNamespace(id)}${project.name}`;
      const head = await commitOf(workspace, "@", cfg);
      bookmarks.push({ replica: project.replica, name: bookmark });
      await serialised(repoKey(project.replica), () => bookmarkSet(project.replica, bookmark, head, cfg, { ignoreWorkingCopy: true }));
      // The meddle context as the start commit has it, in the service repo: never what the agent may later edit.
      const context = await contextTextAt(cfg, project.replica, parent);
      entries.push({ id: project.id, name: project.name, replica: project.replica, workspace: project.name, parent, base, context });
    }
    await linkProfile(configDir, cfg);
    // The primary project's memory; a task without a project has none.
    const primary = projects[0];
    if (primary !== undefined) {
      await ensureMemoryReplica(cfg, primary.id);
      await linkMemory(configDir, cfg, primary.id);
    }
    const manifest: TaskManifest = {
      id,
      title: input.title,
      sessionId: crypto.randomUUID(),
      projects: entries,
      primaryProjectId: primary?.id ?? null,
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
    for (const { replica, name } of bookmarks) await serialised(repoKey(replica), () => bookmarkForget(replica, `exact:${name}`, cfg, { ignoreWorkingCopy: true })).catch(() => {});
    for (const { replica, workspace } of added) await dropWorkspace(cfg, replica, workspaceName, workspace);
    await rm(task, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/** An id from another node (task, session): letters, digits, `-` and `_`. */
export const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/** A commit id from another node (SHA-1 or SHA-256). */
export const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** A folder or project name from another node: one path segment, as `provisionTask` admits. */
function safeName(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && !/[/\\\0]/.test(name);
}

/**
 * Throws unless a manifest from another node is safe to provision here: ids and folder names are single path
 * segments, workspaces are distinct, a project's base is a list of commit ids, its context a string or null, and the
 * primary project is one of the task's (null, for a task without one).
 */
export function checkReceivedManifest(m: TaskManifest): void {
  if (!SAFE_ID.test(m.id)) throw new Error(`invalid task id: ${m.id}`);
  if (!SAFE_ID.test(m.sessionId)) throw new Error(`invalid session id: ${m.sessionId}`);
  const workspaces = new Set<string>();
  for (const p of m.projects) {
    if (!safeName(p.name)) throw new Error(`invalid project name: ${p.name}`);
    if (!safeName(p.workspace)) throw new Error(`invalid workspace: ${p.workspace}`);
    if (workspaces.has(p.workspace)) throw new Error(`duplicate workspace in task: ${p.workspace}`);
    workspaces.add(p.workspace);
    // It goes into the workspace's jj config as a revset: nothing but a commit id.
    const base: unknown = p.base;
    if (!Array.isArray(base) || !base.every((c) => typeof c === "string" && COMMIT_ID.test(c))) {
      throw new Error(`invalid base: ${JSON.stringify(base)}`);
    }
    const context: unknown = p.context;
    if (context !== null && typeof context !== "string") throw new Error(`invalid context of project ${p.name}`);
  }
  if (m.projects.length === 0 ? m.primaryProjectId !== null : !m.projects.some((p) => p.id === m.primaryProjectId)) {
    throw new Error("the primary project is not one of the task's");
  }
}

/**
 * Provisions a task another node sent: the steps of `provisionTask`, keeping the manifest's id, title, session,
 * primary project, creation time and projects (ids, names, workspaces, bases, and the meddle contexts captured at the
 * task's start), with each project's `replica` this node's and its `parent` the revision `parents[projectId]` (fetched
 * from the sender), where the workspace starts and the task's bookmark points. Each workspace is scoped to the task's
 * line (`scopeWorkspace`). Writes `task.json` and the row (`started` 1,
 * `state`, no turns); with `keepRow` (a task restored from its archive on this node, whose row is still here), no row:
 * the caller updates it. On failure, removes what it made.
 */
export async function provisionFromManifest(
  cfg: NodeConfig,
  db: Database,
  manifest: TaskManifest,
  parents: Record<string, string>,
  state: TaskState,
  options: { keepRow?: boolean } = {},
): Promise<TaskManifest> {
  const root = await checkTaskRoot(cfg);
  if (!root.ok) throw new Error(root.reason);
  checkReceivedManifest(manifest);
  const { id } = manifest;
  const projects: Project[] = [];
  for (const entry of manifest.projects) {
    const project = getProject(db, entry.id);
    if (project === null) throw new Error(`unknown project: ${entry.id}`);
    if (parents[entry.id] === undefined) throw new Error(`no parent for project ${entry.id}`);
    projects.push({ ...project, name: entry.name });
  }
  await seedProfile(cfg);
  await ensurePlugins(cfg);

  const p = paths(cfg);
  const task = p.task(id);
  const workspaceName = `meddle-${id}`;
  const added: Array<{ replica: string; workspace: string }> = [];
  /** Bookmarks this call created; one the replica already had (the home's backup) is left alone. */
  const bookmarks: Array<{ replica: string; name: string }> = [];
  try {
    const configDir = p.taskConfig(id);
    await mkdir(task, { recursive: true });
    await ensurePrivateDir(p.taskMeta(id));
    await mkdir(configDir, { recursive: true });
    const entries: TaskManifest["projects"] = [];
    for (const [i, entry] of manifest.projects.entries()) {
      const replica = projects[i]!.replica;
      const parent = parents[entry.id]!;
      const base = entry.base;
      const workspace = join(task, entry.workspace);
      added.push({ replica, workspace });
      await workspaceAdd(replica, workspaceName, workspace, parent, cfg);
      await scopeWorkspace(cfg, workspace, id, base);
      const bookmark = `${taskNamespace(id)}${entry.name}`;
      await serialised(repoKey(replica), async () => {
        const existed = (await bookmarkList(replica, cfg)).some((b) => b.name === bookmark && b.remote === null);
        await bookmarkSet(replica, bookmark, parent, cfg, { ignoreWorkingCopy: true });
        if (!existed) bookmarks.push({ replica, name: bookmark });
      });
      entries.push({ ...entry, replica, parent, base });
    }
    await linkProfile(configDir, cfg);
    if (manifest.primaryProjectId !== null) {
      await ensureMemoryReplica(cfg, manifest.primaryProjectId);
      await linkMemory(configDir, cfg, manifest.primaryProjectId);
    }
    const received: TaskManifest = { ...manifest, projects: entries };
    await writeFile(join(task, "CLAUDE.md"), generatedClaudeMd(received, projects));
    await writeManifest(cfg, received);
    if (options.keepRow !== true) {
      insertTask(db, {
        id,
        title: received.title,
        state,
        session_id: received.sessionId,
        manifest: JSON.stringify(received),
        started: 1,
        turns: 0,
      });
    }
    return received;
  } catch (err) {
    for (const { replica, name } of bookmarks) await serialised(repoKey(replica), () => bookmarkForget(replica, `exact:${name}`, cfg, { ignoreWorkingCopy: true })).catch(() => {});
    for (const { replica, workspace } of added) await dropWorkspace(cfg, replica, workspaceName, workspace);
    await rm(task, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}
