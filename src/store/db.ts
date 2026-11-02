import { Database } from "bun:sqlite";

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT,
    source_kind TEXT,
    source TEXT,
    replica TEXT,
    created_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT,
    state TEXT,
    session_id TEXT,
    manifest TEXT,
    started INTEGER NOT NULL DEFAULT 0,
    turns INTEGER NOT NULL DEFAULT 0,
    created_at TEXT,
    updated_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS events (
    task_id TEXT,
    seq INTEGER,
    type TEXT,
    subtype TEXT,
    uuid TEXT,
    at TEXT,
    json TEXT,
    PRIMARY KEY (task_id, seq)
  )`,
  `CREATE INDEX IF NOT EXISTS events_type ON events (task_id, type, subtype, seq)`,
  `CREATE TABLE IF NOT EXISTS transcript (
    project_key TEXT,
    session_id TEXT,
    subpath TEXT NOT NULL DEFAULT '',
    seq INTEGER,
    uuid TEXT,
    ts INTEGER,
    json TEXT,
    PRIMARY KEY (project_key, session_id, subpath, seq)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS transcript_uuid
    ON transcript (project_key, session_id, subpath, uuid) WHERE uuid IS NOT NULL`,
  // The pool this node belongs to: one row.
  `CREATE TABLE IF NOT EXISTS pool (
    pool_id TEXT PRIMARY KEY,
    pool_secret TEXT,
    created_at TEXT
  )`,
  // The pool's members, past and present; summary and last_addr are JSON.
  `CREATE TABLE IF NOT EXISTS roster (
    node_id TEXT PRIMARY KEY,
    hostname TEXT,
    status TEXT,
    updated_at TEXT,
    added_by TEXT,
    summary TEXT,
    last_seen_at TEXT,
    last_addr TEXT
  )`,
  // The pool's settings (`PoolSettings`), last writer wins per key on updated_at; a NULL value is an unset (tombstone).
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NULL,
    updated_at TEXT NOT NULL,
    set_by TEXT NOT NULL
  )`,
  // The pool's login tokens (src/token.ts), last writer wins per id on updated_at; the values are files, never here.
  `CREATE TABLE IF NOT EXISTS tokens (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    set_at TEXT NOT NULL,
    set_by TEXT NULL,
    status TEXT NOT NULL,
    until TEXT NULL,
    detail TEXT NULL,
    updated_at TEXT NOT NULL,
    removed INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS invites (
    code TEXT PRIMARY KEY,
    created_at TEXT,
    expires_at TEXT,
    used_at TEXT
  )`,
];

/** Columns added to a table after its first release: each is added to a database that lacks it. */
const ADDED_COLUMNS = [
  // A task's model, effort and permission mode overrides, as JSON (`TaskSettings`); NULL for none.
  { table: "tasks", column: "settings", type: "TEXT" },
  // The node id of the project's home: the node whose `trunk` is the project's.
  { table: "projects", column: "home", type: "TEXT" },
  // Prompts sent while the task was moving, as a JSON array of strings; NULL for none.
  { table: "tasks", column: "queued", type: "TEXT" },
  // The node a `moved` task went to.
  { table: "tasks", column: "moved_to", type: "TEXT" },
  // The node a `receiving` task comes from.
  { table: "tasks", column: "receiving_from", type: "TEXT" },
];

export function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  for (const sql of MIGRATIONS) db.exec(sql);
  for (const { table, column, type } of ADDED_COLUMNS) {
    const columns = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
    if (!columns.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
  return db;
}
