// The removed list: the projects `meddle project remove` took out of the pool, carried in pool sync and relayed by every
// node. It only grows: an id once on it stays, with the entry first written, so that every node settles on the same list.
// This file reads and writes the db and nothing else (`rows.ts` imports it), so that every check of a project can use it.
import type { Database } from "bun:sqlite";
import type { Subscribable } from "@earendil-works/chord";
import { SAFE_ID } from "../tasks/provision";
import { ISO_TIME } from "./store";

/** A removed project: its id and the name it had, when it was removed and the node that removed it. */
export type RemovedProject = { id: string; name: string; removedAt: string; removedBy: string };

type RemovedRecord = { id: string; name: string; removed_at: string; removed_by: string };

const listeners = new Set<(id: string) => void>();

/** Fires with a project's id after it was added to the removed list on a node of this process: a listener checks its own db (`isRemoved`). */
export const removedChanges: Subscribable<string> = {
  subscribe(cb) {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
  },
};

function tell(ids: Iterable<string>): void {
  for (const id of ids) {
    for (const cb of [...listeners]) {
      try {
        cb(id);
      } catch {
        // A listener's failure is its own; the others still hear of the change.
      }
    }
  }
}

/** Whether project `projectId` is on the removed list. */
export function isRemoved(db: Database, projectId: string): boolean {
  return db.query("SELECT 1 FROM removed_projects WHERE id = ?").get(projectId) !== null;
}

/** The removed list, by when each project was removed, then its id. */
export function listRemoved(db: Database): RemovedProject[] {
  return db
    .query<RemovedRecord, []>("SELECT id, name, removed_at, removed_by FROM removed_projects ORDER BY removed_at, id")
    .all()
    .map((r) => ({ id: r.id, name: r.name, removedAt: r.removed_at, removedBy: r.removed_by }));
}

/** The ids on the removed list. */
export function removedIds(db: Database): Set<string> {
  return new Set(db.query<{ id: string }, []>("SELECT id FROM removed_projects").all().map((r) => r.id));
}

function insert(db: Database, entry: RemovedProject): boolean {
  const { changes } = db
    .query("INSERT OR IGNORE INTO removed_projects (id, name, removed_at, removed_by) VALUES (?, ?, ?, ?)")
    .run(entry.id, entry.name, entry.removedAt, entry.removedBy);
  return changes > 0;
}

/** Adds `entry` to the removed list; false when its id is already there, whose entry stays. */
export function markRemoved(db: Database, entry: RemovedProject): boolean {
  const inserted = insert(db, entry);
  if (inserted) tell([entry.id]);
  return inserted;
}

/** Adds the rows a peer sent that name a project not yet on the list, skipping any that is malformed; returns the ids added. */
export function mergeRemoved(db: Database, rows: readonly RemovedProject[]): string[] {
  const ids: string[] = [];
  db.transaction(() => {
    for (const row of rows) {
      if (
        typeof row?.id !== "string" || !SAFE_ID.test(row.id) || typeof row.name !== "string" ||
        typeof row.removedBy !== "string" || typeof row.removedAt !== "string" || !ISO_TIME.test(row.removedAt)
      ) continue;
      if (insert(db, row)) ids.push(row.id);
    }
  }).immediate();
  tell(ids);
  return ids;
}
