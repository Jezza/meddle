// A task's lines are rows (`src/pool/rows.ts`), written only by the node holding the task: one per bookmark
// `meddle/task/<id>/<name>` of each of its projects (`writeLineRows`), as its agent works and at every turn end. Every
// node's applier keeps the refs from them: a line held elsewhere is the git ref `refs/remotes/meddle/task/<id>/<name>`,
// which jj shows as `task/<id>/<name>@meddle` (an untracked bookmark of a remote that is not configured) and so treats
// as immutable, with everything below it. A released line goes only through jj (`bookmark forget --include-remotes`):
// a raw git deletion would make jj abandon every commit only that ref kept.
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { NodeConfig } from "../config";
import { bookmarkRefs, bookmarkSet, changeId, changesIn, jj } from "../jj";
import { paths } from "../paths";
import { shortId } from "../pool/ids";
import { listLineRows, writeLineRow, type LineRow } from "../pool/rows";
import { repoKey, serialised } from "../serial";
import { taskGlob, taskNamespace, type TaskManifest } from "../tasks/manifest";
import { containedIn, effectiveHead } from "../tasks/accept";
import { applyProject, catchUp } from "./applier";
import { getProject } from "./project";
import type { ReplicaDeps } from "./replicas";

/** The remote, never configured, whose untracked bookmarks hold the task lines held elsewhere. */
export const LINE_REMOTE = "meddle";

/** Where a node keeps task `taskId`'s lines held elsewhere: `refs/remotes/meddle/task/<taskId>/`. */
export function linePrefix(taskId: string): string {
  return `refs/remotes/${LINE_REMOTE}/task/${taskId}/`;
}

/**
 * Writes the rows of `manifest`'s task, held by this node: for each of its projects, snapshots the task's workspace
 * there and points the project's bookmark `meddle/task/<id>/<name>` at its working-copy change, then writes one row per
 * bookmark under the task's namespace in this node's repo of the project, with this node its holder, at the bookmark's
 * commit. Each row is written at the task's epoch: that of the project's line (1 for a line with no row yet). A row
 * already there as written is left alone; a conflicted bookmark's row keeps its commit (and is still written, or
 * archived). With `archived`, every row says so (a task archived by hand: kept, but out of the view). Then releases
 * each row of the task's in the project whose bookmark is gone (a side line the agent deleted); the project's own line
 * is always kept. When the project's own line moves off work of its own that it neither goes on from nor rewrote (the
 * agent started over, say with `jj new main`: `leftBehind`), that work first gets the side bookmark
 * `meddle/task/<id>/<name>.before-<n>` (`n` the next number free), logged, so it stays a line, archived and kept when
 * the task's work is accepted without it. Without a snapshot of anything but the task's own workspaces.
 *
 * Only the holder writes: a project whose line another node holds (the task moved on, or a rollback took it back from
 * here) is left alone, its workspace, bookmarks and rows untouched, and so is any row another node holds at the task's
 * epoch or above; each such line is logged (`meddle: line: … not written here`). A row another node holds below it (a
 * side line its sender released) is taken at the task's epoch.
 */
