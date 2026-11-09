// Rows: where every line and branch points, carried in pool sync and relayed by every node. Each row has one writer,
// who numbers its writes with `seq`: a write uses one above the highest seq seen for its key, so a node that lost its
// data but kept its id never writes a row that loses to its own older one.
// - A line row, keyed (project, task, name), is written by the task's holder; the greater (epoch, seq) wins.
// - A branch row, keyed (project, branch, node), is written by that node; the greater seq wins.
// Equal on those, the greater content wins, so that every node settles on the same row.
import type { Database } from "bun:sqlite";
import type { Subscribable } from "@earendil-works/chord";
import { COMMIT_ID, SAFE_ID } from "../tasks/provision";

/** A branch row, named by its writer and seq: what a branch row's `drops` list. */
export type RowRef = { node: string; seq: number };

/** Where line `name` of task `task` points: `commit` null is released; `base` are its base commits. */
export type LineRow = {
  project: string; task: string; name: string; holder: string; epoch: number; seq: number;
  commit: string | null; base: string[]; archived: boolean;
};

/** Where node `node` puts branch `branch`: `commit` null is deleted; `drops` are the rows it replaced. */
export type BranchRow = { project: string; branch: string; node: string; seq: number; commit: string | null; drops: RowRef[] };

type LineRecord = {
  project: string; task: string; name: string; holder: string; epoch: number; seq: number; commit_id: string | null;
  base: string; archived: number; seen_seq: number;
};

type BranchRecord = { project: string; branch: string; node: string; seq: number; commit_id: string | null; drops: string };

const listeners = new Set<(project: string) => void>();

/** Fires with a project's id after a write or a merge changed one of its rows on this node. */
export const rowChanges: Subscribable<string> = {
  subscribe(cb) {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
  },
};

/** A Subscribable of `T` and the call that tells its listeners, each failure of one its own. */
function topic<T>(): { subscribable: Subscribable<T>; tell(value: T): void } {
  const subscribers = new Set<(value: T) => void>();
  return {
    subscribable: {
      subscribe(cb) {
        subscribers.add(cb);
        return () => { subscribers.delete(cb); };
      },
    },
    tell(value) {
      for (const cb of [...subscribers]) {
        try {
          cb(value);
        } catch {
          // A listener's failure is its own; the others still hear of the change.
        }
      }
    },
  };
}

const branchTopic = topic<string>();
const lineTopic = topic<{ project: string; task: string }>();

/** Fires with a project's id after a write or a merge changed one of its branch rows on this node (and `rowChanges`). */
export const branchChanges: Subscribable<string> = branchTopic.subscribable;

/** Fires with a line row's project and task after a write or a merge changed it on this node (and `rowChanges`). */
export const lineChanges: Subscribable<{ project: string; task: string }> = lineTopic.subscribable;

function changed(projects: Iterable<string>): void {
  for (const project of projects) {
    for (const cb of [...listeners]) {
      try {
        cb(project);
      } catch {
        // A listener's failure is its own; the others still hear of the change.
      }
    }
  }
}

/** Tells `rowChanges` and `lineChanges` of the line rows changed, given as `[project, task]` keys. */
function linesChanged(keys: Iterable<string>): void {
  const pairs = [...keys].map((k) => JSON.parse(k) as [string, string]);
  changed(new Set(pairs.map(([project]) => project)));
  for (const [project, task] of pairs) lineTopic.tell({ project, task });
}

/** Tells `rowChanges` and `branchChanges` of the projects whose branch rows changed. */
function branchesChanged(projects: Iterable<string>): void {
  const all = [...projects];
  changed(all);
  for (const project of all) branchTopic.tell(project);
}

/** A name `git check-ref-format --branch` accepts (without expanding `@{-n}`, which is refused). */
function isBranchName(name: string): boolean {
  if (name === "" || name.startsWith("-") || name === "HEAD" || name.endsWith(".")) return false;
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name) || name.includes("..") || name.includes("@{")) return false;
  return name.split("/").every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".lock"));
}

function isCommit(commit: unknown): commit is string {
  return typeof commit === "string" && COMMIT_ID.test(commit);
}

/** A peer's line row as this node stores it, or null when no node would write it. */
function acceptLine(r: LineRow): LineRow | null {
  const ok = typeof r.project === "string"
    && typeof r.task === "string" && SAFE_ID.test(r.task)
    && typeof r.name === "string"
    && typeof r.holder === "string"
    && Number.isSafeInteger(r.epoch) && Number.isSafeInteger(r.seq)
    && (r.commit === null || isCommit(r.commit))
    && Array.isArray(r.base) && r.base.every(isCommit)
    && typeof r.archived === "boolean";
  if (!ok) return null;
  return {
    project: r.project, task: r.task, name: r.name, holder: r.holder, epoch: r.epoch, seq: r.seq, commit: r.commit,
    base: [...r.base], archived: r.archived,
  };
}

