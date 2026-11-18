# Sub-agents You Can See Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show every sub-agent of a task: a running count in the sidebar, a list of the task's agents above the
message box, and agent rows in the thread that spin until the agent is done and end with its report, with nothing an
agent runs leaking into the main thread.

**Architecture:** The node folds each task's `task_*` notices (and `meddle` `turn_started`) into an agent log and
serves it on `TaskObject` as `agents` and `agentsRunning`, marking agents stopped once no Claude Code process is left
to run them. The dashboard's pure thread model routes notices to the rows that started them and takes an agent's
`SubagentHandback` messages as its report; a pure panel model formats the list; the task page and sidebar render both.

**Tech Stack:** TypeScript on bun, TypeBox contracts, chord remote objects, Preact, bun:test.

**Spec:** `docs/superpowers/specs/2026-11-18-subagents-design.md` (read it first; this plan argues from it).

## Global Constraints

- Version control is jj: commit each task with `jj commit -m "<one plain sentence>"`, in the repo's style ("Keep a
  turn alive for background work"). No AI attribution in messages.
- bun is `~/.bun/bin/bun` (not on PATH). Run only the test files a task names, plus `~/.bun/bin/bun run typecheck`;
  never the whole suite.
- `agentProgressSummaries` stays off; no SDK option changes; no stop or message controls.
- A node older than this change serves neither `agents` nor `agentsRunning`: the dashboard reads both as optional
  (an empty list, 0) and shows no panel and no count for its tasks.
- `src/state/agents.ts`, `src/dashboard/ui/thread-model.ts` and `src/dashboard/ui/agents-model.ts` stay pure (no
  Preact, no DOM, no database).
- The wording the spec fixes: `Agent "<description>" finished|stopped|failed`, `Agent "<description>" is waiting on
  its own commands`, `Waiting on N commands`, `Waiting on N agents`, `Stopped before it reported`.

## Review Focus

- **A task on a node older than this change:** no `agents` member. Expected: no panel, no sidebar count, no error.
  Pinned in Task 4 (empty inputs) and Task 5 (read through `useOptionalValue`).
- **The node restarts mid-agent and resumes the turn:** a new `turn_started` comes after the agent's run. Expected:
  the agent shows stopped, not running forever. Pinned in Task 1.
- **An agent waiting on its own commands when the session dies.** Expected: stopped, not "Waiting on N commands".
  Pinned in Task 1.
- **Clicking an agent whose Agent call is older than the loaded 200 events.** Expected: earlier events load until its
  row is in, then it opens. Pinned in Task 5 (the `seq` it loads to) and checked by hand in Task 6.
- **A long-lived task with dozens of agents.** Expected: running ones, then the newest 3 finished, the rest counted
  in one line; the panel never grows past its cap. Pinned in Task 4.

---

### Task 1: Fold a task's agents from its log

**Files:**
- Modify: `src/state/contracts.ts` (beside `TaskLogSchema`)
- Create: `src/state/agents.ts`
- Modify: `src/store/events.ts`
- Test: `test/agents.test.ts` (new), `test/events.test.ts`

**Interfaces:**
- Produces, in `src/state/contracts.ts`:
  - `AgentEntrySchema` / `type AgentEntry = { id: string; toolUseId: string; seq: number; description: string;
    agentType: string | null; background: boolean; parent: string | null; state: "running" | "completed" | "failed" |
    "stopped"; orphaned: boolean; doing: string | null; commands: number; tools: number; tokens: number; ms: number;
    startedAt: string; endedAt: string | null }`. `orphaned`: stopped by the stopped rule, not by a notice.
  - `AgentLogSchema` / `type AgentLog = { turnSeq: number; agents: AgentRecord[]; commands: Record<string, number> }`,
    where an `AgentRecord` is an `AgentEntry` without `orphaned` and `commands`, plus `runSeq: number` (the seq of its
    latest `task_started`, wakes included), and `state` is the log's own (the last notice's).
