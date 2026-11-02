// test/token-fallback.test.ts — a turn whose login hits a usage limit or a login-class error marks the token for the
// pool and reruns once with the next token.
import { test, expect } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRegistry } from "@earendil-works/pi-durable";
import { NodeObject } from "../src/state/host";
import { PoolObject, type Notification } from "../src/state/contracts";
import { appendEvent, listEvents } from "../src/store/events";
import { getTask } from "../src/store/records";
import { TaskRunner, TOKEN_RETRY_PROMPT } from "../src/tasks/durable";
import { openHarness } from "../src/tasks/harness";
import { addToken, listTokens, removeToken } from "../src/token";
import { replay, setupNode } from "./helpers";
import { linkClient, startPoolNode, twoPoolNodes } from "./pool-helpers";

const fixture = (name: string) => `${import.meta.dir}/fixtures/${name}`;
/** The recorded rejection's `resetsAt` (unix seconds) as the token's `until`. */
const RESETS_AT = new Date(4102444800 * 1000).toISOString();

/** Resolves with the first value of `readable` (the current one included) that satisfies `pred`. */
function until<T>(readable: { subscribe(cb: (value: T) => void): () => void }, pred: (value: T) => boolean): Promise<T> {
  return new Promise((resolve) => {
    let done = false;
    let stop: (() => void) | undefined;
    stop = readable.subscribe((value) => {
      if (done || !pred(value)) return;
      done = true;
      resolve(value);
      stop?.();
    });
    if (done) stop();
  });
}

