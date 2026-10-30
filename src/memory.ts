import { cp, mkdir, readdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import type { NodeConfig } from "./config";
import { paths } from "./paths";
import { initColocated, isJjRepo, jj } from "./jj";
import { exists } from "./profile";

export function claudeSlot(absPath: string): string {
  return absPath.replace(/[^A-Za-z0-9]/g, "-");
}

export async function ensureMemoryReplica(cfg: NodeConfig, projectId: string): Promise<string> {
  const replica = paths(cfg).memory(projectId);
  await mkdir(replica, { recursive: true });
  if (!(await isJjRepo(replica))) await initColocated(replica);
  return replica;
}

export async function importMemory(cfg: NodeConfig, projectId: string, projectPath: string): Promise<boolean> {
  const slot = claudeSlot(projectPath);
  const source = join(cfg.claudeHome, "projects", slot, "memory");
  const replica = paths(cfg).memory(projectId);
  if (!(await exists(source)) || (await exists(join(replica, "MEMORY.md")))) return false;
  const before = new Set(await readdir(replica));
  try {
    await cp(source, replica, { recursive: true, dereference: true });
  } catch (err) {
    for (const entry of await readdir(replica)) {
      if (!before.has(entry)) await rm(join(replica, entry), { recursive: true, force: true });
    }
    throw err;
  }
  await jj(["commit", "-m", `import memory from ${slot}`, "--config", 'snapshot.max-new-file-size="50MiB"'], replica);
  return true;
}

export async function linkMemory(configDir: string, cfg: NodeConfig, projectId: string): Promise<void> {
  const projectDir = join(configDir, "projects", projectId);
  await mkdir(projectDir, { recursive: true });
  const at = join(projectDir, "memory");
  await rm(at, { recursive: true, force: true });
  await symlink(paths(cfg).memory(projectId), at);
}
