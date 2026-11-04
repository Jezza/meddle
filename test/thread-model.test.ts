// test/thread-model.test.ts
import { test, expect } from "bun:test";
import { buildThread, foldSteps, toolsLine, toolSummary, type ThreadItem } from "../src/dashboard/ui/thread-model";
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
  expect(toolsLine(run.tools)).toEqual({ named: [{ name: "Read", summary: "a.rs" }, { name: "Grep", summary: "take_event" }], more: 1 });
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
