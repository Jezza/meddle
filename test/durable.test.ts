// test/durable.test.ts
import { test, expect, spyOn } from "bun:test";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { loadConfig, ensureDataDirs, paths, type NodeConfig } from "../src/config";
import { openDb } from "../src/store/db";
import { addProjectFromFolder } from "../src/projects/project";
import { initColocated } from "../src/jj";
import { openHarness } from "../src/tasks/harness";
import { CARRY_ON_PROMPT, TaskRunner } from "../src/tasks/durable";
import { appendEvent, listEvents } from "../src/store/events";
import { getTask, queuedOf, updateTask } from "../src/store/records";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { jj } from "../src/jj";
import { listLineRows, writeBranchRow } from "../src/pool/rows";
import { readManifest, transcriptPath, writeManifest, type TaskManifest } from "../src/tasks/manifest";
import type { Attachment, Prompt } from "../src/blobs/attachment";
import { createTask, setupNode } from "./helpers";
import { peerReady, startPoolNode, twoPoolNodes } from "./pool-helpers";

/** The home node id of the projects these tests add. */
const PROJECT_HOME = "a".repeat(64);
const replay = `${import.meta.dir}/fake-claude/replay.ts`;
/**
 * Gives the fresh repo at `repo` a first commit (a README and `files`, by path), bookmarked `main` (the project's default
 * branch): a task of it starts there.
 */
