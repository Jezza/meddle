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
