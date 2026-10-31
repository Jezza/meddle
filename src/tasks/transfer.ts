import { lstat, mkdir, open, readdir, readFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { SendStream } from "@number0/iroh";
import type { NodeConfig } from "../config";
import { paths } from "../paths";
import { MAX_FRAME, writeFrame, type StreamReader } from "../pool/frames";
import type { TaskSettings } from "../store/records";
import type { TaskManifest } from "./manifest";

/*
 * A task's move, as frames on one `blob` stream: JSON header frames (kind 0) in the order manifest, events, transcript
 * rows, files, done; each `file` frame is followed by its bytes as kind-1 frames (one, for a file of at most
 * `MAX_FRAME` bytes). `done` carries the sender's counts and a SHA-256 over every frame before it (kind, length and
 * payload, as sent); the receiver computes its own and answers with its receipt.
 */

export type TransferFrame =
  | { t: "manifest"; manifest: TaskManifest; settings: TaskSettings | null; queued: string[]; turns: number }
  | { t: "event"; seq: number; json: string }
  | { t: "transcript"; projectKey: string; sessionId: string; subpath: string; seq: number; uuid: string | null; ts: number; json: string }
  /** Relative to `<taskConfig>/projects/`, forward slashes; followed by kind-1 frames of `size` bytes in all. */
  | { t: "file"; path: string; size: number }
  | { t: "done"; events: number; transcript: number; files: number; bytes: number; sha256: string };

/** What one side of a transfer counted: rows, files, file bytes, the last event seq (0 for none) and the frame hash. */
export type Receipt = { events: number; transcript: number; files: number; bytes: number; lastEventSeq: number; sha256: string };

const HEADER = 0;
const BYTES = 1;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A SHA-256 over frames as they appear on the wire. */
class FrameHash {
  #hasher = new Bun.CryptoHasher("sha256");

  add(kind: number, data: Uint8Array): void {
    const head = new Uint8Array(5);
    const view = new DataView(head.buffer);
    view.setUint8(0, kind);
    view.setUint32(1, data.length);
    this.#hasher.update(head);
    this.#hasher.update(data);
  }

  digest(): string {
    return this.#hasher.digest("hex");
  }
}

type EventRow = { seq: number; json: string };
type TranscriptRow = { project_key: string; session_id: string; subpath: string; seq: number; uuid: string | null; ts: number; json: string };

/** The regular files under `root`, depth first in name order, as forward-slash paths relative to it; symlinks skipped. */
export async function regularFiles(root: string, rel = ""): Promise<string[]> {
  let names: string[];
  try {
    names = (await readdir(join(root, rel))).sort();
  } catch (err) {
    if (rel === "" && (err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: string[] = [];
  for (const name of names) {
    const path = rel === "" ? name : `${rel}/${name}`;
    const st = await lstat(join(root, path));
    if (st.isDirectory()) out.push(...(await regularFiles(root, path)));
    else if (st.isFile()) out.push(path);
  }
  return out;
}

/**
 * Sends task `taskId` (its row's manifest, settings, queued prompts and turns, its event log, its session's transcript
 * rows and the regular files under `<taskConfig>/projects/`) on `send`, then finishes it. Returns the sender's receipt.
 */
export async function exportTask(cfg: NodeConfig, db: Database, taskId: string, send: SendStream): Promise<Receipt> {
  const row = db
    .query<{ manifest: string; settings: string | null; queued: string | null; turns: number; session_id: string }, [string]>(
      "SELECT manifest, settings, queued, turns, session_id FROM tasks WHERE id = ?",
    )
    .get(taskId);
  if (row === null) throw new Error(`unknown task: ${taskId}`);
  const events = db.query<EventRow, [string]>("SELECT seq, json FROM events WHERE task_id = ? ORDER BY seq").all(taskId);
  const transcript = db
    .query<TranscriptRow, [string]>(
      "SELECT project_key, session_id, subpath, seq, uuid, ts, json FROM transcript WHERE session_id = ? ORDER BY project_key, session_id, subpath, seq",
    )
    .all(row.session_id);

  const hash = new FrameHash();
  const sendFrame = async (kind: number, data: Uint8Array) => {
    hash.add(kind, data);
    await writeFrame(send, kind, data);
  };
  const sendHeader = (frame: TransferFrame) => sendFrame(HEADER, encoder.encode(JSON.stringify(frame)));

  await sendHeader({
    t: "manifest",
    manifest: JSON.parse(row.manifest) as TaskManifest,
    settings: row.settings === null ? null : (JSON.parse(row.settings) as TaskSettings),
    queued: row.queued === null ? [] : (JSON.parse(row.queued) as string[]),
    turns: row.turns,
  });
  for (const e of events) await sendHeader({ t: "event", seq: e.seq, json: e.json });
  for (const r of transcript) {
    await sendHeader({
      t: "transcript", projectKey: r.project_key, sessionId: r.session_id, subpath: r.subpath, seq: r.seq, uuid: r.uuid, ts: r.ts, json: r.json,
    });
  }
  const root = join(paths(cfg).taskConfig(taskId), "projects");
  let files = 0;
  let bytes = 0;
  for (const path of await regularFiles(root)) {
    // The size sent is what was read, so a file that grows meanwhile still matches its frames.
    const data = new Uint8Array(await readFile(join(root, path)));
    await sendHeader({ t: "file", path, size: data.length });
    for (let at = 0; at === 0 || at < data.length; at += MAX_FRAME) await sendFrame(BYTES, data.subarray(at, at + MAX_FRAME));
    files += 1;
    bytes += data.length;
  }
  const receipt: Receipt = {
    events: events.length, transcript: transcript.length, files, bytes, lastEventSeq: events.at(-1)?.seq ?? 0, sha256: hash.digest(),
  };
  await writeFrame(send, HEADER, encoder.encode(JSON.stringify({
    t: "done", events: receipt.events, transcript: receipt.transcript, files, bytes, sha256: receipt.sha256,
  } satisfies TransferFrame)));
  await send.finish();
  return receipt;
}

/** `path` split into segments; throws "bad file path" unless it is relative, non-empty and free of `.`/`..`. */
function safeSegments(path: unknown): string[] {
  if (typeof path !== "string" || path === "" || path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
    throw new Error("bad file path");
  }
  const segments = path.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) throw new Error("bad file path");
  return segments;
}

/** Creates the directories of `segments` under `root`, refusing to pass through anything that is not a directory. */
async function prepareParent(root: string, segments: string[]): Promise<string> {
  let dir = root;
  for (const segment of segments.slice(0, -1)) {
    dir = join(dir, segment);
    const st = await lstat(dir).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return null;
      throw err;
    });
    if (st === null) await mkdir(dir);
    else if (!st.isDirectory()) throw new Error("bad file path");
  }
  const file = join(dir, segments.at(-1)!);
  const st = await lstat(file).catch(() => null);
  if (st !== null && !st.isFile()) throw new Error("bad file path");
  return file;
}

function parseFrame(data: Uint8Array): TransferFrame {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(data));
  } catch {
    throw new Error("bad transfer frame");
  }
  if (typeof value !== "object" || value === null || typeof (value as { t?: unknown }).t !== "string") {
    throw new Error("bad transfer frame");
  }
  return value as TransferFrame;
}

