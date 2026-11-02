// A task's files and rows in one gzipped JSON file: the archive of a task archived here (kept until it is restored or
// deleted, `<data>/archives/`) and what a task that moved away leaves on its old node (decision 18, kept seven days,
// `<data>/moved/`).
import { chmod, mkdir, open, readdir, readFile, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Database } from "bun:sqlite";
import type { NodeConfig } from "../config";
import { ensurePrivateDir, paths } from "../paths";
import { getTask } from "../store/records";
import { prepareParent, regularFiles, safeSegments } from "./transfer";

/** How long a move's leftover is kept. */
export const ARCHIVE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/** An archive's contents: the task's row, manifest, event log, transcript rows and transcript files. */
export type TaskArchive = {
  version: 1;
  archivedAt: string;
  row: Record<string, unknown>;
  manifest: unknown;
  events: Array<{ seq: number; json: string }>;
  transcript: Array<{ project_key: string; session_id: string; subpath: string; seq: number; uuid: string | null; ts: number; json: string }>;
  /** The regular files under `<taskConfig>/projects/`, relative to it, forward slashes; their bytes in base64. */
  files: Array<{ path: string; base64: string }>;
};

/** Makes each partial write's name unique within this process. */
let tmpSeq = 0;

/**
 * Writes task `taskId`'s archive to `file` (its directory made mode 700, the file 600) and returns `file`. The file
 * appears whole or not at all (written aside, then renamed), and is on disk when this returns: the data is synced before
 * the rename and the directory after it, since callers remove the task folder (the only other copy of its transcript
 * files) next. An archive written there since the task's row last changed
 * is kept: a rerun of a move's cleanup after it removed pieces of the task never replaces it with less, while one left
 * from an earlier stay of the task here is replaced.
 */
export async function writeArchive(cfg: NodeConfig, db: Database, taskId: string, file: string): Promise<string> {
  const p = paths(cfg);
  await ensurePrivateDir(dirname(file));
  const row = getTask(db, taskId);
  if (row === null) throw new Error(`unknown task: ${taskId}`);
  // The row is untouched since that archive was written: this stay's (a file's mtime is too coarse to tell).
  const written = await readArchive(file).catch(() => null);
  if (written !== null && written.row.updated_at === row.updated_at) return file;
  const root = join(p.taskConfig(taskId), "projects");
  const files: TaskArchive["files"] = [];
  for (const path of await regularFiles(root)) files.push({ path, base64: (await readFile(join(root, path))).toString("base64") });
  const archive: TaskArchive = {
    version: 1,
    archivedAt: new Date().toISOString(),
    row: { ...row },
    manifest: JSON.parse(row.manifest),
    events: db.query<{ seq: number; json: string }, [string]>("SELECT seq, json FROM events WHERE task_id = ? ORDER BY seq").all(taskId),
    transcript: db
      .query<TaskArchive["transcript"][number], [string]>(
        "SELECT project_key, session_id, subpath, seq, uuid, ts, json FROM transcript WHERE session_id = ? ORDER BY project_key, subpath, seq",
      )
      .all(row.session_id),
    files,
  };
  const temp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
  const handle = await open(temp, "w", 0o600);
  try {
    await handle.writeFile(Bun.gzipSync(JSON.stringify(archive)));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(temp, 0o600);
  await rename(temp, file);
  const dir = await open(dirname(file), "r");
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
  return file;
}

/**
 * Removes what a crash can leave in `<data>/archives/`: a half-written `*.tmp` (never read: an archive is renamed into
 * place whole). `serve` runs it at start, before anything writes an archive; how many it removed.
 */
export async function sweepArchiveTemps(cfg: NodeConfig): Promise<number> {
  const dir = paths(cfg).archives;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith(".tmp")) continue;
    await rm(join(dir, name), { force: true });
    removed += 1;
  }
  return removed;
}

/** Reads an archive `writeArchive` wrote. */
export async function readArchive(file: string): Promise<TaskArchive> {
  return JSON.parse(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await readFile(file))))) as TaskArchive;
}

/**
 * Writes the archive's `files` back under task `taskId`'s `<taskConfig>/projects/` (each mode 600; a path that leaves
 * that directory or passes through anything but a directory is refused, as in a transfer). How many it wrote.
 */
export async function unpackArchiveFiles(cfg: NodeConfig, taskId: string, archive: TaskArchive): Promise<number> {
  const root = join(paths(cfg).taskConfig(taskId), "projects");
  await mkdir(root, { recursive: true });
  for (const f of archive.files) {
    const target = await prepareParent(root, safeSegments(f.path));
    await writeFile(target, Buffer.from(f.base64, "base64"), { mode: 0o600 });
    await chmod(target, 0o600);
  }
  return archive.files.length;
}

/**
 * Deletes the move leftovers (and stray partial writes) in `<data>/moved/` older than `ARCHIVE_DAYS` at `now`; how many
 * it deleted. The `<data>/archive/` directory an earlier meddle kept them in gets the same rule, and is removed once
 * empty. Archives of archived tasks (`<data>/archives/`) are never touched.
 */
export async function runJanitor(cfg: NodeConfig, now = Date.now()): Promise<number> {
  const legacy = join(cfg.dataDir, "archive");
  let deleted = (await sweep(paths(cfg).moved, now)) ?? 0;
  const old = await sweep(legacy, now);
  if (old !== null) {
    deleted += old;
    await rmdir(legacy).catch(() => {}); // not empty yet: the next run tries again
  }
  return deleted;
}

/** Deletes the `.json.gz` and `.tmp` files in `dir` older than `ARCHIVE_DAYS`; how many, or null when `dir` does not exist. */
async function sweep(dir: string, now: number): Promise<number | null> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let deleted = 0;
  for (const name of names) {
    if (!name.endsWith(".json.gz") && !name.endsWith(".tmp")) continue;
    const path = join(dir, name);
    try {
      if (now - (await stat(path)).mtimeMs <= ARCHIVE_DAYS * DAY_MS) continue;
      await unlink(path);
      deleted += 1;
    } catch {
      // gone meanwhile
    }
  }
  return deleted;
}

/** How often `serve` runs the janitor after its first run at start. */
export const JANITOR_INTERVAL_MS = DAY_MS;
