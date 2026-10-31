// test/engine.test.ts
import { test, expect } from "bun:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { openDb } from "../src/store/db";
import { listEvents } from "../src/store/events";
import { SqliteSessionStore } from "../src/store/session-store";
import { Approvals, } from "../src/engine/approvals";
import { InputQueue } from "../src/engine/input";
import { runTurn } from "../src/engine/session";
import { loadConfig, ensureDataDirs } from "../src/config";
import { DEFAULT_CONTEXT } from "../src/projects/context";
const replay = `${import.meta.dir}/fake-claude/replay.ts`;
async function setup() {
  const home = await mkdtemp("/tmp/meddle-eng-");
  const cfg = loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/d`, MEDDLE_TASK_ROOT: `${home}/t` });
  await ensureDataDirs(cfg); await mkdir(`${home}/t/abc/a/.jj`, { recursive: true }); await mkdir(`${home}/t/abc/.meddle/claude`, { recursive: true });
  const db = openDb(":memory:");
  const manifest = { id: "abc", title: "t", sessionId: crypto.randomUUID(), primaryProjectId: "p1", createdAt: "", projects: [{ id: "p1", name: "a", replica: `${home}/t/abc/a`, workspace: "a", parent: "root()" }] };
  const fixture = (name: string) => ({ MEDDLE_FIXTURE: `${import.meta.dir}/fixtures/${name}.jsonl` });
  return { cfg, db, manifest, fixture, input: { cfg, manifest, projectSettings: [], contexts: [DEFAULT_CONTEXT], token: "tok", sessionStore: new SqliteSessionStore(db), resume: false, claudePath: replay, claudeRuntime: "bun" as const } };
}
test("hello: every message is recorded, the result returns, the child exits", async () => {
  const { db, input, fixture } = await setup();
  const { done } = runTurn({ input: { ...input, extraEnv: fixture("hello") }, prompt: "Reply with the single word ok.", db, approvals: new Approvals() });
  const result = await done;
  expect(result.type).toBe("result");
  const types = listEvents(db, "abc").map(e => (e.message as any).type);
  expect(types[0]).toBe("meddle"); expect(types).toContain("system"); expect(types.at(-1)).toBe("result");
  // the prompt is recorded right after turn_started: Claude Code does not echo it
  expect(listEvents(db, "abc")[1]!.message).toEqual({ type: "user", message: { role: "user", content: "Reply with the single word ok." }, parent_tool_use_id: null });
});
test("approval: the dashboard's answer unblocks the tool", async () => {
  const { db, input, fixture } = await setup();
  const approvals = new Approvals();
  approvals.onChange(() => { for (const p of approvals.pending("abc")) approvals.answer(p.requestId, { behavior: "allow", updatedInput: p.input }); });
  const { done } = runTurn({ input: { ...input, extraEnv: fixture("approval") }, prompt: "Run: echo hi", db, approvals });
  expect((await done).type).toBe("result");
  expect(listEvents(db, "abc").some(e => (e.message as any).type === "user")).toBe(true);
  const recorded = listEvents(db, "abc").map(e => e.message as any);
  expect(recorded[0]).toMatchObject({ type: "meddle", subtype: "turn_started" });
  expect(recorded.filter(m => m.type === "result")).toHaveLength(1);
});
test("abort closes the query", async () => {
  const { db, input, fixture } = await setup();
  const ac = new AbortController();
  const { done } = runTurn({ input: { ...input, extraEnv: { ...fixture("hello"), MEDDLE_FIXTURE_STALL: "1" } }, prompt: "x", db, approvals: new Approvals(), signal: ac.signal });
  setTimeout(() => ac.abort(), 300);
  await expect(done).rejects.toMatchObject({ name: "AbortError" });
});
/** Pids of live processes whose environment carries `mark`. */
function processesWith(mark: string): number[] {
  return readdirSync("/proc").filter(d => /^\d+$/.test(d)).filter(d => {
    try { return readFileSync(`/proc/${d}/environ`, "latin1").includes(mark); } catch { return false; }
  }).map(Number);
}
test("a turn that fails to record closes the child and logs turn_failed", async () => {
  const { db, input, fixture } = await setup();
  const mark = `MEDDLE_TEST_MARK=${crypto.randomUUID()}`;
  let childSeen = false;
  const boom = new Error("broadcast failed");
  const { done } = runTurn({
    input: { ...input, extraEnv: { ...fixture("hello"), MEDDLE_FIXTURE_STALL: "1", MEDDLE_TEST_MARK: mark.split("=")[1]! } },
    prompt: "x", db, approvals: new Approvals(),
    onMessage: (m) => { if (m.type !== "meddle" && m.type !== "user") { childSeen = processesWith(mark).length > 0; throw boom; } },
  });
  await expect(done).rejects.toBe(boom);
  expect(childSeen).toBe(true);
  const failed = listEvents(db, "abc").map(e => e.message as any).filter(m => m.subtype === "turn_failed");
  expect(failed).toMatchObject([{ type: "meddle", error: "Error: broadcast failed" }]);
  expect(typeof failed[0].at).toBe("string");
  for (let i = 0; i < 100 && processesWith(mark).length > 0; i++) await Bun.sleep(20);
  expect(processesWith(mark)).toEqual([]);
});
test("an abort after the result resolves with the result", async () => {
  const { db, input, fixture } = await setup();
  const ac = new AbortController();
  const { done } = runTurn({ input: { ...input, extraEnv: fixture("hello") }, prompt: "x", db, approvals: new Approvals(), signal: ac.signal, onMessage: (m) => { if (m.type === "result") ac.abort(); } });
  expect((await done).type).toBe("result");
  expect(listEvents(db, "abc").map(e => (e.message as any).subtype)).not.toContain("turn_aborted");
});
test("a synchronous failure to start still closes the turn in the log", async () => {
  const { db, input } = await setup();
  expect(() => runTurn({ input: { ...input, cfg: undefined as any }, prompt: "x", db, approvals: new Approvals() })).toThrow();
  expect(listEvents(db, "abc").map(e => (e.message as any).subtype ?? (e.message as any).type)).toEqual(["turn_started", "user", "turn_failed"]);
});
test("onMessage streams every recorded event, meddle's own included, in seq order", async () => {
  const { db, input, fixture } = await setup();
  const streamed: [number, unknown][] = [];
  const { done } = runTurn({ input: { ...input, extraEnv: fixture("hello") }, prompt: "x", db, approvals: new Approvals(), onMessage: (m, seq) => streamed.push([seq, m]) });
  expect(streamed).toHaveLength(2); // turn_started and the prompt, both before the child says anything
  await done;
  expect(streamed).toEqual(listEvents(db, "abc").map(e => [e.seq, e.message]));
});
test("input queue: yields pushed items in order, waits while empty, finishes after end", async () => {
  const q = new InputQueue();
  const it = q[Symbol.asyncIterator]();
  q.push("one"); q.push("two", "now");
  expect((await it.next()).value).toEqual({ type: "user", message: { role: "user", content: "one" }, parent_tool_use_id: null, session_id: "", priority: "next" });
  expect((await it.next()).value).toMatchObject({ message: { content: "two" }, priority: "now" });
  let settled = false;
  const waiting = it.next().then(r => { settled = true; return r; });
  await Bun.sleep(20);
  expect(settled).toBe(false);
  q.push("three");
  expect((await waiting).value).toMatchObject({ message: { content: "three" }, priority: "next" });
  q.push("four"); q.end(); q.end();
  expect(() => q.push("five")).toThrow("input queue ended");
  expect((await it.next()).value).toMatchObject({ message: { content: "four" } });
  expect((await it.next()).done).toBe(true);
});
test("approvals: pending until answered, unknown ids refused, listeners told", async () => {
  const approvals = new Approvals();
  let changes = 0;
  approvals.onChange(() => { changes++; });
  expect(approvals.answer("nope", { behavior: "deny", message: "x" })).toBe(false);
  const asked = approvals.ask({ requestId: "r1", taskId: "abc", toolName: "Bash", input: { command: "ls" }, toolUseId: "t1" });
  expect(changes).toBe(1);
  expect(approvals.pending("abc")).toMatchObject([{ requestId: "r1", toolName: "Bash", toolUseId: "t1" }]);
  expect(typeof approvals.pending()[0]!.askedAt).toBe("string");
  expect(approvals.pending("other")).toEqual([]);
  expect(approvals.answer("r1", { behavior: "allow", updatedInput: { command: "ls" } })).toBe(true);
  expect(changes).toBe(2);
  expect(await asked).toEqual({ behavior: "allow", updatedInput: { command: "ls" } });
  expect(approvals.pending()).toEqual([]);
  expect(approvals.answer("r1", { behavior: "deny", message: "x" })).toBe(false);
});
