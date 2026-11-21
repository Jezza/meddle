// test/thread-model.test.ts
import { test, expect } from "bun:test";
import {
  activity, activityLine, agentEndNote, backgroundMeta, buildThread, callRuns, cwdOf, duration, editDiff, exitCode, exploredLine, foldSteps,
  holdsCall, isRunning, keyOf, missingCalls, relativePath, toolSummary, toolTarget, type ThreadItem, type ToolItem, workspaceSource,
} from "../src/dashboard/ui/thread-model";
import type { Attachment } from "../src/blobs/attachment";

const shot: Attachment = { hash: "a".repeat(64), name: "shot.png", type: "image/png", size: 1000 };
test("tool calls get their results and subagent messages nest", () => {
  const items = buildThread([
    { seq: 1, message: { type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } }] }, parent_tool_use_id: null } },
    { seq: 2, message: { type: "assistant", message: { id: "m2", content: [{ type: "text", text: "inside" }] }, parent_tool_use_id: "tu1" } },
    { seq: 3, message: { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "a\nb", is_error: false }] }, parent_tool_use_id: null } },
    { seq: 4, message: { type: "system", subtype: "permission_denied", tool_name: "Bash", decision_reason_type: "classifier", decision_reason: "[Data Exfiltration]", message: "denied" } },
    { seq: 5, message: { type: "brand_new_thing", x: 1 } },
    { seq: 6, message: { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } } } },
  ]);
  expect(items[0]).toMatchObject({ kind: "tool", name: "Bash", result: { text: "a\nb", isError: false } });
  expect((items[0] as any).children[0]).toMatchObject({ kind: "assistant", text: "inside" });
  expect(items[1]).toMatchObject({ kind: "denied", reasonType: "classifier", reason: "[Data Exfiltration]" });
  expect(items[2]).toMatchObject({ kind: "unknown", type: "brand_new_thing" });
  // the stream_event produced no item
  expect(items).toHaveLength(3);
});

test("the recorded approval turn renders one Bash call with its result", async () => {
  const lines = (await Bun.file(`${import.meta.dir}/fixtures/approval.jsonl`).text()).trim().split("\n");
  const messages = lines
    .map((l) => JSON.parse(l) as { dir: string; line: string })
    .filter((e) => e.dir === "out")
    .map((e) => JSON.parse(e.line) as { type?: unknown })
    .filter((m) => typeof m.type === "string");
  const items = buildThread(messages.map((message, i) => ({ seq: i + 1, message })));
  const tools = items.filter((item) => item.kind === "tool");
  expect(tools).toHaveLength(1);
  expect(tools[0]).toMatchObject({ kind: "tool", name: "Bash", result: { text: "hi", isError: false } });
});

test("a prompt meddle recorded becomes a user item", () => {
  const items = buildThread([
    { seq: 1, message: { type: "meddle", subtype: "turn_started", at: "", resume: false } },
    { seq: 2, message: { type: "user", message: { role: "user", content: "Run: echo hi" }, parent_tool_use_id: null } },
  ]);
  expect(items).toEqual([{ kind: "user", text: "Run: echo hi", attachments: [] }]);
});

test("the train's prompt shows as a prompt marked as meddle's; its tools' calls as status lines", () => {
  const items = buildThread([
    { seq: 1, message: { type: "meddle", subtype: "turn_started", at: "", resume: true } },
    { seq: 2, message: { type: "meddle", subtype: "train_turn", kind: "rebase", text: "main moved on, …" } },
    { seq: 3, message: { type: "meddle", subtype: "train_decline", reason: "the API it fixes is gone" } },
    { seq: 4, message: { type: "meddle", subtype: "train_turn", kind: "merge", text: "Check that A and B work together on main. …" } },
    { seq: 5, message: { type: "meddle", subtype: "train_blame", task: "A", reason: "test/a.test.ts fails" } },
  ]);
  expect(items).toEqual([
    { kind: "status", text: "Turn resumed" },
    { kind: "user", text: "main moved on, …", attachments: [], by: "meddle" },
    { kind: "status", text: "Declined: the API it fixes is gone" },
    { kind: "user", text: "Check that A and B work together on main. …", attachments: [], by: "meddle" },
    { kind: "status", text: "Blamed A: test/a.test.ts fails" },
  ]);
});

test("a task the train took off says why in its conversation", () => {
  const items = buildThread([
    { seq: 1, message: { type: "meddle", subtype: "train_left", reason: "another task builds on this work, so it can't rebase" } },
  ]);
  expect(items).toEqual([{ kind: "status", text: "Left meddle's train: another task builds on this work, so it can't rebase" }]);
});

test("a prompt meddle recorded keeps its attachments, and drops a bad one", () => {
  const items = buildThread([{ seq: 1, message: { type: "user", message: { role: "user", content: "look" }, parent_tool_use_id: null,
    attachments: [shot, { ...shot, name: "../x" }] } }]);
  expect(items).toEqual([{ kind: "user", text: "look", attachments: [shot] }]);
});

