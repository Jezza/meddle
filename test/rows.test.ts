import { test, expect } from "bun:test";
import { openDb } from "../src/store/db";
import {
  listBranchRows, listLineRows, mergeBranchRows, mergeLineRows, rowChanges, writeBranchRow, writeLineRow,
  type BranchRow, type LineRow,
} from "../src/pool/rows";

const A = "a".repeat(40);
const B = "b".repeat(64);
const N1 = "1".repeat(64);
const N2 = "2".repeat(64);

function line(epoch: number, seq: number, extra: Partial<LineRow> = {}): LineRow {
  return { project: "p", task: "t", name: "w", holder: N1, epoch, seq, commit: A, base: [B], archived: false, ...extra };
}

function branch(seq: number, extra: Partial<BranchRow> = {}): BranchRow {
  return { project: "p", branch: "main", node: N1, seq, commit: A, drops: [], ...extra };
}

test("a line row with the greater (epoch, seq) wins in either order of arrival", () => {
  for (const order of [[line(0, 5), line(1, 1)], [line(1, 1), line(0, 5)]]) {
    const db = openDb(":memory:");
    for (const row of order) mergeLineRows(db, [row]);
    expect(listLineRows(db)).toEqual([line(1, 1)]);
  }
});

test("a branch row with the greater seq wins in either order of arrival", () => {
  for (const order of [[branch(3, { commit: B }), branch(4)], [branch(4), branch(3, { commit: B })]]) {
    const db = openDb(":memory:");
    for (const row of order) mergeBranchRows(db, [row]);
    expect(listBranchRows(db, "p")).toEqual([branch(4)]);
  }
});

test("rows of an equal key and seq settle on the same row on two databases", () => {
  const lines = [line(2, 2, { commit: A }), line(2, 2, { commit: B.slice(0, 40) })];
  const branches = [branch(2, { commit: A }), branch(2, { commit: null, drops: [{ node: N2, seq: 1 }] })];
  const one = openDb(":memory:");
  const two = openDb(":memory:");
  for (const row of lines) mergeLineRows(one, [row]);
  for (const row of [...lines].reverse()) mergeLineRows(two, [row]);
  for (const row of branches) mergeBranchRows(one, [row]);
  for (const row of [...branches].reverse()) mergeBranchRows(two, [row]);
  expect(listLineRows(one)).toHaveLength(1);
  expect(listLineRows(one)).toEqual(listLineRows(two));
  expect(listBranchRows(one, "p")).toHaveLength(1);
  expect(listBranchRows(one, "p")).toEqual(listBranchRows(two, "p"));
});

test("a merge reports the projects it changed, and rowChanges fires for each", () => {
  const db = openDb(":memory:");
  const heard: string[] = [];
  const off = rowChanges.subscribe((project) => heard.push(project));
  try {
    expect(mergeLineRows(db, [line(0, 1), line(0, 1, { project: "q" })])).toEqual({ changed: ["p", "q"], rejected: 0 });
    // The same rows again change nothing.
    expect(mergeLineRows(db, [line(0, 1)])).toEqual({ changed: [], rejected: 0 });
    expect(mergeBranchRows(db, [branch(1)])).toEqual({ changed: ["p"], rejected: 0 });
    expect(heard).toEqual(["p", "q", "p"]);
  } finally {
    off();
  }
});

test("each malformed row is dropped and counted", () => {
  const db = openDb(":memory:");
  const badLines = [
    line(0, 1, { commit: "abc" }),
    line(0, 1, { commit: "a".repeat(41) }),
    line(0, 1, { commit: "g".repeat(40) }),
    line(0, 1, { base: [A, "nope"] }),
    line(0, 1, { task: "a/b" }),
    line(0, 1, { task: ".." }),
    line(0, 1, { task: "" }),
    line(0, 1.5),
    line(0, Number.NaN),
    line(0, "3" as unknown as number),
  ];
  expect(mergeLineRows(db, [...badLines, line(0, 1)])).toEqual({ changed: ["p"], rejected: badLines.length });
  expect(listLineRows(db)).toEqual([line(0, 1)]);

  const badBranches = [
    branch(1, { commit: "abc" }),
    branch(1, { commit: B + "b" }),
    branch(1, { branch: "a..b" }),
    branch(1, { branch: "-x" }),
    branch(1, { branch: "HEAD" }),
    branch(1, { branch: "" }),
    branch(1, { branch: "meddle/task/t/w" }),
    branch(1.5),
    branch(1, { drops: [{ node: N2, seq: 0.5 }] }),
  ];
  expect(mergeBranchRows(db, [...badBranches, branch(1, { branch: "meddle" })])).toEqual({ changed: ["p"], rejected: badBranches.length });
  expect(listBranchRows(db, "p")).toEqual([branch(1, { branch: "meddle" })]);
});

test("a branch name is refused exactly when `git check-ref-format --branch` refuses it", () => {
  const names = [
    "main", "a/b", "@", "@x", "a@b", "é", "foo/HEAD", "release-1.2", "HEAD", "-x", ".x", "a/.b", "a.lock", "a/b.lock/c",
    "a.lock/b", "a..b", "a.", ".", "a/", "/a", "a//b", "a b", "a~", "a^", "a:", "a?", "a*", "a[", "a\\b", "a@{",
    "@{-1}", "a\x7f", "a\tb", "a\x01",
  ];
  const db = openDb(":memory:");
  for (const name of names) {
    const git = Bun.spawnSync(["git", "check-ref-format", "--branch", name], { cwd: "/" });
    const merged = mergeBranchRows(db, [branch(1, { branch: name })]);
    expect({ name, rejected: merged.rejected }).toEqual({ name, rejected: git.exitCode === 0 ? 0 : 1 });
  }
});

test("writeBranchRow after merging a peer's copy of this node's own row at seq 7 writes seq 8", () => {
  const db = openDb(":memory:");
  mergeBranchRows(db, [branch(7, { node: N1 })]);
  const written = writeBranchRow(db, N1, { project: "p", branch: "main", commit: B, drops: [{ node: N2, seq: 3 }] });
  expect(written).toEqual({ project: "p", branch: "main", node: N1, seq: 8, commit: B, drops: [{ node: N2, seq: 3 }] });
  expect(listBranchRows(db, "p", "main")).toEqual([written]);
  // Another node's row of the same branch is a row of its own.
  expect(writeBranchRow(db, N2, { project: "p", branch: "main", commit: A, drops: [] }).seq).toBe(1);
});

test("writeLineRow writes above the highest seq seen for the line, a losing row's included", () => {
  const db = openDb(":memory:");
  mergeLineRows(db, [line(1, 3), line(0, 7)]);
  const { seq: _, ...rest } = line(1, 0, { holder: N2, commit: null });
  expect(writeLineRow(db, rest)).toEqual(line(1, 8, { holder: N2, commit: null }));
  expect(listLineRows(db, "p", "t")).toEqual([line(1, 8, { holder: N2, commit: null })]);
  expect(listLineRows(db, "p", "other")).toEqual([]);
});
