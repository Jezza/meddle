import { Database } from "bun:sqlite";
import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/store/db";
import {
  deleteProjectRows, lineChanges, listBranchRows, listLineRows, mergeBranchRows, mergeLineRows, rowChanges, setQueued, settleBranchRows, waitingBranchRows,
  writeBranchRow, writeLineRow, type BranchRow, type LineRow,
} from "../src/pool/rows";
import { holdLineRows, reclaimLineRows, releaseLineRows } from "../src/projects/lines";
import { shortId } from "../src/pool/ids";
import { markRemoved } from "../src/pool/removed";
import { LineRowSchema } from "../src/state/contracts";

const A = "a".repeat(40);
const B = "b".repeat(64);
const N1 = "1".repeat(64);
const N2 = "2".repeat(64);

function line(epoch: number, seq: number, extra: Partial<LineRow> = {}): LineRow {
  return { project: "p", task: "t", name: "w", holder: N1, epoch, seq, commit: A, base: [B], archived: false, queuedAt: null, ...extra };
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

const QUEUED = "2026-11-18T10:00:00.000Z";

/** `row` as a node of a meddle before queues sends it: no `queuedAt` at all. */
function withoutQueue(row: LineRow): Omit<LineRow, "queuedAt"> {
  const { queuedAt: _, ...rest } = row;
  return rest;
}

test("queuedAt replicates through merge", () => {
  const one = openDb(":memory:");
  const two = openDb(":memory:");
  const { seq: _, queuedAt: __, ...first } = line(0, 0);
  writeLineRow(one, first);
  const queued = setQueued(one, "p", "t", "w", QUEUED);
  // Everything else as it was, written above the line's seq.
  expect(queued).toEqual(line(0, 2, { queuedAt: QUEUED }));
  expect(listLineRows(one)).toEqual([queued]);

  const heard: Array<{ project: string; task: string }> = [];
  const off = lineChanges.subscribe((l) => heard.push(l));
  try {
    expect(mergeLineRows(two, listLineRows(one))).toEqual({ changed: ["p"], rejected: 0 });
    expect(heard).toEqual([{ project: "p", task: "t" }]);
  } finally {
    off();
  }
  expect(listLineRows(two)).toEqual([queued]);

  // Unqueued, it replicates the same way: the newer row wins with its null.
  const cleared = setQueued(one, "p", "t", "w", null);
  expect(cleared).toEqual(line(0, 3, { queuedAt: null }));
  mergeLineRows(two, [cleared]);
  expect(listLineRows(two)).toEqual([cleared]);

  // A row with no line to hold it has no queue to set.
  expect(() => setQueued(one, "p", "t", "other", QUEUED)).toThrow("no line row");
});

test("queuedAt is part of the wire row, and a row with something else there is dropped", async () => {
  const { Value } = await import("typebox/value");
  expect(Value.Check(LineRowSchema, line(0, 1, { queuedAt: QUEUED }))).toBe(true);
  expect(Value.Check(LineRowSchema, line(0, 1))).toBe(true);
  expect(Value.Check(LineRowSchema, withoutQueue(line(0, 1)))).toBe(true);

  const db = openDb(":memory:");
  expect(mergeLineRows(db, [line(0, 1, { queuedAt: 7 as unknown as string })])).toEqual({ changed: [], rejected: 1 });
  expect(listLineRows(db)).toEqual([]);
});

test("a row from a node of a meddle before queues is stored with no queue", () => {
  const db = openDb(":memory:");
  expect(mergeLineRows(db, [withoutQueue(line(0, 1))])).toEqual({ changed: ["p"], rejected: 0 });
  expect(listLineRows(db)).toEqual([line(0, 1, { queuedAt: null })]);
});

test("writers that omit queuedAt keep it", () => {
  const db = openDb(":memory:");
  const self = N1;
  const { seq: _, queuedAt: __, ...first } = line(0, 0);
  writeLineRow(db, first);
  setQueued(db, "p", "t", "w", QUEUED);
  const queued = () => listLineRows(db, "p", "t").map((r) => [r.name, r.queuedAt]);

  // A write that moves the line, one that says nothing of the queue, and one that says null.
  const moved = writeLineRow(db, { ...first, commit: B.slice(0, 40) });
  expect(moved).toMatchObject({ commit: B.slice(0, 40), queuedAt: QUEUED });
  expect(writeLineRow(db, { ...first, queuedAt: undefined })).toMatchObject({ queuedAt: QUEUED });
  expect(queued()).toEqual([["w", QUEUED]]);
  expect(writeLineRow(db, { ...first, queuedAt: null })).toMatchObject({ queuedAt: null });
  setQueued(db, "p", "t", "w", QUEUED);

  // The handovers and the release in src/projects/lines.ts pass no queue either.
  expect(holdLineRows(db, N2, "t")).toEqual(["w"]);
  expect(listLineRows(db, "p", "t")).toMatchObject([{ holder: N2, epoch: 1, queuedAt: QUEUED }]);
  expect(reclaimLineRows(db, self, "t", false)).toEqual(["w"]);
  expect(listLineRows(db, "p", "t")).toMatchObject([{ holder: self, epoch: 2, queuedAt: QUEUED }]);
  expect(releaseLineRows(db, "t", [])).toEqual(["w"]);
  expect(listLineRows(db, "p", "t")).toMatchObject([{ commit: null, queuedAt: QUEUED }]);

  // A write of a key with no row yet has no queue to keep.
  expect(writeLineRow(db, { ...first, name: "x" })).toMatchObject({ queuedAt: null });
});

test("an older relay without the field doesn't clear it", () => {
  const db = openDb(":memory:");
  const queued = line(0, 4, { queuedAt: QUEUED });
  mergeLineRows(db, [queued]);
  // The same row as a node of a meddle before queues relays it: equal epoch, seq and content, and no queue.
  expect(mergeLineRows(db, [withoutQueue(queued)])).toEqual({ changed: [], rejected: 0 });
  expect(listLineRows(db)).toEqual([queued]);
});

test("rows of an equal key, seq and content, differing only in queuedAt, settle on the queued one in either order", () => {
  const queued = line(0, 4, { queuedAt: QUEUED });
  const later = line(0, 4, { queuedAt: "2026-11-18T11:00:00.000Z" });
  const relayed = withoutQueue(line(0, 4));
  for (const order of [[queued, relayed], [relayed, queued], [relayed, later, queued], [queued, later, relayed]]) {
    const db = openDb(":memory:");
    for (const row of order) mergeLineRows(db, [row]);
    expect(listLineRows(db)).toEqual([order.includes(later) ? later : queued]);
  }
});

test("a database from before queues gets the column, its rows unqueued, and keeps writing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "meddle-rows-"));
  try {
    const path = join(dir, "db.sqlite");
    const old = new Database(path);
    old.exec(`CREATE TABLE line_rows (project TEXT NOT NULL, task TEXT NOT NULL, name TEXT NOT NULL, holder TEXT NOT NULL,
      epoch INTEGER NOT NULL, seq INTEGER NOT NULL, commit_id TEXT NULL, base TEXT NOT NULL, archived INTEGER NOT NULL,
      seen_seq INTEGER NOT NULL, PRIMARY KEY (project, task, name))`);
    old.query("INSERT INTO line_rows VALUES ('p', 't', 'w', ?, 0, 3, ?, ?, 0, 3)").run(N1, A, JSON.stringify([B]));
    old.close();
    const db = openDb(path);
    expect(listLineRows(db)).toEqual([line(0, 3)]);
    expect(setQueued(db, "p", "t", "w", QUEUED)).toEqual(line(0, 4, { queuedAt: QUEUED }));
    db.close();
    // Opened again, the column is not added twice, and the queue stays.
    const again = openDb(path);
    expect(listLineRows(again)).toEqual([line(0, 4, { queuedAt: QUEUED })]);
    again.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const removal = (id: string) => ({ id, name: id, removedAt: "2026-11-23T10:00:00.000Z", removedBy: N1 });

test("rows of a removed project are dropped and not written", () => {
  const db = openDb(":memory:");
  markRemoved(db, removal("p"));
  const lineMerge = mergeLineRows(db, [line(1, 1), line(1, 1, { project: "q" })]);
  expect(lineMerge).toEqual({ changed: ["q"], rejected: 0 });
  const branchMerge = mergeBranchRows(db, [branch(1), branch(1, { project: "q" })]);
  expect(branchMerge).toEqual({ changed: ["q"], rejected: 0 });
  expect(listLineRows(db, "p")).toEqual([]);
  expect(waitingBranchRows(db, "p")).toEqual([]);
  expect(listLineRows(db, "q")).toHaveLength(1);
  expect(waitingBranchRows(db, "q")).toHaveLength(1);
  const removed = `project ${shortId("p")} was removed`;
  expect(() => writeLineRow(db, { project: "p", task: "t", name: "w", holder: N1, epoch: 1, commit: A, base: [], archived: false })).toThrow(removed);
  expect(() => setQueued(db, "p", "t", "w", "2026-11-23T10:00:00.000Z")).toThrow(removed);
  expect(() => writeBranchRow(db, N1, { project: "p", branch: "main", commit: A, drops: [] })).toThrow(removed);
  expect(listLineRows(db, "p")).toEqual([]);
  expect(waitingBranchRows(db, "p")).toEqual([]);
  expect(listBranchRows(db, "p")).toEqual([]);
});

test("deleteProjectRows clears all three tables of one project only", () => {
  const db = openDb(":memory:");
  for (const project of ["p", "q"]) {
    mergeLineRows(db, [line(1, 1, { project })]);
    mergeBranchRows(db, [branch(1, { project }), branch(1, { project, branch: "dev" })]);
    settleBranchRows(db, project, new Set([A]));
    mergeBranchRows(db, [branch(2, { project })]);
  }
  expect(listBranchRows(db, "p")).toHaveLength(2);
  expect(waitingBranchRows(db, "p")).toHaveLength(1);
  const told: string[] = [];
  const stop = rowChanges.subscribe((project) => told.push(project));
  deleteProjectRows(db, "p");
  stop();
  expect(told).toEqual(["p"]);
  expect([listLineRows(db, "p"), listBranchRows(db, "p"), waitingBranchRows(db, "p")]).toEqual([[], [], []]);
  expect(listLineRows(db, "q")).toHaveLength(1);
  expect(listBranchRows(db, "q")).toHaveLength(2);
  expect(waitingBranchRows(db, "q")).toHaveLength(1);
});

test("reclaimLineRows skips a removed project and reclaims the rest", () => {
  const db = openDb(":memory:");
  mergeLineRows(db, [line(1, 1, { project: "p" }), line(1, 1, { project: "q" })]);
  markRemoved(db, removal("p"));
  expect(reclaimLineRows(db, N2, "t", false)).toEqual(["w"]);
  expect(listLineRows(db, "q")).toMatchObject([{ holder: N2, epoch: 2 }]);
  expect(listLineRows(db, "p")).toMatchObject([{ holder: N1, epoch: 1, seq: 1 }]);
  expect(holdLineRows(db, N2, "t")).toEqual([]);
  expect(releaseLineRows(db, "t", [])).toEqual(["w"]);
  expect(listLineRows(db, "p")).toMatchObject([{ holder: N1, epoch: 1, seq: 1, commit: A }]);
});