test("a turn's end carries when it was logged", () => {
  const items = buildThread([
    { seq: 1, at: "2026-11-17T10:00:00.000Z", message: { type: "result", subtype: "success", num_turns: 2, duration_ms: 1500, total_cost_usd: 0.01 } },
    { seq: 2, message: { type: "result", subtype: "error_during_execution" } },
  ]);
  expect(items).toEqual([
    { kind: "status", text: "Turn finished · 2 turns · 1.5 s · $0.0100", at: "2026-11-17T10:00:00.000Z" },
    { kind: "status", text: "Turn ended: error_during_execution" },
  ]);
});

test("a token fault renders as a status line", () => {
  const fault = (fault: unknown, rerun: boolean, label: string | null = "a") =>
    ({ type: "meddle", subtype: "token_fault", at: "", tokenId: label === null ? null : "0123456789abcdef", label, fault, rerun });
  const items = buildThread([
    { seq: 1, message: fault({ kind: "exhausted", until: "2100-01-01T00:00:00.000Z", type: "five_hour" }, true) },
    { seq: 2, message: fault({ kind: "exhausted", until: null, type: null }, false) },
    { seq: 3, message: fault({ kind: "disabled", reason: "billing_error" }, true) },
    { seq: 4, message: fault({ kind: "disabled", reason: "account_on_hold" }, false) },
    { seq: 5, message: fault({ kind: "none" }, false, null) },
    { seq: 6, message: { ...fault({ kind: "exhausted", until: "2100-01-01T00:00:00.000Z", type: null }, false), retried: true } },
  ]);
  expect(items).toEqual([
    { kind: "status", text: "Token a exhausted until 2100-01-01T00:00:00.000Z; switching login" },
    { kind: "status", text: "Token a exhausted; no other token" },
    { kind: "status", text: "Token a disabled: billing_error; switching login" },
    { kind: "status", text: "Token a disabled: account_on_hold; no other token" },
    { kind: "status", text: "No usable token" },
    { kind: "status", text: "Token a exhausted until 2100-01-01T00:00:00.000Z; already switched login once" },
  ]);
});

const tool = (name: string, input: unknown, result?: ToolItem["result"]): ToolItem =>
  ({ kind: "tool", name, input, toolUseId: `${name}${JSON.stringify(input)}`, children: [], ...(result && { result }) });
const done = { text: "", isError: false };

test("foldSteps folds runs of calls that only look, with their thinking, and leaves every other call a row", () => {
  const thinking: ThreadItem = { kind: "assistant", text: "", thinking: "hmm" };
  const vcs: ThreadItem = { kind: "unknown", type: "command_lifecycle", raw: {} };
  const read = tool("Read", { file_path: "a.rs" });
  const grep = tool("Grep", { pattern: "take_event" });
  const edit = tool("Edit", { file_path: "a.rs", old_string: "a", new_string: "b" });
  const bash = tool("Bash", { command: "cargo check" });
  const items: ThreadItem[] = [
    { kind: "user", text: "hi", attachments: [] }, thinking, read, vcs, grep, thinking, edit, bash,
    { kind: "assistant", text: "", thinking: "" }, tool("Read", { file_path: "b.rs" }),
  ];
  expect(foldSteps(items)).toEqual([
    { kind: "user", text: "hi", attachments: [] },
    { kind: "explored", steps: [thinking, read, grep, thinking] as never },
    edit,
    bash,
    { kind: "explored", steps: [tool("Read", { file_path: "b.rs" })] },
  ]);
  // Raw shows the unknown message, which splits the run.
  expect(foldSteps(items, true).map((i) => i.kind)).toEqual(["user", "explored", "unknown", "explored", "tool", "tool", "explored"]);
  // Thinking with no look after it stays on its own.
  expect(foldSteps([thinking, edit])).toEqual([thinking, edit]);
  // Prose between two looks splits them; a message the thread does not know shows only with Raw.
  const odd: ThreadItem = { kind: "unknown", type: "system:api_retry", raw: {} };
  expect(foldSteps([read, { kind: "assistant", text: "so" }, grep, odd]).map((i) => i.kind)).toEqual(["explored", "assistant", "explored"]);
  expect(foldSteps([read, { kind: "assistant", text: "so" }, grep, odd], true).map((i) => i.kind)).toEqual(["explored", "assistant", "explored", "unknown"]);
  expect(keyOf(foldSteps([read, grep])[0]!)).toBe(read.toolUseId);
  expect(keyOf(edit)).toBe(edit.toolUseId);
  expect(keyOf({ kind: "user", text: "x", attachments: [] })).toBeUndefined();
});

