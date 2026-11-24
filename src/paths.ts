import { access, chmod, mkdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import type { NodeConfig } from "./config";

export function paths(cfg: NodeConfig) {
  const data = cfg.dataDir;
  const secrets = join(data, "secrets");
  const task = (taskId: string) => join(cfg.taskRoot, taskId);
  const bin = join(data, "bin");
  return {
    profile: join(data, "profile"),
    plugins: join(data, "plugins"),
    /** Claude Code's registry of live sessions, shared by every task's config dir so their agents can message each other. */
    sessions: join(data, "sessions"),
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
    /** Where the files attached to a task's prompts are put for its agent to read (they live on in `blobs`). */
    taskAttachments: (taskId: string) => join(task(taskId), ".meddle", "attachments"),
    /** The sockets tasks' Claude Codes listen on for messages from other tasks, and meddle's for their receipts (mode 700). */
    socks: join(data, "socks"),
    /** Where task `taskId`'s Claude Code listens for messages (`--messaging-socket-path`). */
    taskSocket: (taskId: string) => join(data, "socks", `${taskId}.sock`),
    /** Prepended to `PATH` for every jj meddle runs (never an agent's): it holds the git remote helper. */
    bin,
    binHelper: join(bin, "git-remote-meddle"),
    /** git's merge driver for the repos of synced scopes (the profile, each project's memory). */
    binMergeDriver: join(bin, "meddle-merge-driver"),
    /** `core.hooksPath` of every `receive-pack` this node serves (a checkout's push here, a peer's to a memory repo). */
    checkoutHooks: join(data, "checkout-hooks"),
    hookPreReceive: join(data, "checkout-hooks", "pre-receive"),
    gitSocket: cfg.gitSocket ?? join(data, "git.sock"),
    /** The archives of tasks archived here, kept until the task is restored or deleted: mode 700, each archive 600. */
    archives: join(data, "archives"),
    archiveFile: (taskId: string) => join(data, "archives", `${taskId}.json.gz`),
    /** The files uploaded to this node, each named by the SHA-256 of its bytes and never deleted: mode 700, each file 600. */
    blobs: join(data, "blobs"),
    /** What a task that moved away left here (decision 18), kept seven days: mode 700, each file 600. */
    moved: join(data, "moved"),
    movedFile: (taskId: string) => join(data, "moved", `${taskId}.json.gz`),
    /**
     * Notes where jj keeps each workspace's own config on this node (`…/jj/workspaces`), as `scopeWorkspace` last found
     * it: `unscopeWorkspace` looks there for the config of a workspace whose folder is gone.
     */
    jjWorkspacesNote: join(data, "jj-workspaces"),
    /** The Claude Code config dir (and working directory) of the Haiku query that names a new task. */
    titleConfig: join(data, "title"),
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
  await ensurePrivateDir(p.sessions);
  await ensurePrivateDir(p.socks);
}

/** The programs a task's workspaces and moves run, which must be on the node's PATH. */
const TASK_TOOLS = ["jj", "git"] as const;

/**
 * Whether this node can host tasks: its task root is a writable directory, and jj and git are on its PATH (a service
 * may run with another PATH than a login shell: the reason names the PATH it looked on).
 */
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
  for (const tool of TASK_TOOLS) {
    if (Bun.which(tool, { PATH: process.env.PATH ?? "" }) === null) return { ok: false, reason: `${tool} is not on this node's PATH (${process.env.PATH ?? ""})` };
  }
  return { ok: true };
}
