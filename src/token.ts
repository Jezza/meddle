// The pool's login tokens: an ordered list of Claude Code OAuth tokens. Metadata lives in the `tokens` table and
// replicates per id, last writer wins on `updatedAt`; each value is a mode-600 file under `<data>/secrets/tokens`,
// named by the token's id (the first 16 hex characters of the SHA-256 of the value) and pulled from a peer by id.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { ensurePrivateDir, paths } from "./paths";
import type { NodeConfig } from "./config";
import { isNodeId } from "./pool/ids";

/** A token id: what names its value file, so nothing else may pass for one. */
export const TOKEN_ID = /^[0-9a-f]{16}$/;

export type TokenStatus = "ok" | "exhausted" | "disabled";

/**
 * One token's metadata, never its value. `until` is when an `exhausted` token is usable again; `detail` says why it is
 * not (a limit type or an error name); `removed` rows are kept so that a removal replicates; `expiresAt` is derived
 * (`setAt` + 365 days).
 */
export type TokenMeta = {
  id: string;
  label: string;
  setAt: string;
  setBy: string | null;
  status: TokenStatus;
  until: string | null;
  detail: string | null;
  updatedAt: string;
  removed: boolean;
  expiresAt: string;
};

/** A token row as a peer sends it: its status not yet known to be one this node understands. */
export type TokenRowIn = Omit<TokenMeta, "status"> & { status: string };

export const MAX_TOKEN_LABEL = 64;
const MAX_DETAIL = 256;
const YEAR_MS = 365 * 86400_000;
const STATUSES: readonly string[] = ["ok", "exhausted", "disabled"];
/** C0 controls, DEL and C1 controls: nothing a label or detail printed on a terminal may carry. */
const CONTROL = /[\x00-\x1f\x7f-\x9f]/;
/** A time as meddle writes one (`Date.toISOString`): times compare as strings. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

type TokenRecord = {
  id: string; label: string; set_at: string; set_by: string | null; status: string; until: string | null;
  detail: string | null; updated_at: string; removed: number;
};

/** The id of a token value: the first 16 hex characters of the SHA-256 of the trimmed value. */
export function tokenId(value: string): string {
  return createHash("sha256").update(value.trim()).digest("hex").slice(0, 16);
}

/** The value file of token `id`; throws `invalid token id` unless `id` is one (the only path builder for them). */
export function tokenFile(cfg: NodeConfig, id: string): string {
  if (!TOKEN_ID.test(id)) throw new Error("invalid token id");
  return join(paths(cfg).tokensDir, id);
}

/** `setAt` + 365 days: how long a Claude Code OAuth token lasts. */
export function expiresAt(meta: { setAt: string }): string {
  return new Date(Date.parse(meta.setAt) + YEAR_MS).toISOString();
}

function metaOf(r: TokenRecord): TokenMeta {
  const meta = {
    id: r.id, label: r.label, setAt: r.set_at, setBy: r.set_by, status: r.status as TokenStatus, until: r.until,
    detail: r.detail, updatedAt: r.updated_at, removed: r.removed !== 0,
  };
  return { ...meta, expiresAt: expiresAt(meta) };
}

/** The row of token `id`, removed or not, or null. */
export function tokenRow(db: Database, id: string): TokenMeta | null {
  const r = db.query<TokenRecord, [string]>("SELECT * FROM tokens WHERE id = ?").get(id);
  return r === null ? null : metaOf(r);
}

/** The tokens in order (when they were set, then id); removed ones only when asked for. */
export function listTokens(db: Database, opts: { includeRemoved?: boolean } = {}): TokenMeta[] {
  const where = opts.includeRemoved ? "" : "WHERE removed = 0";
  return db.query<TokenRecord, []>(`SELECT * FROM tokens ${where} ORDER BY set_at, id`).all().map(metaOf);
}

function write(db: Database, t: Omit<TokenMeta, "expiresAt">): void {
  db.query(
    `INSERT INTO tokens (id, label, set_at, set_by, status, until, detail, updated_at, removed)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET label = excluded.label, set_at = excluded.set_at, set_by = excluded.set_by,
       status = excluded.status, until = excluded.until, detail = excluded.detail, updated_at = excluded.updated_at,
       removed = excluded.removed`,
  ).run(t.id, t.label, t.setAt, t.setBy, t.status, t.until, t.detail, t.updatedAt, t.removed ? 1 : 0);
}

/** A local write's time: `now`, or just after the row it supersedes when this clock is behind that row's writer. */
function after(now: string, previous: string): string {
  const next = Date.parse(previous) + 1;
  return Date.parse(now) >= next ? now : new Date(next).toISOString();
}

