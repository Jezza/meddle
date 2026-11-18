// test/state.test.ts
import { test, expect } from "bun:test";
import { NodeObject, ProjectObject, TaskObject, SessionObject } from "../src/state/host";
import { claudeCodeVersion } from "../src/version";
import { appendEvent, listEvents } from "../src/store/events";
import { errorResultFixture, sideAssistantsFixture } from "./helpers";
import { linkClient, peerReady, startPoolNode, storedShot, twoPoolNodes } from "./pool-helpers";
import { repoKey, serialised } from "../src/serial";
import { getTask } from "../src/store/records";
import { getProject, setDefaultBranch } from "../src/projects/project";
import { readManifest } from "../src/tasks/manifest";
import { createHash } from "node:crypto";
import { remoteReason } from "../src/pool/object";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { paths, type NodeConfig } from "../src/config";
import { jj } from "../src/jj";
import { syncMemoryAfter, syncMemoryBefore } from "../src/projects/memory-sync";
import { ensureServiceRepo } from "../src/projects/replicas";
import { listTokens } from "../src/token";

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

/** A node host (with its pool) for `fixture`, and a client host connected to it over a memory link. */
async function connect(fixture?: string) {
  const node = await startPoolNode(fixture);
  const { client, close: closeClient } = linkClient(node.host);
  const close = async () => {
    await closeClient();
    await node.close();
  };
  return { ...node, client, close };
}

test("claudeCodeVersion reads the pinned SDK's manifest", () => {
  expect(claudeCodeVersion()).toBe("2.1.314");
});

test("a client follows a task through a prompted turn over a link", async () => {
  const { client, metrics, project, db, close } = await connect();
  try {
    const node = await client.get(NodeObject, {});
    expect(node.projectIds.value).toContain(project.id);
    const token = listTokens(db)[0]!;
    // No turn has used the token yet: it is the active one, with no reading.
    expect(node.activeUsage.value).toEqual({ tokenId: token.id, label: token.label, reading: null });
    expect(node.tokenUsage.value).toEqual({});
    expect(node.metrics.value).toBeNull();
    metrics.start();
    await until(node.metrics, (m) => m !== null);
    metrics.stop();
    expect(node.claudeCodeVersion.value).toBe("2.1.314");
    expect(node.token.value.present).toBe(true);

    const { manifest } = await node.createTask({ title: "t", projects: [{ id: project.id }] });
    await until(node.taskIds, (ids) => ids.includes(manifest.id));

    const task = await client.get(TaskObject, { id: manifest.id });
    const session = await client.get(SessionObject, { taskId: manifest.id });
    expect(task.manifest.value.title).toBe("t");
    const states: string[] = [];
    task.state.subscribe((s) => { if (states.at(-1) !== s) states.push(s); });

    await task.prompt({ text: "Reply with the single word ok." });
    await until(task.state, () => states.join(" ") === "idle running idle");
    await until(session.window, (w) => (w.at(-1)?.message as { type?: string } | undefined)?.type === "result");

    expect(states).toEqual(["idle", "running", "idle"]);
    expect(session.window.value.some((e) => (e.message as { type?: string }).type === "stream_event")).toBe(false);
    expect(session.fromSeq.value).toBe(session.window.value[0]!.seq);
    expect(session.live.value).toBeNull();
    await until(task.contextUsage, (u) => u !== null);
    expect(task.contextUsage.value).toMatchObject({ usage: { input_tokens: 376 } });
    await until(task.context, (c) => c !== null);
    expect(task.context.value).toEqual({ tokens: 376, model: "claude-haiku-5-5" });
    // The turn's rate_limit_event (hello.jsonl: 27% of five hours, 33% of seven days) is the token's reading.
    const usage = await until(node.activeUsage, (u) => u?.reading != null);
    const read = { fiveHour: { utilization: 0.27 }, sevenDay: { utilization: 0.33 } };
    expect(usage).toMatchObject({ tokenId: token.id, label: token.label, reading: read });
    expect(node.tokenUsage.value[token.id]).toMatchObject(read);
    expect(task.permissionMode.value).toBe("auto");
    // none chosen: the pool's default, not the turn's
    expect(task.model.value).toBeNull();
    expect(task.lastSeq.value).toBe(session.window.value.at(-1)!.seq);
    expect(task.pending.value).toEqual([]);
    // the recorded initialize response carries the model list
    await until(node.models, (models) => models.length > 0);
    // Claude Code's own default is left out: the pool's is the one shown
    expect(node.models.value.map((m) => m.value)).toEqual(["sonnet", "fable", "opus", "haiku"]);
    expect(node.models.value[2]).toMatchObject({ resolvedModel: "claude-opus-5-5", displayName: "Opus", efforts: ["low", "medium", "high", "xhigh", "max"] });

    const earlier = await session.loadEarlier({ beforeSeq: session.window.value.at(-1)!.seq, limit: 2 });
    expect(earlier.map((e) => e.seq)).toEqual(session.window.value.slice(-3, -1).map((e) => e.seq));

    const notes = await until(node.notifications, (n) => n.some((x) => x.taskId === manifest.id && x.kind === "finished"));
    await node.dismiss({ id: notes.find((x) => x.kind === "finished")!.id });
    await until(node.notifications, (n) => !n.some((x) => x.kind === "finished"));
    expect(node.taskIds.value).toContain(manifest.id);

    await task.setEffort({ effort: "low" });
    await until(task.effort, (e) => e === "low");
    task.release();
    session.release();
    node.release();
  } finally {
    await close();
  }
});

