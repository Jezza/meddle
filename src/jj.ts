import { mkdir, stat } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import type { NodeConfig } from "./config";
import { paths } from "./paths";

export class JjError extends Error {
  constructor(
    public args: string[],
    public code: number,
    public stderr: string,
  ) {
    super(`jj ${args.join(" ")} exited with code ${code}: ${stderr.trim()}`);
    this.name = "JjError";
  }
}

/**
 * The environment meddle runs jj (and Claude Code) with: this process's, with `<data>/bin` (the git remote helper)
 * first on `PATH` and `MEDDLE_GIT_SOCKET` naming this node's git socket.
 */
export function jjEnv(cfg: NodeConfig): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined) env[name] = value;
  const p = paths(cfg);
  env.PATH = env.PATH ? `${p.bin}${delimiter}${env.PATH}` : p.bin;
  env.MEDDLE_GIT_SOCKET = p.gitSocket;
  return env;
}

/** Runs jj in `cwd`; with `cfg`, in `jjEnv(cfg)` so that `meddle://` remotes work. Rejects a `JjError` on failure. */
export async function jj(args: string[], cwd: string, cfg?: NodeConfig): Promise<string> {
  const proc = Bun.spawn(["jj", "--no-pager", "--color", "never", ...args], {
    cwd,
    env: cfg === undefined ? process.env : jjEnv(cfg),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new JjError(args, code, stderr);
  return stdout;
}

export async function isJjRepo(dir: string): Promise<boolean> {
  try {
    return (await stat(join(dir, ".jj"))).isDirectory();
  } catch {
    return false;
  }
}

export async function initColocated(dir: string, cfg?: NodeConfig): Promise<void> {
  await mkdir(dir, { recursive: true });
  await jj(["git", "init", "--colocate"], dir, cfg);
}

/** Clones `url` into `dir` as a colocated repo whose remote is named `remote`. */
export async function cloneColocated(url: string, dir: string, cfg?: NodeConfig, remote = "origin"): Promise<void> {
  const parent = dirname(dir);
  await mkdir(parent, { recursive: true });
  await jj(["git", "clone", "--colocate", "--remote", remote, url, dir], parent, cfg);
}

export async function workspaceAdd(repo: string, name: string, path: string, revision: string, cfg?: NodeConfig): Promise<void> {
  await jj(["workspace", "add", "--colocate", "--name", name, "-r", revision, path], repo, cfg);
}

export async function workspaceForget(repo: string, name: string, cfg?: NodeConfig): Promise<void> {
  await jj(["workspace", "forget", name], repo, cfg);
}

export async function bookmarkSet(repo: string, name: string, revision: string, cfg?: NodeConfig): Promise<void> {
  await jj(["bookmark", "set", name, "-r", revision, "--allow-backwards"], repo, cfg);
}

export async function bookmarkDelete(repo: string, name: string, cfg?: NodeConfig): Promise<void> {
  await jj(["bookmark", "delete", `exact:${name}`], repo, cfg);
}

/** Forgets `name` here and its remote entries, leaving nothing for a push to delete (decision 19). */
export async function bookmarkForget(repo: string, name: string, cfg?: NodeConfig): Promise<void> {
  await jj(["bookmark", "forget", "--include-remotes", `exact:${name}`], repo, cfg);
}

export async function changeId(workspace: string, cfg?: NodeConfig): Promise<string> {
  return (await jj(["log", "-r", "@", "--no-graph", "-T", "change_id"], workspace, cfg)).trim();
}

export async function remoteAdd(repo: string, name: string, url: string, cfg?: NodeConfig): Promise<void> {
  await jj(["git", "remote", "add", name, url], repo, cfg);
}

/** The repo's git remotes, as `jj git remote list` prints them (`<name> <url>`). */
export async function remoteList(repo: string, cfg?: NodeConfig): Promise<Array<{ name: string; url: string }>> {
  const out = await jj(["git", "remote", "list"], repo, cfg);
  return out.split("\n").filter((line) => line !== "").map((line) => {
    const at = line.indexOf(" ");
    return at < 0 ? { name: line, url: "" } : { name: line.slice(0, at), url: line.slice(at + 1) };
  });
}

/** Fetches `bookmarks` (jj string patterns; every bookmark when empty) from `remote`. */
export async function fetch(repo: string, remote: string, bookmarks: string[], cfg?: NodeConfig): Promise<void> {
  await jj(["git", "fetch", "--remote", remote, ...bookmarks.flatMap((b) => ["--branch", b])], repo, cfg);
}

export async function push(repo: string, remote: string, bookmark: string, cfg?: NodeConfig): Promise<void> {
  // A task bookmark points at its workspace's working copy, which is usually not described yet.
  await jj(["git", "push", "--remote", remote, "--bookmark", `exact:${bookmark}`, "--allow-empty-description"], repo, cfg);
}

/** Tracks `bookmark@remote` (idempotent), so that a push may create or move it there. */
export async function track(repo: string, bookmark: string, remote: string, cfg?: NodeConfig): Promise<void> {
  await jj(["bookmark", "track", `exact:${bookmark}`, "--remote", `exact:${remote}`], repo, cfg);
}

export type Bookmark = { name: string; remote: string | null; changeId: string; conflicted: boolean };

/** One line per present bookmark: name, remote, the change it points at ("" when conflicted), the conflict flag. */
const BOOKMARK_TEMPLATE = 'if(present, name ++ "\\t" ++ remote ++ "\\t" ++ if(normal_target, normal_target.change_id(), "") ++ "\\t" ++ conflict ++ "\\n")';

/**
 * Every local and remote bookmark (not the colocated `git` remote, not a local bookmark that was deleted) with the
 * change it points at; a conflicted bookmark has `changeId` "" and `conflicted` true. A read that never snapshots the
 * working copy (`--ignore-working-copy`): a folder project's replica is the user's own checkout, and a snapshot moves
 * no bookmark to another change.
 */
export async function bookmarkList(repo: string, cfg?: NodeConfig): Promise<Bookmark[]> {
  const out = await jj(["bookmark", "list", "--ignore-working-copy", "--all-remotes", "-T", BOOKMARK_TEMPLATE], repo, cfg);
  const list: Bookmark[] = [];
  for (const line of out.split("\n")) {
    if (line === "") continue;
    const [name = "", remote = "", change = "", conflict = ""] = line.split("\t");
    if (remote === "git") continue;
    list.push({ name, remote: remote === "" ? null : remote, changeId: change, conflicted: conflict === "true" });
  }
  return list;
}