- Produces, in `src/state/agents.ts`:
  - `EMPTY_AGENT_LOG: AgentLog`
  - `AGENT_EVENT_KINDS: readonly string[]` = `["system:task_started", "system:task_progress", "system:task_updated",
    "system:task_notification", "system:background_tasks_changed", "meddle:turn_started"]`
  - `foldAgentLog(log: AgentLog, events: readonly EventRecord[]): AgentLog`, returning `log` itself when no event
    changed anything
  - `servedAgents(log: AgentLog, liveTurn: boolean): AgentEntry[]`
  - `runningCount(agents: readonly AgentEntry[]): number`
- Produces, in `src/store/events.ts`: `listEventsOfKinds(db: Database, taskId: string, kinds: readonly string[]):
  EventRecord[]`. `kinds` are `type:subtype`, and the result is oldest first.

- [ ] **Step 1: Write the failing tests** in `test/agents.test.ts`

```ts
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

test("an agent 'completed' while its own commands run is still running, waiting on them; its wake keeps its start", () => {
  let log = foldAgentLog(EMPTY_AGENT_LOG, [turn(1, 0), started(2, 1)]);
  log = foldAgentLog(log, [
    live(3, 2, [command("c1"), command("c2"), command("w1", { ambient: true })]),
    notice(4, 3, "completed", { summary: "This agent has not reported yet: it is waiting on its own background work…" }),
  ]);
  expect(servedAgents(log, true)[0]).toMatchObject({ state: "running", commands: 2, doing: "Waiting on 2 commands", endedAt: null });
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
  expect(servedAgents(resumed, true)[0]).toMatchObject({ state: "stopped", orphaned: true });
  expect(servedAgents(foldAgentLog(resumed, [notice(5, 59, "stopped")]), true)[0]).toMatchObject({ state: "stopped", orphaned: false });
});

test("an agent waiting on its commands when the session dies is stopped", () => {
  const log = foldAgentLog(EMPTY_AGENT_LOG, [turn(1, 0), started(2, 1), live(3, 2, [command("c1")]), notice(4, 3, "completed")]);
  expect(servedAgents(log, false)[0]).toMatchObject({ state: "stopped", orphaned: true, commands: 1 });
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
```

And in `test/events.test.ts`:

