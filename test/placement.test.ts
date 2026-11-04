// test/placement.test.ts — where a new task runs: the rules of `place`, and the candidates read from the roster.
import { test, expect } from "bun:test";
import { nodeOf } from "../src/pool/object";
import { place, placementCandidates, type Candidate } from "../src/pool/placement";
import type { RosterRow } from "../src/pool/store";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

function node(nodeId: string, extra: Partial<Candidate> = {}): Candidate {
  return { nodeId, online: true, hostsTasks: true, running: 0, taskCount: 0, projects: [], limit: 0, ...extra };
}

test("the primary project's home is preferred when it can take the task", () => {
  const nodes = [
    node(A, { projects: [{ id: "p", home: B }] }),
    node(B, { running: 3, taskCount: 9, projects: [{ id: "p", home: B }] }),
    node(C),
  ];
  expect(place({ projectIds: ["p"], nodes })).toEqual({ nodeId: B });
});

test("with the home offline, a node holding a replica of every project is preferred", () => {
  const nodes = [
    node(A, { running: 2, projects: [{ id: "p", home: B }, { id: "q", home: A }] }),
    node(B, { online: false, projects: [{ id: "p", home: B }] }),
    node(C, { running: 0 }),
  ];
  expect(place({ projectIds: ["p", "q"], nodes })).toEqual({ nodeId: A });
  // A node holding only some of the projects is no holder.
  const partial = [node(A, { running: 2, projects: [{ id: "p", home: B }] }), node(B, { online: false, projects: [{ id: "p", home: B }] }), node(C)];
  expect(place({ projectIds: ["p", "q"], nodes: partial })).toEqual({ nodeId: C });
});

test("among replica holders, the fewest running wins", () => {
  const p = [{ id: "p", home: C }];
  const nodes = [node(A, { running: 2, projects: p }), node(B, { running: 1, projects: p }), node(C, { hostsTasks: false, projects: p })];
  expect(place({ projectIds: ["p"], nodes })).toEqual({ nodeId: B });
});

test("with no holder: fewest running, then fewest tasks, then the smaller id", () => {
  expect(place({ projectIds: ["p"], nodes: [node(A, { running: 2 }), node(B, { running: 1, taskCount: 5 }), node(C, { running: 1, taskCount: 4 })] }))
    .toEqual({ nodeId: C });
  expect(place({ projectIds: ["p"], nodes: [node(C, { running: 1, taskCount: 4 }), node(B, { running: 1, taskCount: 4 })] }))
    .toEqual({ nodeId: B });
});

test("a node at its running limit is skipped, even the home", () => {
  const nodes = [
    node(A, { running: 1, limit: 1, projects: [{ id: "p", home: A }] }),
    node(B, { running: 4, limit: 5 }),
    node(C, { running: 2, limit: 2 }),
  ];
  expect(place({ projectIds: ["p"], nodes })).toEqual({ nodeId: B });
});

test("limit 0 is unlimited", () => {
  expect(place({ projectIds: ["p"], nodes: [node(A, { running: 50, limit: 0, projects: [{ id: "p", home: A }] }), node(B)] }))
    .toEqual({ nodeId: A });
});

test("offline nodes and nodes without a task root are never chosen; the errors say why", () => {
  expect(place({ projectIds: ["p"], nodes: [node(A, { online: false }), node(B, { hostsTasks: false })] }))
    .toEqual({ error: "no online node hosts tasks" });
  expect(place({ projectIds: [], nodes: [] })).toEqual({ error: "no online node hosts tasks" });
  expect(place({ projectIds: ["p"], nodes: [node(A, { running: 1, limit: 1 }), node(B, { running: 3, limit: 2 }), node(C, { online: false })] }))
    .toEqual({ error: "every node is at its running limit" });
});

test("a projectless input ignores homes and holders", () => {
  const nodes = [node(A, { running: 1, projects: [{ id: "p", home: A }] }), node(B, { running: 0 })];
  expect(place({ projectIds: [], nodes })).toEqual({ nodeId: B });
});