function stringField(json: string, name: string): string | null {
  try {
    const value = (JSON.parse(json) as Record<string, unknown> | null)?.[name];
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

/**
 * Receives a task `exportTask` sent: files are written under this node's `<taskConfig>/projects/` as they arrive; the
 * event and transcript rows are written in one transaction once `done` arrives, so a stream that ends first ("transfer
 * ended early") leaves no rows. The manifest must be task `expect.taskId`'s. The caller inserts the task row.
 */
export async function importTask(
  cfg: NodeConfig,
  db: Database,
  reader: StreamReader,
  expect: { taskId: string },
): Promise<{ manifest: TaskManifest; settings: TaskSettings | null; queued: string[]; turns: number; receipt: Receipt }> {
  const hash = new FrameHash();
  const next = async () => {
    const frame = await reader.readFrame();
    if (frame === null) throw new Error("transfer ended early");
    return frame;
  };

  const first = await next();
  hash.add(first.kind, first.data);
  const head = first.kind === HEADER ? parseFrame(first.data) : null;
  if (head?.t !== "manifest") throw new Error("transfer does not begin with a manifest");
  if (head.manifest?.id !== expect.taskId) throw new Error("manifest is for another task");

  const root = join(paths(cfg).taskConfig(expect.taskId), "projects");
  await mkdir(root, { recursive: true });
  const events: Array<{ seq: number; json: string }> = [];
  const transcript: Array<Extract<TransferFrame, { t: "transcript" }>> = [];
  let files = 0;
  let bytes = 0;
  for (;;) {
    const frame = await next();
    if (frame.kind !== HEADER) throw new Error("bad transfer frame");
    const parsed = parseFrame(frame.data);
    if (parsed.t === "done") break;
    hash.add(frame.kind, frame.data);
    if (parsed.t === "event") events.push({ seq: parsed.seq, json: parsed.json });
    else if (parsed.t === "transcript") transcript.push(parsed);
    else if (parsed.t === "file") {
      const segments = safeSegments(parsed.path);
      if (!Number.isSafeInteger(parsed.size) || parsed.size < 0) throw new Error("bad transfer frame");
      const handle: FileHandle = await open(await prepareParent(root, segments), "w");
      try {
        let left = parsed.size;
        do {
          const chunk = await next();
          if (chunk.kind !== BYTES || chunk.data.length > left) throw new Error("bad transfer frame");
          hash.add(chunk.kind, chunk.data);
          await handle.write(chunk.data);
          left -= chunk.data.length;
        } while (left > 0);
      } finally {
        await handle.close();
      }
      files += 1;
      bytes += parsed.size;
    } else {
      throw new Error("bad transfer frame");
    }
  }

  const insertEvent = db.query(
    `INSERT INTO events (task_id, seq, type, subtype, uuid, at, json)
     VALUES ($task_id, $seq, $type, $subtype, $uuid, $at, $json)`,
  );
  const insertTranscript = db.query(
    `INSERT OR IGNORE INTO transcript (project_key, session_id, subpath, seq, uuid, ts, json)
     VALUES ($project_key, $session_id, $subpath, $seq, $uuid, $ts, $json)`,
  );
  const at = new Date().toISOString();
  db.transaction(() => {
    for (const e of events) {
      insertEvent.run({
        $task_id: expect.taskId, $seq: e.seq, $type: stringField(e.json, "type"), $subtype: stringField(e.json, "subtype"),
        $uuid: stringField(e.json, "uuid"), $at: at, $json: e.json,
      });
    }
    for (const r of transcript) {
      insertTranscript.run({
        $project_key: r.projectKey, $session_id: r.sessionId, $subpath: r.subpath, $seq: r.seq, $uuid: r.uuid, $ts: r.ts, $json: r.json,
      });
    }
  })();

  return {
    manifest: head.manifest,
    settings: head.settings ?? null,
    queued: Array.isArray(head.queued) ? head.queued : [],
    turns: head.turns,
    receipt: {
      events: events.length, transcript: transcript.length, files, bytes, lastEventSeq: events.at(-1)?.seq ?? 0, sha256: hash.digest(),
    },
  };
}

/** Whether two receipts agree in every field. */
export function receiptsMatch(sent: Receipt, got: Receipt): boolean {
  return sent.events === got.events && sent.transcript === got.transcript && sent.files === got.files && sent.bytes === got.bytes
    && sent.lastEventSeq === got.lastEventSeq && sent.sha256 === got.sha256;
}