test("exploredLine counts what a run looked at by kind, a file read twice once", () => {
  expect(exploredLine([
    tool("Read", { file_path: "a" }, done), tool("Grep", { pattern: "x" }, done), tool("Read", { file_path: "a" }, done),
    tool("Glob", { pattern: "*.ts" }, done), tool("Read", { file_path: "b" }, done), { kind: "assistant", text: "", thinking: "hm" },
  ])).toEqual({ text: "2 files, 2 searches", running: false, failed: 0 });
  expect(exploredLine([tool("WebFetch", { url: "u" }, { text: "no", isError: true }), tool("Read", { file_path: "a" })]))
    .toEqual({ text: "1 page, 1 file", running: true, failed: 1 });
  expect(toolSummary({ command: "cargo check\n--all" })).toBe("cargo check");
  expect(toolSummary({ prompt: "x".repeat(10) }, 4)).toBe("xxxx…");
});

test("an Edit's result keeps its patch and the original file", () => {
  const hunk = { oldStart: 4, oldLines: 2, newStart: 4, newLines: 3, lines: [" a", "-b", "+B", "+c"] };
  const [edit] = buildThread([
    { seq: 1, message: { type: "assistant", message: { id: "m", content: [{ type: "tool_use", id: "e", name: "Edit", input: { file_path: "/w/a.ts", old_string: "b", new_string: "B\nc" } }] } } },
    { seq: 2, message: {
      type: "user", message: { content: [{ type: "tool_result", tool_use_id: "e", content: "updated" }] },
      tool_use_result: { structuredPatch: [hunk, { bad: true }], originalFile: "a\nb\nz\n" },
    } },
  ]) as [ToolItem];
  expect(edit.result?.original).toEqual(["a", "b", "z"]);
  expect(editDiff(edit)).toEqual({ hunks: [hunk], fallback: [], added: 2, removed: 1 });
});

test("workspaceSource picks large-file edits", () => {
  const hunk = { oldStart: 4, oldLines: 1, newStart: 4, newLines: 1, lines: ["-b", "+B"] };
  const edit = (result: Record<string, unknown>) => (buildThread([
    { seq: 1, message: { type: "assistant", message: { id: "m", content: [{ type: "tool_use", id: "e", name: "Edit", input: { file_path: "/w/a.ts", old_string: "b", new_string: "B" } }] } } },
    { seq: 2, message: { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "e", content: "updated" }] }, tool_use_result: result } },
  ]) as [ToolItem])[0];
  // Too large for the log to carry the file: it opens from the workspace.
  expect(workspaceSource(edit({ structuredPatch: [hunk] }))).toEqual({ path: "/w/a.ts" });
  expect(workspaceSource(edit({ structuredPatch: [hunk], originalFile: "a\nb\n" }))).toBeNull();
  expect(workspaceSource(edit({ structuredPatch: [] }))).toBeNull();
});

