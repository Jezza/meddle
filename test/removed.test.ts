import { test, expect } from "bun:test";
import { openDb } from "../src/store/db";
import { isRemoved, listRemoved, markRemoved, mergeRemoved, removedChanges, removedIds, type RemovedProject } from "../src/pool/removed";

const N1 = "1".repeat(64);

function entry(id: string, extra: Partial<RemovedProject> = {}): RemovedProject {
  return { id, name: id, removedAt: "2026-11-23T10:00:00.000Z", removedBy: N1, ...extra };
}

test("markRemoved adds once and keeps the first entry", () => {
  const db = openDb(":memory:");
  expect(markRemoved(db, entry("a", { name: "first" }))).toBe(true);
  expect(markRemoved(db, entry("a", { name: "second" }))).toBe(false);
  expect(listRemoved(db)).toEqual([entry("a", { name: "first" })]);
  expect(isRemoved(db, "a")).toBe(true);
  expect(isRemoved(db, "b")).toBe(false);
});

test("listRemoved orders by time, then id", () => {
  const db = openDb(":memory:");
  markRemoved(db, entry("c", { removedAt: "2026-11-23T10:00:00.000Z" }));
  markRemoved(db, entry("b", { removedAt: "2026-11-23T11:00:00.000Z" }));
  markRemoved(db, entry("a", { removedAt: "2026-11-23T11:00:00.000Z" }));
  expect(listRemoved(db).map((r) => r.id)).toEqual(["c", "a", "b"]);
  expect(removedIds(db)).toEqual(new Set(["a", "b", "c"]));
});

test("mergeRemoved returns only new ids and skips malformed rows", () => {
  const db = openDb(":memory:");
  markRemoved(db, entry("a"));
  const added = mergeRemoved(db, [entry("a"), entry("b"), entry("../x"), entry("c", { removedAt: "yesterday" })]);
  expect(added).toEqual(["b"]);
  expect(isRemoved(db, "../x")).toBe(false);
  expect(isRemoved(db, "c")).toBe(false);
});

test("removedChanges tells each new id", () => {
  const db = openDb(":memory:");
  const told: string[] = [];
  const stop = removedChanges.subscribe((id) => told.push(id));
  mergeRemoved(db, [entry("a"), entry("a"), entry("b")]);
  markRemoved(db, entry("b"));
  stop();
  mergeRemoved(db, [entry("c")]);
  expect(told).toEqual(["a", "b"]);
});

test("mergeRemoved settles on the earliest entry of an id, then the one of the smaller node id, in any order", () => {
  const early = entry("a", { name: "early", removedAt: "2026-11-23T09:00:00.000Z" });
  const late = entry("a", { name: "late", removedAt: "2026-11-23T10:00:00.000Z" });
  const low = entry("b", { name: "low", removedBy: "0".repeat(64) });
  const high = entry("b", { name: "high" });
  for (const order of [[early, late, high, low], [late, early, low, high]]) {
    const db = openDb(":memory:");
    const told: string[] = [];
    const stop = removedChanges.subscribe((id) => told.push(id));
    const added = order.flatMap((e) => mergeRemoved(db, [e]));
    stop();
    expect(listRemoved(db)).toEqual([early, low]);
    // A replaced entry is not a new id.
    expect(added).toEqual(["a", "b"]);
    expect(told).toEqual(["a", "b"]);
  }
  // Both in one batch too.
  const db = openDb(":memory:");
  expect(mergeRemoved(db, [late, high, early, low])).toEqual(["a", "b"]);
  expect(listRemoved(db)).toEqual([early, low]);
});
