// The memory repo of a project follows its `memory` bookmark on every node, around turns (decision 15): before a
// turn the working copy is brought onto `memory` (fetched from the home on other nodes); after a turn what the turn
// wrote is committed, `memory` moves onto it, and other nodes push it to the home. Conflicts stay as jj's markers
// for the next session to tidy. The syncs never throw: failures are logged and the next turn tries again. The syncs of
// one memory repo run one at a time (`serialised`): overlapping ones would leave stray commits beside the history.
// The dashboard writes a memory file on the home (`writeMemory`) in that same line, and refuses rather than guess.
import type { Subscribable } from "@earendil-works/chord";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rm } from "node:fs/promises";
import { join } from "node:path";
import type { NodeConfig } from "../config";
import { bookmarkList, bookmarkSet, fetch, isJjRepo, jj, track } from "../jj";
import { MEMORY_BOOKMARK } from "../memory";
import { paths } from "../paths";
import { shortId } from "../pool/ids";
import { repoKey, serialised } from "../serial";
import { isMemoryPath, readRegular } from "./memory-view";
import { getProject } from "./project";
import { pushBookmark, type ReplicaDeps } from "./replicas";

export { isMemoryPath };

type Log = (line: string) => void;

const defaultLog: Log = (line) => console.error(line);

const listeners = new Set<(projectId: string) => void>();

/**
 * Fires with a project's id after a memory sync here moved its `memory` bookmark or its memory working copy, and after
 * every write of its memory from the dashboard.
 */
export const memoryChanges: Subscribable<string> = {
  subscribe(cb) {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
  },
};

/** Tells `memoryChanges` that the memory of `projectId` changed. */
export function memoryChanged(projectId: string): void {
  for (const cb of [...listeners]) {
    try {
      cb(projectId);
    } catch {
      // A listener's failure is its own; the others still hear of the change.
    }
  }
}

/** `err` as one line. */
function oneLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim();
}

/** The change ids `revset` resolves to in `repo`. */
async function changes(cfg: NodeConfig, repo: string, revset: string): Promise<string[]> {
  const out = await jj(["log", "-r", revset, "--no-graph", "-T", 'change_id ++ "\\n"'], repo, cfg);
  return out.split("\n").filter((line) => line !== "");
}

/** Whether `rev` is `base` or one of its descendants. */
async function descends(cfg: NodeConfig, repo: string, rev: string, base: string): Promise<boolean> {
  return (await changes(cfg, repo, `${rev} & descendants(${base})`)).length > 0;
}

/**
 * Where `memory` and the working copy's parents are, read without a snapshot: what a sync moved when it differs
 * after it.
 */
async function placing(cfg: NodeConfig, repo: string): Promise<string> {
  const template = `commit_id ++ " " ++ self.contained_in('bookmarks(exact:"${MEMORY_BOOKMARK}")') ++ " " ++ self.contained_in("@-") ++ "\\n"`;
  return jj(["--ignore-working-copy", "log", "-r", `bookmarks(exact:"${MEMORY_BOOKMARK}") | @-`, "--no-graph", "-T", template], repo, cfg);
}

/** Runs `fn` on the memory repo of `projectId` and tells `memoryChanges` when it moved `memory` or the working copy. */
async function noting(deps: ReplicaDeps, projectId: string, fn: () => Promise<void>): Promise<void> {
  const repo = paths(deps.cfg).memory(projectId);
  const where = () => placing(deps.cfg, repo).catch(() => null);
  const before = await where();
  await fn();
  if (before !== (await where())) memoryChanged(projectId);
}

/**
 * Settles the local `memory` bookmark. When it is conflicted and `remote` has a clean `memory` (this node's unpushed
 * commits against the home's newer ones), it takes the remote's. When there is no clean remote one (on the home, or
 * the remote's is conflicted too), it takes one of its own targets, preferring one `@` does not descend from, and
 * `note`s the change. Either way the commits it pointed at stay under `@` or on the chosen side, and the caller's
 * rebase of `@` onto `memory` carries the rest across. Returns whether `memory` exists.
 */
async function settleMemory(cfg: NodeConfig, repo: string, remote: string | null, note: (change: string) => void): Promise<boolean> {
  const list = await bookmarkList(repo, cfg);
  const local = list.find((b) => b.name === MEMORY_BOOKMARK && b.remote === null);
  const upstream = remote === null ? undefined : list.find((b) => b.name === MEMORY_BOOKMARK && b.remote === remote);
  if (local === undefined) return false;
  if (!local.conflicted) return true;
  if (upstream !== undefined && !upstream.conflicted) {
    await bookmarkSet(repo, MEMORY_BOOKMARK, upstream.changeId, cfg);
    return true;
  }
  const targets = `bookmarks(exact:"${MEMORY_BOOKMARK}")`;
  const [change] = [...(await changes(cfg, repo, `${targets} ~ ::@`)), ...(await changes(cfg, repo, targets))];
  if (change === undefined) throw new Error("the memory bookmark is conflicted and has no target");
  await bookmarkSet(repo, MEMORY_BOOKMARK, change, cfg);
  note(change);
  return true;
}

