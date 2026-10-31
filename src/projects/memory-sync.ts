// The memory repo of a project follows its `memory` bookmark on every node, around turns (decision 15): before a
// turn the working copy is brought onto `memory` (fetched from the home on other nodes); after a turn what the turn
// wrote is committed, `memory` moves onto it, and other nodes push it to the home. Conflicts stay as jj's markers
// for the next session to tidy. Nothing here throws: failures are logged and the next turn tries again.
import type { NodeConfig } from "../config";
import { bookmarkList, bookmarkSet, fetch, isJjRepo, jj, track } from "../jj";
import { MEMORY_BOOKMARK } from "../memory";
import { paths } from "../paths";
import { shortId } from "../pool/ids";
import { getProject } from "./project";
import { pushBookmark, type ReplicaDeps } from "./replicas";

type Log = (line: string) => void;

const defaultLog: Log = (line) => console.error(line);

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
 * Settles the local `memory` bookmark: when it is conflicted (this node's unpushed commits against the home's newer
 * ones) and `remote` has a `memory`, it takes the remote's; the commits it pointed at stay under `@`, which the
 * caller rebases. Returns whether `memory` exists (and is not conflicted).
 */
async function settleMemory(cfg: NodeConfig, repo: string, remote: string | null): Promise<boolean> {
  const list = await bookmarkList(repo, cfg);
  const local = list.find((b) => b.name === MEMORY_BOOKMARK && b.remote === null);
  const upstream = remote === null ? undefined : list.find((b) => b.name === MEMORY_BOOKMARK && b.remote === remote);
  if (local === undefined) return false;
  if (!local.conflicted) return true;
  if (upstream === undefined || upstream.conflicted) throw new Error("the memory bookmark is conflicted");
  await bookmarkSet(repo, MEMORY_BOOKMARK, upstream.changeId, cfg);
  return true;
}

/** Brings `@` (and its uncommitted edits) onto `memory` when it is not already a descendant of it. */
async function followMemory(cfg: NodeConfig, repo: string): Promise<void> {
  if (!(await descends(cfg, repo, "@", MEMORY_BOOKMARK))) await jj(["rebase", "-b", "@", "-d", MEMORY_BOOKMARK], repo, cfg);
}

/** Fetches `memory` from the home and tracks it there, so the local bookmark follows the home's. */
async function fetchMemory(cfg: NodeConfig, repo: string, remote: string): Promise<void> {
  await fetch(repo, remote, [`exact:${MEMORY_BOOKMARK}`], cfg);
  await track(repo, MEMORY_BOOKMARK, remote, cfg);
}

/** The project's home and memory repo; throws when this node does not hold both. */
async function memoryOf(deps: ReplicaDeps, projectId: string): Promise<{ home: string; repo: string }> {
  const project = getProject(deps.db, projectId);
  if (project === null) throw new Error("unknown project");
  const repo = paths(deps.cfg).memory(projectId);
  if (!(await isJjRepo(repo))) throw new Error("no memory replica");
  return { home: project.home, repo };
}

/**
 * Before a turn of `projectId` on this node (skipped while a task of the project is `live` here): a node that is not
 * the home fetches the home's `memory`; then the working copy is rebased onto `memory` when it is not a descendant.
 * Never rejects: a failure is logged (`meddle: git: memory of <shortId> …`) and the turn goes ahead.
 */
export async function syncMemoryBefore(deps: ReplicaDeps, projectId: string, live: boolean, log: Log = defaultLog): Promise<void> {
  if (live) return;
  try {
    const { cfg, pool } = deps;
    const { home, repo } = await memoryOf(deps, projectId);
    let remote: string | null = null;
    if (home !== pool.identity.id) {
      remote = shortId(home);
      if (!pool.net.isOnline(home)) throw new Error(`home ${remote} is offline`);
      await fetchMemory(cfg, repo, remote);
    }
    if (await settleMemory(cfg, repo, remote)) await followMemory(cfg, repo);
  } catch (err) {
    log(`meddle: git: memory of ${shortId(projectId)} was not synced before the turn: ${oneLine(err)}`);
  }
}

/**
 * After a turn of `projectId` on this node: commits what the turn wrote (`memory from <shortId(self)>`), moves
 * `memory` onto it (rebasing first when it does not descend from `memory`), and from a node that is not the home
 * pushes `memory` to the home. Never rejects: a failure is logged (`meddle: git: memory of <shortId> …`) and the
 * next turn end tries again.
 */
export async function syncMemoryAfter(deps: ReplicaDeps, projectId: string, log: Log = defaultLog): Promise<void> {
  try {
    const { cfg, pool } = deps;
    const self = pool.identity.id;
    const { home, repo } = await memoryOf(deps, projectId);
    if ((await jj(["log", "-r", "@", "--no-graph", "-T", "empty"], repo, cfg)).trim() !== "true") {
      await jj(["commit", "-m", `memory from ${shortId(self)}`], repo, cfg);
    }
    const remote = home === self ? null : shortId(home);
    const online = remote !== null && pool.net.isOnline(home);
    if (online) await fetchMemory(cfg, repo, remote);
    const exists = await settleMemory(cfg, repo, remote);
    if (exists && !(await descends(cfg, repo, "@-", MEMORY_BOOKMARK))) {
      await jj(["rebase", "-b", "@", "-d", MEMORY_BOOKMARK], repo, cfg);
    }
    const [parent] = await changes(cfg, repo, "@- ~ root()");
    if (parent === undefined) return;
    await bookmarkSet(repo, MEMORY_BOOKMARK, parent, cfg);
    if (remote === null) return;
    if (!online) throw new Error(`home ${remote} is offline`);
    const pushed = (await bookmarkList(repo, cfg)).find((b) => b.name === MEMORY_BOOKMARK && b.remote === remote);
    if (pushed?.changeId === parent) return;
    await pushBookmark(cfg, repo, home, MEMORY_BOOKMARK, parent);
  } catch (err) {
    log(`meddle: git: memory of ${shortId(projectId)} was not synced after the turn: ${oneLine(err)}`);
  }
}
