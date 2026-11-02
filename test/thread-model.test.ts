// test/thread-model.test.ts
import { test, expect } from "bun:test";
import { buildThread } from "../src/dashboard/ui/thread-model";
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
  expect(items[1]).toEqual({ kind: "user", text: "Run: echo hi" });
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
