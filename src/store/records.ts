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

export function insertTask(db: Database, row: Omit<TaskRow, "created_at" | "updated_at" | "settings">): void {
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

const TASK_PATCH_COLUMNS = ["state", "started", "turns", "session_id", "manifest"] as const;

export function updateTask(
  db: Database,
  id: string,
  patch: Partial<Pick<TaskRow, "state" | "started" | "turns" | "session_id" | "manifest">>,
): void {
  const sets = ["updated_at = $updated_at"];
  const params: Record<string, string | number> = { $id: id, $updated_at: new Date().toISOString() };
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

/** The tasks that live on this node: every state but `moved` (gone to another node) and `receiving` (not here yet). */
export function listLiveTasks(db: Database): TaskRow[] {
  return db.query<TaskRow, []>("SELECT * FROM tasks WHERE state NOT IN ('moved', 'receiving') ORDER BY created_at, id").all();
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
