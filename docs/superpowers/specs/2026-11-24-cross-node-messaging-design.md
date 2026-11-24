# Agents message each other across the pool

## Why

An agent in one task should be able to talk to the agent in another task, wherever in the pool that task is held,
the way Claude Code sessions on one machine already talk: `ListAgents` to see who is there, `SendMessage` to write,
a reply by `SendMessage` to the `from=` it was sent from. Today that works only between live sessions on one node
(the shared session registry: every task's `sessions` links to `<data>/sessions`, each session named by its task id),
and only while both have a turn running: meddle closes a task's Claude Code after each turn, so an idle task is in no
registry and can't be reached at all.

Waking an idle task with a message is wanted: the message starts a turn there, on that node's token. There is no
limit on it: two agents can wake each other back and forth for as long as they keep replying. That is accepted, the
agents trusted to stop (Claude Code tells them to "decide whether/how to respond"); no wake budget, no hop count.

## What changes

The agent keeps using Claude Code's own tools. Meddle takes them over with SDK hooks for task targets, carries the
message to the node holding the task, and puts it into that task's Claude Code through Claude Code's own peer socket.
No new tool for the agent, no patch to Claude Code (pinned at 2.1.314; every wire detail below is from it).

### Addresses

A task's address is its id (12 hex), as now: it is the session name meddle sets (`CLAUDE_CODE_SESSION_NAME`). Every
message meddle carries says `from="<sender task id>"`, so a reply always comes back through meddle, whether or not
the sender is still running.

### `ListAgents`

A PostToolUse hook (matcher `ListAgents`) rewrites the result (`updatedToolOutput`). Claude Code's result is
`{listing, sections, notes}` and the model reads `listing`; the hook appends one row per task the agent can message
and isn't already listed: the live tasks of every online member (this node's idle tasks included), not archived,
moved or merge tasks, not the task itself. A row carries the task id first (the address), the title, the node's name
and whether it is busy or idle. When Claude Code said "No reachable agents…", that sentence goes. Rows read like
Claude Code's own (the builder copies the format from a real listing).

Where the list comes from: a new `PeerObject.tasks()` on each member, answering its live tasks (`{id, title, state}`),
fanned out to the online members and cached briefly (a few seconds); this node's from its own `tasks` table. There is
no pool-wide task table today, and a task with no project has no line rows to find it by.

### `SendMessage` to a task

- **PreToolUse** (matcher `SendMessage`): when `to` (a trailing ` [ref]` dropped) names a task in the list above, the
  hook keeps the call's `to` and `message` by `tool_use_id` and rewrites `to` to a name nothing answers to, so Claude
  Code's own send finds no one (measured: ~4 ms, no network) and never delivers it itself. This applies to tasks on
  this node too, live or not: one path, one `from`.
- **PostToolUse**: for a kept call, meddle delivers the message (below) and replaces the result with
  `{success, message, display}` saying what happened: delivered, waking the task, queued for it, or why not (node
  offline, no such task, archived). Other `SendMessage` calls (subagents, teammates, other local sessions) are
  untouched.
- `notify_when_idle` to a task is refused in the result ("not available for tasks"); a later change can add it.

Hooks reach the runner as `onFilesChanged` does: `EngineInput` callbacks set in `TaskRunner.#engineInput`.

### Carrying it

The sender's node finds the holder (the tasks list above), then calls a new `PeerObject.message({to, from, text})`
on it (members only, as the other peer methods); a task on this node goes straight to the runner. A call follows the
train's `#callPeer`: offline before or during the call is "node offline", a refusal is the peer's reason.

### Delivering it

On the holder, `TaskRunner.message(taskId, from, text)`:

- **Its turn is running** (a live Claude Code): write the message into that Claude Code's socket. A train turn is
  the exception, as for prompts: the message queues for the task's next turn rather than pulling the agent off the
  train's work.
- **Idle**: start the task's turn as for a prompt, but with no prompt: Claude Code resumes, registers its socket
  (measured: ~0.3 s resumed, ~1.3 s fresh), meddle writes the message, and Claude Code runs the turn by itself. It
  ends like any turn: input closed after its `result`.
- **Not taking turns now** (moving, a pool-update hold, prompts queued ahead): queued with the task's prompts, marked
  as a message, and delivered when its turn comes, as an idle delivery.
- **Archived, moved away, being archived or received**: refused, with the reason.

Writing to a socket: the task's registry entry (`<data>/sessions/<pid>.json`, `name` = task id) gives
`messagingSocketPath`; its key file (`<pid>.<sha256 of that path>.key`) gives `peerToken`. Meddle connects and writes
two lines:

```
{"type":"auth","token":"<peerToken>"}
{"msgV":1,"msg_id":"<uuid>","type":"user","priority":"next","from":"uds:<meddle's socket>","message":{"role":"user","content":"<cross-session-message from=\"<sender task id>\">\n<text>\n</cross-session-message>"}}
```

The sender wraps the text: Claude Code shows the envelope as written, under its own "Another Claude session sent a
message" framing, and the model replies with `SendMessage` to the `from=` task id (seen with a hook catching it).
`from` on the line is a socket meddle listens on, named `<meddle pid>-<8 hex>.sock` in Claude Code's socket dir;
Claude Code sends its receipts there (held, refused, dropped), which meddle logs on the target's thread.

Not through stdin: a peer message the SDK host injects (with or without `origin: {kind: "peer"}`) gets Claude Code's
"its `from=` is a host session id that SendMessage cannot reach" note, and models then refuse to reply.

### A turn with no prompt

`runTurn`, `TurnInput` and `runTurnPhase` take an optional prompt. Without one: no prompt pushed, no `promptEvent`;
`turn_started` as usual, then a new `peer_message` event (`from`, `text`, `msg_id`) logged by meddle when the message
is written (Claude Code doesn't echo it to the host). `drive` must not end the turn at a resumed session's empty
first `result`, nor before the message's turn has started (its `init`); if the socket never registers (a timeout,
~30 s) the turn fails as a turn does and the message goes back to the queue. A message to a running turn logs the
same `peer_message` event in that turn.

A peer message is not the user's input: it doesn't take the task off the merge train's queue (`#inputRuns`). A
cut-off message turn is rerun as other cut-off turns are (`CARRY_ON_PROMPT`).

### What "sent" promises (my call)

The sender's result says the message reached the target's node and was handed to its task, never that the agent
read it (as Claude Code's own sends say). On the target, meddle keeps each message (by `msg_id`) until its turn shows
Claude Code took it; if the turn ends first (a running turn's last `result` racing the write), or a receipt says it
was dropped or refused, the message goes back to the task's queue and is delivered on its next turn. A receipt that
it is held is logged on the target's thread and nothing more.

### Queued messages (my call)

Queued messages wait in the task's queue with its prompts, in arrival order, and travel with the task when it moves,
as prompts do. The queue's entry carries the sender's task id, node id and title, so the dashboard can link to it.
The dashboard lists them in the queue as messages (the sender's title, the text), and the user can drop one; Take
back and Send now leave them alone (they aren't the user's text to edit), and a turn started for a queued prompt
also gets the messages queued before it, written to its socket once it registers.

### Dashboard

- The target's thread shows a `peer_message` as a message from the sender: the sender's title (linking to it), the
  text. Not styled as the user's.
- The sender's `SendMessage` to a task shows as the existing `MessageRow`, "Message to" the target's title, its
  summary; the result's failure in red as other failed calls.

## Approaches

- **Fake registry entries** for remote tasks, each pointing at a socket meddle owns, so Claude Code's own
  `SendMessage` writes to meddle. Works (an entry with a foreign `pidDomain` skips the liveness checks; a plain send
  checks no socket owner), but the line Claude Code writes names no recipient, so one socket per remote task; hooks
  do the same with less.
- **Deliver on stdin** (`origin: {kind: "peer"}`): the SDK's own way in, but Claude Code adds the "SendMessage cannot
  reach" note to anything a host injects, and models refuse to reply. Only Claude Desktop's entrypoints skip it, and
  `CLAUDE_CODE_ENTRYPOINT=local-agent` drops nearly all bundled skills and plugins, scrubs subprocess env, caps Sonnet
  5's context and changes ~29 Desktop-host checks: rejected.
- **A meddle tool** (`mcp__meddle__send_message`) for replies: works, but a second way to send when Claude Code's
  own is right there.
- **Picked:** hooks on `ListAgents`/`SendMessage` for the sending side; the target's own socket for delivery, a task
  started with no prompt when idle. Spiked end to end on 2.1.314 (fresh and resumed sessions).

## Calls left to the builder (marked as mine)

- The list cache's lifetime, and whether a task whose node is offline is listed (I'd leave it out).
- The exact text of rewritten results and rows (terse, matching Claude Code's).
- The sentinel `to` in PreToolUse; anything that can't collide with a real name.
- Whether meddle's receipt socket is one per node (I'd say yes) and how receipts show (a muted line on the target's
  thread).
- Message size: Claude Code caps a socket line; meddle refuses longer text before sending, with the cap in the result.

## Non-goals

- `notify_when_idle` to tasks; attachments with a message; messages to a node rather than a task.
- Messages between pools.
- Changing how live local sessions message each other outside task targets.
