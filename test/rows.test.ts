import { Database } from "bun:sqlite";
import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/store/db";
import {
  listBranchRows, listLineRows, mergeBranchRows, mergeLineRows, rowChanges, settleBranchRows, waitingBranchRows,
  writeBranchRow, writeLineRow, type BranchRow, type LineRow,
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

/** Settles project `p`'s waiting branch rows as if every commit they name were here. */
const settleAll = (db: ReturnType<typeof openDb>) => settleBranchRows(db, "p", new Set([A, B, B.slice(0, 40)]));

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
    settleAll(db);
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
  settleAll(one);
  settleAll(two);
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
  expect(waitingBranchRows(db, "p")).toEqual([branch(1, { branch: "meddle" })]);
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

test("a peer's branch row waits, unlisted and unrelayed, until its commit is here", () => {
  const db = openDb(":memory:");
  const heard: string[] = [];
  const off = rowChanges.subscribe((project) => heard.push(project));
  try {
    mergeBranchRows(db, [branch(1, { node: N2 })]);
    expect(listBranchRows(db, "p")).toEqual([]);
    expect(waitingBranchRows(db, "p")).toEqual([branch(1, { node: N2 })]);
    // Heard of, so that the applier fetches its commit.
    expect(heard).toEqual(["p"]);
    expect(settleBranchRows(db, "p", new Set())).toBe(false);
    expect(listBranchRows(db, "p")).toEqual([]);
    expect(settleBranchRows(db, "p", new Set([A]))).toBe(true);
    expect(listBranchRows(db, "p")).toEqual([branch(1, { node: N2 })]);
    expect(waitingBranchRows(db, "p")).toEqual([]);
    expect(heard).toEqual(["p", "p"]);
  } finally {
    off();
  }
});

test("a newer row waiting for its commit leaves its writer's older row where it is", () => {
  const db = openDb(":memory:");
  mergeBranchRows(db, [branch(1, { node: N2 })]);
  settleAll(db);
  mergeBranchRows(db, [branch(2, { node: N2, commit: B })]);
  settleBranchRows(db, "p", new Set([A]));
  expect(listBranchRows(db, "p")).toEqual([branch(1, { node: N2 })]);
  expect(waitingBranchRows(db, "p")).toEqual([branch(2, { node: N2, commit: B })]);
  // An older row than the one listed is no news.
  mergeBranchRows(db, [branch(1, { node: N2, commit: B })]);
  expect(waitingBranchRows(db, "p")).toEqual([branch(2, { node: N2, commit: B })]);
  settleBranchRows(db, "p", new Set([A, B]));
  expect(listBranchRows(db, "p")).toEqual([branch(2, { node: N2, commit: B })]);
});

test("a deleting row is admitted without a commit; a row it drops still waits for its own", () => {
  const db = openDb(":memory:");
  const deleting = branch(3, { node: N2, commit: null, drops: [{ node: N1, seq: 1 }] });
  mergeBranchRows(db, [deleting, branch(1, { node: N1, commit: B })]);
  settleBranchRows(db, "p", new Set());
  expect(listBranchRows(db, "p")).toEqual([deleting]);
  expect(waitingBranchRows(db, "p")).toEqual([branch(1, { node: N1, commit: B })]);
});

test("this node's own row come back from a peer waits, and its next row goes above it keeping what it dropped", () => {
  const db = openDb(":memory:");
  mergeBranchRows(db, [branch(5, { node: N1, commit: B, drops: [{ node: N2, seq: 2 }] })]);
  const written = writeBranchRow(db, N1, { project: "p", branch: "main", commit: A, drops: [{ node: N2, seq: 3 }] });
  expect(written).toEqual(branch(6, { node: N1, commit: A, drops: [{ node: N2, seq: 3 }, { node: N2, seq: 2 }] }));
  expect(listBranchRows(db, "p")).toEqual([written]);
  expect(waitingBranchRows(db, "p")).toEqual([]);
});

test("a database from before rows waited has every branch row wait, once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "meddle-rows-"));
  try {
    const path = join(dir, "db.sqlite");
    const old = new Database(path);
    old.exec(`CREATE TABLE branch_rows (project TEXT NOT NULL, branch TEXT NOT NULL, node TEXT NOT NULL, seq INTEGER NOT NULL,
      commit_id TEXT NULL, drops TEXT NOT NULL, PRIMARY KEY (project, branch, node))`);
    old.query("INSERT INTO branch_rows VALUES ('p', 'main', ?, 1, ?, '[]')").run(N1, A);
    old.close();
    const db = openDb(path);
    expect(listBranchRows(db, "p")).toEqual([]);
    expect(waitingBranchRows(db, "p")).toEqual([branch(1)]);
    settleBranchRows(db, "p", new Set([A]));
    db.close();
    // Opened again, the admitted row stays.
    const again = openDb(path);
    expect(listBranchRows(again, "p")).toEqual([branch(1)]);
    again.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeLineRow writes above the highest seq seen for the line, a losing row's included", () => {
  const db = openDb(":memory:");
  mergeLineRows(db, [line(1, 3), line(0, 7)]);
  const { seq: _, ...rest } = line(1, 0, { holder: N2, commit: null });
  expect(writeLineRow(db, rest)).toEqual(line(1, 8, { holder: N2, commit: null }));
  expect(listLineRows(db, "p", "t")).toEqual([line(1, 8, { holder: N2, commit: null })]);
  expect(listLineRows(db, "p", "other")).toEqual([]);
});
