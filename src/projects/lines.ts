// A task's line on its project's home: the home holds each of the task's bookmarks `meddle/task/<id>/<name>` as the
// git ref `refs/remotes/meddle/task/<id>/<name>`, which jj shows as `task/<id>/<name>@meddle` (an untracked bookmark
// of a remote that is not configured) and so treats as immutable, with everything below it. The holder writes it (on
// the home by `git update-ref`, elsewhere by a forced push); it goes away only through jj (`releaseLines`): a raw git
// deletion would make jj abandon every commit only that ref kept, the user's own included.
import type { NodeConfig } from "../config";
import { bookmarkRefs, git, gitImport, jj, networkMs } from "../jj";
import { shortId } from "../pool/ids";
import { PeerObject } from "../state/contracts";
import { getTask } from "../store/records";
import { repoKey, serialised } from "../serial";
import { taskNamespace } from "../tasks/manifest";
import { listProjects, type Project } from "./project";
import { meddleUrl, type ReplicaDeps } from "./replicas";

/** The remote, never configured, whose untracked bookmarks hold the task lines on a home. */
export const LINE_REMOTE = "meddle";

/** Where the home keeps task `taskId`'s line: `refs/remotes/meddle/task/<taskId>/`. */
export function linePrefix(taskId: string): string {
  return `refs/remotes/${LINE_REMOTE}/task/${taskId}/`;
}

/** A line's bookmark name on the home (`task/<taskId>/<name>`), split. */
const LINE_BOOKMARK = /^task\/([^/]+)\/(.+)$/;

/**
 * Points task `taskId`'s line `name` at `commit` on the home (`git update-ref`), then imports it, so that jj shows
 * `task/<taskId>/<name>@meddle` and holds the commit and its ancestors immutable. The caller holds `repoKey(homeRepo)`.
 */
export async function writeLine(cfg: NodeConfig, homeRepo: string, taskId: string, name: string, commit: string): Promise<void> {
  await git(["update-ref", `${linePrefix(taskId)}${name}`, commit], homeRepo, cfg);
  await gitImport(homeRepo, cfg);
}

/**
 * The lines the home holds (the `@meddle` bookmarks under `task/`), of task `taskId` or of every task, in jj's order
 * (by name), each with its head commit ("" when conflicted). Imports git's refs first; never snapshots the working
 * copy. The caller holds `repoKey(homeRepo)`.
 */
export async function homeLines(cfg: NodeConfig, homeRepo: string, taskId?: string): Promise<Array<{ taskId: string; name: string; commitId: string }>> {
  const pattern = taskId === undefined ? "glob:task/*" : `glob:task/${taskId}/*`;
  const lines: Array<{ taskId: string; name: string; commitId: string }> = [];
  for (const ref of await bookmarkRefs(homeRepo, pattern, cfg)) {
    if (ref.remote !== LINE_REMOTE) continue;
    const match = LINE_BOOKMARK.exec(ref.name);
    if (match === null) continue;
    lines.push({ taskId: match[1]!, name: match[2]!, commitId: ref.commitId });
  }
  return lines;
}

/**
 * Releases every line of task `taskId` on the home whose name is not in `keep`, through jj
 * (`bookmark forget --include-remotes`, never a git deletion): its commits stay visible and become mutable again,
 * unless another line still holds them. Returns the names released. The caller holds `repoKey(homeRepo)`.
 */
export async function releaseLines(cfg: NodeConfig, homeRepo: string, taskId: string, keep: string[]): Promise<string[]> {
  const released: string[] = [];
  for (const { name } of await homeLines(cfg, homeRepo, taskId)) {
    if (keep.includes(name)) continue;
    await jj(["--ignore-working-copy", "bookmark", "forget", "--include-remotes", `exact:task/${taskId}/${name}`], homeRepo, cfg);
    released.push(name);
  }
  return released;
}

/** The git refs under `prefix` (ending in `/`) in `repo`: each name after the prefix, with its commit. */
async function refsUnder(cfg: NodeConfig, repo: string, prefix: string): Promise<Array<{ name: string; commitId: string }>> {
  // A pattern matches from the start up to a slash: `…/t1` names `…/t1/x`, never `…/t10/x`.
  const out = await git(["for-each-ref", "--format=%(refname)%09%(objectname)", prefix.slice(0, -1)], repo, cfg);
  return out.split("\n").filter(Boolean).map((line) => {
    const [ref = "", commitId = ""] = line.split("\t");
    return { name: ref.slice(prefix.length), commitId };
  });
}

/**
 * Pushes task `taskId`'s bookmarks `meddle/task/<id>/*` of `repo` (a replica of `project` on another node) to the
 * project's home as its line, forced: `+refs/heads/meddle/task/<id>/*:refs/remotes/meddle/task/<id>/*`, under
 * `repoKey(repo)`. No such bookmark is nothing to push. The home imports what it gets when its git server finishes
 * the push.
 */