export async function writeLineRows(deps: ReplicaDeps, manifest: TaskManifest, options: { archived?: boolean } = {}): Promise<void> {
  const { cfg, db, pool } = deps;
  const self = pool.identity.id;
  const taskId = manifest.id;
  const namespace = taskNamespace(taskId);
  const archived = options.archived ?? false;
  /** The epoch this node writes a project's `rows` at (its line `name`'s), or null when another node holds the line. */
  const heldAt = (rows: Map<string, LineRow>, name: string): number | null => {
    const own = rows.get(name);
    if (own === undefined) return 1;
    return own.holder === self ? own.epoch : null;
  };
  const rowsOf = (projectId: string) => new Map(listLineRows(db, projectId, taskId).map((r) => [r.name, r]));
  const log = deps.log ?? ((line: string) => console.error(line));
  /** Says that line row `r`, held by another node, is not written here. */
  const skip = (r: LineRow) => {
    log(`meddle: line: ${taskId}'s line ${shortId(r.project)}/${r.name} is held by ${shortId(r.holder)} at epoch ${r.epoch}; not written here`);
  };
  for (const p of manifest.projects) {
    const before = rowsOf(p.id);
    if (heldAt(before, p.name) === null) {
      skip(before.get(p.name)!);
      continue;
    }
    // The task's own workspace: meddle's, so snapshotting it is fine.
    const change = await changeId(join(paths(cfg).task(taskId), p.workspace), cfg);
    const bookmarks = await serialised(repoKey(p.replica), async () => {
      await bookmarkSet(p.replica, `${namespace}${p.name}`, change, cfg, { ignoreWorkingCopy: true });
      const list = async () => (await bookmarkRefs(p.replica, taskGlob(taskId), cfg)).filter((b) => b.remote === null);
      const listed = await list();
      // The line moved off work of its own (the agent started over, `jj new main`): that work stays a side line.
      const prev = before.get(p.name);
      const own = listed.find((b) => b.name === `${namespace}${p.name}`);
      if (prev?.holder !== self || prev.commit === null || own === undefined || own.conflicted || own.commitId === "") return listed;
      let left: string | null;
      try {
        left = await leftBehind(cfg, p.replica, prev, own.commitId);
      } catch (err) {
        log(`meddle: line: whether ${taskId}'s line ${shortId(p.id)}/${p.name} left work behind is not known: ${messageOf(err)}`);
        return listed;
      }
      if (left === null) return listed;
      const side = beforeName(p.name, [...listed.map((b) => b.name.slice(namespace.length)), ...before.keys()]);
      await bookmarkSet(p.replica, `${namespace}${side}`, left, cfg, { ignoreWorkingCopy: true });
      log(`meddle: line: ${taskId}'s line ${shortId(p.id)}/${p.name} moved off its work at ${left.slice(0, 12)}; kept as ${side}`);
      return list();
    });
    // Read again after the snapshot, and nothing awaited from here on: a row that came in meanwhile counts.
    const rows = rowsOf(p.id);
    const taskEpoch = heldAt(rows, p.name);
    if (taskEpoch === null) {
      skip(rows.get(p.name)!);
      continue;
    }
    const kept = [p.name];
    for (const r of rows.values()) if (r.holder !== self && r.epoch >= taskEpoch) kept.push(r.name);
    for (const b of bookmarks) {
      const name = b.name.slice(namespace.length);
      // A name git can't hold as one ref component under the namespace is no line.
      if (name === "" || name.includes("/")) continue;
      kept.push(name);
      const row = rows.get(name);
      if (row !== undefined && row.holder !== self && row.epoch >= taskEpoch) {
        skip(row);
        continue;
      }
      // A conflicted bookmark names no one commit: its row keeps the one it had (and a line it never had waits).
      const commit = b.conflicted || b.commitId === "" ? row?.commit ?? null : b.commitId;
      if (commit === null) continue;
      if (row !== undefined && row.holder === self && row.commit === commit && row.archived === archived) continue;
      const epoch = row?.holder === self ? Math.max(row.epoch, taskEpoch) : taskEpoch;
      const base = row?.base ?? (name === p.name ? p.base : []);
      writeLineRow(db, { project: p.id, task: taskId, name, holder: self, epoch, commit, base, archived });
    }
    releaseLineRows(db, taskId, kept, p.id);
  }
}

function messageOf(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim();
}

/** How many generations below a line's new head `leftBehind` looks for a rewrite of the old one. */
const REWRITE_DEPTH = 100;

/**
 * The work a project's own line leaves behind as it moves from row `prev` to commit `next`, or null when it leaves
 * none: `prev`'s effective head (`effectiveHead`), unless that is at or below `next` (the line went on from it) or a
 * base of the line (no work of its own), or `next`'s ancestry holds a rewrite of it. A rewrite (a rebase, an amend, a
 * squash into another commit) is told two ways: a commit of the same change id below `next` (also one rewritten
 * elsewhere, such as in your checkout, and fetched back), or the old head among the evolution of a commit up to
 * `REWRITE_DEPTH` generations below `next` that is not below a base (`jj evolog`, which also follows a squash, where
 * the change id goes away).
 */
async function leftBehind(cfg: NodeConfig, repo: string, prev: LineRow, next: string): Promise<string | null> {
  if (prev.commit === null || prev.commit === next) return null;
  const head = await effectiveHead(cfg, repo, prev.commit);
  if (await containedIn(cfg, repo, head, [next, ...prev.base])) return null;
  const change = (await jj(["log", "--ignore-working-copy", "-r", head, "--no-graph", "-T", "change_id"], repo, cfg)).trim();
  const same = await jj(["log", "--ignore-working-copy", "-r", `change_id(${change}) & ::${next}`, "--no-graph", "-T", "commit_id"], repo, cfg);
  if (same.trim() !== "") return null;
  const own = prev.base.length === 0 ? `ancestors(${next}, ${REWRITE_DEPTH})` : `ancestors(${next}, ${REWRITE_DEPTH}) ~ ::(${prev.base.join(" | ")})`;
  const evolved = await jj(["evolog", "--ignore-working-copy", "-r", own, "--no-graph", "-T", 'commit.commit_id() ++ "\n"'], repo, cfg);
  return evolved.split("\n").includes(head) ? null : head;
}