async function committed(repo: string, files: Record<string, string> = {}): Promise<void> {
  await writeFile(`${repo}/README`, "a\n");
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(repo, path, ".."), { recursive: true });
    await writeFile(join(repo, path), text);
  }
  await jj(["commit", "-m", "init"], repo);
  await jj(["bookmark", "set", "main", "-r", "@-"], repo);
}
test("a prompt runs a durable turn and leaves the task idle", async () => {
  const home = await mkdtemp("/tmp/meddle-dur-");
  const cfg = loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/d`, MEDDLE_TASK_ROOT: `${home}/t` });
  await ensureDataDirs(cfg); await mkdir(cfg.taskRoot, { recursive: true });
  const db = openDb(paths(cfg).db);
  const a = `${home}/a`; await initColocated(a); await committed(a);
  const p = await addProjectFromFolder(cfg, db, a, PROJECT_HOME, "a");
  await (await import("../src/token")).addToken(cfg, db, "tok", { setBy: null });
  const fixture = `${import.meta.dir}/fixtures/hello.jsonl`;
  const open = async (extra: Record<string,string> = {}) => { const { createRegistry } = await import("@earendil-works/pi-durable"); const h = await openHarness(cfg, createRegistry()); return { h, runner: new TaskRunner(cfg, db, h.harness, { claudePath: replay, claudeRuntime: "bun", extraEnv: { MEDDLE_FIXTURE: fixture, ...extra } }) }; };
  const { h, runner } = await open();
  const m = await createTask({ cfg, db, id: PROJECT_HOME, runner }, { title: "t", projectIds: [p.id] });
  const result = (r: TaskRunner, id: string) => new Promise<void>(res => r.onEvent((tid, _s, msg: any) => { if (tid === id && msg.type === "result") res(); }));
  const idle = (r: TaskRunner, id: string) => new Promise<void>(res => r.onState((tid, s) => { if (tid === id && s === "idle") res(); }));
  const first = result(runner, m.id);
  const firstIdle = idle(runner, m.id);
  await runner.prompt(m.id, "Reply with the single word ok.");
  await first; await firstIdle;
  expect(runner.state(m.id)).toBe("idle");
  const started = listEvents(db, m.id).filter(e => (e.message as any).subtype === "turn_started").map(e => (e.message as any).resume);
  expect(started).toEqual([false]);
  const second = result(runner, m.id);
  const secondIdle = idle(runner, m.id);
  await runner.prompt(m.id, "Again.");
  await second; await secondIdle;
  expect(listEvents(db, m.id).filter(e => (e.message as any).subtype === "turn_started").map(e => (e.message as any).resume)).toEqual([false, true]);
  // the first turn ended with its result, so the new turn is no rerun: it sends its own prompt
  const prompts = listEvents(db, m.id).filter(e => (e.message as any).type === "user").map(e => (e.message as any).message.content);
  expect(prompts).toEqual(["Reply with the single word ok.", "Again."]);
  await h.close();
});
test("a turn interrupted by a process death resumes after reopen", async () => {
  const home = await mkdtemp("/tmp/meddle-dur-");
  const cfg = loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/d`, MEDDLE_TASK_ROOT: `${home}/t` });
  await ensureDataDirs(cfg); await mkdir(cfg.taskRoot, { recursive: true });
  const db = openDb(paths(cfg).db);
  const a = `${home}/a`; await initColocated(a); await committed(a);
  const p = await addProjectFromFolder(cfg, db, a, PROJECT_HOME, "a");
  await (await import("../src/token")).addToken(cfg, db, "tok", { setBy: null });
  const fixture = `${import.meta.dir}/fixtures/hello.jsonl`;
  const input = `${await mkdtemp("/tmp/meddle-input-")}/input.jsonl`; // what each Claude Code run is sent
  const open = async (extra: Record<string,string> = {}) => { const { createRegistry } = await import("@earendil-works/pi-durable"); const h = await openHarness(cfg, createRegistry()); return { h, runner: new TaskRunner(cfg, db, h.harness, { claudePath: replay, claudeRuntime: "bun", extraEnv: { MEDDLE_FIXTURE: fixture, MEDDLE_FIXTURE_INPUT: input, ...extra } }) }; };
  const turnsStarted = () => listEvents(db, m.id).filter(e => (e.message as any).subtype === "turn_started").map(e => (e.message as any).resume);
  // 1. the first process stalls before the result; closing its Harness kills the turn mid-way
  const { h, runner } = await open({ MEDDLE_FIXTURE_STALL: "1" });
  const m = await createTask({ cfg, db, id: PROJECT_HOME, runner }, { title: "t", projectIds: [p.id] });
  // by its init, Claude Code has read the prompt and written the session's transcript, so the rerun resumes it
  const initialised = new Promise<void>(res => runner.onEvent((tid, _s, msg: any) => { if (tid === m.id && msg.type === "system" && msg.subtype === "init") res(); }));
  await runner.prompt(m.id, "Reply with the single word ok.");
  await initialised;
  expect(runner.state(m.id)).toBe("running");
  // a steer into the live turn is sent, and queued (told to listeners) until Claude Code takes it: not logged yet
  const told: Prompt[][] = [];
  runner.onQueued((tid) => { if (tid === m.id) told.push(runner.queued(m.id)); });
  await runner.prompt(m.id, "Also say why.");
  expect(runner.queued(m.id)).toEqual([{ text: "Also say why.", attachments: [] }]);
  expect(told).toEqual([[{ text: "Also say why.", attachments: [] }]]);
  expect(listEvents(db, m.id).filter(e => (e.message as any).type === "user").map(e => (e.message as any).message.content)).toEqual(["Reply with the single word ok."]);
  await h.close();
  expect(runner.liveQuery(m.id)).toBeNull();
  expect(turnsStarted()).toEqual([false]);
  // the turn was killed before Claude Code took the steer: it waits as the task's next prompt
  expect(queuedOf(getTask(db, m.id)!)).toEqual([{ text: "Also say why.", attachments: [] }]);
  // 2. a fresh process reruns the parked phase, which resumes the session and finishes the turn; the steer runs next
  const again = await open();
  let results = 0;
  const finished = new Promise<void>(res => again.runner.onEvent((tid, _s, msg: any) => { if (tid === m.id && msg.type === "result" && ++results === 2) res(); }));
  await finished;
  await eventually(() => again.runner.state(m.id) === "idle", () => again.runner.state(m.id));
  // 3. one fresh start, one resume, then the steer's own turn, and the task is idle again with nothing queued
  expect(turnsStarted()).toEqual([false, true, true]);
  expect(again.runner.queued(m.id)).toEqual([]);
  // the close logged turn_aborted, so the rerun told Claude to carry on rather than sending the prompt again
  const prompts = listEvents(db, m.id).filter(e => (e.message as any).type === "user").map(e => (e.message as any).message.content);
  expect(prompts).toEqual(["Reply with the single word ok.", CARRY_ON_PROMPT, "Also say why."]);
  // the person's prompt and steer go to Claude Code as a human's (each time it is sent); meddle's own carry-on does not
  const sent = readFileSync(input, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
  expect(sent.map(f => [f.message.content, f.origin])).toEqual([
    ["Reply with the single word ok.", { kind: "human" }],
    ["Also say why.", { kind: "human" }],
    [CARRY_ON_PROMPT, undefined],
    ["Also say why.", { kind: "human" }],
  ]);
  await again.h.close();
});
test("a pending approval makes the task waiting until it is answered", async () => {
  const home = await mkdtemp("/tmp/meddle-dur-");
  const cfg = loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/d`, MEDDLE_TASK_ROOT: `${home}/t` });
  await ensureDataDirs(cfg); await mkdir(cfg.taskRoot, { recursive: true });
  const db = openDb(paths(cfg).db);
  const a = `${home}/a`; await initColocated(a); await committed(a);
  const p = await addProjectFromFolder(cfg, db, a, PROJECT_HOME, "a");
  const { createRegistry } = await import("@earendil-works/pi-durable");
  const h = await openHarness(cfg, createRegistry());
  const runner = new TaskRunner(cfg, db, h.harness, { claudePath: replay, claudeRuntime: "bun", extraEnv: { MEDDLE_FIXTURE: `${import.meta.dir}/fixtures/approval.jsonl` } });
  await expect(createTask({ cfg, db, id: PROJECT_HOME, runner }, { title: "t", projectIds: [p.id] })).rejects.toThrow("no usable token");
  await (await import("../src/token")).addToken(cfg, db, "tok", { setBy: null });
  const m = await createTask({ cfg, db, id: PROJECT_HOME, runner }, { title: "t", projectIds: [p.id] });
  const states: string[] = [];
  runner.onState((tid, s) => { if (tid === m.id) states.push(`${s}/${runner.state(m.id)}`); });
  runner.approvals.onChange(() => { for (const q of runner.approvals.pending(m.id)) runner.approvals.answer(q.requestId, { behavior: "allow", updatedInput: q.input }); });
  const idle = new Promise<void>(res => runner.onState((tid, s) => { if (tid === m.id && s === "idle") res(); }));
  await runner.prompt(m.id, "Run: echo hi");
  await idle;
  expect(states).toEqual(["running/running", "waiting/waiting", "running/running", "idle/idle"]);
  await h.close();
});
/** A node with project `a`, whose first commit also holds `files` (by path), and a task of it. */
async function setup(files: Record<string, string> = {}) {
  const home = await mkdtemp("/tmp/meddle-dur-");
  const cfg = loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/d`, MEDDLE_TASK_ROOT: `${home}/t` });
  await ensureDataDirs(cfg); await mkdir(cfg.taskRoot, { recursive: true });
  const db = openDb(paths(cfg).db);
  const a = `${home}/a`; await initColocated(a); await committed(a, files);
  const p = await addProjectFromFolder(cfg, db, a, PROJECT_HOME, "a");
  await (await import("../src/token")).addToken(cfg, db, "tok", { setBy: null });
  const fixture = `${import.meta.dir}/fixtures/hello.jsonl`;
  const open = async (extra: Record<string,string> = {}) => { const { createRegistry } = await import("@earendil-works/pi-durable"); const h = await openHarness(cfg, createRegistry()); return { h, runner: new TaskRunner(cfg, db, h.harness, { claudePath: replay, claudeRuntime: "bun", extraEnv: { MEDDLE_FIXTURE: fixture, ...extra } }) }; };
  const { h, runner } = await open();
  const m = await createTask({ cfg, db, id: PROJECT_HOME, runner }, { title: "t", projectIds: [p.id] });
  const turnsStarted = () => listEvents(db, m.id).filter(e => (e.message as any).subtype === "turn_started").map(e => (e.message as any).resume);
  /** Resolves on the first `idle` after a `result`: the turn is over. */
  const settled = (r: TaskRunner) => new Promise<void>(res => {
    let seen = false;
    r.onEvent((tid, _s, msg: any) => { if (tid === m.id && msg.type === "result") seen = true; });
    r.onState((tid, s) => { if (tid === m.id && seen && s === "idle") res(); });
  });
  return { cfg, db, h, runner, m, open, turnsStarted, settled };
}
test("a task started without any Claude Code output is reconciled and starts its session fresh", async () => {
  const { db, h, runner, m, turnsStarted, settled } = await setup();
  // a turn died before Claude Code said anything: started is set, the state is stuck running, no turn exists
  updateTask(db, m.id, { started: 1, state: "running" });
  appendEvent(db, m.id, { type: "meddle", subtype: "turn_started", at: new Date().toISOString(), resume: false });
  appendEvent(db, m.id, { type: "user", message: { role: "user", content: "lost" }, parent_tool_use_id: null });
  await expect(runner.retry(m.id)).rejects.toThrow(`nothing to retry for task ${m.id}`);
  const done = settled(runner);
  await runner.prompt(m.id, "Reply with the single word ok.");
  await done;
  expect(turnsStarted()).toEqual([false, false]);
  expect(runner.state(m.id)).toBe("idle");
  await h.close();
});
test("concurrent prompts start one turn and queue the other as the next, and throwing listeners do not break it", async () => {
  const { db, h, runner, m, turnsStarted } = await setup();
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    runner.onEvent(() => { throw new Error("event listener"); });
    runner.onState(() => { throw new Error("state listener"); });
    runner.onQueued(() => { throw new Error("queued listener"); });
    let results = 0;
    runner.onEvent((tid, _s, msg: any) => { if (tid === m.id && msg.type === "result") results++; });
    const outcomes = await Promise.allSettled([runner.prompt(m.id, "one"), runner.prompt(m.id, "two")]);
    expect(outcomes.map(o => o.status)).toEqual(["fulfilled", "fulfilled"]);
    await eventually(() => results === 2 && runner.state(m.id) === "idle", () => `${results} results, ${runner.state(m.id)}`);
    expect(turnsStarted()).toEqual([false, true]);
    expect(listEvents(db, m.id).filter(e => (e.message as any).type === "user").map(e => (e.message as any).message.content)).toEqual(["one", "two"]);
    expect(runner.queued(m.id)).toEqual([]);
    expect(logged).toHaveBeenCalled();
  } finally {
    logged.mockRestore();
  }
  await h.close();
});
test("a turn cut off after it ended finishes on reopen without running again", async () => {
  const { db, h, runner, m, open, turnsStarted } = await setup();
  const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
  const graph = await h.harness.taskGraph(BACKGROUND_CONTEXT);
  // close the Harness as soon as the turn's `finish` checkpoint is committed, while its bookmarks are being set
  const closed = new Promise<void>(res => graph.subscribe(value => {
    if (Object.values(value.tasks).some(t => t.kind === "meddle.turn" && "phase" in t.state && t.state.phase === "finish")) res(h.close());
  }));
  await runner.prompt(m.id, "Reply with the single word ok.");
  await closed;
  graph.dispose();
  expect(runner.state(m.id)).toBe("running");
  const again = await open();
  await new Promise<void>(res => again.runner.onState((tid, s) => { if (tid === m.id && s === "idle") res(); }));
  expect(turnsStarted()).toEqual([false]);
  expect(listEvents(db, m.id).filter(e => (e.message as any).type === "result")).toHaveLength(1);
  expect(getTask(db, m.id)?.turns).toBe(1);
  await again.h.close();
});
test("a task started before with no transcript on disk starts its session fresh, even after Claude Code said something", async () => {
  const { db, h, runner, m, turnsStarted, settled } = await setup();
  // the last turn died after Claude Code's init but before it wrote the transcript
  updateTask(db, m.id, { started: 1 });
  appendEvent(db, m.id, { type: "meddle", subtype: "turn_started", at: new Date().toISOString(), resume: false });
  appendEvent(db, m.id, { type: "system", subtype: "init", session_id: m.sessionId });
  const done = settled(runner);
  await runner.prompt(m.id, "Reply with the single word ok.");
  await done;
  expect(turnsStarted()).toEqual([false, false]);
  await h.close();
});
test("a turn that fails before it runs logs turn_failed with the reason, and pi-durable's report reaches the log", async () => {
  // The project's context, committed: read from the task's start commit, whatever its workspace holds now.
  const { db, h, runner, m, cfg } = await setup({ ".meddle/context.toml": "[claude]\nallwo = []\n" });
  await writeFile(join(paths(cfg).task(m.id), "a", ".meddle", "context.toml"), "[claude]\nallow = []\n");
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    const told: unknown[] = [];
    runner.onEvent((tid, _s, msg: any) => { if (tid === m.id && msg.subtype === "turn_failed") told.push(msg); });
    const idle = new Promise<void>(res => runner.onState((tid, s) => { if (tid === m.id && s === "idle") res(); }));
    await runner.prompt(m.id, "hi");
    await idle;
    const failed = listEvents(db, m.id).map(e => e.message as any).filter(msg => msg.subtype === "turn_failed");
    expect(failed).toMatchObject([{ type: "meddle", error: "Error: context.toml: unknown key claude.allwo" }]);
    expect(told).toEqual(failed);
    for (let i = 0; i < 100 && !logged.mock.calls.some(c => String(c[0]).includes("task_faulted")); i++) await Bun.sleep(10);
    expect(logged.mock.calls.some(c => String(c[0]).startsWith("meddle: durable task_faulted (meddle.turn "))).toBe(true);
  } finally {
    logged.mockRestore();
  }
  await h.close();
});
test("a task's meddle context is its start commit's: editing it in the workspace changes nothing for its next turn", async () => {
  const { db, h, runner, m, cfg, settled } = await setup({ ".meddle/context.toml": 'instructions = "Committed."\n' });
  // An agent's edit, after the start: a context that would fail the turn were it read.
  await writeFile(join(paths(cfg).task(m.id), "a", ".meddle", "context.toml"), "[claude]\nallwo = []\n");
  const done = settled(runner);
  await runner.prompt(m.id, "Reply with the single word ok.");
  await done;
  const messages = listEvents(db, m.id).map(e => e.message as any);
  expect(messages.filter(msg => msg.subtype === "turn_failed")).toEqual([]);
  expect(messages.filter(msg => msg.type === "result").map(msg => msg.subtype)).toEqual(["success"]);
  await h.close();
});
test("a task's meddle context comes from its row: editing task.json's copy changes nothing", async () => {
  const { db, h, runner, m, cfg, settled } = await setup({ ".meddle/context.toml": 'instructions = "Committed."\n' });
  expect(m.projects[0]!.context).toBe('instructions = "Committed."\n');
  // task.json is in the task's folder, where its agent can write: a context there that would fail the turn.
  const file = await readManifest(cfg, m.id);
  await writeManifest(cfg, { ...file, projects: [{ ...file.projects[0]!, context: "[claude]\nallwo = []\n" }] });
  const done = settled(runner);
  await runner.prompt(m.id, "Reply with the single word ok.");
  await done;
  const messages = listEvents(db, m.id).map(e => e.message as any);
  expect(messages.filter(msg => msg.subtype === "turn_failed")).toEqual([]);
  expect(messages.filter(msg => msg.type === "result").map(msg => msg.subtype)).toEqual(["success"]);
  await h.close();
});
test("a project id in task.json that the task's row lacks fails the turn", async () => {
  const { db, h, runner, m, cfg } = await setup();
  // The agent renames the project in task.json, which is in the task's folder.
  const file = await readManifest(cfg, m.id);
  const renamed = "f".repeat(m.projects[0]!.id.length);
  await writeManifest(cfg, { ...file, projects: [{ ...file.projects[0]!, id: renamed }] });
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    const idle = new Promise<void>(res => runner.onState((tid, s) => { if (tid === m.id && s === "idle") res(); }));
    await runner.prompt(m.id, "hi");
    await idle;
    const failed = listEvents(db, m.id).map(e => e.message as any).filter(msg => msg.subtype === "turn_failed");
    expect(failed).toMatchObject([{ type: "meddle", error: `Error: task.json names project ${renamed}, which is not one of the task's` }]);
  } finally {
    logged.mockRestore();
  }
  await h.close();
});
test("a turn rewrites a stale CLAUDE.md, and leaves a current one alone", async () => {
  const { stat } = await import("node:fs/promises");
  const { getProject } = await import("../src/projects/project");
  const { generatedClaudeMd } = await import("../src/tasks/provision");
  const { cfg, db, h, runner, m, settled } = await setup();
  const file = join(paths(cfg).task(m.id), "CLAUDE.md");
  const project = getProject(db, m.projects[0]!.id)!;
  const current = generatedClaudeMd(m, [project]);
  await writeFile(file, "Old text, as an older meddle wrote it.\n");
  const first = settled(runner);
  await runner.prompt(m.id, "Reply with the single word ok.");
  await first;
  expect(await readFile(file, "utf8")).toBe(current);
  expect(current).toContain("Describe each revision you make with jj describe:\nAdd a description (4-7 words) to your revision(s).");
  // The next turn finds it current and does not write it again.
  const written = (await stat(file)).mtimeMs;
  const second = settled(runner);
  await runner.prompt(m.id, "Again.");
  await second;
  expect((await stat(file)).mtimeMs).toBe(written);
  await h.close();
});
test("a prompt sent once the turn's input has closed waits, queued, and runs as the next turn", async () => {
  const { db, h, runner, m, turnsStarted } = await setup();
  let late: Promise<unknown> | undefined;
  let queuedThen: Prompt[] | undefined;
  let results = 0;
  // a microtask after the result's listeners: the turn's input is closed, its child not gone yet
  runner.onEvent((tid, _s, msg: any) => {
    if (tid !== m.id || msg.type !== "result" || ++results > 1) return;
    queueMicrotask(() => { late = runner.prompt(m.id, "too late"); late.then(() => { queuedThen = runner.queued(m.id); }, () => {}); });
  });
  await runner.prompt(m.id, "Reply with the single word ok.");
  await eventually(() => results === 2 && runner.state(m.id) === "idle", () => `${results} results, ${runner.state(m.id)}`);
  await late;
  expect(queuedThen).toEqual([{ text: "too late", attachments: [] }]);
  expect(turnsStarted()).toEqual([false, true]);
  const prompts = listEvents(db, m.id).filter(e => (e.message as any).type === "user").map(e => (e.message as any).message.content);
  expect(prompts).toEqual(["Reply with the single word ok.", "too late"]);
  expect(runner.queued(m.id)).toEqual([]);
  await h.close();
});
test("the runner says when a turn's process comes and goes, the process gone by the time it says so", async () => {
  const { runner, h, m, settled } = await setup();
  const told: boolean[] = [];
  runner.onLive((tid) => { if (tid === m.id) told.push(runner.liveQuery(m.id) !== null); });
  const over = settled(runner);
  await runner.prompt(m.id, "Reply with the single word ok.");
  await over;
  expect(told).toEqual([true, false]);
  expect(runner.liveQuery(m.id)).toBeNull();
  await h.close();
});
test("a steer Claude Code folds into the running turn is queued until it takes it, then logged there", async () => {
  const { db, h, runner, m, open } = await setup();
  await h.close();
  const steering = await open({ MEDDLE_FIXTURE: `${import.meta.dir}/fixtures/steer-fold.jsonl` });
  const STEER = "Also: end your reply with the word PINEAPPLE.";
  const told: Prompt[][] = [];
  steering.runner.onQueued((tid) => { if (tid === m.id) told.push(steering.runner.queued(m.id)); });
  let sent: Promise<unknown> | undefined;
  steering.runner.onEvent((tid, _s, msg: any) => { if (tid === m.id && msg.type === "assistant" && sent === undefined) sent = steering.runner.prompt(m.id, STEER); });
  for (const p of steering.runner.approvals.pending(m.id)) steering.runner.approvals.answer(p.requestId, { behavior: "allow", updatedInput: p.input });
  steering.runner.approvals.onChange(() => { for (const p of steering.runner.approvals.pending(m.id)) steering.runner.approvals.answer(p.requestId, { behavior: "allow", updatedInput: p.input }); });
  const end = turnEnd(steering.runner, m.id);
  await steering.runner.prompt(m.id, "Run the bash command `sleep 3; echo first`, then say done.");
  expect((await end.result).result).toBe("done\n\nPINEAPPLE");
  await end.idle;
  await sent;
  expect(told).toEqual([[{ text: STEER, attachments: [] }], []]);
  const prompts = listEvents(db, m.id).filter(e => (e.message as any).type === "user" && typeof (e.message as any).message.content === "string").map(e => (e.message as any).message.content);
  expect(prompts).toEqual(["Run the bash command `sleep 3; echo first`, then say done.", STEER]);
  expect(listEvents(db, m.id).filter(e => (e.message as any).subtype === "turn_started")).toHaveLength(1);
  await steering.h.close();
});
test("send now cuts a running task's turn short for the steer Claude Code has not taken, which runs next", async () => {
  const { db, h, m, open } = await setup();
  await h.close();
  const stalling = await open({ MEDDLE_FIXTURE_STALL: "1" });
  const { runner } = stalling;
  const STEER = "Stop that, and say why instead.";
  const prompts = () => listEvents(db, m.id).filter(e => (e.message as any).type === "user").map(e => (e.message as any).message.content);
  // an idle task has nothing waiting to send
  expect(await runner.sendNow(m.id)).toBe("nothing_waiting");
  let sent: Promise<unknown> | undefined;
  runner.onEvent((tid, _s, msg: any) => {
    if (tid === m.id && msg.type === "assistant" && sent === undefined) sent = runner.prompt(m.id, STEER).then(() => runner.sendNow(m.id));
  });
  await runner.prompt(m.id, "Reply with the single word ok.");
  await eventually(() => sent !== undefined, () => "no reply to steer");
  expect(await sent).toBe("stopped");
  // the stand-in ends rather than run the steer, so it runs as the task's next turn (which stalls in its turn)
  await eventually(() => prompts().length === 2, () => JSON.stringify(prompts()));
  expect(prompts()).toEqual(["Reply with the single word ok.", STEER]);
  await stalling.h.close();
}, 30_000);
test("take back answers a task's queued prompts, the live turn's steers first, and leaves nothing queued", async () => {
  const { db, h, m, open } = await setup();
  await h.close();
  const stalling = await open({ MEDDLE_FIXTURE_STALL: "1" });
  const { runner } = stalling;
  const STEER = "Stop that, and say why instead.";
  const prompts = () => listEvents(db, m.id).filter(e => (e.message as any).type === "user").map(e => (e.message as any).message.content);
  const told: Prompt[][] = [];
  runner.onQueued((tid) => { if (tid === m.id) told.push(runner.queued(m.id)); });
  let steered: Promise<unknown> | undefined;
  runner.onEvent((tid, _s, msg: any) => { if (tid === m.id && msg.type === "assistant" && steered === undefined) steered = runner.prompt(m.id, STEER); });
  await runner.prompt(m.id, "Reply with the single word ok.");
  await eventually(() => steered !== undefined, () => "no reply to steer");
  expect(await steered).toBe("queued");
  const later = { text: "later", attachments: [{ hash: "b".repeat(64), name: "notes.txt", type: "text/plain", size: 5 }] };
  updateTask(db, m.id, { queued: JSON.stringify([later]) });
  expect(await runner.takeBackQueued(m.id)).toEqual([{ text: STEER, attachments: [] }, later]);
  expect(runner.queued(m.id)).toEqual([]);
  expect(told.at(-1)).toEqual([]);
  const end = turnEnd(runner, m.id);
  await runner.interrupt(m.id);
  await end.idle;
  expect(runner.queued(m.id)).toEqual([]);
  expect(prompts()).toEqual(["Reply with the single word ok."]);
  expect(listEvents(db, m.id).filter(e => (e.message as any).subtype === "turn_started")).toHaveLength(1);
  await stalling.h.close();
}, 30_000);
test("take back on an idle task with nothing queued answers []", async () => {
  const { h, runner, m } = await setup();
  expect(await runner.takeBackQueued(m.id)).toEqual([]);
  await h.close();
});
test("a prompt whose turn is starting stays", async () => {
  const { db, h, runner, m } = await setup();
  const prompts = () => listEvents(db, m.id).filter(e => (e.message as any).type === "user").map(e => (e.message as any).message.content);
  updateTask(db, m.id, { queued: JSON.stringify(["a", "b"]) });
  const starting = runner.startQueued(m.id);
  expect(await runner.takeBackQueued(m.id)).toEqual([{ text: "b", attachments: [] }]);
  await starting;
  await eventually(() => prompts().includes("a"), () => JSON.stringify(prompts()));
  expect(runner.queued(m.id)).toEqual([]);
  expect(prompts()).not.toContain("b");
  await h.close();
});
test("take back while a prompt's own turn is being created takes the text queued behind it", async () => {
  const { db, h, runner, m, settled } = await setup();
  const prompts = () => listEvents(db, m.id).filter(e => (e.message as any).type === "user").map(e => (e.message as any).message.content);
  const done = settled(runner);
  const first = runner.prompt(m.id, "Reply with the single word ok.");
  expect(await runner.prompt(m.id, "behind it")).toBe("queued");
  expect(await runner.takeBackQueued(m.id)).toEqual([{ text: "behind it", attachments: [] }]);
  await first;
  await done;
  expect(runner.queued(m.id)).toEqual([]);
  expect(prompts()).toEqual(["Reply with the single word ok."]);
  await h.close();
});
test("a prompt to a task whose turn is parked retries the turn and queues the message for after it", async () => {
  const { insertTask } = await import("../src/store/records");
  const home = await mkdtemp("/tmp/meddle-dur-");
  const cfg = loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/d`, MEDDLE_TASK_ROOT: `${home}/t` });
  const db = openDb(":memory:");
  insertTask(db, { id: "t1", title: "t", state: "running", session_id: "s", manifest: "{}", started: 1, turns: 0 });
  const retried: string[] = [];
  const parked = { record: { id: "turn-1", kind: "meddle.turn", input: { taskId: "t1", prompt: "p" } }, state: { kind: "blocked", reason: "restart_limit" } };
  const harness = {
    inspect: async () => ({ tasks: [parked] }),
    retryTask: async (id: string) => { retried.push(id); },
  } as any;
  const runner = new TaskRunner(cfg, db, harness, {});
  // the prompt waits, queued, for the retried turn to end
  await runner.prompt("t1", "hello");
  expect(retried).toEqual(["turn-1"]);
  expect(runner.queued("t1")).toEqual([{ text: "hello", attachments: [] }]);
  await runner.retry("t1");
  expect(retried).toEqual(["turn-1", "turn-1"]);
  expect(listEvents(db, "t1")).toEqual([]);
});
test("a task's model, effort and permission mode outlive the runner and start its next turn", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const { db, h, runner, m, open, settled } = await setup();
  // no live turn: each is kept for later turns, none throws
  await runner.setModel(m.id, "claude-test-model");
  await runner.setEffort(m.id, "low");
  await runner.setPermissionMode(m.id, "plan");
  await runner.setModel(m.id, "claude-other-model");
  await expect(runner.setPermissionMode("nope", "plan")).rejects.toThrow("unknown task: nope");
  await h.close();
  const mark = crypto.randomUUID();
  const again = await open({ MEDDLE_TEST_MARK: mark });
  expect(again.runner.settings(m.id)).toEqual({ model: "claude-other-model", effort: "low", permissionMode: "plan" });
  expect(JSON.parse(getTask(db, m.id)!.settings!)).toEqual({ model: "claude-other-model", effort: "low", permissionMode: "plan" });
  // the next turn's child is started with them
  let argv: string[] = [];
  again.runner.onEvent((tid, _s, msg: any) => {
    if (tid !== m.id || msg.type !== "system" || msg.subtype !== "init") return;
    for (const pid of readdirSync("/proc").filter(d => /^\d+$/.test(d))) {
      try {
        if (readFileSync(`/proc/${pid}/environ`, "latin1").includes(`MEDDLE_TEST_MARK=${mark}`)) argv = readFileSync(`/proc/${pid}/cmdline`, "latin1").split("\0");
      } catch {}
    }
  });
  const done = settled(again.runner);
  await again.runner.prompt(m.id, "Reply with the single word ok.");
  await done;
  expect(argv).toContain("--model=claude-other-model");
  expect(argv).toContain("--effort=low");
  expect(argv).toContain("--permission-mode=plan");
  await again.runner.setModel(m.id);
  expect(again.runner.settings(m.id)).toEqual({ effort: "low", permissionMode: "plan" });
  await again.h.close();
});
test("a turn cut off by a hard kill, with no end in the log, carries on in the resumed session", async () => {
  const { writeFile } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  const { transcriptPath } = await import("../src/tasks/manifest");
  const { cfg, db, h, runner, m, turnsStarted, settled } = await setup();
  // the killed process had started the turn and Claude Code had written the transcript; nothing ended the turn
  updateTask(db, m.id, { started: 1, state: "running" });
  appendEvent(db, m.id, { type: "meddle", subtype: "turn_started", at: new Date().toISOString(), resume: false });
  appendEvent(db, m.id, { type: "user", message: { role: "user", content: "Reply with the single word ok." }, parent_tool_use_id: null });
  await mkdir(dirname(transcriptPath(cfg, m)), { recursive: true });
  await writeFile(transcriptPath(cfg, m), "{}\n");
  const done = settled(runner);
  await runner.prompt(m.id, "Reply with the single word ok.");
  await done;
  expect(turnsStarted()).toEqual([false, true]);
  const prompts = listEvents(db, m.id).filter(e => (e.message as any).type === "user").map(e => (e.message as any).message.content);
  expect(prompts).toEqual(["Reply with the single word ok.", CARRY_ON_PROMPT]);
  await h.close();
});

// ─── turns across the mesh ───

async function changeOf(cfg: NodeConfig, repo: string, rev: string): Promise<string> {
  return (await jj(["log", "-r", rev, "--no-graph", "-T", "change_id"], repo, cfg)).trim();
}

/** Resolves with the next `result` of `taskId` and once the task is idle after it. */
function turnEnd(runner: TaskRunner, taskId: string): { result: Promise<any>; idle: Promise<void> } {
  const result = new Promise<any>((res) => runner.onEvent((tid, _s, msg: any) => { if (tid === taskId && msg.type === "result") res(msg); }));
  const idle = new Promise<void>((res) => runner.onState((tid, s) => { if (tid === taskId && s === "idle") res(); }));
  return { result, idle };
}

async function eventually(cond: () => boolean, what: () => string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting: ${what()}`);
    await Bun.sleep(10);
  }
}

