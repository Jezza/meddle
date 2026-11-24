// Head rows: where each node's copy of each synced scope is (`src/scopes/`), carried in pool sync and relayed by every
// node. A row, keyed (scope, node), is written by that node only, which numbers its writes with `seq` (one above the
// highest seen for the key, so a node that lost its data never writes a row that loses to its own older one); the
// greater seq wins, then the greater content, so every node settles on the same row. A peer's row waits
// (`scope_heads_waiting`) until this node holds the commit it names, and only then is it used and relayed: every node
// that hands a row on can hand its commit on too. No row of a removed project's memory is taken or written.
import type { Database } from "bun:sqlite";
import type { Subscribable } from "@earendil-works/chord";
import { parseScopeKey } from "../scopes/scope";
import { COMMIT_ID } from "../tasks/provision";
import { shortId } from "./ids";
import { isRemoved, removedIds } from "./removed";
import { topic } from "./rows";

/**
 * Where `node`'s copy of `scope` is: `commit` (null for none yet), made under merge rules `rule`; `seed`, the seed
 * commit a profile line starts from (null for none, and for memory); `edited`, whether the line holds more than its seed
 * (always for memory).
 */
export type HeadRow = { scope: string; node: string; seq: number; commit: string | null; rule: number; seed: string | null; edited: boolean };

type HeadRecord = { scope: string; node: string; seq: number; commit_id: string | null; rule: number; seed: string | null; edited: number };
type HeadTable = "scope_heads" | "scope_heads_waiting";

const heads = topic<string>();

/** Fires with a scope's key when one of its rows was admitted, changed, or started waiting on this node. */
export const headChanges: Subscribable<string> = heads.subscribable;

const isCommit = (v: unknown): v is string => typeof v === "string" && COMMIT_ID.test(v);

/** The project a scope key's memory belongs to, else null. */
function projectOf(scope: string): string | null {
  const s = parseScopeKey(scope);
  return s?.kind === "memory" ? s.projectId : null;
}

/** A peer's head row as this node stores it, or null when no node would write it. */
function accept(r: HeadRow): HeadRow | null {
  const ok = typeof r.scope === "string" && parseScopeKey(r.scope) !== null
    && typeof r.node === "string"
    && Number.isSafeInteger(r.seq)
    && (r.commit === null || isCommit(r.commit))
    && Number.isSafeInteger(r.rule)
    && (r.seed === null || isCommit(r.seed))
    && typeof r.edited === "boolean";
  return ok ? { scope: r.scope, node: r.node, seq: r.seq, commit: r.commit, rule: r.rule, seed: r.seed, edited: r.edited } : null;
}

function rowOf(r: HeadRecord): HeadRow {
  return { scope: r.scope, node: r.node, seq: r.seq, commit: r.commit_id, rule: r.rule, seed: r.seed, edited: r.edited !== 0 };
}

function record(db: Database, scope: string, node: string, table: HeadTable): HeadRow | null {
  const r = db.query<HeadRecord, [string, string]>(`SELECT * FROM ${table} WHERE scope = ? AND node = ?`).get(scope, node);
  return r === null ? null : rowOf(r);
}

function put(db: Database, r: HeadRow, table: HeadTable): void {
  db.query(
    `INSERT INTO ${table} (scope, node, seq, commit_id, rule, seed, edited) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (scope, node) DO UPDATE SET seq = excluded.seq, commit_id = excluded.commit_id, rule = excluded.rule,
       seed = excluded.seed, edited = excluded.edited`,
  ).run(r.scope, r.node, r.seq, r.commit, r.rule, r.seed, r.edited ? 1 : 0);
}

function remove(db: Database, r: Pick<HeadRow, "scope" | "node">, table: HeadTable): void {
  db.query(`DELETE FROM ${table} WHERE scope = ? AND node = ?`).run(r.scope, r.node);
}

const content = (r: HeadRow) => JSON.stringify([r.commit, r.rule, r.seed, r.edited]);

/** Whether `r` wins over `local`, of the same key: the greater seq, then the greater content. */
function wins(r: HeadRow, local: HeadRow): boolean {
  if (r.seq !== local.seq) return r.seq > local.seq;
  return content(r) > content(local);
}

/**
 * Merges a peer's head rows: per (scope, node), the greater seq wins, then the greater content; a winner waits until
 * `settleHeadRows` admits it. `changed` are the scopes with a row waiting anew; a row of a removed project's memory is
 * skipped (not counted as rejected); `rejected` counts the rows dropped as malformed.
 */
