import { access, chmod, mkdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import type { NodeConfig } from "./config";

export function paths(cfg: NodeConfig) {
  const data = cfg.dataDir;
  const secrets = join(data, "secrets");
  const task = (taskId: string) => join(cfg.taskRoot, taskId);
  return {
    profile: join(data, "profile"),
    plugins: join(data, "plugins"),
    secrets,
    tokenFile: join(secrets, "claude-token"),
    db: join(data, "meddle.sqlite"),
    durableDb: join(data, "durable.sqlite"),
    memory: (projectId: string) => join(data, "memory", projectId),
    replica: (projectId: string) => join(data, "replicas", projectId),
    task,
    taskConfig: (taskId: string) => join(task(taskId), ".meddle", "claude"),
    taskManifest: (taskId: string) => join(task(taskId), ".meddle", "task.json"),
  };
}

export async function ensureDataDirs(cfg: NodeConfig): Promise<void> {
  const p = paths(cfg);
  for (const dir of [cfg.dataDir, p.profile, p.plugins, join(cfg.dataDir, "memory"), join(cfg.dataDir, "replicas")]) {
    await mkdir(dir, { recursive: true });
  }
  await mkdir(p.secrets, { recursive: true, mode: 0o700 });
  await chmod(p.secrets, 0o700);
}

export async function checkTaskRoot(cfg: NodeConfig): Promise<{ ok: true } | { ok: false; reason: string }> {
  const root = cfg.taskRoot;
  try {
    if (!(await stat(root)).isDirectory()) return { ok: false, reason: `task root ${root} is not a directory` };
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
    return { ok: false, reason: `task root ${root} ${missing ? "does not exist" : "is not accessible"}` };
  }
  try {
    await access(root, constants.W_OK);
  } catch {
    return { ok: false, reason: `task root ${root} is not writable` };
  }
  return { ok: true };
}
