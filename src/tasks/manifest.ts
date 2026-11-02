import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { NodeConfig } from "../config";
import { claudeSlot } from "../memory";
import { paths } from "../paths";

export type TaskManifest = {
  id: string;
  title: string;
  sessionId: string;
  projects: Array<{ id: string; name: string; replica: string; workspace: string; parent: string }>;
  /** The first project's id; null for a task without a project. */
  primaryProjectId: string | null;
  createdAt: string;
};

/**
 * Every bookmark of task `taskId` is under `meddle/task/<taskId>/`: its project's bookmark `<project name>` and the
 * side bookmarks the agent names `<project name>.<label>`. All of them are pushed to the home, travel on a move and
 * are forgotten together.
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
