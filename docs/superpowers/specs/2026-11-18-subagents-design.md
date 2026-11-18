# Sub-agents you can see

Mockups (not in the repo; on peeriot-00X): `.superpowers/brainstorm/*/content/subagents-thread.html` (the thread's
rows) and `subagents-panel.html` (the agent list and the sidebar count; option 1 is the one chosen).

## Why

Tasks hand work to sub-agents. The "Enable drag-and-drop and clipboard image attachments" task runs a plan through
subagent-driven development: an implementer agent per task, then a reviewer agent, most of them in the background.
From the dashboard you cannot tell how many agents a task has, which are still working, or how far they've got. The
user had to ask Claude "How are the sub-agents going? What's the progress?". And what the agents do lands in the
main thread as noise:

- A background agent's row looks finished the moment it starts. Its result is the launch receipt ("Async agent
  launched successfully…"), so it never spins.
- Every background command an agent runs, and each of its `Monitor` watchers, ends with a notice that the thread
  prints as a status line at the top level. They pile up under "Turn finished" while the agent works (the user's
  screenshot: a dozen lines of shell commands).
- The agent's report comes back through a `SubagentHandback` call inside its run, drawn as raw JSON. The row's own
  result is a placeholder ("This agent's report was delivered to you as a message… not repeated here"), and so is
  the agent's "done" notice.
- `task_progress` frames (current step, tools used, tokens, time) are thrown away (`PROGRESS_KINDS`).
- An agent stopped with its session (the first Task 1 implementer, at 18:24) showed nothing until a status line an
  hour later, when the next turn started.

The user wants what Claude Code does: every sub-agent of the session gathered at the bottom, with how each is
getting on, so you can see at a glance how many a task has and how they're progressing.

## Goals

- At a glance, from the sidebar, which tasks have agents running and how many.
- In a task, one list of its agents above the message box: running ones with their current step, tools, tokens and
  time; finished and stopped ones after them.
- Nothing an agent runs shows in the main thread. The agent's row in the thread spins until it's done, shows what it's
  doing, and ends with its report.
- An agent that dies with its Claude Code process shows as stopped when that happens, not at the next turn.

## Non-goals

- An agent's own view in place of the thread (option 2 in the mockup). Clicking an agent in the list opens its row in
  the thread instead; its own view may come later.
