// test/train-turn.test.ts — Train turns: the merge train's own turns on a task (describe, rebase, fix) or on its merge
// task (merge). Each runs in `auto` whatever the task's own mode, with meddle's `decline` or `blame` tool, and shows as
// meddle's prompt. The user's prompts meanwhile wait for it, and the task stays queued until one of them runs. The fake
// Claude Code makes no MCP calls, so the tools' handlers are called directly.
import { expect, spyOn, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRegistry } from "@earendil-works/pi-durable";
import { paths } from "../src/config";
import { buildOptions } from "../src/engine/options";
import type { MeddleEvent } from "../src/engine/session";
import { listLineRows } from "../src/pool/rows";
import { DESCRIBE_PROMPT } from "../src/pool/settings";
import { PeerObject } from "../src/state/contracts";
import { listEvents } from "../src/store/events";
import { getTask, queuedOf } from "../src/store/records";
import { CARRY_ON_PROMPT, TaskRunner, type RunnerHooks } from "../src/tasks/durable";
import { openHarness } from "../src/tasks/harness";
import { describePrompt, mergePrompt, mergeTitle, rebasePrompt } from "../src/train/prompts";
import { TRAIN_TOOLS, trainOutcome, trainToolList, trainTools } from "../src/train/tools";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { createTask, replay, setupNode } from "./helpers";
import { peerReady, poolNodes, twoPoolNodes, type GitPoolNode } from "./pool-helpers";

type EngineSeen = Parameters<NonNullable<RunnerHooks["engineInput"]>>[1];

/** Polls `get` until it returns `want`; fails with the last value after `ms` (20 s). */
async function until<T>(what: string, get: () => Promise<T> | T, want: T, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    const got = await get();
    if (JSON.stringify(got) === JSON.stringify(want)) return;
    if (Date.now() > end) throw new Error(`${what} is still ${JSON.stringify(got)}, not ${JSON.stringify(want)}`);
    await Bun.sleep(25);
  }
}

/** Resolves once the task's state goes to running and back to idle. */
function nextIdle(runner: TaskRunner, taskId: string): Promise<void> {
  return new Promise<void>((res) => {
    let ran = false;
    const off = runner.onState((id, s) => {
      if (id !== taskId) return;
      if (s === "running") ran = true;
      else if (s === "idle" && ran) { off(); res(); }
    });
  });
}

/** The task's logged events, as messages. */
const messages = (db: Parameters<typeof listEvents>[0], taskId: string) =>
  listEvents(db, taskId).map((e) => e.message as { type?: string; subtype?: string; [key: string]: unknown });

/** The texts of the user prompts the task's log holds, oldest first. */
const userPrompts = (db: Parameters<typeof listEvents>[0], taskId: string) =>
  messages(db, taskId).filter((m) => m.type === "user").map((m) => (m.message as { content?: unknown }).content);

/** The train's prompts the task's log holds (`train_turn`), oldest first. */
const trainTurns = (db: Parameters<typeof listEvents>[0], taskId: string) =>
  messages(db, taskId).filter((m) => m.type === "meddle" && m.subtype === "train_turn");

const noPrompt = (async function* () {})();
const deny = async () => ({ behavior: "deny" as const, message: "x" });

