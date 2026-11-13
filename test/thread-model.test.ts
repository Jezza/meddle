// test/thread-model.test.ts
import { test, expect } from "bun:test";
import {
  activity, activityLine, buildThread, cwdOf, duration, editDiff, exitCode, exploredLine, foldSteps, keyOf, relativePath, toolSummary,
  toolTarget, type ThreadItem, type ToolItem,
} from "../src/dashboard/ui/thread-model";
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
  expect(items).toEqual([{ kind: "user", text: "Run: echo hi" }]);
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
    { kind: "user", text: "hi" }, thinking, read, vcs, grep, thinking, edit, bash,
    { kind: "assistant", text: "", thinking: "" }, tool("Read", { file_path: "b.rs" }),
  ];
  expect(foldSteps(items)).toEqual([
    { kind: "user", text: "hi" },
    { kind: "explored", steps: [thinking, read, grep, thinking] as never },
    edit,
    bash,
    { kind: "explored", steps: [tool("Read", { file_path: "b.rs" })] },
  ]);
  // Raw shows the unknown message, which splits the run.
  expect(foldSteps(items, true).map((i) => i.kind)).toEqual(["user", "explored", "unknown", "explored", "tool", "tool", "explored"]);
  // Thinking with no look after it stays on its own.
  expect(foldSteps([thinking, edit])).toEqual([thinking, edit]);
  // Prose between two looks splits them; a message the thread does not know shows, unless it only keeps the books.
  const odd: ThreadItem = { kind: "unknown", type: "system:api_retry", raw: {} };
  expect(foldSteps([read, { kind: "assistant", text: "so" }, grep, odd]).map((i) => i.kind)).toEqual(["explored", "assistant", "explored", "unknown"]);
  expect(keyOf(foldSteps([read, grep])[0]!)).toBe(read.toolUseId);
  expect(keyOf(edit)).toBe(edit.toolUseId);
  expect(keyOf({ kind: "user", text: "x" })).toBeUndefined();
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

test("an Edit's result keeps its patch, and editDiff numbers its lines", () => {
  const [edit] = buildThread([
    { seq: 1, message: { type: "assistant", message: { id: "m", content: [{ type: "tool_use", id: "e", name: "Edit", input: { file_path: "/w/a.ts", old_string: "b", new_string: "B\nc" } }] } } },
    { seq: 2, message: {
      type: "user", message: { content: [{ type: "tool_result", tool_use_id: "e", content: "updated" }] },
      tool_use_result: { structuredPatch: [{ oldStart: 4, oldLines: 2, newStart: 4, newLines: 3, lines: [" a", "-b", "+B", "+c"] }, { bad: true }] },
    } },
  ]) as [ToolItem];
  expect(edit.result?.patch).toHaveLength(1);
  expect(editDiff(edit)).toEqual({
    lines: [
      { kind: "hunk", text: "@@ -4,2 +4,3 @@" },
      { kind: "same", text: "a", line: 4 },
      { kind: "del", text: "b", line: 5 },
      { kind: "add", text: "B", line: 5 },
      { kind: "add", text: "c", line: 6 },
    ],
    added: 2,
    removed: 1,
  });
});

test("editDiff without a patch shows the input's old lines removed and new lines added", () => {
  expect(editDiff(tool("Edit", { old_string: "a\nb", new_string: "c" }))).toEqual({
    lines: [{ kind: "del", text: "a" }, { kind: "del", text: "b" }, { kind: "add", text: "c" }], added: 1, removed: 2,
  });
  expect(editDiff(tool("Write", { content: "x\ny" }, done))).toMatchObject({ added: 2, removed: 0 });
  // A final newline is not one more line.
  expect(editDiff(tool("Write", { content: "x\ny\n" }, done))).toMatchObject({ added: 2, removed: 0 });
  expect(editDiff(tool("MultiEdit", { edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d" }] })))
    .toMatchObject({ added: 2, removed: 2 });
});

test("editDiff numbers each hunk from its own start", () => {
  const patch = [
    { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] },
    { oldStart: 40, oldLines: 2, newStart: 40, newLines: 1, lines: [" c", "-d", "\\ No newline at end of file"] },
  ];
  expect(editDiff(tool("Edit", {}, { ...done, patch })).lines).toEqual([
    { kind: "hunk", text: "@@ -1,1 +1,1 @@" }, { kind: "del", text: "a", line: 1 }, { kind: "add", text: "b", line: 1 },
    { kind: "hunk", text: "@@ -40,2 +40,1 @@" }, { kind: "same", text: "c", line: 40 }, { kind: "del", text: "d", line: 41 },
  ]);
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

test("a rate limit event says something only when the limit is not plainly allowed", () => {
  const items = buildThread([
    { seq: 1, message: { type: "rate_limit_event", rate_limit_info: { status: "allowed" } } },
    { seq: 2, message: { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", rateLimitType: "five_hour" } } },
  ]);
  expect(items).toEqual([{ kind: "status", text: "Rate limit allowed_warning (five_hour)" }]);
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
