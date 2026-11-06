// test/provision.test.ts
import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { mkdtemp, readlink, readFile, lstat } from "node:fs/promises";
import { loadConfig, ensureDataDirs, paths } from "../src/config";
import { openDb } from "../src/store/db";
import type { Database } from "bun:sqlite";
import { addProjectFromFolder, type Project } from "../src/projects/project";
import { resolveStarts } from "../src/projects/starts";
import { newId } from "../src/store/records";
import { provisionFromManifest, provisionTask, cwdFor, unscopeWorkspace, workspaceImmutableHeads } from "../src/tasks/provision";
import { initColocated, isJjRepo, jj, workspaceConfigPath } from "../src/jj";
import type { NodeConfig } from "../src/config";

/** The home node id of the projects these tests add. */
const PROJECT_HOME = "a".repeat(64);

/** A fresh colocated repo at `repo` with a first commit, `@` empty on it: a task of it starts there. */
async function initCommitted(repo: string): Promise<void> {
  await initColocated(repo);
  await (await import("node:fs/promises")).writeFile(`${repo}/README`, "init\n");
  await jj(["commit", "-m", "init"], repo);
}

/** Provisions a new task of `projects` (homed on `PROJECT_HOME`), each starting where its home resolves (`startAt`). */
async function provision(cfg: NodeConfig, db: Database, title: string, projects: Project[]) {
  const taskId = newId();
  const starts = await resolveStarts({ cfg, db, selfId: PROJECT_HOME }, taskId, projects.map((p) => ({ id: p.id })));
  return provisionTask(cfg, db, { title, taskId, starts });
}
test("provision creates workspaces, config dir links and CLAUDE.md, seeding the profile first", async () => {
  const home = await mkdtemp("/tmp/meddle-prov-");
  const cfg = loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/data`, MEDDLE_TASK_ROOT: `${home}/tasks` });
  await ensureDataDirs(cfg);
  await (await import("node:fs/promises")).mkdir(cfg.taskRoot, { recursive: true });
  const db = openDb(`${home}/data/meddle.sqlite`);
  const a = `${home}/a`; await initCommitted(a);
  const pa = await addProjectFromFolder(cfg, db, a, PROJECT_HOME, "a");
  const m = await provision(cfg, db, "t", [pa]);
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
  await expect(provisionTask(cfg, db, { title: "t", taskId: newId(), starts: [] })).rejects.toThrow(/task root/);
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
  const a = `${home}/a`; await initCommitted(a);
  const b = `${home}/b`; await initCommitted(b);
  const pa = await addProjectFromFolder(cfg, db, a, PROJECT_HOME, "a");
  const pb = await addProjectFromFolder(cfg, db, b, PROJECT_HOME, "b");
  const m = await provision(cfg, db, "pair", [pa, pb]);
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
  await expect(provisionTask(cfg, db, { title: "t", taskId: newId(), starts: [{ projectId: "0123456789ab", kind: "sync", branch: "main" }] })).rejects.toThrow(
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
  const a = `${home}/a`; await initCommitted(a);
  const b = `${home}/b`; await initCommitted(b);
  const pa = await addProjectFromFolder(cfg, db, a, PROJECT_HOME, "a");
  const pb = await addProjectFromFolder(cfg, db, b, PROJECT_HOME, "b");
  // b's start names a commit b does not have.
  const taskId = newId();
  const [startA] = await resolveStarts({ cfg, db, selfId: PROJECT_HOME }, taskId, [{ id: pa.id }]);
  const missing = "1".repeat(40);
  await expect(
    provisionTask(cfg, db, { title: "t", taskId, starts: [startA!, { projectId: pb.id, kind: "line", mode: "child", commit: missing, base: missing }] }),
  ).rejects.toThrow(missing);
  expect(await readdir(cfg.taskRoot)).toEqual([]);
  for (const repo of [a, b]) {
    expect((await jj(["workspace", "list", "-T", 'name ++ "\\n"'], repo)).trim()).toBe("default");
    expect((await jj(["bookmark", "list", "-T", 'name ++ "\\n"'], repo)).trim()).not.toContain("meddle/task/");
  }
  const { listTasks } = await import("../src/store/records");
  expect(listTasks(db)).toEqual([]);
});
/** A node in a temp home with project `a` (a folder, its own home) whose repo has a commit `main`; that commit's id. */
async function projectWithMain() {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const home = await mkdtemp("/tmp/meddle-prov-");
  const cfg = loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/data`, MEDDLE_TASK_ROOT: `${home}/tasks` });
  await ensureDataDirs(cfg);
  await mkdir(cfg.taskRoot, { recursive: true });
  const db = openDb(`${home}/data/meddle.sqlite`);
  const a = `${home}/a`; await initColocated(a);
  await writeFile(`${a}/mine`, "mine\n");
  await jj(["commit", "-m", "mine"], a);
  await jj(["bookmark", "set", "main", "-r", "@-"], a);
  const main = (await jj(["log", "--ignore-working-copy", "-r", "main", "--no-graph", "-T", "commit_id"], a)).trim();
  const pa = await addProjectFromFolder(cfg, db, a, PROJECT_HOME, "a");
  return { cfg, db, a, pa, main };
}