/** A peer's branch row as this node stores it, or null when no node would write it. */
function acceptBranch(r: BranchRow): BranchRow | null {
  const ok = typeof r.project === "string"
    && typeof r.branch === "string" && isBranchName(r.branch) && !r.branch.startsWith("meddle/")
    && typeof r.node === "string"
    && Number.isSafeInteger(r.seq)
    && (r.commit === null || isCommit(r.commit))
    && Array.isArray(r.drops)
    && r.drops.every((d) => typeof d === "object" && d !== null && typeof d.node === "string" && Number.isSafeInteger(d.seq));
  if (!ok) return null;
  return {
    project: r.project, branch: r.branch, node: r.node, seq: r.seq, commit: r.commit,
    drops: r.drops.map((d) => ({ node: d.node, seq: d.seq })),
  };
}

function lineOf(r: LineRecord): LineRow {
  return {
    project: r.project, task: r.task, name: r.name, holder: r.holder, epoch: r.epoch, seq: r.seq, commit: r.commit_id,
    base: JSON.parse(r.base) as string[], archived: r.archived !== 0,
  };
}

function branchOf(r: BranchRecord): BranchRow {
  return { project: r.project, branch: r.branch, node: r.node, seq: r.seq, commit: r.commit_id, drops: JSON.parse(r.drops) as RowRef[] };
}

function lineRecord(db: Database, project: string, task: string, name: string): LineRecord | null {
  return db.query<LineRecord, [string, string, string]>("SELECT * FROM line_rows WHERE project = ? AND task = ? AND name = ?")
    .get(project, task, name);
}

function branchRecord(db: Database, project: string, branch: string, node: string): BranchRecord | null {
  return db.query<BranchRecord, [string, string, string]>("SELECT * FROM branch_rows WHERE project = ? AND branch = ? AND node = ?")
    .get(project, branch, node);
}

function putLine(db: Database, r: LineRow, seenSeq: number): void {
  db.query(
    `INSERT INTO line_rows (project, task, name, holder, epoch, seq, commit_id, base, archived, seen_seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (project, task, name) DO UPDATE SET holder = excluded.holder, epoch = excluded.epoch,
       seq = excluded.seq, commit_id = excluded.commit_id, base = excluded.base, archived = excluded.archived,
       seen_seq = excluded.seen_seq`,
  ).run(r.project, r.task, r.name, r.holder, r.epoch, r.seq, r.commit, JSON.stringify(r.base), r.archived ? 1 : 0, seenSeq);
}

function putBranch(db: Database, r: BranchRow): void {
  db.query(
    `INSERT INTO branch_rows (project, branch, node, seq, commit_id, drops) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (project, branch, node) DO UPDATE SET seq = excluded.seq, commit_id = excluded.commit_id,
       drops = excluded.drops`,
  ).run(r.project, r.branch, r.node, r.seq, r.commit, JSON.stringify(r.drops));
}

/** Everything a line row carries but its key, epoch and seq, as one comparable string. */
function lineContent(r: LineRow): string {
  return JSON.stringify([r.holder, r.commit, r.base, r.archived]);
}

/** Everything a branch row carries but its key and seq, as one comparable string. */
function branchContent(r: BranchRow): string {
  return JSON.stringify([r.commit, r.drops]);
}

/** Whether line row `r` wins over `local`, of the same key: the greater (epoch, seq), then the greater content. */
function lineWins(r: LineRow, local: LineRow): boolean {
  if (r.epoch !== local.epoch) return r.epoch > local.epoch;
  if (r.seq !== local.seq) return r.seq > local.seq;
  return lineContent(r) > lineContent(local);
}

/** Whether branch row `r` wins over `local`, of the same key: the greater seq, then the greater content. */
function branchWins(r: BranchRow, local: BranchRow): boolean {
  if (r.seq !== local.seq) return r.seq > local.seq;
  return branchContent(r) > branchContent(local);
}

/**
 * Merges a peer's line rows: per (project, task, name), the greater (epoch, seq) wins, then the greater content.
 * `changed` are the projects whose rows changed; `rejected` counts the rows dropped (a task id failing `SAFE_ID`, a
 * commit or base that is not 40 or 64 hex characters, an epoch or seq that is not an integer, a malformed field).
 */
