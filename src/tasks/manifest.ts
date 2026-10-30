import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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