test("train turns force auto and get meddle's tools; the user's next turn has the task's own mode", async () => {
  const hooks: RunnerHooks = {};
  const node = await setupNode("hello.jsonl", {}, { hooks });
  try {
    const m = await createTask(node, { title: "t", projectIds: [node.project.id] });
    await node.runner.setPermissionMode(m.id, "default");
    const seen: EngineSeen[] = [];
    hooks.engineInput = (id, input) => { if (id === m.id) seen.push(input); };

    expect(await node.runner.trainTurn(m.id, "describe", "Describe it.")).toEqual({ kind: "done" });

    expect(seen).toHaveLength(1);
    const train = seen[0]!;
    expect(train.permissionMode).toBe("auto");
    expect(train.allowedTools).toEqual(["mcp__meddle__decline", "mcp__meddle__blame"]);
    expect(train.extraMcpServers?.meddle).toMatchObject({ type: "sdk", name: "meddle" });
    const options = buildOptions({ ...train, prompt: noPrompt, canUseTool: deny, onPermissionDenied: () => {} });
    expect(options.permissionMode).toBe("auto");
    expect(options.mcpServers?.meddle).toBe(train.extraMcpServers!.meddle!);
    expect(options.allowedTools).toEqual(["mcp__meddle__decline", "mcp__meddle__blame"]);
    // The task's own mode is untouched.
    expect(node.runner.settings(m.id).permissionMode).toBe("default");
    // The train's prompt is logged as meddle's, not as a prompt of the user's.
    expect(trainTurns(node.db, m.id)).toEqual([{ type: "meddle", subtype: "train_turn", kind: "describe", text: "Describe it.", after: expect.any(Number) }]);
    expect(userPrompts(node.db, m.id)).toEqual([]);

    const idle = nextIdle(node.runner, m.id);
    expect(await node.runner.prompt(m.id, "Hello.")).toBe("turn");
    await idle;
    expect(seen).toHaveLength(2);
    expect(seen[1]!.permissionMode).toBe("default");
    expect(seen[1]!.extraMcpServers).toBeUndefined();
    expect(seen[1]!.allowedTools).toBeUndefined();
    const user = buildOptions({ ...seen[1]!, prompt: noPrompt, canUseTool: deny, onPermissionDenied: () => {} });
    expect(user.permissionMode).toBe("default");
    expect(user.mcpServers?.meddle).toBeUndefined();
    expect(user.allowedTools).toBeUndefined();
    expect(userPrompts(node.db, m.id)).toEqual(["Hello."]);
  } finally {
    await node.harness.close();
  }
}, 60_000);

test("the tools record their calls, and a train turn's outcome is read from what it logged", async () => {
  const recorded: MeddleEvent[] = [];
  const record = (e: MeddleEvent) => { recorded.push(e); };
  // `decline` for a task's turns, `blame` for the merge task's.
  for (const kind of ["describe", "rebase", "fix"] as const) expect(trainToolList(kind, record).map((t) => t.name)).toEqual(["decline"]);
  expect(trainToolList("merge", record).map((t) => t.name)).toEqual(["blame"]);
  expect(TRAIN_TOOLS).toEqual(["mcp__meddle__decline", "mcp__meddle__blame"]);
  const server = trainTools("rebase", record);
  expect(server).toMatchObject({ type: "sdk", name: "meddle" });
  expect(server.instance).toBeDefined();

  const [decline] = trainToolList("rebase", record);
  const declined = await decline!.handler({ reason: "the API it fixes is gone" }, {});
  expect(declined.isError).toBeFalsy();
  expect(declined.content[0]).toMatchObject({ type: "text" });
  expect(recorded).toEqual([{ type: "meddle", subtype: "train_decline", reason: "the API it fixes is gone" }]);

  const [blame] = trainToolList("merge", record);
  await blame!.handler({ task: "Fix login", reason: "test/login.test.ts fails: expected 200, got 500" }, {});
  expect(recorded[1]).toEqual({ type: "meddle", subtype: "train_blame", task: "Fix login", reason: "test/login.test.ts fails: expected 200, got 500" });

  const start = [
    { type: "meddle", subtype: "turn_started", at: "", resume: true },
    { type: "meddle", subtype: "train_turn", kind: "rebase", text: rebasePrompt("0123abcd") },
    { type: "system", subtype: "init" },
  ];
  const success = { type: "result", subtype: "success", is_error: false };
  expect(trainOutcome([...start, recorded[0], success])).toEqual({ kind: "declined", reason: "the API it fixes is gone" });
  expect(trainOutcome([...start, recorded[1], success])).toEqual({ kind: "blamed", task: "Fix login", reason: "test/login.test.ts fails: expected 200, got 500" });
  expect(trainOutcome([...start, success])).toEqual({ kind: "done" });
  // A turn that ended with an error, or failed, or was aborted, failed; a decline before that still stands.
  expect(trainOutcome([...start, { type: "result", subtype: "error_max_turns", is_error: true }])).toEqual({ kind: "failed", reason: "the turn ended with error_max_turns" });
  expect(trainOutcome([{ type: "meddle", subtype: "turn_failed", at: "", error: "Error: no usable token" }])).toEqual({ kind: "failed", reason: "no usable token" });
  expect(trainOutcome([...start, { type: "meddle", subtype: "turn_aborted", at: "" }])).toEqual({ kind: "failed", reason: "the turn was aborted" });
  expect(trainOutcome([...start, recorded[0], { type: "meddle", subtype: "turn_failed", at: "", error: "Error: boom" }])).toEqual({ kind: "declined", reason: "the API it fixes is gone" });
  expect(trainOutcome([...start])).toEqual({ kind: "failed", reason: "the turn ended without a result" });
  // A rerun after a restart carries on: the cut-off attempt's abort is not how the turn ended.
  const rerun = [{ type: "meddle", subtype: "turn_started", at: "", resume: true }, { type: "meddle", subtype: "train_turn", kind: "rebase", text: CARRY_ON_PROMPT }];
  expect(trainOutcome([...start, { type: "meddle", subtype: "turn_aborted", at: "" }, ...rerun, success])).toEqual({ kind: "done" });
  // A token fault that reruns the turn is not its end; one that does not is.
  const fault = { type: "meddle", subtype: "token_fault", at: "", tokenId: "t1", label: "work", fault: { kind: "exhausted", until: null, type: null } };
  expect(trainOutcome([...start, { type: "result", subtype: "error_during_execution", is_error: true }, { ...fault, rerun: true }, ...rerun, success])).toEqual({ kind: "done" });
  expect(trainOutcome([...start, { type: "result", subtype: "error_during_execution", is_error: true }, { ...fault, rerun: false }])).toEqual({ kind: "failed", reason: "token work exhausted; no other token" });
});

