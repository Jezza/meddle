# Taking Queued Messages Back Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ↑ (caret on the first line) or Esc in the composer takes every queued message back into the box, as
Claude Code does.

**Architecture:** Three layers, each tested on its own. The engine's `runTurn` gets `takeBack()`, which drops unread
steers from the `InputQueue` and withdraws written ones from Claude Code with `cancel_async_message`. The runner's
`takeBackQueued` combines that with clearing the task's `queued` column, exposed as the task method `takeBackQueued`.
The composer maps ↑/Esc to a `"take-back"` action and merges the returned texts into the box.

**Tech Stack:** Bun, TypeScript, Preact, `@anthropic-ai/claude-agent-sdk` 0.3.314 (Claude Code 2.1.326 behaviour),
typebox contracts.

**Spec:** `docs/superpowers/specs/2026-11-18-take-back-queued-design.md`

## Global Constraints

- Bun is at `/home/jezza/.bun/bin/bun` (not on PATH): `export PATH=$HOME/.bun/bin:$PATH`. This workspace has no
  `node_modules`: run `bun install --frozen-lockfile` once first.
- Run only the affected test files plus `bun run typecheck`; never the full suite (13 minutes).
- Commit with jj (`jj commit -m "…"`), one commit per task; no AI attribution in messages.
- Copy, verbatim: placeholder `↑ to edit queued messages`; in-flight row `Taking your messages back…`.
- The box fills only from what the node answers it withdrew, never from what the page shows queued.
- Match the surrounding code: doc comments in the files' voice, no new dependencies.

## Review Focus

1. **Claude takes a steer while it is being taken back:** it is not returned, and is logged once as taken → engine
   test "a steer Claude Code already took is not taken back" (Task 1).
2. **Taken back after the turn's `result`, while the turn waits on that steer:** the turn ends at once, not after the
   5 s grace, and the steer is not requeued for a next turn → engine test (Task 1), runner test (Task 2).
3. **A queued text whose turn is being started** (`startQueued` between `#createTurn` and removing the head): it is
   not taken back, so it never both runs and lands in the box → runner test "a text whose turn is starting stays"
   (Task 2).
4. **Text already in the box, caret mid-text:** the taken-back texts go above it and the caret keeps its place in it →
   `withTakenBack` test (Task 3).
5. **↑ on a later line, with a modifier, or during IME composition:** the box's own ↑ → `composerKey` test (Task 3).

---

### Task 1: The engine takes steers back

**Files:**
- Modify: `src/engine/input.ts` (InputQueue)
- Modify: `src/engine/session.ts` (`runTurn`, `drive`, `ControlRequests`)
- Modify: `test/fake-claude/replay.ts` (answer `cancel_async_message`)
- Test: `test/engine.test.ts`

**Interfaces:**
- Produces: `InputQueue.drop(uuid: string): "dropped" | "written" | "gone"`. `"dropped"`: it was still unread in
  `#items`, so it is removed from `#items` and `#untaken` (and `written()` waiters are told if that made it written).
  `"written"`: it is untaken but already read by the SDK. `"gone"`: it is not untaken.
- Produces: `runTurn(...)` also returns `takeBack: () => Promise<string[]>`: the texts withdrawn, oldest first.

- [ ] **Step 1: Teach the stand-in `cancel_async_message`.** In `replay.ts`'s stdin handler, a `control_request` with
  `request.subtype === "cancel_async_message"`: when an arrived, unused `user` frame has `uuid === request.message_uuid`,
  mark it used and answer `{ cancelled: true, message_uuid }`; otherwise answer `{ cancelled: false }`. Never treat it as
  an interrupt. Add one line for it to the header comment. (Claude Code 2.1.326 answers exactly these shapes; print
  mode answers `{ cancelled }`.)

- [ ] **Step 2: Write the failing tests** in `test/engine.test.ts`:

```ts
test("input queue: drop removes an unread text, and tells a read one from one that is gone", async () => {
  const q = new InputQueue();
  const a = q.push("a"), b = q.push("b");
  expect(q.drop(b)).toBe("dropped");
  expect(q.untaken()).toEqual([{ uuid: a, text: "a" }]);
  const it = q[Symbol.asyncIterator]();
  expect((await it.next()).value.uuid).toBe(a);
  expect(q.drop(a)).toBe("written");
  expect(q.drop(b)).toBe("gone");
  q.take(a);
  expect(q.drop(a)).toBe("gone");
});
test("take back withdraws a steer Claude Code holds: it is never logged, and the turn goes on without it", async () => {
  // hello + MEDDLE_FIXTURE_STALL: at the first assistant message push STEER, then `await turn.takeBack()`
  // expect: takeBack resolves [STEER]; queue.untaken() is []; then turn.query.interrupt() ends the turn;
  // the logged user texts are only ["Reply with the single word ok."]
}, 15_000);
test("a steer Claude Code already took is not taken back", async () => {
  // steer-fold: push STEER at the first assistant message; once its user event is logged (onMessage sees a user
  // message with content STEER), call takeBack()
  // expect: takeBack resolves []; STEER is logged exactly once; result is "done\n\nPINEAPPLE"
}, 15_000);
test("taking back the steer a finished turn waits on ends the turn at once", async () => {
  // hello (no stall): push STEER at the assistant message; at the `result` call takeBack()
  // expect: takeBack resolves [STEER]; `done` resolves { result: "ok" } within 2_000 ms of the result (well under
  // EXIT_GRACE_MS = 5_000); queue.untaken() is []
}, 15_000);
```

- [ ] **Step 3: Run them to see them fail**

Run: `bun test test/engine.test.ts`
Expected: the four new tests FAIL (`drop` / `takeBack` is not a function); the existing ones pass.

- [ ] **Step 4: Implement.**
  - `InputQueue.drop` as in Interfaces.
  - `takeBack` in `runTurn`, for each `queue.untaken()` in order:
    - `drop` → `"dropped"`: withdrawn.
    - `"written"`: first `await queue.written()` (Claude Code can cancel only what it has read). Then send
      `{ subtype: "cancel_async_message", message_uuid }` through `ControlRequests.request`. When the reply's
      `response.cancelled === true` and `queue.take(uuid) !== null`, it is withdrawn.
    - A rejected request (a Claude Code without it) counts as not cancelled.
    - Widen `ControlRequests.request` to a union of the two request shapes and their replies.
  - Afterwards, when the turn's `result` is in, nothing is untaken and no background work is live, end the input
    then, as `drive` does at a `result`. Give `drive` a way to be asked (e.g. a `recheck` callback it sets up) rather
    than duplicating its state.

- [ ] **Step 5: Run the tests to see them pass**

Run: `bun test test/engine.test.ts && bun run typecheck`
Expected: all pass, no type errors.

- [ ] **Step 6: Commit**

```bash
jj commit -m "engine: take back steers a turn has not taken"
```

### Task 2: The runner and the task method

**Files:**
- Modify: `src/tasks/durable.ts` (`LiveTurn`, the turn start that builds it near line 810, new `takeBackQueued`)
- Modify: `src/state/contracts.ts` (task methods, beside `sendNow`)
- Modify: `src/state/host.ts` (task method wiring, beside `sendNow` near line 830)
- Test: `test/durable.test.ts`

**Interfaces:**
- Consumes: `runTurn(...).takeBack` (Task 1).
- Produces: `DurableRunner.takeBackQueued(taskId: string): Promise<string[]>`.
- Produces: the contract method `takeBackQueued: method(Type.Object({}), Type.Object({ texts: Type.Array(Type.String()) }))`,
  doc comment in the style of `sendNow`'s; the host answers `{ texts: await runner.takeBackQueued(id) }`.

- [ ] **Step 1: Write the failing tests** in `test/durable.test.ts` (use its `setup`, `open`, `eventually`):

```ts
test("take back answers a task's queued texts, the live turn's steers first, and leaves nothing queued", async () => {
  // stalling runner (MEDDLE_FIXTURE_STALL: "1"); prompt "Reply with the single word ok."; at the first assistant
  // message `await runner.prompt(m.id, STEER)`; then write queued ["later"] to the row (updateTask from
  // ../src/store/records)
  // expect: await runner.takeBackQueued(m.id) → [STEER, "later"]; runner.queued(m.id) → []; onQueued told [];
  // after runner.interrupt(m.id) and the turn's end, no second turn starts and STEER is never logged
}, 30_000);
test("take back on an idle task with nothing queued answers []", async () => {
  // expect: await runner.takeBackQueued(m.id) → []
});
test("a text whose turn is starting stays", async () => {
  // queued ["a", "b"] on an idle task; start runner.startQueued(m.id) without awaiting it, then call
  // takeBackQueued before it resolves
  // expect: the answer is ["b"]; "a" runs as the next turn's prompt
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test test/durable.test.ts -t "take back|whose turn is starting"`
Expected: FAIL (`takeBackQueued` is not a function).

- [ ] **Step 3: Implement `takeBackQueued(taskId)`.**
  - Call `#refuseElsewhere(taskId)` first, as `sendNow` does, so a moving, moved or archived task is refused.
  - Take back the live turn's steers via `LiveTurn.takeBack` (add it to `LiveTurn`).
  - Then remove the row's `queued` in one transaction. While `#pending.has(taskId)`, keep its first text, since its
    turn may be starting.
  - `#emitQueued(taskId)`, then answer the live texts followed by the row's.
  - Add the contract method and the host wiring.

