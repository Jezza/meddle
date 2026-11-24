# Cross-node agent messaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent's `SendMessage` to a task id reaches that task's agent wherever in the pool it is held, waking it when idle; `ListAgents` lists the pool's tasks.

**Architecture:** SDK hooks take over `SendMessage`/`ListAgents` for task targets and hand messages to a `Messenger`, which finds the holder and calls a new `PeerObject.message` (or the local runner). The holder's `TaskRunner.message` writes the message into the task's Claude Code through Claude Code's own peer socket (`PeerInbox`), starting a turn with no prompt when the task is idle. Queued messages are `Prompt`s with a `peer` field, so the existing queue, move and dashboard plumbing carries them.

**Tech Stack:** TypeScript on Bun, `@anthropic-ai/claude-agent-sdk` 0.3.328 driving pinned Claude Code 2.1.314, chord (`PeerObject`), typebox, preact dashboard, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-11-24-cross-node-messaging-design.md`

## Global Constraints

- Claude Code is pinned at 2.1.314; every wire detail here is read from it: socket lines `{"type":"auth","token":<peerToken>}` then `{msgV:1,msg_id,uuid,type:"user",priority:"next",from:"uds:<path>",message:{role:"user",content}}`, each `\n`-terminated, at most 1 MiB a line (Claude Code's cap). The SDK reports a socket message by its `uuid` as `command_lifecycle` (`queued`/`started` before it runs, `completed` after the turn's `result`); it never echoes the message itself.
- A task's address is its id (12 lowercase hex); the envelope is exactly `<cross-session-message from="<sender task id>">\n<text>\n</cross-session-message>`.
- Message text is at most 256 KiB (UTF-8): refused by the sender's node above that.
- Registry: `<taskConfig>/sessions/<pid>.json` (`name`, `sessionId`, `messagingSocketPath`, `pid`), key `<pid>.<sha256 hex of messagingSocketPath>.key` (`peerToken`). Read through the task's config dir, not `<data>/sessions`: tasks provisioned before the shared registry keep a private one.
- A message never counts as the user's input: no path that runs one calls `#inputRuns`.
- No limit on waking (spec: accepted).
- User-facing text: terse, name the thing, one term per concept ("message").
- Tests: `~/.bun/bin/bun test <files>` for affected files and `~/.bun/bin/bun run typecheck`; never the full suite.
- Commits: jj, one revision per task, `jj describe -m "<4-7 words>"` then `jj new`; no AI attribution.

## Review Focus

- A socket that never registers, or a message Claude Code never starts (dropped, refused, held): a message-only turn fails as a turn does within its deadline and the message goes back to the queue, never lost and never a hung `running` task — Task 4 tests `…never registers…`, `…never started…`; Task 5 test `a dropped receipt fails a message-only turn`.
- A running turn ends between the write and Claude Code taking it, or after its input closed: the message is requeued once, not lost and not duplicated — Task 4 `…handed back untaken`, Task 5 `a message after the turn's result waits for the next turn`.
- A stale registry entry or an earlier turn's locate still polling: never written to, never writes into the next turn — Task 2 `findSocket skips an entry whose pid is gone`, Task 3 `end stops a pending locate`.
- A message to the sender's own id, an unknown id, a task on an offline node, an archived task, or over 256 KiB: a failure result saying which, nothing delivered — Tasks 6–7.
- A member running an older meddle (no `tasks`/`message`), or one that hangs: its tasks aren't listed, the listing still answers within the member timeout — Task 6 `a member without tasks() is left out`, `a hung member is left out after the timeout`.

---

### Task 1: A queued prompt can be a message

**Files:**
- Modify: `src/blobs/attachment.ts` (`PromptSchema`, `promptOf`, `queueEntry`)
- Test: `test/attachment.test.ts`

**Interfaces:**
- Produces: `PeerFromSchema = Type.Object({ taskId: Type.String(), nodeId: Type.String(), title: Type.String() })`, `type PeerFrom`; `PromptSchema` gains `peer: Type.Optional(PeerFromSchema)`; `type PeerPrompt = Prompt & { peer: PeerFrom }`; `isPeerPrompt(p: Prompt): p is PeerPrompt`; `promptOf`/`queueEntry` keep `peer`. A peer prompt always has `attachments: []`.