- Stopping an agent or sending it a message from the dashboard.
- Listing the main session's own background commands in the agent list (they stay in the thread as today).
- Model-written progress lines (the SDK's `agentProgressSummaries` option): it costs a model call per update. The
  current step is the progress frame's `description` (e.g. `Running bun test …`).
- Agent teams and teammates.

## Anti-goals

- A count or a spinner that says an agent is running when its process is gone.
- An agent's commands, watchers or notices in the main thread.
- An agent list that pushes the thread off the screen.

## Approaches

**What clicking an agent opens** (the user's choice, from the mockup):

1. Its row in the thread, scrolled to and opened, with the agent's steps nested inside. **Chosen**: "Option 1 would
   be easiest for now."
2. Its own view in place of the thread, like Claude Code's agent view, with "← Thread" back. More work: the node
   would serve one agent's events on request. Not now.

**Where the agent list comes from** (one sensible way):

- **The node keeps each task's agent list**, folded from the `task_*` notices in the task's event log, and serves it
  as a member of `TaskObject`. Chosen. The sidebar reads it for a task on any node; it survives a restart and
  travels with a moved, archived or restored task because it is rebuilt from the log.
- Working it out in the page: rejected. The session's window is the newest 200 events (`WINDOW_SIZE`), and a few
  agents working at once push the older ones' `task_started` out of it. The sidebar doesn't load a task's events at
  all.
- Reading Claude Code's own agent files (`subagents/agent-<id>.meta.json`): rejected. It means watching the disk for
  what the notices already carry, and it has no progress.

Size: a project. It touches the node (fold and served member), the contract, the thread model, the task page and the
sidebar.

## What the notices carry

From `@anthropic-ai/claude-agent-sdk` 0.3.314 (`sdk.d.ts`), all `type: "system"`, already in the event log:

- `task_started`: `task_id`, `run_id`, `tool_use_id` (the call that started it), `description`, `task_type`
  (`local_agent` for a sub-agent, `local_bash` for a background command or `Monitor` watcher), `subagent_type`,
  `is_backgrounded`, `spawn_depth`, `parent_task_id` (the agent that launched it, when one did), and for a resumed
  agent a `prompt` (the follow-up it was sent). A resumed agent keeps its `task_id` and gets a new `run_id`.
- `task_progress`: `task_id`, `tool_use_id`, `description` (the current step), `usage { total_tokens, tool_uses,
  duration_ms }`, `last_tool_name`, optional `summary`.
- `task_updated`: `task_id`, `patch { status, end_time, is_backgrounded, error, … }`.
- `task_notification`: `task_id`, `tool_use_id`, `status` (`completed` | `failed` | `stopped`), optional `reason`
  (`worker_restart`), `summary`, optional `usage`.
- `background_tasks_changed`: every live background task (replace semantics), with `ambient` for those that are not
  activity.

An agent's own messages already arrive with `parent_tool_use_id` set to its Agent call and nest under it
(`buildThread`). Its report is the `message` of a `SubagentHandback` tool call in its run (the attachments task's
agents all reported this way).

Two things the log shows that the SDK types don't say (task `360e67ba40a1`):

- **A follow-up comes from a `SendMessage` call**, not the Agent call. `SendMessage { to: <agent id>, summary,
  message }` (seq 12388) returns at once ("Resuming agent …"). That run's `task_started`, `task_progress` and
  `task_notification` carry the `SendMessage` call's `tool_use_id` (seq 12393, 12510), while the agent's messages in
  that run still nest under the original Agent call. The run ends with another `SubagentHandback`.
- **An agent waiting on its own background commands is "completed" before it has reported.** It ends its turn while
  its tests run, and Claude Code sends `task_updated { status: "completed" }` and a `completed` notice whose summary
  says "This agent has not reported yet: it is waiting on its own background work…" (seq 18685, 19092). Its commands
  stay in `background_tasks_changed` with `parent_task_id` set to the agent. When one ends, the same `task_id` gets a
  new `task_started` (a new `run_id`, the same `tool_use_id`) whose `prompt` is a `<task-notification>` (seq 18720,
  19113): a wake, not a follow-up. The main session also wakes for the "not reported yet" notice (seq 19094).

## Design

### The agent list on the node

A new `TaskObject` state member, `agents`, whose entries are:

```ts
type AgentEntry = {
  id: string;              // the local_agent task_id
  toolUseId: string;       // the Agent call that started it: its first task_started's tool_use_id
  seq: number;             // seq of its first task_started: how far back the thread must load to show its row
  description: string;
  agentType: string | null;   // subagent_type
  background: boolean;        // latest is_backgrounded
  parent: string | null;      // parent_task_id: an agent launched by an agent
  state: "running" | "completed" | "failed" | "stopped";
  doing: string | null;       // while running: the latest progress description, or "Waiting on N commands"
  commands: number;           // its own live background commands (parent_task_id = id), from background_tasks_changed
  tools: number; tokens: number; ms: number;  // the latest usage, from progress or the notification, as given
  startedAt: string;          // `at` of the task_started that began the current piece of work (first start or follow-up)
  endedAt: string | null;
};
```

- Kept in a cell folded from the log the way `log` is (`foldTaskLog`, `catchUpLog` in `src/state/host.ts`): each
  fresh event updates it. Only `local_agent` tasks are entries.
- **Follow-ups and wakes.** A later `task_started` for a known id sets it running again. If its `prompt` is a
  `<task-notification>` it is a wake: `startedAt` stays. Otherwise it is a follow-up: `startedAt` moves to it,
  `endedAt` clears. `toolUseId` and `seq` never change: they name the agent's row, wherever its runs were started.
- **Waiting on its own commands.** A `completed` notice or `task_updated` while the agent has live background
  commands of its own (the latest `background_tasks_changed` entries whose `parent_task_id` is the agent) leaves it
  `running`, `doing` "Waiting on N commands". It is `completed` only once a `completed` comes with none left. So the
  fold also reads `background_tasks_changed`.
- At object start it reads only the task's `system` events of subtype `task_started`, `task_progress`,
  `task_updated`, `task_notification` and `background_tasks_changed` (the `events_type` index covers
  `(task_id, type, subtype, seq)`), not the whole log. The attachments task's log is over 12,000 events, mostly
  stream frames.
- **The stopped rule.** An entry the log leaves `running` is served as `stopped` once the task has no live turn,
  because then no Claude Code process is left to run it (the turn ended, was interrupted, the task was moved now, the
  node restarted). A task that is `moving` while its move waits for the turn to end still has its turn: its agents
  are still running. Claude Code's own `stopped` notice, when it comes at the next turn, changes nothing visible.
  Without a declared stop control, meddle's interrupt kills background agents (`sdk.d.ts`, the option beside
  `agentProgressSummaries`), so this covers interrupt too.
- Order: running first, newest first; then finished, newest `endedAt` first.
- A node older than this change serves no `agents`. The dashboard treats a missing member as an empty list: no
  panel, no count, for that node's tasks.

### The sidebar

`TaskEntry` gets the task's running agent count. A task row shows a purple count (the agent icon and the number)
after its title while it is above 0, titled "N agents running". If chord pushes `TaskObject` members as a whole and
progress frames make `agents` churn for every listing dashboard, serve the count as its own member (`agentsRunning`)
for the sidebar to read; that's the builder's call after looking at how chord subscribes.

### The agent list in a task

A panel above the composer (`Composer` in `src/dashboard/ui/Task.tsx`), the same width, shown while the task has any
agents. It shows on a read-only (archived) task too, without the composer.

- **Head:** the agent icon, "Agents", then "N running · N done · N stopped" (only the parts above 0; failed counts
  with stopped as "N stopped or failed" when both, the builder's wording), and a fold toggle on the right.
- **Rows:** running agents first. Each: a spinner, the description, the current step (`doing`, monospace,
  ellipsised), then `tools · tokens · time` (tokens as `80k`; time ticking from `startedAt` while running, else
  `ms`). Finished rows: a check (completed) or a red cross (failed, stopped), the description, "done 4m ago" /
  "stopped" / "failed", and the final numbers. At most 3 finished rows show; the rest fold into "N earlier: 1
  stopped, 2 done ▸", which opens them in place.
- **Folded:** one line: "2 agents running: Implement Task 3 (3m 25s), Review Task 2 (41s) · 5 done · 1 stopped". With
  none running: "N agents, all finished". Folded or open is remembered per browser, like the sidebar's archived toggle
  (`ARCHIVED_OPEN_KEY` in `Sidebar.tsx`).
- **Height:** the panel never takes more than about a third of the pane; its rows scroll inside it.
- **Click:** selects the row (highlighted while its agent's thread row is open) and scrolls the thread to the agent's
  row and opens it. If `seq` is older than the oldest loaded event, the thread loads earlier events
  (`session.loadEarlier`) until it is in, then scrolls. An agent launched by an agent (`parent`) has its row inside
  its parent's: open the parent too.

### The thread (`src/dashboard/ui/thread-model.ts`, `Task.tsx`)

As in the first mockup:

- **Notices go to their row.** A `task_started` or `task_notification` is not an item of its own when it has a row
  to mark. An agent's notices (`local_agent`) mark the agent's row, the Agent call that first started it, whichever
  call's `tool_use_id` they carry (a follow-up's carry the `SendMessage` call's). Other notices mark the call their
  `tool_use_id` names. A background command's row shows "background" with a spinner until its notice, then its exit
  code or "ended" (a `Monitor` watcher). A notice for a call inside an agent's run never shows at the top level. A
  notice for the main session's own call or agent still shows a status line at the top, as today, since it says why
  Claude picked up again. For an agent that line reads `Agent "<description>" finished` (or `stopped`, `failed`, or
  `is waiting on its own commands` for the "not reported yet" notice), never the placeholder. A notice with no loaded
  row stays a status line as today.
- **An Agent call runs until its agent is done** by the agent list's state (so not at a "not reported yet" notice), or
  by the last notice when the list has no entry for it (an older node). The launch receipt of a background agent is
  not its result. A follow-up or a wake sets the row running again; its steps already nest under it.
- **A `SendMessage` call to an agent** is a one-line row, "Message to <agent's description>" with the message's
  `summary`, spinning while the run it started is running. Opening it opens and scrolls to the agent's row. Its result
  ("Resuming agent …") is not shown.
- **The report is the result.** `SubagentHandback` calls are not rows. Their `message` is the agent's report, shown
  formatted (markdown) as the row's result, first in its body, with the agent's steps folded beneath into one line
  ("44 tools" and what they were). With several reports (follow-ups), the newest shows and "earlier report" opens the
  others. Without any `SubagentHandback` (older Claude Code, or an agent that never sent one), the call's result text
  is the report, as today.
- **A running agent's row** shows `model · tools · time` in its meta (`model` from the call's input as today, the
  numbers from the agent list by `toolUseId`), and beneath its name the current step with small working dots.
- **A stopped or failed agent's row** is red and opens by itself, like a failed call, saying "Stopped before it
  reported" (with "the session ended" when the agent list's stopped rule made it so) or the failure.
- **The working line.** While the main session has nothing of its own in progress and agents are running, the line
  under the thread reads "Waiting on N agents · <time>" and never turns red (stalled), like a running call today.

## Constraints

- jj, bun, TypeScript as the repo. Run only the affected tests plus `bun run typecheck`, not the full suite.
- The agent list must be rebuilt from the event log alone (plus the task's state for the stopped rule), so moves,
  archives, restores and node restarts need nothing new.
- Dashboards and nodes of different versions meet in a pool: a missing `agents` member is an empty list, and the
  thread changes need no node change.
- Pure models stay pure (no Preact, no DOM): the fold and the panel's rows are functions with tests.

## Left to the builder

- Where the fold lives (beside `foldTaskLog`, or its own module) and the exact member names.
- Whether the sidebar reads `agents` or a separate count member (see above).
- Tests: the fold over a fixture cut from the attachments task's events (agents in the foreground and background, a
  `SendMessage` follow-up, a "not reported yet" notice and its wake, a stopped agent, an agent's background
  commands); the stopped rule against task states and a move waiting on its turn; the thread model on the same
  fixture (no agent notices at the top level, rows running until the agent is done, follow-ups on the agent's row,
  reports as results); the panel's row model (order, folding, counts). `test/thread-model.test.ts`, `test/ui.test.ts` and
  `test/fixtures/` hold the existing ones.
- Icons, spacing and wording within the mockups' lines.

## Decided in conversation

The user's: what was wrong (the attachments task, their screenshot of the notices under "Turn finished"); wanting the
agents gathered at the bottom like Claude Code, with a count at a glance; option 1 over option 2.

My calls, not objected to: agents in the foreground and the background are both listed, the main session's own
background commands are not; the panel hides when there are none and remembers being folded per browser; the stopped
rule; no stop or message controls; the newest report shows when there are several.

My calls after the builder check, for the user to look over:

- An agent Claude Code calls "completed" while it waits on its own background commands is still running ("Waiting on
  N commands"), and its wake is part of the same run, not a new one.
- A follow-up sent with `SendMessage` shows on the agent's own row, which spins again and ends with the new report.
  The `SendMessage` row near the bottom is one line that leads to it. Time counts from the follow-up, not the first
  start.