/** Gives the task work to land: a file in its workspace, written to the line's row. */
async function withWork(node: GitPoolNode, taskId: string): Promise<void> {
  await writeFile(join(paths(node.cfg).task(taskId), "a", "work"), "a\n");
  await node.runner.writeTaskLines(taskId);
}

test("prompts sent during a train turn wait for it: queued, not steered; the task stays queued until one runs", async () => {
  const { nodes, close } = await poolNodes(1, { nodes: [{ extraEnv: { MEDDLE_FIXTURE_RESULTS_MS: "3000" } }] });
  const A = nodes[0]!;
  try {
    const m = await createTask(A, { title: "t", projectIds: [A.project.id] });
    await withWork(A, m.id);
    await A.runner.accept(m.id);
    const accepted = A.runner.queue(m.id);
    expect(accepted).not.toBeNull();
    const left: string[] = [];
    A.runner.onQueue((id, queue, reason) => { if (id === m.id && queue === null) left.push(String(reason)); });

    const outcome = A.runner.trainTurn(m.id, "describe", describePrompt(DESCRIBE_PROMPT, []));
    // Sent while the train's turn is pending: it waits.
    expect(await A.runner.prompt(m.id, "First.")).toBe("queued");
    await until("the train's live turn", () => A.runner.liveQuery(m.id) !== null, true);
    // Sent while it runs: it waits too, rather than going into the train's turn.
    expect(await A.runner.prompt(m.id, "Second.")).toBe("queued");
    const waiting = [{ text: "First.", attachments: [] }, { text: "Second.", attachments: [] }];
    expect(queuedOf(getTask(A.db, m.id)!)).toEqual(waiting);
    expect(A.runner.queued(m.id)).toEqual(waiting);
    // Send now has no effect on the train's turn.
    expect(await A.runner.sendNow(m.id)).toBe("nothing_waiting");
    // Asked again for the same kind, the train joins the turn running; another kind waits its turn.
    const joined = A.runner.trainTurn(m.id, "describe", "Asked again.");
    await expect(A.runner.trainTurn(m.id, "rebase", rebasePrompt("0123abcd"))).rejects.toThrow("task is running");
    // A mode the user picks is kept for their turns, and does not reach the train's.
    const live = spyOn(A.runner.liveQuery(m.id)!, "setPermissionMode");
    await A.runner.setPermissionMode(m.id, "plan");
    expect(live).not.toHaveBeenCalled();
    expect(A.runner.settings(m.id).permissionMode).toBe("plan");
    // Nothing of the user's has run: the task is still queued.
    expect(A.runner.queue(m.id)).toEqual(accepted);
    expect(userPrompts(A.db, m.id)).toEqual([]);

    expect(await outcome).toEqual({ kind: "done" });
    expect(await joined).toEqual({ kind: "done" });
    expect(trainTurns(A.db, m.id).map((e) => e.text)).toEqual([describePrompt(DESCRIBE_PROMPT, [])]);
    // Then they run, one turn each, after the train's: the first to start takes the task off the queue.
    await until("the user's prompts", () => userPrompts(A.db, m.id), ["First.", "Second."], 30_000);
    await until("the state", () => A.runner.state(m.id), "idle", 30_000);
    const log = messages(A.db, m.id);
    const trainEnd = log.findIndex((e) => e.type === "result");
    const first = log.findIndex((e) => e.type === "user");
    expect(trainEnd).toBeGreaterThan(log.findIndex((e) => e.subtype === "train_turn"));
    expect(first).toBeGreaterThan(trainEnd);
    expect(A.runner.queue(m.id)).toBeNull();
    expect(left).toEqual(["you sent it a prompt"]);
  } finally {
    await close();
  }
}, 90_000);

