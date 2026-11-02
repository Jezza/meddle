// test/durable.test.ts
import { test, expect, spyOn } from "bun:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import { loadConfig, ensureDataDirs, paths, type NodeConfig } from "../src/config";
import { openDb } from "../src/store/db";
import { addProjectFromFolder } from "../src/projects/project";
import { initColocated } from "../src/jj";
import { openHarness } from "../src/tasks/harness";
import { CARRY_ON_PROMPT, TaskRunner } from "../src/tasks/durable";
import { appendEvent, listEvents } from "../src/store/events";
import { getTask, updateTask } from "../src/store/records";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { bookmarkList, jj } from "../src/jj";
import { shortId } from "../src/pool/identity";
import { setupNode } from "./helpers";
import { peerReady, twoPoolNodes } from "./pool-helpers";

/** The home node id of the projects these tests add. */
const PROJECT_HOME = "a".repeat(64);
const replay = `${import.meta.dir}/fake-claude/replay.ts`;
test("a prompt runs a durable turn and leaves the task idle", async () => {
  const home = await mkdtemp("/tmp/meddle-dur-");
  const cfg = loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/d`, MEDDLE_TASK_ROOT: `${home}/t` });
  await ensureDataDirs(cfg); await mkdir(cfg.taskRoot, { recursive: true });
  const db = openDb(paths(cfg).db);
  const a = `${home}/a`; await initColocated(a);
  const p = await addProjectFromFolder(cfg, db, a, PROJECT_HOME, "a");
  await (await import("../src/token")).addToken(cfg, db, "tok", { setBy: null });
  const fixture = `${import.meta.dir}/fixtures/hello.jsonl`;
  const open = async (extra: Record<string,string> = {}) => { const { createRegistry } = await import("@earendil-works/pi-durable"); const h = await openHarness(cfg, createRegistry()); return { h, runner: new TaskRunner(cfg, db, h.harness, { claudePath: replay, claudeRuntime: "bun", extraEnv: { MEDDLE_FIXTURE: fixture, ...extra } }) }; };
  const { h, runner } = await open();
  const m = await runner.create({ title: "t", projectIds: [p.id] });
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
  const a = `${home}/a`; await initColocated(a);
  const p = await addProjectFromFolder(cfg, db, a, PROJECT_HOME, "a");
  await (await import("../src/token")).addToken(cfg, db, "tok", { setBy: null });
  const fixture = `${import.meta.dir}/fixtures/hello.jsonl`;
  const open = async (extra: Record<string,string> = {}) => { const { createRegistry } = await import("@earendil-works/pi-durable"); const h = await openHarness(cfg, createRegistry()); return { h, runner: new TaskRunner(cfg, db, h.harness, { claudePath: replay, claudeRuntime: "bun", extraEnv: { MEDDLE_FIXTURE: fixture, ...extra } }) }; };
  const turnsStarted = () => listEvents(db, m.id).filter(e => (e.message as any).subtype === "turn_started").map(e => (e.message as any).resume);
  // 1. the first process stalls before the result; closing its Harness kills the turn mid-way
  const { h, runner } = await open({ MEDDLE_FIXTURE_STALL: "1" });
  const m = await runner.create({ title: "t", projectIds: [p.id] });
  // by its init, Claude Code has read the prompt and written the session's transcript, so the rerun resumes it
  const initialised = new Promise<void>(res => runner.onEvent((tid, _s, msg: any) => { if (tid === m.id && msg.type === "system" && msg.subtype === "init") res(); }));
  await runner.prompt(m.id, "Reply with the single word ok.");
  await initialised;
  expect(runner.state(m.id)).toBe("running");
  // a steer into the live turn is sent, then recorded and told to listeners
  const steered: unknown[] = [];
  runner.onEvent((tid, seq, msg) => { if (tid === m.id && msg.type === "user") steered.push([seq, msg]); });
  await runner.prompt(m.id, "Also say why.");
  const steer = { type: "user", message: { role: "user", content: "Also say why." }, parent_tool_use_id: null };
  const logged = listEvents(db, m.id).filter(e => (e.message as any).type === "user");
  expect(logged.map(e => e.message)).toEqual([{ ...steer, message: { role: "user", content: "Reply with the single word ok." } }, steer]);
  expect(steered).toEqual([[logged[1]!.seq, steer]]);
  await h.close();
  expect(runner.liveQuery(m.id)).toBeNull();
  expect(turnsStarted()).toEqual([false]);
  // 2. a fresh process reruns the parked phase, which resumes the session and finishes the turn
  const again = await open();
  const finished = new Promise<void>(res => again.runner.onEvent((tid, _s, msg: any) => { if (tid === m.id && msg.type === "result") res(); }));
  const idle = new Promise<void>(res => again.runner.onState((tid, s) => { if (tid === m.id && s === "idle") res(); }));
  await finished; await idle;
  // 3. one fresh start, one resume, and the task is idle again
  expect(turnsStarted()).toEqual([false, true]);
  expect(again.runner.state(m.id)).toBe("idle");
  // the close logged turn_aborted, so the rerun told Claude to carry on rather than sending the prompt again
  const prompts = listEvents(db, m.id).filter(e => (e.message as any).type === "user").map(e => (e.message as any).message.content);
  expect(prompts).toEqual(["Reply with the single word ok.", "Also say why.", CARRY_ON_PROMPT]);
  await again.h.close();
});
test("a pending approval makes the task waiting until it is answered", async () => {
  const home = await mkdtemp("/tmp/meddle-dur-");
  const cfg = loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/d`, MEDDLE_TASK_ROOT: `${home}/t` });
  await ensureDataDirs(cfg); await mkdir(cfg.taskRoot, { recursive: true });
  const db = openDb(paths(cfg).db);
  const a = `${home}/a`; await initColocated(a);
  const p = await addProjectFromFolder(cfg, db, a, PROJECT_HOME, "a");
  const { createRegistry } = await import("@earendil-works/pi-durable");
  const h = await openHarness(cfg, createRegistry());
  const runner = new TaskRunner(cfg, db, h.harness, { claudePath: replay, claudeRuntime: "bun", extraEnv: { MEDDLE_FIXTURE: `${import.meta.dir}/fixtures/approval.jsonl` } });
  await expect(runner.create({ title: "t", projectIds: [p.id] })).rejects.toThrow("no usable token");
  await (await import("../src/token")).addToken(cfg, db, "tok", { setBy: null });
  const m = await runner.create({ title: "t", projectIds: [p.id] });
  const states: string[] = [];
  runner.onState((tid, s) => { if (tid === m.id) states.push(`${s}/${runner.state(m.id)}`); });
  runner.approvals.onChange(() => { for (const q of runner.approvals.pending(m.id)) runner.approvals.answer(q.requestId, { behavior: "allow", updatedInput: q.input }); });
  const idle = new Promise<void>(res => runner.onState((tid, s) => { if (tid === m.id && s === "idle") res(); }));
  await runner.prompt(m.id, "Run: echo hi");
  await idle;
  expect(states).toEqual(["running/running", "waiting/waiting", "running/running", "idle/idle"]);
  await h.close();
});
async function setup() {
  const home = await mkdtemp("/tmp/meddle-dur-");
  const cfg = loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/d`, MEDDLE_TASK_ROOT: `${home}/t` });
  await ensureDataDirs(cfg); await mkdir(cfg.taskRoot, { recursive: true });
  const db = openDb(paths(cfg).db);
  const a = `${home}/a`; await initColocated(a);
  const p = await addProjectFromFolder(cfg, db, a, PROJECT_HOME, "a");
  await (await import("../src/token")).addToken(cfg, db, "tok", { setBy: null });
  const fixture = `${import.meta.dir}/fixtures/hello.jsonl`;
  const open = async (extra: Record<string,string> = {}) => { const { createRegistry } = await import("@earendil-works/pi-durable"); const h = await openHarness(cfg, createRegistry()); return { h, runner: new TaskRunner(cfg, db, h.harness, { claudePath: replay, claudeRuntime: "bun", extraEnv: { MEDDLE_FIXTURE: fixture, ...extra } }) }; };
  const { h, runner } = await open();
  const m = await runner.create({ title: "t", projectIds: [p.id] });
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
  await expect(runner.retry(m.id)).rejects.toThrow(`no parked turn for task ${m.id}`);
  const done = settled(runner);
  await runner.prompt(m.id, "Reply with the single word ok.");
  await done;
  expect(turnsStarted()).toEqual([false, false]);
  expect(runner.state(m.id)).toBe("idle");
  await h.close();
});
test("concurrent prompts start one turn, and throwing listeners do not break it", async () => {
  const { h, runner, m, turnsStarted, settled } = await setup();
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    runner.onEvent(() => { throw new Error("event listener"); });
    runner.onState(() => { throw new Error("state listener"); });
    const done = settled(runner);
    const outcomes = await Promise.allSettled([runner.prompt(m.id, "one"), runner.prompt(m.id, "two")]);
    expect(outcomes.map(o => o.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(outcomes.find(o => o.status === "rejected")).toMatchObject({ reason: { message: "task has a pending turn" } });
    await done;
    expect(turnsStarted()).toEqual([false]);
    expect(runner.state(m.id)).toBe("idle");
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
  const { writeFile } = await import("node:fs/promises");
  const { db, h, runner, m } = await setup();
  await mkdir(`${m.projects[0]!.replica}/.meddle`, { recursive: true });
  await writeFile(`${m.projects[0]!.replica}/.meddle/context.toml`, "[claude]\nallwo = []\n");
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
test("a steer after the turn's result is refused and not logged", async () => {
  const { db, h, runner, m, settled } = await setup();
  const done = settled(runner);
  let late: Promise<void> | undefined;
  // a microtask after the result's listeners: the turn's input is closed, its child not gone yet
  runner.onEvent((tid, _s, msg: any) => { if (tid === m.id && msg.type === "result") queueMicrotask(() => { late = runner.prompt(m.id, "too late"); late.catch(() => {}); }); });
  await runner.prompt(m.id, "Reply with the single word ok.");
  await done;
  await expect(late!).rejects.toThrow("the turn just ended; send it as a new prompt");
  const prompts = listEvents(db, m.id).filter(e => (e.message as any).type === "user").map(e => (e.message as any).message.content);
  expect(prompts).toEqual(["Reply with the single word ok."]);
  await h.close();
});
test("a prompt to a task whose turn is parked retries the turn and asks for the message again", async () => {
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
  await expect(runner.prompt("t1", "hello")).rejects.toThrow("the task's interrupted turn is being retried; send your message again once it is idle");
  expect(retried).toEqual(["turn-1"]);
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

test("without a pool, a task of a folder project starts from its main bookmark, not root", async () => {
  const { cfg, project, runner, harness } = await setupNode();
  try {
    await writeFile(`${project.replica}/README`, "hello\n");
    await jj(["commit", "-m", "init"], project.replica, cfg);
    await jj(["bookmark", "set", "main", "-r", "@-"], project.replica, cfg);
    const main = await changeOf(cfg, project.replica, "main");
    const m = await runner.create({ title: "t", projectIds: [project.id] });
    expect(await changeOf(cfg, join(paths(cfg).task(m.id), "a"), "@-")).toBe(main);
  } finally {
    await harness.close();
  }
});

test("a turn-end push to an unreachable home is logged once and the turn completes; the next turn end pushes", async () => {
  const { A, B, close } = await twoPoolNodes();
  try {
    await peerReady(B, A);
    const short = shortId(A.id);
    const m = await B.runner.create({ title: "t", projectIds: [A.project.id] });
    const bookmark = `meddle/task/${m.id}/a`;
    const workspace = join(paths(B.cfg).task(m.id), "a");
    const onA = async () => (await bookmarkList(A.project.replica, A.cfg)).find((b) => b.name === bookmark && b.remote === null)?.changeId;
    const pushLines = () => B.logs.filter((l) => l.startsWith("meddle: git: push "));

    // The home goes away.
    A.net.unwatch(B.id, "bye");
    B.net.unwatch(A.id, "bye");
    await eventually(() => !B.net.isOnline(A.id) && !A.net.isOnline(B.id), () => `B sees A: ${B.net.isOnline(A.id)}, A sees B: ${A.net.isOnline(B.id)}`);
    const first = turnEnd(B.runner, m.id);
    await B.runner.prompt(m.id, "Reply with the single word ok.");
    expect((await first.result).subtype).toBe("success");
    await first.idle;
    expect(B.runner.state(m.id)).toBe("idle");
    expect(pushLines()).toEqual([`meddle: git: push of ${bookmark} to ${short} failed: home ${short} is offline`]);
    expect(await onA()).toBeUndefined();

    // The home comes back; the task has moved on to a new change.
    A.net.watch(B.id);
    B.net.watch(A.id);
    B.net.offerAddress(B.pool.store.row(A.id)!.lastAddr!);
    A.net.offerAddress(A.pool.store.row(B.id)!.lastAddr!);
    await eventually(() => B.net.isOnline(A.id), () => `B sees A: ${B.net.isOnline(A.id)}`);
    await writeFile(`${workspace}/work`, "work\n");
    await jj(["commit", "-m", "work"], workspace, B.cfg);
    const change = await changeOf(B.cfg, workspace, "@");
    const second = turnEnd(B.runner, m.id);
    await B.runner.prompt(m.id, "Again.");
    expect((await second.result).subtype).toBe("success");
    await second.idle;
    expect(await onA()).toBe(change);
    expect(pushLines()).toHaveLength(1);
  } finally {
    await close();
  }
}, 15_000);

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
