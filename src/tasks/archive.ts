// What a task that moved away leaves on its old node (decision 18): one gzipped JSON file, kept for seven days.
import { chmod, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { NodeConfig } from "../config";
import { ensurePrivateDir, paths } from "../paths";
import { getTask } from "../store/records";
import { regularFiles } from "./transfer";

/** How long an archive is kept. */
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

/**
 * Writes task `taskId`'s archive to `<data>/archive/<taskId>.json.gz` (directory 700, file 600) and returns its path.
 * The file appears whole or not at all (written aside, then renamed). An archive written since the task's row last
 * changed is kept: a rerun of a move's cleanup after it removed pieces of the task never replaces it with less, while
 * one left from an earlier stay of the task here is replaced.
 */
export async function writeArchive(cfg: NodeConfig, db: Database, taskId: string): Promise<string> {
  const p = paths(cfg);
  const file = p.archiveFile(taskId);
  await ensurePrivateDir(p.archive);
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
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, Bun.gzipSync(JSON.stringify(archive)), { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, file);
  return file;
}

/** Reads an archive `writeArchive` wrote. */
export async function readArchive(file: string): Promise<TaskArchive> {
  return JSON.parse(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await readFile(file))))) as TaskArchive;
}

/** Deletes the archives (and stray partial writes) older than `ARCHIVE_DAYS` at `now`; how many it deleted. */
export async function runJanitor(cfg: NodeConfig, now = Date.now()): Promise<number> {
  const dir = paths(cfg).archive;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
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
