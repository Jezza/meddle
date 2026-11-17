// test/graph-model.test.ts
import { test, expect } from "bun:test";
import { atText, hasOlder, layoutLanes, mergeGraphs, type Row } from "../src/dashboard/ui/graph-model";
import type { GraphBookmark, GraphCommit } from "../src/projects/graph";

const main: GraphBookmark = { kind: "branch", name: "main" };
const task = (t: string): GraphBookmark => ({ kind: "task", task: t });

function c(commit: string, parents: string[], time: number, bookmarks: GraphBookmark[] = []): GraphCommit {
  return { commit, change: commit, parents, description: commit, immutable: false, time, bookmarks };
}

/** Each commit's lane, by id. */
function lanes(rows: readonly Row[], defaultBranch: string | null = "main"): Record<string, number> {
  const laid = layoutLanes(rows, defaultBranch).rows;
  return Object.fromEntries(rows.map((r, i) => [r.commit.commit, laid[i]!.lane]));
}

function segs(rows: readonly Row[], commit: string) {
  return layoutLanes(rows, "main").rows[rows.findIndex((r) => r.commit.commit === commit)]!.segs;
}

test("merging unions by commit and orders children first", () => {
  const rows = mergeGraphs([
    { nodeId: "A", graph: [c("x", ["c2"], 5), c("c2", ["c3"], 2), c("c3", [], 1)] },
    { nodeId: "B", graph: [c("y", ["c2"], 4), c("c2", ["c3"], 2), c("c3", [], 1)] },
  ]);
  expect(rows.map((r) => r.commit.commit)).toEqual(["x", "y", "c2", "c3"]);
});

test("a parent newer than its child still comes after it", () => {
  // p's clock ran ahead of r's: p is ready only once r is placed, and q, ready first, is newer than r.
  const rows = mergeGraphs([{ nodeId: "A", graph: [c("r", ["p"], 3), c("p", [], 9), c("q", [], 5)] }]);
  expect(rows.map((r) => r.commit.commit)).toEqual(["q", "r", "p"]);
});

test("a bookmark behind elsewhere is labelled behind", () => {
  const rows = mergeGraphs([
    { nodeId: "A", graph: [c("c3", ["c2"], 3, [main]), c("c2", ["c1"], 2), c("c1", [], 1)] },
    { nodeId: "B", graph: [c("c2", ["c1"], 2, [main]), c("c1", [], 1)] },
  ]);
  expect(rows.map((r) => r.commit.commit)).toEqual(["c3", "c2", "c1"]);
  expect(rows[0]!.labels).toMatchObject([{ bookmark: main, nodes: ["A"], behind: null }]);
  expect(rows[1]!.labels).toEqual([{ bookmark: main, nodes: ["B"], behind: 1, notPushed: false }]);
  expect(rows[2]!.labels).toEqual([]);
});

test("positions on diverged lines are both plain", () => {
  const rows = mergeGraphs([
    { nodeId: "A", graph: [c("a", ["c1"], 3, [main]), c("c1", [], 1)] },
    { nodeId: "B", graph: [c("b", ["c1"], 2, [main]), c("c1", [], 1)] },
  ]);
  expect(rows.flatMap((r) => r.labels.map((l) => l.behind))).toEqual([null, null]);
});

test("nodes with a bookmark at the same commit share one label, in input order", () => {
  const rows = mergeGraphs([
    { nodeId: "B", graph: [c("c1", [], 1, [main])] },
    { nodeId: "A", graph: [c("c1", [], 1, [main, task("t")])] },
  ]);
  expect(rows[0]!.labels).toEqual([
    { bookmark: main, nodes: ["B", "A"], behind: null, notPushed: false },
    { bookmark: task("t"), nodes: ["A"], behind: null, notPushed: false },
  ]);
});

test("a commit only one node has is not pushed", () => {
  const a = { nodeId: "A", graph: [c("c3", [], 3, [main])] };
  const b = { nodeId: "B", graph: [c("c4", ["c3"], 4, [{ kind: "branch", name: "spike" }]), c("c3", [], 3, [main])] };
  expect(mergeGraphs([a, b])[0]!.labels[0]).toMatchObject({ nodes: ["B"], notPushed: true });
  expect(mergeGraphs([a, b])[1]!.labels[0]).toMatchObject({ nodes: ["A", "B"], notPushed: false });
  expect(mergeGraphs([b])[0]!.labels[0]).toMatchObject({ notPushed: false });
});