- [ ] **Step 1: Write the failing tests** — `promptOf keeps a message's sender` (round-trips `{ text: "hi", attachments: [], peer: { taskId: "aaaaaaaaaaaa", nodeId: "n1", title: "Quiet fox" } }`); `queueEntry of a message is the object, not the text`; `promptOf rejects a malformed sender` (`peer: { taskId: 1 }` throws `bad queued prompt`).
- [ ] **Step 2: Run** `~/.bun/bin/bun test test/attachment.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** test + `~/.bun/bin/bun run typecheck` — PASS.
- [ ] **Step 5: Commit** `jj describe -m "Queue a message as a prompt"` && `jj new`.

### Task 2: Writing to a Claude Code's peer socket

**Files:**
- Create: `src/engine/peer-socket.ts`
- Test: `test/peer-socket.test.ts`

**Interfaces:**
- Produces:
  - `envelope(fromTaskId: string, text: string): string`.
  - `type PeerSocket = { path: string; token: string | null }`.
  - `findSocket(sessionsDir: string, name: string, opts?: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal }): Promise<PeerSocket>` — polls (default 100 ms, timeout 30 000 ms) for a `<pid>.json` whose `name` is `name` (the task id), with `messagingSocketPath`, its pid alive (`process.kill(pid, 0)`; EPERM counts as alive); token from its key file, `null` when absent. Rejects `Error("messaging socket never registered")` on timeout, `AbortError` on `signal`.
  - `writePeerLine(sock: PeerSocket, line: { uuid: string; from: string; content: string }): Promise<void>` — auth line (when a token) then the message line (`msg_id` = `uuid`); 5 s connect timeout.

- [ ] **Step 1: Write the failing tests** (temp dir, `node:net` server): `envelope wraps the text for the sender` (exact string); `findSocket finds the task's entry and its token`; `findSocket skips an entry whose pid is gone` (pid `2 ** 22 + 1`, `timeoutMs: 300` → rejects `messaging socket never registered`); `findSocket waits for the entry to appear` (written after 200 ms); `findSocket stops when aborted`; `writePeerLine sends auth then the message` (exactly two lines, fields as above).
- [ ] **Step 2: Run** `~/.bun/bin/bun test test/peer-socket.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** + typecheck — PASS.
- [ ] **Step 5: Commit** `jj describe -m "Write messages to Claude Code sockets"` && `jj new`.

### Task 3: A turn's peer inbox

**Files:**
- Create: `src/engine/peer-inbox.ts`
- Test: `test/peer-inbox.test.ts`

**Interfaces:**
- Consumes: Task 2; `PeerPrompt` (Task 1).
- Produces: `class PeerInbox` — `constructor(locate: (signal: AbortSignal) => Promise<PeerSocket>, replyTo: () => string, opts?: { startMs?: number /* 30 000 */ })`;
  - `push(p: PeerPrompt): string` — a fresh uuid; written in push order after `locate` resolved once (cached);
  - `queued(uuid: string): boolean` — true while Claude Code said it queued it (`noteQueued`) and has not taken it; `noteQueued(uuid: string): void`;
  - `take(uuid: string): PeerPrompt | null`;
  - `fail(uuid: string, reason: string): void` — a receipt said dropped/refused: settles `failed` with that reason while the message stays untaken;
  - `untaken(): Array<{ uuid: string; prompt: PeerPrompt }>` oldest first;
  - `readonly failed: Promise<Error>` — settles (never rejects) on the first locate/write failure, `fail`, or a written message not taken within `startMs`;
  - `end(): void` — aborts a pending locate (its signal) and any write not yet started; nothing is written after it.

- [ ] **Step 1: Write the failing tests** (fake socket server, stub `locate`): `writes pushed messages in order once located`; `take marks a message taken and untaken lists the rest`; `a failed locate settles failed and leaves messages untaken`; `a message not taken within startMs settles failed`; `fail settles failed with the receipt's reason`; `end stops a pending locate and nothing is written after it`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**; the line's `from` is `"uds:" + replyTo()`.
- [ ] **Step 4: Run** + typecheck — PASS.
- [ ] **Step 5: Commit** `jj describe -m "Track messages written to a turn"` && `jj new`.

### Task 4: Turns with no prompt, and messages in turns

