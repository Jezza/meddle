// test/context.test.ts
import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { loadContext, composeSettings, composeEnv, loadProjectSettings, DEFAULT_CONTEXT } from "../src/projects/context";
test("missing file gives defaults", async () => {
  expect(await loadContext(await mkdtemp("/tmp/ctx-"))).toEqual(DEFAULT_CONTEXT);
});
test("parses and composes", async () => {
  const r = await mkdtemp("/tmp/ctx-"); await mkdir(`${r}/.meddle`);
  await writeFile(`${r}/.meddle/context.toml`, `instructions = "Use cargo nextest."\n[env]\nRUST_LOG = "debug"\n[claude]\nask = ["Bash(git push *)"]\n[claude.autoMode]\nallow = ["Cargo builds"]\n[resources]\nruns = ["cargo"]\n`);
  const c = await loadContext(r);
  expect(c.env.RUST_LOG).toBe("debug");
  const s = composeSettings([c]) as any;
  expect(s.autoMode.allow).toEqual(["$defaults", "Cargo builds"]);
  expect(s.permissions.ask).toEqual(["Bash(git push *)"]);
  expect(composeEnv([DEFAULT_CONTEXT, c])).toEqual({ RUST_LOG: "debug" });
});
test("unknown key is named", async () => {
  const r = await mkdtemp("/tmp/ctx-"); await mkdir(`${r}/.meddle`);
  await writeFile(`${r}/.meddle/context.toml`, `[claude]\nallwo = []\n`);
  await expect(loadContext(r)).rejects.toThrow("unknown key claude.allwo");
});
test("project settings come first, context rules are appended", async () => {
  const r = await mkdtemp("/tmp/ctx-"); await mkdir(`${r}/.meddle`);
  await writeFile(`${r}/.meddle/context.toml`, `[claude]\nask = ["Bash(git push *)"]\n[claude.autoMode]\nallow = ["Cargo builds"]\n`);
  const c = await loadContext(r);
  const s = composeSettings([c], [{ autoMode: { allow: ["Project rule"] }, permissions: { ask: ["Bash(rm *)"] } }]) as any;
  expect(s.autoMode.allow).toEqual(["$defaults", "Project rule", "Cargo builds"]);
  expect(s.permissions.ask).toEqual(["Bash(rm *)", "Bash(git push *)"]);
});
test("project settings are {} without .claude/settings.json", async () => {
  expect(await loadProjectSettings(await mkdtemp("/tmp/ctx-"))).toEqual({});
});