test("a turn's subagent and synthetic messages leave the task's context at its main thread's", async () => {
  const { client, project, close } = await connect(await sideAssistantsFixture());
  try {
    const node = await client.get(NodeObject, {});
    const { manifest } = await node.createTask({ title: "t", projects: [{ id: project.id }] });
    const task = await client.get(TaskObject, { id: manifest.id });
    await task.prompt({ text: "Reply with the single word ok." });
    await until(task.contextUsage, (u) => u !== null);
    expect(task.context.value).toEqual({ tokens: 376, model: "claude-haiku-5-5" });
    task.release();
    node.release();
  } finally {
    await close();
  }
});

test("a plan-usage reading that cannot be written does not fail the turn", async () => {
  const { client, project, db, close } = await connect();
  try {
    // Every write of a reading fails (as a busy or full database would); reading them still works.
    db.run("CREATE TRIGGER no_usage BEFORE INSERT ON token_usage BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    const node = await client.get(NodeObject, {});
    const { manifest } = await node.createTask({ title: "t", projects: [{ id: project.id }] });
    const task = await client.get(TaskObject, { id: manifest.id });
    await task.prompt({ text: "Reply with the single word ok." });
    const notes = await until(node.notifications, (n) => n.some((x) => x.taskId === manifest.id && x.kind !== "approval"));
    expect(notes.filter((x) => x.taskId === manifest.id).map((x) => x.kind)).toEqual(["finished"]);
    task.release();
    node.release();
  } finally {
    await close();
  }
});

test("a model chosen for an idle task shows at once, for every client, and its unset is the pool's default", async () => {
  const { client, project, close } = await connect();
  try {
    const node = await client.get(NodeObject, {});
    const { manifest } = await node.createTask({ title: "t", projects: [{ id: project.id }], model: "fable", effort: "high" });
    const task = await client.get(TaskObject, { id: manifest.id });
    const other = await client.get(TaskObject, { id: manifest.id });
    expect(task.model.value).toBe("fable");
    expect(task.effort.value).toBe("high");
    await task.setModel({ model: "opus" });
    await until(task.model, (m) => m === "opus");
    await until(other.model, (m) => m === "opus");
    await task.setModel({});
    await until(task.model, (m) => m === null);
    task.release();
    other.release();
    node.release();
  } finally {
    await close();
  }
});

test("renaming a task updates its manifest for every client, its row and its folder's manifest", async () => {
  const { client, project, cfg, db, close } = await connect();
  try {
    const node = await client.get(NodeObject, {});
    const { manifest } = await node.createTask({ title: "before", projects: [{ id: project.id }] });
    const task = await client.get(TaskObject, { id: manifest.id });
    const other = await client.get(TaskObject, { id: manifest.id });
    expect(task.activityAt.value).not.toBe("");
    await task.rename({ title: "  after  " });
    await until(task.manifest, (m) => m.title === "after");
    await until(other.manifest, (m) => m.title === "after");
    expect(getTask(db, manifest.id)!.title).toBe("after");
    expect((await readManifest(cfg, manifest.id)).title).toBe("after");
    await expect(task.rename({ title: "   " })).rejects.toThrow("a task's title cannot be blank");
    task.release();
    other.release();
    node.release();
  } finally {
    await close();
  }
});

test("a client sees a pending approval, and approving it lets the turn finish", async () => {
  const { client, project, close } = await connect("approval.jsonl");
  try {
    const node = await client.get(NodeObject, {});
    const { manifest } = await node.createTask({ title: "t", projects: [{ id: project.id }] });
    const task = await client.get(TaskObject, { id: manifest.id });

    await task.prompt({ text: "Run: echo hi" });
    const [pending] = await until(task.pending, (p) => p.length === 1);
    expect(pending!.toolName).toBe("Bash");
    await until(task.state, (s) => s === "waiting");
    await until(node.notifications, (n) => n.some((x) => x.kind === "approval" && x.taskId === manifest.id));
    await expect(task.approve({ requestId: "nope" })).rejects.toThrow("no pending request nope");

    await task.approve({ requestId: pending!.requestId });
    await until(task.pending, (p) => p.length === 0);
    await until(task.state, (s) => s === "idle");
    task.release();
    node.release();
  } finally {
    await close();
  }
});

test("a client sees what a busy task was sent and has not started on as queued", async () => {
  // the turn stalls before its result, so Claude Code takes nothing sent meanwhile
  const node0 = await startPoolNode("hello.jsonl", { MEDDLE_FIXTURE_STALL: "1" });
  const { client, close: closeClient } = linkClient(node0.host);
  try {
    const node = await client.get(NodeObject, {});
    const { manifest } = await node.createTask({ title: "t", projects: [{ id: node0.project.id }] });
    const task = await client.get(TaskObject, { id: manifest.id });
    const session = await client.get(SessionObject, { taskId: manifest.id });
    expect(task.queued.value).toEqual([]);
    await task.prompt({ text: "Reply with the single word ok." });
    await until(session.window, (w) => w.some((e) => (e.message as { type?: string; subtype?: string }).subtype === "init"));
    await task.prompt({ text: "Also say why." });
    await task.prompt({ text: "And keep it short." });
    expect((await until(task.queued, (q) => q.length === 2))).toEqual(["Also say why.", "And keep it short."]);
    task.release();
    session.release();
    node.release();
  } finally {
    await closeClient();
    await node0.close();
  }
});

test("a prompt with only an attachment is taken; a blank one with none is refused", async () => {
  const connected = await connect();
  const { client, project, close } = connected;
  try {
    const node = await client.get(NodeObject, {});
    const { manifest } = await node.createTask({ title: "t", projects: [{ id: project.id }] });
    const task = await client.get(TaskObject, { id: manifest.id });
    const session = await client.get(SessionObject, { taskId: manifest.id });
    const shot = await storedShot(connected);
    await expect(task.prompt({ text: "  " })).rejects.toThrow("a prompt needs text or an attachment");
    expect(await task.prompt({ text: "", attachments: [shot] })).toEqual({ queued: false });
    const window = await until(session.window, (w) => w.some((e) => (e.message as { type?: string }).type === "result"));
    expect(window.filter((e) => (e.message as { type?: string }).type === "user").map((e) => e.message))
      .toEqual([expect.objectContaining({ message: { role: "user", content: "" }, attachments: [shot] })]);
    task.release();
    session.release();
    node.release();
  } finally {
    await close();
  }
});

test("queuedPrompts shows a queued prompt's attachments; queued its text", async () => {
  const connected = await connect();
  const { client, project, runner, close } = connected;
  try {
    const node = await client.get(NodeObject, {});
    const { manifest } = await node.createTask({ title: "t", projects: [{ id: project.id }] });
    const task = await client.get(TaskObject, { id: manifest.id });
    const shot = await storedShot(connected);
    expect(task.queuedPrompts.value).toEqual([]);
    // A pool update's hold on new turns: the prompt waits for the next.
    runner.setHolds({ turns: "held", work: null, hosting: null });
    expect(await task.prompt({ text: "look", attachments: [shot] })).toEqual({ queued: true });
    await until(task.queuedPrompts, (q) => q.length === 1);
    await until(task.queued, (q) => q.length === 1);
    expect(task.queued.value).toEqual(["look"]);
    expect(task.queuedPrompts.value).toEqual([{ text: "look", attachments: [shot] }]);
    task.release();
    node.release();
  } finally {
    await close();
  }
});

test("a new task's first prompt is sent with only attachments, keeping its made-up title, and not when blank with none", async () => {
  const connected = await connect();
  const { client, project, db, close } = connected;
  try {
    const node = await client.get(NodeObject, {});
    const shot = await storedShot(connected);
    const blank = await node.createTask({ projects: [{ id: project.id }], prompt: "  " });
    const { manifest } = await node.createTask({ projects: [{ id: project.id }], prompt: "", attachments: [shot] });
    const session = await client.get(SessionObject, { taskId: manifest.id });
    const window = await until(session.window, (w) => w.some((e) => (e.message as { type?: string }).type === "result"));
    expect(window.filter((e) => (e.message as { type?: string }).type === "user").map((e) => e.message))
      .toEqual([expect.objectContaining({ message: { role: "user", content: "" }, attachments: [shot] })]);
    // A blank text names nothing: the made-up title stays.
    expect(manifest.title).toMatch(/^[a-z]+ [a-z]+ [a-z]+$/);
    expect(getTask(db, manifest.id)?.title).toBe(manifest.title);
    // Blank with nothing attached: no turn, the task idle and its log empty.
    expect(getTask(db, blank.manifest.id)?.state).toBe("idle");
    expect(listEvents(db, blank.manifest.id)).toEqual([]);
    session.release();
    node.release();
  } finally {
    await close();
  }
});

test("a session keeps stream deltas out of its window and in live until the next event", async () => {
  const { client, host, db, project, close } = await connect();
  try {
    const node = await client.get(NodeObject, {});
    const { id } = (await node.createTask({ title: "t", projects: [{ id: project.id }] })).manifest;
    const delta = (type: string, field: string, value: string) =>
      ({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type, [field]: value } } });
    appendEvent(db, id, { type: "system", subtype: "init", permissionMode: "default", model: "m" });
    appendEvent(db, id, delta("thinking_delta", "thinking", "hm"));
    appendEvent(db, id, delta("text_delta", "text", "Hel"));
    appendEvent(db, id, delta("text_delta", "text", "lo"));

    const session = await client.get(SessionObject, { taskId: id });
    expect(session.window.value.map((e) => e.seq)).toEqual([1]);
    expect(session.fromSeq.value).toBe(1);
    expect(session.live.value).toEqual({ text: "Hello", thinking: "hm" });
    session.release();

    // the node's own reference is another principal's object, so it reads the log afresh
    appendEvent(db, id, { type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } });
    const again = await host.get(SessionObject, { taskId: id });
    expect(again.window.value.map((e) => e.seq)).toEqual([1, 5]);
    expect(again.live.value).toBeNull();
    expect(await again.loadEarlier({ beforeSeq: 5, limit: 10 })).toEqual([again.window.value[0]!]);
    again.release();
    node.release();
  } finally {
    await close();
  }
});