test("without a pool, a task of a folder project starts on its default branch", async () => {
  const node = await setupNode();
  const { cfg, project, harness } = node;
  try {
    // `main` moves on in the service repo, and its row with it: a start reads the branch from its rows.
    await jj(["new", "main"], project.replica, cfg);
    await writeFile(`${project.replica}/README`, "hello\n");
    await jj(["commit", "-m", "hello"], project.replica, cfg);
    await jj(["bookmark", "set", "main", "-r", "@-"], project.replica, cfg);
    const fork = await changeOf(cfg, project.replica, "main");
    const main = (await jj(["log", "--ignore-working-copy", "-r", "main", "--no-graph", "-T", "commit_id"], project.replica, cfg)).trim();
    writeBranchRow(node.db, project.home, { project: project.id, branch: "main", commit: main, drops: [] });
    const m = await createTask(node, { title: "t", projectIds: [project.id] });
    expect(await changeOf(cfg, join(paths(cfg).task(m.id), "a"), "@-")).toBe(fork);
  } finally {
    await harness.close();
  }
});

test("a turn end with every other node offline writes the task's line rows, and the other node has them once it is back; nothing is logged", async () => {
  const { A, B, close } = await twoPoolNodes();
  try {
    await peerReady(B, A);
    const P = A.project.id;
    const m = await createTask(B, { title: "t", projectIds: [P] });
    const workspace = join(paths(B.cfg).task(m.id), "a");
    const replicaB = paths(B.cfg).replica(P);
    const lineOn = (db: typeof A.db) => listLineRows(db, P, m.id).map((r) => [r.name, r.holder, r.commit]);

    // The other node goes away.
    A.net.unwatch(B.id, "bye");
    B.net.unwatch(A.id, "bye");
    await eventually(() => !B.net.isOnline(A.id) && !A.net.isOnline(B.id), () => `B sees A: ${B.net.isOnline(A.id)}, A sees B: ${A.net.isOnline(B.id)}`);
    await writeFile(`${workspace}/work`, "work\n");
    const first = turnEnd(B.runner, m.id);
    await B.runner.prompt(m.id, "Reply with the single word ok.");
    expect((await first.result).subtype).toBe("success");
    await first.idle;
    expect(B.runner.state(m.id)).toBe("idle");
    // The row follows the task's bookmark here at once; A, offline, still has the start's.
    const head = (await jj(["log", "--ignore-working-copy", "-r", `meddle/task/${m.id}/a`, "--no-graph", "-T", "commit_id"], replicaB, B.cfg)).trim();
    expect(head).not.toBe(m.projects[0]!.base[0]!);
    expect(lineOn(B.db)).toEqual([["a", B.id, head]]);
    expect(lineOn(A.db)).not.toEqual([["a", B.id, head]]);

    // It comes back: pool sync brings it the row, with no turn.
    A.net.watch(B.id);
    B.net.watch(A.id);
    B.net.offerAddress(B.pool.store.row(A.id)!.lastAddr!);
    A.net.offerAddress(A.pool.store.row(B.id)!.lastAddr!);
    await eventually(() => JSON.stringify(lineOn(A.db)) === JSON.stringify([["a", B.id, head]]), () => `A's rows: ${JSON.stringify(lineOn(A.db))}`, 15_000);
    expect(getTask(B.db, m.id)!.turns).toBe(1);
    expect(B.logs.filter((l) => l.startsWith("meddle: push") || l.startsWith("meddle: line"))).toEqual([]);
  } finally {
    await close();
  }
}, 30_000);

