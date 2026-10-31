import type { Database } from "bun:sqlite";

export type EventRecord = { seq: number; message: unknown };

function stringField(message: unknown, name: string): string | null {
  if (typeof message !== "object" || message === null) return null;
  const value = (message as Record<string, unknown>)[name];
  return typeof value === "string" ? value : null;
}

export function appendEvent(db: Database, taskId: string, message: unknown): number {
  return db.transaction(() => {
    const { next } = db
      .query<{ next: number }, [string]>("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM events WHERE task_id = ?")
      .get(taskId)!;
    db.query(
      `INSERT INTO events (task_id, seq, type, subtype, uuid, at, json)
       VALUES ($task_id, $seq, $type, $subtype, $uuid, $at, $json)`,
    ).run({
      $task_id: taskId,
      $seq: next,
      $type: stringField(message, "type"),
      $subtype: stringField(message, "subtype"),
      $uuid: stringField(message, "uuid"),
      $at: new Date().toISOString(),
      $json: JSON.stringify(message),
    });
    return next;
  })();
}

export function listEvents(
  db: Database,
  taskId: string,
  opts: { fromSeq?: number; limit?: number } = {},
): EventRecord[] {
  const rows = db
    .query<{ seq: number; json: string }, [string, number, number]>(
      "SELECT seq, json FROM events WHERE task_id = ? AND seq >= ? ORDER BY seq LIMIT ?",
    )
    .all(taskId, opts.fromSeq ?? 1, opts.limit ?? -1);
  return rows.map((row) => ({ seq: row.seq, message: JSON.parse(row.json) }));
}

/**
 * The newest `limit` events of a task before `beforeSeq` (all of them without it), leaving out `excludeTypes`; oldest
 * first. Reads only the rows it returns, newest first, so a long log costs no more than a short one.
 */
export function listEventsTail(
  db: Database,
  taskId: string,
  opts: { beforeSeq?: number; limit: number; excludeTypes?: string[] },
): EventRecord[] {
  const where = ["task_id = ?"];
  const params: Array<string | number> = [taskId];
  if (opts.beforeSeq !== undefined) {
    where.push("seq < ?");
    params.push(opts.beforeSeq);
  }
  const excluded = opts.excludeTypes ?? [];
  // `type IS NULL` keeps messages without a type, which `NOT IN` alone would drop.
  if (excluded.length > 0) where.push(`(type IS NULL OR type NOT IN (${excluded.map(() => "?").join(", ")}))`);
  params.push(...excluded, opts.limit);
  const rows = db
    .query<{ seq: number; json: string }, Array<string | number>>(
      `SELECT seq, json FROM events WHERE ${where.join(" AND ")} ORDER BY seq DESC LIMIT ?`,
    )
    .all(...params);
  return rows.reverse().map((row) => ({ seq: row.seq, message: JSON.parse(row.json) }));
}

/** The task's newest event of `type` (and `subtype`, when given), or null. */
export function latestEventOfType(db: Database, taskId: string, type: string, subtype?: string): EventRecord | null {
  const row = subtype === undefined
    ? db.query<{ seq: number; json: string }, [string, string]>(
      "SELECT seq, json FROM events WHERE task_id = ? AND type = ? ORDER BY seq DESC LIMIT 1",
    ).get(taskId, type)
    : db.query<{ seq: number; json: string }, [string, string, string]>(
      "SELECT seq, json FROM events WHERE task_id = ? AND type = ? AND subtype = ? ORDER BY seq DESC LIMIT 1",
    ).get(taskId, type, subtype);
  return row === null ? null : { seq: row.seq, message: JSON.parse(row.json) };
}

/** The task's newest `type`/`subtype` event whose JSON has a non-null top-level `field`, or null. */
export function latestEventWithField(db: Database, taskId: string, type: string, subtype: string, field: string): EventRecord | null {
  const row = db.query<{ seq: number; json: string }, [string, string, string, string]>(
    "SELECT seq, json FROM events WHERE task_id = ? AND type = ? AND subtype = ? AND json_extract(json, ?) IS NOT NULL ORDER BY seq DESC LIMIT 1",
  ).get(taskId, type, subtype, `$.${field}`);
  return row === null ? null : { seq: row.seq, message: JSON.parse(row.json) };
}
