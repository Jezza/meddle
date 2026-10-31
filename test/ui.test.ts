// test/ui.test.ts
import { test, expect } from "bun:test";
import { joinStateOf } from "../src/dashboard/ui/join-state";
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

test("Settings blocks joining only while this node is a member with other members; a removed node may join again", () => {
  const [a, b, c] = ["a", "b", "c"].map((x) => x.repeat(64)) as [string, string, string];
  expect(joinStateOf([{ nodeId: a, status: "member" }], a)).toEqual({ blocked: false, hint: null });
  expect(joinStateOf([{ nodeId: a, status: "member" }, { nodeId: b, status: "removed" }], a)).toEqual({ blocked: false, hint: null });
  expect(joinStateOf([{ nodeId: a, status: "member" }, { nodeId: b, status: "member" }], a).blocked).toBe(true);
  // Removed itself, while its roster still lists the members that remain.
  const removed = joinStateOf([{ nodeId: a, status: "removed" }, { nodeId: b, status: "member" }, { nodeId: c, status: "member" }], a);
  expect(removed.blocked).toBe(false);
  expect(removed.hint).toContain("removed from its pool");
});