test("provision scopes each workspace to its task's line, from its start's base; unscopeWorkspace removes that config", async () => {
  const { cfg, db, a, pa, main } = await projectWithMain();
  const m = await provision(cfg, db, "t", [pa]);
  expect(m.projects[0]!.base).toBe(main);
  const workspace = `${paths(cfg).task(m.id)}/a`;
  const immutableHeads = 'revset-aliases."immutable_heads()"';
  const scoped = workspaceImmutableHeads(m.id, main);
  expect(scoped).toBe(`present(${main}) | untracked_remote_bookmarks(~glob:"task/${m.id}/*", remote=exact:"meddle")`);
  expect((await jj(["config", "get", immutableHeads], workspace, cfg)).trim()).toBe(scoped);
  // The user's own workspace keeps jj's default.
  expect(await jj(["config", "get", immutableHeads], a, cfg).catch(() => "")).not.toContain(m.id);
  const file = await workspaceConfigPath(workspace, cfg);
  expect(await Bun.file(file).text()).toContain(scoped);

  await unscopeWorkspace(cfg, workspace);
  expect(await Bun.file(file).exists()).toBe(false);
  expect(existsSync(dirname(file))).toBe(false);
  expect(await jj(["config", "get", immutableHeads], workspace, cfg).catch(() => "")).not.toContain(m.id);
  // Nothing to remove is no error.
  await unscopeWorkspace(cfg, workspace);
});

test("unscopeWorkspace of a workspace whose folder is gone still removes its jj config folder, and no other", async () => {
  const { rm } = await import("node:fs/promises");
  const { cfg, db, pa } = await projectWithMain();
  const m1 = await provision(cfg, db, "t1", [pa]);
  const m2 = await provision(cfg, db, "t2", [pa]);
  const gone = `${paths(cfg).task(m1.id)}/a`;
  const kept = `${paths(cfg).task(m2.id)}/a`;
  const goneConfig = dirname(await workspaceConfigPath(gone, cfg));
  const keptConfig = dirname(await workspaceConfigPath(kept, cfg));
  expect(existsSync(goneConfig)).toBe(true);
  await rm(gone, { recursive: true, force: true });
  await unscopeWorkspace(cfg, gone);
  expect(existsSync(goneConfig)).toBe(false);
  expect(existsSync(keptConfig)).toBe(true);
  // Nothing left to remove is no error.
  await unscopeWorkspace(cfg, gone);
});

