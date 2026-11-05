// test/tokens.test.ts — the token list: ids, add/remove/enable, picking, merging, migration and replication by id.
import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHost, memoryLinkPair } from "@earendil-works/chord";
import { ensureDataDirs, loadConfig, paths } from "../src/config";
import { NodeObject, PoolObject } from "../src/state/contracts";
import { openDb } from "../src/store/db";
import {
  TOKEN_ID, addToken, enableToken, listTokens, markToken, mergeTokens, migrateLegacyToken, moveToken, pickToken,
  removeToken, sweepTokenValues, tokenFile, tokenId, tokenValue, writeTokenValue, type TokenMeta,
} from "../src/token";
import { linkClient, twoNodes, twoPoolNodes } from "./pool-helpers";

const A = "a".repeat(64);
const B = "b".repeat(64);
const T0 = "2026-10-01T00:00:00.000Z";
const T1 = "2026-10-02T00:00:00.000Z";
const T2 = "2026-10-03T00:00:00.000Z";
const T3 = "2026-10-04T00:00:00.000Z";
const T4 = "2026-10-05T00:00:00.000Z";

async function node() {
  const dir = await mkdtemp("/tmp/meddle-tokens-");
  const cfg = loadConfig({ HOME: dir, MEDDLE_DATA_DIR: `${dir}/d`, MEDDLE_TASK_ROOT: `${dir}/t` });
  await ensureDataDirs(cfg);
  const db = openDb(paths(cfg).db);
  return { dir, cfg, db };
}

async function eventually(cond: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(20);
  }
}

/** A replicated row as a peer would send it. */
function row(over: Partial<TokenMeta> & { id: string }): TokenMeta {
  return {
    label: "x", setAt: T1, setBy: A, status: "ok", until: null, detail: null, updatedAt: T1, removed: false,
    rank: Date.parse(T1), expiresAt: "2027-10-02T00:00:00.000Z", ...over,
  };
}

test("tokenId is stable and addToken is idempotent on the value", async () => {
  const { cfg, db } = await node();
  const id = tokenId("tok-a");
  expect(id).toMatch(TOKEN_ID);
  expect(id).toBe(createHash("sha256").update("tok-a").digest("hex").slice(0, 16));
  expect(tokenId(" tok-a\r\n")).toBe(id);
  expect(tokenId("tok-b")).not.toBe(id);

  const first = await addToken(cfg, db, "tok-a\n", { label: "work", setBy: A, now: T1 });
  expect(first).toEqual({
    id, label: "work", setAt: T1, setBy: A, status: "ok", until: null, detail: null, updatedAt: T1, removed: false,
    rank: Date.parse(T1), expiresAt: "2027-10-02T00:00:00.000Z",
  });
  expect(await tokenValue(cfg, id)).toBe("tok-a");
  expect((await stat(tokenFile(cfg, id))).mode & 0o777).toBe(0o600);
  expect((await stat(paths(cfg).tokensDir)).mode & 0o777).toBe(0o700);

  // The same value again: one row, nothing changes without a label.
  const again = await addToken(cfg, db, "tok-a", { setBy: B, now: T2 });
  expect(again).toEqual(first);
  // A label given renames it; when it was set and by whom stay.
  const renamed = await addToken(cfg, db, "tok-a", { label: "main", setBy: B, now: T3 });
  expect(renamed).toMatchObject({ id, label: "main", setAt: T1, setBy: A, updatedAt: T3 });

  // A different value is a second token, after the first.
  const second = await addToken(cfg, db, "tok-b", { label: "spare", setBy: null, now: T0 });
  expect(listTokens(db).map((t) => [t.id, t.label])).toEqual([[id, "main"], [second.id, "spare"]]);
  // Without a label, a token is named after its id.
  const unnamed = await addToken(cfg, db, "tok-c", { setBy: null, now: T4 });
  expect(unnamed.label).toBe(unnamed.id.slice(0, 8));
  expect(listTokens(db)).toHaveLength(3);

  await expect(addToken(cfg, db, "  \n", { setBy: null })).rejects.toThrow("empty token");
  await expect(addToken(cfg, db, "tok-d", { label: "x".repeat(65), setBy: null })).rejects.toThrow("invalid token label");
  expect(listTokens(db)).toHaveLength(3);
});