export async function pushLines(cfg: NodeConfig, repo: string, project: Project, taskId: string): Promise<void> {
  const local = `refs/heads/${taskNamespace(taskId)}`;
  await serialised(repoKey(repo), async () => {
    if ((await refsUnder(cfg, repo, local)).length === 0) return;
    const url = meddleUrl(project.home, { kind: "project", id: project.id });
    await git(["push", "--force", url, `+${local}*:${linePrefix(taskId)}*`], repo, cfg, { timeoutMs: networkMs(cfg) });
  });
}

/**
 * On the home: writes each of task `taskId`'s bookmarks `meddle/task/<id>/*` of `homeRepo` that its line does not have
 * at the same commit to the line (`writeLine`), under `repoKey(homeRepo)`. Never releases a line: a bookmark gone here
 * is given back by `giveBackLines`.
 */
export async function writeLines(cfg: NodeConfig, homeRepo: string, taskId: string): Promise<void> {
  await serialised(repoKey(homeRepo), async () => {
    const lines = new Map((await refsUnder(cfg, homeRepo, linePrefix(taskId))).map((l) => [l.name, l.commitId]));
    for (const { name, commitId } of await refsUnder(cfg, homeRepo, `refs/heads/${taskNamespace(taskId)}`)) {
      if (lines.get(name) !== commitId) await writeLine(cfg, homeRepo, taskId, name, commitId);
    }
  });
}

/**
 * The holder's write of task `taskId`'s line in `project` from its bookmarks in `repo`, this node's repo of the project
 * (Decision 3): on the home (`selfId`), `writeLines`; elsewhere `pushLines`.
 */
export async function holdLines(cfg: NodeConfig, selfId: string, repo: string, project: Project, taskId: string): Promise<void> {
  if (project.home === selfId) await writeLines(cfg, repo, taskId);
  else await pushLines(cfg, repo, project, taskId);
}

/**
 * Releases task `taskId`'s lines on `project`'s home whose name is not in `keep` (`releaseLines`): here when this node
 * is the home, else through the home's `PeerObject.releaseLines`, refused `home <short> is offline` while it cannot
 * be reached. Returns the names released.
 */
export async function releaseOnHome(deps: ReplicaDeps, project: Project, taskId: string, keep: string[]): Promise<string[]> {
  const { cfg, pool } = deps;
  if (project.home === pool.identity.id) return serialised(repoKey(project.replica), () => releaseLines(cfg, project.replica, taskId, keep));
  if (!pool.net.isOnline(project.home)) throw new Error(`home ${shortId(project.home)} is offline`);
  const ref = await pool.peerRef(project.home, PeerObject);
  try {
    if (ref.variant !== "peer") throw new Error(`${shortId(project.home)} did not serve the peer variant of PeerObject`);
    return (await ref.releaseLines({ projectId: project.id, taskId, keep })).released;
  } finally {
    ref.release();
  }
}

/**
 * Gives back what the holder of task `taskId` no longer keeps (Decision 3): any line on `project`'s home (read from the
 * home repo here, or with `git ls-remote` from another node) whose name `repo`, this node's repo of the project, no
 * longer has as a bookmark under the task's namespace is released there (`releaseOnHome`), so its commits are mutable
 * on the home again unless another line still holds them. The agent gives a side line back by deleting its bookmark.
 * The project's own line (`name`) is always kept. Returns the names released.
 */
export async function giveBackLines(deps: ReplicaDeps, repo: string, project: Project, taskId: string, name: string): Promise<string[]> {
  const { cfg, pool } = deps;
  const prefix = linePrefix(taskId);
  const { lines, local } = await serialised(repoKey(repo), async () => {
    const local = (await refsUnder(cfg, repo, `refs/heads/${taskNamespace(taskId)}`)).map((r) => r.name);
    if (project.home === pool.identity.id) return { lines: (await refsUnder(cfg, repo, prefix)).map((r) => r.name), local };
    const url = meddleUrl(project.home, { kind: "project", id: project.id });
    const listed = await git(["ls-remote", url, `${prefix}*`], repo, cfg, { timeoutMs: networkMs(cfg) });
    const lines = listed.split("\n").filter(Boolean).map((line) => line.split("\t")[1] ?? "")
      .filter((ref) => ref.startsWith(prefix)).map((ref) => ref.slice(prefix.length));
    return { lines, local };
  });
  const keep = local.includes(name) ? local : [...local, name];
  if (lines.every((n) => keep.includes(n))) return [];
  return releaseOnHome(deps, project, taskId, keep);
}

/** How long the janitor leaves a line `startAt` wrote alone: the task it is for may still be being created. */
export const STARTING_MS = 60 * 60_000;

/** The lines `startAt` wrote on this node, by `<home repo>\0<task id>`, with when (ms). */
const starting = new Map<string, number>();

