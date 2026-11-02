// Replicas of projects homed on other nodes: cloned from the home over the pool's git transport, with the home's
// remote named after its shortId; task bookmarks pushed to the home; the parent of a new task (the home's `trunk`).
import { rm } from "node:fs/promises";
import type { Database } from "bun:sqlite";
import { paths, type NodeConfig } from "../config";
import { repoName, type Repo } from "../git/wire";
import { bookmarkList, bookmarkRefs, bookmarkSet, cloneColocated, fetch, gitImport, isJjRepo, jj, JjError, push, remoteAdd, remoteList, track, type BookmarkRef } from "../jj";
import { cloneMemoryReplica } from "../memory";
import { shortId } from "../pool/ids";
import { repoKey, serialised } from "../serial";
import type { PoolRuntime } from "../pool/runtime";
import { PeerObject } from "../state/contracts";
import { taskGlob } from "../tasks/manifest";
import { getProject, registerReplica, type Project } from "./project";

export type ReplicaDeps = { cfg: NodeConfig; db: Database; pool: PoolRuntime };

/** The project a peer reports holding: its id, name and home. */
type ProjectInfo = { id: string; name: string; home: string };

/** The URL of `repo` on node `nodeId`. */
export function meddleUrl(nodeId: string, repo: Repo): string {
  return `meddle://${nodeId}/${repoName(repo)}`;
}

/** Asks each online member's PeerObject about `projectId` until one knows it; null when none does. */
async function findProject(pool: PoolRuntime, projectId: string): Promise<ProjectInfo | null> {
  for (const member of pool.store.members()) {
    if (member.nodeId === pool.identity.id || !pool.net.isOnline(member.nodeId)) continue;
    let ref: Awaited<ReturnType<typeof pool.peerRef<typeof PeerObject>>>;
    try {
      ref = await pool.peerRef(member.nodeId, PeerObject);
    } catch {
      continue;
    }
    try {
      if (ref.variant !== "peer") continue;
      const info = await ref.projectInfo({ id: projectId }).catch(() => null);
      if (info !== null && info.home !== "") return info;
    } finally {
      ref.release();
    }
  }
  return null;
}

/** One `ensureReplica` at a time per project and data dir: a second caller waits for the first. */
const cloning = new Map<string, Promise<Project>>();

/**
 * The project `projectId` on this node. When this node has no working replica of it, clones it and its memory from
 * the home (named by the project row, or else by any online member that holds the project), naming the home's
 * remote `shortId(home)`, and registers the replica. Rejects `home <shortId> is offline` when the home cannot be
 * reached, and `no online node holds project <shortId>` when nobody knows the project.
 */
export async function ensureReplica(deps: ReplicaDeps, projectId: string): Promise<Project> {
  const key = `${deps.cfg.dataDir}\0${projectId}`;
  const running = cloning.get(key);
  if (running !== undefined) return running;
  const work = replicate(deps, projectId).finally(() => cloning.delete(key));
  cloning.set(key, work);
  return work;
}

async function replicate(deps: ReplicaDeps, projectId: string): Promise<Project> {
  const { cfg, db, pool } = deps;
  const row = getProject(db, projectId);
  if (row !== null && (await isJjRepo(row.replica))) return row;
  if (row !== null && row.home === pool.identity.id) throw new Error(`the replica of project ${shortId(projectId)} is missing`);
  const info = row ?? (await findProject(pool, projectId));
  if (info === null) throw new Error(`no online node holds project ${shortId(projectId)}`);
  const home = info.home;
  if (!pool.net.isOnline(home)) throw new Error(`home ${shortId(home)} is offline`);

  const replica = row?.replica ?? paths(cfg).replica(projectId);
  // What a failed clone left behind: this node has no row (or no repo) for it.
  await rm(replica, { recursive: true, force: true });
  await cloneColocated(meddleUrl(home, { kind: "project", id: projectId }), replica, cfg, shortId(home));
  await cloneMemoryReplica(cfg, projectId, home);
  return row ?? registerReplica(db, { id: projectId, name: info.name, home, replica });
}

/**
 * Makes sure `replica` has a remote named `shortId(nodeId)` for `repo` on that node (correcting its url when it
 * names something else); returns the remote's name.
 */
export async function ensureRemote(cfg: NodeConfig, replica: string, nodeId: string, repo: Repo): Promise<string> {
  const name = shortId(nodeId);
  const url = meddleUrl(nodeId, repo);
  const existing = (await remoteList(replica, cfg)).find((r) => r.name === name);
  if (existing === undefined) await remoteAdd(replica, name, url, cfg);
  else if (existing.url !== url) await jj(["git", "remote", "set-url", name, url], replica, cfg);
  return name;
}

/**
 * Whether `name` matches jj glob `glob`, as far as meddle uses globs: `*` is any run of characters (`/` too), `?` one
 * character, anything else itself.
 */