function labelOk(label: unknown): label is string {
  return typeof label === "string" && label.length > 0 && label.length <= MAX_TOKEN_LABEL && !CONTROL.test(label);
}

/** The token a CLI argument names among the tokens not removed: its full id, else its label (one token only). */
function resolve(db: Database, idOrLabel: string): TokenMeta {
  const live = listTokens(db);
  const byId = live.find((t) => t.id === idOrLabel);
  if (byId !== undefined) return byId;
  const byLabel = live.filter((t) => t.label === idOrLabel);
  if (byLabel.length > 1) throw new Error(`ambiguous token label: ${idOrLabel}`);
  if (byLabel.length === 0) throw new Error(`no such token: ${idOrLabel}`);
  return byLabel[0]!;
}

/** Writes token `id`'s value file (mode 600, its directory 700), replacing it whole. */
export async function writeTokenValue(cfg: NodeConfig, id: string, value: string): Promise<void> {
  const file = tokenFile(cfg, id);
  await ensurePrivateDir(paths(cfg).tokensDir);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, value, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, file);
}

/** Deletes token `id`'s value file, if there is one. */
export async function deleteTokenValue(cfg: NodeConfig, id: string): Promise<void> {
  await rm(tokenFile(cfg, id), { force: true });
}

/** Token `id`'s value, or null when its file is absent here. */
export async function tokenValue(cfg: NodeConfig, id: string): Promise<string | null> {
  const file = tokenFile(cfg, id);
  try {
    const value = (await readFile(file, "utf8")).trim();
    return value === "" ? null : value;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Adds a token (its value file first, then its row) or, for a value already listed, renames it when `label` is given
 * and brings it back when it was removed. A new token is set at `now` by `setBy` and named `label`, or the first 8
 * characters of its id.
 */
export async function addToken(
  cfg: NodeConfig, db: Database, value: string, opts: { label?: string; setBy: string | null; now?: string },
): Promise<TokenMeta> {
  const trimmed = value.trim();
  if (trimmed === "") throw new Error("empty token");
  if (opts.label !== undefined && !labelOk(opts.label)) {
    throw new Error(`invalid token label: at most ${MAX_TOKEN_LABEL} characters, none of them control characters`);
  }
  const id = tokenId(trimmed);
  const now = opts.now ?? new Date().toISOString();
  await writeTokenValue(cfg, id, trimmed);
  return db.transaction(() => {
    const local = tokenRow(db, id);
    if (local === null) {
      write(db, {
        id, label: opts.label ?? id.slice(0, 8), setAt: now, setBy: opts.setBy, status: "ok", until: null, detail: null,
        updatedAt: now, removed: false,
      });
    } else {
      const label = opts.label ?? local.label;
      if (label === local.label && !local.removed) return local;
      write(db, { ...local, label, removed: false, updatedAt: after(now, local.updatedAt) });
    }
    return tokenRow(db, id)!;
  })();
}

/**
 * Removes a token named by its full id or its label: its row is kept as `removed` (so the removal replicates) and its
 * value file is deleted last. Throws `ambiguous token label: <l>` or `no such token: <x>`.
 */
export async function removeToken(cfg: NodeConfig, db: Database, idOrLabel: string, now?: string): Promise<TokenMeta> {
  const at = now ?? new Date().toISOString();
  const removed = db.transaction(() => {
    const local = resolve(db, idOrLabel);
    write(db, { ...local, removed: true, updatedAt: after(at, local.updatedAt) });
    return tokenRow(db, local.id)!;
  })();
  await deleteTokenValue(cfg, removed.id);
  return removed;
}

/** Makes a token (full id or label) `ok` again, clearing its `until` and `detail`. */
export function enableToken(db: Database, idOrLabel: string, now?: string): TokenMeta {
  const at = now ?? new Date().toISOString();
  return db.transaction(() => {
    const local = resolve(db, idOrLabel);
    if (local.status === "ok" && local.until === null && local.detail === null) return local;
    write(db, { ...local, status: "ok", until: null, detail: null, updatedAt: after(at, local.updatedAt) });
    return tokenRow(db, local.id)!;
  })();
}

/** Sets token `id`'s status (`exhausted` until a time, `disabled`, or `ok`); null when there is no such row. */
export function markToken(
  db: Database, id: string, status: TokenStatus, until: string | null, detail: string | null, now?: string,
): TokenMeta | null {
  const at = now ?? new Date().toISOString();
  return db.transaction(() => {
    const local = tokenRow(db, id);
    if (local === null) return null;
    write(db, { ...local, status, until, detail, updatedAt: after(at, local.updatedAt) });
    return tokenRow(db, id);
  })();
}

/** Usable at `at` (ms): `ok`, or `exhausted` until a time that has passed. */
function usable(t: TokenMeta, at: number): boolean {
  if (t.status === "ok") return true;
  return t.status === "exhausted" && t.until !== null && Date.parse(t.until) <= at;
}

/** The token a turn starting at `now` uses: the first in order not removed, usable and with its value here. */
export async function pickToken(
  cfg: NodeConfig, db: Database, now?: string,
): Promise<{ id: string; label: string; value: string } | null> {
  const at = Date.parse(now ?? new Date().toISOString());
  for (const t of listTokens(db)) {
    if (!usable(t, at)) continue;
    const value = await tokenValue(cfg, t.id);
    if (value !== null) return { id: t.id, label: t.label, value };
  }
  return null;
}

/** A replicated row this node can store: an id that names a file safely, and nothing no node would write. */
function acceptable(r: TokenRowIn): r is TokenMeta {
  const time = (s: unknown) => typeof s === "string" && ISO_TIME.test(s);
  const text = (s: unknown) => s === null || (typeof s === "string" && s.length <= MAX_DETAIL && !CONTROL.test(s));
  return typeof r.id === "string" && TOKEN_ID.test(r.id)
    && labelOk(r.label)
    && STATUSES.includes(r.status)
    && time(r.setAt) && time(r.updatedAt) && (r.until === null || time(r.until))
    && (r.setBy === null || (typeof r.setBy === "string" && isNodeId(r.setBy)))
    && text(r.detail)
    && typeof r.removed === "boolean";
}

/** Everything a row carries but its id and time, as one comparable string: equal times resolve the same everywhere. */
function content(r: TokenRowIn): string {
  return JSON.stringify([r.label, r.setAt, r.setBy, r.status, r.until, r.detail, r.removed]);
}

/**
 * Merges a peer's rows: per id, the row with the later `updatedAt` wins (on equal times the greater content, so every
 * node settles on the same row). `missingValues` are accepted ids not removed whose value file is absent here (to
 * pull); `removedValues` are accepted ids now removed whose value file is still here (to delete); `rejected` are the
 * rows dropped (an id that is not a token id, a bad label, an unknown status, a malformed time, setBy or detail).
 * Touches no file: a peer's `expiresAt` is ignored.
 */
export function mergeTokens(
  cfg: NodeConfig, db: Database, rows: readonly TokenRowIn[],
): { changed: boolean; missingValues: string[]; removedValues: string[]; rejected: string[] } {
  const rejected: string[] = [];
  const accepted = new Set<string>();
  let changed = false;
  db.transaction(() => {
    for (const r of rows) {
      if (!acceptable(r)) {
        rejected.push(String(r.id));
        continue;
      }
      accepted.add(r.id);
      const local = tokenRow(db, r.id);
      if (local !== null && !(r.updatedAt > local.updatedAt || (r.updatedAt === local.updatedAt && content(r) > content(local)))) continue;
      write(db, r);
      changed = true;
    }
  })();
  const missingValues: string[] = [];
  const removedValues: string[] = [];
  for (const id of accepted) {
    const t = tokenRow(db, id)!;
    const present = existsSync(tokenFile(cfg, id));
    if (!t.removed && !present) missingValues.push(id);
    if (t.removed && present) removedValues.push(id);
  }
  return { changed, missingValues, removedValues, rejected };
}

/**
 * Imports the single token of meddle before token lists (`<data>/secrets/claude-token` and its `.meta.json`) as a token
 * labelled `default`, set when and by whom its meta says (else when the file was written, by `selfId`), then renames
 * both files to `*.migrated`. False when there is nothing to import.
 */
export async function migrateLegacyToken(cfg: NodeConfig, db: Database, selfId: string): Promise<boolean> {
  const file = join(paths(cfg).secrets, "claude-token");
  const metaFile = `${file}.meta.json`;
  let value: string;
  let setAt: string;
  try {
    value = await readFile(file, "utf8");
    setAt = (await stat(file)).mtime.toISOString();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
  let setBy: string | null = selfId;
  try {
    const meta = JSON.parse(await readFile(metaFile, "utf8")) as { setAt?: unknown; setBy?: unknown };
    if (typeof meta.setAt === "string" && ISO_TIME.test(meta.setAt)) setAt = meta.setAt;
    if (typeof meta.setBy === "string" && isNodeId(meta.setBy)) setBy = meta.setBy;
  } catch {
    // No meta (or an unreadable one): set on this node, when the file was written.
  }
  const imported = value.trim() !== "";
  if (imported) await addToken(cfg, db, value, { label: "default", setBy, now: setAt });
  await rename(file, `${file}.migrated`);
  await rename(metaFile, `${metaFile}.migrated`).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "ENOENT") throw err;
  });
  return imported;
}