test("a session's live says which block streams, a thinking block with no text and a tool call's name among them", async () => {
  const { client, host, db, project, close } = await connect();
  try {
    const node = await client.get(NodeObject, {});
    const { id } = (await node.createTask({ title: "t", projects: [{ id: project.id }] })).manifest;
    const start = (block: Record<string, unknown>) => ({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: block } });
    appendEvent(db, id, { type: "system", subtype: "init", permissionMode: "default", model: "m" });
    appendEvent(db, id, start({ type: "thinking", thinking: "" }));
    const session = await client.get(SessionObject, { taskId: id });
    expect(session.live.value).toEqual({ text: "", thinking: "", block: "thinking" });

    appendEvent(db, id, { type: "assistant", message: { content: [{ type: "thinking", thinking: "" }] } });
    appendEvent(db, id, start({ type: "text", text: "" }));
    appendEvent(db, id, { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me look." } } });
    appendEvent(db, id, start({ type: "tool_use", id: "t1", name: "Bash", input: {} }));
    session.release();
    // the node's own reference is another principal's object, so it reads the log afresh
    const again = await host.get(SessionObject, { taskId: id });
    expect(again.live.value).toEqual({ text: "Let me look.", thinking: "", block: "tool_use", tool: "Bash" });
    again.release();
    node.release();
  } finally {
    await close();
  }
});

test("a turn whose result is an error is notified as failed", async () => {
  const { client, project, close } = await connect(await errorResultFixture("error_max_turns"));
  try {
    const node = await client.get(NodeObject, {});
    const { manifest } = await node.createTask({ title: "t", projects: [{ id: project.id }] });
    const task = await client.get(TaskObject, { id: manifest.id });
    await task.prompt({ text: "Reply with the single word ok." });
    const notes = await until(node.notifications, (n) => n.some((x) => x.taskId === manifest.id && x.kind === "failed"));
    expect(notes.filter((x) => x.taskId === manifest.id).map(({ kind, text }) => ({ kind, text }))).toEqual([{ kind: "failed", text: "Turn ended: error_max_turns" }]);
    await until(task.state, (s) => s === "idle");
    task.release();
    node.release();
  } finally {
    await close();
  }
});

test("a task's activation reads its log summary from the newest events, and its session from the log's tail", async () => {
  const { client, db, project, close } = await connect();
  try {
    const node = await client.get(NodeObject, {});
    const { id } = (await node.createTask({ title: "t", projects: [{ id: project.id }] })).manifest;
    appendEvent(db, id, { type: "system", subtype: "init", permissionMode: "default", model: "old" });
    appendEvent(db, id, { type: "result", subtype: "success", usage: { input_tokens: 1 } });
    appendEvent(db, id, { type: "system", subtype: "init", permissionMode: "auto", model: "new" });
    appendEvent(db, id, { type: "system", subtype: "status", permissionMode: "plan" });
    // A later status without a mode (a compaction notice) must not hide the mode change.
    appendEvent(db, id, { type: "system", subtype: "status", status: "compacting" });
    // The context is the newest main-thread call's: not a subagent's, nor a synthetic message's, nor one without usage.
    appendEvent(db, id, {
      type: "assistant", parent_tool_use_id: null,
      message: { model: "claude-opus-5-5", usage: { input_tokens: 2, cache_read_input_tokens: 1000, cache_creation_input_tokens: 10 } },
    });
    appendEvent(db, id, { type: "assistant", parent_tool_use_id: "tu1", message: { model: "claude-haiku-5-5", usage: { input_tokens: 5 } } });
    appendEvent(db, id, { type: "assistant", parent_tool_use_id: null, message: { model: "<synthetic>", usage: { input_tokens: 0 } } });
    for (let i = 0; i < 246; i++) appendEvent(db, id, { type: "assistant", n: i });
    appendEvent(db, id, { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } } });
    const task = await client.get(TaskObject, { id });
    expect(task.lastSeq.value).toBe(255);
    expect(task.permissionMode.value).toBe("plan");
    expect(task.contextUsage.value).toMatchObject({ usage: { input_tokens: 1 } });
    expect(task.context.value).toEqual({ tokens: 1012, model: "claude-opus-5-5" });
    const session = await client.get(SessionObject, { taskId: id });
    expect(session.window.value).toHaveLength(200);
    expect(session.window.value.at(-1)!.seq).toBe(254);
    expect(session.live.value).toEqual({ text: "x", thinking: "" });
    expect((await session.loadEarlier({ beforeSeq: session.fromSeq.value, limit: 3 })).map((e) => e.seq)).toEqual([52, 53, 54]);
    task.release();
    session.release();
    node.release();
  } finally {
    await close();
  }
});