- [ ] **Step 4: Run the tests to see them pass**

Run: `bun test test/durable.test.ts test/state.test.ts && bun run typecheck`
Expected: all pass. (`state.test.ts` checks the contracts against the host.)

- [ ] **Step 5: Commit**

```bash
jj commit -m "tasks: take back what a task has queued"
```

### Task 3: The composer

**Files:**
- Modify: `src/dashboard/ui/composer-model.ts`
- Modify: `src/dashboard/ui/Task.tsx` (`Composer`, `Queued`)
- Test: `test/ui.test.ts`

**Interfaces:**
- Consumes: `task.takeBackQueued({})` → `{ texts: string[] }` (Task 2).
- Produces: `composerKey(e, { running, touch, anyQueued, value, caret }): "send" | "send-now" | "take-back" | null`.
  `caret` is the textarea's `selectionStart`. `ComposerKeyEvent` stays as it is. The existing Enter rules are unchanged.
- Produces: `withTakenBack(texts: string[], draft: string, caret: number): { text: string; caret: number }`.

- [ ] **Step 1: Write the failing tests** in `test/ui.test.ts`. Add `anyQueued: false, value: "", caret: 0` to the
  existing test's `desk`, then:

```ts
test("composerKey: ↑ on the box's first line, or Esc, takes queued messages back; otherwise they are the box's", () => {
  const key = (k: Partial<Parameters<typeof composerKey>[0]>) => ({ key: "ArrowUp", shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, keyCode: 38, ...k });
  const q = { running: true, touch: false, anyQueued: true, value: "one\ntwo", caret: 2 };
  expect(composerKey(key({}), q)).toBe("take-back");
  expect(composerKey(key({ key: "Escape", keyCode: 27 }), { ...q, caret: 6 })).toBe("take-back");
  expect(composerKey(key({}), { ...q, caret: 6 })).toBeNull();          // second line
  expect(composerKey(key({}), { ...q, caret: 3 })).toBe("take-back");   // end of the first line
  expect(composerKey(key({}), { ...q, anyQueued: false })).toBeNull();
  expect(composerKey(key({ key: "Escape", keyCode: 27 }), { ...q, anyQueued: false })).toBeNull();
  expect(composerKey(key({ shiftKey: true }), q)).toBeNull();
  expect(composerKey(key({ isComposing: true }), q)).toBeNull();
});
test("withTakenBack: the texts, oldest first, above what the box held; the caret keeps its place in it", () => {
  expect(withTakenBack(["a", "b"], "", 0)).toEqual({ text: "a\nb", caret: 3 });
  expect(withTakenBack(["a", "b"], "xyz", 1)).toEqual({ text: "a\nb\nxyz", caret: 5 });
  expect(withTakenBack([], "xyz", 1)).toEqual({ text: "xyz", caret: 1 });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test test/ui.test.ts`
Expected: the new tests FAIL (`withTakenBack` not exported, `"take-back"` never answered).

- [ ] **Step 3: Implement** `composerKey`'s take-back rule and `withTakenBack` (Claude Code's `EJe`: when there are
  no texts, the draft unchanged; when the draft is empty, the texts with the caret at their end; otherwise
  `${texts}\n${draft}` with the caret at `texts.length + 1 + caret`). Update the doc comment.

- [ ] **Step 4: Wire `Composer`.**
  - On `"take-back"`: `preventDefault`, and ignore the key while a take-back is in flight.
  - Call `task.takeBackQueued({})`. Then `setText((t) => withTakenBack(texts, t, caretAtReply).text)`, reading
    `caretAtReply` from `box.current.selectionStart` when the reply comes. After render, set the box's selection to
    the returned caret.
  - While in flight, show a `composer-row` reading `Taking your messages back…`.
  - On an error, show `Not taken back: <error>` in the `composer-row error` style that `nowError` uses.
  - Placeholder: when `anyQueued && !touch` and the box is not disabled, `↑ to edit queued messages`.
  - `Queued` tooltip: append `; ↑ or Esc in the box takes it back to edit`.

- [ ] **Step 5: Run the tests to see them pass**

Run: `bun test test/ui.test.ts && bun run typecheck`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
jj commit -m "dashboard: ↑ or Esc takes queued messages back into the box"
```

- [ ] **Step 7: See it in the real app** (`run` skill). Start a task on a long turn and queue two messages. ↑ in the
  empty box brings both back, oldest first, and the queued bubbles go. Clearing the box and sending nothing leaves
  nothing queued.
