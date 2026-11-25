import { test, expect } from "bun:test";
import { EMPTY_AGENT_LOG, foldAgentLog, runningCount, servedAgents } from "../src/state/agents";

const at = (min: number) => `2026-11-17T19:${String(min).padStart(2, "0")}:00.000Z`;
const e = (seq: number, min: number, message: object) => ({ seq, at: at(min), message });
const turn = (seq: number, min: number) => e(seq, min, { type: "meddle", subtype: "turn_started", at: at(min), resume: false });
const started = (seq: number, min: number, over: object = {}) => e(seq, min, {
  type: "system", subtype: "task_started", task_id: "a1", tool_use_id: "tu1", description: "Implement Task 3",
  subagent_type: "general-purpose", is_backgrounded: true, task_type: "local_agent", ...over,
});
const progress = (seq: number, min: number, description: string, tools: number, tokens: number, ms: number) => e(seq, min, {
  type: "system", subtype: "task_progress", task_id: "a1", tool_use_id: "tu1", description,
  usage: { total_tokens: tokens, tool_uses: tools, duration_ms: ms },
});
const notice = (seq: number, min: number, status: string, over: object = {}) =>
  e(seq, min, { type: "system", subtype: "task_notification", task_id: "a1", tool_use_id: "tu1", status, summary: "", ...over });
const command = (id: string, over: object = {}) => ({ task_id: id, task_type: "local_bash", parent_task_id: "a1", description: id, ...over });
const live = (seq: number, min: number, tasks: object[]) => e(seq, min, { type: "system", subtype: "background_tasks_changed", tasks });

test("an agent runs from its start to its notice, with its latest step and numbers", () => {
  const log = foldAgentLog(EMPTY_AGENT_LOG, [turn(1, 0), started(2, 1), progress(3, 2, "Running bun test", 31, 79502, 205904)]);
  expect(servedAgents(log, true)).toEqual([{
    id: "a1", toolUseId: "tu1", seq: 2, description: "Implement Task 3", agentType: "general-purpose", background: true,
    parent: null, state: "running", orphaned: false, doing: "Running bun test", commands: 0, tools: 31, tokens: 79502,
    ms: 205904, startedAt: at(1), endedAt: null,
  }]);
  const done = foldAgentLog(log, [notice(4, 8, "completed", { usage: { total_tokens: 99089, tool_uses: 44, duration_ms: 445183 } })]);
  expect(servedAgents(done, true)[0]).toMatchObject({ state: "completed", doing: null, tools: 44, tokens: 99089, ms: 445183, endedAt: at(8) });
  expect(runningCount(servedAgents(done, true))).toBe(0);
});

test("events the fold does not read, and commands' own starts, leave the log as it was", () => {
  const log = foldAgentLog(EMPTY_AGENT_LOG, [started(1, 1)]);
  const bash = e(3, 2, { type: "system", subtype: "task_started", task_id: "c1", tool_use_id: "tu9", task_type: "local_bash", description: "bun test" });
  expect(foldAgentLog(log, [e(2, 2, { type: "assistant", message: {} }), bash])).toBe(log);
});

test("an event whose message is not an object is passed over", () => {
  const log = foldAgentLog(EMPTY_AGENT_LOG, [started(1, 1)]);
  expect(foldAgentLog(log, [e(2, 2, null as never), e(3, 2, "text" as never)])).toBe(log);
});

test("an agent 'completed' while its own commands run is still running, waiting on them; its wake keeps its start", () => {
  let log = foldAgentLog(EMPTY_AGENT_LOG, [turn(1, 0), started(2, 1)]);
  log = foldAgentLog(log, [
    live(3, 2, [command("c1"), command("c2"), command("w1", { ambient: true })]),
    notice(4, 3, "completed", { summary: "This agent has not reported yet: it is waiting on its own background work…" }),
  ]);
  expect(servedAgents(log, true)[0]).toMatchObject({ state: "running", commands: 2, doing: "c1, c2", endedAt: null });
  log = foldAgentLog(log, [live(5, 4, [command("c2")]), started(6, 4, { prompt: "<task-notification>\n<task-id>c1</task-id>" })]);
  expect(servedAgents(log, true)[0]).toMatchObject({ state: "running", startedAt: at(1), commands: 1 });
  log = foldAgentLog(log, [live(7, 6, []), notice(8, 6, "completed")]);
  expect(servedAgents(log, true)[0]).toMatchObject({ state: "completed", commands: 0, endedAt: at(6) });
});

test("a follow-up sent with SendMessage runs the agent again on its own row, timed from the follow-up", () => {
  let log = foldAgentLog(EMPTY_AGENT_LOG, [turn(1, 0), started(2, 1), notice(3, 8, "completed")]);
  log = foldAgentLog(log, [started(4, 9, { tool_use_id: "tu-send", prompt: "Fix needed before review" })]);
  expect(servedAgents(log, true)[0]).toMatchObject({ state: "running", toolUseId: "tu1", seq: 2, startedAt: at(9), endedAt: null });
});