test("the agent's jj, in the environment meddle gives its Claude Code, reads its workspace's config: it may describe its line's head", async () => {
  const { mkdtemp: tempDir } = await import("node:fs/promises");
  const { buildEnv } = await import("../src/engine/options");
  const { writeLine } = await import("../src/projects/lines");
  const { cfg, db, a, pa } = await projectWithMain();
  // The preload's own config dir, not `~/.config`: where meddle's jj wrote the workspace's config.
  expect(process.env.XDG_CONFIG_HOME).toStartWith(tmpdir());
  const m = await provision(cfg, db, "t", [pa]);
  const workspace = `${paths(cfg).task(m.id)}/a`;
  const head = (await jj(["log", "-r", "@", "--no-graph", "-T", "commit_id"], workspace, cfg)).trim();
  await writeLine(cfg, a, m.id, "a", head);
  const env = buildEnv({
    cfg, manifest: m, contexts: [], projectSettings: [], token: "tok", prompt: (async function* () {})(),
    canUseTool: async () => ({ behavior: "deny" as const, message: "x" }), onPermissionDenied: () => {}, sessionStore: {} as never,
    resume: false, extraEnv: { JJ_USER: "agent", JJ_EMAIL: "agent@meddle.invalid" },
  });
  expect(env.XDG_CONFIG_HOME).toBe(process.env.XDG_CONFIG_HOME!);
  const describe = async (childEnv: Record<string, string>) => {
    const proc = Bun.spawn(["jj", "describe", "-r", head, "-m", "by the agent"], { cwd: workspace, env: childEnv, stdout: "pipe", stderr: "pipe" });
    return { code: await proc.exited, stderr: await new Response(proc.stderr).text() };
  };
  // Without it (and a home of its own, so no developer config is read) the agent's jj would hold its own head immutable.
  const { XDG_CONFIG_HOME: _, ...without } = env;
  const refused = await describe({ ...without, HOME: await tempDir("/tmp/meddle-prov-home-") });
  expect(refused.code).not.toBe(0);
  expect(refused.stderr).toContain(`Commit ${head.slice(0, 12)} is immutable`);
  expect(await describe(env)).toMatchObject({ code: 0 });
  expect((await jj(["log", "-r", "@", "--no-graph", "-T", "description"], workspace, cfg)).trim()).toBe("by the agent");
});

test("a task's workspace may not rewrite a commit another task's line also holds; alone on it, its own line's head it may", async () => {
  const { writeLine, releaseLines } = await import("../src/projects/lines");
  const { cfg, db, a, pa } = await projectWithMain();
  const m = await provision(cfg, db, "t", [pa]);
  const workspace = `${paths(cfg).task(m.id)}/a`;
  await (await import("node:fs/promises")).writeFile(`${workspace}/work`, "work\n");
  const head = (await jj(["log", "-r", "@", "--no-graph", "-T", "commit_id"], workspace, cfg)).trim();
  await writeLine(cfg, a, m.id, "a", head);
  // Another task's line on the same commit (a child start at this task's line head).
  await writeLine(cfg, a, "othertask", "a", head);
  const describe = () => jj(["describe", "-r", head, "-m", "by the agent"], workspace, cfg);
  await expect(describe()).rejects.toThrow(`Commit ${head.slice(0, 12)} is immutable`);
  await releaseLines(cfg, a, "othertask", []);
  await describe();
  expect((await jj(["log", "-r", "@", "--no-graph", "-T", "description"], workspace, cfg)).trim()).toBe("by the agent");
});

