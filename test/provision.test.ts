// test/provision.test.ts
import { test, expect } from "bun:test";
import { mkdtemp, readlink, readFile, lstat } from "node:fs/promises";
import { loadConfig, ensureDataDirs, paths } from "../src/config";
import { openDb } from "../src/store/db";
import { addProjectFromFolder } from "../src/projects/project";
import { provisionTask, cwdFor } from "../src/tasks/provision";
import { initColocated, isJjRepo } from "../src/jj";
test("provision creates workspaces, config dir links and CLAUDE.md, seeding the profile first", async () => {
  const home = await mkdtemp("/tmp/meddle-prov-");
  const cfg = loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/data`, MEDDLE_TASK_ROOT: `${home}/tasks` });
  await ensureDataDirs(cfg);
  await (await import("node:fs/promises")).mkdir(cfg.taskRoot, { recursive: true });
  const db = openDb(`${home}/data/meddle.sqlite`);
  const a = `${home}/a`; await initColocated(a);
  const pa = await addProjectFromFolder(cfg, db, a, "a");
  const m = await provisionTask(cfg, db, { title: "t", projectIds: [pa.id] });
  const task = paths(cfg).task(m.id);
  expect((await lstat(`${task}/a/.jj`)).isDirectory()).toBe(true);
  expect(await readlink(`${task}/.meddle/claude/skills`)).toBe(`${paths(cfg).profile}/skills`);
  expect(await readlink(`${task}/.meddle/claude/projects/${pa.id}/memory`)).toBe(paths(cfg).memory(pa.id));
  expect(await readFile(`${task}/CLAUDE.md`, "utf8")).toContain("# Task: t");
  expect(await isJjRepo(paths(cfg).profile)).toBe(true);
  expect(m.projects[0]).toMatchObject({ id: pa.id, name: "a", replica: a, workspace: "a" });
  expect(await Bun.file(`${task}/a/.git`).exists()).toBe(true);
  expect(await (await import("../src/jj")).jj(["bookmark", "list", `meddle/task/${m.id}/a`], a)).toContain(`meddle/task/${m.id}/a`);
  expect(cwdFor(m, cfg)).toEqual({ cwd: `${task}/a`, projectConfigRoot: a, settingSources: ["user", "project", "local"] });
});
test("provision refuses without a task root", async () => {
  const home = await mkdtemp("/tmp/meddle-prov-");
  const cfg = loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/data`, MEDDLE_TASK_ROOT: `${home}/missing` });
  await ensureDataDirs(cfg);
  const db = openDb(`${home}/data/meddle.sqlite`);
  await expect(provisionTask(cfg, db, { title: "t", projectIds: [] })).rejects.toThrow(/task root/);
});
test("a two-project task gets a workspace per project and runs from the task folder", async () => {
  const { mkdir } = await import("node:fs/promises");
  const { changeId } = await import("../src/jj");
  const { readManifest } = await import("../src/tasks/manifest");
  const { getTask } = await import("../src/store/records");
  const home = await mkdtemp("/tmp/meddle-prov-");
  const cfg = loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/data`, MEDDLE_TASK_ROOT: `${home}/tasks` });
  await ensureDataDirs(cfg);
  await mkdir(cfg.taskRoot, { recursive: true });
  const db = openDb(`${home}/data/meddle.sqlite`);
  const a = `${home}/a`; await initColocated(a);
  const b = `${home}/b`; await initColocated(b);
  const pa = await addProjectFromFolder(cfg, db, a, "a");
  const pb = await addProjectFromFolder(cfg, db, b, "b");
  const m = await provisionTask(cfg, db, { title: "pair", projectIds: [pa.id, pb.id] });
  const task = paths(cfg).task(m.id);
  expect(m.id).toMatch(/^[0-9a-f]{12}$/);
  expect(m.primaryProjectId).toBe(pa.id);
  expect(m.projects.map((p) => p.workspace)).toEqual(["a", "b"]);
  const [ca, cb] = [await changeId(`${task}/a`), await changeId(`${task}/b`)];
  expect(ca).not.toBe(cb);
  expect(await readFile(`${task}/CLAUDE.md`, "utf8")).toBe(
    "# Task: pair\n\n- a/: jj workspace of project a\n- b/: jj workspace of project b\n\n" +
      "This folder is a meddle task. Each project is a jj workspace; commit with jj.\n",
  );
  expect(cwdFor(m, cfg)).toEqual({ cwd: task, settingSources: ["user"] });
  expect(await readManifest(cfg, m.id)).toEqual(m);
  const row = getTask(db, m.id);
  expect(row).toMatchObject({ title: "pair", state: "idle", session_id: m.sessionId, started: 0, turns: 0 });
  expect(JSON.parse(row!.manifest)).toEqual(m);
});
test("provision with an unknown project throws and leaves no task folder", async () => {
  const { mkdir, readdir } = await import("node:fs/promises");
  const home = await mkdtemp("/tmp/meddle-prov-");
  const cfg = loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/data`, MEDDLE_TASK_ROOT: `${home}/tasks` });
  await ensureDataDirs(cfg);
  await mkdir(cfg.taskRoot, { recursive: true });
  const db = openDb(`${home}/data/meddle.sqlite`);
  await expect(provisionTask(cfg, db, { title: "t", projectIds: ["0123456789ab"] })).rejects.toThrow(
    "unknown project: 0123456789ab",
  );
  expect(await readdir(cfg.taskRoot)).toEqual([]);
});
