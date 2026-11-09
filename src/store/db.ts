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
  // The pool this node belongs to: one row; pool_id and pool_secret are empty until `meddle pool secret` sets them.
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
  // Where each task's line points (src/pool/rows.ts): written by the task's holder, the greater (epoch, seq) wins.
  // commit_id NULL is released; base is a JSON array of commit ids; seen_seq is the highest seq seen for the line.
  `CREATE TABLE IF NOT EXISTS line_rows (
    project TEXT NOT NULL,
    task TEXT NOT NULL,
    name TEXT NOT NULL,
    holder TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    commit_id TEXT NULL,
    base TEXT NOT NULL,
    archived INTEGER NOT NULL,
    seen_seq INTEGER NOT NULL,
    PRIMARY KEY (project, task, name)
  )`,
  // Where each node puts each branch (src/pool/rows.ts): written by that node, the greater seq wins. commit_id NULL is
  // deleted; drops is a JSON array of the `{ node, seq }` rows it replaced.
  `CREATE TABLE IF NOT EXISTS branch_rows (
    project TEXT NOT NULL,
    branch TEXT NOT NULL,
    node TEXT NOT NULL,
    seq INTEGER NOT NULL,
    commit_id TEXT NULL,
    drops TEXT NOT NULL,
    PRIMARY KEY (project, branch, node)
  )`,
];

/** Columns added to a table after its first release: each is added to a database that lacks it. */
const ADDED_COLUMNS = [
  // A task's model, effort and permission mode overrides, as JSON (`TaskSettings`); NULL for none.
  { table: "tasks", column: "settings", type: "TEXT" },
  // The node id of the project's home: the node whose repo is the project's.
  { table: "projects", column: "home", type: "TEXT" },
  // `sync` and `upstream` belong to a removed feature: kept so older databases match, read and written by nothing.
  { table: "projects", column: "sync", type: "TEXT" },
  { table: "projects", column: "upstream", type: "INTEGER" },
  // The project's default branch: what a task starts from when no revision is named; NULL for none.
  { table: "projects", column: "default_branch", type: "TEXT" },
  // Prompts sent while the task was moving, as a JSON array of strings; NULL for none.
  { table: "tasks", column: "queued", type: "TEXT" },
  // The node a `moved` task went to.
  { table: "tasks", column: "moved_to", type: "TEXT" },
  // The node a `receiving` task comes from.
  { table: "tasks", column: "receiving_from", type: "TEXT" },
  // The node an `archived` task was archived on, and when.
  { table: "tasks", column: "archived_on", type: "TEXT" },
  { table: "tasks", column: "archived_at", type: "TEXT" },
  // The pool's name, which with the secret derives its id; NULL marks a pool of an older meddle (reset at the next start).
  { table: "pool", column: "name", type: "TEXT" },
  // The newest time any member reported a connection with the node (on the reporter's clock), and the node's address
  // as that member saw it (JSON): how a node that moved is found again, and when it was last heard of.
  { table: "roster", column: "reached_at", type: "TEXT" },
  { table: "roster", column: "reached_addr", type: "TEXT" },
  // Where a token sits in the order turns try them (src/token.ts); NULL for a row from before it: sorted by set_at.
  { table: "tokens", column: "rank", type: "REAL" },
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