test("a received manifest keeps its projects' base; one without (an older node's) takes the root commit, whatever its parent names", async () => {
  const { cfg, db, a, pa } = await projectWithMain();
  const m = await provision(cfg, db, "t", [pa]);
  const root = "0".repeat(40);
  const { base: _, ...older } = m.projects[0]!;
  const fromOlder = await provisionFromManifest(cfg, db, { ...m, id: "0123456789ab", projects: [{ ...older, parent: "main" }] }, { [pa.id]: "@" }, "idle");
  expect(fromOlder.projects[0]!.base).toBe(root);
  expect(fromOlder.projects[0]!.parent).toBe("@");
  // A main-era task created off its home, moved or restored onto it: its parent names a remote the home does not have.
  const head = (await jj(["log", "--ignore-working-copy", "-r", "main", "--no-graph", "-T", "commit_id"], a, cfg)).trim();
  const fromTrunk = await provisionFromManifest(
    cfg, db, { ...m, id: "0123456789ac", projects: [{ ...older, parent: `trunk@${PROJECT_HOME.slice(0, 10)}` }] }, { [pa.id]: head }, "idle",
  );
  expect(fromTrunk.projects[0]!.base).toBe(root);
  const trunkWorkspace = `${paths(cfg).task("0123456789ac")}/a`;
  expect((await jj(["config", "get", 'revset-aliases."immutable_heads()"'], trunkWorkspace, cfg)).trim()).toBe(workspaceImmutableHeads("0123456789ac", root));
  // Its earlier work, below the commit it arrived at, stays its own to rewrite (once task m's line no longer holds it).
  const { releaseLines } = await import("../src/projects/lines");
  await releaseLines(cfg, a, m.id, []);
  await jj(["describe", "-r", head, "-m", "reworded by the agent"], trunkWorkspace, cfg);
  const kept = await provisionFromManifest(cfg, db, { ...m, id: "ba9876543210", projects: [{ ...m.projects[0]!, base: "0".repeat(40) }] }, { [pa.id]: "main" }, "idle");
  expect(kept.projects[0]!.base).toBe("0".repeat(40));
  // A base is a commit id, never anything else jj would read as a revset.
  await expect(provisionFromManifest(cfg, db, { ...m, id: "abababababab", projects: [{ ...m.projects[0]!, base: "all()" }] }, { [pa.id]: "main" }, "idle"))
    .rejects.toThrow("invalid base: all()");
  const workspace = `${paths(cfg).task("ba9876543210")}/a`;
  expect((await jj(["config", "get", 'revset-aliases."immutable_heads()"'], workspace, cfg)).trim()).toBe(workspaceImmutableHeads("ba9876543210", "0".repeat(40)));
});