test("a task's agents come from its log, and one left running with no live turn shows stopped", async () => {
  const { client, db, project, close } = await connect();
  try {
    const node = await client.get(NodeObject, {});
    const { id } = (await node.createTask({ title: "t", projects: [{ id: project.id }] })).manifest;
    appendEvent(db, id, { type: "meddle", subtype: "turn_started", at: "2026-11-17T19:00:00.000Z", resume: false });
    appendEvent(db, id, { type: "system", subtype: "task_started", task_id: "a1", tool_use_id: "tA", task_type: "local_agent", is_backgrounded: true, description: "Implement Task 3" });
    appendEvent(db, id, { type: "system", subtype: "task_started", task_id: "a2", tool_use_id: "tB", task_type: "local_agent", is_backgrounded: true, description: "Review Task 2" });
    appendEvent(db, id, { type: "system", subtype: "task_notification", task_id: "a2", tool_use_id: "tB", status: "completed", summary: "" });
    for (let i = 0; i < 300; i++) appendEvent(db, id, { type: "stream_event", event: {} });
    const task = await client.get(TaskObject, { id });
    expect(task.agents.value.map((a) => [a.id, a.state, a.orphaned]).sort()).toEqual([["a1", "stopped", true], ["a2", "completed", false]]);
    expect(task.agentsRunning.value).toBe(0);
    task.release();
    node.release();
  } finally {
    await close();
  }
});

/** A node whose turns replay `background-agent.jsonl` (a background agent, its step, then its notice), with `env`. */
async function agentNode(env: Record<string, string>) {
  const node0 = await startPoolNode("background-agent.jsonl", env);
  const { client, close: closeClient } = linkClient(node0.host);
  const node = await client.get(NodeObject, {});
  const { manifest } = await node.createTask({ title: "t", projects: [{ id: node0.project.id }] });
  const task = await client.get(TaskObject, { id: manifest.id });
  const session = await client.get(SessionObject, { taskId: manifest.id });
  const close = async () => {
    task.release();
    session.release();
    node.release();
    await closeClient();
    await node0.close();
  };
  return { task, session, close };
}

const kindOf = (e: { message: unknown }) => {
  const m = e.message as { type?: string; subtype?: string };
  return m.subtype === undefined ? m.type : `${m.type}/${m.subtype}`;
};

