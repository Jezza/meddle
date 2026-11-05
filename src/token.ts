// The pool's login tokens: an ordered list of Claude Code OAuth tokens. Metadata lives in the `tokens` table and
// replicates per id, last writer wins on `updatedAt`; each value is a mode-600 file under `<data>/secrets/tokens`,
// named by the token's id (the first 16 hex characters of the SHA-256 of the value) and pulled from a peer by id.
// The order is each row's `rank`, a number kept apart from `setAt` (which the expiry derives from): adding a token, or
// adding a removed one again, puts it last; `moveToken` puts it between two others by rewriting its own row alone.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
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
 * not (a limit type or an error name); `removed` rows are kept so that a removal replicates; `rank` orders the list
 * (ascending, then by id); `expiresAt` is derived (`setAt` + 365 days).
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
  rank: number;
  expiresAt: string;
};

/**
 * A token row as a peer sends it: its status not yet known to be one this node understands, and no `rank` from a node
 * of a meddle before ranks (such a row sorts by when it was set).
 */
export type TokenRowIn = Omit<TokenMeta, "status" | "rank"> & { status: string; rank?: unknown };

export const MAX_TOKEN_LABEL = 64;
const MAX_DETAIL = 256;
const YEAR_MS = 365 * 86400_000;
/** The rank gap a move to either end of the list leaves, and between tokens when the list is renumbered. */
const RANK_STEP = 1000;
const STATUSES: readonly string[] = ["ok", "exhausted", "disabled"];
/** C0 controls, DEL and C1 controls: nothing a label or detail printed on a terminal may carry. */
const CONTROL = /[\x00-\x1f\x7f-\x9f]/;
/** A time as meddle writes one (`Date.toISOString`): times compare as strings. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

type TokenRecord = {
  id: string; label: string; set_at: string; set_by: string | null; status: string; until: string | null;
  detail: string | null; updated_at: string; removed: number; rank: number | null;
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
    detail: r.detail, updatedAt: r.updated_at, removed: r.removed !== 0, rank: r.rank ?? Date.parse(r.set_at),
  };
  return { ...meta, expiresAt: expiresAt(meta) };
}

/** The row of token `id`, removed or not, or null. */
export function tokenRow(db: Database, id: string): TokenMeta | null {
  const r = db.query<TokenRecord, [string]>("SELECT * FROM tokens WHERE id = ?").get(id);
  return r === null ? null : metaOf(r);
}

/** The tokens in order (by rank, then id); removed ones only when asked for. */
export function listTokens(db: Database, opts: { includeRemoved?: boolean } = {}): TokenMeta[] {
  const where = opts.includeRemoved ? "" : "WHERE removed = 0";
  return db.query<TokenRecord, []>(`SELECT * FROM tokens ${where}`).all().map(metaOf)
    .sort((x, y) => x.rank - y.rank || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

/** The rank that puts a token last: `now`, or just after the last token not removed when this clock is behind it. */
function lastRank(db: Database, now: string, except?: string): number {
  const ranks = listTokens(db).filter((t) => t.id !== except).map((t) => t.rank);
  return Math.max(Date.parse(now), ...ranks.map((r) => r + 1));
}

function write(db: Database, t: Omit<TokenMeta, "expiresAt">): void {
  db.query(
    `INSERT INTO tokens (id, label, set_at, set_by, status, until, detail, updated_at, removed, rank)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET label = excluded.label, set_at = excluded.set_at, set_by = excluded.set_by,
       status = excluded.status, until = excluded.until, detail = excluded.detail, updated_at = excluded.updated_at,
       removed = excluded.removed, rank = excluded.rank`,
  ).run(t.id, t.label, t.setAt, t.setBy, t.status, t.until, t.detail, t.updatedAt, t.removed ? 1 : 0, t.rank);
}

/** A local write's time: `now`, or just after the row it supersedes when this clock is behind that row's writer. */
function after(now: string, previous: string): string {
  const next = Date.parse(previous) + 1;
  return Date.parse(now) >= next ? now : new Date(next).toISOString();
}

/** Null, or at most 256 characters with no control characters. */
function detailOk(detail: unknown): boolean {
  return detail === null || (typeof detail === "string" && detail.length <= MAX_DETAIL && !CONTROL.test(detail));
}

function labelOk(label: unknown): label is string {
  return typeof label === "string" && label.length > 0 && label.length <= MAX_TOKEN_LABEL && !CONTROL.test(label);
}

/**
 * The token a CLI argument names among the tokens not removed: its full id, else its label (one token only). Throws
 * `ambiguous token label: <l>` or `no such token: <x>`.
 */
export function findToken(db: Database, idOrLabel: string): TokenMeta {
  const live = listTokens(db);
  const byId = live.find((t) => t.id === idOrLabel);
  if (byId !== undefined) return byId;
  const byLabel = live.filter((t) => t.label === idOrLabel);
  if (byLabel.length > 1) throw new Error(`ambiguous token label: ${idOrLabel}`);
  if (byLabel.length === 0) throw new Error(`no such token: ${idOrLabel}`);
  return byLabel[0]!;
}

let tmpSeq = 0;

/**
 * Writes token `id`'s value file (mode 600, its directory 700), replacing it whole. The file and the rename are on disk
 * when it returns, so a caller may delete another copy of the value (the legacy file, on migration) after it.
 */
export async function writeTokenValue(cfg: NodeConfig, id: string, value: string): Promise<void> {
  const file = tokenFile(cfg, id);
  const dir = paths(cfg).tokensDir;
  await ensurePrivateDir(dir);
  // Unique per call: a pull and a CLI-less add of the same value may write it at once in one process.
  const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
  const handle = await open(tmp, "w", 0o600);
  try {
    await handle.writeFile(value);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(tmp, 0o600);
  await rename(tmp, file);
  const dirHandle = await open(dir, "r");
  try {
    await dirHandle.sync();
  } finally {
    await dirHandle.close();
  }
}

/** Whether token `id`'s value is here: its file exists and holds more than blanks (what `tokenValue` would read). */
export function hasTokenValue(cfg: NodeConfig, id: string): boolean {
  try {
    return readFileSync(tokenFile(cfg, id), "utf8").trim() !== "";
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
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
 * characters of its id. A new token and a removed one brought back go last in the order (a removed one keeps when it
 * was set, so its expiry); a rename leaves a token where it is.
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
        updatedAt: now, removed: false, rank: lastRank(db, now),
      });
    } else {
      const label = opts.label ?? local.label;
      if (label === local.label && !local.removed) return local;
      const rank = local.removed ? lastRank(db, now, id) : local.rank;
      write(db, { ...local, label, removed: false, rank, updatedAt: after(now, local.updatedAt) });
    }
    return tokenRow(db, id)!;
  }).immediate();
}

