// test/state.test.ts
import { test, expect } from "bun:test";
import { memoryLinkPair, createHost, type Host } from "@earendil-works/chord";
import { createNodeHost, NodeObject, TaskObject, SessionObject } from "../src/state/host";
import { findTaskPids, MetricsSampler } from "../src/metrics";
import { claudeCodeVersion } from "../src/version";
import { appendEvent } from "../src/store/events";
import { setupNode } from "./helpers";

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

/** A node host for `fixture`, and a client host connected to it over a memory link. */
async function connect(fixture?: string) {
  const node = await setupNode(fixture);
  const metrics = new MetricsSampler({ taskPids: () => findTaskPids(node.cfg.taskRoot), intervalMs: 60_000, dataDir: node.cfg.dataDir });
  const host = createNodeHost({ cfg: node.cfg, db: node.db, runner: node.runner, metrics, claudeCodeVersion: claudeCodeVersion() });
  const [down, up] = memoryLinkPair();
  host.accept(down, { principal: "owner", kind: "client" });
  const client: Host = createHost({ name: "client", self: "client", kind: "client", upstream: { link: up, principal: "node" } });
  const close = async () => {
    await client.close();
    await host.close();
    await node.harness.close();
  };
  return { ...node, metrics, host, client, close };
}

test("claudeCodeVersion reads the pinned SDK's manifest", () => {
  expect(claudeCodeVersion()).toBe("2.1.314");
});

test("a client follows a task through a prompted turn over a link", async () => {
  const { client, metrics, project, close } = await connect();
  try {
    const node = await client.get(NodeObject, {});
    expect(node.projectIds.value).toContain(project.id);
    expect(node.metrics.value).toBeNull();
    metrics.start();
    await until(node.metrics, (m) => m !== null);
    metrics.stop();
    expect(node.claudeCodeVersion.value).toBe("2.1.314");
    expect(node.token.value.present).toBe(true);

    const manifest = await node.createTask({ title: "t", projectIds: [project.id] });
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
    expect(task.permissionMode.value).toBe("auto");
    expect(task.model.value).toBe("claude-haiku-5-5");
    expect(task.lastSeq.value).toBe(session.window.value.at(-1)!.seq);
    expect(task.pending.value).toEqual([]);
    // the recorded initialize response carries the model list
    await until(node.models, (models) => models.length > 0);
    expect(node.models.value).toEqual(["default", "sonnet", "fable", "opus", "haiku"]);

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

test("a client sees a pending approval, and approving it lets the turn finish", async () => {
  const { client, project, close } = await connect("approval.jsonl");
  try {
    const node = await client.get(NodeObject, {});
    const manifest = await node.createTask({ title: "t", projectIds: [project.id] });
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

test("a session keeps stream deltas out of its window and in live until the next event", async () => {
  const { client, host, db, project, close } = await connect();
  try {
    const node = await client.get(NodeObject, {});
    const { id } = await node.createTask({ title: "t", projectIds: [project.id] });
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
