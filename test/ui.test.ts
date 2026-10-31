// test/ui.test.ts
import { test, expect } from "bun:test";
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