/**
 * Removes a token named by its full id or its label: its row is kept as `removed` (so the removal replicates) and its
 * value file is deleted last. Throws `ambiguous token label: <l>` or `no such token: <x>`.
 */
export async function removeToken(cfg: NodeConfig, db: Database, idOrLabel: string, now?: string): Promise<TokenMeta> {
  const at = now ?? new Date().toISOString();
  const removed = db.transaction(() => {
    const local = findToken(db, idOrLabel);
    write(db, { ...local, removed: true, updatedAt: after(at, local.updatedAt) });
    return tokenRow(db, local.id)!;
  }).immediate();
  await deleteTokenValue(cfg, removed.id);
  return removed;
}

/**
 * Puts a token (full id or label) just before or just after another in the order, rewriting its own row alone: its
 * rank goes halfway between its new neighbours' (a step past the end one at either end). When two neighbours' ranks
 * are too close for a number between them, the list is renumbered a step apart, rewriting only the rows whose rank
 * changes. A token already there is left as it is. Throws `cannot move a token before or after itself`,
 * `ambiguous token label: <l>` or `no such token: <x>`.
 */
export function moveToken(
  db: Database, idOrLabel: string, to: { before: string } | { after: string }, now?: string,
): TokenMeta {
  const at = now ?? new Date().toISOString();
  return db.transaction(() => {
    const moving = findToken(db, idOrLabel);
    const anchor = findToken(db, "before" in to ? to.before : to.after);
    if (anchor.id === moving.id) throw new Error("cannot move a token before or after itself");
    const current = listTokens(db);
    const rest = current.filter((t) => t.id !== moving.id);
    const index = rest.findIndex((t) => t.id === anchor.id) + ("before" in to ? 0 : 1);
    const prev = rest[index - 1];
    const next = rest[index];
    const wanted = [...rest.slice(0, index), moving, ...rest.slice(index)];
    if (wanted.every((t, i) => t.id === current[i]!.id)) return moving;
    const lo = prev?.rank ?? next!.rank - 2 * RANK_STEP;
    const hi = next?.rank ?? prev!.rank + 2 * RANK_STEP;
    const rank = (lo + hi) / 2;
    if (lo < rank && rank < hi) {
      write(db, { ...moving, rank, updatedAt: after(at, moving.updatedAt) });
    } else {
      const base = wanted[0]!.id === moving.id ? wanted[1]!.rank : wanted[0]!.rank;
      wanted.forEach((t, i) => {
        const r = base + i * RANK_STEP;
        if (t.rank !== r) write(db, { ...t, rank: r, updatedAt: after(at, t.updatedAt) });
      });
    }
    return tokenRow(db, moving.id)!;
  }).immediate();
}

/** Makes a token (full id or label) `ok` again, clearing its `until` and `detail`. */
export function enableToken(db: Database, idOrLabel: string, now?: string): TokenMeta {
  const at = now ?? new Date().toISOString();
  return db.transaction(() => {
    const local = findToken(db, idOrLabel);
    if (local.status === "ok" && local.until === null && local.detail === null) return local;
    write(db, { ...local, status: "ok", until: null, detail: null, updatedAt: after(at, local.updatedAt) });
    return tokenRow(db, local.id)!;
  }).immediate();
}