function globMatches(glob: string, name: string): boolean {
  const re = glob.split("").map((c) => (c === "*" ? ".*" : c === "?" ? "." : c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("");
  return new RegExp(`^${re}$`).test(name);
}

/**
 * Fetches the bookmarks `patterns` select (jj string patterns, passed as they are: `exact:<b>` or `glob:<g>`) from
 * node `nodeId`'s remote (`shortId(nodeId)`, which must exist), then checks they arrived: rejects
 * `bookmark <b> not found on <shortId>` for an `exact:` one the node does not have, and, with `requireMatch` (the
 * default), `no bookmark matching <g> on <shortId>` for a `glob:` one that selects nothing there.
 */
export async function fetchBookmarks(
  cfg: NodeConfig, replica: string, nodeId: string, patterns: string[], opts: { requireMatch?: boolean } = {},
): Promise<void> {
  const remote = shortId(nodeId);
  const requireMatch = opts.requireMatch ?? true;
  for (const p of patterns) if (!p.startsWith("exact:") && !p.startsWith("glob:")) throw new Error(`bookmark pattern ${p} is neither exact: nor glob:`);
  await fetch(replica, remote, patterns, cfg);
  const checked = patterns.filter((p) => p.startsWith("exact:") || requireMatch);
  if (checked.length === 0) return;
  const present = (await bookmarkList(replica, cfg)).filter((b) => b.remote === remote).map((b) => b.name);
  for (const p of checked) {
    if (p.startsWith("exact:")) {
      const b = p.slice("exact:".length);
      if (!present.includes(b)) throw new Error(`bookmark ${b} not found on ${remote}`);
    } else {
      const g = p.slice("glob:".length);
      if (!present.some((name) => globMatches(g, name))) throw new Error(`no bookmark matching ${g} on ${remote}`);
    }
  }
}

/**
 * Points `bookmark` at `changeId` and pushes it to the home: fetch it from the home (nothing when the home has none),
 * track `<bookmark>@<shortId(home)>`, set the bookmark (backwards or sideways too), push. jj refuses a push over an
 * untracked or stale remote bookmark, or a new one while the bookmark tracks another remote; this order survives all
 * three. One push at a time per repo (`repoKey`): overlapping ones would clash on git's ref locks.
 */
export async function pushBookmark(cfg: NodeConfig, replica: string, home: string, bookmark: string, changeId: string): Promise<void> {
  const remote = shortId(home);
  await serialised(repoKey(replica), async () => {
    await fetch(replica, remote, [`exact:${bookmark}`], cfg);
    await track(replica, `exact:${bookmark}`, remote, cfg);
    await bookmarkSet(replica, bookmark, changeId, cfg);
    await push(replica, remote, `exact:${bookmark}`, cfg);
  });
}

/**
 * What a failed jj command says, as an Error: its `Error:` line, followed by the updates the remote rejected (when it
 * names them). Anything that is not a jj failure (a time limit) is returned as it is.
 */
function jjFailure(err: unknown): unknown {
  if (!(err instanceof JjError)) return err;
  const lines = err.stderr.split("\n");
  const errorLine = lines.find((l) => l.startsWith("Error: "))?.slice("Error: ".length).trim()
    ?? lines.map((l) => l.trim()).filter(Boolean).at(-1)
    ?? err.message;
  const rejected: string[] = [];
  const from = lines.findIndex((l) => l.includes("rejected the following updates"));
  if (from >= 0) for (const l of lines.slice(from + 1)) {
    if (!l.startsWith("  ")) break;
    rejected.push(l.trim());
  }
  return new Error(rejected.length === 0 ? errorLine : `${errorLine}: ${rejected.join(", ")}`);
}

/**
 * Pushes every bookmark under task `taskId`'s namespace in `replica` to the project's home `home` (spec 21.5; the
 * home never fetches, so this push is the backup), first pointing the task's project bookmark `primary` at its change
 * when given. Under the repo lock:
 * 1. Notes what this node changed since its last push: each local bookmark of the namespace whose commit differs from
 *    its tracked `<name>@<home>` entry, or that tracks no such entry.
 * 2. Fetches the namespace from the home (nothing there is fine: a task's first push) and tracks it there; then notes
 *    `primary` at the commit its change has now (resolved after the fetch, never before it: a caller that did not
 *    set the bookmark first must not pin it to a commit the fetch has since rewritten).
 * 3. Puts back what it noted, by commit id (a commit the fetch hid still resolves by it): this node's changes win,
 *    sideways or backwards too. A bookmark it did not change keeps what the fetch made of it: deleted or moved on the
 *    home, it is deleted or moved here.
 * 4. Restores, at the home's commit, a bookmark the home has that is deleted or conflicted here (deleted here and
 *    moved on the home): the home refuses deletions, and jj refuses to push a conflicted bookmark, so either would
 *    fail every push.
 * 5. Pushes the namespace.
 * Rejects on a failed fetch or push with jj's error line; when the home refuses one bookmark, the ones it accepted
 * have still landed.
 */
export async function pushNamespace(
  cfg: NodeConfig, replica: string, home: string, taskId: string, primary: { name: string; changeId: string } | null,
): Promise<void> {
  const remote = shortId(home);
  const glob = taskGlob(taskId);
  await serialised(repoKey(replica), async () => {
    try {
      const before = await bookmarkRefs(replica, glob, cfg);
      const atHome = (refs: BookmarkRef[], name: string) => refs.find((r) => r.name === name && r.remote === remote);
      const changed = new Map<string, string>();
      for (const b of before) {
        if (b.remote !== null || b.conflicted) continue;
        const h = atHome(before, b.name);
        if (h === undefined || !h.tracked || h.conflicted || h.commitId !== b.commitId) changed.set(b.name, b.commitId);
      }
      await fetchBookmarks(cfg, replica, home, [glob], { requireMatch: false });
      await track(replica, glob, remote, cfg);
      if (primary !== null) changed.set(primary.name, await commitOf(cfg, replica, primary.changeId));
      const after = await bookmarkRefs(replica, glob, cfg);
      const local = new Map(after.filter((b) => b.remote === null).map((b) => [b.name, b]));
      const want = new Map(changed);
      for (const h of after) {
        if (h.remote !== remote || h.conflicted || want.has(h.name)) continue;
        const here = local.get(h.name);
        if (here === undefined || here.conflicted) want.set(h.name, h.commitId);
      }
      for (const [name, commit] of want) {
        const here = local.get(name);
        if (here === undefined || here.conflicted || here.commitId !== commit) {
          await bookmarkSet(replica, name, commit, cfg, { ignoreWorkingCopy: true });
        }
      }
      await push(replica, remote, glob, cfg);
    } catch (err) {
      throw jjFailure(err);
    }
  });
}

/** The commit id change `changeId` resolves to in `repo`, without snapshotting the working copy. */
async function commitOf(cfg: NodeConfig, repo: string, changeId: string): Promise<string> {
  return (await jj(["log", "--ignore-working-copy", "-r", changeId, "--no-graph", "-T", "commit_id"], repo, cfg)).trim();
}

/** The remote bookmarks `replica` knows, with the change each points at ("" and `conflicted` when conflicted). */
export async function remoteHeads(cfg: NodeConfig, replica: string): Promise<Array<{ name: string; remote: string; changeId: string; conflicted: boolean }>> {
  const heads: Array<{ name: string; remote: string; changeId: string; conflicted: boolean }> = [];
  for (const b of await bookmarkList(replica, cfg)) {
    if (b.remote !== null) heads.push({ name: b.name, remote: b.remote, changeId: b.changeId, conflicted: b.conflicted });
  }
  return heads;
}

/**
 * The home's latest trunk-like revision: jj's `trunk()` (a remote's main/master/trunk) or a local `trunk`, `main` or
 * `master` bookmark.
 */
const HOME_TRUNK = 'latest(trunk() ~ root() | bookmarks(exact:"trunk") | bookmarks(exact:"main") | bookmarks(exact:"master"))';

/**
 * On a project's home: points the local `trunk` bookmark at the latest trunk-like revision (`HOME_TRUNK`), so that
 * other nodes, which fetch only `trunk`, start tasks where the home would. Never snapshots the working copy, and adds
 * no operation when `trunk` is already there. Returns that change id, or null (and leaves the bookmarks alone) when
 * nothing resolves.
 */
export async function refreshTrunk(cfg: NodeConfig, replica: string): Promise<string | null> {
  // What git moved (a pull or commit in the checkout, a push from a peer) first, then a read that never snapshots the
  // working copy: a folder project's replica is the user's own checkout.
  await gitImport(replica, cfg);
  const resolve = async (revset: string) =>
    (await jj(["log", "--ignore-working-copy", "-r", revset, "--no-graph", "-T", 'change_id ++ "\\n"'], replica, cfg)).split("\n").filter(Boolean);
  const [change] = await resolve(HOME_TRUNK);
  if (change === undefined) return null;
  // Set only when it moves, and then without a snapshot either: a peer's every fetch runs this.
  const current = await resolve('bookmarks(exact:"trunk")');
  if (current.length !== 1 || current[0] !== change) await bookmarkSet(replica, "trunk", change, cfg, { ignoreWorkingCopy: true });
  return change;
}

/**
 * The revision a new task of `project` starts from: on the home, the change `refreshTrunk` resolves (`root()` when
 * nothing does); elsewhere `trunk@<shortId(home)>` after fetching it (`root()` when the home has no `trunk`).
 * Rejects `home <shortId> is offline` on another node while the home cannot be reached.
 */
export async function trunkFor(deps: ReplicaDeps, project: Project): Promise<string> {
  const { cfg, pool } = deps;
  if (project.home === pool.identity.id) return (await refreshTrunk(cfg, project.replica)) ?? "root()";
  const remote = shortId(project.home);
  if (!pool.net.isOnline(project.home)) throw new Error(`home ${remote} is offline`);
  try {
    await fetchBookmarks(cfg, project.replica, project.home, ["exact:trunk"]);
  } catch (err) {
    if (err instanceof Error && err.message === `bookmark trunk not found on ${remote}`) return "root()";
    throw err;
  }
  return `trunk@${remote}`;
}