test("editDiff without a patch falls back to the input's lines", () => {
  expect(editDiff(tool("Edit", { old_string: "a\nb", new_string: "c" }))).toEqual({
    hunks: [], fallback: [{ kind: "del", text: "a" }, { kind: "del", text: "b" }, { kind: "add", text: "c" }], added: 1, removed: 2,
  });
  expect(editDiff(tool("Write", { content: "x\ny" }, done))).toMatchObject({ added: 2, removed: 0 });
  // A final newline is not one more line.
  expect(editDiff(tool("Write", { content: "x\ny\n" }, done))).toMatchObject({ added: 2, removed: 0 });
  expect(editDiff(tool("MultiEdit", { edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d" }] })))
    .toMatchObject({ added: 2, removed: 2 });
});

test("a Write that creates a file numbers its lines", () => {
  const [edit] = buildThread([
    { seq: 1, message: { type: "assistant", message: { id: "m", content: [{ type: "tool_use", id: "w", name: "Write", input: { file_path: "/w/n.ts", content: "x\ny\n" } }] } } },
    { seq: 2, message: {
      type: "user", message: { content: [{ type: "tool_result", tool_use_id: "w", content: "created" }] },
      tool_use_result: { type: "create", filePath: "/w/n.ts", content: "x\ny\n", structuredPatch: [], originalFile: null },
    } },
  ]) as [ToolItem];
  expect(edit.result?.original).toBeUndefined();
  expect(editDiff(edit)).toEqual({
    hunks: [], fallback: [{ kind: "add", text: "x", new: 1 }, { kind: "add", text: "y", new: 2 }], added: 2, removed: 0,
  });
});

test("toolTarget names a path relative to the session, a pattern and where, or a subagent's task", () => {
  expect(toolTarget(tool("Edit", { file_path: "/w/src/a.ts" }), "/w")).toBe("src/a.ts");
  expect(toolTarget(tool("Grep", { pattern: "foo", path: "/w/src" }), "/w")).toBe("foo in src");
  expect(toolTarget(tool("Glob", { pattern: "*.ts" }), "/w")).toBe("*.ts");
  expect(toolTarget(tool("Agent", { description: "Review", prompt: "long" }), "/w")).toBe("Review");
  expect(toolTarget(tool("Bash", { command: "ls\n-la" }), "/w")).toBe("ls");
});

test("exitCode reads a failed command's code; paths show relative to the session's directory", () => {
  expect(exitCode(tool("Bash", {}, { text: "Exit code 2\nboom", isError: true }))).toBe(2);
  expect(exitCode(tool("Bash", {}, { text: "Error: Exit code 1", isError: true }))).toBe(1);
  expect(exitCode(tool("Bash", {}, { text: "Exit code 2", isError: false }))).toBeUndefined();
  expect(exitCode(tool("Bash", {}, { text: "denied", isError: true }))).toBeUndefined();
  const cwd = cwdOf([
    { message: { type: "system", subtype: "init", cwd: "/old" } },
    { message: { type: "system", subtype: "init", cwd: "/w" } },
    { message: { type: "user" } },
  ]);
  expect(cwd).toBe("/w");
  expect(relativePath("/w/src/a.ts", cwd)).toBe("src/a.ts");
  expect(relativePath("/wx/a.ts", cwd)).toBe("/wx/a.ts");
  expect(relativePath("/w/a.ts", "")).toBe("/w/a.ts");
  expect(cwdOf([])).toBe("");
});

test("a skill's text goes with its Skill call, not into the thread as a message from you", () => {
  const call = (seq: number, id: string, skill: string) =>
    ({ seq, message: { type: "assistant", message: { id: `m${seq}`, content: [{ type: "tool_use", id, name: "Skill", input: { skill } }] }, parent_tool_use_id: null } });
  const launched = (seq: number, id: string, skill: string) => ({
    seq,
    message: {
      type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: `Launching skill: ${skill}` }] },
      parent_tool_use_id: null, tool_use_result: { success: true, commandName: skill },
    },
  });
  const synthetic = (seq: number, text: string) =>
    ({ seq, message: { type: "user", message: { role: "user", content: [{ type: "text", text }] }, parent_tool_use_id: null, isSynthetic: true } });
  const items = buildThread([
    call(1, "tu1", "brainstorming"),
    launched(2, "tu1", "brainstorming"),
    synthetic(3, "Base directory for this skill: /s\n\n# Brainstorming"),
    { seq: 4, message: { type: "assistant", message: { id: "m4", content: [{ type: "text", text: "Using it" }] }, parent_tool_use_id: null } },
    // A skill that ran in a subagent sends no text: a later synthetic message is not its.
    call(5, "tu2", "forked"),
    launched(6, "tu2", "forked"),
    { seq: 7, message: { type: "assistant", message: { id: "m7", content: [{ type: "text", text: "Done" }] }, parent_tool_use_id: null } },
    synthetic(8, "something else"),
  ]);
  expect(items.map((i) => i.kind)).toEqual(["tool", "assistant", "tool", "assistant", "user"]);
  expect(items[0]).toMatchObject({ name: "Skill", result: { text: "Launching skill: brainstorming" }, skill: "Base directory for this skill: /s\n\n# Brainstorming" });
  expect((items[2] as ToolItem).skill).toBeUndefined();
  expect(items[4]).toEqual({ kind: "user", text: "something else", attachments: [] });
  expect(toolTarget(items[0] as ToolItem, "/w")).toBe("brainstorming");
});

test("a rate limit event says something only when the limit is not plainly allowed", () => {
  const items = buildThread([
    { seq: 1, message: { type: "rate_limit_event", rate_limit_info: { status: "allowed" } } },
    { seq: 2, message: { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", rateLimitType: "five_hour" } } },
  ]);
  expect(items).toEqual([{ kind: "status", text: "Rate limit allowed_warning (five_hour)" }]);
});

test("a task notification shows its summary, with how the task ended when the summary does not say", () => {
  const note = (seq: number, status: string, summary: string) =>
    ({ seq, message: { type: "system", subtype: "task_notification", task_id: "b1", status, summary } });
  const items = buildThread([
    note(1, "completed", "Sleep 3 seconds then echo first"),
    note(2, "failed", 'Background command "make" failed with exit code 2'),
    note(3, "stopped", ""),
  ]);
  expect(items).toEqual([
    { kind: "status", text: "Sleep 3 seconds then echo first (completed)" },
    { kind: "status", text: 'Background command "make" failed with exit code 2' },
    { kind: "status", text: "Task stopped" },
  ]);
});

test("progress frames and bare request statuses leave no item", () => {
  const items = buildThread([
    { seq: 1, message: { type: "system", subtype: "status", status: "requesting" } },
    { seq: 2, message: { type: "system", subtype: "thinking_tokens", estimated_tokens: 40, estimated_tokens_delta: 40 } },
    { seq: 3, message: { type: "tool_progress", tool_use_id: "tu1", tool_name: "Bash", elapsed_time_seconds: 3 } },
    { seq: 4, message: { type: "system", subtype: "status", status: null } },
    { seq: 5, message: { type: "system", subtype: "status", status: "compacting" } },
    { seq: 6, message: { type: "system", subtype: "status", status: null, permissionMode: "plan" } },
  ]);
  expect(items).toEqual([
    { kind: "status", text: "Status: compacting" },
    { kind: "status", text: "Status: permission mode plan" },
  ]);
});

test("activity says what a running turn is doing from the block streaming, else the call still running", () => {
  const live = (over: { text?: string; thinking?: string; block?: string; tool?: string }) => ({ text: "", thinking: "", ...over });
  // A thinking block whose text the API leaves out still says the turn is thinking.
  expect(activity(live({ block: "thinking" }), [])).toBe("Thinking");
  expect(activity(live({ thinking: "hm" }), [])).toBe("Thinking");
  expect(activity(live({ text: "Hel" }), [])).toBe("Writing");
  expect(activity(live({ text: "Done.", block: "thinking" }), [])).toBe("Thinking");
  expect(activity(live({ text: "Let me look.", block: "tool_use", tool: "Bash" }), [])).toBe("Writing a Bash call");
  expect(activity(live({ block: "tool_use" }), [])).toBe("Writing a tool call");

  const items = buildThread([
    { seq: 1, message: { type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] } } },
    { seq: 2, message: { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }] } } },
    { seq: 3, message: { type: "assistant", message: { id: "m2", content: [{ type: "tool_use", id: "t2", name: "Agent", input: {} }] } } },
    { seq: 4, message: { type: "assistant", message: { id: "m3", content: [{ type: "tool_use", id: "t3", name: "Bash", input: {} }] }, parent_tool_use_id: "t2" } },
  ]);
  expect(activity(null, items)).toBe("Running Agent › Bash");
  expect(activity(null, items.slice(0, 1))).toBe("Working");
  expect(activity(null, [])).toBe("Working");
});

