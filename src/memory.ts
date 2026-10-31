import { cp, mkdir, readdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import type { NodeConfig } from "./config";
import { paths } from "./paths";
import { bookmarkSet, cloneColocated, initColocated, isJjRepo, jj, remoteAdd, remoteList } from "./jj";
import { shortId } from "./pool/ids";
import { exists } from "./profile";

/** The bookmark a memory repo's history is shared under. */
export const MEMORY_BOOKMARK = "memory";

export function claudeSlot(absPath: string): string {
  return absPath.replace(/[^A-Za-z0-9]/g, "-");
}

export async function ensureMemoryReplica(cfg: NodeConfig, projectId: string): Promise<string> {
  const replica = paths(cfg).memory(projectId);
  await mkdir(replica, { recursive: true });
  if (!(await isJjRepo(replica))) await initColocated(replica, cfg);
  return replica;
}

/**
 * The memory replica of a project homed on node `home`: cloned from `meddle://<home>/memory/<projectId>` with the
 * remote named `shortId(home)` when this node has none. When the clone fails (the home has no memory repo), an empty
 * local repo with that remote instead; a later sync fetches the home's `memory`. An existing replica is kept (it may
 * hold commits the home has not seen) and gets the remote when it lacks it.
 */
export async function cloneMemoryReplica(cfg: NodeConfig, projectId: string, home: string): Promise<string> {
  const replica = paths(cfg).memory(projectId);
  const remote = shortId(home);
  const url = `meddle://${home}/memory/${projectId}`;
  if (!(await isJjRepo(replica))) {
    await rm(replica, { recursive: true, force: true });
    try {
      await cloneColocated(url, replica, cfg, remote);
      return replica;
    } catch {
      await rm(replica, { recursive: true, force: true });
      await ensureMemoryReplica(cfg, projectId);
    }
  }
  if (!(await remoteList(replica, cfg)).some((r) => r.name === remote)) await remoteAdd(replica, remote, url, cfg);
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
  await jj(["commit", "-m", `import memory from ${slot}`, "--config", 'snapshot.max-new-file-size="50MiB"'], replica, cfg);
  await bookmarkSet(replica, MEMORY_BOOKMARK, "@-", cfg);
  return true;
}

export async function linkMemory(configDir: string, cfg: NodeConfig, projectId: string): Promise<void> {
  const projectDir = join(configDir, "projects", projectId);
  await mkdir(projectDir, { recursive: true });
  const at = join(projectDir, "memory");
  await rm(at, { recursive: true, force: true });
  await symlink(paths(cfg).memory(projectId), at);
}