/** Brings `@` (and its uncommitted edits) onto `memory` when it is not already a descendant of it. */
async function followMemory(cfg: NodeConfig, repo: string): Promise<void> {
  if (!(await descends(cfg, repo, "@", MEMORY_BOOKMARK))) await jj(["rebase", "-b", "@", "-d", MEMORY_BOOKMARK], repo, cfg);
}

/** Fetches `memory` from the home and tracks it there, so the local bookmark follows the home's. */
async function fetchMemory(cfg: NodeConfig, repo: string, remote: string): Promise<void> {
  await fetch(repo, remote, [`exact:${MEMORY_BOOKMARK}`], cfg);
  await track(repo, `exact:${MEMORY_BOOKMARK}`, remote, cfg);
}

/** Logs that a conflicted `memory` of `projectId` was resolved to `change`. */
function resolved(projectId: string, log: Log): (change: string) => void {
  return (change) => log(`meddle: git: memory of ${shortId(projectId)} had a conflicted bookmark; resolved to ${change}`);
}

/** The project's home and memory repo; throws when this node does not hold both. */
async function memoryOf(deps: ReplicaDeps, projectId: string): Promise<{ home: string; repo: string }> {
  const project = getProject(deps.db, projectId);
  if (project === null) throw new Error("unknown project");
  const repo = paths(deps.cfg).memory(projectId);
  if (!(await isJjRepo(repo))) throw new Error("no memory replica");
  return { home: project.home, repo };
}

/** Runs `fn` after every other sync of the memory repo of `projectId` on this node has finished. */
function oneAtATime<T>(deps: ReplicaDeps, projectId: string, fn: () => Promise<T>): Promise<T> {
  return serialised(`memory-sync\0${paths(deps.cfg).memory(projectId)}`, fn);
}

/**
 * Before a turn of `projectId` on this node (skipped while a task of the project is `live` here): a node that is not
 * the home fetches the home's `memory`; then the working copy is rebased onto `memory` when it is not a descendant.
 * Never rejects: a failure is logged (`meddle: git: memory of <shortId> …`) and the turn goes ahead.
 */
export async function syncMemoryBefore(deps: ReplicaDeps, projectId: string, live: boolean, log: Log = defaultLog): Promise<void> {
  if (live) return;
  await oneAtATime(deps, projectId, () => noting(deps, projectId, () => before(deps, projectId, log)));
}

async function before(deps: ReplicaDeps, projectId: string, log: Log): Promise<void> {
  try {
    const { cfg, pool } = deps;
    const { home, repo } = await memoryOf(deps, projectId);
    let remote: string | null = null;
    if (home !== pool.identity.id) {
      remote = shortId(home);
      if (!pool.net.isOnline(home)) throw new Error(`home ${remote} is offline`);
      await fetchMemory(cfg, repo, remote);
    }
    if (await settleMemory(cfg, repo, remote, resolved(projectId, log))) await followMemory(cfg, repo);
  } catch (err) {
    log(`meddle: git: memory of ${shortId(projectId)} was not synced before the turn: ${oneLine(err)}`);
  }
}

/**
 * After a turn of `projectId` on this node (skipped while another task of the project is `live` here: the next idle
 * turn end commits what both wrote): commits what the turn wrote (`memory from <shortId(self)>`, with `: task <taskId>`
 * when given; into `@-` when that has conflicts, so a tidy-up resolves it), moves
 * `memory` onto it (rebasing first when it does not descend from `memory`), and from a node that is not the home
 * pushes `memory` to the home. Never rejects: a failure is logged (`meddle: git: memory of <shortId> …`) and the
 * next turn end tries again.
 */
export async function syncMemoryAfter(
  deps: ReplicaDeps, projectId: string, live: boolean, log: Log = defaultLog, taskId: string | null = null,
): Promise<void> {
  if (live) return;
  await oneAtATime(deps, projectId, () => noting(deps, projectId, () => after(deps, projectId, log, taskId)));
}