test("activityLine: thinking says so longer the longer it runs; only a turn that should be streaming stalls", () => {
  expect(activityLine("Thinking", 3, 3)).toEqual({ text: "Thinking", stall: 0 });
  expect(activityLine("Thinking", 12, 12).text).toBe("Still thinking");
  expect(activityLine("Thinking", 50, 50)).toEqual({ text: "Deep in thought", stall: 0 });
  expect(activityLine("Running Bash", 300, 300).stall).toBe(0);
  expect(activityLine("Writing", 40, 9).stall).toBe(0);
  expect(activityLine("Writing", 40, 15).stall).toBe(0.5);
  expect(activityLine("Working", 40, 40)).toEqual({ text: "Working", stall: 1 });
  expect([duration(0), duration(59), duration(61), duration(3600)]).toEqual(["0s", "59s", "1m 1s", "60m 0s"]);
});

const call = (seq: number, id: string, name: string, input: object, parent: string | null = null) =>
  ({ seq, message: { type: "assistant", message: { id: `m${seq}`, content: [{ type: "tool_use", id, name, input }] }, parent_tool_use_id: parent } });
const answer = (seq: number, id: string, content: string, parent: string | null = null) =>
  ({ seq, message: { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content }] }, parent_tool_use_id: parent } });
const sys = (seq: number, subtype: string, over: object) => ({ seq, message: { type: "system", subtype, ...over } });
const agentStart = (seq: number, over: object = {}) =>
  sys(seq, "task_started", { task_id: "a1", tool_use_id: "tA", task_type: "local_agent", is_backgrounded: true, description: "Implement Task 3", ...over });

test("a background agent runs until its notice; its commands' notices mark their rows and stay out of the main thread", () => {
  const events = [
    call(1, "tA", "Agent", { description: "Implement Task 3", run_in_background: true, model: "sonnet" }),
    agentStart(2),
    answer(3, "tA", "Async agent launched successfully."),
    call(4, "tB", "Bash", { command: "bun test", run_in_background: true }, "tA"),
    sys(5, "task_started", { task_id: "c1", tool_use_id: "tB", task_type: "local_bash", is_backgrounded: true, parent_task_id: "a1" }),
    answer(6, "tB", "Command running in background with ID: c1", "tA"),
  ];
  const items = buildThread(events);
  expect(items).toHaveLength(1);
  const agent = items[0] as ToolItem;
  expect(agent).toMatchObject({ name: "Agent", background: true });
  expect(isRunning(agent)).toBe(true);
  expect(isRunning(agent.children[0] as ToolItem)).toBe(true);
  expect(backgroundMeta(agent.children[0] as ToolItem)).toBe("background");
  const later = buildThread([...events,
    sys(7, "task_notification", { task_id: "c1", tool_use_id: "tB", status: "completed", summary: 'Background command "bun test" completed (exit code 0)' })]);
  expect(later).toHaveLength(1);
  expect(backgroundMeta((later[0] as ToolItem).children[0] as ToolItem)).toBe("exit 0");
});