test("a task provisioned from a manifest onto its home never snapshots the user's working copy but to add its workspace, nor on a failure", async () => {
  const { chmod, mkdir, readFile: read, writeFile } = await import("node:fs/promises");
  const { cfg, db, a, pa, main } = await projectWithMain();
  const m = await provision(cfg, db, "t", [pa]);
  // meddle's jj runs with `<data>/bin` first on PATH: a jj there notes each command run in the user's folder.
  const calls = `${cfg.dataDir}/jj-calls`;
  await mkdir(paths(cfg).bin, { recursive: true });
  await writeFile(`${paths(cfg).bin}/jj`, `#!/bin/sh\nif [ "$PWD" = "${a}" ]; then printf '%s' "$*" | tr '\\n' ' ' >> "${calls}"; echo >> "${calls}"; fi\nexec "${Bun.which("jj")}" "$@"\n`);
  await chmod(`${paths(cfg).bin}/jj`, 0o755);
  await provisionFromManifest(cfg, db, { ...m, id: "0123456789ad" }, { [pa.id]: main }, "idle");
  // A failure after the bookmark is set forgets it again and drops the workspace: a second workspace of the same repo.
  const twice = { ...m, id: "0123456789ae", projects: [m.projects[0]!, { ...m.projects[0]!, workspace: "b" }] };
  await expect(provisionFromManifest(cfg, db, twice, { [pa.id]: main }, "idle")).rejects.toThrow();
  const run = (await read(calls, "utf8")).split("\n").filter(Boolean);
  expect(run.some((c) => c.includes("bookmark set"))).toBe(true);
  expect(run.some((c) => c.includes("bookmark forget"))).toBe(true);
  expect(run.some((c) => c.includes("workspace forget"))).toBe(true);
  // jj refuses `--ignore-working-copy` to `workspace add` alone.
  expect(run.filter((c) => !c.includes("--ignore-working-copy") && !c.includes("workspace add"))).toEqual([]);
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
  const m = await provisionTask(cfg, db, { title: "loose", taskId: newId(), starts: [] });
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
  const { createTask } = await import("./helpers");
  const node = await setupNode();
  const { runner, db, cfg } = node;
  const m = await createTask(node, { title: "loose", projectIds: [] });
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

test("provision takes each start: a child start on its commit, an edit start editing it, a sync start on its fetched commit", async () => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const home = await mkdtemp("/tmp/meddle-prov-");
  const cfg = loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/data`, MEDDLE_TASK_ROOT: `${home}/tasks` });
  await ensureDataDirs(cfg);
  await mkdir(cfg.taskRoot, { recursive: true });
  const db = openDb(`${home}/data/meddle.sqlite`);
  const read = async (repo: string, rev: string) => (await jj(["log", "--ignore-working-copy", "-r", rev, "--no-graph", "-T", "commit_id"], repo)).trim();
  // Each repo: P, then W with content on it, `@` back on P.
  const repos: Record<string, { project: Project; P: string; W: string }> = {};
  for (const name of ["a", "b", "c"]) {
    const repo = `${home}/${name}`;
    await initCommitted(repo);
    const P = await read(repo, "@-");
    await writeFile(`${repo}/w`, "w\n");
    await jj(["commit", "-m", "W"], repo);
    const W = await read(repo, "@-");
    await jj(["new", P], repo);
    repos[name] = { project: await addProjectFromFolder(cfg, db, repo, PROJECT_HOME, name), P, W };
  }
  const { a, b, c } = repos as Record<"a" | "b" | "c", { project: Project; P: string; W: string }>;
  const taskId = newId();
  const m = await provisionTask(cfg, db, {
    title: "t",
    taskId,
    starts: [
      { projectId: a.project.id, kind: "line", mode: "child", commit: a.W, base: a.W },
      { projectId: b.project.id, kind: "line", mode: "edit", commit: b.W, base: b.P },
      { projectId: c.project.id, kind: "sync", branch: "main" },
    ],
    synced: { [c.project.id]: c.P },
  });
  const task = paths(cfg).task(taskId);
  expect(m.id).toBe(taskId);
  expect(m.projects.map((p) => [p.name, p.parent, p.base])).toEqual([["a", a.W, a.W], ["b", b.W, b.P], ["c", c.P, c.P]]);
  expect(await read(`${task}/a`, "@-")).toBe(a.W);
  expect(await read(`${task}/b`, "@")).toBe(b.W);
  expect(await read(`${task}/c`, "@-")).toBe(c.P);
  // Each task bookmark is the workspace's working copy: on W itself for the edit.
  expect(await read(b.project.replica, `meddle/task/${taskId}/b`)).toBe(b.W);
  expect(await read(a.project.replica, `meddle/task/${taskId}/a`)).toBe(await read(`${task}/a`, "@"));
  for (const [name, base] of [["a", a.W], ["b", b.P], ["c", c.P]] as const) {
    expect((await jj(["config", "get", 'revset-aliases."immutable_heads()"'], `${task}/${name}`, cfg)).trim()).toBe(workspaceImmutableHeads(taskId, base));
  }

  // The same id again, an id that is not one path segment, and a start that names no commit id are refused.
  const start = { projectId: a.project.id, kind: "line" as const, mode: "child" as const, commit: a.W, base: a.W };
  await expect(provisionTask(cfg, db, { title: "t", taskId, starts: [start] })).rejects.toThrow(`task ${taskId} exists here`);
  await expect(provisionTask(cfg, db, { title: "t", taskId: "../x", starts: [start] })).rejects.toThrow("invalid task id: ../x");
  await expect(provisionTask(cfg, db, { title: "t", taskId: newId(), starts: [{ ...start, base: "all()" }] })).rejects.toThrow("invalid commit: all()");
  await expect(provisionTask(cfg, db, { title: "t", taskId: newId(), starts: [{ projectId: c.project.id, kind: "sync", branch: "main" }] }))
    .rejects.toThrow("no commit for the sync start of c");
});
