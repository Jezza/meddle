// test/fake-claude/replay.test.ts
import { test, expect } from "bun:test";
import { query } from "@anthropic-ai/claude-agent-sdk";
test("the SDK drives the replayer through a recorded hello session", async () => {
  const seen: string[] = [];
  const q = query({ prompt: "Reply with the single word ok.", options: {
    pathToClaudeCodeExecutable: `${import.meta.dir}/replay.ts`, executable: "bun",
    env: { ...process.env, MEDDLE_FIXTURE: `${import.meta.dir}/../fixtures/hello.jsonl` },
    settingSources: [], permissionMode: "auto", tools: [],
  }});
  for await (const m of q) seen.push(m.type);
  expect(seen[0]).toBe("system");
  expect(seen.at(-1)).toBe("result");
});

test("the SDK asks canUseTool once while replaying a recorded approval session", async () => {
  const seen: string[] = [];
  const asked: string[] = [];
  const q = query({ prompt: "Run: echo hi", options: {
    pathToClaudeCodeExecutable: `${import.meta.dir}/replay.ts`, executable: "bun",
    env: { ...process.env, MEDDLE_FIXTURE: `${import.meta.dir}/../fixtures/approval.jsonl` },
    settingSources: [], permissionMode: "default", tools: ["Bash"],
    canUseTool: async (toolName, input) => {
      asked.push(toolName);
      return { behavior: "allow", updatedInput: input };
    },
  }});
  for await (const m of q) seen.push(m.type);
  expect(asked).toEqual(["Bash"]);
  expect(seen.at(-1)).toBe("result");
});

test("the replayer speaks of the user messages it was sent by their own uuids, not the recording's", async () => {
  const prompt = { uuid: crypto.randomUUID(), text: "Reply with the single word ok." };
  const steer = { uuid: crypto.randomUUID(), text: "Also: end your reply with the word PINEAPPLE." };
  const send = (m: typeof prompt) => ({ type: "user" as const, message: { role: "user" as const, content: m.text }, parent_tool_use_id: null, session_id: "", priority: "next" as const, uuid: m.uuid });
  let wake = () => {};
  let steered = false, ended = false;
  async function* input() {
    yield send(prompt);
    while (!steered) await new Promise<void>(r => { wake = r; });
    yield send(steer);
    while (!ended) await new Promise<void>(r => { wake = r; });
  }
  const q = query({ prompt: input(), options: {
    pathToClaudeCodeExecutable: `${import.meta.dir}/replay.ts`, executable: "bun",
    env: { ...process.env, MEDDLE_FIXTURE: `${import.meta.dir}/../fixtures/steer-turn.jsonl` },
    settingSources: [], permissionMode: "auto", tools: [],
  }});
  const lifecycles: [string, string][] = [];
  const consumed: string[][] = [];
  for await (const m of q as AsyncIterable<any>) {
    if (m.type === "assistant" && !steered) { steered = true; wake(); }
    if (m.type === "command_lifecycle") lifecycles.push([m.command_uuid, m.state]);
    if (m.type === "result") consumed.push(m.user_message_uuids);
    if (m.type === "result" && consumed.length === 2) { ended = true; wake(); }
  }
  expect(consumed).toEqual([[prompt.uuid], [steer.uuid]]);
  expect(lifecycles).toEqual([
    [prompt.uuid, "queued"], [prompt.uuid, "started"], [steer.uuid, "queued"], [prompt.uuid, "completed"],
    [steer.uuid, "started"], [steer.uuid, "completed"],
  ]);
});