test("the at text names the nodes, then behind or not pushed", () => {
  const name = (id: string) => id.toLowerCase();
  expect(atText({ bookmark: main, nodes: ["A", "B"], behind: null, notPushed: false }, name)).toBe("⌂ a · b");
  expect(atText({ bookmark: main, nodes: ["A"], behind: 1, notPushed: false }, name)).toBe("⌂ a · 1 behind");
  expect(atText({ bookmark: main, nodes: ["A"], behind: null, notPushed: true }, name)).toBe("⌂ a · not pushed");
});

test("the default branch is lane 0", () => {
  // The task line is newer than c3, so c2's newest child is t1: the default branch keeps lane 0 regardless.
  const rows = mergeGraphs([{
    nodeId: "A",
    graph: [c("t2", ["t1"], 7, [task("t")]), c("t1", ["c2"], 6), c("c3", ["c2"], 5, [main]), c("c2", ["c1"], 2), c("c1", [], 1)],
  }]);
  expect(lanes(rows)).toEqual({ c1: 0, c2: 0, c3: 0, t1: 1, t2: 1 });
  expect(segs(rows, "c2")).toContainEqual({ kind: "in", lane: 1 });
  expect(segs(rows, "t1")).toContainEqual({ kind: "down", lane: 1 });
  expect(segs(rows, "t1")).toContainEqual({ kind: "up", lane: 1 });
  expect(segs(rows, "c3")).toContainEqual({ kind: "through", lane: 1 });
  expect(layoutLanes(rows, "main").lanes).toBe(2);
  // Without a default branch, the newest child continues.
  expect(lanes(rows, null)).toEqual({ c1: 0, c2: 0, c3: 1, t1: 0, t2: 0 });
});

test("a merge draws out to its second parent", () => {
  const rows = mergeGraphs([{
    nodeId: "A",
    graph: [
      c("m", ["c3", "t2"], 6, [main]), c("c3", ["c2"], 5), c("t2", ["t1"], 4), c("t1", ["c2"], 3), c("c2", ["c1"], 2), c("c1", [], 1),
    ],
  }]);
  const lane = lanes(rows);
  expect(lane).toMatchObject({ m: 0, c3: 0, t2: 1, t1: 1 });
  expect(segs(rows, "m")).toContainEqual({ kind: "out", lane: 1 });
  expect(segs(rows, "c3")).toContainEqual({ kind: "through", lane: 1 });
  expect(segs(rows, "t2")).toContainEqual({ kind: "up", lane: 1 });
});

test("lanes are stable as rows are added at the top", () => {
  const base = [
    c("b2", ["b1"], 8, [task("b")]), c("c4", ["c3"], 7, [main]), c("b1", ["c3"], 6), c("a2", ["a1"], 5, [task("a")]),
    c("c3", ["c2"], 4), c("a1", ["c2"], 3), c("c2", ["c1"], 2), c("c1", [], 1),
  ];
  const before = lanes(mergeGraphs([{ nodeId: "A", graph: base }]));
  expect(before).toEqual({ b2: 2, c4: 0, b1: 2, a2: 1, c3: 0, a1: 1, c2: 0, c1: 0 });
  const after = lanes(mergeGraphs([{ nodeId: "A", graph: [c("n1", ["c4"], 10), c("a3", ["a2"], 9, [task("a")]), ...base] }]));
  expect(after).toMatchObject(before);
  expect(after).toMatchObject({ n1: 3, a3: 1 });
});

test("a parent outside the graph ends in a stub", () => {
  const cut = mergeGraphs([{ nodeId: "A", graph: [c("c2", ["c1"], 2, [main]), c("c1", ["c0"], 1)] }]);
  expect(segs(cut, "c1")).toContainEqual({ kind: "stub", lane: 0 });
  expect(segs(cut, "c2")).not.toContainEqual({ kind: "stub", lane: 0 });
  expect(hasOlder(cut)).toBe(true);
  const whole = mergeGraphs([{ nodeId: "A", graph: [c("c2", ["c1"], 2, [main]), c("c1", ["c0"], 1), c("c0", [], 0)] }]);
  expect(segs(whole, "c1")).not.toContainEqual({ kind: "stub", lane: 0 });
  expect(hasOlder(whole)).toBe(false);
});
