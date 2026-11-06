// test/engine.test.ts
import { test, expect } from "bun:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { openDb } from "../src/store/db";
import { listEvents } from "../src/store/events";
import { SqliteSessionStore } from "../src/store/session-store";
import { Approvals, } from "../src/engine/approvals";
import { InputQueue } from "../src/engine/input";
import { runTurn, tokenFaultOf, type TokenFault } from "../src/engine/session";
import { loadConfig, ensureDataDirs } from "../src/config";
import { DEFAULT_CONTEXT } from "../src/projects/context";
const replay = `${import.meta.dir}/fake-claude/replay.ts`;
async function setup() {
  const home = await mkdtemp("/tmp/meddle-eng-");
  const cfg = loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/d`, MEDDLE_TASK_ROOT: `${home}/t` });
  await ensureDataDirs(cfg); await mkdir(`${home}/t/abc/a/.jj`, { recursive: true }); await mkdir(`${home}/t/abc/.meddle/claude`, { recursive: true });
  const db = openDb(":memory:");
  const manifest = { id: "abc", title: "t", sessionId: crypto.randomUUID(), primaryProjectId: "p1", createdAt: "", projects: [{ id: "p1", name: "a", replica: `${home}/t/abc/a`, workspace: "a", parent: "root()", base: "0000000000000000000000000000000000000000" }] };
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
  expect(listEvents(db, "abc")[1]!.message).toEqual({ type: "user", message: { role: "user", content: "Reply with the single word ok." }, parent_tool_use_id: null, uuid: expect.any(String) });
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
/** The SDK message of line `n` (1-based) of a fixture. */
function fixtureFrame(name: string, n: number): any {
  const line = readFileSync(`${import.meta.dir}/fixtures/${name}.jsonl`, "utf8").split("\n").filter(Boolean)[n - 1]!;
  return JSON.parse(JSON.parse(line).line);
}
test("tokenFaultOf reads a rejected rate limit and the login-class assistant errors, nothing else", () => {
  // the recorded rejection: resetsAt in unix seconds
  expect(tokenFaultOf(fixtureFrame("rate-limited", 6))).toEqual({ kind: "exhausted", until: new Date(4102444800 * 1000).toISOString(), type: "five_hour" });
  // a resetsAt in milliseconds is taken as such; none gives a null until; no type gives a null type
  const at = Date.parse("2030-01-02T03:04:05.000Z");
  expect(tokenFaultOf({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: at } } as any)).toEqual({ kind: "exhausted", until: "2030-01-02T03:04:05.000Z", type: null });
  expect(tokenFaultOf({ type: "rate_limit_event", rate_limit_info: { status: "rejected" } } as any)).toEqual({ kind: "exhausted", until: null, type: null });
  // hello.jsonl line 6: status allowed, overageStatus rejected: the discriminator is status
  const allowed = fixtureFrame("hello", 6);
  expect(allowed.rate_limit_info).toMatchObject({ status: "allowed", overageStatus: "rejected" });
  expect(tokenFaultOf(allowed)).toBeNull();
  expect(tokenFaultOf({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", resetsAt: 1 } } as any)).toBeNull();
  const assistant = fixtureFrame("hello", 7);
  expect(tokenFaultOf(assistant)).toBeNull();
  expect(tokenFaultOf({ ...assistant, error: "rate_limit" })).toEqual({ kind: "exhausted", until: null, type: null });
  for (const reason of ["billing_error", "account_on_hold", "authentication_failed", "oauth_org_not_allowed", "verification_required"]) {
    expect(tokenFaultOf({ ...assistant, error: reason })).toEqual({ kind: "disabled", reason });
  }
  for (const other of ["max_output_tokens", "overloaded", "server_error", "unknown"]) expect(tokenFaultOf({ ...assistant, error: other })).toBeNull();
  expect(tokenFaultOf(fixtureFrame("hello", 8))).toBeNull();
});
test("onTokenFault is called once, before done resolves, for a turn whose login hit a limit", async () => {
  const { db, input, fixture } = await setup();
  const faults: TokenFault[] = [];
  const { done } = runTurn({ input: { ...input, extraEnv: fixture("rate-limited") }, prompt: "x", db, approvals: new Approvals(), onTokenFault: (f) => faults.push(f) });
  const result = await done;
  expect(result).toMatchObject({ subtype: "error_during_execution", is_error: true });
  expect(faults).toEqual([{ kind: "exhausted", until: new Date(4102444800 * 1000).toISOString(), type: "five_hour" }]);
  // a turn without one never calls it
  const none: TokenFault[] = [];
  await runTurn({ input: { ...input, extraEnv: fixture("hello") }, prompt: "x", db, approvals: new Approvals(), onTokenFault: (f) => none.push(f) }).done;
  expect(none).toEqual([]);
});
const STEER = "Also: end your reply with the word PINEAPPLE.";
/**
 * Runs a turn of recording `name` whose first assistant message is answered with a steer into its input, as the
 * runner steers a live turn; `extraEnv` goes to the stand-in.
 */
async function steeredTurn(name: string, extraEnv: Record<string, string> = {}) {
  const { db, input, fixture } = await setup();
  const queue = new InputQueue();
  let steer: string | undefined;
  let steerableAfterFirstResult: boolean | undefined;
  const { done } = runTurn({
    input: { ...input, extraEnv: { ...fixture(name), ...extraEnv } }, prompt: "Reply with the single word ok.", db, approvals: new Approvals(), queue,
    onMessage: (m) => {
      if (m.type === "assistant" && steer === undefined) steer = queue.push(STEER);
      if (m.type === "result") steerableAfterFirstResult ??= !queue.ended;
    },
  });
  const result = await done;
  const recorded = listEvents(db, "abc").map(e => e.message as any);
  return { result, recorded, steer: steer!, queue, steerableAfterFirstResult };
}
/** Each recorded event as `type[/subtype]`, a prompt's text after the user's. */
const shape = (recorded: any[]) => recorded.filter(m => m.type !== "stream_event" && m.subtype !== "thinking_tokens" && m.type !== "rate_limit_event")
  .map(m => (m.subtype ? `${m.type}/${m.subtype}` : m.type) + (m.type === "user" && typeof m.message.content === "string" ? `: ${m.message.content}` : ""));
test("a steer Claude Code folds into the running turn is logged where it took it, and the turn ends with that turn's result", async () => {
  const { result, recorded, steer, queue } = await steeredTurn("steer-fold");
  expect(result).toMatchObject({ subtype: "success", result: "done\n\nPINEAPPLE" });
  expect(queue.untaken()).toEqual([]);
  // logged once, with its uuid, as Claude Code started on it: after the tool's result, before the reply to it
  expect(recorded.filter(m => m.type === "user" && m.message.content === STEER)).toEqual([{ type: "user", message: { role: "user", content: STEER }, parent_tool_use_id: null, uuid: steer }]);
  const s = shape(recorded);
  expect(s.slice(s.indexOf(`user: ${STEER}`) - 1, s.indexOf(`user: ${STEER}`) + 3)).toEqual(["user", `user: ${STEER}`, "command_lifecycle", "assistant"]);
  expect(s.filter(x => x === "result/success")).toHaveLength(1);
});
test("a steer that gets a turn of its own keeps the turn going past the exit grace, open to more steers, to its own result", async () => {
  const { result, recorded, queue, steerableAfterFirstResult } = await steeredTurn("steer-turn", { MEDDLE_FIXTURE_LATER_RESULTS_MS: "5500" });
  expect(result).toMatchObject({ subtype: "success", result: "ok PINEAPPLE" });
  expect(recorded.filter(m => m.type === "result").map(m => m.result)).toEqual(["ok", "ok PINEAPPLE"]);
  expect(recorded.map(m => m.subtype)).not.toContain("turn_failed");
  expect(steerableAfterFirstResult).toBe(true);
  expect(queue.untaken()).toEqual([]);
  const s = shape(recorded);
  expect(s.indexOf(`user: ${STEER}`)).toBeGreaterThan(s.indexOf("result/success"));
  expect(s.indexOf(`user: ${STEER}`)).toBeLessThan(s.lastIndexOf("system/init"));
}, 15_000);
test("a steer Claude Code never takes ends the turn after the exit grace, unlogged and handed back untaken", async () => {
  const { db, input, fixture } = await setup();
  const queue = new InputQueue();
  let steer: string | undefined;
  const { done } = runTurn({
    input: { ...input, extraEnv: fixture("hello") }, prompt: "Reply with the single word ok.", db, approvals: new Approvals(), queue,
    onMessage: (m) => { if (m.type === "assistant") steer = queue.push(STEER); },
  });
  expect(await done).toMatchObject({ result: "ok" });
  expect(queue.untaken()).toEqual([{ uuid: steer!, text: STEER }]);
  expect(listEvents(db, "abc").map(e => e.message as any).filter(m => m.type === "user").map(m => m.message.content)).toEqual(["Reply with the single word ok."]);
}, 15_000);
test("input queue: every text pushed is untaken, in order, until taken by its uuid; taken ones are told once", () => {
  const q = new InputQueue();
  const a = q.push("a"), b = q.push("b"), c = q.push("c", "now");
  expect(new Set([a, b, c]).size).toBe(3);
  expect(q.untaken()).toEqual([{ uuid: a, text: "a" }, { uuid: b, text: "b" }, { uuid: c, text: "c" }]);
  expect(q.take(b)).toBe("b");
  expect(q.take(b)).toBeNull(); // taken already
  expect(q.take("unknown")).toBeNull();
  expect(q.untaken()).toEqual([{ uuid: a, text: "a" }, { uuid: c, text: "c" }]);
});
test("input queue: yields pushed items in order, waits while empty, finishes after end", async () => {
  const q = new InputQueue();
  const it = q[Symbol.asyncIterator]();
  const one = q.push("one"); q.push("two", "now");
  expect((await it.next()).value).toEqual({ type: "user", message: { role: "user", content: "one" }, parent_tool_use_id: null, session_id: "", priority: "next", uuid: one });
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
