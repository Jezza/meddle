// test/durable.test.ts
import { test, expect, spyOn } from "bun:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import { loadConfig, ensureDataDirs, paths } from "../src/config";
import { openDb } from "../src/store/db";
import { addProjectFromFolder } from "../src/projects/project";
import { initColocated } from "../src/jj";
import { openHarness } from "../src/tasks/harness";
import { TaskRunner } from "../src/tasks/durable";
import { appendEvent, listEvents } from "../src/store/events";
import { getTask, updateTask } from "../src/store/records";
const replay = `${import.meta.dir}/fake-claude/replay.ts`;
test("a prompt runs a durable turn and leaves the task idle", async () => {
  const home = await mkdtemp("/tmp/meddle-dur-");
  const cfg = loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/d`, MEDDLE_TASK_ROOT: `${home}/t` });
  await ensureDataDirs(cfg); await mkdir(cfg.taskRoot, { recursive: true });
  const db = openDb(paths(cfg).db);
  const a = `${home}/a`; await initColocated(a);
  const p = await addProjectFromFolder(cfg, db, a, "a");
  await (await import("../src/token")).setToken(cfg, "tok");
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
  await h.close();
});
test("a turn interrupted by a process death resumes after reopen", async () => {
  const home = await mkdtemp("/tmp/meddle-dur-");
  const cfg = loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/d`, MEDDLE_TASK_ROOT: `${home}/t` });
  await ensureDataDirs(cfg); await mkdir(cfg.taskRoot, { recursive: true });
  const db = openDb(paths(cfg).db);
  const a = `${home}/a`; await initColocated(a);
  const p = await addProjectFromFolder(cfg, db, a, "a");
  await (await import("../src/token")).setToken(cfg, "tok");
  const fixture = `${import.meta.dir}/fixtures/hello.jsonl`;
  const open = async (extra: Record<string,string> = {}) => { const { createRegistry } = await import("@earendil-works/pi-durable"); const h = await openHarness(cfg, createRegistry()); return { h, runner: new TaskRunner(cfg, db, h.harness, { claudePath: replay, claudeRuntime: "bun", extraEnv: { MEDDLE_FIXTURE: fixture, ...extra } }) }; };
  const turnsStarted = () => listEvents(db, m.id).filter(e => (e.message as any).subtype === "turn_started").map(e => (e.message as any).resume);
  // 1. the first process stalls before the result; closing its Harness kills the turn mid-way
  const { h, runner } = await open({ MEDDLE_FIXTURE_STALL: "1" });
  const m = await runner.create({ title: "t", projectIds: [p.id] });
  // Claude Code's init is the evidence that it created the session, so the rerun resumes it
  const initialised = new Promise<void>(res => runner.onEvent((tid, _s, msg: any) => { if (tid === m.id && msg.type === "system" && msg.subtype === "init") res(); }));
  await runner.prompt(m.id, "Reply with the single word ok.");
  await initialised;
  expect(runner.state(m.id)).toBe("running");
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
  await again.h.close();
});
test("a pending approval makes the task waiting until it is answered", async () => {
  const home = await mkdtemp("/tmp/meddle-dur-");
  const cfg = loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/d`, MEDDLE_TASK_ROOT: `${home}/t` });
  await ensureDataDirs(cfg); await mkdir(cfg.taskRoot, { recursive: true });
  const db = openDb(paths(cfg).db);
  const a = `${home}/a`; await initColocated(a);
  const p = await addProjectFromFolder(cfg, db, a, "a");
  const { createRegistry } = await import("@earendil-works/pi-durable");
  const h = await openHarness(cfg, createRegistry());
  const runner = new TaskRunner(cfg, db, h.harness, { claudePath: replay, claudeRuntime: "bun", extraEnv: { MEDDLE_FIXTURE: `${import.meta.dir}/fixtures/approval.jsonl` } });
  await expect(runner.create({ title: "t", projectIds: [p.id] })).rejects.toThrow("no token set");
  await (await import("../src/token")).setToken(cfg, "tok");
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
  const p = await addProjectFromFolder(cfg, db, a, "a");
  await (await import("../src/token")).setToken(cfg, "tok");
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