test("pickToken skips disabled and exhausted-until-later, takes exhausted-past, skips a row without a value file", async () => {
  const { cfg, db } = await node();
  const now = "2026-11-02T12:00:00.000Z";
  const a = await addToken(cfg, db, "tok-a", { label: "a", setBy: null, now: T0 });
  const b = await addToken(cfg, db, "tok-b", { label: "b", setBy: null, now: T1 });
  const c = await addToken(cfg, db, "tok-c", { label: "c", setBy: null, now: T2 });
  const d = await addToken(cfg, db, "tok-d", { label: "d", setBy: null, now: T3 });
  expect(await pickToken(cfg, db, now)).toEqual({ id: a.id, label: "a", value: "tok-a" });

  markToken(db, a.id, "disabled", null, "billing_error");
  markToken(db, b.id, "exhausted", "2026-11-02T13:00:00.000Z", "five_hour");
  expect(listTokens(db)[0]).toMatchObject({ status: "disabled", until: null, detail: "billing_error" });
  expect(await pickToken(cfg, db, now)).toEqual({ id: c.id, label: "c", value: "tok-c" });

  // c's value file is gone (not pulled yet): the next one.
  await rm(tokenFile(cfg, c.id));
  expect(await pickToken(cfg, db, now)).toEqual({ id: d.id, label: "d", value: "tok-d" });

  // b's limit has passed by then.
  expect(await pickToken(cfg, db, "2026-11-02T13:00:00.000Z")).toEqual({ id: b.id, label: "b", value: "tok-b" });
  markToken(db, b.id, "exhausted", "2026-11-02T11:00:00.000Z", "five_hour");
  expect(await pickToken(cfg, db, now)).toEqual({ id: b.id, label: "b", value: "tok-b" });

  // enable puts a disabled token back first in order.
  const enabled = enableToken(db, "a");
  expect(enabled).toMatchObject({ id: a.id, status: "ok", until: null, detail: null });
  expect(await pickToken(cfg, db, now)).toEqual({ id: a.id, label: "a", value: "tok-a" });

  for (const id of [a.id, b.id, d.id]) markToken(db, id, "disabled", null, "authentication_failed");
  expect(await pickToken(cfg, db, now)).toBeNull();
});

test("remove deletes the value file and keeps a removed row; add again revives it; an ambiguous label is refused", async () => {
  const { cfg, db } = await node();
  const a = await addToken(cfg, db, "tok-a", { label: "work", setBy: A, now: T1 });
  const b = await addToken(cfg, db, "tok-b", { label: "home", setBy: A, now: T2 });

  const removed = await removeToken(cfg, db, "work", T3);
  expect(removed).toMatchObject({ id: a.id, label: "work", removed: true, updatedAt: T3 });
  expect(existsSync(tokenFile(cfg, a.id))).toBe(false);
  expect(listTokens(db).map((t) => t.id)).toEqual([b.id]);
  expect(listTokens(db, { includeRemoved: true }).map((t) => [t.id, t.removed])).toEqual([[a.id, true], [b.id, false]]);
  expect(await pickToken(cfg, db)).toMatchObject({ id: b.id });
  await expect(removeToken(cfg, db, "work")).rejects.toThrow("no such token: work");

  // Added again: the same row, no longer removed, its value back, at the end of the list.
  const revived = await addToken(cfg, db, "tok-a", { setBy: B, now: T4 });
  expect(revived).toMatchObject({ id: a.id, label: "work", removed: false, setAt: T1, updatedAt: T4 });
  expect(await tokenValue(cfg, a.id)).toBe("tok-a");
  expect(await pickToken(cfg, db)).toMatchObject({ id: b.id });

  // Two tokens named the same are named by id instead; an id prefix names nothing.
  const c = await addToken(cfg, db, "tok-c", { label: "home", setBy: A });
  await expect(removeToken(cfg, db, "home")).rejects.toThrow("ambiguous token label: home");
  expect(() => enableToken(db, "home")).toThrow("ambiguous token label: home");
  await expect(removeToken(cfg, db, c.id.slice(0, 8))).rejects.toThrow(`no such token: ${c.id.slice(0, 8)}`);
  expect((await removeToken(cfg, db, c.id)).id).toBe(c.id);
  expect(existsSync(tokenFile(cfg, b.id))).toBe(true);
  expect(listTokens(db).map((t) => t.id)).toEqual([b.id, a.id]);
});