/** One task of node A's project, with work, accepted; and the tools its train turns' `meddle` server gets, as wired. */
async function acceptedTask(A: GitPoolNode) {
  const P = A.project;
  const m = await createTask(A, { title: "t", projectIds: [P.id] });
  await withWork(A, m.id);
  await A.runner.accept(m.id);
  let tools: SdkMcpToolDefinition<any>[] | undefined;
  A.hooks.trainTools = (id, wired) => { if (id === m.id) tools = wired; };
  const queuedAt = () => listLineRows(A.db, P.id, m.id).find((r) => r.name === "a")?.queuedAt ?? null;
  const left: string[] = [];
  A.runner.onQueue((id, queue, reason) => { if (id === m.id && queue === null) left.push(String(reason)); });
  /** Calls the `decline` of the train turn now running, as its agent would. */
  const decline = async (reason: string) => {
    await until("the train's tools", () => tools !== undefined, true);
    await tools!.find((t) => t.name === "decline")!.handler({ reason }, {});
  };
  return { m, queuedAt, left, decline };
}

test("a decline takes the task off its queue as it is logged, with no call waiting; asked again, the train hears it and prompts no one", async () => {
  const { nodes, close } = await poolNodes(1, { nodes: [{ extraEnv: { MEDDLE_FIXTURE_RESULTS_MS: "3000" } }] });
  const A = nodes[0]!;
  try {
    const { m, queuedAt, left, decline } = await acceptedTask(A);
    expect(queuedAt()).not.toBeNull();
    // The call that starts the turn is dropped, as one cut off by a restart (or a lost link) would be.
    void A.runner.trainTurn(m.id, "rebase", rebasePrompt("0123abcd"));
    await until("the train's live turn", () => A.runner.liveQuery(m.id) !== null, true);
    await decline("the API it fixes is gone");
    // The turn still runs, so no call has heard how it went: the decline itself took the task off.
    expect(A.runner.liveQuery(m.id)).not.toBeNull();
    expect(queuedAt()).toBeNull();
    expect(A.runner.queue(m.id)).toBeNull();
    expect(left).toEqual(["the API it fixes is gone"]);
    expect(messages(A.db, m.id).filter((e) => e.subtype === "train_decline")).toEqual([
      { type: "meddle", subtype: "train_decline", reason: "the API it fixes is gone" },
    ]);
    await until("the state", () => A.runner.state(m.id), "idle", 30_000);

    // Asked again for that turn, the train is told of the decline; the agent is not prompted again.
    const turns = () => messages(A.db, m.id).filter((e) => e.subtype === "turn_started").length;
    expect(turns()).toBe(1);
    expect(await A.runner.trainTurn(m.id, "rebase", rebasePrompt("0123abcd"))).toEqual({ kind: "declined", reason: "the API it fixes is gone" });
    expect(turns()).toBe(1);
    expect(trainTurns(A.db, m.id)).toHaveLength(1);
    expect(left).toEqual(["the API it fixes is gone"]);
    // Accepted again, the task is the train's again: it asks afresh.
    await A.runner.accept(m.id);
    expect(await A.runner.trainTurn(m.id, "rebase", rebasePrompt("4567cdef"))).toEqual({ kind: "done" });
    expect(trainTurns(A.db, m.id).map((e) => e.text)).toEqual([rebasePrompt("0123abcd"), rebasePrompt("4567cdef")]);
    expect(queuedAt()).not.toBeNull();
  } finally {
    await close();
  }
}, 90_000);

