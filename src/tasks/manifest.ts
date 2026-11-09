import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { NodeConfig } from "../config";
import { claudeSlot } from "../memory";
import { paths } from "../paths";

/** One project of a task: its workspace in the project's repo here (`replica`), and where the task started. */
export type ManifestProject = {
  id: string;
  name: string;
  replica: string;
  workspace: string;
  /** The revision the workspace was made on here: the commit its start named. */
  parent: string;
  /**
   * The commits the task's work is measured from: its workspace may rewrite nothing at or below them
   * (`scopeWorkspace`). Its start's `base`: the revision itself for a child start, its parents for an edit start.
   */
  base: string[];
  /**
   * The project's `.meddle/context.toml` as the task's start commit had it (null for none), captured as the task was
   * created so that its agent cannot loosen it.
   */
  context: string | null;
};

export type TaskManifest = {
  id: string;
  title: string;
  sessionId: string;
  projects: ManifestProject[];
  /** The first project's id; null for a task without a project. */
  primaryProjectId: string | null;
  createdAt: string;
};

/** How a task takes a revision it starts at: `edit` works on it in place, `child` on a new change on top of it. */
export type HandoffMode = "edit" | "child";

/**
 * Where one project of a task starts, as the node asked resolved it (commit ids): the task's line is written at
 * `commit`, and `base` are the commits the task's work is measured from (`[commit]` in `child` mode, its parents in
 * `edit` mode).
 */
export type Start = { projectId: string; mode: HandoffMode; commit: string; base: string[] };

/**
 * Every bookmark of task `taskId` is under `meddle/task/<taskId>/`: its project's bookmark `<project name>` and the
 * side bookmarks the agent names `<project name>.<label>`. Each is one of its line rows (`writeLineRows`), all travel
 * on a move, and they are forgotten together.
 */
export function taskNamespace(taskId: string): string {
  return `meddle/task/${taskId}/`;
}

/** The jj string pattern for every bookmark under the task's namespace (jj's glob `*` crosses `/`). */
export function taskGlob(taskId: string): string {
  return `glob:${taskNamespace(taskId)}*`;
}

/**
 * A side bookmark's name: `<project>.<label>`, not `<project>/<label>`, since git cannot hold `…/p` and `…/p/x`
 * side by side (its refs are files).
 */
export function sideBookmark(taskId: string, projectName: string, label: string): string {
  return `${taskNamespace(taskId)}${projectName}.${label}`;
}

export async function readManifest(cfg: NodeConfig, taskId: string): Promise<TaskManifest> {
  return JSON.parse(await readFile(paths(cfg).taskManifest(taskId), "utf8")) as TaskManifest;
}

export async function writeManifest(cfg: NodeConfig, m: TaskManifest): Promise<void> {
  const file = paths(cfg).taskManifest(m.id);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(m, null, 2)}\n`);
}

/**
 * The project dir Claude Code keeps the task's session in, under `<taskConfig>/projects/`: the one it is told to use
 * (`CLAUDE_CODE_PROJECT_DIR_NAME`, the primary project); for a task without a project, its own name for the folder
 * it runs in, the task folder (resolved, as the child's working directory is). Needs the task folder to exist then.
 */
export function transcriptSlot(cfg: NodeConfig, m: TaskManifest): string {
  return m.primaryProjectId ?? claudeSlot(realpathSync(paths(cfg).task(m.id)));
}

/**
 * Where Claude Code keeps the task's session transcript: under the task's config dir, in `transcriptSlot`. It exists
 * once Claude Code has read a first prompt.
 */
export function transcriptPath(cfg: NodeConfig, m: TaskManifest): string {
  return join(paths(cfg).taskConfig(m.id), "projects", transcriptSlot(cfg, m), `${m.sessionId}.jsonl`);
}
