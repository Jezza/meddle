// test/memory.test.ts
import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, readlink, readFile, readdir } from "node:fs/promises";
import { loadConfig, ensureDataDirs, paths } from "../src/config";
import { claudeSlot, ensureMemoryReplica, importMemory, linkMemory } from "../src/memory";
import { jj } from "../src/jj";
test("slot naming matches Claude Code", () => {
  expect(claudeSlot("/home/jezza/projects/ssk")).toBe("-home-jezza-projects-ssk");
});
test("import from an existing slot, then link", async () => {
  const home = await mkdtemp("/tmp/meddle-mem-");
  const proj = `${home}/proj`;
  await mkdir(`${home}/.claude/projects/${claudeSlot(proj)}/memory`, { recursive: true });
  await writeFile(`${home}/.claude/projects/${claudeSlot(proj)}/memory/MEMORY.md`, "- note\n");
  const cfg = loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/data`, MEDDLE_TASK_ROOT: home });
  await ensureDataDirs(cfg);
  const replica = await ensureMemoryReplica(cfg, "p1");
  expect(await importMemory(cfg, "p1", proj)).toBe(true);
  expect(await readFile(`${replica}/MEMORY.md`, "utf8")).toBe("- note\n");
  expect(await jj(["log", "-r", "@-", "--no-graph", "-T", "description"], replica)).toBe(`import memory from ${claudeSlot(proj)}\n`);
  const configDir = `${home}/t/.meddle/claude`;
  await linkMemory(configDir, cfg, "p1");
  expect(await readlink(`${configDir}/projects/p1/memory`)).toBe(replica);
});
test("import does nothing when the slot has no memory directory", async () => {
  const home = await mkdtemp("/tmp/meddle-mem-");
  const cfg = loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/data`, MEDDLE_TASK_ROOT: home });
  await ensureDataDirs(cfg);
  const replica = await ensureMemoryReplica(cfg, "p1");
  expect(replica).toBe(paths(cfg).memory("p1"));
  expect(await importMemory(cfg, "p1", `${home}/proj`)).toBe(false);
  expect((await readdir(replica)).sort()).toEqual([".git", ".jj"]);
});
test("import never overwrites a replica that already has MEMORY.md", async () => {
  const home = await mkdtemp("/tmp/meddle-mem-");
  const proj = `${home}/proj`;
  const source = `${home}/.claude/projects/${claudeSlot(proj)}/memory`;
  await mkdir(source, { recursive: true });
  await writeFile(`${source}/MEMORY.md`, "- from slot\n");
  await writeFile(`${source}/extra.md`, "extra\n");
  const cfg = loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/data`, MEDDLE_TASK_ROOT: home });
  await ensureDataDirs(cfg);
  const replica = await ensureMemoryReplica(cfg, "p1");
  await writeFile(`${replica}/MEMORY.md`, "- replica\n");
  expect(await importMemory(cfg, "p1", proj)).toBe(false);
  expect(await readFile(`${replica}/MEMORY.md`, "utf8")).toBe("- replica\n");
  expect((await readdir(replica)).sort()).toEqual([".git", ".jj", "MEMORY.md"]);
});
