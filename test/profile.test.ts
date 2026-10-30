// test/profile.test.ts
import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, readlink, readFile } from "node:fs/promises";
import { loadConfig, ensureDataDirs, paths } from "../src/config";
import { seedProfile, linkProfile, ensurePlugins, PROFILE_ENTRIES } from "../src/profile";
import { isJjRepo } from "../src/jj";
test("seed copies ~/.claude entries into a jj repo and links them", async () => {
  const home = await mkdtemp("/tmp/meddle-prof-");
  await mkdir(`${home}/.claude/skills/pine`, { recursive: true });
  await writeFile(`${home}/.claude/skills/pine/SKILL.md`, "---\nname: pine\ndescription: d\n---\n");
  await writeFile(`${home}/.claude/CLAUDE.md`, "# rules\n");
  const cfg = loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/data`, MEDDLE_TASK_ROOT: home });
  await ensureDataDirs(cfg);
  await seedProfile(cfg); await seedProfile(cfg);
  expect(await isJjRepo(paths(cfg).profile)).toBe(true);
  expect(await readFile(`${paths(cfg).profile}/CLAUDE.md`, "utf8")).toBe("# rules\n");
  const configDir = `${home}/task/.meddle/claude`;
  await mkdir(configDir, { recursive: true });
  await ensurePlugins(cfg);
  await linkProfile(configDir, cfg);
  for (const e of PROFILE_ENTRIES) expect(await readlink(`${configDir}/${e}`)).toBe(`${paths(cfg).profile}/${e}`);
  expect(await readFile(`${configDir}/skills/pine/SKILL.md`, "utf8")).toContain("name: pine");
  expect(await readlink(`${configDir}/plugins`)).toBe(paths(cfg).plugins);
});

test("ensurePlugins replaces the empty plugins dir from ensureDataDirs with a link to ~/.claude/plugins", async () => {
  const home = await mkdtemp("/tmp/meddle-prof-");
  await mkdir(`${home}/.claude/plugins`, { recursive: true });
  const cfg = loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/data`, MEDDLE_TASK_ROOT: home });
  await ensureDataDirs(cfg);
  await ensurePlugins(cfg);
  expect(await readlink(paths(cfg).plugins)).toBe(`${home}/.claude/plugins`);
});
