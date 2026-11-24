// test/task-messages.test.ts: messages from other tasks' agents, delivered by the runner (the replayer's peer mode stands
// in for Claude Code's session registry and socket).
import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { loadConfig, ensureDataDirs, paths } from "../src/config";
import { openDb } from "../src/store/db";
import { addProjectFromFolder } from "../src/projects/project";
import { initColocated, jj } from "../src/jj";
import { openHarness } from "../src/tasks/harness";
import { TaskRunner, type RunnerHooks } from "../src/tasks/durable";
import type { EngineInput } from "../src/engine/options";
import { listEvents } from "../src/store/events";
import { getTask, queuedOf, updateTask } from "../src/store/records";
import { queueEntry, type Prompt } from "../src/blobs/attachment";
import { createTask } from "./helpers";

const PROJECT_HOME = "a".repeat(64);
const replay = `${import.meta.dir}/fake-claude/replay.ts`;
const sender = { taskId: "bbbbbbbbbbbb", nodeId: "n2", title: "Quiet fox" };
const message = (text: string): Prompt => ({ text, attachments: [], peer: sender });

async function eventually(cond: () => boolean, what: () => string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting: ${what()}`);
    await Bun.sleep(10);
  }
}

/** A node with one task, its runner replaying `fixture` in peer mode. */
async function node(fixture = "hello", extra: Record<string, string> = {}, hooks: RunnerHooks = {}) {
  const home = await mkdtemp("/tmp/meddle-msg-");
  const cfg = loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/d`, MEDDLE_TASK_ROOT: `${home}/t` });
  await ensureDataDirs(cfg); await mkdir(cfg.taskRoot, { recursive: true });
  const db = openDb(paths(cfg).db);
  const a = `${home}/a`; await initColocated(a);
  await writeFile(`${a}/README`, "a\n"); await jj(["commit", "-m", "init"], a); await jj(["bookmark", "set", "main", "-r", "@-"], a);
  const p = await addProjectFromFolder(cfg, db, a, PROJECT_HOME, "a");
  await (await import("../src/token")).addToken(cfg, db, "tok", { setBy: null });
  const input = `${home}/input.jsonl`;
  const { createRegistry } = await import("@earendil-works/pi-durable");
  /** A fresh harness and runner on the same node: what a restart of meddle makes. */
  const reopen = async (env: Record<string, string> = extra) => {
    const h = await openHarness(cfg, createRegistry());
    const runner = new TaskRunner(cfg, db, h.harness, {
      claudePath: replay, claudeRuntime: "bun",
      extraEnv: { MEDDLE_FIXTURE: `${import.meta.dir}/fixtures/${fixture}.jsonl`, MEDDLE_FIXTURE_PEER: "1", MEDDLE_FIXTURE_INPUT: input, ...env },
      hooks,
    });
    return { h, runner };
  };
  const { h, runner } = await reopen();
  const m = await createTask({ cfg, db, id: PROJECT_HOME, runner }, { title: "t", projectIds: [p.id] });
  const events = () => listEvents(db, m.id).map((e) => e.message as any);
  const socketLines = () => {
    try { return readFileSync(input, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((f) => f.via === "socket"); } catch { return []; }
  };
  const idle = () => eventually(() => runner.state(m.id) === "idle" && runner.liveQuery(m.id) === null, () => runner.state(m.id));
  return { cfg, db, h, runner, reopen, id: m.id, project: p.id, events, socketLines, idle };
}

test("a message to an idle task wakes it", async () => {
  const { h, runner, id, events, idle } = await node();
  expect(await runner.message(id, sender, "hi")).toBe("waking");
  await eventually(() => events().some((e) => e.type === "result"), () => JSON.stringify(events().map((e) => e.subtype ?? e.type)));
  await idle();
  const logged = events();
  expect(logged.find((e) => e.subtype === "peer_message")).toMatchObject({ from: sender, text: "hi" });
  expect(logged.filter((e) => e.type === "user" && typeof e.message?.content === "string")).toEqual([]);
  expect(runner.queued(id)).toEqual([]);
  await h.close();
});

test("a message to a running turn is written into it", async () => {
  const { h, runner, id, events, idle } = await node("steer-fold");
  let delivered: Promise<string> | undefined;
  runner.onEvent((tid, _s, m: any) => { if (tid === id && m.type === "assistant" && delivered === undefined) delivered = runner.message(id, sender, "also this"); });
  await runner.prompt(id, "Run: sleep 2");
  await eventually(() => delivered !== undefined, () => "no assistant");
  expect(await delivered!).toBe("delivered");
  await idle();
  const logged = events();
  const at = logged.findIndex((e) => e.subtype === "peer_message");
  expect(at).toBeGreaterThan(-1);
  expect(at).toBeLessThan(logged.findIndex((e) => e.type === "result"));
  expect(logged.filter((e) => e.subtype === "turn_started")).toHaveLength(1);
  await h.close();
});

test("a message after the turn's result waits for the next turn", async () => {
  const { h, runner, id, events, idle } = await node();
  let sent: Promise<string> | undefined;
  runner.onEvent((tid, _s, m: any) => { if (tid === id && m.type === "result" && sent === undefined) sent = runner.message(id, sender, "late"); });
  await runner.prompt(id, "x");
  await eventually(() => sent !== undefined, () => "no result");
  expect(await sent!).toBe("queued");
  await eventually(() => events().filter((e) => e.subtype === "turn_started").length === 2 && events().filter((e) => e.type === "result").length === 2, () => "no second turn");
  await idle();
  expect(events().filter((e) => e.subtype === "peer_message").map((e) => e.text)).toEqual(["late"]);
  await h.close();
});