/**
 * Sets token `id`'s status (`exhausted` until a time, `disabled`, or `ok`); null when there is no such row. Throws
 * `invalid token mark` for anything a peer would drop: a status other than the three, an `until` that is not an ISO
 * time (`Date.toISOString`) or null, a `detail` over 256 characters or with control characters.
 */
export function markToken(
  db: Database, id: string, status: TokenStatus, until: string | null, detail: string | null, now?: string,
): TokenMeta | null {
  if (!STATUSES.includes(status) || !(until === null || ISO_TIME.test(until)) || !detailOk(detail)) {
    throw new Error("invalid token mark: a status of ok, exhausted or disabled, an ISO time or null, a short detail");
  }
  const at = now ?? new Date().toISOString();
  return db.transaction(() => {
    const local = tokenRow(db, id);
    if (local === null) return null;
    write(db, { ...local, status, until, detail, updatedAt: after(at, local.updatedAt) });
    return tokenRow(db, id);
  }).immediate();
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

/**
 * A replicated row this node can store: an id that names a file safely, and nothing no node would write. A row with
 * no `rank` (a node of a meddle before ranks) is given the one that sorts it by when it was set.
 */
function acceptable(r: TokenRowIn): TokenMeta | null {
  const time = (s: unknown) => typeof s === "string" && ISO_TIME.test(s);
  const rank = r.rank === undefined && time(r.setAt) ? Date.parse(r.setAt) : r.rank;
  const ok = typeof r.id === "string" && TOKEN_ID.test(r.id)
    && labelOk(r.label)
    && STATUSES.includes(r.status)
    && time(r.setAt) && time(r.updatedAt) && (r.until === null || time(r.until))
    && (r.setBy === null || (typeof r.setBy === "string" && isNodeId(r.setBy)))
    && detailOk(r.detail)
    && typeof r.removed === "boolean"
    && typeof rank === "number" && Number.isFinite(rank);
  return ok ? { ...(r as TokenMeta), rank: rank as number } : null;
}

/** Everything a row carries but its id and time, as one comparable string: equal times resolve the same everywhere. */
function content(r: TokenMeta): string {
  return JSON.stringify([r.label, r.setAt, r.setBy, r.status, r.until, r.detail, r.removed, r.rank]);
}

/**
 * Merges a peer's rows: per id, the row with the later `updatedAt` wins (on equal times the greater content, so every
 * node settles on the same row). `missingValues` are accepted ids not removed whose value file is absent here (to
 * pull); `removedValues` are accepted ids now removed whose value file is still here (to delete); `rejected` are the
 * rows dropped (an id that is not a token id, a bad label, an unknown status, a malformed time, setBy or detail, a rank
 * that is not a finite number).
 * Touches no file: a peer's `expiresAt` is ignored.
 */
export function mergeTokens(
  cfg: NodeConfig, db: Database, rows: readonly TokenRowIn[],
): { changed: boolean; missingValues: string[]; removedValues: string[]; rejected: string[] } {
  const rejected: string[] = [];
  const accepted = new Set<string>();
  let changed = false;
  db.transaction(() => {
    for (const row of rows) {
      const r = acceptable(row);
      if (r === null) {
        rejected.push(String(row.id));
        continue;
      }
      accepted.add(r.id);
      const local = tokenRow(db, r.id);
      if (local !== null && !(r.updatedAt > local.updatedAt || (r.updatedAt === local.updatedAt && content(r) > content(local)))) continue;
      write(db, r);
      changed = true;
    }
  }).immediate();
  const missingValues: string[] = [];
  const removedValues: string[] = [];
  for (const id of accepted) {
    const t = tokenRow(db, id)!;
    // An empty value file is no value: pull one over it. Any file of a removed token goes.
    if (!t.removed && !hasTokenValue(cfg, id)) missingValues.push(id);
    if (t.removed && existsSync(tokenFile(cfg, id))) removedValues.push(id);
  }
  return { changed, missingValues, removedValues, rejected };
}

/**
 * Imports the single token of meddle before token lists (`<data>/secrets/claude-token` and its `.meta.json`) as a token
 * labelled `default`, set when and by whom its meta says (else when the file was written, by `selfId`). Once the value
 * is in `tokens/<id>`, the meta file is renamed to `*.migrated` and the old value file deleted, so that no copy of the
 * value outlives the token's removal. False when there is nothing to import.
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
  await rename(metaFile, `${metaFile}.migrated`).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "ENOENT") throw err;
  });
  await rm(file, { force: true });
  return imported;
}

/**
 * Removes what a crash can leave in the tokens directory: a half-written `*.tmp` (never read as a value: only a file
 * named by a token id is) and the value of a token that is removed. Run at `serve` start. Returns how many it removed.
 */
export async function sweepTokenValues(cfg: NodeConfig, db: Database): Promise<number> {
  let names: string[];
  try {
    names = await readdir(paths(cfg).tokensDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
  let removed = 0;
  for (const name of names) {
    const stray = name.endsWith(".tmp") || (TOKEN_ID.test(name) && tokenRow(db, name)?.removed === true);
    if (!stray) continue;
    await rm(join(paths(cfg).tokensDir, name), { force: true });
    removed += 1;
  }
  return removed;
}