/** The name of the next side line `<name>.before-<n>` that keeps work a line left behind: `n` one above any in `taken`. */
function beforeName(name: string, taken: Iterable<string>): string {
  const prefix = `${name}.before-`;
  let n = 0;
  for (const t of taken) {
    if (!t.startsWith(prefix)) continue;
    const k = Number(t.slice(prefix.length));
    if (Number.isInteger(k) && k > n) n = k;
  }
  return `${prefix}${n + 1}`;
}

/**
 * Takes task `taskId`'s live line rows as this node's (`selfId`), as they are: each row another node held is written
 * with this node its holder, one epoch up, and each archived one live again; a row already so is left alone. What a
 * node that received the task writes as it activates it, and what a restore here writes. Returns the names written.
 */
export function holdLineRows(db: Database, selfId: string, taskId: string): string[] {
  const written: string[] = [];
  for (const row of listLineRows(db, undefined, taskId)) {
    if (row.commit === null || (row.holder === selfId && !row.archived)) continue;
    const epoch = row.holder === selfId ? row.epoch : row.epoch + 1;
    writeLineRow(db, { project: row.project, task: row.task, name: row.name, holder: selfId, epoch, commit: row.commit, base: row.base, archived: false });
    written.push(row.name);
  }
  return written;
}

/**
 * Takes task `taskId`'s live line rows back as this node's (`selfId`) after its move to another node rolled back, at an
 * epoch above any the target could have written: the target takes the lines one epoch up only as it activates the
 * task (`holdLineRows`), so a row this node held goes two up, and one the target holds (it activated the task, but its
 * answer was lost) one up from the target's. Each row keeps its commit; `archived` says whether the task is archived
 * here again (a restore-move's). Returns the names written.
 */
export function reclaimLineRows(db: Database, selfId: string, taskId: string, archived: boolean): string[] {
  const written: string[] = [];
  for (const row of listLineRows(db, undefined, taskId)) {
    if (row.commit === null) continue;
    const epoch = row.holder === selfId ? row.epoch + 2 : row.epoch + 1;
    writeLineRow(db, { project: row.project, task: row.task, name: row.name, holder: selfId, epoch, commit: row.commit, base: row.base, archived });
    written.push(row.name);
  }
  return written;
}

/**
 * Writes released (`commit` null) every line row of task `taskId` (of project `projectId` only, when given) whose name
 * is not in `keep` and that is not released already, each keeping its holder and epoch. Returns the names released.
 */
export function releaseLineRows(db: Database, taskId: string, keep: string[], projectId?: string): string[] {
  const released: string[] = [];
  for (const row of listLineRows(db, projectId, taskId)) {
    if (row.commit === null || keep.includes(row.name)) continue;
    writeLineRow(db, { project: row.project, task: row.task, name: row.name, holder: row.holder, epoch: row.epoch, commit: null, base: [], archived: row.archived });
    released.push(row.name);
  }
  return released;
}

/** How often `awaitLine` looks again at first; each catch-up that brought no row doubles it, up to the most. */
const AWAIT_LINE_POLL_MS = 100;
const AWAIT_LINE_POLL_MAX_MS = 2000;
/** The most `awaitLine` gives one catch-up with the peers before it looks again. */
const AWAIT_LINE_CATCH_UP_MS = 5000;

/**
 * Task `taskId`'s line `name` of project `projectId` as this node's service repo has it: resolves its row's commit once
 * jj there knows it. Until then it catches up on the project (`catchUp`, while no row has the line) or applies its rows
 * (`applyProject`, which fetches the commit), and rejects `line <t>/<n> is not here yet` after `timeoutMs`.
 */
export async function awaitLine(deps: ReplicaDeps, projectId: string, taskId: string, name: string, timeoutMs: number): Promise<string> {
  const { cfg, db } = deps;
  const deadline = Date.now() + timeoutMs;
  let wait = AWAIT_LINE_POLL_MS;
  for (;;) {
    const row = listLineRows(db, projectId, taskId).find((r) => r.name === name);
    const project = getProject(db, projectId);
    if (row?.commit != null && project !== null) {
      const known = await changesIn(project.replica, `present(${row.commit})`, cfg).catch(() => []);
      if (known.length > 0) return row.commit;
    }
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`line ${taskId}/${name} is not here yet`);
    try {
      if (row?.commit != null) await applyProject(deps, projectId, left);
      else {
        await catchUp(deps, projectId, Math.min(left, AWAIT_LINE_CATCH_UP_MS));
        // Caught up, and still no row: no peer has it yet, so look again less often.
        if (!listLineRows(db, projectId, taskId).some((r) => r.name === name)) wait = Math.min(wait * 2, AWAIT_LINE_POLL_MAX_MS);
      }
    } catch {
      // A service repo still being made, or a peer that did not answer: the next look tells.
    }
    await Bun.sleep(Math.min(wait, Math.max(0, deadline - Date.now())));
  }
}
