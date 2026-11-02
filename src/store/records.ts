import { randomBytes } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";

export function newId(): string {
  return randomBytes(6).toString("hex");
}

export type ProjectRow = {
  id: string;
  name: string;
  source_kind: "folder" | "upstream";
  source: string;
  replica: string;
  created_at: string;
  /** The home's node id; NULL in a row from before homes, until the node claims it (`claimHomelessProjects`). */
  home: string | null;
};

export type TaskRow = {
  id: string;
  title: string;
  state: string;
  session_id: string;
  manifest: string;
  started: 0 | 1;
  turns: number;
  created_at: string;
  updated_at: string;
  /** `TaskSettings` as JSON, or NULL for none. */
  settings: string | null;
  /** Prompts sent while the task was moving, as a JSON array of strings; NULL for none. */
  queued: string | null;
  /** The node a `moved` task went to. */
  moved_to: string | null;
  /** The node a `receiving` task comes from. */
  receiving_from: string | null;
  /** The node an `archived` task was archived on (its archive is there). */
  archived_on: string | null;
  /** When the task was archived (ISO). */
  archived_at: string | null;
};

/** What the user chose for a task's later turns; an absent field takes the default. */
export type TaskSettings = { model?: string; effort?: string; permissionMode?: PermissionMode };

export function insertProject(db: Database, row: ProjectRow): void {
  db.query(
    "INSERT INTO projects (id, name, source_kind, source, replica, created_at, home) VALUES ($id, $name, $source_kind, $source, $replica, $created_at, $home)",
  ).run({
    $id: row.id,
    $name: row.name,
    $source_kind: row.source_kind,
    $source: row.source,
    $replica: row.replica,
    $created_at: row.created_at,
    $home: row.home,
  });
}

/** Gives every project without a home (added before projects had one) the home `nodeId`: this node. */
export function claimHomelessProjects(db: Database, nodeId: string): void {
  db.query("UPDATE projects SET home = ? WHERE home IS NULL").run(nodeId);
}

export function getProjectRow(db: Database, id: string): ProjectRow | null {
  return db.query<ProjectRow, [string]>("SELECT * FROM projects WHERE id = ?").get(id);
}

export function listProjectRows(db: Database): ProjectRow[] {
  return db.query<ProjectRow, []>("SELECT * FROM projects ORDER BY created_at, id").all();
}

export function insertTask(
  db: Database,
  row: Omit<TaskRow, "created_at" | "updated_at" | "settings" | "queued" | "moved_to" | "receiving_from" | "archived_on" | "archived_at">,
): void {
  const now = new Date().toISOString();
  db.query(
    `INSERT INTO tasks (id, title, state, session_id, manifest, started, turns, created_at, updated_at)
     VALUES ($id, $title, $state, $session_id, $manifest, $started, $turns, $created_at, $updated_at)`,
  ).run({
    $id: row.id,
    $title: row.title,
    $state: row.state,
    $session_id: row.session_id,
    $manifest: row.manifest,
    $started: row.started,
    $turns: row.turns,
    $created_at: now,
    $updated_at: now,
  });
}

export function getTask(db: Database, id: string): TaskRow | null {
  return db.query<TaskRow, [string]>("SELECT * FROM tasks WHERE id = ?").get(id);
}

const TASK_PATCH_COLUMNS = [
  "state", "started", "turns", "session_id", "manifest", "settings", "queued", "moved_to", "receiving_from", "archived_on", "archived_at",
] as const;

/** Sets the given columns of a task row (`null` clears a nullable one; `undefined` leaves it). */
export function updateTask(db: Database, id: string, patch: Partial<Pick<TaskRow, (typeof TASK_PATCH_COLUMNS)[number]>>): void {
  const sets = ["updated_at = $updated_at"];
  const params: Record<string, string | number | null> = { $id: id, $updated_at: new Date().toISOString() };
  for (const column of TASK_PATCH_COLUMNS) {
    const value = patch[column];
    if (value === undefined) continue;
    sets.push(`${column} = $${column}`);
    params[`$${column}`] = value;
  }
  db.query(`UPDATE tasks SET ${sets.join(", ")} WHERE id = $id`).run(params);
}

/** Every task row, moved and received ones included. */
export function listTasks(db: Database): TaskRow[] {
  return db.query<TaskRow, []>("SELECT * FROM tasks ORDER BY created_at, id").all();
}

/**
 * The tasks that live on this node: every state but `moved` (gone to another node), `receiving` (not here yet) and
 * `archived` (only its rows and archive are here).
 */
export function listLiveTasks(db: Database): TaskRow[] {
  return db.query<TaskRow, []>("SELECT * FROM tasks WHERE state NOT IN ('moved', 'receiving', 'archived') ORDER BY created_at, id").all();
}

/** The tasks archived on this node (state `archived`; a `moved` row that still names where it was archived is not one). */
export function listArchivedTasks(db: Database): TaskRow[] {
  return db.query<TaskRow, []>("SELECT * FROM tasks WHERE state = 'archived' ORDER BY created_at, id").all();
}

/** How many of this node's tasks are in state `running` or `waiting`. */
export function countRunningTasks(db: Database): number {
  return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tasks WHERE state IN ('running', 'waiting')").get()!.n;
}

/** The task's settings; `{}` for a task with none, or an unknown task. */
export function getTaskSettings(db: Database, id: string): TaskSettings {
  const row = db.query<{ settings: string | null }, [string]>("SELECT settings FROM tasks WHERE id = ?").get(id);
  return row?.settings ? (JSON.parse(row.settings) as TaskSettings) : {};
}

/** Sets the given fields of the task's settings; a field given as `undefined` goes back to the default. */
export function updateTaskSettings(db: Database, id: string, patch: { [K in keyof TaskSettings]?: TaskSettings[K] | undefined }): void {
  db.transaction(() => {
    const settings: Record<string, unknown> = { ...getTaskSettings(db, id) };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete settings[key];
      else settings[key] = value;
    }
    db.query("UPDATE tasks SET settings = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(settings), new Date().toISOString(), id);
  })();
}

/** Deletes task `id`'s event log and its session's transcript rows. */
export function clearTaskLog(db: Database, id: string, sessionId: string): void {
  db.transaction(() => {
    db.query("DELETE FROM events WHERE task_id = ?").run(id);
    db.query("DELETE FROM transcript WHERE session_id = ?").run(sessionId);
  })();
}

/** Deletes task `id`'s row, its event log and its session's transcript rows. */
export function deleteTask(db: Database, id: string, sessionId: string): void {
  db.transaction(() => {
    clearTaskLog(db, id, sessionId);
    db.query("DELETE FROM tasks WHERE id = ?").run(id);
  })();
}

/** The task's queued prompts (`[]` for none). */
export function queuedOf(row: Pick<TaskRow, "queued">): string[] {
  return row.queued === null ? [] : (JSON.parse(row.queued) as string[]);
}
