import { access, chmod, mkdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import type { NodeConfig } from "./config";

export function paths(cfg: NodeConfig) {
  const data = cfg.dataDir;
  const secrets = join(data, "secrets");
  const task = (taskId: string) => join(cfg.taskRoot, taskId);
  const bin = join(data, "bin");
  const hooks = join(data, "git-hooks");
  return {
    profile: join(data, "profile"),
    plugins: join(data, "plugins"),
    secrets,
    /** One file per login token, named by its id (mode 600, the directory 700); `tokenFile` in token.ts names them. */
    tokensDir: join(secrets, "tokens"),
    irohKey: join(secrets, "iroh.key"),
    db: join(data, "meddle.sqlite"),
    durableDb: join(data, "durable.sqlite"),
    memory: (projectId: string) => join(data, "memory", projectId),
    replica: (projectId: string) => join(data, "replicas", projectId),
    task,
    /** meddle's own files in a task folder, the Claude Code config dir and its transcripts among them. */
    taskMeta: (taskId: string) => join(task(taskId), ".meddle"),
    taskConfig: (taskId: string) => join(task(taskId), ".meddle", "claude"),
    taskManifest: (taskId: string) => join(task(taskId), ".meddle", "task.json"),
    /** Prepended to `PATH` for every jj and Claude Code meddle runs: it holds the git remote helper. */
    bin,
    binHelper: join(bin, "git-remote-meddle"),
    /** `core.hooksPath` of the `receive-pack` serving a peer's push. */
    hooks,
    hookUpdate: join(hooks, "update"),
    gitSocket: cfg.gitSocket ?? join(data, "git.sock"),
    /** The archives of tasks archived here, kept until the task is restored or deleted: mode 700, each archive 600. */
    archives: join(data, "archives"),
    archiveFile: (taskId: string) => join(data, "archives", `${taskId}.json.gz`),
    /** What a task that moved away left here (decision 18), kept seven days: mode 700, each file 600. */
    moved: join(data, "moved"),
    movedFile: (taskId: string) => join(data, "moved", `${taskId}.json.gz`),
  };
}

/** Creates `dir` with mode 700, or tightens it to 700 when it exists: it holds what only this user may read. */
export async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}

/** The data dir (mode 700: its database holds every task's transcript) and the directories under it. */
export async function ensureDataDirs(cfg: NodeConfig): Promise<void> {
  const p = paths(cfg);
  await ensurePrivateDir(cfg.dataDir);
  for (const dir of [p.profile, p.plugins, join(cfg.dataDir, "memory"), join(cfg.dataDir, "replicas")]) {
    await mkdir(dir, { recursive: true });
  }
  await ensurePrivateDir(p.secrets);
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