export function mergeLineRows(db: Database, rows: readonly LineRow[]): { changed: string[]; rejected: number } {
  const projects = new Set<string>();
  const keys = new Set<string>();
  let rejected = 0;
  db.transaction(() => {
    for (const row of rows) {
      const r = acceptLine(row);
      if (r === null) {
        rejected++;
        continue;
      }
      const local = lineRecord(db, r.project, r.task, r.name);
      if (local === null || lineWins(r, lineOf(local))) {
        putLine(db, r, Math.max(r.seq, local?.seen_seq ?? r.seq));
        projects.add(r.project);
        keys.add(JSON.stringify([r.project, r.task]));
      } else if (r.seq > local.seen_seq) {
        // A losing row's seq is still seen: the line's next write goes above it.
        db.query("UPDATE line_rows SET seen_seq = ? WHERE project = ? AND task = ? AND name = ?").run(r.seq, r.project, r.task, r.name);
      }
    }
  }).immediate();
  linesChanged(keys);
  return { changed: [...projects], rejected };
}

/**
 * Merges a peer's branch rows: per (project, branch, node), the greater seq wins, then the greater content.
 * `changed` are the projects whose rows changed; `rejected` counts the rows dropped (a branch name failing
 * `git check-ref-format --branch` or under `meddle/`, a commit that is not 40 or 64 hex characters, a seq or a drop's
 * seq that is not an integer, a malformed field).
 */
export function mergeBranchRows(db: Database, rows: readonly BranchRow[]): { changed: string[]; rejected: number } {
  const projects = new Set<string>();
  let rejected = 0;
  db.transaction(() => {
    for (const row of rows) {
      const r = acceptBranch(row);
      if (r === null) {
        rejected++;
        continue;
      }
      const local = branchRecord(db, r.project, r.branch, r.node);
      if (local !== null && !branchWins(r, branchOf(local))) continue;
      putBranch(db, r);
      projects.add(r.project);
    }
  }).immediate();
  branchesChanged(projects);
  return { changed: [...projects], rejected };
}

/** The line rows, of one project and one task of it when given, by project, task and name. */
export function listLineRows(db: Database, project?: string, task?: string): LineRow[] {
  const where: string[] = [];
  const args: string[] = [];
  if (project !== undefined) {
    where.push("project = ?");
    args.push(project);
  }
  if (task !== undefined) {
    where.push("task = ?");
    args.push(task);
  }
  const clause = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`;
  return db.query<LineRecord, string[]>(`SELECT * FROM line_rows ${clause} ORDER BY project, task, name`).all(...args).map(lineOf);
}

/** The branch rows of a project, of one branch when given, by branch and node. */
export function listBranchRows(db: Database, project: string, branch?: string): BranchRow[] {
  const rows = branch === undefined
    ? db.query<BranchRecord, [string]>("SELECT * FROM branch_rows WHERE project = ? ORDER BY branch, node").all(project)
    : db.query<BranchRecord, [string, string]>("SELECT * FROM branch_rows WHERE project = ? AND branch = ? ORDER BY node").all(project, branch);
  return rows.map(branchOf);
}

/** Every branch row of every project, by project, branch and node: what pool sync carries. */
export function allBranchRows(db: Database): BranchRow[] {
  return db.query<BranchRecord, []>("SELECT * FROM branch_rows ORDER BY project, branch, node").all().map(branchOf);
}

/** Writes a line row (this node being its holder) at one above the highest seq seen for the line. */
export function writeLineRow(db: Database, row: Omit<LineRow, "seq">): LineRow {
  const written = db.transaction(() => {
    const local = lineRecord(db, row.project, row.task, row.name);
    // seen_seq is never below the stored row's seq.
    const r: LineRow = {
      project: row.project, task: row.task, name: row.name, holder: row.holder, epoch: row.epoch,
      seq: (local?.seen_seq ?? 0) + 1, commit: row.commit, base: [...row.base], archived: row.archived,
    };
    putLine(db, r, r.seq);
    return r;
  }).immediate();
  linesChanged([JSON.stringify([written.project, written.task])]);
  return written;
}

/** Writes this node's row of a branch at one above the highest seq seen for it. */
export function writeBranchRow(db: Database, selfId: string, row: Omit<BranchRow, "seq" | "node">): BranchRow {
  const written = db.transaction(() => {
    const local = branchRecord(db, row.project, row.branch, selfId);
    // The greater seq always wins, so the stored row has the highest seq seen.
    const r: BranchRow = {
      project: row.project, branch: row.branch, node: selfId, seq: (local?.seq ?? 0) + 1, commit: row.commit,
      drops: row.drops.map((d) => ({ node: d.node, seq: d.seq })),
    };
    putBranch(db, r);
    return r;
  }).immediate();
  branchesChanged([written.project]);
  return written;
}