test("a task's agent runs while its turn is live and its notice is held back, then is done", async () => {
  // The agent's notice comes 1.5 s after the turn's first result: the turn stays live, waiting on it.
  const { task, session, close } = await agentNode({ MEDDLE_FIXTURE_BACKGROUND_MS: "1500" });
  try {
    expect(task.agents.value).toEqual([]);
    expect(task.agentsRunning.value).toBe(0);
    await task.prompt({ text: "Review the suite in the background." });
    await until(session.window, (w) => w.some((e) => kindOf(e) === "result/success"));
    await until(task.agents, (a) => a[0]?.doing === "Running bun test");
    await until(task.agentsRunning, (n) => n === 1);
    expect(session.window.value.map(kindOf)).not.toContain("system/task_notification");
    expect(task.state.value).toBe("running");
    expect(task.agents.value).toEqual([expect.objectContaining({
      id: "agent01", toolUseId: "toolu_agent", description: "Review the suite", background: true, state: "running", orphaned: false,
      doing: "Running bun test", tools: 3, tokens: 12000, ms: 4000, endedAt: null,
    })]);

    const [done] = await until(task.agents, (a) => a[0]?.state === "completed");
    expect(done).toMatchObject({ orphaned: false, doing: null, tools: 5, tokens: 15000, ms: 7000 });
    expect(done!.endedAt).not.toBeNull();
    await until(task.agentsRunning, (n) => n === 0);
    // The turn ends with the result of Claude Code's wake for the agent; its end leaves a done agent done.
    await until(task.state, (s) => s === "idle");
    expect(task.agents.value.map((a) => [a.id, a.state, a.orphaned])).toEqual([["agent01", "completed", false]]);
    expect(task.agentsRunning.value).toBe(0);
  } finally {
    await close();
  }
}, 20_000);

test("a task's agent left running when its turn's process goes is stopped and orphaned", async () => {
  // The turn stalls before its result, the agent running, until it is interrupted: then the process ends, no notice.
  const { task, session, close } = await agentNode({ MEDDLE_FIXTURE_STALL: "1" });
  try {
    await task.prompt({ text: "Review the suite in the background." });
    await until(task.agents, (a) => a[0]?.doing === "Running bun test");
    await until(task.agentsRunning, (n) => n === 1);
    expect(task.agents.value[0]).toMatchObject({ state: "running", orphaned: false });

    // The task's state when the agent stopped: the process goes before the turn's finish makes the task idle.
    let stateAtStop: string | undefined;
    const off = task.agents.subscribe((a) => { if (a[0]?.state === "stopped") stateAtStop ??= task.state.value; });
    await task.interrupt({});
    const [stopped] = await until(task.agents, (a) => a[0]?.state === "stopped");
    off();
    expect(stopped).toMatchObject({ id: "agent01", orphaned: true, doing: null, tools: 3 });
    expect(stateAtStop).toBe("running");
    await until(task.agentsRunning, (n) => n === 0);
    await until(task.state, (s) => s === "idle");
    expect(session.window.value.map(kindOf)).not.toContain("system/task_notification");
    expect(task.agents.value.map((a) => [a.state, a.orphaned])).toEqual([["stopped", true]]);
  } finally {
    await close();
  }
}, 20_000);

test("a project's graph shows a task's line and follows a turn's end", async () => {
  const { client, project, close } = await connect();
  try {
    const node = await client.get(NodeObject, {});
    const view = await client.get(ProjectObject, { id: project.id });
    expect(view.graph.value.some((c) => c.bookmarks.some((b) => b.kind === "task"))).toBe(false);
    const { manifest } = await node.createTask({ title: "t", projects: [{ id: project.id }] });
    const task = await client.get(TaskObject, { id: manifest.id });
    await task.prompt({ text: "Reply with the single word ok." });
    const graph = await until(view.graph, (list) => list.some((c) => c.bookmarks.some((b) => b.kind === "task")));
    expect(graph.flatMap((c) => c.bookmarks)).toContainEqual({ kind: "task", task: manifest.id });
    expect(graph.flatMap((c) => c.bookmarks)).toContainEqual({ kind: "branch", name: "main" });
    expect(await view.olderGraph({ limit: 1 })).toHaveLength(1);
    // Clamped to 1..2000.
    expect(await view.olderGraph({ limit: 0 })).toHaveLength(1);

    // Archiving flips the line's row: its line leaves the graph.
    await until(task.state, (s) => s === "idle");
    await task.archive({});
    await until(view.graph, (list) => !list.some((c) => c.bookmarks.some((b) => b.kind === "task")));
  } finally {
    await close();
  }
}, 15_000);

test("a project's contextLoaded reads the context on its default branch, not the service repo's empty working copy", async () => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { initColocated, jj } = await import("../src/jj");
  const { addProjectFromFolder } = await import("../src/projects/project");
  const { cfg, db, id, home, client, close } = await connect();
  try {
    // `bad`'s default branch holds a context.toml that does not parse; `fine`'s holds it only above its default branch.
    const add = async (name: string, onMain: boolean) => {
      const folder = `${home}/${name}`;
      await mkdir(`${folder}/.meddle`, { recursive: true });
      await initColocated(folder, cfg);
      await writeFile(`${folder}/README`, "r\n");
      await jj(["commit", "-m", "readme"], folder, cfg);
      if (!onMain) await jj(["bookmark", "set", "main", "-r", "@-"], folder, cfg);
      await writeFile(`${folder}/.meddle/context.toml`, "[claude]\nallwo = []\n");
      await jj(["commit", "-m", "context"], folder, cfg);
      if (onMain) await jj(["bookmark", "set", "main", "-r", "@-"], folder, cfg);
      return addProjectFromFolder(cfg, db, folder, id, name);
    };
    const bad = await add("bad", true);
    const fine = await add("fine", false);
    expect(await Bun.file(`${bad.replica}/.meddle/context.toml`).exists()).toBe(false);
    const loaded = async (projectId: string) => {
      const view = await client.get(ProjectObject, { id: projectId });
      try {
        return view.contextLoaded.value;
      } finally {
        view.release();
      }
    };
    expect(await loaded(bad.id)).toBe(false);
    expect(await loaded(fine.id)).toBe(true);
  } finally {
    await close();
  }
}, 15_000);

