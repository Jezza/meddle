import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { NodeConfig } from "../config";
import { paths } from "../paths";

export type TaskManifest = {
  id: string;
  title: string;
  sessionId: string;
  projects: Array<{ id: string; name: string; replica: string; workspace: string; parent: string }>;
  primaryProjectId: string;
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
 * Where Claude Code keeps the task's session transcript: under the task's config dir, in the project dir it is told
 * to use (`CLAUDE_CODE_PROJECT_DIR_NAME`, the primary project). It exists once Claude Code has read a first prompt.
 */
export function transcriptPath(cfg: NodeConfig, m: TaskManifest): string {
  return join(paths(cfg).taskConfig(m.id), "projects", m.primaryProjectId, `${m.sessionId}.jsonl`);
}