/**
 * Notes that `startAt` wrote task `taskId`'s line in `homeRepo` at `at` (ms; now by default): until `STARTING_MS` later,
 * `releaseGoneLines` leaves the task's lines there alone, though no node holds the task yet.
 */
export function noteStarting(homeRepo: string, taskId: string, at = Date.now()): void {
  starting.set(`${homeRepo}\0${taskId}`, at);
}

/** Whether `startAt` wrote task `taskId`'s line in `homeRepo` less than `STARTING_MS` before `now`; forgets older notes. */
function isStarting(homeRepo: string, taskId: string, now: number): boolean {
  for (const [key, at] of starting) if (now - at >= STARTING_MS) starting.delete(key);
  return starting.has(`${homeRepo}\0${taskId}`);
}

/**
 * The home's janitor: for every project homed on this node, releases the whole line of each task in `homeLines` that
 * `whereIs` finds gone from every node (one an offline node may hold keeps its line). A line `startAt` wrote here less
 * than `STARTING_MS` before `now` is left alone (`noteStarting`): its task may still be being created on another node,
 * after the start released `handoff:<projectId>`. Each project's pass runs under `handoff:<projectId>`, so a start
 * running now is not taken for a gone task either. A task whose line could not be released is logged, and the pass goes
 * on. Returns how many tasks it released.
 */
export async function releaseGoneLines(
  deps: ReplicaDeps, log: (line: string) => void = (line) => console.error(line), now = Date.now(),
): Promise<number> {
  const { cfg, db, pool } = deps;
  const released = new Set<string>();
  const where = new Map<string, Awaited<ReturnType<typeof whereIs>>>();
  for (const project of listProjects(db)) {
    if (project.home !== pool.identity.id) continue;
    const repo = project.replica;
    await serialised(`handoff:${project.id}`, async () => {
      const lines = await serialised(repoKey(repo), () => homeLines(cfg, repo));
      for (const taskId of new Set(lines.map((l) => l.taskId))) {
        if (isStarting(repo, taskId, now)) continue;
        try {
          if (!where.has(taskId)) where.set(taskId, await whereIs(deps, taskId));
          if (where.get(taskId) !== "gone") continue;
          await serialised(repoKey(repo), () => releaseLines(cfg, repo, taskId, []));
          released.add(taskId);
        } catch (err) {
          log(`meddle: line janitor: the line of ${taskId} on ${project.name} was not released: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    });
  }
  return released.size;
}

/**
 * Fetches task `taskId`'s line from node `from` into `repo`'s local bookmarks `meddle/task/<id>/*`, pruning the ones
 * `from` does not have, and imports them (mutable there): from the home's line (`refs/remotes/meddle/task/<id>/*`,
 * `source` "home") or from a holder's own bookmarks (`refs/heads/meddle/task/<id>/*`, `source` "holder"). Under
 * `repoKey(repo)`. Returns the bookmarks there now, by name after the namespace.
 */
export async function fetchLines(
  cfg: NodeConfig, repo: string, project: Project, from: string, taskId: string, source: "home" | "holder",
): Promise<Array<{ name: string; commitId: string }>> {
  const local = `refs/heads/${taskNamespace(taskId)}`;
  const src = source === "home" ? linePrefix(taskId) : local;
  return serialised(repoKey(repo), async () => {
    const url = meddleUrl(from, { kind: "project", id: project.id });
    await git(["fetch", "--prune", url, `+${src}*:${local}*`], repo, cfg, { timeoutMs: networkMs(cfg) });
    await gitImport(repo, cfg);
    return refsUnder(cfg, repo, local);
  });
}

/**
 * Where task `taskId` is: on this node or an online member, maybe on an offline member, or gone from them all. A
 * `moved` row (what a task that went on to another node left) holds nothing, here or on a member (`taskHeld`).
 */
export async function whereIs(deps: ReplicaDeps, taskId: string): Promise<"held" | "offline" | "gone"> {
  const { db, pool } = deps;
  const row = getTask(db, taskId);
  if (row !== null && row.state !== "moved") return "held";
  let offline = false;
  for (const member of pool.store.members()) {
    if (member.nodeId === pool.identity.id) continue;
    if (!pool.net.isOnline(member.nodeId)) {
      offline = true;
      continue;
    }
    let ref: Awaited<ReturnType<typeof pool.peerRef<typeof PeerObject>>>;
    try {
      ref = await pool.peerRef(member.nodeId, PeerObject);
    } catch {
      offline = true;
      continue;
    }
    try {
      if (ref.variant !== "peer") {
        offline = true;
        continue;
      }
      let answer: boolean;
      try {
        answer = await ref.taskHeld({ id: taskId });
      } catch {
        offline = true;
        continue;
      }
      if (answer) return "held";
    } finally {
      ref.release();
    }
  }
  return offline ? "offline" : "gone";
}