test("an agent's reports are its SubagentHandback messages; a SendMessage follow-up runs it again from its own row", () => {
  const events = [
    call(1, "tA", "Agent", { description: "Implement Task 3", run_in_background: true }),
    agentStart(2),
    answer(3, "tA", "Async agent launched successfully."),
    call(4, "tH", "SubagentHandback", { message: "Status: DONE_WITH_CONCERNS" }, "tA"),
    answer(5, "tH", "Report delivered to your caller.", "tA"),
    sys(6, "task_notification", { task_id: "a1", tool_use_id: "tA", status: "completed", summary: "This agent's report was delivered to you as a message…" }),
    call(7, "tS", "SendMessage", { to: "a1", summary: "Fix the fetcher", message: "Fix needed before review" }),
    answer(8, "tS", "Resuming agent a1"),
    agentStart(9, { tool_use_id: "tS", prompt: "Fix needed before review" }),
    call(10, "tH2", "SubagentHandback", { message: "Status: DONE" }, "tA"),
  ];
  const items = buildThread(events);
  const agent = items[0] as ToolItem;
  expect(agent.children).toEqual([]);
  expect(agent.reports).toEqual(["Status: DONE_WITH_CONCERNS", "Status: DONE"]);
  expect(isRunning(agent)).toBe(true);
  const send = items.find((i): i is ToolItem => i.kind === "tool" && i.name === "SendMessage")!;
  expect(send).toMatchObject({ resumes: "tA", background: true });
  expect(isRunning(send)).toBe(true);
  expect(items.filter((i) => i.kind === "status")).toEqual([{ kind: "status", text: 'Agent "Implement Task 3" finished' }]);
  const done = buildThread([...events, sys(11, "task_notification", { task_id: "a1", tool_use_id: "tS", status: "completed", summary: "" })]);
  expect(isRunning(done[0] as ToolItem)).toBe(false);
  expect(isRunning(done.find((i): i is ToolItem => i.kind === "tool" && i.name === "SendMessage")!)).toBe(false);
  expect(done.filter((i) => i.kind === "status")).toHaveLength(2);
});

test("an agent's notice that it has not reported yet says it waits on its own commands", () => {
  const items = buildThread([
    call(1, "tA", "Agent", { description: "Implement Task 7" }),
    agentStart(2),
    sys(3, "task_notification", { task_id: "a1", tool_use_id: "tA", status: "completed",
      summary: "This agent has not reported yet: it is waiting on its own background work and will deliver its report through SubagentHandback when that finishes." }),
  ]);
  expect(items.at(-1)).toEqual({ kind: "status", text: 'Agent "Implement Task 7" is waiting on its own commands' });
});

test("the line under the thread waits on agents while the main session has nothing of its own running", () => {
  const items = buildThread([call(1, "tA", "Agent", { description: "x" }), agentStart(2), answer(3, "tA", "Async agent launched successfully.")]);
  expect(activity(null, items, 2)).toBe("Waiting on 2 agents");
  expect(activity(null, items, 1)).toBe("Waiting on 1 agent");
  // An older node serves no count: the thread's own running background agents stand in.
  expect(activity(null, items)).toBe("Waiting on 1 agent");
  const busy = buildThread([call(1, "tA", "Agent", { description: "x" }), agentStart(2), answer(3, "tA", "Async agent launched successfully."), call(4, "tB", "Bash", { command: "ls" })]);
  expect(activity(null, busy, 2)).toBe("Running Bash");
  expect(activityLine("Waiting on 2 agents", 300, 300).stall).toBe(0);
});

test("a command's notice ends its row and keeps today's line at the top; a start or notice with no row stays as it was; a stopped agent says so", () => {
  const items = buildThread([
    call(1, "tB", "Bash", { command: "make", run_in_background: true }),
    sys(2, "task_started", { task_id: "c1", tool_use_id: "tB", task_type: "local_bash", is_backgrounded: true }),
    sys(3, "task_started", { task_id: "c2", tool_use_id: "gone", task_type: "local_bash", is_backgrounded: true }),
    sys(4, "task_notification", { task_id: "c1", tool_use_id: "tB", status: "failed", summary: 'Background command "make" failed with exit code 2' }),
    sys(5, "task_notification", { task_id: "c3", tool_use_id: "gone", status: "stopped", summary: "" }),
    call(6, "tM", "Monitor", { command: "tail -f log" }),
    sys(7, "task_started", { task_id: "m1", tool_use_id: "tM", task_type: "local_bash", is_backgrounded: true }),
    sys(8, "task_notification", { task_id: "m1", tool_use_id: "tM", status: "completed", summary: "Monitor ended" }),
    call(9, "tA", "Agent", { description: "Review Task 2" }),
    agentStart(10, { description: "Review Task 2" }),
    sys(11, "task_notification", { task_id: "a1", tool_use_id: "tA", status: "stopped", summary: "" }),
    // A report outside an agent's run is an ordinary call.
    call(12, "tH", "SubagentHandback", { message: "hi" }),
  ]);
  expect(items.map((i) => i.kind)).toEqual(["tool", "unknown", "status", "status", "tool", "status", "tool", "status", "tool"]);
  const [make, , madeLine, goneLine, watch, watchLine, agent, agentLine, stray] = items as [ToolItem, ThreadItem, ThreadItem, ThreadItem, ToolItem, ThreadItem, ToolItem, ThreadItem, ToolItem];
  expect(isRunning(make)).toBe(false);
  expect(backgroundMeta(make)).toBe("exit 2");
  expect(madeLine).toEqual({ kind: "status", text: 'Background command "make" failed with exit code 2' });
  expect(goneLine).toEqual({ kind: "status", text: "Task stopped" });
  expect(backgroundMeta(watch)).toBe("ended");
  expect(watchLine).toEqual({ kind: "status", text: "Monitor ended (completed)" });
  expect(backgroundMeta(agent)).toBe("stopped");
  expect(agentLine).toEqual({ kind: "status", text: 'Agent "Review Task 2" stopped' });
  expect(stray).toMatchObject({ name: "SubagentHandback" });
  expect(backgroundMeta(stray)).toBeNull();
  expect(isRunning(stray)).toBe(true);
});

