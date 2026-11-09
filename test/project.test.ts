// test/project.test.ts
import { test, expect } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { loadConfig, ensureDataDirs, paths } from "../src/config";
import { openDb } from "../src/store/db";
import { insertTask, listArchivedTasks, listLiveTasks, listTasks, updateTask } from "../src/store/records";
import { addProjectFromFolder, addProjectFromUpstream, getProject, listProjects, projectChanges, registerReplica, setDefaultBranch } from "../src/projects/project";
import { bookmarkList, git, initColocated, isJjRepo, jj, remoteList } from "../src/jj";
import { listBranchRows, rowChanges } from "../src/pool/rows";

const HOME_A = "a".repeat(64);
const HOME_B = "b".repeat(64);
/**
 * Runs `add` and returns what it resolved to, with whether each `rowChanges` it fired came after the project was
 * saved: the applier that a row wakes looks the project up at once.
 */
async function withRowChanges<T>(db: ReturnType<typeof openDb>, add: () => Promise<T>): Promise<{ added: T; saved: boolean[] }> {
  const saved: boolean[] = [];
  const stop = rowChanges.subscribe((project) => saved.push(getProject(db, project) !== null));
  try {
    return { added: await add(), saved };
  } finally {
    stop();
  }
}

/** `template` of `rev` in `repo`, read without a snapshot. */
const read = async (repo: string, rev: string, template = "commit_id") =>
  (await jj(["log", "--ignore-working-copy", "-r", rev, "--no-graph", "-T", template], repo)).trim();

test("a folder project's service repo is built in the replicas directory from the folder's default branch, reading the folder only", async () => {
  const { home, cfg, db } = await freshNode();
  const folder = `${home}/repo`;
  await initColocated(folder);
  await writeFile(`${folder}/README`, "hi\n");
  await jj(["commit", "-m", "init"], folder);
  // No `main`: `master` is the default branch.
  await jj(["bookmark", "set", "master", "-r", "@-"], folder);
  await jj(["bookmark", "set", "other", "-r", "@-"], folder);
  const master = await read(folder, "master");
  const lastOp = () => jj(["op", "log", "--ignore-working-copy", "-n", "1", "--no-graph", "-T", "id"], folder);
  const before = await lastOp();
  const { added: p, saved } = await withRowChanges(db, () => addProjectFromFolder(cfg, db, folder, HOME_A));
  expect(saved).toEqual([true]);
  expect(p.id).toMatch(/^[0-9a-f]{12}$/);
  expect(p.source).toEqual({ kind: "folder", path: folder });
  expect(p.replica).toBe(paths(cfg).replica(p.id));
  expect(p.defaultBranch).toBe("master");
  expect(await read(p.replica, "master")).toBe(master);
  expect(await read(p.replica, "bookmarks()")).toBe(master);
  expect(await read(p.replica, "bookmarks()", 'bookmarks ++ ""')).toBe("master");
  expect(await lastOp()).toBe(before);
  expect(listBranchRows(db, p.id)).toEqual([{ project: p.id, branch: "master", node: HOME_A, seq: 1, commit: master, drops: [] }]);
  expect(listProjects(db).map(x => x.id)).toEqual([p.id]);
});

test("a folder that is not a colocated jj repo is refused, and nothing is added", async () => {
  const { home, cfg, db } = await freshNode();
  const plain = `${home}/plain`;
  Bun.spawnSync(["git", "init", "-q", plain]);
  await expect(addProjectFromFolder(cfg, db, plain, HOME_A)).rejects.toThrow(`${plain} is not a jj repo`);
  expect(await isJjRepo(plain)).toBe(false);
  expect(listProjects(db)).toEqual([]);
});

