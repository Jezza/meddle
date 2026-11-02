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
 * first on `PATH`, `MEDDLE_GIT_SOCKET` naming this node's git socket, and the pool's settings (`cfg.poolEnv`: the
 * jj identity and `env.*`, never a reserved name) on top.
 */
export function jjEnv(cfg: NodeConfig): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined) env[name] = value;
  const p = paths(cfg);
  env.PATH = env.PATH ? `${p.bin}${delimiter}${env.PATH}` : p.bin;
  env.MEDDLE_GIT_SOCKET = p.gitSocket;
  Object.assign(env, cfg.poolEnv);
  return env;
}

/** What a jj command that talks to a peer may take when no config says otherwise. */
const NETWORK_TIMEOUT_MS = 120_000;

/** The time limit of a jj command that talks to a peer: the config's, or the default. */
function networkMs(cfg?: NodeConfig): number {
  return cfg?.jjNetworkTimeoutMs ?? NETWORK_TIMEOUT_MS;
}

export type JjOptions = {
  /**
   * Kills the command (with the git and remote-helper processes it started) and rejects
   * `jj <args> timed out after <ms> ms` when it has not exited by then: a peer that never answers must not hold a
   * repo's lock for good.
   */
  timeoutMs?: number;
};

/** Runs jj in `cwd`; with `cfg`, in `jjEnv(cfg)` so that `meddle://` remotes work. Rejects a `JjError` on failure. */
export async function jj(args: string[], cwd: string, cfg?: NodeConfig, options: JjOptions = {}): Promise<string> {
  const { timeoutMs } = options;
  const proc = Bun.spawn(["jj", "--no-pager", "--color", "never", ...args], {
    cwd,
    env: cfg === undefined ? process.env : jjEnv(cfg),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    // Its own process group, so a timeout kills git and the remote helper with it.
    detached: timeoutMs !== undefined,
  });
  const finished = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = timeoutMs === undefined
    ? null
    : new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        try {
          process.kill(-proc.pid, "SIGKILL");
        } catch {
          proc.kill("SIGKILL");
        }
        reject(new Error(`jj ${args.join(" ")} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
    });
  // Once timed out, the outputs end whenever the killed processes' pipes close; nobody waits for them.
  finished.catch(() => {});
  let stdout: string, stderr: string, code: number;
  try {
    [stdout, stderr, code] = await (limit === null ? finished : Promise.race([finished, limit]));
  } finally {
    clearTimeout(timer);
  }
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

/** A clone moves a whole repo once, so it may take `CLONE_TIMEOUT_FACTOR` times the fetch/push limit. */
export const CLONE_TIMEOUT_FACTOR = 10;

/**
 * Clones `url` into `dir` as a colocated repo whose remote is named `remote`; limited to
 * `CLONE_TIMEOUT_FACTOR * cfg.jjNetworkTimeoutMs` (20 minutes by default), whether `url` is a peer or an upstream.
 */
export async function cloneColocated(url: string, dir: string, cfg?: NodeConfig, remote = "origin"): Promise<void> {
  const parent = dirname(dir);
  await mkdir(parent, { recursive: true });
  await jj(["git", "clone", "--colocate", "--remote", remote, url, dir], parent, cfg, {
    timeoutMs: networkMs(cfg) * CLONE_TIMEOUT_FACTOR,
  });
}

export async function workspaceAdd(repo: string, name: string, path: string, revision: string, cfg?: NodeConfig): Promise<void> {
  await jj(["workspace", "add", "--colocate", "--name", name, "-r", revision, path], repo, cfg);
}

export async function workspaceForget(repo: string, name: string, cfg?: NodeConfig): Promise<void> {
  await jj(["workspace", "forget", name], repo, cfg);
}

/**
 * Points bookmark `name` at `revision` (backwards or sideways too). With `ignoreWorkingCopy`, without snapshotting the
 * working copy first (the ref is still exported to git): for a repo that is the user's own checkout.
 */
export async function bookmarkSet(
  repo: string, name: string, revision: string, cfg?: NodeConfig, options: { ignoreWorkingCopy?: boolean } = {},
): Promise<void> {
  const args = ["bookmark", "set", name, "-r", revision, "--allow-backwards"];
  await jj(options.ignoreWorkingCopy === true ? ["--ignore-working-copy", ...args] : args, repo, cfg);
}

export async function bookmarkDelete(repo: string, name: string, cfg?: NodeConfig): Promise<void> {
  await jj(["bookmark", "delete", `exact:${name}`], repo, cfg);
}

/**
 * Forgets the bookmarks `pattern` (a jj string pattern, `exact:` or `glob:`) selects here and their remote entries,
 * leaving nothing for a push to delete (decision 19). No match is no error.
 */
export async function bookmarkForget(repo: string, pattern: string, cfg?: NodeConfig): Promise<void> {
  await jj(["bookmark", "forget", "--include-remotes", pattern], repo, cfg);
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

/** Fetches `bookmarks` (jj string patterns; every bookmark when empty) from `remote`; limited to `cfg.jjNetworkTimeoutMs`. */
export async function fetch(repo: string, remote: string, bookmarks: string[], cfg?: NodeConfig): Promise<void> {
  await jj(["git", "fetch", "--remote", remote, ...bookmarks.flatMap((b) => ["--branch", b])], repo, cfg, { timeoutMs: networkMs(cfg) });
}

/**
 * Pushes the bookmarks `pattern` (a jj string pattern, `exact:` or `glob:`) selects to `remote`: the ones tracking it,
 * and a local one with no entry there yet, which the push creates there and tracks (jj 0.45). Limited to
 * `cfg.jjNetworkTimeoutMs`. Nothing to push is no error; when the remote refuses one bookmark, the ones it accepted
 * still land and this rejects; one conflicted bookmark among them fails the whole push.
 */
export async function push(repo: string, remote: string, pattern: string, cfg?: NodeConfig): Promise<void> {
  // A task bookmark points at its workspace's working copy, which is usually not described yet.
  await jj(["git", "push", "--remote", remote, "--bookmark", pattern, "--allow-empty-description"], repo, cfg, { timeoutMs: networkMs(cfg) });
}

/**
 * Tracks `<b>@remote` for every bookmark `b` that `pattern` (a jj string pattern, `exact:` or `glob:`) selects
 * (idempotent; no match is no error), so that a push may create or move it there.
 */
export async function track(repo: string, pattern: string, remote: string, cfg?: NodeConfig): Promise<void> {
  // `<glob>@<remote>` does not parse: the remote goes in its own option.
  await jj(["bookmark", "track", pattern, "--remote", `exact:${remote}`], repo, cfg);
}

export type Bookmark = { name: string; remote: string | null; changeId: string; conflicted: boolean };

/** A bookmark entry by commit: local (`remote` null) or a remote's, its commit ("" when conflicted), tracked or not. */
export type BookmarkRef = { name: string; remote: string | null; commitId: string; conflicted: boolean; tracked: boolean };

const REF_TEMPLATE = 'if(present, name ++ "\\t" ++ remote ++ "\\t" ++ if(normal_target, normal_target.commit_id(), "") ++ "\\t" ++ conflict ++ "\\t" ++ tracked ++ "\\n")';

/**
 * The present local and remote entries (not the colocated `git` remote) of the bookmarks `pattern` selects, by commit
 * id: a commit that an operation hid still resolves by its id, where its change id may not. Imports git's refs first
 * and never snapshots the working copy, like `bookmarkList`.
 */
export async function bookmarkRefs(repo: string, pattern: string, cfg?: NodeConfig): Promise<BookmarkRef[]> {
  await gitImport(repo, cfg);
  const out = await jj(["bookmark", "list", "--ignore-working-copy", "--all-remotes", "-T", REF_TEMPLATE, pattern], repo, cfg);
  const refs: BookmarkRef[] = [];
  for (const line of out.split("\n")) {
    if (line === "") continue;
    const [name = "", remote = "", commit = "", conflict = "", tracked = ""] = line.split("\t");
    if (remote === "git") continue;
    refs.push({ name, remote: remote === "" ? null : remote, commitId: commit, conflicted: conflict === "true", tracked: tracked === "true" });
  }
  return refs;
}

/** One line per present bookmark: name, remote, the change it points at ("" when conflicted), the conflict flag. */
const BOOKMARK_TEMPLATE = 'if(present, name ++ "\\t" ++ remote ++ "\\t" ++ if(normal_target, normal_target.change_id(), "") ++ "\\t" ++ conflict ++ "\\n")';

/**
 * Brings a colocated repo's git refs into jj without snapshotting the working copy: what peers pushed into its `.git`
 * and what the user did with git. jj imports them by itself only in a command that snapshots; a read run with
 * `--ignore-working-copy` runs this first. Adds no operation when nothing changed.
 */
export async function gitImport(repo: string, cfg?: NodeConfig): Promise<void> {
  // Run after a peer's push, as that push's last step: limited like the push itself.
  await jj(["--ignore-working-copy", "git", "import"], repo, cfg, { timeoutMs: networkMs(cfg) });
}

/**
 * Every local and remote bookmark (not the colocated `git` remote, not a local bookmark that was deleted) with the
 * change it points at; a conflicted bookmark has `changeId` "" and `conflicted` true. The git refs are imported first
 * (`gitImport`), then read without snapshotting the working copy: a folder project's replica is the user's own
 * checkout, and a snapshot moves no bookmark to another change.
 */
export async function bookmarkList(repo: string, cfg?: NodeConfig): Promise<Bookmark[]> {
  await gitImport(repo, cfg);
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
