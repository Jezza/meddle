import type { Database } from "bun:sqlite";
import { attachmentProblem, type Attachment } from "../blobs/attachment";

/** `at`: when this node logged the event (a moved task's events keep the times they were logged with). */
export type EventRecord = { seq: number; message: unknown; at: string };

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
    .query<{ seq: number; at: string; json: string }, [string, number, number]>(
      "SELECT seq, at, json FROM events WHERE task_id = ? AND seq >= ? ORDER BY seq LIMIT ?",
    )
    .all(taskId, opts.fromSeq ?? 1, opts.limit ?? -1);
  return rows.map((row) => ({ seq: row.seq, message: JSON.parse(row.json), at: row.at }));
}

/** The seq of the task's newest event; 0 when it has none. */
export function lastSeq(db: Database, taskId: string): number {
  return db.query<{ last: number }, [string]>("SELECT COALESCE(MAX(seq), 0) AS last FROM events WHERE task_id = ?").get(taskId)!.last;
}

/**
 * The task's events after `afterSeq` up to `toSeq` (inclusive) of any of `types` (each message's `type`), oldest first:
 * the rest of the span is never parsed.
 */
export function listEventsBetween(db: Database, taskId: string, afterSeq: number, toSeq: number, types: readonly string[]): EventRecord[] {
  if (types.length === 0) return [];
  const rows = db
    .query<{ seq: number; at: string; json: string }, Array<string | number>>(
      `SELECT seq, at, json FROM events WHERE task_id = ? AND seq > ? AND seq <= ? AND type IN (${types.map(() => "?").join(", ")}) ORDER BY seq`,
    )
    .all(taskId, afterSeq, toSeq, ...types);
  return rows.map((row) => ({ seq: row.seq, message: JSON.parse(row.json), at: row.at }));
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
  // An entry `type` leaves out every message of that type, `type:subtype` only those with that subtype too.
  // `IS NOT` keeps messages without a type or subtype, which `NOT IN` and `<>` would drop.
  for (const kind of opts.excludeTypes ?? []) {
    const at = kind.indexOf(":");
    if (at < 0) {
      where.push("type IS NOT ?");
      params.push(kind);
    } else {
      where.push("NOT (type IS ? AND subtype IS ?)");
      params.push(kind.slice(0, at), kind.slice(at + 1));
    }
  }
  params.push(opts.limit);
  const rows = db
    .query<{ seq: number; at: string; json: string }, Array<string | number>>(
      `SELECT seq, at, json FROM events WHERE ${where.join(" AND ")} ORDER BY seq DESC LIMIT ?`,
    )
    .all(...params);
  return rows.reverse().map((row) => ({ seq: row.seq, message: JSON.parse(row.json), at: row.at }));
}

/**
 * The task's events of any of `kinds`, oldest first; a kind is `type:subtype`. One read that parses only the matching
 * rows, but it does not narrow by the `events_type` index: SQLite scans the task's rows and filters them, about 5 to
 * 13 ms on the largest log. No kinds, no events.
 */
export function listEventsOfKinds(db: Database, taskId: string, kinds: readonly string[]): EventRecord[] {
  if (kinds.length === 0) return [];
  const params: string[] = [taskId];
  const any = kinds.map((kind) => {
    const at = kind.indexOf(":");
    params.push(kind.slice(0, at), kind.slice(at + 1));
    return "(type = ? AND subtype = ?)";
  });
  const rows = db
    .query<{ seq: number; at: string; json: string }, string[]>(
      `SELECT seq, at, json FROM events WHERE task_id = ? AND (${any.join(" OR ")}) ORDER BY seq`,
    )
    .all(...params);
  return rows.map((row) => ({ seq: row.seq, message: JSON.parse(row.json), at: row.at }));
}

/** The task's newest event of `type` (and `subtype`, when given), or null. */
export function latestEventOfType(db: Database, taskId: string, type: string, subtype?: string): EventRecord | null {
  const row = subtype === undefined
    ? db.query<{ seq: number; at: string; json: string }, [string, string]>(
      "SELECT seq, at, json FROM events WHERE task_id = ? AND type = ? ORDER BY seq DESC LIMIT 1",
    ).get(taskId, type)
    : db.query<{ seq: number; at: string; json: string }, [string, string, string]>(
      "SELECT seq, at, json FROM events WHERE task_id = ? AND type = ? AND subtype = ? ORDER BY seq DESC LIMIT 1",
    ).get(taskId, type, subtype);
  return row === null ? null : { seq: row.seq, message: JSON.parse(row.json), at: row.at };
}

/**
 * The task's newest assistant message of the main thread that reports usage (no `parent_tool_use_id`, a
 * `message.usage`, not one Claude Code made up as `<synthetic>`), or null.
 */
export function latestMainAssistant(db: Database, taskId: string): EventRecord | null {
  const row = db.query<{ seq: number; at: string; json: string }, [string]>(
    `SELECT seq, at, json FROM events WHERE task_id = ? AND type = 'assistant'
       AND json_extract(json, '$.parent_tool_use_id') IS NULL AND json_extract(json, '$.message.usage') IS NOT NULL
       AND coalesce(json_extract(json, '$.message.model'), '') != '<synthetic>'
     ORDER BY seq DESC LIMIT 1`,
  ).get(taskId);
  return row === null ? null : { seq: row.seq, message: JSON.parse(row.json), at: row.at };
}

/** The task's newest `type`/`subtype` event whose JSON has a non-null top-level `field`, or null. */
export function latestEventWithField(db: Database, taskId: string, type: string, subtype: string, field: string): EventRecord | null {
  const row = db.query<{ seq: number; at: string; json: string }, [string, string, string, string]>(
    "SELECT seq, at, json FROM events WHERE task_id = ? AND type = ? AND subtype = ? AND json_extract(json, ?) IS NOT NULL ORDER BY seq DESC LIMIT 1",
  ).get(taskId, type, subtype, `$.${field}`);
  return row === null ? null : { seq: row.seq, message: JSON.parse(row.json), at: row.at };
}

/**
 * Every valid attachment of the task's logged prompts (`user` events with `attachments`), oldest first, each as its
 * `hash`, `name`, `type` and `size` alone; anything else on an event's `attachments` is left out.
 */
export function listPromptAttachments(db: Database, taskId: string): Attachment[] {
  const rows = db.query<{ json: string }, [string]>(
    "SELECT json FROM events WHERE task_id = ? AND type = 'user' AND json_extract(json, '$.attachments') IS NOT NULL ORDER BY seq",
  ).all(taskId);
  return rows.flatMap((row) => {
    const attachments = (JSON.parse(row.json) as { attachments?: unknown }).attachments;
    if (!Array.isArray(attachments)) return [];
    return (attachments as unknown[])
      .filter((a): a is Attachment => attachmentProblem(a) === null)
      .map(({ hash, name, type, size }) => ({ hash, name, type, size }));
  });
}