test("a removed token added again goes to the end of the list, keeping when it was set and its expiry", async () => {
  const { cfg, db } = await node();
  const a = await addToken(cfg, db, "tok-a", { label: "a", setBy: A, now: T1 });
  const b = await addToken(cfg, db, "tok-b", { label: "b", setBy: A, now: T2 });
  await removeToken(cfg, db, "a", T3);
  const revived = await addToken(cfg, db, "tok-a", { setBy: B, now: T4 });
  expect(revived).toMatchObject({ id: a.id, setAt: T1, expiresAt: a.expiresAt });
  expect(listTokens(db).map((t) => t.label)).toEqual(["b", "a"]);
  expect(await pickToken(cfg, db)).toMatchObject({ id: b.id });
  // Renaming a listed token leaves it where it is.
  await addToken(cfg, db, "tok-b", { label: "b2", setBy: B, now: "2026-10-06T00:00:00.000Z" });
  expect(listTokens(db).map((t) => t.label)).toEqual(["b2", "a"]);
});

test("a new token goes to the end of the list even when this clock is behind the last token's", async () => {
  const { cfg, db } = await node();
  await addToken(cfg, db, "tok-a", { label: "a", setBy: A, now: T2 });
  const b = await addToken(cfg, db, "tok-b", { label: "b", setBy: A, now: T1 });
  expect(b.setAt).toBe(T1);
  expect(listTokens(db).map((t) => t.label)).toEqual(["a", "b"]);
});

test("moveToken puts a token before or after another, writing only the moved row", async () => {
  const { cfg, db } = await node();
  await addToken(cfg, db, "tok-a", { label: "a", setBy: A, now: T0 });
  await addToken(cfg, db, "tok-b", { label: "b", setBy: A, now: T1 });
  await addToken(cfg, db, "tok-c", { label: "c", setBy: A, now: T2 });
  const labels = () => listTokens(db).map((t) => t.label);
  const others = (moved: string) => JSON.stringify(listTokens(db).filter((t) => t.label !== moved));

  let before = others("c");
  const moved = moveToken(db, "c", { before: "a" }, T3);
  expect(moved).toMatchObject({ label: "c", updatedAt: T3, setAt: T2 });
  expect(labels()).toEqual(["c", "a", "b"]);
  expect(others("c")).toBe(before);

  before = others("c");
  moveToken(db, "c", { after: "b" }, T4);
  expect(labels()).toEqual(["a", "b", "c"]);
  expect(others("c")).toBe(before);

  before = others("a");
  moveToken(db, "a", { after: "b" });
  expect(labels()).toEqual(["b", "a", "c"]);
  expect(others("a")).toBe(before);

  moveToken(db, "c", { before: "a" });
  expect(labels()).toEqual(["b", "c", "a"]);
  // Already there: nothing is written.
  const rows = JSON.stringify(listTokens(db));
  expect(moveToken(db, "c", { before: "a" })).toMatchObject({ label: "c" });
  expect(moveToken(db, "c", { after: "b" })).toMatchObject({ label: "c" });
  expect(JSON.stringify(listTokens(db))).toBe(rows);
  // A new token still goes to the end.
  await addToken(cfg, db, "tok-d", { label: "d", setBy: A });
  expect(labels()).toEqual(["b", "c", "a", "d"]);
});