async function after(deps: ReplicaDeps, projectId: string, log: Log, taskId: string | null): Promise<void> {
  try {
    const { cfg, pool } = deps;
    const self = pool.identity.id;
    const { home, repo } = await memoryOf(deps, projectId);
    if ((await jj(["log", "-r", "@", "--no-graph", "-T", "empty"], repo, cfg)).trim() !== "true") {
      // A commit with conflicts is never pushed: what a session wrote on top of one (tidying the markers up) goes into
      // it instead of above it, so the tidied commit replaces the conflicted one and pushes again.
      if ((await changes(cfg, repo, "@- & conflicts()")).length > 0) await jj(["squash", "--use-destination-message"], repo, cfg);
      else await jj(["commit", "-m", `memory from ${shortId(self)}${taskId === null ? "" : `: task ${taskId}`}`], repo, cfg);
    }
    const remote = home === self ? null : shortId(home);
    const online = remote !== null && pool.net.isOnline(home);
    if (online) await fetchMemory(cfg, repo, remote);
    // Settled, rebased onto and moved in one go: a peer's push to the home's `memory` cannot land in between.
    const parent = await serialised(repoKey(repo), async () => {
      const exists = await settleMemory(cfg, repo, remote, resolved(projectId, log));
      if (exists && !(await descends(cfg, repo, "@-", MEMORY_BOOKMARK))) {
        await jj(["rebase", "-b", "@", "-d", MEMORY_BOOKMARK], repo, cfg);
      }
      const [parent] = await changes(cfg, repo, "@- ~ root()");
      if (parent !== undefined) await bookmarkSet(repo, MEMORY_BOOKMARK, parent, cfg);
      return parent;
    });
    if (parent === undefined || remote === null) return;
    if (!online) throw new Error(`home ${remote} is offline`);
    const pushed = (await bookmarkList(repo, cfg)).find((b) => b.name === MEMORY_BOOKMARK && b.remote === remote);
    if (pushed?.changeId === parent) return;
    await pushBookmark(cfg, repo, home, MEMORY_BOOKMARK, parent);
  } catch (err) {
    log(`meddle: git: memory of ${shortId(projectId)} was not synced after the turn: ${oneLine(err)}`);
  }
}

export type MemoryWriteCode = "changed" | "busy" | "path" | "not-home" | "no-repo";

/** Why `writeMemory` refused. */
export class MemoryWriteError extends Error {
  constructor(readonly code: MemoryWriteCode, message: string) {
    super(message);
    this.name = "MemoryWriteError";
  }
}

/**
 * Writes the memory file `path` of `projectId` on its home (deletes it when `text` is null), commits just that file
 * (`memory: dashboard`) and moves `memory` onto it. `base` is the sha256 hex of the file as it was read (null: there
 * was none); when the file on disk is not that any more nothing is written. A working copy behind `memory` (a peer
 * pushed) is brought onto it first, unless a task of the project is `live` here, whose turn owns the working copy.
 * Rejects with a `MemoryWriteError`; resolves with the new change on `memory`.
 */
export async function writeMemory(
  deps: ReplicaDeps, projectId: string, path: string, text: string | null, base: string | null, live: boolean,
): Promise<{ change: string }> {
  const repo = paths(deps.cfg).memory(projectId);
  // The memory sync's lock first, then the repo's (as a turn end takes them), so a peer's push waits for the write.
  const written = await oneAtATime(deps, projectId, () => serialised(repoKey(repo), () => write(deps, projectId, repo, path, text, base, live)));
  memoryChanged(projectId);
  return written;
}

async function write(
  deps: ReplicaDeps, projectId: string, repo: string, path: string, text: string | null, base: string | null, live: boolean,
): Promise<{ change: string }> {
  const { cfg } = deps;
  const project = getProject(deps.db, projectId);
  if (project === null) throw new MemoryWriteError("no-repo", "unknown project");
  if (project.home !== deps.pool.identity.id) throw new MemoryWriteError("not-home", `memory is written on its home ${shortId(project.home)}`);
  if (!isMemoryPath(path)) throw new MemoryWriteError("path", `not a memory file: ${JSON.stringify(path)}`);
  if (!(await isJjRepo(repo))) throw new MemoryWriteError("no-repo", "no memory replica");

  if (await settleMemory(cfg, repo, null, resolved(projectId, defaultLog))) {
    if (!(await descends(cfg, repo, "@", MEMORY_BOOKMARK))) {
      if (live) throw new MemoryWriteError("busy", "a turn of the project is live here and its memory is behind");
      await followMemory(cfg, repo);
    }
  }
  const file = join(repo, path);
  const kind = await lstat(file).then((s) => (s.isFile() ? "file" : "other"), () => "absent");
  if (kind === "other") throw new MemoryWriteError("path", `${path} is not a regular file`);
  const bytes = await readRegular(repo, path);
  const now = bytes === null ? null : createHash("sha256").update(bytes).digest("hex");
  if (now !== base) throw new MemoryWriteError("changed", `${path} changed since it was read`);

  if (text === null) {
    await rm(file, { force: true });
  } else {
    // Never through a symlink: one put here since the check would send the write outside the repo.
    const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644);
    try {
      await handle.writeFile(text);
    } finally {
      await handle.close();
    }
  }
  await jj(["commit", "-m", "memory: dashboard", `root-file:${JSON.stringify(path)}`], repo, cfg);
  const [change] = await changes(cfg, repo, "@-");
  await bookmarkSet(repo, MEMORY_BOOKMARK, change!, cfg);
  return { change: change! };
}
