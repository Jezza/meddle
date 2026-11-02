// test/token-fallback.test.ts — a turn whose login hits a usage limit or a login-class error marks the token for the
// pool and reruns once with the next token.
import { test, expect } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRegistry } from "@earendil-works/pi-durable";
import { NodeObject } from "../src/state/host";
import { PoolObject, type Notification } from "../src/state/contracts";
import { listEvents } from "../src/store/events";
import { getTask } from "../src/store/records";
import { TaskRunner, TOKEN_RETRY_PROMPT } from "../src/tasks/durable";
import { openHarness } from "../src/tasks/harness";
import { addToken, listTokens, removeToken } from "../src/token";
import { replay } from "./helpers";
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
    const m = await node.nodeObject.createTask({ title: "t", projectIds: [node.project.id] });
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
    const m = await node.nodeObject.createTask({ title: "t", projectIds: [node.project.id] });
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
    const m = await node.nodeObject.createTask({ title: "t", projectIds: [node.project.id] });
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
    const m = await node.nodeObject.createTask({ title: "t", projectIds: [node.project.id] });
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
    const m = await node.nodeObject.createTask({ title: "t", projectIds: [node.project.id] });
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
    const runner = new TaskRunner(node.cfg, node.db, harness.harness, {
      claudePath: replay, claudeRuntime: "bun",
      extraEnv: { MEDDLE_FIXTURE: fixture("hello.jsonl"), MEDDLE_FIXTURE_BY_TOKEN: byToken },
      pool: node.pool, log: (line) => node.logs.push(line),
    });
    await eventually(
      () => getTask(node.db, m.id)!.state === "idle" && messages(node.db, m.id).some((x) => x.type === "result" && x.subtype === "success"),
      () => `the rerun to complete: ${JSON.stringify(messages(node.db, m.id).map((x) => x.subtype ?? x.type))}`,
      20_000,
    );
    void runner;
    const log = messages(node.db, m.id);
    expect(log.filter((x) => x.type === "meddle" && x.subtype === "turn_started")).toHaveLength(2);
    expect(prompts(node.db, m.id)).toEqual(["Reply with the single word ok.", TOKEN_RETRY_PROMPT]);
    expect(log.filter((x) => x.type === "result").map((r) => r.subtype)).toEqual(["error_during_execution", "success"]);
  } finally {
    await reopened?.close();
    await node.close();
  }
}, 40_000);
