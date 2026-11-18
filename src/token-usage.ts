// Each token's latest plan-usage reading on this node: how much of its 5-hour and 7-day claude.ai limits it has used,
// as the `rate_limit_event`s of the turns run with it report. Claude Code emits one about every API call, whatever its
// status, and its `rate_limit_info.unifiedWindows` (not in the SDK's types) carries both windows. Readings live in the
// `token_usage` table, are never replicated, and are only read joined to the tokens not removed.
import type { Database } from "bun:sqlite";
import type { NodeConfig } from "./config";
import { listTokens, pickToken, TOKEN_ID } from "./token";

/** One limit window: the share of it used (0–1, as the API sends it, so it may pass 1) and when it resets (ISO). */
export type UsageWindow = { utilization: number; resetsAt: string | null };

/** A token's usage as one `rate_limit_event` said, at `readAt`; a window the event did not carry is null. */
export type UsageReading = { fiveHour: UsageWindow | null; sevenDay: UsageWindow | null; readAt: string };

type UsageRecord = {
  token_id: string; five_hour_utilization: number | null; five_hour_resets_at: string | null;
  seven_day_utilization: number | null; seven_day_resets_at: string | null; read_at: string;
};

/** A window of `unifiedWindows`, or null: its `utilization` a finite number, its `resetsAt` unix seconds (ms when that large). */
function windowOf(value: unknown): UsageWindow | null {
  const w = value as { utilization?: unknown; resetsAt?: unknown } | null | undefined;
  if (typeof w?.utilization !== "number" || !Number.isFinite(w.utilization)) return null;
  const at = w.resetsAt;
  const ms = typeof at === "number" && Number.isFinite(at) && at > 0 ? (at < 1e12 ? at * 1000 : at) : null;
  const resetsAt = ms === null || Number.isNaN(new Date(ms).getTime()) ? null : new Date(ms).toISOString();
  return { utilization: w.utilization, resetsAt };
}

/** The reading an SDK message carries, taken at `readAt`: null unless it is a `rate_limit_event` with a window. */
export function usageReadingOf(m: unknown, readAt: string): UsageReading | null {
  const msg = m as { type?: unknown; rate_limit_info?: { unifiedWindows?: Record<string, unknown> } } | null;
  if (msg?.type !== "rate_limit_event") return null;
  const windows = msg.rate_limit_info?.unifiedWindows;
  const fiveHour = windowOf(windows?.five_hour);
  const sevenDay = windowOf(windows?.seven_day);
  return fiveHour === null && sevenDay === null ? null : { fiveHour, sevenDay, readAt };
}

/**
 * Keeps `reading` as token `id`'s, unless the one kept was read later (another task's, taken after it). True when it
 * was written. Throws `invalid token id` unless `id` is one.
 */
export function recordUsage(db: Database, id: string, reading: UsageReading): boolean {
  if (!TOKEN_ID.test(id)) throw new Error("invalid token id");
  const { fiveHour: f, sevenDay: s } = reading;
  const result = db.query(
    `INSERT INTO token_usage (token_id, five_hour_utilization, five_hour_resets_at, seven_day_utilization,
       seven_day_resets_at, read_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (token_id) DO UPDATE SET five_hour_utilization = excluded.five_hour_utilization,
       five_hour_resets_at = excluded.five_hour_resets_at, seven_day_utilization = excluded.seven_day_utilization,
       seven_day_resets_at = excluded.seven_day_resets_at, read_at = excluded.read_at
     WHERE excluded.read_at >= token_usage.read_at`,
  ).run(id, f?.utilization ?? null, f?.resetsAt ?? null, s?.utilization ?? null, s?.resetsAt ?? null, reading.readAt);
  return result.changes > 0;
}

/** The readings of the tokens not removed, by token id. */
export function tokenUsages(db: Database): Record<string, UsageReading> {
  const rows = db.query<UsageRecord, []>(
    "SELECT u.* FROM token_usage u JOIN tokens t ON t.id = u.token_id WHERE t.removed = 0",
  ).all();
  const win = (utilization: number | null, resetsAt: string | null) => (utilization === null ? null : { utilization, resetsAt });
  return Object.fromEntries(rows.map((r) => [r.token_id, {
    fiveHour: win(r.five_hour_utilization, r.five_hour_resets_at),
    sevenDay: win(r.seven_day_utilization, r.seven_day_resets_at),
    readAt: r.read_at,
  }]));
}

/**
 * The token this node's next turn uses (`pickToken`), with its reading here (null: none yet). With none usable, the
 * first in order, so that what ran out still shows until it resets; null when there is no token at all.
 */
export async function activeUsage(
  cfg: NodeConfig, db: Database,
): Promise<{ tokenId: string; label: string; reading: UsageReading | null } | null> {
  const token = (await pickToken(cfg, db)) ?? listTokens(db)[0] ?? null;
  if (token === null) return null;
  return { tokenId: token.id, label: token.label, reading: tokenUsages(db)[token.id] ?? null };
}