test("an agent left running is stopped once no turn is live, or once a later turn started", () => {
  const log = foldAgentLog(EMPTY_AGENT_LOG, [turn(1, 0), started(2, 1), progress(3, 2, "Running grep", 6, 23260, 8316)]);
  expect(servedAgents(log, true)[0]).toMatchObject({ state: "running", orphaned: false });
  expect(servedAgents(log, false)[0]).toMatchObject({ state: "stopped", orphaned: true, doing: null });
  // The node restarted and resumed the turn: a new process, the agent's run older than it.
  const resumed = foldAgentLog(log, [turn(4, 59)]);
  expect(servedAgents(resumed, true)[0]).toMatchObject({ state: "stopped", orphaned: true, endedAt: null });
  // Claude Code's own stop notice for it at the new process's start changes nothing visible.
  const told = foldAgentLog(resumed, [notice(5, 59, "stopped", { reason: "worker_restart" })]);
  expect(servedAgents(told, true)).toEqual(servedAgents(resumed, true));
  expect(servedAgents(told, false)).toEqual(servedAgents(resumed, true));
});

test("an agent waiting on its commands when the session dies is stopped", () => {
  const log = foldAgentLog(EMPTY_AGENT_LOG, [turn(1, 0), started(2, 1), live(3, 2, [command("c1")]), notice(4, 3, "completed")]);
  expect(servedAgents(log, false)[0]).toMatchObject({ state: "stopped", orphaned: true, commands: 1 });
});

test("an agent waiting on its commands when a new process starts stays stopped, whatever that process says of its own", () => {
  const log = foldAgentLog(EMPTY_AGENT_LOG, [turn(1, 0), started(2, 1), live(3, 2, [command("c1")]), notice(4, 3, "completed")]);
  const next = foldAgentLog(log, [turn(5, 59)]);
  expect(next.commands).toEqual({});
  const stopped = { state: "stopped", orphaned: true, commands: 0, doing: null, endedAt: at(3) };
  expect(servedAgents(next, true)[0]).toMatchObject(stopped);
  // The new process's own background work, none of it the agent's; then its stop notice for the agent.
  const later = foldAgentLog(next, [live(6, 59, [command("c9", { parent_task_id: null })]), live(7, 59, []), notice(8, 59, "stopped")]);
  expect(servedAgents(later, true)[0]).toMatchObject(stopped);
});

test("an agent stopped with its process runs again on a follow-up, no longer orphaned", () => {
  const log = foldAgentLog(EMPTY_AGENT_LOG, [turn(1, 0), started(2, 1), turn(3, 50), started(4, 51, { tool_use_id: "tu-send", prompt: "Carry on" })]);
  expect(servedAgents(log, true)[0]).toMatchObject({ state: "running", orphaned: false, startedAt: at(51) });
  expect(servedAgents(foldAgentLog(log, [notice(5, 52, "stopped")]), true)[0]).toMatchObject({ state: "stopped", orphaned: false, endedAt: at(52) });
});

test("running agents come first, newest first, then finished ones, last ended first", () => {
  const log = foldAgentLog(EMPTY_AGENT_LOG, [
    turn(1, 0),
    started(2, 1, { task_id: "old", tool_use_id: "t-old", is_backgrounded: false }), notice(3, 2, "completed", { task_id: "old" }),
    started(4, 3, { task_id: "mid", tool_use_id: "t-mid" }), notice(5, 9, "failed", { task_id: "mid" }),
    started(6, 4, { task_id: "r1", tool_use_id: "t-r1" }),
    started(7, 5, { task_id: "r2", tool_use_id: "t-r2", parent_task_id: "r1", spawn_depth: 2 }),
  ]);
  const served = servedAgents(log, true);
  expect(served.map((a) => [a.id, a.state])).toEqual([["r2", "running"], ["r1", "running"], ["mid", "failed"], ["old", "completed"]]);
  expect(served[0]!.parent).toBe("r1");
  expect(served.at(-1)!.background).toBe(false);
  expect(runningCount(served)).toBe(2);
});

test("a foreground agent moved to the background says so; one started without a call has no row", () => {
  const moved = foldAgentLog(EMPTY_AGENT_LOG, [started(1, 1, { is_backgrounded: false }),
    e(2, 2, { type: "system", subtype: "task_updated", task_id: "a1", patch: { is_backgrounded: true } })]);
  expect(servedAgents(moved, true)[0]!.background).toBe(true);
  const bare: Record<string, unknown> = { ...started(1, 1).message };
  delete bare.tool_use_id;
  expect(servedAgents(foldAgentLog(EMPTY_AGENT_LOG, [e(1, 1, bare)]), true)[0]).toMatchObject({ id: "a1", toolUseId: "" });
});

test("an agent's Bash step is the description the agent gave it; its other steps stay as Claude Code says them", () => {
  const step = (description: string, tool: string) => e(3, 2, {
    type: "system", subtype: "task_progress", task_id: "a1", tool_use_id: "tu1", description, last_tool_name: tool,
    usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 },
  });
  const log = foldAgentLog(EMPTY_AGENT_LOG, [turn(1, 0), started(2, 1)]);
  expect(servedAgents(foldAgentLog(log, [step("Running Run affected tests", "Bash")]), true)[0]!.doing).toBe("Run affected tests");
  expect(servedAgents(foldAgentLog(log, [step("Reading src/state/agents.ts", "Read")]), true)[0]!.doing).toBe("Reading src/state/agents.ts");
});

test("an agent waiting on commands none of which has a description says how many", () => {
  const log = foldAgentLog(EMPTY_AGENT_LOG, [
    turn(1, 0), started(2, 1), live(3, 2, [command("c1", { description: undefined })]), notice(4, 3, "completed"),
  ]);
  expect(servedAgents(log, true)[0]).toMatchObject({ state: "running", commands: 1, doing: "Waiting on 1 command" });
});
