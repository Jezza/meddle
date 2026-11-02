// test/provision.test.ts
import { test, expect } from "bun:test";
import { mkdtemp, readlink, readFile, lstat } from "node:fs/promises";
import { loadConfig, ensureDataDirs, paths } from "../src/config";
import { openDb } from "../src/store/db";
import { addProjectFromFolder } from "../src/projects/project";
import { provisionTask, cwdFor } from "../src/tasks/provision";
import { initColocated, isJjRepo } from "../src/jj";

/** The home node id of the projects these tests add. */
const PROJECT_HOME = "a".repeat(64);
test("provision creates workspaces, config dir links and CLAUDE.md, seeding the profile first", async () => {
  const home = await mkdtemp("/tmp/meddle-prov-");
  const cfg = loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/data`, MEDDLE_TASK_ROOT: `${home}/tasks` });
  await ensureDataDirs(cfg);
  await (await import("node:fs/promises")).mkdir(cfg.taskRoot, { recursive: true });
  const db = openDb(`${home}/data/meddle.sqlite`);
  const a = `${home}/a`; await initColocated(a);
  const pa = await addProjectFromFolder(cfg, db, a, PROJECT_HOME, "a");
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
  // the transcripts live under .meddle: only this user may read it
  expect((await lstat(`${task}/.meddle`)).mode & 0o777).toBe(0o700);
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
  const pa = await addProjectFromFolder(cfg, db, a, PROJECT_HOME, "a");
  const pb = await addProjectFromFolder(cfg, db, b, PROJECT_HOME, "b");
  const m = await provisionTask(cfg, db, { title: "pair", projectIds: [pa.id, pb.id] });
  const task = paths(cfg).task(m.id);
  expect(m.id).toMatch(/^[0-9a-f]{12}$/);
  expect(m.primaryProjectId).toBe(pa.id);
  expect(m.projects.map((p) => p.workspace)).toEqual(["a", "b"]);
  const [ca, cb] = [await changeId(`${task}/a`), await changeId(`${task}/b`)];
  expect(ca).not.toBe(cb);
  expect(await readFile(`${task}/CLAUDE.md`, "utf8")).toBe(
    "# Task: pair\n\n- a/: jj workspace of project a\n- b/: jj workspace of project b\n\n" +
      "This folder is a meddle task. Each project is a jj workspace; commit with jj.\n\n" +
      `To keep a side branch, give it a bookmark named meddle/task/${m.id}/<project>.<label> (for example meddle/task/${m.id}/<project>.spike). ` +
      "Bookmarks outside that namespace are not backed up and do not travel, and git refuses a name with a slash after the project name.\n",
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
test("a provision failing after a workspace exists undoes workspaces, bookmarks and the task folder", async () => {
  const { mkdir, readdir } = await import("node:fs/promises");
  const { jj } = await import("../src/jj");
  const home = await mkdtemp("/tmp/meddle-prov-");
  const cfg = loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/data`, MEDDLE_TASK_ROOT: `${home}/tasks` });
  await ensureDataDirs(cfg);
  await mkdir(cfg.taskRoot, { recursive: true });
  const db = openDb(`${home}/data/meddle.sqlite`);
  const a = `${home}/a`; await initColocated(a);
  const b = `${home}/b`; await initColocated(b);
  const pa = await addProjectFromFolder(cfg, db, a, PROJECT_HOME, "a");
  const pb = await addProjectFromFolder(cfg, db, b, PROJECT_HOME, "b");
  await expect(
    provisionTask(cfg, db, { title: "t", projectIds: [pa.id, pb.id], parents: { [pb.id]: "nonexistent_rev" } }),
  ).rejects.toThrow(/nonexistent_rev/);
  expect(await readdir(cfg.taskRoot)).toEqual([]);
  for (const repo of [a, b]) {
    expect((await jj(["workspace", "list", "-T", 'name ++ "\\n"'], repo)).trim()).toBe("default");
    expect((await jj(["bookmark", "list", "-T", 'name ++ "\\n"'], repo)).trim()).not.toContain("meddle/task/");
  }
  const { listTasks } = await import("../src/store/records");
  expect(listTasks(db)).toEqual([]);
});
test("a task without a project is scratch space: no workspace, no primary, no memory slot, run from the task folder", async () => {
  const { mkdir, readdir } = await import("node:fs/promises");
  const { realpathSync } = await import("node:fs");
  const { claudeSlot } = await import("../src/memory");
  const { transcriptPath, readManifest } = await import("../src/tasks/manifest");
  const { buildEnv } = await import("../src/engine/options");
  const { checkReceivedManifest } = await import("../src/tasks/provision");
  const home = await mkdtemp("/tmp/meddle-prov-");
  const cfg = loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/data`, MEDDLE_TASK_ROOT: `${home}/tasks` });
  await ensureDataDirs(cfg);
  await mkdir(cfg.taskRoot, { recursive: true });
  const db = openDb(`${home}/data/meddle.sqlite`);
  const m = await provisionTask(cfg, db, { title: "loose", projectIds: [] });
  const task = paths(cfg).task(m.id);
  expect(m.projects).toEqual([]);
  expect(m.primaryProjectId).toBeNull();
  expect(await readManifest(cfg, m.id)).toEqual(m);
  // Only the generated CLAUDE.md and meddle's own folder: no workspace, no `projects/` (memory) slot.
  expect((await readdir(task)).sort()).toEqual([".meddle", "CLAUDE.md"]);
  expect(await Bun.file(`${paths(cfg).taskConfig(m.id)}/projects`).exists()).toBe(false);
  expect(await readdir(paths(cfg).taskConfig(m.id))).not.toContain("projects");
  expect(await readFile(`${task}/CLAUDE.md`, "utf8")).toBe(
    "# Task: loose\n\nThis task has no project attached. This folder is scratch space; it travels with the task.\n",
  );
  expect(cwdFor(m, cfg)).toEqual({ cwd: task, projectConfigRoot: null, settingSources: ["user"] });
  const env = buildEnv({
    cfg, manifest: m, contexts: [], projectSettings: [], token: "tok", prompt: (async function* () {})(),
    canUseTool: async () => ({ behavior: "deny" as const, message: "x" }), onPermissionDenied: () => {}, sessionStore: {} as never, resume: false,
  });
  expect(env).not.toHaveProperty("CLAUDE_CODE_PROJECT_DIR_NAME");
  expect(env.CLAUDE_CONFIG_DIR).toBe(paths(cfg).taskConfig(m.id));
  // Claude Code's own slot for the folder it runs in (resolved: the child's cwd is the real path).
  expect(transcriptPath(cfg, m)).toBe(`${paths(cfg).taskConfig(m.id)}/projects/${claudeSlot(realpathSync(task))}/${m.sessionId}.jsonl`);
  // A received manifest may have no project too.
  expect(() => checkReceivedManifest(m)).not.toThrow();
  expect(() => checkReceivedManifest({ ...m, primaryProjectId: "p1" })).toThrow("the primary project is not one of the task's");
});
test("a projectless task's turn runs to success, leaves its transcript where Claude Code writes it, and the next turn resumes", async () => {
  const { setupNode } = await import("./helpers");
  const { listEvents } = await import("../src/store/events");
  const { transcriptPath } = await import("../src/tasks/manifest");
  const { existsSync } = await import("node:fs");
  const { runner, db, cfg } = await setupNode();
  const m = await runner.create({ title: "loose", projectIds: [] });
  const turn = (text: string) => new Promise<void>((res) => {
    let ran = false;
    const off = runner.onState((id, s) => {
      if (id !== m.id) return;
      if (s === "running") ran = true;
      else if (s === "idle" && ran) { off(); res(); }
    });
    void runner.prompt(m.id, text);
  });
  await turn("Reply with the single word ok.");
  const results = listEvents(db, m.id).filter((e) => (e.message as { type?: string }).type === "result");
  expect(results.map((e) => (e.message as { subtype?: string }).subtype)).toEqual(["success"]);
  expect(existsSync(transcriptPath(cfg, m))).toBe(true);
  await turn("Again.");
  const started = listEvents(db, m.id).filter((e) => (e.message as { subtype?: string }).subtype === "turn_started");
  expect(started.map((e) => (e.message as { resume?: boolean }).resume)).toEqual([false, true]);
}, 30_000);
