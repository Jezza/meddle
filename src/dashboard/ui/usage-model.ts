// The usage meters of the task bar and Settings: a task's context fill, and a token's 5-hour and 7-day plan usage.
import type { UsageWindow } from "../../token-usage";
import { ago, tokens, usageShort } from "./sidebar-model";

export type Level = "ok" | "warn" | "bad";

/** How old a reading may be before its meters fade. */
export const STALE_MS = 30 * 60_000;

/**
 * One meter: its `label` (`ctx`, `5h`, `7d`), the share filled (NaN: no bar, the whole is not known), its `text`, its
 * colour `level`, whether it is `faded` (stale or reset), its tooltip `title`, and a `note` for where there is room.
 */
export type Meter = { label: string; fraction: number; text: string; level: Level; faded: boolean; title: string; note: string | null };

/** `bad` from 95% used, `warn` from 80%. */
export function levelOf(fraction: number): Level {
  return fraction >= 0.95 ? "bad" : fraction >= 0.8 ? "warn" : "ok";
}

/** A count as `tokens` writes it, but a whole number of millions without its `.0` (a window of `1M`). */
function windowText(n: number): string {
  return tokens(n).replace(/\.0M$/, "M");
}

/**
 * The context meter of a task: its latest call's tokens over the context window of that call's model in the latest
 * result's `modelUsage` (`375k / 1M`); the count alone while that window is not known. Null before its first call.
 */
export function contextMeter(context: { tokens: number; model: string | null } | null | undefined, contextUsage: unknown): Meter | null {
  if (context === null || context === undefined) return null;
  const { modelUsage } = (contextUsage ?? {}) as { modelUsage?: Record<string, { contextWindow?: unknown }> | null };
  const size = context.model === null ? undefined : modelUsage?.[context.model]?.contextWindow;
  const window = typeof size === "number" && size > 0 ? size : null;
  const fraction = window === null ? NaN : context.tokens / window;
  const latest = usageShort(contextUsage);
  const title = [
    `${context.tokens.toLocaleString("en-US")}${window === null ? "" : ` of ${window.toLocaleString("en-US")}`} tokens of context`
      + (context.model === null ? "" : ` · ${context.model}`),
    ...(latest === null ? [] : [`latest turn: ${latest}`]),
  ].join("\n");
  return {
    label: "ctx",
    fraction,
    text: window === null ? tokens(context.tokens) : `${tokens(context.tokens)} / ${windowText(window)}`,
    level: window === null ? "ok" : levelOf(fraction),
    faded: false,
    title,
    note: null,
  };
}

/** When a window resets: its time today, else its weekday and time. */
function resetText(at: number, now: number): string {
  const time: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString();
  return sameDay ? new Date(at).toLocaleTimeString([], time) : new Date(at).toLocaleString([], { weekday: "short", ...time });
}

/**
 * The meter of one plan-usage window of a reading taken at `readAt`, at `now` (ms): its share used, clamped to 100%;
 * once its reset has passed, 0%, faded, `reset`. Faded too when the reading is older than `STALE_MS`. Null for none.
 */
export function windowMeter(label: "5h" | "7d", w: UsageWindow | null, readAt: string, now: number): Meter | null {
  if (w === null) return null;
  const resets = w.resetsAt === null ? null : Date.parse(w.resetsAt);
  const reset = resets !== null && resets <= now;
  const fraction = reset ? 0 : Math.min(1, Math.max(0, w.utilization));
  const percent = `${Math.round(fraction * 100)}%`;
  const note = reset ? "reset" : resets === null ? null : `resets ${resetText(resets, now)}`;
  const name = label === "5h" ? "5-hour" : "7-day";
  return {
    label,
    fraction,
    text: percent,
    level: levelOf(fraction),
    faded: reset || now - Date.parse(readAt) > STALE_MS,
    title: `${name} limit: ${percent} used${note === null ? "" : `, ${note}`}`,
    note,
  };
}

/** `read 2m ago`. */
export function readAgo(readAt: string, now: number): string {
  return `read ${ago(now - Date.parse(readAt))} ago`;
}