test("a task's bookmarks are listed without waiting for a push holding its replica's lock", async () => {
  const { client, project, close } = await connect();
  try {
    const node = await client.get(NodeObject, {});
    const { manifest } = await node.createTask({ title: "t", projects: [{ id: project.id }] });
    let release = () => {};
    const held = new Promise<void>((res) => { release = res; });
    let locked = () => {};
    const entered = new Promise<void>((res) => { locked = res; });
    const holder = serialised(repoKey(project.replica), async () => { locked(); await held; });
    await entered;
    try {
      const started = Date.now();
      const task = await client.get(TaskObject, { id: manifest.id });
      expect(Date.now() - started).toBeLessThan(1000);
      expect(task.bookmarks.value).toEqual([
        { project: project.id, name: `meddle/task/${manifest.id}/${project.name}`, changeId: expect.stringMatching(/^[k-z]+$/) },
      ]);
      task.release();
    } finally {
      release();
      await holder;
    }
    node.release();
  } finally {
    await close();
  }
}, 15_000);

test("changes come back over the object and follow a turn", async () => {
  const { client, project, cfg, close } = await connect();
  try {
    const node = await client.get(NodeObject, {});
    const { manifest } = await node.createTask({ title: "t", projects: [{ id: project.id }] });
    const task = await client.get(TaskObject, { id: manifest.id });
    // Read once the object is up, not before it.
    expect(await until(task.changes, (list) => list.length > 0)).toEqual([
      { project: project.id, name: project.name, start: "main", conflicted: false, from: manifest.projects[0]!.base[0], changes: [expect.objectContaining({ workingCopy: true, files: 0, empty: true })] },
    ]);
    // What the agent writes in its workspace shows once its turn's end snapshots it and moves the line.
    const workspace = `${paths(cfg).task(manifest.id)}/${manifest.projects[0]!.workspace}`;
    await writeFile(`${workspace}/notes.txt`, "one\ntwo\n");
    await task.prompt({ text: "Reply with the single word ok." });
    const changes = await until(task.changes, (list) => list[0]?.changes[0]?.files === 1);
    expect(changes[0]!.changes).toEqual([expect.objectContaining({ workingCopy: true, files: 1, added: 2, removed: 0, empty: false })]);

    const change = changes[0]!.changes[0]!.change;
    expect(await task.changeDiff({ project: project.id, change })).toContain("+two");
    expect(await task.changeDiff({ project: project.id, change: changes[0]!.changes[0]!.commit, from: changes[0]!.from! })).toContain("notes.txt");
    expect(await task.changeFile({ project: project.id, rev: change, path: "notes.txt" })).toBe("one\ntwo\n");
    expect(await task.changeFile({ project: project.id, rev: `${change}-`, path: "notes.txt" })).toBeNull();
    expect(await task.workspaceFile({ path: `${workspace}/notes.txt` })).toBe("one\ntwo\n");
    // A malformed id reaches the caller with its code.
    expect(await task.changeFile({ project: project.id, rev: "x|y", path: "notes.txt" }).then(() => "", remoteReason)).toStartWith("bad-id:");
    expect(await task.changeDiff({ project: "nope", change }).then(() => "", remoteReason)).toStartWith("project:");
    // An id that is not (or no longer) there: jj's own reason.
    expect(await task.changeDiff({ project: project.id, change: "kkkkkkkkkkkk" }).then(() => "", remoteReason)).toStartWith("jj:");
    task.release();
    node.release();
  } finally {
    await close();
  }
}, 15_000);

test("workspaceFile refuses outside the workspace", async () => {
  const { client, project, home, cfg, close } = await connect();
  try {
    const node = await client.get(NodeObject, {});
    const { manifest } = await node.createTask({ title: "t", projects: [{ id: project.id }] });
    const task = await client.get(TaskObject, { id: manifest.id });
    expect(await task.workspaceFile({ path: `${home}/a/README` }).then(() => "", remoteReason)).toStartWith("outside:");
    // An archived task's changes are not here.
    const inside = `${paths(cfg).task(manifest.id)}/a/README`;
    expect(await task.workspaceFile({ path: inside })).toBe("a\n");
    await task.archive({});
    await until(task.changes, (list) => list.length === 0);
    expect(await task.workspaceFile({ path: inside }).then(() => "", remoteReason)).toStartWith("archived:");
    expect(await task.changeDiff({ project: project.id, change: "abc" }).then(() => "", remoteReason)).toStartWith("archived:");
    task.release();
    node.release();
  } finally {
    await close();
  }
}, 15_000);

/**
 * Logs every jj call `cfg`'s node makes from now on, its end too (`<data>/bin` is first on jj's PATH); with
 * `failOnce`, the first call whose arguments contain it fails instead. Answers the log's lines so far.
 */
async function logJj(cfg: NodeConfig, dir: string, failOnce?: string): Promise<() => Promise<string[]>> {
  const log = `${dir}/jj.log`;
  await writeFile(log, "");
  await mkdir(paths(cfg).bin, { recursive: true });
  const wrapper = `${paths(cfg).bin}/jj`;
  await writeFile(wrapper, [
    "#!/bin/sh",
    `printf 'start %s\\n' "$*" >> '${log}'`,
    ...(failOnce === undefined ? [] : [`case "$*" in *'${failOnce}'*) if [ ! -e '${log}.failed' ]; then : > '${log}.failed'; exit 1; fi;; esac`]),
    `'${Bun.which("jj")}' "$@"`,
    "s=$?",
    `printf 'done %s\\n' "$*" >> '${log}'`,
    "exit $s",
    "",
  ].join("\n"));
  await chmod(wrapper, 0o755);
  return async () => (await Bun.file(log).text()).split("\n");
}