test("the agent's reason stands however the turn's end, the calls that join it and a prompt that waited fall", async () => {
  const { nodes, close } = await poolNodes(1, { nodes: [{ extraEnv: { MEDDLE_FIXTURE_RESULTS_MS: "3000" } }] });
  const A = nodes[0]!;
  try {
    const { m, queuedAt, left, decline } = await acceptedTask(A);
    const outcome = A.runner.trainTurn(m.id, "rebase", rebasePrompt("0123abcd"));
    await until("the train's live turn", () => A.runner.liveQuery(m.id) !== null, true);
    // A call joins before the decline; a prompt sent meanwhile waits for the turn, which ends with it waiting.
    const before = A.runner.trainTurn(m.id, "rebase", rebasePrompt("0123abcd"));
    expect(await A.runner.prompt(m.id, "Meanwhile.")).toBe("queued");
    await decline("the API it fixes is gone");
    expect(left).toEqual(["the API it fixes is gone"]);
    // A call that joins after the decline hears it too.
    const after = A.runner.trainTurn(m.id, "rebase", rebasePrompt("0123abcd"));

    for (const call of [outcome, before, after]) expect(await call).toEqual({ kind: "declined", reason: "the API it fixes is gone" });
    expect(queuedAt()).toBeNull();
    expect(A.runner.queue(m.id)).toBeNull();
    // The prompt that waited runs next; its start found the task off the queue already, so the reason stands, told once.
    await until("the user's prompt", () => userPrompts(A.db, m.id), ["Meanwhile."], 30_000);
    await until("the state", () => A.runner.state(m.id), "idle", 30_000);
    expect(left).toEqual(["the API it fixes is gone"]);
    expect(trainTurns(A.db, m.id)).toHaveLength(1);
  } finally {
    await close();
  }
}, 90_000);

test("the prompts match the spec copy", () => {
  expect(describePrompt(DESCRIBE_PROMPT, [])).toBe("Before your work lands on main: Add a description (4-7 words) to your revision(s).");
  expect(describePrompt(DESCRIBE_PROMPT, ["kxqzlmno"])).toBe(
    "Before your work lands on main: resolve the conflicts in kxqzlmno, then Add a description (4-7 words) to your revision(s).",
  );
  expect(describePrompt("Describe your work.", ["kxqzlmno", "vnnpplvq", "wtsoyrmz"])).toBe(
    "Before your work lands on main: resolve the conflicts in kxqzlmno, vnnpplvq and wtsoyrmz, then Describe your work.",
  );
  const rebase =
    "main moved on, and your work no longer merges cleanly with it. Rebase onto main (0123abcd), fix the conflicts, run the tests your changes affect (not the full suite), and keep each revision described. If your change no longer makes sense on main, because something it relies on is gone or has changed meaning, call decline with the reason.";
  expect(rebasePrompt("0123abcd")).toBe(rebase);
  // The fix turn opens with what the merge agent reported.
  expect(rebasePrompt("0123abcd", "test/login.test.ts fails: expected 200, got 500")).toBe(
    `The merge agent that checked your work together with other tasks on main reported: test/login.test.ts fails: expected 200, got 500\n\n${rebase}`,
  );
  expect(mergePrompt(["Fix login", "Add search"], "vnnpplvq", DESCRIBE_PROMPT)).toBe(
    "Check that Fix login and Add search work together on main. Merged cleanly as vnnpplvq. Run the typecheck and the tests that cover what they change; don't run the full suite, and don't change any files. If a test fails, call blame with the task responsible and what failed. Otherwise: Add a description (4-7 words) to your revision(s).",
  );
  expect(mergePrompt(["A", "B", "C"], "vnnpplvq", "Describe it.")).toStartWith("Check that A, B and C work together on main.");
  expect(mergeTitle(["Fix login", "Add search"])).toBe("Merge Fix login, Add search");
});