test("messages queued ahead of a prompt go into its turn", async () => {
  const { h, db, runner, id, events, idle } = await node("steer-fold");
  updateTask(db, id, { queued: JSON.stringify([queueEntry(message("first")), queueEntry({ text: "Run: sleep 2", attachments: [] })]) });
  await runner.startQueued(id);
  await eventually(() => events().some((e) => e.type === "result"), () => "no result");
  await idle();
  const logged = events();
  expect(logged.filter((e) => e.subtype === "turn_started")).toHaveLength(1);
  expect(logged.filter((e) => e.subtype === "peer_message").map((e) => e.text)).toEqual(["first"]);
  expect(logged.filter((e) => e.type === "user" && typeof e.message?.content === "string").map((e) => e.message.content)).toEqual(["Run: sleep 2"]);
  expect(queuedOf(getTask(db, id)!)).toEqual([]);
  await h.close();
});

test("take-back leaves messages queued", async () => {
  const { h, db, runner, id } = await node();
  updateTask(db, id, { queued: JSON.stringify([queueEntry({ text: "mine", attachments: [] }), queueEntry(message("theirs"))]) });
  expect(await runner.takeBackQueued(id)).toEqual([{ text: "mine", attachments: [] }]);
  expect(queuedOf(getTask(db, id)!)).toEqual([message("theirs")]);
  await h.close();
});

test("dropQueued drops a message and refuses a prompt", async () => {
  const { h, db, runner, id } = await node();
  updateTask(db, id, { queued: JSON.stringify([queueEntry({ text: "mine", attachments: [] }), queueEntry(message("theirs"))]) });
  await expect(runner.dropQueued(id, { text: "mine", attachments: [] })).rejects.toThrow("not a queued message");
  await runner.dropQueued(id, message("theirs"));
  expect(queuedOf(getTask(db, id)!)).toEqual([{ text: "mine", attachments: [] }]);
  await h.close();
});

test("a dropped receipt fails a message-only turn, requeues the message, and starts no turn for it", async () => {
  const { h, db, runner, id, events, socketLines, idle } = await node("hello", { MEDDLE_FIXTURE_PEER_IGNORE: "1" });
  expect(await runner.message(id, sender, "hi")).toBe("waking");
  await eventually(() => socketLines().length === 1, () => "not written");
  const [line] = socketLines();
  const replyTo = String(line.from).replace(/^uds:/, "");
  await new Promise<void>((resolve, reject) => {
    const c = connect(replyTo, () => c.end(`${JSON.stringify({ type: "control", action: "peer_message_status", orig_msg_id: line.uuid, status: "dropped" })}\n`));
    c.on("close", () => resolve()); c.on("error", reject);
  });
  await eventually(() => events().some((e) => e.subtype === "turn_failed"), () => JSON.stringify(events().map((e) => e.subtype ?? e.type)));
  await idle();
  expect(events().find((e) => e.subtype === "peer_receipt")).toMatchObject({ uuid: line.uuid, status: "dropped" });
  expect(queuedOf(getTask(db, id)!)).toEqual([message("hi")]);
  await Bun.sleep(500);
  expect(events().filter((e) => e.subtype === "turn_started")).toHaveLength(1);
  await h.close();
});

test("a message to an archived task is refused", async () => {
  const { h, db, runner, id } = await node();
  updateTask(db, id, { state: "archived" });
  await expect(runner.message(id, sender, "hi")).rejects.toThrow("task is archived");
  await h.close();
});

test("a task's turn gets messaging: its agent's message reaches another task and wakes it", async () => {
  const seen = new Map<string, Omit<EngineInput, "prompt" | "canUseTool" | "onPermissionDenied">>();
  const { cfg, db, h, runner, id, project, idle } = await node("hello", {}, { engineInput: (taskId, input) => { seen.set(taskId, input); } });
  const other = await createTask({ cfg, db, id: PROJECT_HOME, runner }, { title: "Other", projectIds: [project] });
  await runner.prompt(id, "x");
  await eventually(() => seen.has(id), () => "no engine input");
  await idle();
  const messaging = seen.get(id)!.messaging!;
  expect(messaging.selfId).toBe(id);
  expect((await messaging.directory()).map((e) => e.id).sort()).toEqual([id, other.id].sort());
  expect(await messaging.send(other.id, "hi")).toEqual({ ok: true, how: "waking", title: "Other" });
  await eventually(() => listEvents(db, other.id).some((e) => (e.message as any).subtype === "peer_message"), () => "not delivered");
  expect(listEvents(db, other.id).map((e) => e.message as any).find((e) => e.subtype === "peer_message").from).toMatchObject({ taskId: id, title: "t" });
  await h.close();
});

test("a turn of two messages cut off after Claude Code took one: the rerun writes only the other", async () => {
  const { db, h, runner, reopen, id, events } = await node("hello", { MEDDLE_FIXTURE_STALL: "1" });
  updateTask(db, id, { queued: JSON.stringify([queueEntry(message("one")), queueEntry(message("two"))]) });
  await runner.startQueued(id);
  // Claude Code took the first (its one user step) and holds the second; then meddle stops mid-turn.
  await eventually(() => events().some((e) => e.subtype === "peer_message"), () => "first not taken");
  await h.close();
  const again = await reopen({});
  await eventually(
    () => events().filter((e) => e.subtype === "peer_message").length === 2 && again.runner.state(id) === "idle" && again.runner.liveQuery(id) === null,
    () => JSON.stringify(events().map((e) => e.subtype ?? e.type)), 30_000,
  );
  expect(events().filter((e) => e.subtype === "peer_message").map((e) => e.text)).toEqual(["one", "two"]);
  expect(queuedOf(getTask(db, id)!)).toEqual([]);
  await again.h.close();
}, 60_000);
