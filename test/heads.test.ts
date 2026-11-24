import { expect, test } from "bun:test";
import { openDb } from "../src/store/db";
import {
  allHeadRows, deleteScopeRows, headChanges, listHeadRows, mergeHeadRows, settleHeadRows, waitingHeadRows, writeHeadRow, type HeadRow,
} from "../src/pool/heads";
import { deleteProjectRows } from "../src/pool/rows";
import { markRemoved } from "../src/pool/removed";

const A = "a".repeat(40);
const B = "b".repeat(40);
const N1 = "1".repeat(64);
const N2 = "2".repeat(64);
const SCOPE = "memory/p";

function head(seq: number, extra: Partial<HeadRow> = {}): HeadRow {
  return { scope: SCOPE, node: N2, seq, commit: A, rule: 1, seed: null, edited: true, ...extra };
}

test("a write numbers itself one above the highest seq seen", () => {
  const db = openDb(":memory:");
  expect(writeHeadRow(db, N1, { scope: SCOPE, commit: A, rule: 1, seed: null, edited: true }).seq).toBe(1);
  expect(writeHeadRow(db, N1, { scope: SCOPE, commit: B, rule: 1, seed: null, edited: true }).seq).toBe(2);
  // This node's own row, come back from a peer with a higher seq after this node lost its data.
  mergeHeadRows(db, [{ ...head(7), node: N1 }]);
  expect(writeHeadRow(db, N1, { scope: SCOPE, commit: A, rule: 1, seed: null, edited: true }).seq).toBe(8);
  expect(listHeadRows(db, SCOPE).find((r) => r.node === N1)?.seq).toBe(8);
});

test("a peer's row waits until its commit is here", () => {
  const db = openDb(":memory:");
  const heard: string[] = [];
  const stop = headChanges.subscribe((s) => heard.push(s));
  try {
    expect(mergeHeadRows(db, [head(1)])).toEqual({ changed: [SCOPE], rejected: 0 });
    expect(listHeadRows(db, SCOPE)).toEqual([]);
    expect(waitingHeadRows(db, SCOPE)).toEqual([head(1)]);
    expect(settleHeadRows(db, SCOPE, new Set())).toBe(false);
    expect(settleHeadRows(db, SCOPE, new Set([A]))).toBe(true);
    expect(listHeadRows(db, SCOPE)).toEqual([head(1)]);
    expect(waitingHeadRows(db, SCOPE)).toEqual([]);
    expect(allHeadRows(db)).toEqual([head(1)]);
    expect(heard).toEqual([SCOPE, SCOPE]);
  } finally {
    stop();
  }
});

test("the greater seq wins, then the greater content", () => {
  const db = openDb(":memory:");
  mergeHeadRows(db, [head(2)]);
  mergeHeadRows(db, [head(1, { commit: B })]);
  settleHeadRows(db, SCOPE, new Set([A, B]));
  expect(listHeadRows(db, SCOPE)[0]!.commit).toBe(A);
  mergeHeadRows(db, [head(2, { commit: B })]);
  settleHeadRows(db, SCOPE, new Set([A, B]));
  expect(listHeadRows(db, SCOPE)[0]!.commit).toBe(B);
  // The losing copy changes nothing.
  expect(mergeHeadRows(db, [head(2)]).changed).toEqual([]);
});

test("a malformed row is rejected and counted", () => {
  const db = openDb(":memory:");
  const bad = [
    head(1, { scope: "nonsense" }), head(1, { commit: "xyz" }), head(1.5), head(1, { seed: "no" }),
    { ...head(1), edited: "yes" } as unknown as HeadRow, head(1, { rule: Number.NaN }),
  ];
  expect(mergeHeadRows(db, bad)).toEqual({ changed: [], rejected: bad.length });
});

test("a removed project's memory rows are skipped and refused, and go with its rows", () => {
  const db = openDb(":memory:");
  mergeHeadRows(db, [head(1)]);
  settleHeadRows(db, SCOPE, new Set([A]));
  mergeHeadRows(db, [head(1, { scope: "profile" })]);
  settleHeadRows(db, "profile", new Set([A]));
  deleteProjectRows(db, "p");
  expect(listHeadRows(db, SCOPE)).toEqual([]);
  expect(listHeadRows(db, "profile")).toHaveLength(1);
  markRemoved(db, { id: "p", name: "p", removedAt: "2026-11-24T00:00:00Z", removedBy: N1 });
  expect(mergeHeadRows(db, [head(2)])).toEqual({ changed: [], rejected: 0 });
  expect(() => writeHeadRow(db, N1, { scope: SCOPE, commit: A, rule: 1, seed: null, edited: true })).toThrow("project p was removed");
});

test("deleteScopeRows drops a scope's rows, waiting ones too", () => {
  const db = openDb(":memory:");
  mergeHeadRows(db, [head(1), head(1, { node: N1, commit: B })]);
  settleHeadRows(db, SCOPE, new Set([A]));
  deleteScopeRows(db, SCOPE);
  expect(listHeadRows(db, SCOPE)).toEqual([]);
  expect(waitingHeadRows(db, SCOPE)).toEqual([]);
});