test("a turn started fresh after a seq sends its prompt, though the log before it ends in a cut-off turn", async () => {
  const { mkdir: mkdirp, writeFile: write } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  const { transcriptPath } = await import("../src/tasks/manifest");
  const { cfg, db, h, runner, m, turnsStarted, settled } = await setup();
  // Another node's log ends mid-turn (as a received task's can), and the session's transcript exists.
  updateTask(db, m.id, { started: 1, queued: JSON.stringify(["carry on after the move"]) });
  const last = appendEvent(db, m.id, { type: "meddle", subtype: "turn_started", at: new Date().toISOString(), resume: false });
  await mkdirp(dirname(transcriptPath(cfg, m)), { recursive: true });
  await write(transcriptPath(cfg, m), "{}\n");
  const done = settled(runner);
  await runner.startQueued(m.id, { freshAfter: last });
  await done;
  expect(turnsStarted()).toEqual([false, true]);
  const prompts = listEvents(db, m.id).filter(e => (e.message as any).type === "user").map(e => (e.message as any).message.content);
  expect(prompts).toEqual(["carry on after the move"]);
  await h.close();
});

test("a task created with a made-up title is named from its prompt, unless it was renamed first", async () => {
  const { cfg, db, h, runner, m } = await setup();
  const { readManifest } = await import("../src/tasks/manifest");
  const manifests: string[] = [];
  runner.onManifest((tid, manifest) => { if (tid === m.id) manifests.push(manifest.title); });
  // The stand-in Claude Code replays a recording whose reply is `ok`: that is Haiku's title.
  await runner.nameFromPrompt(m.id, "t", { text: "Say hello", attachments: [] });
  expect(getTask(db, m.id)?.title).toBe("ok");
  expect(JSON.parse(getTask(db, m.id)!.manifest).title).toBe("ok");
  expect((await readManifest(cfg, m.id)).title).toBe("ok");
  expect(manifests).toEqual(["ok"]);
  // Renamed while Haiku is asked: the rename stands.
  await runner.rename(m.id, "first");
  const naming = runner.nameFromPrompt(m.id, "first", { text: "Say hello", attachments: [] });
  await runner.rename(m.id, "Mine");
  await naming;
  expect(getTask(db, m.id)?.title).toBe("Mine");
  expect((await readManifest(cfg, m.id)).title).toBe("Mine");
  // A task that cannot be renamed keeps its title, and naming it does not reject.
  await runner.nameFromPrompt("nonexistent", "t", { text: "Say hello", attachments: [] });
  await h.close();
});

