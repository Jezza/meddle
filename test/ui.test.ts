// test/ui.test.ts
import { test, expect } from "bun:test";
import { headText, mergeProjects, moveTargets, projectChoices } from "../src/dashboard/ui/pool-model";
import { hashOf, viewOf } from "../src/dashboard/ui/routes";

test("the dashboard bundle builds", async () => {
  const build = await Bun.build({ entrypoints: ["src/dashboard/ui/main.tsx"], target: "browser", format: "esm" });
  expect(build.success).toBe(true);
});

test("viewOf and hashOf round-trip the pool routes", () => {
  expect(viewOf("#/task/abc/t1")).toEqual({ name: "task", nodeId: "abc", id: "t1" });
  expect(hashOf({ name: "task", nodeId: "abc", id: "t1" })).toBe("#/task/abc/t1");
  expect(viewOf("#/task/t1")).toEqual({ name: "pool" });          // the Plan 1 shape no longer resolves
  expect(viewOf("#/settings")).toEqual({ name: "settings" });
});

test("viewOf falls back to the pool for a malformed escape instead of throwing", () => {
  expect(viewOf("#/task/%zz/x")).toEqual({ name: "pool" });
  expect(viewOf("#/task/abc/%E0%A4%A")).toEqual({ name: "pool" });
});

test("a task moves only to another online member that hosts tasks and runs the same known Claude Code version", () => {
  const [a, b, c, d, e, f] = ["a", "b", "c", "d", "e", "f"].map((x) => x.repeat(64)) as [string, string, string, string, string, string];
  const row = (nodeId: string, over: Partial<{ status: "member" | "removed"; online: boolean; hostsTasks: boolean; claudeCodeVersion: string }> = {}) =>
    ({ nodeId, status: "member" as const, online: true, hostsTasks: true, claudeCodeVersion: "2.1.0", ...over });
  const nodes = [
    row(a),
    row(b),
    row(c, { online: false }),
    row(d, { hostsTasks: false }),
    row(e, { claudeCodeVersion: "2.2.0" }),
    row(f, { status: "removed" }),
  ];
  expect(moveTargets(nodes, a, "2.1.0").map((n) => n.nodeId)).toEqual([b]);
  expect(moveTargets(nodes, b, "2.1.0").map((n) => n.nodeId)).toEqual([a]);
  // an unknown version on this node (a compiled binary) moves nowhere, nor to a node that reports unknown
  expect(moveTargets(nodes, a, "unknown")).toEqual([]);
  expect(moveTargets([row(a, { claudeCodeVersion: "unknown" }), row(b, { claudeCodeVersion: "unknown" })], a, "unknown")).toEqual([]);
});

test("the projects view merges each project's holders by id, home's name first, holders in pool order", () => {
  const [a, b, c] = ["a", "b", "c"].map((x) => x.repeat(64)) as [string, string, string];
  const heads = [{ name: "trunk", remote: null, changeId: "kkkkkkkkkkkk", conflicted: false }];
  const rows = mergeProjects([
    { nodeId: c, id: "p1", name: "one", home: a, heads: [], contextLoaded: true },
    { nodeId: a, id: "p1", name: "one", home: a, heads, contextLoaded: true },
    { nodeId: b, id: "p2", name: "two", home: b, heads: [], contextLoaded: false },
  ], [a, b, c]);
  expect(rows).toEqual([
    { id: "p1", name: "one", home: a, holders: [{ nodeId: a, heads, contextLoaded: true }, { nodeId: c, heads: [], contextLoaded: true }] },
    { id: "p2", name: "two", home: b, holders: [{ nodeId: b, heads: [], contextLoaded: false }] },
  ]);
  expect(headText(heads[0]!)).toBe("trunk kkkkkkkk");
  expect(headText({ name: "meddle/task/t1/one", remote: "0123456789", changeId: "", conflicted: true })).toBe("meddle/task/t1/one@0123456789 (conflicted)");
});

test("projectChoices: every project an online member lists, once, named as its home lists it", () => {
  const a = "a".repeat(64);
  const b = "b".repeat(64);
  const c = "c".repeat(64);
  const nodes = [
    { nodeId: a, status: "member" as const, online: true, projects: [{ id: "p", name: "old-name", home: b }, { id: "q", name: "zeta", home: a }] },
    { nodeId: b, status: "member" as const, online: true, projects: [{ id: "p", name: "alpha", home: b }] },
    { nodeId: c, status: "member" as const, online: false, projects: [{ id: "r", name: "offline", home: c }] },
    { nodeId: "d".repeat(64), status: "removed" as const, online: true, projects: [{ id: "s", name: "gone", home: c }] },
  ];
  expect(projectChoices(nodes)).toEqual([{ id: "p", name: "alpha", home: b }, { id: "q", name: "zeta", home: a }]);
  // With the home not listing it, another holder's entry stands.
  expect(projectChoices([nodes[0]!])).toEqual([{ id: "p", name: "old-name", home: b }, { id: "q", name: "zeta", home: a }]);
});