test("moveToken refuses a token moved against itself, an unknown token and an ambiguous label", async () => {
  const { cfg, db } = await node();
  const a = await addToken(cfg, db, "tok-a", { label: "a", setBy: A, now: T0 });
  await addToken(cfg, db, "tok-b", { label: "dup", setBy: A, now: T1 });
  await addToken(cfg, db, "tok-c", { label: "dup", setBy: A, now: T2 });
  await addToken(cfg, db, "tok-d", { label: "gone", setBy: A, now: T3 });
  await removeToken(cfg, db, "gone");
  const rows = JSON.stringify(listTokens(db, { includeRemoved: true }));
  expect(() => moveToken(db, "a", { before: a.id })).toThrow("cannot move a token before or after itself");
  expect(() => moveToken(db, "nope", { before: "a" })).toThrow("no such token: nope");
  expect(() => moveToken(db, "a", { after: "nope" })).toThrow("no such token: nope");
  expect(() => moveToken(db, "a", { after: "gone" })).toThrow("no such token: gone");
  expect(() => moveToken(db, "dup", { after: "a" })).toThrow("ambiguous token label: dup");
  expect(() => moveToken(db, "a", { before: "dup" })).toThrow("ambiguous token label: dup");
  expect(JSON.stringify(listTokens(db, { includeRemoved: true }))).toBe(rows);
});

test("moves that run out of room between two tokens renumber the list, keeping its order", async () => {
  const { cfg, db } = await node();
  await addToken(cfg, db, "tok-a", { label: "a", setBy: A, now: T0 });
  await addToken(cfg, db, "tok-b", { label: "b", setBy: A, now: "2026-10-01T00:00:00.001Z" });
  await addToken(cfg, db, "tok-c", { label: "c", setBy: A, now: "2026-10-01T00:00:00.002Z" });
  // Each move halves the gap after a: without renumbering, two ranks would soon be equal.
  for (let i = 0; i < 100; i++) {
    moveToken(db, "c", { before: "b" });
    expect(listTokens(db).map((t) => t.label)).toEqual(["a", "c", "b"]);
    moveToken(db, "b", { before: "c" });
    expect(listTokens(db).map((t) => t.label)).toEqual(["a", "b", "c"]);
  }
  const ranks = listTokens(db).map((t) => t.rank);
  expect(new Set(ranks).size).toBe(3);
});