test("a call of the session's own running before a background agent is what the line says", () => {
  const items = buildThread([call(1, "tB", "Bash", { command: "ls" }), call(2, "tA", "Agent", { description: "x" }), agentStart(3), answer(4, "tA", "Async agent launched successfully.")]);
  expect(activity(null, items, 1)).toBe("Running Bash");
  expect(activity(null, [])).toBe("Working");
});

test("a resumed agent's row runs in the background again whatever its start says, until the next notice", () => {
  const ended = (seq: number, toolUseId: string) => sys(seq, "task_notification", { task_id: "a1", tool_use_id: toolUseId, status: "completed", summary: "" });
  const events = [
    call(1, "tA", "Agent", { description: "Implement Task 3", run_in_background: true }),
    agentStart(2),
    answer(3, "tA", "Async agent launched successfully."),
    ended(4, "tA"),
  ];
  const running = (more: Array<{ seq: number; message: unknown }>) => isRunning(buildThread([...events, ...more])[0] as ToolItem);
  expect(running([])).toBe(false);
  // A follow-up from a SendMessage call, its start without `is_backgrounded`.
  const followUp = [
    call(5, "tS", "SendMessage", { to: "a1", summary: "Fix it", message: "Fix it" }),
    answer(6, "tS", "Resuming agent a1"),
    agentStart(7, { tool_use_id: "tS", prompt: "Fix it", is_backgrounded: undefined }),
  ];
  expect(running(followUp)).toBe(true);
  expect(running([...followUp, ended(8, "tS")])).toBe(false);
  // A wake: the same task and call as the Agent's own, its prompt a notice, its start without `is_backgrounded`.
  const wake = agentStart(9, { prompt: "<task-notification>a command ended</task-notification>", is_backgrounded: undefined });
  expect(running([...followUp, ended(8, "tS"), wake])).toBe(true);
  expect(running([...followUp, ended(8, "tS"), wake, ended(10, "tA")])).toBe(false);
});

test("holdsCall tells whether the events hold a call's tool_use, its start or result alone not counting", () => {
  const events = [call(1, "tA", "Agent", { description: "Implement Task 3" }), agentStart(2, { task_id: "a2", tool_use_id: "tZ" }), answer(3, "tZ", "done")];
  expect(holdsCall(events, "tA")).toBe(true);
  expect(holdsCall(events, "tZ")).toBe(false);
  expect(holdsCall([], "tA")).toBe(false);
});