```ts
test("listEventsOfKinds returns only the task's events of those type:subtype kinds, oldest first", () => {
  const db = openDb(":memory:");
  for (const m of [
    { type: "system", subtype: "task_started" }, { type: "stream_event" }, { type: "meddle", subtype: "turn_started" },
    { type: "system", subtype: "init" }, { type: "system", subtype: "task_started" },
  ]) appendEvent(db, "t", m);
  appendEvent(db, "u", { type: "system", subtype: "task_started" });
  expect(listEventsOfKinds(db, "t", ["system:task_started", "meddle:turn_started"]).map((e) => e.seq)).toEqual([1, 3, 5]);
  expect(listEventsOfKinds(db, "t", [])).toEqual([]);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `~/.bun/bin/bun test test/agents.test.ts test/events.test.ts`
Expected: FAIL. `src/state/agents` and `listEventsOfKinds` don't exist yet.

- [ ] **Step 3: Add the schemas, `listEventsOfKinds` and the fold**

`listEventsOfKinds` is one query, `WHERE task_id = ? AND ((type = ? AND subtype = ?) OR …) ORDER BY seq`, which the
`events_type` index serves; with no kinds it returns `[]`. The fold applies the spec's rules ("The agent list on the
node") event by event:

- `turn_started` sets `turnSeq`.
- `task_started`:
  - Ignored unless `task_type` is `local_agent`.
  - A new id becomes a record: `toolUseId` is `tool_use_id ?? ""`; `seq` and `startedAt` come from this event.
  - A known id sets `state: "running"`, `endedAt: null`, `doing: null`, and `runSeq` to this event's seq. If its
    `prompt` doesn't start with `<task-notification>` (a follow-up, not a wake), `startedAt` moves to this event.
  - `background` takes `is_backgrounded` when it's given.
- `task_progress` (known id): `doing` = its `description`, and the numbers from `usage`.
- `task_updated` (known id): only `patch.is_backgrounded`.
- `task_notification` (known id): `state` = `status`, the numbers from `usage` when given, `endedAt` = this event's
  `at`, `doing: null`.
- `background_tasks_changed`: `commands` is rebuilt from `tasks`, counting entries that aren't `local_agent` and
  aren't `ambient`, by `parent_task_id`.

`servedAgents` turns each record into an entry:
- `commands` = `log.commands[id] ?? 0`.
- If the log state is `completed` and `commands > 0`: `state` is `running`, `endedAt` null, `doing` `Waiting on N
  command(s)`.
- Then, if the state is `running` and either `!liveTurn` or `runSeq < turnSeq`: `state` is `stopped`, `orphaned`
  true, `doing` null.
- Order: running first by `startedAt` descending, then the rest by `endedAt ?? startedAt` descending.

- [ ] **Step 4: Run the tests to see them pass**

Run: `~/.bun/bin/bun test test/agents.test.ts test/events.test.ts && ~/.bun/bin/bun run typecheck`
Expected: all pass; typecheck clean.

- [ ] **Step 5: Commit**

`jj commit -m "Fold a task's agents from the notices in its log"`

---

### Task 2: Serve a task's agents

**Files:**
- Modify: `src/state/contracts.ts` (`TaskObject`'s state, after `contextUsage`)
- Modify: `src/state/host.ts` (the task object near `const log = self.state("log", …)`, `catchUpLog`, the `states`
  listener, the members returned by `gated({ … })`, and an `agentLogNow` beside `taskLogNow`)
- Test: `test/state.test.ts`

**Interfaces:**
- Consumes: Task 1's `AgentEntrySchema`, `AgentLogSchema`, `EMPTY_AGENT_LOG`, `AGENT_EVENT_KINDS`, `foldAgentLog`,
  `servedAgents`, `runningCount`, `listEventsOfKinds`.
- Produces: `TaskObject` state members `agents: Type.Array(AgentEntrySchema)` (the task's agents, served order) and
  `agentsRunning: Type.Number()` (how many of them run), each with a doc comment in the contract's style.

- [ ] **Step 1: Write the failing test** in `test/state.test.ts`

```ts
test("a task's agents come from its log, and one left running with no live turn shows stopped", async () => {
  const { client, db, project, close } = await connect();
  try {
    const node = await client.get(NodeObject, {});
    const { id } = (await node.createTask({ title: "t", projects: [{ id: project.id }] })).manifest;
    appendEvent(db, id, { type: "meddle", subtype: "turn_started", at: "2026-11-17T19:00:00.000Z", resume: false });
    appendEvent(db, id, { type: "system", subtype: "task_started", task_id: "a1", tool_use_id: "tA", task_type: "local_agent", is_backgrounded: true, description: "Implement Task 3" });
    appendEvent(db, id, { type: "system", subtype: "task_started", task_id: "a2", tool_use_id: "tB", task_type: "local_agent", is_backgrounded: true, description: "Review Task 2" });
    appendEvent(db, id, { type: "system", subtype: "task_notification", task_id: "a2", tool_use_id: "tB", status: "completed", summary: "" });
    for (let i = 0; i < 300; i++) appendEvent(db, id, { type: "stream_event", event: {} });
    const task = await client.get(TaskObject, { id });
    expect(task.agents.value.map((a) => [a.id, a.state, a.orphaned]).sort()).toEqual([["a1", "stopped", true], ["a2", "completed", false]]);
    expect(task.agentsRunning.value).toBe(0);
    task.release();
    node.release();
  } finally {
    await close();
  }
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `~/.bun/bin/bun test test/state.test.ts -t "a task's agents come from its log"`
Expected: FAIL; `task.agents` is undefined.

- [ ] **Step 3: Wire the cells and members**

- `agentLog = self.state("agentLog", AgentLogSchema, { init: () => agentLogNow(id) })`, where
  `agentLogNow(taskId) = foldAgentLog(EMPTY_AGENT_LOG, listEventsOfKinds(db, taskId, AGENT_EVENT_KINDS))`.
- `liveTurn = self.state("liveTurn", Type.Boolean(), { init: () => runner.liveQuery(id) !== null })`.
- `catchUpLog` folds the same fresh events into `agentLog` (replace only when `foldAgentLog` returns a new object)
  and refreshes `liveTurn` when `runner.liveQuery(id) !== null` differs from it. The `states` listener refreshes
  `liveTurn` too.
- Members: `agents: self.derive([agentLog, liveTurn], (l, live) => servedAgents(l, live))`, and `agentsRunning`
  derived the same way through `runningCount`. Find out from chord's `derive` whether an unchanged number is pushed
  again. If it is, keep `agentsRunning` in a cell replaced only when the count changes, so that sidebars aren't
  pushed every progress frame.

- [ ] **Step 4: Run it to see it pass**

Run: `~/.bun/bin/bun test test/state.test.ts -t "a task's agents come from its log|a task's activation reads its log summary" && ~/.bun/bin/bun run typecheck`
Expected: both pass; typecheck clean.

- [ ] **Step 5: Commit**

`jj commit -m "Serve a task's agents and how many run"`

---

### Task 3: Agent and background rows in the thread model

**Files:**
- Modify: `src/dashboard/ui/thread-model.ts`
- Test: `test/thread-model.test.ts`

**Interfaces:**
- Produces, on `ToolItem` (each with a doc comment):
  - `background?: boolean`: the call started a background task, so its result is a receipt, and it runs until
    `ended`.
  - `ended?: { status: string; text: string }`: from its latest notice, and cleared by a later `task_started` of its
    task.
  - `reports?: string[]`: an Agent call's `SubagentHandback` messages, oldest first.
  - `resumes?: string`: on a `SendMessage` call that resumed an agent, the `toolUseId` of that agent's own row.
- Produces: `isRunning(tool: ToolItem): boolean`, `backgroundMeta(tool: ToolItem): string | null`, and
  `activity(live: Live, items: readonly ThreadItem[], agentsRunning = 0): string`. `activityLine` never stalls a line
  starting `Waiting on`.

- [ ] **Step 1: Write the failing tests** in `test/thread-model.test.ts` (add `isRunning`, `backgroundMeta` to the
  import)

```ts
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
```

The existing tests stay as they are: "Running Agent › Bash" for a foreground agent, and the notice summaries for
tasks with no known call.

- [ ] **Step 2: Run them to see them fail**

Run: `~/.bun/bin/bun test test/thread-model.test.ts`
Expected: the four new tests FAIL (`isRunning`/`backgroundMeta` missing); the old ones pass.

- [ ] **Step 3: Implement in `buildThread` and the helpers**

- **Track rows.** Keep a map from task id to row, and the set of top-level tool ids (a call pushed onto `top`).
- **`task_started`:**
  - A `local_agent` start names the agent's row. The first time, that's the call its `tool_use_id` names. Later,
    it's the row already mapped for that task id.
  - It sets `background` from `is_backgrounded` and clears `ended`.
  - If its `tool_use_id` names a different known call (a `SendMessage`), that call gets `resumes` = the agent row's
    `toolUseId`, `background: true`, and `ended` cleared.
  - Any other task's start marks the call its `tool_use_id` names in the same way.
  - A start with no known row stays an `unknown` item, as today.
- **`task_notification`:**
  - It sets `ended` on the row it maps to (by task id, else by `tool_use_id`), and on a different known call named by
    its `tool_use_id`.
  - A status line goes on `top` only for a top-level row. For an agent, that line reads `Agent "<description>"
    finished` (for `completed`), `stopped` or `failed`, where `<description>` is the Agent call's
    `input.description`. If the summary starts with `This agent has not reported yet`,
    it reads `Agent "<description>" is waiting on its own commands` instead. Other top-level rows keep today's summary
    text.
  - A notice with no known row is today's status line.
- **`SubagentHandback`:** a `tool_use` named `SubagentHandback` under an Agent call isn't a row. Its
  `input.message` is appended to the parent's `reports`, and its result is swallowed (like a question's).
- **`isRunning`:** for a `background` call, `ended === undefined`; for any other call, `result === undefined`.
  `activity` uses it in place of `result === undefined`.
- **`backgroundMeta`:** for a non-background call, `null`. While running, `"background"`. Once ended, a `Monitor`
  gives `"ended"`; otherwise `exit N` from `/exit code (\d+)/` in `ended.text`, else `ended.status`.
- **"Waiting on N agents":** `activity` returns this when nothing is streaming and the running chain is empty or
  starts at a background Agent call. N is `agentsRunning`, or, when that is 0, the number of top-level background
  Agent calls still running. If N is 0, fall back to today's lines.

- [ ] **Step 4: Run the tests to see them pass**

Run: `~/.bun/bin/bun test test/thread-model.test.ts && ~/.bun/bin/bun run typecheck`
Expected: all pass; typecheck clean.

- [ ] **Step 5: Commit**

`jj commit -m "Put agents' notices and reports on their rows in the thread"`

---

### Task 4: The agent list's rows and the sidebar count, as models

**Files:**
- Create: `src/dashboard/ui/agents-model.ts`
- Modify: `src/dashboard/ui/sidebar-model.ts` (export `tokens`; `TaskEntry.agents`)
- Test: `test/ui.test.ts` (and its `entry()` helper gets `agents: 0`)

**Interfaces:**
- Consumes: `AgentEntry` (Task 1), `duration` (`thread-model.ts`), `ago` and `tokens` (`sidebar-model.ts`).
- Produces, in `agents-model.ts`:
  - `FINISHED_SHOWN = 3`
  - `type AgentRow = { agent: AgentEntry; doing: string; nums: string }`
  - `agentCounts(agents: readonly AgentEntry[]): string`
  - `panelRows(agents: readonly AgentEntry[], now: number, showAll: boolean): { rows: AgentRow[]; earlier: string | null }`.
    It keeps the served order.
  - `foldedLine(agents: readonly AgentEntry[], now: number): string`
- Produces: `TaskEntry.agents: number` (agents running; 0 from a node that does not say).

- [ ] **Step 1: Write the failing tests** in `test/ui.test.ts`. Import `agentCounts`, `foldedLine` and `panelRows`
  from `../src/dashboard/ui/agents-model`, and `type AgentEntry` from `../src/state/contracts`.

```ts
const NOW = Date.parse("2026-11-17T19:40:00.000Z");
const agentEntry = (description: string, over: Partial<AgentEntry> = {}): AgentEntry => ({
  id: description, toolUseId: `t-${description}`, seq: 1, description, agentType: "general-purpose", background: true, parent: null,
  state: "running", orphaned: false, doing: null, commands: 0, tools: 0, tokens: 0, ms: 0,
  startedAt: "2026-11-17T19:36:35.000Z", endedAt: null, ...over,
});

test("agentCounts says how many run, are done, stopped and failed, leaving out the noughts", () => {
  expect(agentCounts([agentEntry("a"), agentEntry("b"), agentEntry("c", { state: "completed" }), agentEntry("d", { state: "stopped" })]))
    .toBe("2 running · 1 done · 1 stopped");
  expect(agentCounts([agentEntry("a", { state: "failed" })])).toBe("1 failed");
  expect(agentCounts([])).toBe("");
});

test("panelRows: running agents with their step and numbers, then the newest finished, the rest counted", () => {
  const finished = (n: number, over: Partial<AgentEntry> = {}) =>
    agentEntry(`f${n}`, { state: "completed", endedAt: "2026-11-17T19:36:00.000Z", tools: 14, tokens: 37314, ms: 82000, ...over });
  const list = [
    agentEntry("Implement Task 3: blobs between nodes", { doing: "Running bun test", tools: 31, tokens: 79502 }),
    agentEntry("Review Task 2"),
    finished(1), finished(2, { state: "stopped", orphaned: true }), finished(3, { state: "failed" }), finished(4, { state: "stopped" }), finished(5),
  ];
  const { rows, earlier } = panelRows(list, NOW, false);
  expect(rows.map((r) => [r.agent.description, r.doing, r.nums])).toEqual([
    ["Implement Task 3: blobs between nodes", "Running bun test", "31 tools · 80k · 3m 25s"],
    ["Review Task 2", "Working", "0 tools · 0 · 3m 25s"],
    ["f1", "done 4m ago", "14 tools · 37k · 1m 22s"],
    ["f2", "stopped with the session", "14 tools · 37k · 1m 22s"],
    ["f3", "failed", "14 tools · 37k · 1m 22s"],
  ]);
  expect(earlier).toBe("2 earlier: 1 stopped, 1 done");
  expect(panelRows(list, NOW, true)).toMatchObject({ earlier: null });
  expect(panelRows(list, NOW, true).rows).toHaveLength(7);
  const many = Array.from({ length: 30 }, (_, i) => finished(i));
  expect(panelRows(many, NOW, false)).toMatchObject({ earlier: "27 earlier: 27 done" });
  expect(panelRows(many, NOW, false).rows).toHaveLength(3);
  expect(panelRows([], NOW, false)).toEqual({ rows: [], earlier: null });
});

test("foldedLine: the running agents with their times, then the rest; or that all are finished", () => {
  const list = [
    agentEntry("Implement Task 3"), agentEntry("Review Task 2", { startedAt: "2026-11-17T19:39:19.000Z" }),
    agentEntry("x", { state: "completed" }), agentEntry("y", { state: "stopped" }),
  ];
  expect(foldedLine(list, NOW)).toBe("2 agents running: Implement Task 3 (3m 25s), Review Task 2 (41s) · 1 done · 1 stopped");
  expect(foldedLine([agentEntry("a")], NOW)).toBe("1 agent running: a (3m 25s)");
  expect(foldedLine([agentEntry("x", { state: "completed" }), agentEntry("y", { state: "completed" })], NOW)).toBe("2 agents, all finished");
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `~/.bun/bin/bun test test/ui.test.ts`
Expected: FAIL; `agents-model` doesn't exist.

- [ ] **Step 3: Implement `agents-model.ts`, export `tokens`, add `TaskEntry.agents`**

- **A running row:**
  - `doing` is `agent.doing ?? "Working"`.
  - `nums` is `${tools} tools · ${tokens(tokens)} · ${duration(elapsed)}`, where `elapsed` counts whole seconds from
    `startedAt`.
- **A finished row:**
  - `doing` is `done ${ago(now − endedAt)} ago`, `stopped with the session` (orphaned), `stopped` or `failed`.
  - `nums` is the same as for a running row, but the time is `duration(round(ms / 1000))`.
- **`earlier`:** counts the hidden finished agents in the order stopped, failed, done, leaving out the noughts.
- **`foldedLine`:** the running agents' descriptions with their elapsed times, then `agentCounts` without its running
  part.

- [ ] **Step 4: Run them to see them pass**

Run: `~/.bun/bin/bun test test/ui.test.ts && ~/.bun/bin/bun run typecheck`
Expected: all pass; typecheck clean.

- [ ] **Step 5: Commit**

`jj commit -m "Model the agent list's rows and the sidebar's agent count"`

---

### Task 5: Show the agents on the task page and in the sidebar

**Files:**
- Create: `src/dashboard/ui/Agents.tsx` (`AgentsPanel`)
- Modify: `src/dashboard/ui/Task.tsx` (`TaskLoaded`, `Thread`, `ToolRow`, `Live`, the `ThreadView` context)
- Modify: `src/dashboard/ui/sources.tsx` (export and widen `useOptionalValue`; report `agents`)
- Modify: `src/dashboard/ui/Sidebar.tsx` (`TaskRow`'s count; move `stored`/`store` to `hooks.ts` for reuse)
- Modify: `src/dashboard/ui/index.html` (styles)
- Test: `test/ui.test.ts` ("the dashboard bundle builds")

**Interfaces:**
- Consumes:
  - From Task 2: the `agents` and `agentsRunning` members.
  - From Task 3: `isRunning`, `backgroundMeta`, `activity(live, items, agentsRunning)`, and the `ToolItem` fields
    `background`, `ended`, `reports`, `resumes`.
  - From Task 4: `panelRows`, `agentCounts`, `foldedLine`, `FINISHED_SHOWN` and `TaskEntry.agents`.
- Produces:
  - `AgentsPanel({ agents, selected, onPick }: { agents: readonly AgentEntry[]; selected: string | null; onPick(agent: AgentEntry): void })`.
  - `useOptionalValue(task, member)` for `"activityAt" | "agents" | "agentsRunning"`.
  - Each tool row's `<details>` carries `data-call={toolUseId}`.

- [ ] **Step 1: Read both members as optional and report the count**

`TaskLoaded` reads `useOptionalValue(task, "agents") ?? []`. `TaskSourceLoaded` reports
`agents: useOptionalValue(task, "agentsRunning") ?? 0`. `TaskRow` shows `<span class="agent-count">` (the `agent`
icon from `Task.tsx`'s `ICONS`, then the number) after the pending badge while `task.agents > 0`, titled
`N agent(s) running`.

- [ ] **Step 2: Build `AgentsPanel`**

- **Placement:** it renders above `Composer`, and on an archived task where the composer would be. It is hidden for
  `[]`.
- **Head:** the agent icon, `Agents`, `agentCounts`, and a fold toggle remembered under `meddle.agents.folded` with
  `stored`/`store`.
- **Folded:** a single line, `foldedLine`.
- **Open:** `panelRows(agents, now, showAll)`, ticking once a second (`useTick(1000)` from `Task.tsx`; move it to
  `hooks.ts` if both files need it). Each row shows a spinner, a check, or a red cross, then the description,
  `doing` and `nums`. The `earlier` line toggles `showAll`.
- **Height:** at most about a third of the pane, scrolling inside.
- **Click:** a row calls `onPick`, and the selected row is highlighted.

- [ ] **Step 3: Scroll to and open an agent's row**

- **State:** `TaskLoaded` keeps `focus: { toolUseId: string; seq: number; n: number } | null`, where `n` bumps on
  every pick. It's set from `onPick` and from a `SendMessage` row's open (through the `ThreadView` context's new
  `focus(toolUseId)`, which looks up `seq` in `agents`).
- **Load, then open:** on a new `focus`, `Thread` calls `session.loadEarlier` page by page until its oldest seq is
  `≤ focus.seq` or nothing earlier is left. It then finds `[data-call="<toolUseId>"]`, sets `open` on it and every
  `details` around it, and calls `scrollIntoView({ block: "start" })`.
- **Nothing to open:** if `toolUseId` is `""` or no row is found, it does nothing.

- [ ] **Step 4: Render agent rows, background rows and `SendMessage` rows in `ToolRow`**

- **Context:** `ThreadView` also carries the agents keyed by `toolUseId`.
- **An Agent row with an entry:**
  - Running state, red and auto-open come from `entry.state`.
  - The meta is `model · N tools · time`.
  - While running, a `.now` line under the name shows `entry.doing`.
- **An Agent row without an entry** (an older node): running state comes from `isRunning(tool)`, and it's red when
  `tool.ended?.status` is `stopped` or `failed`.
- **An Agent row's body:**
  - If it has `reports`: the newest report as `Markdown` in a `.report` card. Older reports sit behind an "earlier
    report" toggle. The children fold into a closed `Steps` row reading `N tools`.
  - Otherwise: the children as today. The result text shows only for a non-background call (an older Claude Code's
    report).
- **A stopped or failed agent:** the body leads with `Stopped before it reported`. When `entry.orphaned` is true,
  that reads `Stopped before it reported: the session ended`.
- **Background calls:** the meta is `backgroundMeta(tool)`, and running state comes from `isRunning(tool)`.
- **A `SendMessage` with `resumes`:** a row with verb `Message`, whose target is the agent's description and the
  input's `summary`. It shows no output, and opening it calls `focus(resumes)` instead of expanding.
- **The live line:** `Live` passes `agentsRunning` to `activity`.

- [ ] **Step 5: Add the styles to `index.html`**

Take `.agent-count`, `.agents`, `.agents-head`, `.arow`, `.amore`, `.now`, `.report`, `.report-head` and
`.step.focus` from the mockups' `<style>` blocks:
- `.superpowers/brainstorm/713800-1794959470/content/subagents-panel.html`
- `.superpowers/brainstorm/12906-1794944487/content/subagents-thread.html`

The mockups are on peeriot-00X and not in the repo. If you can't read them, follow the dashboard's `.step` and
`.chip` styles. Cap `.agents` at `max-height: 33vh` with `overflow-y: auto`.

- [ ] **Step 6: Typecheck and build**

Run: `~/.bun/bin/bun run typecheck && ~/.bun/bin/bun test test/ui.test.ts test/thread-model.test.ts`
Expected: typecheck clean; "the dashboard bundle builds" and every model test pass.

- [ ] **Step 7: Commit**

`jj commit -m "Show a task's agents above its message box and their count in the sidebar"`

---

### Task 6: See it on a scratch node

No new code unless this finds a bug. If it does, fix it in the task that owns the code, and commit there.

- [ ] **Step 1: Start a scratch node.** Use the `run` skill. Never touch the user's node on port 7777 or
  `~/.local/share/meddle`, beyond reading it with `sqlite3 -readonly`.
  - Give the node its own `HOME`, `MEDDLE_DATA_DIR` and `MEDDLE_TASK_ROOT` under one `mktemp -d`, and set
    `MEDDLE_PORT=7791`.
  - Point it at nothing: `MEDDLE_IROH_PRESET=minimal`, `MEDDLE_LIGHTHOUSE_URL=http://127.0.0.1:9`.
  - Use the fake Claude Code exactly as `lab/node.sh` does.
  - Give it a token with `token add --file` and the text `tok-scratch`, then run `task new --title "Agents check"
    --here`.
- [ ] **Step 2: Copy in the attachments task's log up to the middle of Task 3**
  - Run
    `sqlite3 <scratch>/meddle.sqlite "ATTACH 'file:$HOME/.local/share/meddle/meddle.sqlite?mode=ro' AS o; DELETE FROM events WHERE task_id='<new id>'; INSERT INTO events SELECT '<new id>', seq, type, subtype, uuid, at, json FROM o.events WHERE task_id='360e67ba40a1' AND seq <= 12100;"`
    (the attach needs `-cmd ".open --uri"` or a URI-enabled build: check `ATTACH` worked).
  - Then restart the scratch node.
- [ ] **Step 3: Look at it**
  - Open `http://127.0.0.1:7791/#/task/<scratch node id>/<new id>` in the headless browser the `run` skill uses, and
    screenshot it.
  - Expected:
    - no notice lines under "Turn finished";
    - agent rows ending with their reports;
    - the first Task 1 implementer red, "Stopped before it reported";
    - the agent list above the message box, listing the attachments task's agents as finished or stopped (no turn is
      live here, so none run);
    - clicking the oldest agent loads earlier events and opens its row.
  - Running rows can't be seen without a live turn; the model tests cover them.
- [ ] **Step 4: Stop the scratch node and delete its folder.** Report the screenshots to the user.
