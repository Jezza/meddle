import { randomBytes } from "node:crypto";
import type { Database } from "bun:sqlite";

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
};

export function insertProject(db: Database, row: ProjectRow): void {
  db.query(
    "INSERT INTO projects (id, name, source_kind, source, replica, created_at) VALUES ($id, $name, $source_kind, $source, $replica, $created_at)",
  ).run({
    $id: row.id,
    $name: row.name,
    $source_kind: row.source_kind,
    $source: row.source,
    $replica: row.replica,
    $created_at: row.created_at,
  });
}

export function getProjectRow(db: Database, id: string): ProjectRow | null {
  return db.query<ProjectRow, [string]>("SELECT * FROM projects WHERE id = ?").get(id);
}

export function listProjectRows(db: Database): ProjectRow[] {
  return db.query<ProjectRow, []>("SELECT * FROM projects ORDER BY created_at, id").all();
}

export function insertTask(db: Database, row: Omit<TaskRow, "created_at" | "updated_at">): void {
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

export function listTasks(db: Database): TaskRow[] {
  return db.query<TaskRow, []>("SELECT * FROM tasks ORDER BY created_at, id").all();
}