test("missingCalls names the calls the events refer to that no loaded tool_use defines, once each, in first-seen order", () => {
  // An agent's messages (its own calls defined among them) whose Agent call is older than the events.
  expect(missingCalls([call(5, "tB", "Bash", { command: "ls" }, "tA"), answer(6, "tB", "a", "tA"), call(7, "tC", "Read", { file_path: "x" }, "tA")])).toEqual(["tA"]);
  // Notices and starts whose call is older than the events.
  expect(missingCalls([
    sys(1, "task_notification", { task_id: "c1", tool_use_id: "tB", status: "completed", summary: "done" }),
    sys(2, "task_started", { task_id: "c2", tool_use_id: "tC", task_type: "local_bash" }),
    answer(3, "tD", "a", "tA"),
    sys(4, "task_notification", { task_id: "c1", tool_use_id: "tB", status: "completed", summary: "done" }),
  ])).toEqual(["tB", "tC", "tA"]);
  // Nothing missing: every call is in, none is named, or a name is "" or not a string; other events' ids do not count.
  const agent = [
    call(1, "tA", "Agent", { description: "Implement Task 3", run_in_background: true }),
    agentStart(2),
    answer(3, "tA", "Async agent launched successfully."),
    call(4, "tB", "Bash", { command: "bun test", run_in_background: true }, "tA"),
    sys(5, "task_started", { task_id: "c1", tool_use_id: "tB", task_type: "local_bash", is_backgrounded: true, parent_task_id: "a1" }),
    sys(6, "task_notification", { task_id: "c1", tool_use_id: "tB", status: "completed", summary: "done" }),
  ];
  expect(missingCalls(agent)).toEqual([]);
  expect(missingCalls([
    answer(1, "x", "a", ""),
    { message: { type: "assistant", message: { content: [{ type: "text", text: "hi" }] }, parent_tool_use_id: 7 } },
    sys(3, "task_notification", { task_id: "c1", status: "stopped", summary: "" }),
    sys(4, "permission_denied", { tool_name: "Bash", tool_use_id: "tZ" }),
    { message: { type: "stream_event", event: {}, parent_tool_use_id: "tY" } },
  ])).toEqual([]);
  expect(missingCalls([])).toEqual([]);
  // A call defined later in the same events counts as defined.
  expect(missingCalls([answer(1, "tB", "a", "tA"), sys(2, "task_notification", { task_id: "a1", tool_use_id: "tA", status: "completed", summary: "" }), call(3, "tA", "Agent", { description: "x" })])).toEqual([]);
});

test("a background call whose notice never came reads stopped once the agent it ran in has finished", () => {
  const events = [
    call(1, "tA", "Agent", { description: "Implement Task 3", run_in_background: true }),
    agentStart(2),
    call(3, "tB", "Bash", { command: "bun test", run_in_background: true }, "tA"),
    sys(4, "task_started", { task_id: "c1", tool_use_id: "tB", task_type: "local_bash", is_backgrounded: true, parent_task_id: "a1" }),
    call(5, "tM", "Monitor", { command: "tail -f log" }, "tA"),
    sys(6, "task_started", { task_id: "m1", tool_use_id: "tM", task_type: "local_bash", is_backgrounded: true, parent_task_id: "a1" }),
    sys(7, "task_notification", { task_id: "c1", tool_use_id: "tB", status: "completed", summary: 'Background command "bun test" completed (exit code 0)' }),
  ];
  const [bash, monitor] = (buildThread(events)[0] as ToolItem).children as [ToolItem, ToolItem];
  expect([backgroundMeta(monitor), backgroundMeta(monitor, false)]).toEqual(["background", "stopped"]);
  // A notice that came says how it ended, whatever became of the agent.
  expect(backgroundMeta(bash, false)).toBe("exit 0");
  expect(backgroundMeta(buildThread([call(1, "tB", "Bash", { command: "ls" })])[0] as ToolItem, false)).toBeNull();
});

test("a row runs as the agent list says for an agent's call, else as the call does while what holds it runs", () => {
  // What holds a row: the agent whose row holds it, or at the top the task's turn. A running call in a live turn runs.
  expect(callRuns(undefined, true, true)).toBe(true);
  expect(callRuns(undefined, true, false)).toBe(false);
  expect(callRuns(undefined, false, true)).toBe(false);
  // An agent's call runs as its entry says, a wake or follow-up after its notice included, whatever holds it.
  expect(callRuns("running", false, false)).toBe(true);
  expect(callRuns("completed", true, true)).toBe(false);
  expect(callRuns("stopped", true, true)).toBe(false);
  expect(callRuns("failed", true, true)).toBe(false);
});

test("the main session's own background call whose notice never came reads stopped once the task's turn is not live", () => {
  const [bash, monitor] = buildThread([
    call(1, "tB", "Bash", { command: "bun test", run_in_background: true }),
    sys(2, "task_started", { task_id: "c1", tool_use_id: "tB", task_type: "local_bash", is_backgrounded: true }),
    call(3, "tM", "Monitor", { command: "tail -f log" }),
    sys(4, "task_started", { task_id: "m1", tool_use_id: "tM", task_type: "local_bash", is_backgrounded: true }),
  ]) as [ToolItem, ToolItem];
  for (const tool of [bash, monitor]) {
    expect([backgroundMeta(tool, true), callRuns(undefined, isRunning(tool), true)]).toEqual(["background", true]);
    expect([backgroundMeta(tool, false), callRuns(undefined, isRunning(tool), false)]).toEqual(["stopped", false]);
  }
});

test("a stopped agent's row says it stopped before it reported, and a failed one that it failed, with its notice's text", () => {
  expect(agentEndNote(false, false, undefined)).toBe("Stopped before it reported");
  expect(agentEndNote(false, true, "")).toBe("Stopped before it reported: the session ended");
  expect(agentEndNote(true, false, "API Error: 529 overloaded")).toBe("Failed: API Error: 529 overloaded");
  expect(agentEndNote(true, false, "")).toBe("Failed");
  expect(agentEndNote(true, false, undefined)).toBe("Failed");
});
