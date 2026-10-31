// test/project.test.ts
import { test, expect } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { loadConfig, ensureDataDirs, paths } from "../src/config";
import { openDb } from "../src/store/db";
import { claimHomelessProjects, insertTask, listLiveTasks, listTasks } from "../src/store/records";
import { addProjectFromFolder, addProjectFromUpstream, getProject, listProjects, projectChanges, registerReplica } from "../src/projects/project";
import { initColocated, isJjRepo, jj } from "../src/jj";

const HOME_A = "a".repeat(64);
const HOME_B = "b".repeat(64);
test("a plain git folder becomes a colocated jj replica", async () => {
  const home = await mkdtemp("/tmp/meddle-proj-");
  const folder = `${home}/repo`;
  Bun.spawnSync(["git", "init", "-q", folder]);
  const cfg = loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/data`, MEDDLE_TASK_ROOT: home });
  await ensureDataDirs(cfg);
  const db = openDb(`${home}/data/meddle.sqlite`);
  const p = await addProjectFromFolder(cfg, db, folder, HOME_A);
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
  const p = await addProjectFromUpstream(cfg, db, repo, HOME_A, "up");
  expect(p.name).toBe("up");
  expect(p.source).toEqual({ kind: "upstream", url: repo });
  expect(p.replica).toBe(paths(cfg).replica(p.id));
  expect(await isJjRepo(paths(cfg).replica(p.id))).toBe(true);
  expect(getProject(db, p.id)).toEqual(p);
});

async function freshNode() {
  const home = await mkdtemp("/tmp/meddle-proj-");
  const cfg = loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/data`, MEDDLE_TASK_ROOT: home });
  await ensureDataDirs(cfg);
  return { home, cfg, db: openDb(`${home}/data/meddle.sqlite`) };
}

test("a project stores its home and returns it, and adding one fires projectChanges", async () => {
  const { home, cfg, db } = await freshNode();
  const folder = `${home}/repo`;
  await initColocated(folder);
  let fired = 0;
  const stop = projectChanges.subscribe(() => { fired++; });
  try {
    const p = await addProjectFromFolder(cfg, db, folder, HOME_A, "named");
    expect(p.home).toBe(HOME_A);
    expect(p.name).toBe("named");
    expect(getProject(db, p.id)).toEqual(p);
    expect(listProjects(db)).toEqual([p]);
    expect(fired).toBe(1);
  } finally {
    stop();
  }
});

test("registerReplica stores the home's project id, name and home, and fires projectChanges", async () => {
  const { home, db } = await freshNode();
  let fired = 0;
  const stop = projectChanges.subscribe(() => { fired++; });
  try {
    const p = registerReplica(db, { id: "0123456789ab", name: "theirs", home: HOME_B, replica: `${home}/replica` });
    expect(p).toEqual({
      id: "0123456789ab", name: "theirs", home: HOME_B, replica: `${home}/replica`,
      source: { kind: "upstream", url: `meddle://${HOME_B}/project/0123456789ab` },
    });
    expect(getProject(db, "0123456789ab")).toEqual(p);
    expect(fired).toBe(1);
  } finally {
    stop();
  }
});

test("openDb adds the project home and the task move columns to an older database, once; the node claims its projects", async () => {
  const { Database } = await import("bun:sqlite");
  const file = `${await mkdtemp("/tmp/meddle-db-")}/old.sqlite`;
  const old = new Database(file, { create: true });
  old.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, source_kind TEXT, source TEXT, replica TEXT, created_at TEXT)");
  old.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, state TEXT, session_id TEXT, manifest TEXT, started INTEGER NOT NULL DEFAULT 0, turns INTEGER NOT NULL DEFAULT 0, created_at TEXT, updated_at TEXT)");
  old.exec("INSERT INTO projects (id, name, source_kind, source, replica) VALUES ('p', 'old', 'folder', '/x', '/x')");
  old.exec("INSERT INTO tasks (id, title, state) VALUES ('t', 'old', 'idle')");
  old.close();
  openDb(file).close();
  const db = openDb(file);
  const columns = (table: string) => db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  expect(columns("projects").filter((c) => c === "home")).toEqual(["home"]);
  for (const name of ["queued", "moved_to", "receiving_from"]) expect(columns("tasks").filter((c) => c === name)).toEqual([name]);
  expect(db.query("SELECT name, home FROM projects").get()).toEqual({ name: "old", home: null });
  // The node that opens it claims the homeless project.
  claimHomelessProjects(db, HOME_A);
  expect(getProject(db, "p")?.home).toBe(HOME_A);
  expect(db.query("SELECT title, queued, moved_to, receiving_from FROM tasks").get())
    .toEqual({ title: "old", queued: null, moved_to: null, receiving_from: null });
  db.close();
});

test("listLiveTasks leaves out moved and receiving tasks", async () => {
  const { db } = await freshNode();
  for (const [id, state] of [["t1", "idle"], ["t2", "moved"], ["t3", "running"], ["t4", "receiving"], ["t5", "waiting"]] as const) {
    insertTask(db, { id, title: id, state, session_id: id, manifest: "{}", started: 0, turns: 0 });
  }
  expect(listLiveTasks(db).map((t) => t.id)).toEqual(["t1", "t3", "t5"]);
  expect(listTasks(db)).toHaveLength(5);
});
