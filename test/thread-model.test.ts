// test/thread-model.test.ts
import { test, expect } from "bun:test";
import { activity, activityLine, buildThread, duration, foldSteps, stepsLine, toolSummary, type Step, type ThreadItem } from "../src/dashboard/ui/thread-model";
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

test("foldSteps folds each run of tool calls, thinking and unknown messages into one line", () => {
  const tool = (name: string, input: unknown): ThreadItem => ({ kind: "tool", name, input, toolUseId: name, children: [] });
  const thinking: ThreadItem = { kind: "assistant", text: "", thinking: "hmm" };
  const vcs: ThreadItem = { kind: "unknown", type: "system:vcs_state_changed", raw: {} };
  const items: ThreadItem[] = [
    { kind: "user", text: "hi" },
    thinking,
    tool("Read", { file_path: "a.rs" }),
    thinking,
    tool("Grep", { pattern: "take_event" }),
    vcs,
    tool("Read", { file_path: "b.rs" }),
    { kind: "assistant", text: "found it", thinking: "so" },
    tool("Bash", { command: "cargo check\n--all" }),
  ];
  const shown = foldSteps(items);
  expect(shown.map((i) => i.kind)).toEqual(["user", "steps", "assistant", "steps"]);
  const run = shown[1] as Extract<typeof shown[number], { kind: "steps" }>;
  expect(run.steps).toEqual(items.slice(1, 7) as typeof run.steps);
  expect(run.tools.map((t) => t.toolUseId)).toEqual(["Read", "Grep", "Read"]);
  expect(stepsLine(run.steps)).toEqual({ text: "Reading 2 files, searching for 1 pattern, 1 event…", running: true, failed: 0 });
  expect(toolSummary({ command: "cargo check\n--all" })).toBe("cargo check");
  expect(toolSummary({ prompt: "x".repeat(10) }, 4)).toBe("xxxx…");
});

test("foldSteps folds a run of unknown messages alone too", () => {
  const unknown = (type: string): ThreadItem => ({ kind: "unknown", type, raw: { type } });
  const shown = foldSteps([unknown("x"), { kind: "assistant", text: "", thinking: "" }, unknown("y"), { kind: "assistant", text: "hi" }]);
  expect(shown).toEqual([
    { kind: "steps", steps: [unknown("x"), unknown("y")] as never, tools: [] },
    { kind: "assistant", text: "hi" },
  ]);
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

test("stepsLine says what a run did, a lone call by what it did, each kind in the present while one of it runs", () => {
  const done = { text: "", isError: false };
  const tool = (name: string, input: unknown, result?: { text: string; isError: boolean }): Step =>
    ({ kind: "tool", name, input, toolUseId: `${name}${JSON.stringify(input)}`, children: [], ...(result && { result }) });
  expect(stepsLine([tool("Bash", { command: "cargo check\n--all" }, done)])).toEqual({ text: "Ran cargo check", running: false, failed: 0 });
  expect(stepsLine([tool("Bash", { command: "cargo check" })]).text).toBe("Running cargo check…");
  expect(stepsLine([tool("Agent", { description: "Explore" }, done)]).text).toBe("Ran agent: Explore");
  expect(stepsLine([tool("mcp__x__y", {}, done)]).text).toBe("Called mcp__x__y");
  expect(stepsLine([tool("Bash", { command: "a" }, done), tool("Read", { file_path: "b" })]))
    .toEqual({ text: "Ran 1 command, reading 1 file…", running: true, failed: 0 });
  expect(stepsLine([
    tool("Edit", { file_path: "a" }, done), tool("Foo", { x: 1 }, done), tool("Edit", { file_path: "b" }, { text: "no", isError: true }),
    tool("Foo", { x: 2 }, done), { kind: "assistant", text: "", thinking: "hm" },
  ])).toEqual({ text: "Edited 2 files, called Foo 2 times", running: false, failed: 1 });
  expect(stepsLine([{ kind: "assistant", text: "", thinking: "hm" }]).text).toBe("");
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