// ─── prompts with attachments ───

test("a task whose first prompt is files alone is named from them: Haiku sees its images and every file's name", async () => {
  const { db, h, m, open } = await setup();
  const input = `${await mkdtemp("/tmp/meddle-title-input-")}/input.jsonl`;
  const { h: h2, runner } = await open({ MEDDLE_FIXTURE_INPUT: input });
  try {
    const shot = await storedShot({ runner });
    // A file of a type Haiku is not shown, and an image this node lacks and no pool has: each goes by its name alone.
    const notes = { ...(await storedShot({ runner })), name: "notes.txt", type: "text/plain" };
    const lost = { hash: "0".repeat(64), name: "lost.png", type: "image/png", size: 3 };
    await runner.nameFromPrompt(m.id, "t", { text: "  ", attachments: [shot, notes, lost] });
    expect(getTask(db, m.id)?.title).toBe("ok");
    const [sent] = (await readFile(input, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const content = sent.message.content;
    expect(content).toHaveLength(2);
    expect(content[0]).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from(PNG_BYTES).toString("base64") } });
    expect(content[1]).toEqual({ type: "text", text: "<request>\n\n</request>\n<files>\n- shot.png\n- notes.txt\n- lost.png\n</files>" });
  } finally {
    await h2.close();
    await h.close();
  }
});