test("an empty value file is no value: mergeTokens names it missing, and writeTokenValue replaces it", async () => {
  const { cfg, db } = await node();
  const a = await addToken(cfg, db, "tok-a", { label: "a", setBy: A, now: T1 });
  await writeFile(tokenFile(cfg, a.id), "  \n", { mode: 0o600 });
  expect(await tokenValue(cfg, a.id)).toBeNull();
  expect(mergeTokens(cfg, db, [row({ ...a, updatedAt: T1 })]).missingValues).toEqual([a.id]);
  await writeTokenValue(cfg, a.id, "tok-a");
  expect(await tokenValue(cfg, a.id)).toBe("tok-a");
  expect((await stat(tokenFile(cfg, a.id))).mode & 0o777).toBe(0o600);
  expect(mergeTokens(cfg, db, [row({ ...a, updatedAt: T1 })]).missingValues).toEqual([]);
  expect((await readdir(paths(cfg).tokensDir)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
});

test("mergeTokens is last writer wins per id, names missing values, and rejects path-like ids, long labels and unknown statuses", async () => {
  const { cfg, db } = await node();
  const a = await addToken(cfg, db, "tok-a", { label: "a", setBy: A, now: T1 });
  const canary = paths(cfg).irohKey;
  await writeFile(canary, "key", { mode: 0o600 });
  const secretsBefore = (await readdir(paths(cfg).secrets)).sort();

  // Older than the local row: kept as it is.
  expect(mergeTokens(cfg, db, [row({ ...a, label: "old", updatedAt: T0 })])).toEqual({ changed: false, missingValues: [], removedValues: [], rejected: [] });
  expect(listTokens(db)[0]!.label).toBe("a");
  // Newer: taken (its expiresAt is derived here, not taken).
  expect(mergeTokens(cfg, db, [row({ ...a, label: "new", updatedAt: T2, expiresAt: "1999-01-01T00:00:00.000Z" })]))
    .toEqual({ changed: true, missingValues: [], removedValues: [], rejected: [] });
  expect(listTokens(db)[0]).toMatchObject({ label: "new", expiresAt: "2027-10-02T00:00:00.000Z" });
  // The same again changes nothing.
  expect(mergeTokens(cfg, db, [row({ ...a, label: "new", updatedAt: T2 })]).changed).toBe(false);

  // A new id whose value is not here yet.
  const x = tokenId("tok-x");
  expect(mergeTokens(cfg, db, [row({ id: x, label: "x" })])).toEqual({ changed: true, missingValues: [x], removedValues: [], rejected: [] });
  // A removal of a token whose value is here.
  expect(mergeTokens(cfg, db, [row({ ...a, label: "new", removed: true, updatedAt: T3 })]))
    .toEqual({ changed: true, missingValues: [], removedValues: [a.id], rejected: [] });
  expect(listTokens(db).map((t) => t.id)).toEqual([x]);

  // Equal times converge on one row whichever arrives first.
  const tie1 = row({ id: tokenId("tok-t"), label: "one", updatedAt: T4 });
  const tie2 = row({ id: tokenId("tok-t"), label: "two", updatedAt: T4 });
  const other = await node();
  mergeTokens(cfg, db, [tie1]);
  mergeTokens(cfg, db, [tie2]);
  mergeTokens(other.cfg, other.db, [tie2]);
  mergeTokens(other.cfg, other.db, [tie1]);
  const label = (rows: TokenMeta[]) => rows.find((t) => t.id === tie1.id)!.label;
  expect(label(listTokens(db))).toBe(label(listTokens(other.db)));

  // Rows that could name a file outside the tokens directory, or that no node writes, are dropped.
  const bad = [
    row({ id: "../iroh.key" }),
    row({ id: "../../meddle.sqlite", removed: true }),
    row({ id: tokenId("tok-y"), label: "y".repeat(65) }),
    row({ id: tokenId("tok-z"), status: "weird" as TokenMeta["status"] }),
    row({ id: tokenId("tok-w"), label: "\u001b[2Jhi" }),
  ];
  expect(mergeTokens(cfg, db, bad)).toEqual({
    changed: false, missingValues: [], removedValues: [], rejected: ["../iroh.key", "../../meddle.sqlite", tokenId("tok-y"), tokenId("tok-z"), tokenId("tok-w")],
  });
  expect(listTokens(db, { includeRemoved: true }).map((t) => t.id).sort()).toEqual([a.id, x, tie1.id].sort());
  expect((await readdir(paths(cfg).secrets)).sort()).toEqual(secretsBefore);
  expect(await readFile(canary, "utf8")).toBe("key");
});

test("mergeTokens orders a row without a rank (an older node's) by when it was set, takes a newer row's rank, and rejects a bad rank", async () => {
  const { cfg, db } = await node();
  const a = await addToken(cfg, db, "tok-a", { label: "a", setBy: A, now: T1 });
  const b = await addToken(cfg, db, "tok-b", { label: "b", setBy: A, now: T2 });

  // An older node's row has no rank: it sorts by when it was set.
  const { rank: _, ...old } = row({ id: tokenId("tok-o"), label: "o", setAt: T0, updatedAt: T0 });
  expect(mergeTokens(cfg, db, [old as TokenMeta]).rejected).toEqual([]);
  expect(listTokens(db).map((t) => t.label)).toEqual(["o", "a", "b"]);
  expect(listTokens(db)[0]!.rank).toBe(Date.parse(T0));

  // A peer moved b first: its newer row's rank is taken.
  expect(mergeTokens(cfg, db, [row({ ...b, rank: Date.parse(T0) - 1000, updatedAt: T3 })]).changed).toBe(true);
  expect(listTokens(db).map((t) => t.label)).toEqual(["b", "o", "a"]);

  // A rank that is not a finite number is dropped.
  const bad = [
    row({ ...a, rank: Number.NaN, updatedAt: T4 }),
    row({ ...a, rank: Number.POSITIVE_INFINITY, updatedAt: T4 }),
    row({ ...a, rank: "1" as unknown as number, updatedAt: T4 }),
    row({ ...a, rank: null as unknown as number, updatedAt: T4 }),
  ];
  expect(mergeTokens(cfg, db, bad)).toMatchObject({ changed: false, rejected: [a.id, a.id, a.id, a.id] });
  expect(listTokens(db).map((t) => t.label)).toEqual(["b", "o", "a"]);
});

test("tokenFile refuses an invalid id", async () => {
  const { cfg } = await node();
  const id = tokenId("tok-a");
  expect(tokenFile(cfg, id)).toBe(join(paths(cfg).tokensDir, id));
  for (const bad of ["../iroh.key", "", id.slice(0, 15), `${id}0`, id.toUpperCase(), `${id.slice(0, 15)}/`]) {
    expect(() => tokenFile(cfg, bad)).toThrow("invalid token id");
  }
  await expect(tokenValue(cfg, "../iroh.key")).rejects.toThrow("invalid token id");
});

test("migrateLegacyToken imports the single token once as default, and no copy of the value stays behind", async () => {
  const { cfg, db } = await node();
  const legacy = join(paths(cfg).secrets, "claude-token");
  await writeFile(legacy, "tok-legacy\n", { mode: 0o600 });
  await writeFile(`${legacy}.meta.json`, JSON.stringify({ setAt: T1, setBy: A }), { mode: 0o600 });

  expect(await migrateLegacyToken(cfg, db, B)).toBe(true);
  const id = tokenId("tok-legacy");
  expect(listTokens(db)).toEqual([{
    id, label: "default", setAt: T1, setBy: A, status: "ok", until: null, detail: null, updatedAt: T1, removed: false,
    rank: Date.parse(T1), expiresAt: "2027-10-02T00:00:00.000Z",
  }]);
  expect(await tokenValue(cfg, id)).toBe("tok-legacy");
  expect(existsSync(legacy)).toBe(false);
  expect(existsSync(`${legacy}.migrated`)).toBe(false);
  expect(existsSync(`${legacy}.meta.json`)).toBe(false);
  expect(existsSync(`${legacy}.meta.json.migrated`)).toBe(true);
  expect((await readdir(paths(cfg).secrets)).sort()).toEqual(["claude-token.meta.json.migrated", "tokens"]);

  expect(await migrateLegacyToken(cfg, db, B)).toBe(false);
  expect(listTokens(db)).toHaveLength(1);

  // Without its meta file the token was set on this node, when the file was written.
  const bare = await node();
  const file = join(paths(bare.cfg).secrets, "claude-token");
  await writeFile(file, "tok-bare", { mode: 0o600 });
  const mtime = (await stat(file)).mtime.toISOString();
  expect(await migrateLegacyToken(bare.cfg, bare.db, B)).toBe(true);
  expect(listTokens(bare.db)).toEqual([expect.objectContaining({ id: tokenId("tok-bare"), label: "default", setAt: mtime, setBy: B })]);
  expect(existsSync(file)).toBe(false);
});

test("markToken refuses a mark a peer would drop", async () => {
  const { cfg, db } = await node();
  const a = await addToken(cfg, db, "tok-a", { label: "a", setBy: null, now: T0 });
  const bad: Array<[string, string | null, string | null]> = [
    ["weird", null, null],
    ["exhausted", "tomorrow", null],
    ["exhausted", "2026-11-02T13:00:00Z", null],
    ["disabled", null, "x".repeat(257)],
    ["disabled", null, "bad\u001b[2J"],
  ];
  for (const [status, until, detail] of bad) {
    expect(() => markToken(db, a.id, status as TokenMeta["status"], until, detail)).toThrow("invalid token mark");
  }
  expect(listTokens(db)[0]).toMatchObject({ status: "ok", until: null, detail: null, updatedAt: T0 });
  expect(markToken(db, a.id, "exhausted", "2026-11-02T13:00:00.000Z", "five_hour")).toMatchObject({ status: "exhausted" });
  expect(markToken(db, tokenId("tok-none"), "disabled", null, null)).toBeNull();
});

test("a crash-orphaned .tmp and a removed token's value are swept, and a .tmp is never read as a value", async () => {
  const { cfg, db } = await node();
  const a = await addToken(cfg, db, "tok-a", { label: "a", setBy: null, now: T0 });
  const b = await addToken(cfg, db, "tok-b", { label: "b", setBy: null, now: T1 });
  const c = await addToken(cfg, db, "tok-c", { label: "c", setBy: null, now: T2 });
  await removeToken(cfg, db, "b");
  // A crash left a's value half-written (the file itself gone), and b's value after its removal committed.
  await rm(tokenFile(cfg, a.id));
  await writeFile(`${tokenFile(cfg, a.id)}.4242.tmp`, "tok-a", { mode: 0o600 });
  await writeFile(tokenFile(cfg, b.id), "tok-b", { mode: 0o600 });
  expect(await tokenValue(cfg, a.id)).toBeNull();
  expect(await pickToken(cfg, db)).toMatchObject({ id: c.id });

  expect(await sweepTokenValues(cfg, db)).toBe(2);
  expect(await readdir(paths(cfg).tokensDir)).toEqual([c.id]);
  expect(await sweepTokenValues(cfg, db)).toBe(0);
  const empty = await node();
  expect(await sweepTokenValues(empty.cfg, empty.db)).toBe(0);
});

test("a value pull that failed is retried at the next refresh, with no token row changing", async () => {
  const { a, b, start, close } = await twoNodes({ start: false });
  try {
    // A lists the token but holds no value yet (as a member that merged the row before pulling it would).
    const added = await addToken(a.cfg, a.db, "tok-a", { label: "a", setBy: a.id });
    await rm(tokenFile(a.cfg, added.id));
    const rowsOfA = JSON.stringify(listTokens(a.db, { includeRemoved: true }));
    start();
    await eventually(() => b.errors.some((e) => String(e).includes("the token's value is not on this node")));
    expect(await tokenValue(b.cfg, added.id)).toBeNull();

    // The value arrives on A without its row changing: B asks again on its own.
    await writeTokenValue(a.cfg, added.id, "tok-a");
    const since = Date.now();
    await eventually(async () => (await tokenValue(b.cfg, added.id)) === "tok-a", 20_000);
    expect(Date.now() - since).toBeLessThan(20_000);
    expect(JSON.stringify(listTokens(a.db, { includeRemoved: true }))).toBe(rowsOfA);
    expect(JSON.stringify(listTokens(b.db, { includeRemoved: true }))).toBe(rowsOfA);
  } finally {
    await close();
  }
}, 40_000);

test("two nodes adding the same token value end with one token", async () => {
  const { A: na, B: nb, close } = await twoPoolNodes({ nodes: [{ token: null }, { token: null }] });
  try {
    await addToken(na.cfg, na.db, "tok-a", { label: "from-a", setBy: na.id });
    await na.pool.tokenChanged();
    await addToken(nb.cfg, nb.db, "tok-a", { label: "from-b", setBy: nb.id });
    await nb.pool.tokenChanged();
    const same = () => JSON.stringify(listTokens(na.db)) === JSON.stringify(listTokens(nb.db));
    await eventually(() => same() && listTokens(na.db)[0]?.label === "from-b");
    expect(listTokens(na.db).map((t) => t.id)).toEqual([tokenId("tok-a")]);
    expect(listTokens(nb.db).map((t) => t.id)).toEqual([tokenId("tok-a")]);
    expect([...na.errors, ...nb.errors].map(String)).toEqual([]);
  } finally {
    await close();
  }
}, 30_000);

test("a token added on A is pulled by B and B's pickToken returns its value; a removal on A deletes B's file", async () => {
  const { A: na, B: nb, close } = await twoPoolNodes({ nodes: [{ token: null }, { token: null }] });
  const linked = linkClient(nb.host);
  try {
    const pool = await linked.client.get(PoolObject, {});
    if (pool.variant !== "default") throw new Error("expected the default variant");
    const nodeB = await linked.client.get(NodeObject, {});
    expect(pool.activeTokenId.value).toBeNull();
    expect(nodeB.token.value).toEqual({ present: false, expiresAt: null });
    expect(await pickToken(nb.cfg, nb.db)).toBeNull();

    const added = await addToken(na.cfg, na.db, "tok-a", { label: "a", setBy: na.id });
    await na.pool.tokenChanged();
    const start = Date.now();
    await eventually(async () => (await pickToken(nb.cfg, nb.db))?.value === "tok-a");
    expect(Date.now() - start).toBeLessThan(10_000);
    expect((await stat(tokenFile(nb.cfg, added.id))).mode & 0o777).toBe(0o600);
    await eventually(() => pool.activeTokenId.value === added.id && pool.tokens.value.length === 1);
    expect(pool.tokens.value[0]).toMatchObject({ id: added.id, label: "a", setBy: na.id, status: "ok", removed: false });
    await eventually(() => nodeB.token.value.present && nodeB.token.value.expiresAt === added.expiresAt);

    await removeToken(na.cfg, na.db, "a");
    await na.pool.tokenChanged();
    await eventually(() => !existsSync(tokenFile(nb.cfg, added.id)));
    expect(listTokens(nb.db)).toEqual([]);
    expect(listTokens(nb.db, { includeRemoved: true })).toEqual([expect.objectContaining({ id: added.id, removed: true })]);
    expect(await pickToken(nb.cfg, nb.db)).toBeNull();
    await eventually(() => pool.activeTokenId.value === null && pool.tokens.value.length === 0);
    await eventually(() => !nodeB.token.value.present && nodeB.token.value.expiresAt === null);
    expect([...na.errors, ...nb.errors].map(String)).toEqual([]);
    pool.release();
    nodeB.release();
  } finally {
    await linked.close();
    await close();
  }
}, 30_000);

test("fetchToken refuses an unknown id before touching the filesystem", async () => {
  const { a, b, close } = await twoNodes({ start: false });
  const [down, up] = memoryLinkPair();
  const probe = createHost({ name: "probe", self: "probe", kind: "client", upstream: { link: up, principal: "node" } });
  try {
    const known = await addToken(b.cfg, b.db, "tok-a", { label: "a", setBy: b.id });
    const gone = await addToken(b.cfg, b.db, "tok-gone", { label: "gone", setBy: b.id });
    await removeToken(b.cfg, b.db, gone.id);
    b.host.accept(down, { principal: `peer:${a.id}`, kind: "client" });
    const pool = await probe.get(PoolObject, {});
    if (pool.variant !== "peer") throw new Error("expected the peer variant");
    expect((await pool.fetchToken({ id: known.id })).value === "tok-a").toBe(true);
    // A path, an id with no row and a removed id are all unknown: the table is asked first, so `tokenFile`'s own
    // refusal (`invalid token id`) is never reached.
    for (const id of ["../../iroh.key", tokenId("tok-never"), gone.id]) {
      let refusal: unknown = null;
      await pool.fetchToken({ id }).catch((err: unknown) => { refusal = err; });
      expect(refusal).toMatchObject({ code: "forbidden" });
      expect(String((refusal as Error).message)).toContain("unknown token");
    }
    pool.release();
  } finally {
    await probe.close();
    await close();
  }
}, 15_000);