**Files:**
- Modify: `src/engine/session.ts` (`MeddleEvent`, `RunTurnArgs`, `runTurn`, `drive`)
- Modify: `test/fake-claude/replay.ts` (peer mode)
- Test: `test/engine.test.ts`

**Interfaces:**
- Consumes: `PeerInbox` (Task 3).
- Produces:
  - `MeddleEvent` gains `{ type: "meddle"; subtype: "peer_message"; from: PeerFrom; text: string; uuid: string }` and `{ type: "meddle"; subtype: "peer_receipt"; uuid: string; status: string; reason?: string }`.
  - `RunTurnArgs.prompt?: Prompt` (absent: no stdin prompt, no `promptEvent`) and `RunTurnArgs.inbox?: PeerInbox`; `runTurn` returns `{ query, done, sendNow, takeBack, inbox }` (the one passed, or a fresh one).
  - `drive(…, prompt: string | null, …)`: `promptQueued` only for a non-null uuid; a `command_lifecycle queued` naming an inbox uuid → `inbox.noteQueued`; a uuid `takenBy` names that `inbox.take` answers logs `peer_message` (before the frame that says so) and calls `goOn`; `endIfDone` also needs `inbox.untaken()` empty; a `result` is not the turn's while a message-only turn's (prompt null) message is untaken or queued — no grace starts then; for a message-only turn only, a settled `inbox.failed` while its message is untaken ends the turn: `turn_failed` (error = the reason), `done` rejects; in a prompt turn it changes nothing (the message stays untaken). `finally` calls `inbox.end()` before anything reads `untaken()`.
- Replayer peer mode (`MEDDLE_FIXTURE_PEER=1`): at start writes `<CLAUDE_CONFIG_DIR>/sessions/<pid>.json` (`pid`, `sessionId` = `sessionArg()`, `name` = `CLAUDE_CODE_SESSION_NAME`, `messagingSocketPath` in a temp dir) and its key (`peerToken` random), listens; a socket `type:"user"` line after a matching auth line is pushed to `arrived` as a user frame (uuid = its `uuid`), appended to `MEDDLE_FIXTURE_INPUT` with `"via":"socket"`, and answered `command_lifecycle queued`; when the recording uses it, emits `started` for its uuid, and `completed` after the next `result`. Removes its entry on exit. `MEDDLE_FIXTURE_PEER_SKIP=1` never registers; `MEDDLE_FIXTURE_PEER_IGNORE=1` registers but never uses socket frames.

- [ ] **Step 1: Write the failing tests** (replayer, peer mode):
  - `a turn with no prompt runs the message Claude Code takes from its socket` — `hello.jsonl`, no prompt, inbox with one message: log `turn_started`, `peer_message` (from, text), frames, `result`; no prompt event; one `via: socket` input line whose content is the envelope.
  - `a resumed session's empty result does not end a message-only turn` — a fixture beginning with an empty `result` before the user step (`background-resume.jsonl` if it fits, else a trimmed copy saved as `test/fixtures/peer-resume.jsonl`): the turn ends at the message's `result`, after `peer_message`.
  - `a message folded into a running turn is logged where it was taken` — `steer-fold.jsonl`, stdin prompt, message pushed after the first `assistant`: `peer_message` logged before the turn's `result`, inbox empty at the end.
  - `a message the turn did not take is handed back untaken` — `hello.jsonl` with `MEDDLE_FIXTURE_RESULTS_MS`, message pushed before its `result`: `done` resolves, `inbox.untaken()` has it, no `peer_message`.
  - `a peer turn whose socket never registers fails and hands its message back` — `MEDDLE_FIXTURE_PEER_SKIP=1`, locate timeout 300 ms.
  - `a message Claude Code never starts fails its message-only turn` — `MEDDLE_FIXTURE_PEER_IGNORE=1`, `startMs: 300`: `turn_failed`, message untaken.
- [ ] **Step 2: Run** `~/.bun/bin/bun test test/engine.test.ts test/fake-claude/replay.test.ts` — FAIL.
- [ ] **Step 3: Implement** the replayer mode, then `session.ts`.
- [ ] **Step 4: Run** both files + typecheck — PASS, existing engine tests unchanged.
- [ ] **Step 5: Commit** `jj describe -m "Run turns started by messages"` && `jj new`.

### Task 5: The runner delivers messages