test("an upstream's default branch is fetched into a service repo in the replicas directory", async () => {
  const { home, cfg, db } = await freshNode();
  const up = `${home}/upstream`;
  const g = (...args: string[]) => git(["-c", "user.name=t", "-c", "user.email=t@t", ...args], up);
  await mkdir(up);
  await g("init", "-b", "main");
  await writeFile(`${up}/README`, "hi\n");
  await g("add", ".");
  await g("commit", "-m", "init");
  await g("branch", "dev");
  const main = (await g("rev-parse", "HEAD")).trim();
  const { added: p, saved } = await withRowChanges(db, () => addProjectFromUpstream(cfg, db, up, HOME_A, "up"));
  expect(saved).toEqual([true]);
  expect(p.name).toBe("up");
  expect(p.source).toEqual({ kind: "upstream", url: up });
  expect(p.replica).toBe(paths(cfg).replica(p.id));
  expect(p.defaultBranch).toBe("main");
  expect(await read(p.replica, "bookmarks()", 'bookmarks ++ ""')).toBe("main");
  expect(await read(p.replica, "@-")).toBe(await read(p.replica, "root()"));
  expect(listBranchRows(db, p.id)).toEqual([{ project: p.id, branch: "main", node: HOME_A, seq: 1, commit: main, drops: [] }]);
  expect(getProject(db, p.id)).toEqual(p);
  // The upstream stays the service repo's `origin`, which nothing fetches from after the add.
  expect(await remoteList(p.replica, cfg)).toEqual([{ name: "origin", url: up }]);
  expect((await bookmarkList(p.replica, cfg)).filter((b) => b.remote !== null)).toEqual([]);
  // A project has no sync branches: what a row from before holds in `sync` and `upstream` is not read.
  db.query("UPDATE projects SET sync = ?, upstream = 1 WHERE id = ?").run(JSON.stringify(["main", "dev"]), p.id);
  expect(getProject(db, p.id)).toEqual(p);
  expect(Object.keys(p).sort()).toEqual(["defaultBranch", "home", "id", "name", "replica", "source"]);
});

test("the default branch is stored, and set-default changes it", async () => {
  const { home, cfg, db } = await freshNode();
  const folder = `${home}/repo`;
  await initColocated(folder);
  const p = await addProjectFromFolder(cfg, db, folder, HOME_A, "named");
  expect(p.defaultBranch).toBeNull();
  expect(setDefaultBranch(db, p.id, "dev")).toEqual({ ...p, defaultBranch: "dev" });
  expect(getProject(db, p.id)?.defaultBranch).toBe("dev");
  expect(setDefaultBranch(db, "nope", "dev")).toBeNull();
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
      source: { kind: "upstream", url: `meddle://${HOME_B}/project/0123456789ab` }, defaultBranch: null,
    });
    expect(getProject(db, "0123456789ab")).toEqual(p);
    expect(fired).toBe(1);
  } finally {
    stop();
  }
});

test("openDb adds the project home and the task move columns to an older database, once", async () => {
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
  expect(db.query("SELECT title, queued, moved_to, receiving_from FROM tasks").get())
    .toEqual({ title: "old", queued: null, moved_to: null, receiving_from: null });
  db.close();
});

test("listLiveTasks leaves out moved, receiving and archived tasks; listArchivedTasks lists only archived ones", async () => {
  const { db } = await freshNode();
  for (const [id, state] of [["t1", "idle"], ["t2", "moved"], ["t3", "running"], ["t4", "receiving"], ["t5", "waiting"], ["t6", "archived"], ["t7", "moved"]] as const) {
    insertTask(db, { id, title: id, state, session_id: id, manifest: "{}", started: 0, turns: 0 });
  }
  // A moved row that still says where it was archived is not an archived task.
  updateTask(db, "t7", { archived_on: "n", archived_at: new Date().toISOString() });
  expect(listLiveTasks(db).map((t) => t.id)).toEqual(["t1", "t3", "t5"]);
  expect(listArchivedTasks(db).map((t) => t.id)).toEqual(["t6"]);
  expect(listTasks(db)).toHaveLength(7);
});