async function* chunks(...parts: Uint8Array[]) { for (const p of parts) yield p; }
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]); // a few bytes are enough; nothing decodes them

/** Puts a small PNG into the node's blob store; answers it as an attachment named `shot.png`. */
async function storedShot(node: { runner: TaskRunner }): Promise<Attachment> {
  const { hash, size } = await node.runner.blobs.store.write(chunks(PNG_BYTES));
  return { hash, name: "shot.png", type: "image/png", size };
}

/** The user messages the stand-in Claude Code wrote to the task's session transcript, one per run, in order. */
async function transcriptPrompts(cfg: NodeConfig, m: TaskManifest): Promise<any[]> {
  return (await readFile(transcriptPath(cfg, m), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/** Resolves on the task's next `init`: Claude Code has read its first prompt and written it to the transcript. */
function nextInit(runner: TaskRunner, taskId: string): Promise<void> {
  return new Promise<void>((res) => runner.onEvent((tid, _s, msg: any) => { if (tid === taskId && msg.type === "system" && msg.subtype === "init") res(); }));
}

const userEvents = (db: Parameters<typeof listEvents>[0], taskId: string) =>
  listEvents(db, taskId).map((e) => e.message as any).filter((msg) => msg.type === "user");

test("a prompt's image reaches Claude Code inline and its file as a path", async () => {
  const node = await setupNode();
  try {
    const m = await createTask(node, { title: "t", projectIds: [node.project.id] });
    const shot = await storedShot(node);
    const end = turnEnd(node.runner, m.id);
    expect(await node.runner.prompt(m.id, "look", [shot])).toBe("turn");
    await end.idle;
    const [first] = await transcriptPrompts(node.cfg, m);
    const dir = paths(node.cfg).taskAttachments(m.id);
    expect(first.message.content[0]).toMatchObject({ type: "image", source: { media_type: "image/png" } });
    expect(first.message.content.at(-1).text).toBe(`look\n\nAttached files:\n- shot.png: ${dir}/${shot.hash}/shot.png`);
    expect(new Uint8Array(await readFile(`${dir}/${shot.hash}/shot.png`))).toEqual(PNG_BYTES);
    // meddle's own log holds the text and the refs, never the bytes
    expect(userEvents(node.db, m.id)).toMatchObject([{ message: { content: "look" }, attachments: [shot] }]);
  } finally {
    await node.harness.close();
  }
});

test("a turn without attachments still finds the attachments folder Claude Code is given", async () => {
  const node = await setupNode();
  try {
    const m = await createTask(node, { title: "t", projectIds: [node.project.id] });
    const dir = paths(node.cfg).taskAttachments(m.id);
    expect(existsSync(dir)).toBe(false);
    const end = turnEnd(node.runner, m.id);
    await node.runner.prompt(m.id, "Reply with the single word ok.");
    await end.idle;
    expect(existsSync(dir)).toBe(true);
    const [first] = await transcriptPrompts(node.cfg, m);
    expect(first.message.content).toBe("Reply with the single word ok.");
  } finally {
    await node.harness.close();
  }
});

test("a prompt naming a blob no node has, a bad name or a wrong size is refused, and nothing is queued or logged", async () => {
  const node = await setupNode();
  try {
    const m = await createTask(node, { title: "t", projectIds: [node.project.id] });
    const shot = await storedShot(node);
    await expect(node.runner.prompt(m.id, "look", [{ ...shot, hash: "0".repeat(64) }])).rejects.toThrow("attachment shot.png is not on any online node");
    await expect(node.runner.prompt(m.id, "look", [{ ...shot, name: "../x" }])).rejects.toThrow("bad attachment:");
    // every attachment is checked before any is fetched: a bad one after a missing one is what is refused
    await expect(node.runner.prompt(m.id, "look", [{ ...shot, hash: "0".repeat(64) }, { ...shot, name: "" }])).rejects.toThrow("bad attachment:");
    await expect(node.runner.prompt(m.id, "look", [{ ...shot, size: shot.size + 1 }])).rejects.toThrow("bad attachment: size does not match its file");
    expect(node.runner.queued(m.id)).toEqual([]);
    expect(getTask(node.db, m.id)!.queued).toBeNull();
    expect(node.runner.state(m.id)).toBe("idle");
    expect(userEvents(node.db, m.id)).toEqual([]);
  } finally {
    await node.harness.close();
  }
});

test("a queue an older meddle wrote still reads, attachments stay with their prompt, and each runs once, in order", async () => {
  const node = await setupNode();
  try {
    const m = await createTask(node, { title: "t", projectIds: [node.project.id] });
    const shot = await storedShot(node);
    updateTask(node.db, m.id, { queued: JSON.stringify(["old", { text: "new", attachments: [shot] }]) });
    expect(node.runner.queued(m.id)).toEqual([{ text: "old", attachments: [] }, { text: "new", attachments: [shot] }]);
    // held turns: both prompts queue behind them; a text alone is written as an older meddle wrote it
    node.runner.setHolds({ turns: "held", work: null, hosting: null });
    expect(await node.runner.prompt(m.id, "plain")).toBe("queued");
    expect(await node.runner.prompt(m.id, "again", [shot])).toBe("queued");
    expect(JSON.parse(getTask(node.db, m.id)!.queued!)).toEqual([
      "old", { text: "new", attachments: [shot] }, "plain", { text: "again", attachments: [shot] },
    ]);
    let results = 0;
    node.runner.onEvent((tid, _s, msg: any) => { if (tid === m.id && msg.type === "result") results++; });
    node.runner.setHolds({ turns: null, work: null, hosting: null });
    await eventually(() => results === 4 && node.runner.state(m.id) === "idle", () => `${results} results, ${node.runner.state(m.id)}`, 30_000);
    expect(userEvents(node.db, m.id).map((u) => [u.message.content, u.attachments ?? []])).toEqual([
      ["old", []], ["new", [shot]], ["plain", []], ["again", [shot]],
    ]);
    expect(node.runner.queued(m.id)).toEqual([]);
    expect(getTask(node.db, m.id)!.queued).toBeNull();
    // each turn's Claude Code was sent its own prompt's image
    const dir = paths(node.cfg).taskAttachments(m.id);
    const sent = (await transcriptPrompts(node.cfg, m)).map((u) => typeof u.message.content === "string" ? u.message.content : u.message.content.at(-1).text);
    expect(sent).toEqual(["old", `new\n\nAttached files:\n- shot.png: ${dir}/${shot.hash}/shot.png`, "plain", `again\n\nAttached files:\n- shot.png: ${dir}/${shot.hash}/shot.png`]);
  } finally {
    await node.harness.close();
  }
}, 60_000);

test("a steer with an image that the turn ends without keeps its image for the next turn", async () => {
  const node = await setupNode("hello.jsonl", { MEDDLE_FIXTURE_STALL: "1" });
  try {
    const m = await createTask(node, { title: "t", projectIds: [node.project.id] });
    const shot = await storedShot(node);
    const initialised = nextInit(node.runner, m.id);
    await node.runner.prompt(m.id, "look");
    await initialised;
    // the stand-in, stalled before its result, never takes the steer
    expect(await node.runner.prompt(m.id, "and this", [shot])).toBe("queued");
    expect(node.runner.queued(m.id)).toEqual([{ text: "and this", attachments: [shot] }]);
    // turns held, so the steer waits once the interrupted turn ends without it
    node.runner.setHolds({ turns: "held", work: null, hosting: null });
    const end = turnEnd(node.runner, m.id);
    await node.runner.interrupt(m.id);
    await end.idle;
    expect(node.runner.queued(m.id)).toEqual([{ text: "and this", attachments: [shot] }]);
    expect(JSON.parse(getTask(node.db, m.id)!.queued!)).toEqual([{ text: "and this", attachments: [shot] }]);
    expect(userEvents(node.db, m.id).map((u) => u.message.content)).toEqual(["look"]);
    // the next turn sends it, its image inline
    const next = nextInit(node.runner, m.id);
    node.runner.setHolds({ turns: null, work: null, hosting: null });
    await next;
    const sent = (await transcriptPrompts(node.cfg, m))[1];
    const dir = paths(node.cfg).taskAttachments(m.id);
    expect(sent.message.content[0]).toMatchObject({ type: "image", source: { media_type: "image/png" } });
    expect(sent.message.content.at(-1).text).toBe(`and this\n\nAttached files:\n- shot.png: ${dir}/${shot.hash}/shot.png`);
    expect(userEvents(node.db, m.id).at(-1)).toMatchObject({ message: { content: "and this" }, attachments: [shot] });
    expect(node.runner.queued(m.id)).toEqual([]);
    const ended = turnEnd(node.runner, m.id);
    await node.runner.interrupt(m.id);
    await ended.idle;
  } finally {
    await node.harness.close();
  }
});

test("a prompt sent while an earlier one with an attachment is still being taken runs after it", async () => {
  const node = await setupNode();
  try {
    const m = await createTask(node, { title: "t", projectIds: [node.project.id] });
    const shot = await storedShot(node);
    let results = 0;
    node.runner.onEvent((tid, _s, msg: any) => { if (tid === m.id && msg.type === "result") results++; });
    // the first prompt's file is checked on disk; the second has nothing to wait for, yet it waits its turn
    const first = node.runner.prompt(m.id, "first, with image", [shot]);
    const second = node.runner.prompt(m.id, "second, text");
    expect(await Promise.all([first, second])).toEqual(["turn", "queued"]);
    await eventually(() => results === 2 && node.runner.state(m.id) === "idle", () => `${results} results, ${node.runner.state(m.id)}`);
    expect(userEvents(node.db, m.id).map((u) => u.message.content)).toEqual(["first, with image", "second, text"]);
  } finally {
    await node.harness.close();
  }
});

test("steers reach the live turn in the order they were sent, a refused one between them breaking nothing", async () => {
  const node = await setupNode("hello.jsonl", { MEDDLE_FIXTURE_STALL: "1" });
  try {
    const m = await createTask(node, { title: "t", projectIds: [node.project.id] });
    const shot = await storedShot(node);
    const initialised = nextInit(node.runner, m.id);
    await node.runner.prompt(m.id, "look");
    await initialised;
    // the first steer's files are written before it is sent; the third, text alone, is sent after it all the same
    const sent = [
      node.runner.prompt(m.id, "S1", [shot]),
      node.runner.prompt(m.id, "refused", [{ ...shot, hash: "0".repeat(64) }]),
      node.runner.prompt(m.id, "S2"),
    ];
    expect((await Promise.allSettled(sent)).map((r) => r.status === "fulfilled" ? r.value : (r.reason as Error).message)).toEqual([
      "queued", "attachment shot.png is not on any online node", "queued",
    ]);
    expect(node.runner.queued(m.id)).toEqual([{ text: "S1", attachments: [shot] }, { text: "S2", attachments: [] }]);
    // held, so the interrupted turn leaves both queued, still in order
    node.runner.setHolds({ turns: "held", work: null, hosting: null });
    const end = turnEnd(node.runner, m.id);
    await node.runner.interrupt(m.id);
    await end.idle;
    expect(JSON.parse(getTask(node.db, m.id)!.queued!)).toEqual([{ text: "S1", attachments: [shot] }, "S2"]);
  } finally {
    await node.harness.close();
  }
});

test("a steer whose turn ends while its files are written, as the task begins to be archived, is refused, not left queued", async () => {
  const A = await startPoolNode("hello.jsonl", { MEDDLE_FIXTURE_STALL: "1" });
  try {
    const m = await createTask(A, { title: "t", projectIds: [A.project.id] });
    const shot = await storedShot(A);
    const initialised = nextInit(A.runner, m.id);
    await A.runner.prompt(m.id, "look");
    await initialised;
    let archived: Promise<void> | undefined;
    A.hooks.afterSteerContent = async (taskId) => {
      // meanwhile the turn ends without the steer, and an archive of the idle task begins
      const end = turnEnd(A.runner, taskId);
      await A.runner.interrupt(taskId);
      await end.idle;
      archived = A.runner.archive(taskId);
    };
    await expect(A.runner.prompt(m.id, "and this", [shot])).rejects.toThrow("task is being archived");
    await archived;
    expect(getTask(A.db, m.id)).toMatchObject({ state: "archived", queued: null });
    expect(userEvents(A.db, m.id).map((u) => u.message.content)).toEqual(["look"]);
  } finally {
    await A.close();
    A.db.close();
    await rm(A.home, { recursive: true, force: true });
  }
}, 30_000);

test("an attachment keeps only its hash, name, type and size: nothing else a caller put on it is stored or logged", async () => {
  const node = await setupNode();
  try {
    const m = await createTask(node, { title: "t", projectIds: [node.project.id] });
    const shot = await storedShot(node);
    const carrying = { ...shot, data: Buffer.from(PNG_BYTES).toString("base64") } as Attachment;
    // queued (turns held): the stored queue
    node.runner.setHolds({ turns: "held", work: null, hosting: null });
    expect(await node.runner.prompt(m.id, "held", [carrying])).toBe("queued");
    expect(JSON.parse(getTask(node.db, m.id)!.queued!)).toEqual([{ text: "held", attachments: [shot] }]);
    const queuedTurn = turnEnd(node.runner, m.id);
    node.runner.setHolds({ turns: null, work: null, hosting: null });
    await queuedTurn.idle;
    // a turn of its own: the turn's input, which is what the log records
    const ownTurn = turnEnd(node.runner, m.id);
    expect(await node.runner.prompt(m.id, "direct", [carrying])).toBe("turn");
    await ownTurn.idle;
    expect(userEvents(node.db, m.id).map((u) => [u.message.content, u.attachments])).toEqual([["held", [shot]], ["direct", [shot]]]);
  } finally {
    await node.harness.close();
  }
});
