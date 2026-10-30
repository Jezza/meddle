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
];

export function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  for (const sql of MIGRATIONS) db.exec(sql);
  return db;
}