async function eventually(cond: () => boolean, what: () => string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting: ${what()}`);
    await Bun.sleep(10);
  }
}

/** Resolves on the task's first `idle` after a `result` or `turn_failed`: its turn is over. */
function turnOver(runner: TaskRunner, taskId: string): Promise<void> {
  return new Promise((resolve) => {
    let ended = false;
    runner.onEvent((tid, _seq, m: any) => {
      if (tid === taskId && (m.type === "result" || (m.type === "meddle" && m.subtype === "turn_failed"))) ended = true;
    });
    runner.onState((tid, s) => { if (tid === taskId && ended && s === "idle") resolve(); });
  });
}

/** The task's events, as messages. */
function messages(db: Parameters<typeof listEvents>[0], taskId: string): any[] {
  return listEvents(db, taskId).map((e) => e.message as any);
}

/** The text of each prompt meddle recorded (user events with string content). */
function prompts(db: Parameters<typeof listEvents>[0], taskId: string): string[] {
  return messages(db, taskId).filter((m) => m.type === "user" && typeof m.message?.content === "string").map((m) => m.message.content);
}

/** A copy of hello.jsonl whose assistant message carries `error` and whose `result` is an error, in a temp file. */
async function assistantErrorFixture(error: string): Promise<string> {
  const lines = (await readFile(fixture("hello.jsonl"), "utf8")).split("\n").filter(Boolean).map((l) => {
    const entry = JSON.parse(l) as { dir: string; line?: string };
    if (entry.dir !== "out" || entry.line === undefined) return l;
    const frame = JSON.parse(entry.line) as { type?: string };
    if (frame.type === "assistant") return JSON.stringify({ ...entry, line: JSON.stringify({ ...frame, error }) });
    if (frame.type === "result") {
      return JSON.stringify({ ...entry, line: JSON.stringify({ ...frame, subtype: "error_during_execution", is_error: true, errors: [error] }) });
    }
    return l;
  });
  const file = `${await mkdtemp("/tmp/meddle-fixture-")}/assistant-error.jsonl`;
  await writeFile(file, `${lines.join("\n")}\n`);
  return file;
}

/** A copy of hello.jsonl whose rate-limit event is `rejected` (until RESETS_AT) while its `result` stays a success. */
async function rejectedButSucceededFixture(): Promise<string> {
  const lines = (await readFile(fixture("hello.jsonl"), "utf8")).split("\n").filter(Boolean).map((l) => {
    const entry = JSON.parse(l) as { dir: string; line?: string };
    if (entry.dir !== "out" || entry.line === undefined) return l;
    const frame = JSON.parse(entry.line) as { type?: string; rate_limit_info?: object };
    if (frame.type !== "rate_limit_event") return l;
    const info = { ...frame.rate_limit_info, status: "rejected", resetsAt: 4102444800, rateLimitType: "five_hour" };
    return JSON.stringify({ ...entry, line: JSON.stringify({ ...frame, rate_limit_info: info }) });
  });
  const file = `${await mkdtemp("/tmp/meddle-fixture-")}/rejected-success.jsonl`;
  await writeFile(file, `${lines.join("\n")}\n`);
  return file;
}

/** A pool node with no default token, the fixture chosen by the token a turn runs with, and a client on its host. */
async function tokenNode(byToken: Record<string, string>) {
  const env = { MEDDLE_FIXTURE_BY_TOKEN: Object.entries(byToken).map(([t, f]) => `${t}=${f}`).join(",") };
  const node = await startPoolNode("hello.jsonl", env, { token: null });
  const { client, close: closeClient } = linkClient(node.host);
  const nodeObject = await client.get(NodeObject, {});
  const pool = await client.get(PoolObject, {});
  if (pool.variant !== "default") throw new Error("expected the default variant");
  /** Adds token `value` labelled `label`, set at `at` (so the order is the order of the calls). */
  const add = async (value: string, label: string, at: string) => {
    const t = await addToken(node.cfg, node.db, value, { label, setBy: node.id, now: at });
    await node.pool.tokenChanged();
    return t;
  };
  const close = async () => {
    nodeObject.release();
    pool.release();
    await closeClient();
    await node.close();
  };
  return { ...node, nodeObject, poolObject: pool, add, close };
}

/** The task's notifications as `{kind, text}`. */
function notesOf(notes: Notification[], taskId: string): Array<{ kind: string; text: string }> {
  return notes.filter((n) => n.taskId === taskId).map(({ kind, text }) => ({ kind, text }));
}

test("a rate-limited token is marked exhausted and the turn reruns once with the next token", async () => {
  const node = await tokenNode({ "tok-a": fixture("rate-limited.jsonl"), "tok-b": fixture("hello.jsonl") });
  try {
    const a = await node.add("tok-a", "a", "2026-01-01T00:00:00.000Z");
    const b = await node.add("tok-b", "b", "2026-01-01T00:00:01.000Z");
    await until(node.poolObject.activeTokenId, (id) => id === a.id);
    const m = (await node.nodeObject.createTask({ title: "t", projectIds: [node.project.id] })).manifest;
    const over = turnOver(node.runner, m.id);
    await node.runner.prompt(m.id, "Reply with the single word ok.");
    await over;

    const log = messages(node.db, m.id);
    const results = log.filter((x) => x.type === "result");
    expect(results.map((r) => r.subtype)).toEqual(["error_during_execution", "success"]);
    const faultAt = log.findIndex((x) => x.type === "meddle" && x.subtype === "token_fault");
    expect(log[faultAt]).toMatchObject({
      tokenId: a.id, label: "a", rerun: true, fault: { kind: "exhausted", until: RESETS_AT, type: "five_hour" },
    });
    // the fault comes after the failed attempt's result, the rerun after the fault
    expect(faultAt).toBeGreaterThan(log.indexOf(results[0]));
    const starts = log.flatMap((x, i) => (x.type === "meddle" && x.subtype === "turn_started" ? [{ i, resume: x.resume }] : []));
    expect(starts.map((s) => s.resume)).toEqual([false, true]);
    expect(starts[1]!.i).toBeGreaterThan(faultAt);
    expect(prompts(node.db, m.id)).toEqual(["Reply with the single word ok.", TOKEN_RETRY_PROMPT]);
    // the failed message stays in the log
    expect(log.filter((x) => x.type === "meddle" && x.subtype === "token_fault")).toHaveLength(1);

    const tokens = listTokens(node.db);
    expect(tokens.find((t) => t.id === a.id)).toMatchObject({ status: "exhausted", until: RESETS_AT, detail: "five_hour" });
    expect(tokens.find((t) => t.id === b.id)).toMatchObject({ status: "ok" });
    await until(node.poolObject.activeTokenId, (id) => id === b.id);

    const notes = await until(node.nodeObject.notifications, (n) => n.some((x) => x.taskId === m.id && x.kind === "finished"));
    expect(notesOf(notes, m.id)).toEqual([{ kind: "finished", text: "Turn finished" }]);
    expect(getTask(node.db, m.id)!.state).toBe("idle");
  } finally {
    await node.close();
  }
}, 30_000);

test("with no other token the turn fails once and raises a token notification", async () => {
  const node = await tokenNode({ "tok-a": fixture("rate-limited.jsonl") });
  try {
    const a = await node.add("tok-a", "a", "2026-01-01T00:00:00.000Z");
    const m = (await node.nodeObject.createTask({ title: "t", projectIds: [node.project.id] })).manifest;
    const over = turnOver(node.runner, m.id);
    await node.runner.prompt(m.id, "Reply with the single word ok.");
    await over;

    const log = messages(node.db, m.id);
    expect(log.filter((x) => x.type === "result").map((r) => r.subtype)).toEqual(["error_during_execution"]);
    const faults = log.filter((x) => x.type === "meddle" && x.subtype === "token_fault");
    expect(faults).toHaveLength(1);
    expect(faults[0]).toMatchObject({ tokenId: a.id, label: "a", rerun: false, fault: { kind: "exhausted", until: RESETS_AT } });
    expect(log.filter((x) => x.type === "meddle" && x.subtype === "turn_started")).toHaveLength(1);
    expect(listTokens(node.db)[0]).toMatchObject({ id: a.id, status: "exhausted", until: RESETS_AT });

    const notes = await until(node.nodeObject.notifications, (n) => n.some((x) => x.taskId === m.id && x.kind === "token"));
    await Bun.sleep(200); // nothing else is on its way
    expect(notesOf(node.nodeObject.notifications.value, m.id)).toEqual([
      { kind: "token", text: `token a exhausted until ${RESETS_AT}; no other token` },
    ]);
    expect(notes.some((x) => x.kind === "failed")).toBe(false);
  } finally {
    await node.close();
  }
}, 30_000);

test("a disabled-class error disables the token with until null", async () => {
  const node = await tokenNode({ "tok-a": await assistantErrorFixture("billing_error") });
  try {
    const a = await node.add("tok-a", "a", "2026-01-01T00:00:00.000Z");
    const m = (await node.nodeObject.createTask({ title: "t", projectIds: [node.project.id] })).manifest;
    const over = turnOver(node.runner, m.id);
    await node.runner.prompt(m.id, "Reply with the single word ok.");
    await over;

    expect(listTokens(node.db)[0]).toMatchObject({ id: a.id, status: "disabled", until: null, detail: "billing_error" });
    const faults = messages(node.db, m.id).filter((x) => x.type === "meddle" && x.subtype === "token_fault");
    expect(faults).toMatchObject([{ tokenId: a.id, rerun: false, fault: { kind: "disabled", reason: "billing_error" } }]);
    await until(node.nodeObject.notifications, (n) => n.some((x) => x.taskId === m.id && x.kind === "token"));
    await Bun.sleep(200);
    expect(notesOf(node.nodeObject.notifications.value, m.id)).toEqual([
      { kind: "token", text: "token a disabled: billing_error; no other token" },
    ]);
    await until(node.poolObject.activeTokenId, (id) => id === null);
  } finally {
    await node.close();
  }
}, 30_000);

test("with no usable token the only notification is of kind token", async () => {
  const node = await tokenNode({});
  try {
    await node.add("tok-a", "a", "2026-01-01T00:00:00.000Z");
    const m = (await node.nodeObject.createTask({ title: "t", projectIds: [node.project.id] })).manifest;
    await removeToken(node.cfg, node.db, "a");
    const over = turnOver(node.runner, m.id);
    await node.runner.prompt(m.id, "Reply with the single word ok.");
    await over;

    const log = messages(node.db, m.id);
    expect(log.map((x) => x.subtype)).toEqual(["token_fault", "turn_failed"]);
    expect(log[0]).toMatchObject({ tokenId: null, label: null, fault: { kind: "none" }, rerun: false });
    expect(log[1].error).toContain("no usable token");
    await until(node.nodeObject.notifications, (n) => n.some((x) => x.taskId === m.id && x.kind === "token"));
    await Bun.sleep(200);
    expect(notesOf(node.nodeObject.notifications.value, m.id)).toEqual([{ kind: "token", text: "no usable token" }]);
  } finally {
    await node.close();
  }
}, 30_000);

test("the mark replicates", async () => {
  const { A, B, close } = await twoPoolNodes({
    nodes: [{ token: null, extraEnv: { MEDDLE_FIXTURE_BY_TOKEN: `tok-a=${fixture("rate-limited.jsonl")}` } }, { token: null }],
  });
  try {
    const a = await addToken(A.cfg, A.db, "tok-a", { label: "a", setBy: A.id });
    await A.pool.tokenChanged();
    await eventually(() => listTokens(B.db).some((t) => t.id === a.id), () => "B to list the token");
    const m = await A.runner.create({ title: "t", projectIds: [A.project.id] });
    const over = turnOver(A.runner, m.id);
    await A.runner.prompt(m.id, "Reply with the single word ok.");
    await over;
    expect(listTokens(A.db)[0]).toMatchObject({ status: "exhausted", until: RESETS_AT });
    await eventually(
      () => listTokens(B.db).find((t) => t.id === a.id)?.status === "exhausted",
      () => `B to list the token exhausted: ${JSON.stringify(listTokens(B.db))}`,
    );
    expect(listTokens(B.db).find((t) => t.id === a.id)).toMatchObject({ status: "exhausted", until: RESETS_AT, detail: "five_hour" });
  } finally {
    await close();
  }
}, 30_000);

test("a service restart after the fault reruns once with TOKEN_RETRY_PROMPT", async () => {
  const byToken = `tok-a=${fixture("rate-limited.jsonl")},tok-b=${fixture("hello.jsonl")}`;
  const node = await tokenNode({ "tok-a": fixture("rate-limited.jsonl"), "tok-b": fixture("hello.jsonl") });
  let reopened: { close(): Promise<void> } | undefined;
  try {
    await node.add("tok-a", "a", "2026-01-01T00:00:00.000Z");
    await node.add("tok-b", "b", "2026-01-01T00:00:01.000Z");
    const m = (await node.nodeObject.createTask({ title: "t", projectIds: [node.project.id] })).manifest;
    // The sleep before the rerun is `now()`: this hook is the only window for the process to stop in.
    let closing: Promise<void> | undefined;
    node.hooks.afterTokenFault = () => { closing ??= node.harness.close(); };
    await node.runner.prompt(m.id, "Reply with the single word ok.");
    await eventually(() => closing !== undefined, () => "the token fault");
    await closing;
    const startsBefore = messages(node.db, m.id).filter((x) => x.type === "meddle" && x.subtype === "turn_started").length;
    expect(startsBefore).toBe(1);

    const harness = await openHarness(node.cfg, createRegistry());
    reopened = harness;
    new TaskRunner(node.cfg, node.db, harness.harness, {
      claudePath: replay, claudeRuntime: "bun",
      extraEnv: { MEDDLE_FIXTURE: fixture("hello.jsonl"), MEDDLE_FIXTURE_BY_TOKEN: byToken },
      pool: node.pool, log: (line) => node.logs.push(line),
    });
    await eventually(
      () => getTask(node.db, m.id)!.state === "idle" && messages(node.db, m.id).some((x) => x.type === "result" && x.subtype === "success"),
      () => `the rerun to complete: ${JSON.stringify(messages(node.db, m.id).map((x) => x.subtype ?? x.type))}`,
      20_000,
    );
    const log = messages(node.db, m.id);
    expect(log.filter((x) => x.type === "meddle" && x.subtype === "turn_started")).toHaveLength(2);
    expect(prompts(node.db, m.id)).toEqual(["Reply with the single word ok.", TOKEN_RETRY_PROMPT]);
    expect(log.filter((x) => x.type === "result").map((r) => r.subtype)).toEqual(["error_during_execution", "success"]);
  } finally {
    await reopened?.close();
    await node.close();
  }
}, 40_000);

test("a fault in a turn that succeeds marks the token but does not rerun the turn", async () => {
  const node = await tokenNode({ "tok-a": await rejectedButSucceededFixture(), "tok-b": fixture("hello.jsonl") });
  try {
    const a = await node.add("tok-a", "a", "2026-01-01T00:00:00.000Z");
    const b = await node.add("tok-b", "b", "2026-01-01T00:00:01.000Z");
    const m = (await node.nodeObject.createTask({ title: "t", projectIds: [node.project.id] })).manifest;
    const over = turnOver(node.runner, m.id);
    await node.runner.prompt(m.id, "Reply with the single word ok.");
    await over;

    const log = messages(node.db, m.id);
    expect(log.filter((x) => x.type === "meddle" && x.subtype === "turn_started")).toHaveLength(1);
    expect(log.filter((x) => x.type === "result").map((r) => r.subtype)).toEqual(["success"]);
    expect(log.some((x) => x.type === "meddle" && x.subtype === "token_fault")).toBe(false);
    expect(listTokens(node.db).find((t) => t.id === a.id)).toMatchObject({ status: "exhausted", until: RESETS_AT, detail: "five_hour" });
    await until(node.poolObject.activeTokenId, (id) => id === b.id);
    await until(node.nodeObject.notifications, (n) => n.some((x) => x.taskId === m.id && x.kind === "finished"));
    await Bun.sleep(200);
    expect(notesOf(node.nodeObject.notifications.value, m.id)).toEqual([{ kind: "finished", text: "Turn finished" }]);
  } finally {
    await node.close();
  }
}, 30_000);

test("a turn reruns for its token at most once: a second fault stops it and says another login is left", async () => {
  const node = await tokenNode({
    "tok-a": fixture("rate-limited.jsonl"), "tok-b": fixture("rate-limited.jsonl"), "tok-c": fixture("hello.jsonl"),
  });
  try {
    const a = await node.add("tok-a", "a", "2026-01-01T00:00:00.000Z");
    const b = await node.add("tok-b", "b", "2026-01-01T00:00:01.000Z");
    const c = await node.add("tok-c", "c", "2026-01-01T00:00:02.000Z");
    const m = (await node.nodeObject.createTask({ title: "t", projectIds: [node.project.id] })).manifest;
    const over = turnOver(node.runner, m.id);
    await node.runner.prompt(m.id, "Reply with the single word ok.");
    await over;

    const log = messages(node.db, m.id);
    expect(log.filter((x) => x.type === "meddle" && x.subtype === "turn_started")).toHaveLength(2);
    const faults = log.filter((x) => x.type === "meddle" && x.subtype === "token_fault");
    expect(faults.map((f) => [f.tokenId, f.rerun, f.retried])).toEqual([[a.id, true, undefined], [b.id, false, true]]);
    expect(prompts(node.db, m.id)).toEqual(["Reply with the single word ok.", TOKEN_RETRY_PROMPT]);
    expect(listTokens(node.db).map((t) => [t.id, t.status])).toEqual([[a.id, "exhausted"], [b.id, "exhausted"], [c.id, "ok"]]);
    await until(node.nodeObject.notifications, (n) => n.some((x) => x.taskId === m.id && x.kind === "token"));
    await Bun.sleep(200);
    expect(notesOf(node.nodeObject.notifications.value, m.id)).toEqual([{
      kind: "token",
      text: `token b exhausted until ${RESETS_AT}; already switched login once, send the message again to use the next token`,
    }]);
  } finally {
    await node.close();
  }
}, 30_000);

test("a restart before the rerun's sleep is stored still reruns at most once", async () => {
  const byToken = `tok-a=${fixture("rate-limited.jsonl")},tok-b=${fixture("rate-limited.jsonl")},tok-c=${fixture("hello.jsonl")}`;
  const node = await tokenNode({
    "tok-a": fixture("rate-limited.jsonl"), "tok-b": fixture("rate-limited.jsonl"), "tok-c": fixture("hello.jsonl"),
  });
  let reopened: { close(): Promise<void> } | undefined;
  try {
    await node.add("tok-a", "a", "2026-01-01T00:00:00.000Z");
    await node.add("tok-b", "b", "2026-01-01T00:00:01.000Z");
    await node.add("tok-c", "c", "2026-01-01T00:00:02.000Z");
    const m = (await node.nodeObject.createTask({ title: "t", projectIds: [node.project.id] })).manifest;
    let closing: Promise<void> | undefined;
    node.hooks.afterTokenFault = () => { closing ??= node.harness.close(); };
    await node.runner.prompt(m.id, "Reply with the single word ok.");
    await eventually(() => closing !== undefined, () => "the token fault");
    await closing;

    const harness = await openHarness(node.cfg, createRegistry());
    reopened = harness;
    new TaskRunner(node.cfg, node.db, harness.harness, {
      claudePath: replay, claudeRuntime: "bun",
      extraEnv: { MEDDLE_FIXTURE: fixture("hello.jsonl"), MEDDLE_FIXTURE_BY_TOKEN: byToken },
      pool: node.pool, log: (line) => node.logs.push(line),
    });
    const faults = () => messages(node.db, m.id).filter((x) => x.type === "meddle" && x.subtype === "token_fault");
    await eventually(
      () => getTask(node.db, m.id)!.state === "idle" && faults().length === 2,
      () => `the rerun to stop: ${JSON.stringify(messages(node.db, m.id).map((x) => x.subtype ?? x.type))}`,
      20_000,
    );
    await Bun.sleep(300); // no third attempt is on its way
    const log = messages(node.db, m.id);
    expect(log.filter((x) => x.type === "meddle" && x.subtype === "turn_started")).toHaveLength(2);
    expect(faults().map((f) => [f.label, f.rerun, f.retried])).toEqual([["a", true, undefined], ["b", false, true]]);
    expect(log.filter((x) => x.type === "result").map((r) => r.subtype)).toEqual(["error_during_execution", "error_during_execution"]);
  } finally {
    await reopened?.close();
    await node.close();
  }
}, 40_000);

test("a turn aborted between its token rerun and the rerun's start logs turn_aborted, so the next turn is not a token rerun", async () => {
  const node = await setupNode();
  try {
    const m = await node.runner.create({ title: "t", projectIds: [node.project.id] });
    const told: string[] = [];
    node.runner.onEvent((tid, _seq, msg: any) => { if (tid === m.id) told.push(msg.subtype ?? msg.type); });
    appendEvent(node.db, m.id, { type: "meddle", subtype: "turn_started", at: new Date().toISOString() } as any);
    appendEvent(node.db, m.id, { type: "meddle", subtype: "token_fault", at: new Date().toISOString(), rerun: true } as any);
    node.runner.abortTurnPhase(m.id);
    expect(messages(node.db, m.id).map((x) => x.subtype)).toEqual(["turn_started", "token_fault", "turn_aborted"]);
    expect(told).toEqual(["turn_aborted"]);

    // The rerun had started (its own turn_started is the newest): runTurn logs its abort, not this.
    appendEvent(node.db, m.id, { type: "meddle", subtype: "token_fault", at: new Date().toISOString(), rerun: true } as any);
    appendEvent(node.db, m.id, { type: "meddle", subtype: "turn_started", at: new Date().toISOString() } as any);
    node.runner.abortTurnPhase(m.id);
    // A token fault that does not rerun is a turn's end: nothing to add either.
    appendEvent(node.db, m.id, { type: "meddle", subtype: "token_fault", at: new Date().toISOString(), rerun: false } as any);
    node.runner.abortTurnPhase(m.id);
    expect(messages(node.db, m.id).map((x) => x.subtype)).toEqual([
      "turn_started", "token_fault", "turn_aborted", "token_fault", "turn_started", "token_fault",
    ]);
  } finally {
    await node.harness.close();
  }
});