test("trainTurn runs on another node, through PeerObject.trainTurn", async () => {
  const { A, B, close } = await twoPoolNodes();
  try {
    const m = await createTask(B, { title: "t", projectIds: [B.project.id] });
    await peerReady(A, B);
    const peer = await A.pool.peerRef(B.id, PeerObject);
    try {
      if (peer.variant !== "peer") throw new Error("not the peer variant");
      const text = rebasePrompt("0123abcd");
      expect(await peer.trainTurn({ taskId: m.id, kind: "rebase", text })).toEqual({ kind: "done" });
      expect(trainTurns(B.db, m.id)).toEqual([{ type: "meddle", subtype: "train_turn", kind: "rebase", text, after: expect.any(Number) }]);
      expect(B.runner.state(m.id)).toBe("idle");
      // A task the node does not have is refused, as any call on it would be.
      await expect(peer.trainTurn({ taskId: "nope", kind: "describe", text })).rejects.toThrow("unknown task");
    } finally {
      peer.release();
    }
  } finally {
    await close();
  }
}, 90_000);

test("a train turn cut off by a restart: asking again joins its rerun, whose outcome counts what came before", async () => {
  let tools: SdkMcpToolDefinition<any>[] | undefined;
  const node = await setupNode("hello.jsonl", { MEDDLE_FIXTURE_STALL: "1" }, { hooks: { trainTools: (_id, wired) => { tools = wired; } } });
  const { cfg, db } = node;
  const m = await createTask(node, { title: "t", projectIds: [node.project.id] });
  const initialised = new Promise<void>((res) => node.runner.onEvent((id, _s, msg: { type?: string; subtype?: string }) => {
    if (id === m.id && msg.type === "system" && msg.subtype === "init") res();
  }));
  // The first process stalls before the result; the agent declines; then the process goes.
  void node.runner.trainTurn(m.id, "rebase", rebasePrompt("0123abcd")).catch(() => {});
  await initialised;
  await tools!.find((t) => t.name === "decline")!.handler({ reason: "the API it fixes is gone" }, {});
  await node.harness.close();

  // A fresh process holds its Harness until asked again, so the rerun cannot finish first.
  const h = await openHarness(cfg, createRegistry(), { hold: true });
  const seen: EngineSeen[] = [];
  const runner = new TaskRunner(cfg, db, h.harness, {
    claudePath: replay, claudeRuntime: "bun",
    extraEnv: { MEDDLE_FIXTURE: `${import.meta.dir}/fixtures/hello.jsonl` },
    hooks: { engineInput: (id, input) => { if (id === m.id) seen.push(input); } },
  });
  try {
    const again = runner.trainTurn(m.id, "rebase", rebasePrompt("0123abcd"));
    await Bun.sleep(100);
    runner.resumeHarness();
    expect(await again).toEqual({ kind: "declined", reason: "the API it fixes is gone" });
    // One train turn, run twice: no second turn started for the second call; the rerun was the train's too.
    expect(messages(db, m.id).filter((e) => e.subtype === "turn_started")).toHaveLength(2);
    expect(trainTurns(db, m.id).map((e) => e.text)).toEqual([rebasePrompt("0123abcd"), CARRY_ON_PROMPT]);
    expect(seen.map((s) => s.permissionMode)).toEqual(["auto"]);
    expect(runner.state(m.id)).toBe("idle");
  } finally {
    await h.close();
  }
}, 60_000);