test("homes come from any candidate's entry, even one that cannot take the task", () => {
  // Only the offline C says where p lives; B is its home and takes the task over the idler A.
  const nodes = [node(A), node(B, { running: 2 }), node(C, { online: false, projects: [{ id: "p", home: B }] })];
  expect(place({ projectIds: ["p"], nodes })).toEqual({ nodeId: B });
});

function row(nodeId: string, summary: unknown, extra: Partial<RosterRow> = {}): RosterRow {
  return {
    nodeId, hostname: `host-${nodeId[0]}`, status: "member", updatedAt: "2026-11-02T00:00:00.000Z", addedBy: A,
    summary: summary as RosterRow["summary"], lastSeenAt: "2026-11-02T00:00:00.000Z", lastAddr: null,
    reachedAt: null, reachedAddr: null, ...extra,
  };
}

test("placementCandidates: the roster's other members as their summaries say, older peers defaulted, and this node live", () => {
  const older = { hostname: "b", version: "0.1.0", claudeCodeVersion: "2.0.0", hostsTasks: true, taskCount: 4 };
  const newer = {
    hostname: "c", version: "0.2.0", claudeCodeVersion: "2.0.0", hostsTasks: true, taskCount: 2, running: 1, limit: 3,
    projects: [{ id: "p", name: "pee", home: C }],
  };
  const self = { nodeId: A, hostsTasks: false, running: 2, taskCount: 7, projects: [{ id: "q", home: A }], limit: 4 };
  const rows = [
    row(A, { ...newer, hostname: "stale self row", running: 99 }),
    row(B, older),
    row(C, newer),
    row("d".repeat(64), null),
    row("e".repeat(64), newer, { status: "removed" }),
  ];
  const online = new Set([B, "e".repeat(64)]);
  expect(placementCandidates(rows, (id) => online.has(id), self)).toEqual([
    { nodeId: B, online: true, hostsTasks: true, running: 0, taskCount: 4, projects: [], limit: 0 },
    { nodeId: C, online: false, hostsTasks: true, running: 1, taskCount: 2, projects: [{ id: "p", home: C }], limit: 3 },
    { nodeId: "d".repeat(64), online: false, hostsTasks: false, running: 0, taskCount: 0, projects: [], limit: 0 },
    { nodeId: A, online: true, hostsTasks: false, running: 2, taskCount: 7, projects: [{ id: "q", home: A }], limit: 4 },
  ]);
});

test("nodeOf defaults an older peer's summary the same way", () => {
  const older = { hostname: "b", version: "0.1.0", claudeCodeVersion: "2.0.0", hostsTasks: true, taskCount: 4 };
  const live = { summary: { ...older, hostname: "a", running: 1, limit: 2, projects: [{ id: "q", name: "q", home: A }] }, at: "t" };
  expect(nodeOf(row(B, older), A, live, [B])).toMatchObject({ nodeId: B, online: true, taskCount: 4, running: 0, limit: 0, projects: [] });
  expect(nodeOf(row(C, null), A, live, [])).toMatchObject({ nodeId: C, online: false, running: 0, limit: 0, projects: [] });
  expect(nodeOf(row(A, older), A, live, [])).toMatchObject({ nodeId: A, running: 1, limit: 2, projects: [{ id: "q", name: "q", home: A }] });
});

test("a roster row merged from an older peer reads back with running 0, limit 0 and no projects", async () => {
  const { PoolStore } = await import("../src/pool/store");
  const { openDb } = await import("../src/store/db");
  const store = new PoolStore(openDb(":memory:"));
  store.ensurePool({ nodeId: A, hostname: "a" });
  const older = { hostname: "b", version: "0.1.0", claudeCodeVersion: "2.0.0", hostsTasks: true, taskCount: 4 };
  store.merge([row(B, older)]);
  expect(store.row(B)?.summary).toEqual({ ...older, running: 0, limit: 0, projects: [] });
});