export function mergeHeadRows(db: Database, rows: readonly HeadRow[]): { changed: string[]; rejected: number } {
  const scopes = new Set<string>();
  let rejected = 0;
  db.transaction(() => {
    const removed = removedIds(db);
    for (const row of rows) {
      const r = accept(row);
      if (r === null) {
        rejected++;
        continue;
      }
      const project = projectOf(r.scope);
      if (project !== null && removed.has(project)) continue;
      const local = record(db, r.scope, r.node, "scope_heads");
      if (local !== null && !wins(r, local)) continue;
      const waiting = record(db, r.scope, r.node, "scope_heads_waiting");
      if (waiting !== null && !wins(r, waiting)) continue;
      put(db, r, "scope_heads_waiting");
      scopes.add(r.scope);
    }
  }).immediate();
  for (const s of scopes) heads.tell(s);
  return { changed: [...scopes], rejected };
}

/** Every scope's rows waiting to be admitted, by scope and node. */
export function allWaitingHeadRows(db: Database): HeadRow[] {
  return db.query<HeadRecord, []>("SELECT * FROM scope_heads_waiting ORDER BY scope, node").all().map(rowOf);
}

/** A scope's rows waiting to be admitted, by node. */
export function waitingHeadRows(db: Database, scope: string): HeadRow[] {
  return db.query<HeadRecord, [string]>("SELECT * FROM scope_heads_waiting WHERE scope = ? ORDER BY node").all(scope).map(rowOf);
}

/**
 * Admits each of `scope`'s waiting rows that is newer than its key's row and names no commit or one of `present`, and
 * lets go of each its key's row beats. True (and `headChanges` fires) when the admitted rows changed.
 */
export function settleHeadRows(db: Database, scope: string, present: ReadonlySet<string>): boolean {
  const moved = db.transaction(() => {
    let changes = false;
    for (const w of waitingHeadRows(db, scope)) {
      const local = record(db, scope, w.node, "scope_heads");
      const newer = local === null || wins(w, local);
      if (newer && w.commit !== null && !present.has(w.commit)) continue;
      if (newer) put(db, w, "scope_heads");
      remove(db, w, "scope_heads_waiting");
      changes ||= newer;
    }
    return changes;
  }).immediate();
  if (moved) heads.tell(scope);
  return moved;
}

/** The admitted head rows, of one scope when given, by scope and node. */
export function listHeadRows(db: Database, scope?: string): HeadRow[] {
  const rows = scope === undefined
    ? db.query<HeadRecord, []>("SELECT * FROM scope_heads ORDER BY scope, node").all()
    : db.query<HeadRecord, [string]>("SELECT * FROM scope_heads WHERE scope = ? ORDER BY node").all(scope);
  return rows.map(rowOf);
}

/** Every admitted head row, by scope and node: what pool sync carries. */
export function allHeadRows(db: Database): HeadRow[] {
  return listHeadRows(db);
}

/**
 * Writes this node's row of a scope at one above the highest seq seen for it, a waiting row's included (its own row
 * come back from a peer after this node lost its data). Throws `project <short id> was removed` for a removed project's
 * memory.
 */
export function writeHeadRow(db: Database, selfId: string, row: Omit<HeadRow, "node" | "seq">): HeadRow {
  const written = db.transaction(() => {
    const project = projectOf(row.scope);
    if (project !== null && isRemoved(db, project)) throw new Error(`project ${shortId(project)} was removed`);
    const local = record(db, row.scope, selfId, "scope_heads");
    const waiting = record(db, row.scope, selfId, "scope_heads_waiting");
    const r: HeadRow = { ...row, node: selfId, seq: Math.max(local?.seq ?? 0, waiting?.seq ?? 0) + 1 };
    put(db, r, "scope_heads");
    if (waiting !== null) remove(db, r, "scope_heads_waiting");
    return r;
  }).immediate();
  heads.tell(written.scope);
  return written;
}

/** Deletes every row of `scope`, waiting ones too. */
export function deleteScopeRows(db: Database, scope: string): void {
  db.transaction(() => {
    for (const table of ["scope_heads", "scope_heads_waiting"]) db.query(`DELETE FROM ${table} WHERE scope = ?`).run(scope);
  }).immediate();
  heads.tell(scope);
}
