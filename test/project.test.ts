// test/project.test.ts
import { test, expect } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { loadConfig, ensureDataDirs, paths } from "../src/config";
import { openDb } from "../src/store/db";
import { addProjectFromFolder, addProjectFromUpstream, getProject, listProjects } from "../src/projects/project";
import { initColocated, isJjRepo, jj } from "../src/jj";
test("a plain git folder becomes a colocated jj replica", async () => {
  const home = await mkdtemp("/tmp/meddle-proj-");
  const folder = `${home}/repo`;
  Bun.spawnSync(["git", "init", "-q", folder]);
  const cfg = loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/data`, MEDDLE_TASK_ROOT: home });
  await ensureDataDirs(cfg);
  const db = openDb(`${home}/data/meddle.sqlite`);
  const p = await addProjectFromFolder(cfg, db, folder);
  expect(p.id).toMatch(/^[0-9a-f]{12}$/);
  expect(p.replica).toBe(folder);
  expect(await isJjRepo(folder)).toBe(true);
  expect(listProjects(db).map(x => x.id)).toEqual([p.id]);
});
test("an upstream is cloned into the replicas directory", async () => {
  const home = await mkdtemp("/tmp/meddle-proj-");
  const repo = `${home}/upstream`;
  await initColocated(repo);
  await writeFile(`${repo}/README`, "hi\n");
  await jj(["commit", "-m", "init"], repo);
  const cfg = loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/data`, MEDDLE_TASK_ROOT: home });
  await ensureDataDirs(cfg);
  const db = openDb(`${home}/data/meddle.sqlite`);
  const p = await addProjectFromUpstream(cfg, db, repo, "up");
  expect(p.name).toBe("up");
  expect(p.source).toEqual({ kind: "upstream", url: repo });
  expect(p.replica).toBe(paths(cfg).replica(p.id));
  expect(await isJjRepo(paths(cfg).replica(p.id))).toBe(true);
  expect(getProject(db, p.id)).toEqual(p);
});