**Files:**
- Modify: `src/tasks/durable.ts` (`TurnInput`, `LiveTurn`, `runTurnPhase`, `startQueued`, `queued`, `#takeBackQueued`, `#engineInput`, new `message`, `dropQueued`, `#messageSocket`)
- Test: `test/durable.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces:
  - `TurnInput.messages?: PeerPrompt[]` — written through the turn's inbox. `prompt` stays a string: a turn of messages only has `prompt: ""` and runs with no stdin prompt.
  - Reruns of such a turn (durable `run` re-entered): if a `peer_message` was logged since its last `turn_started`, it reruns as a cut-off turn does now (`CARRY_ON_PROMPT`, or the token retry), otherwise it delivers its messages again.
  - At turn end the inbox's untaken messages go `#requeueFront` with the stdin steers — except the turn's own `messages` when the turn was aborted (the durable rerun delivers those).
  - `TaskRunner.message(taskId: string, from: PeerFrom, text: string): Promise<"delivered" | "waking" | "queued">` — serialised with `prompt` (`prompt\0<id>`); refused as `#refusePrompt` refuses (a moving task's queue takes it: `"queued"`). A running user turn whose input has not ended (`!live.queue.ended && this.#live.get(taskId)?.queue === live.queue`): `live.inbox.push` → `"delivered"`. A train turn, an ended input, a queue ahead, a pending turn or a pool hold: `#enqueueNext` → `"queued"`. Idle: `#createTurn({ taskId, prompt: "", messages: [p] })` → `"waking"`.
  - `startQueued`: takes the head run — the leading peer prompts plus the first non-peer prompt after them, if any — into one turn (`prompt` = that prompt's text or `""`, `messages` = the peer prompts); removes exactly those entries once the turn exists; calls `#inputRuns` only when the run has a non-peer prompt.
  - `queued()` lists live steers, then the live inbox's untaken messages, then the queue. `#takeBackQueued` leaves peer prompts where they are.
  - `TaskRunner.dropQueued(taskId: string, entry: Prompt): Promise<void>` — removes the first queued peer prompt `Bun.deepEquals` to `entry`; throws `not a queued message` when there is none.
  - `#engineInput`: the inbox's `locate` is `(signal) => findSocket(join(paths(cfg).taskConfig(taskId), "sessions"), taskId, { signal })`; `replyTo` is `#messageSocket()`.
  - `#messageSocket(): string` — listens once on `<dir of the first located socket>/<process.pid>-<8 hex>.sock` (closed with the runner); a `{type:"control", action:"peer_message_status", orig_msg_id, status, reason?}` line is logged as `peer_receipt` on the task whose live inbox wrote `orig_msg_id`; `status` `dropped`, `expired` or `refused` also calls that inbox's `fail(orig_msg_id, …)`; any other line is ignored.

- [ ] **Step 1: Write the failing tests** (replayer peer mode):
  - `a message to an idle task wakes it` — `"waking"`; `peer_message` with `from`; task back to `idle`.
  - `a message to a running turn is written into it` — `steer-fold.jsonl`, sent after the turn's first `assistant` → `"delivered"`; `peer_message` before the turn's `result`.
  - `a message after the turn's result waits for the next turn` — sent once its input ended → `"queued"`, then its own turn.
  - `a message to a train turn waits for the next turn` / `a queued message behind a train turn starts its own turn and leaves the train's queue alone`.
  - `messages queued ahead of a prompt go into its turn` — two messages then a prompt queued: one turn, two `peer_message`s and the prompt.
  - `take-back leaves messages queued` / `dropQueued drops a message and refuses a prompt`.
  - `a dropped receipt fails a message-only turn and requeues the message` — a fake receipt line on `#messageSocket()`.
  - `a message to an archived task is refused`.
- [ ] **Step 2: Run** `~/.bun/bin/bun test test/durable.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `test/durable.test.ts test/queue.test.ts test/engine.test.ts` + typecheck — PASS.
- [ ] **Step 5: Commit** `jj describe -m "Deliver messages to tasks"` && `jj new`.

### Task 6: Pool: listing tasks and carrying messages

**Files:**
- Modify: `src/state/contracts.ts` (`PeerObject.variants.peer.methods`), `src/state/host.ts` (`servePeer`, `PeerObjectDeps.runner`, wiring a `Messenger`)
- Create: `src/tasks/messenger.ts`
- Test: `test/messenger.test.ts`, `test/state.test.ts`

**Interfaces:**
- Consumes: `TaskRunner.message` (Task 5), `PeerFromSchema` (Task 1), `PoolRuntime` (`net.isOnline`, `peerRef`, roster).
- Produces:
  - `PeerObject.tasks: method(Type.Object({}), Type.Array(Type.Object({ id: Type.String(), title: Type.String(), state: Type.String() })))` — members only; tasks not `archived`/`moved`/`receiving`, no merge tasks. Doc: "A node older than this method has none".
  - `PeerObject.message: method(Type.Object({ to: Type.String(), from: PeerFromSchema, text: Type.String() }), Type.Union([Type.Literal("delivered"), Type.Literal("waking"), Type.Literal("queued")]))` — members only; refusals as `ChordError` with the runner's reason.
  - `TaskRunner.listLive(): Array<{ id: string; title: string; state: string }>` — the same filter.
  - `type TaskEntry = { id: string; title: string; state: string; nodeId: string; nodeName: string }`; `type SendOutcome = { ok: true; how: "delivered" | "waking" | "queued"; title: string } | { ok: false; reason: string }`.
  - `class Messenger` — `constructor(deps: { selfId: string; runner: Pick<TaskRunner, "message" | "listLive">; pool?: PoolRuntime; cacheMs?: number /* 5 000 */; memberMs?: number /* 3 000 */ })`;
    - `directory(): Promise<TaskEntry[]>` — this node's plus each online member's `tasks()`, in parallel, each member bounded by `memberMs` (a failing, hung or older member left out); cached `cacheMs`.
    - `send(from: PeerFrom, to: string, text: string): Promise<SendOutcome>` — over 256 KiB → `"message is over 256 KiB"`; `to === from.taskId` → `"that is this task"`; in the directory → this node's runner or the holder's `message` (offline before/during the call → `"node <name> is offline"`, refusal → its reason); not in it → one fresh directory read, then `"no task <to>"`, or `"its node is offline"` when the id is a task of an offline member known from line rows (`listLineRows`), else the first.

- [ ] **Step 1: Write the failing tests** (`Messenger` with a fake pool): `directory lists this node's tasks and each online member's`; `a member without tasks() is left out`; `a hung member is left out after the timeout` (`memberMs: 100`); `send to this node's task goes to the runner`; `send to a remote task calls its holder's message`; `send to an unknown id fails`; `send to itself fails`; `send over 256 KiB fails`; `a holder that goes offline mid-call fails as offline`. `test/state.test.ts`: `PeerObject.tasks and message refuse a non-member`.
- [ ] **Step 2: Run** `~/.bun/bin/bun test test/messenger.test.ts test/state.test.ts` — FAIL.
- [ ] **Step 3: Implement**; one `Messenger` per node, made where the runner and `servePeer` are wired, handed to the runner (`TaskRunner.setMessenger(m)`).
- [ ] **Step 4: Run** + typecheck — PASS.
- [ ] **Step 5: Commit** `jj describe -m "Carry messages between nodes"` && `jj new`.

### Task 7: Hooks on SendMessage and ListAgents

**Files:**
- Create: `src/engine/messaging-hooks.ts`
- Modify: `src/engine/options.ts` (`EngineInput.messaging`, `buildOptions`), `src/tasks/durable.ts` (`#engineInput` sets `messaging` when a messenger is set)
- Test: `test/messaging-hooks.test.ts`, `test/options.test.ts`

**Interfaces:**
- Consumes: `Messenger.directory`, `Messenger.send`, `TaskEntry`, `SendOutcome` (Task 6).
- Produces:
  - `type Messaging = { selfId: string; directory(): Promise<TaskEntry[]>; send(to: string, text: string): Promise<SendOutcome> }` (the runner closes `send` over the task's `PeerFrom`).
  - `taskTarget(to: unknown): string | null` — `to` with a trailing ` [<hex>]` dropped, when it is 12 lowercase hex; else null.
  - `messagingHooks(m: Messaging): { PreToolUse: HookCallbackMatcher[]; PostToolUse: HookCallbackMatcher[] }` — `PreToolUse` (`SendMessage`): a `taskTarget` keeps `{ to, message, notify }` by `tool_use_id` and answers `updatedInput: { ...input, to: "meddle-routed-message" }`. `PostToolUse` (`SendMessage|ListAgents`): a kept call → `notify_when_idle` refused, else `send`; answers `updatedToolOutput: { success, message, display }`; `ListAgents` → the response with `listing` = `listingWith(listing, await directory(), selfId)`.
  - `listingWith(listing: string, entries: TaskEntry[], selfId: string): string` — rows `- <id> — <title> · <nodeName> · <busy|idle>` (busy = `running`/`waiting`) for entries not `selfId` and not already named in `listing`; when it adds any, the "No reachable agents…" paragraph goes.
  - Texts: `Sent to <title> (<id>).`; `Sent to <title> (<id>); it was idle and starts a turn for it.`; `Queued for <title> (<id>); it gets it on its next turn.`; `Not sent: <reason>.`; `Not sent: notify_when_idle is not available for tasks.` — `display` the same.
  - `buildOptions` merges these with `PermissionDenied` and the file `PostToolUse`.

- [ ] **Step 1: Write the failing tests** — `a SendMessage to a task id is routed through meddle`; `a SendMessage to a subagent name is left alone`; `a ref suffix still names the task`; `a task the directory does not list is still routed` (send answers its failure); `a failed send says why`; `notify_when_idle to a task is refused without sending`; `listingWith adds the pool's tasks and drops the no-agents line`; `listingWith leaves out the task itself and ones already listed`. `test/options.test.ts`: `messaging hooks join the file hook`.
- [ ] **Step 2: Run** `~/.bun/bin/bun test test/messaging-hooks.test.ts test/options.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** + typecheck — PASS.
- [ ] **Step 5: Commit** `jj describe -m "Route SendMessage to tasks"` && `jj new`.

### Task 8: Dashboard

**Files:**
- Modify: `src/dashboard/ui/thread-model.ts`, `src/dashboard/ui/Task.tsx`, `src/state/contracts.ts` (`TaskObject.dropQueued`), `src/state/host.ts`
- Test: `test/thread-model.test.ts`

**Interfaces:**
- Consumes: `peer_message`/`peer_receipt` (Task 4), `TaskRunner.dropQueued` (Task 5), `taskTarget` (Task 7, pure: import it), `PeerFrom`.
- Produces:
  - `ThreadItem` gains `{ kind: "peer"; from: PeerFrom; text: string }`; `peer_receipt` becomes a `status` item `message <status>`.
  - A `SendMessage` tool item whose input `to` is a `taskTarget` gets `messageTo: string` and `failed: boolean` (its result's `success === false`, read from the result text's JSON).
  - `Task.tsx`: the `peer` item renders as a message from `<title>` linking to `hashOf({ name: "task", nodeId, id })`, not styled as the user's; a `messageTo` call renders as a one-line row "Message to <title or id>" with its `summary` (adapting `MessageRow`, which today needs `resumes`), red when `failed`; the queue lists peer prompts as "From <title>" with a drop control (`TaskObject.dropQueued({ entry })`), not taken back.
  - `TaskObject.dropQueued: method(Type.Object({ entry: PromptSchema }), Type.Object({}))`.

- [ ] **Step 1: Write the failing tests**: `a peer message is its own item with its sender`; `a SendMessage to a task id names the task`; `a failed SendMessage to a task is marked failed`; `a receipt is a status line`.
- [ ] **Step 2: Run** `~/.bun/bin/bun test test/thread-model.test.ts` — FAIL.
- [ ] **Step 3: Implement** the model, the rows, the queue entries and `dropQueued`.
- [ ] **Step 4: Run** `test/thread-model.test.ts test/state.test.ts` + typecheck — PASS; then look at it on a throwaway dev node (port 7790, Playwright from the bun cache).
- [ ] **Step 5: Commit** `jj describe -m "Show task messages in the dashboard"` && `jj new`.

### Task 9: Live check

**Files:** none (verification only).

- [ ] **Step 1:** Throwaway node, real pinned Claude Code, two tasks: task A asked to `ListAgents` and message idle task B for a one-word reply. Expected: B wakes, its thread shows the message from A; B's reply wakes A and shows on A's thread.
- [ ] **Step 2:** B mid-turn (a long prompt): the message lands in B's running turn, logged once (no duplicate `peer_message`, no second turn for it) — confirms `started` comes for a message folded into a running turn.
- [ ] **Step 3:** Report what was seen; no commit.
