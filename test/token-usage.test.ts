// test/token-usage.test.ts — each token's latest plan-usage reading: parsing rate-limit events, keeping the newest.
import { test, expect } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { ensureDataDirs, loadConfig, paths } from "../src/config";
import { openDb } from "../src/store/db";
import { addToken, removeToken } from "../src/token";
import { recordUsage, tokenUsages, usageReadingOf, type UsageReading } from "../src/token-usage";

const T0 = "2026-11-18T10:00:00.000Z";
const T1 = "2026-11-18T10:05:00.000Z";
const FIVE = 1793406600;
const SEVEN = 1793851200;

async function node() {
  const dir = await mkdtemp("/tmp/meddle-token-usage-");
  const cfg = loadConfig({ HOME: dir, MEDDLE_DATA_DIR: `${dir}/d`, MEDDLE_TASK_ROOT: `${dir}/t` });
  await ensureDataDirs(cfg);
  return { cfg, db: openDb(paths(cfg).db) };
}

function event(windows: unknown): unknown {
  return {
    type: "rate_limit_event",
    rate_limit_info: { status: "allowed", resetsAt: FIVE, rateLimitType: "five_hour", unifiedWindows: windows },
  };
}

const WINDOWS = {
  five_hour: { utilization: 0.27, resetsAt: FIVE, status: "allowed" },
  seven_day: { utilization: 0.33, resetsAt: SEVEN, status: "allowed" },
};

function reading(readAt: string, five = 0.27): UsageReading {
  return {
    fiveHour: { utilization: five, resetsAt: new Date(FIVE * 1000).toISOString() },
    sevenDay: { utilization: 0.33, resetsAt: new Date(SEVEN * 1000).toISOString() },
    readAt,
  };
}

test("usageReadingOf reads both windows of a rate_limit_event, reset times as ISO", () => {
  expect(usageReadingOf(event(WINDOWS), T0)).toEqual(reading(T0));
});

test("usageReadingOf takes a reset time given in milliseconds", () => {
  const ms = { five_hour: { ...WINDOWS.five_hour, resetsAt: FIVE * 1000 }, seven_day: { ...WINDOWS.seven_day, resetsAt: SEVEN * 1000 } };
  expect(usageReadingOf(event(ms), T0)).toEqual(reading(T0));
});

test("usageReadingOf leaves a missing window null, and a reset time it cannot read null", () => {
  expect(usageReadingOf(event({ seven_day: WINDOWS.seven_day }), T0)).toEqual({ ...reading(T0), fiveHour: null });
  expect(usageReadingOf(event({ five_hour: { utilization: 0.5, resetsAt: "soon" } }), T0))
    .toEqual({ fiveHour: { utilization: 0.5, resetsAt: null }, sevenDay: null, readAt: T0 });
});

test("usageReadingOf is null for anything without a numeric window", () => {
  expect(usageReadingOf(event({}), T0)).toBeNull();
  expect(usageReadingOf(event({ five_hour: { utilization: "0.2" } }), T0)).toBeNull();
  expect(usageReadingOf(event(undefined), T0)).toBeNull();
  expect(usageReadingOf({ type: "rate_limit_event" }, T0)).toBeNull();
  expect(usageReadingOf({ type: "assistant", rate_limit_info: { unifiedWindows: WINDOWS } }, T0)).toBeNull();
  expect(usageReadingOf(null, T0)).toBeNull();
});

test("recordUsage keeps the newest reading per token", async () => {
  const { cfg, db } = await node();
  const t = await addToken(cfg, db, "value-a", { setBy: null });
  expect(recordUsage(db, t.id, reading(T1, 0.4))).toBe(true);
  expect(tokenUsages(db)).toEqual({ [t.id]: reading(T1, 0.4) });
  // A reading taken earlier (another task's, delivered late) does not replace it.
  expect(recordUsage(db, t.id, reading(T0, 0.1))).toBe(false);
  expect(tokenUsages(db)[t.id]).toEqual(reading(T1, 0.4));
  expect(recordUsage(db, t.id, reading(T1, 0.5))).toBe(true);
  expect(tokenUsages(db)[t.id]).toEqual(reading(T1, 0.5));
});

test("a removed token's reading is not listed, and comes back with the token", async () => {
  const { cfg, db } = await node();
  const t = await addToken(cfg, db, "value-a", { setBy: null });
  recordUsage(db, t.id, reading(T0));
  await removeToken(cfg, db, t.id);
  expect(tokenUsages(db)).toEqual({});
  await addToken(cfg, db, "value-a", { setBy: null });
  expect(tokenUsages(db)).toEqual({ [t.id]: reading(T0) });
});

test("recordUsage refuses an id that is not a token id", async () => {
  const { db } = await node();
  expect(() => recordUsage(db, "nope", reading(T0))).toThrow("invalid token id");
});
