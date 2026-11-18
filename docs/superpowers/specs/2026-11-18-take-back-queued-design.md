# Taking queued messages back

## Why

A message queued while a turn runs (`Queued` in `src/dashboard/ui/Task.tsx`) cannot be changed or withdrawn: a typo
goes to Claude as typed, and a message the turn has since made pointless still runs. Claude Code lets you pull queued
messages back into the input to fix or drop them; the composer should do the same, the way Claude Code does it.

## What changes

As Claude Code does by default (2.1.326, read from its bundle):

- **↑ in the composer**, with messages queued and the caret on the box's first line, takes back **every** queued
  message at once. With the caret on a later line ↑ moves it as usual; with nothing queued ↑ is the box's own.
- **Esc in the composer**, with messages queued, does the same. (Esc does nothing in the composer today.)
- **What lands in the box:** the taken-back texts, oldest first, joined with newlines; then, when the box already held
  text, a newline and that text. The caret keeps its place in the text that was there (Claude Code's `EJe`). Fixing a
  typo is: ↑, edit, Enter. Dropping them is: ↑, clear the box.
- **Only what was taken back.** The box fills from what the node answers it withdrew, never from what the page shows
  queued. A message Claude started on in the meantime stays where it is (it shows in the thread as taken, as today);
  if none could be taken back, the box is unchanged. While the request runs the composer says "Taking your messages
  back…" and a second ↑ or Esc does nothing.
- **Hint:** while messages are queued and the box is empty, the placeholder says "↑ to edit queued messages", and the
  queued bubble's tooltip mentions ↑ beside Ctrl+Enter. (Claude Code shows its hint only the first 3 times; not
  copied.)

## Where the messages are

`DurableRunner.queued(taskId)` answers two lists, and taking back clears both, in that order:

1. **The live turn's untaken steers** (`InputQueue.untaken()`). One the SDK has not read yet is dropped from the
   `InputQueue` outright. One already written to Claude Code is withdrawn with the `cancel_async_message` control
   request (`message_uuid`), which removes it from Claude Code's command queue unless it was already dequeued; it is
   taken back only when Claude Code says it cancelled it. A steer taken back leaves `untaken` unlogged, so the turn's
   end (which waits for untaken steers after a `result`) no longer waits for it.
2. **The task's queue for later turns** (`tasks.queued`): removed from the row.

A new task method, `takeBackQueued: method({}, { texts: string[] })`, does this and answers the texts withdrawn,
oldest first; `queued` listeners are told as usual. It is refused while the task is moving, as `prompt` is, since the
queue travels with it.

## Non-goals

- Taking back one message (Claude Code's select-then-Enter mode, behind `CLAUDE_CODE_KB_COHESION_FIXES`), or an ×
  on each queued bubble.
- ↑ falling through to earlier prompts (Claude Code's history); the composer has none.
- Images or pasted attachments: queued messages are text.

## Approaches

Picked in conversation from three, all from Claude Code:

1. ↑ on an empty box takes back the newest one; again for the next. Precise, but not what Claude Code does.
2. **↑ on the first line, or Esc, takes back all at once into the box (picked):** Claude Code's default, so the habit
   carries over.
3. ↑ selects a queued message, Enter takes back that one: Claude Code's experimental mode; a step more per message.

## Left to the builder

- The reply shape of `cancel_async_message` (the SDK's types leave it out; read it from the bundled CLI as
  `SEND_NOW` was) and how the session sends it (`ControlRequests` in `src/engine/session.ts`).
- Whether `InputQueue` can tell read from unread items as it stands (`#items` vs `#untaken`), or needs a method to drop
  an unread one.
- The pure part of the key handling goes in `composer-model.ts` (a `"take-back"` action from key, caret and
  `anyQueued`), tested in `test/ui.test.ts`; the runner's part is tested as `prompt` and `sendNow` are.