test("a trigger with the task's line where it was does not read its changes again", async () => {
  const { client, project, cfg, db, home, close } = await connect();
  try {
    const node = await client.get(NodeObject, {});
    const { manifest } = await node.createTask({ title: "t", projects: [{ id: project.id }] });
    const task = await client.get(TaskObject, { id: manifest.id });
    await until(task.changes, (list) => list.length > 0);
    expect(getProject(db, project.id)?.defaultBranch).toBe("main");
    const lines = await logJj(cfg, home);
    const line = `meddle/task/${manifest.id}/${project.name}`;

    // A project registration with the line where it was: probed, not read.
    setDefaultBranch(db, project.id, "main");
    for (let i = 0; !(await lines()).some((l) => l.startsWith("done") && l.includes(`exact:"${line}"`)); i++) {
      if (i > 100) throw new Error("the line was not probed");
      await Bun.sleep(50);
    }
    await Bun.sleep(300);
    // Moved: read.
    await jj(["--ignore-working-copy", "bookmark", "set", line, "-r", manifest.projects[0]!.base[0]!, "--allow-backwards"], project.replica, cfg);
    setDefaultBranch(db, project.id, "main");
    await until(task.changes, (list) => list[0]?.changes.length === 0);
    const reads = (await lines()).filter((l) => l.startsWith("start") && l.includes("diff().files()"));
    expect(reads).toHaveLength(1);
    task.release();
    node.release();
  } finally {
    await close();
  }
}, 15_000);

test("a project whose changes failed to read is read again on the next trigger", async () => {
  const { client, project, cfg, db, home, close } = await connect();
  try {
    // The first read of the task's range fails.
    await logJj(cfg, home, "diff().files()");
    const node = await client.get(NodeObject, {});
    const { manifest } = await node.createTask({ title: "t", projects: [{ id: project.id }] });
    const task = await client.get(TaskObject, { id: manifest.id });
    for (let i = 0; !(await Bun.file(`${home}/jj.log.failed`).exists()); i++) {
      if (i > 100) throw new Error("the range was not read");
      await Bun.sleep(50);
    }
    await Bun.sleep(300);
    expect(task.changes.value).toEqual([]);
    // Nothing moved, but the project was left out: read again.
    setDefaultBranch(db, project.id, "main");
    const changes = await until(task.changes, (list) => list.length === 1);
    expect(changes[0]).toMatchObject({ project: project.id, start: "main" });
    task.release();
    node.release();
  } finally {
    await close();
  }
}, 15_000);

test("a project whose re-read fails keeps its changes until a read lands", async () => {
  const { client, project, cfg, db, home, close } = await connect();
  try {
    const node = await client.get(NodeObject, {});
    const { manifest } = await node.createTask({ title: "t", projects: [{ id: project.id }] });
    const task = await client.get(TaskObject, { id: manifest.id });
    const earlier = await until(task.changes, (list) => list.length > 0);
    // The line moves, and the read that follows fails.
    await logJj(cfg, home, "diff().files()");
    const line = `meddle/task/${manifest.id}/${project.name}`;
    await jj(["--ignore-working-copy", "bookmark", "set", line, "-r", manifest.projects[0]!.base[0]!, "--allow-backwards"], project.replica, cfg);
    setDefaultBranch(db, project.id, "main");
    for (let i = 0; !(await Bun.file(`${home}/jj.log.failed`).exists()); i++) {
      if (i > 100) throw new Error("the range was not read");
      await Bun.sleep(50);
    }
    await Bun.sleep(300);
    expect(task.changes.value).toEqual(earlier);
    // The next trigger reads it again, though nothing moved since.
    setDefaultBranch(db, project.id, "main");
    await until(task.changes, (list) => list[0]?.changes.length === 0);
    task.release();
    node.release();
  } finally {
    await close();
  }
}, 15_000);

test("a trigger after the start's bookmark moved off the base names the start again", async () => {
  const { client, project, cfg, db, close } = await connect();
  try {
    const node = await client.get(NodeObject, {});
    const { manifest } = await node.createTask({ title: "t", projects: [{ id: project.id }] });
    const task = await client.get(TaskObject, { id: manifest.id });
    await until(task.changes, (list) => list[0]?.start === "main");
    await jj(["--ignore-working-copy", "bookmark", "delete", "main"], project.replica, cfg);
    setDefaultBranch(db, project.id, "main");
    // No bookmark on the base now: its short change id.
    const changes = await until(task.changes, (list) => list[0]?.start !== "main");
    expect(changes[0]!.start).toMatch(/^[k-z]{8}$/);
    task.release();
    node.release();
  } finally {
    await close();
  }
}, 15_000);

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** `memoryHead` once `memory` and the memory working copy's parent are both on `change` (`memoryPlacing`'s line). */
async function headAt(cfg: NodeConfig, projectId: string, change: string): Promise<string> {
  const commit = await jj(["--ignore-working-copy", "log", "-r", change, "--no-graph", "-T", "commit_id"], paths(cfg).memory(projectId), cfg);
  return `${commit.trim()} true true`;
}

test("memoryHead follows a dashboard write", async () => {
  const { client, project, cfg, close } = await connect();
  try {
    const view = await client.get(ProjectObject, { id: project.id });
    const before = view.memoryHead.value;
    const { change } = await view.writeMemory({ path: "a.md", text: "x\n", base: null });
    const at = await headAt(cfg, project.id, change);
    expect(at).not.toBe(before);
    expect(await until(view.memoryHead, (head) => head === at)).toBe(at);
    view.release();
  } finally {
    await close();
  }
}, 15_000);

