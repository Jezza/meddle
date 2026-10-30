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
