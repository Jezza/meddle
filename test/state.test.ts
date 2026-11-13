// test/state.test.ts
import { test, expect } from "bun:test";
import { NodeObject, ProjectObject, TaskObject, SessionObject } from "../src/state/host";
import { claudeCodeVersion } from "../src/version";
import { appendEvent } from "../src/store/events";
import { errorResultFixture } from "./helpers";
import { linkClient, startPoolNode } from "./pool-helpers";
import { repoKey, serialised } from "../src/serial";
import { getTask } from "../src/store/records";
import { readManifest } from "../src/tasks/manifest";

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
    for (let i = 0; i < 249; i++) appendEvent(db, id, { type: "assistant", n: i });
    appendEvent(db, id, { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } } });
    const task = await client.get(TaskObject, { id });
    expect(task.lastSeq.value).toBe(255);
    expect(task.permissionMode.value).toBe("plan");
    expect(task.contextUsage.value).toMatchObject({ usage: { input_tokens: 1 } });
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

test("a project's heads list its replica's bookmarks and follow a turn's end of a task of it, without a metrics sample", async () => {
  const { client, project, close } = await connect();
  try {
    const node = await client.get(NodeObject, {});
    const view = await client.get(ProjectObject, { id: project.id });
    expect(view.heads.value.some((h) => h.name.startsWith("meddle/task/"))).toBe(false);
    const { manifest } = await node.createTask({ title: "t", projects: [{ id: project.id }] });
    const task = await client.get(TaskObject, { id: manifest.id });
    await task.prompt({ text: "Reply with the single word ok." });
    const bookmark = `meddle/task/${manifest.id}/${project.name}`;
    const heads = await until(view.heads, (list) => list.some((h) => h.name === bookmark));
    const head = heads.find((h) => h.name === bookmark)!;
    expect(head).toMatchObject({ remote: null, conflicted: false });
    expect(head.changeId).toMatch(/^[k-z]+$/);
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