test("memoryEntries and memoryHistory come back over the object", async () => {
  const { client, project, close } = await connect();
  try {
    const view = await client.get(ProjectObject, { id: project.id });
    const text = "---\nname: Tides\ndescription: when the tide turns\ntype: user\n---\nbody\n";
    const first = await view.writeMemory({ path: "tides.md", text, base: null });
    const second = await view.writeMemory({ path: "MEMORY.md", text: "- [Tides](tides.md)\n", base: null });

    const entries = await view.memoryEntries({});
    expect(entries.map((e) => e.path)).toEqual(["MEMORY.md", "tides.md"]);
    expect(entries[1]).toMatchObject({
      path: "tides.md", size: text.length, hash: sha256(text), name: "Tides", description: "when the tide turns", type: "user",
      last: { change: first.change, kind: "dashboard", node: null, task: null, description: "memory: dashboard", files: ["tides.md"], removed: 0 },
    });

    const history = await view.memoryHistory({ limit: 10 });
    expect(history.slice(0, 2).map((c) => c.change)).toEqual([second.change, first.change]);
    expect(history[0]).toMatchObject({ kind: "dashboard", files: ["MEMORY.md"], added: 1, removed: 0 });
    expect(history[0]!.at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    // The limit is clamped to 1..200.
    expect(await view.memoryHistory({ limit: 0 })).toHaveLength(1);
    expect((await view.memoryHistory({ limit: 1, before: second.change })).map((c) => c.change)).toEqual([first.change]);
    expect((await view.memoryHistory({ limit: 10, path: "tides.md" })).map((c) => c.change)).toEqual([first.change]);

    expect(await view.memoryFile({ path: "tides.md" })).toBe(text);
    expect(await view.memoryFile({ path: "tides.md", change: first.change })).toBe(text);
    expect(await view.memoryFile({ path: "tides.md", change: `${first.change}-` })).toBeNull();
    expect(await view.memoryDiff({ change: first.change })).toContain("+name: Tides");
    // A read refuses a path that is not a memory file.
    const refused = await view.memoryFile({ path: "../x.md" }).then(() => "", remoteReason);
    expect(refused).toStartWith("path:");
    view.release();
  } finally {
    await close();
  }
}, 15_000);

test("a changed base reaches the caller as changed:, and a delete takes the file out", async () => {
  const { client, project, cfg, close } = await connect();
  try {
    const view = await client.get(ProjectObject, { id: project.id });
    await view.writeMemory({ path: "a.md", text: "x\n", base: null });
    // As the dashboard reads it: the reason, without chord's own code.
    const refused = await view.writeMemory({ path: "a.md", text: "z\n", base: sha256("y\n") }).then(() => "", remoteReason);
    expect(refused).toStartWith("changed:");
    expect(await view.memoryFile({ path: "a.md" })).toBe("x\n");

    const { change } = await view.deleteMemory({ path: "a.md", base: sha256("x\n") });
    expect(await view.memoryFile({ path: "a.md" })).toBeNull();
    expect((await view.memoryEntries({})).map((e) => e.path)).not.toContain("a.md");
    const at = await headAt(cfg, project.id, change);
    expect(await until(view.memoryHead, (head) => head === at)).toBe(at);
    view.release();
  } finally {
    await close();
  }
}, 15_000);

test("the home follows a peer's push of memory onto disk while no task of the project is live there", async () => {
  const { A, B, close } = await twoPoolNodes();
  const { client, close: closeClient } = linkClient(A.host);
  try {
    await peerReady(B, A);
    const id = A.project.id;
    await ensureServiceRepo({ cfg: B.cfg, db: B.db, pool: B.pool }, id);
    const memA = paths(A.cfg).memory(id);
    const memB = paths(B.cfg).memory(id);
    const view = await client.get(ProjectObject, { id });
    await view.writeMemory({ path: "MEMORY.md", text: "- base\n", base: null });
    await syncMemoryBefore({ cfg: B.cfg, db: B.db, pool: B.pool }, id, false);
    const before = view.memoryHead.value;

    await writeFile(`${memB}/NOTES.md`, "- from b\n");
    await syncMemoryAfter({ cfg: B.cfg, db: B.db, pool: B.pool }, id, false);
    const fromB = (await jj(["--ignore-working-copy", "log", "-r", "@-", "--no-graph", "-T", "change_id"], memB, B.cfg)).trim();
    // The push moved A's `memory`; A's working copy follows it, and `memoryHead` says where both are.
    const at = await headAt(A.cfg, id, fromB);
    expect(await until(view.memoryHead, (head) => head === at)).toBe(at);
    expect(at).not.toBe(before);
    expect(await Bun.file(`${memA}/NOTES.md`).text()).toBe("- from b\n");
    expect((await view.memoryEntries({})).map((e) => e.path)).toEqual(["MEMORY.md", "NOTES.md"]);
    view.release();
  } finally {
    await closeClient();
    await close();
  }
}, 20_000);

test("while an update awaits confirmation, a project's memory is not written, and still reads", async () => {
  let held: string | null = null;
  const node = await startPoolNode(undefined, {}, { inputHold: () => held });
  const { client, close } = linkClient(node.host);
  try {
    const view = await client.get(ProjectObject, { id: node.project.id });
    held = "update in progress";
    const refusal = (p: Promise<unknown>) => p.then(() => "", (err: unknown) => (err as Error).message);
    expect(await refusal(view.writeMemory({ path: "a.md", text: "x\n", base: null }))).toContain("update in progress");
    expect(await refusal(view.deleteMemory({ path: "a.md", base: null }))).toContain("update in progress");
    expect(await view.memoryEntries({})).toEqual([]);
    held = null;
    await view.writeMemory({ path: "a.md", text: "x\n", base: null });
    expect((await view.memoryEntries({})).map((e) => e.path)).toEqual(["a.md"]);
    view.release();
  } finally {
    await close();
    await node.close();
  }
}, 15_000);
