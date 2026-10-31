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

/** Whether the task's log holds any message other than meddle's own: Claude Code has run for it. */
export function hasSdkEvents(db: Database, taskId: string): boolean {
  return db.query("SELECT 1 FROM events WHERE task_id = ? AND type != 'meddle' LIMIT 1").get(taskId) !== null;
}
