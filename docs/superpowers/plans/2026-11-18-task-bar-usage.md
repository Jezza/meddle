# Usage and Context in the Task Bar and Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each task's context fill and its node's active login's 5-hour/7-day plan usage as meters in the task
bar, and every token's latest usage reading in the Settings Tokens table.

**Architecture:** Turns record each `rate_limit_event`'s `unifiedWindows` against the token they picked, in a local
`token_usage` table; `NodeObject` publishes those readings (`tokenUsage`) and the active token's one (`activeUsage`).
Context fill is folded from the task log's latest main-thread assistant message into `TaskObject.context`. A pure
`usage-model.ts` turns both into meter specs that `Task.tsx` and `Settings.tsx` render.

**Tech Stack:** Bun, TypeScript, bun:sqlite, typebox + `@earendil-works/chord` state objects, Preact.

**Spec:** `docs/superpowers/specs/2026-11-18-task-bar-usage-design.md`

## Global Constraints

- Thresholds: warn colour at utilization ≥ 0.80, bad colour at ≥ 0.95 (both context fill and plan windows).
- A reading older than 30 minutes is stale (faded). A window whose `resetsAt` has passed shows 0%, faded, `reset`.
- No-data copy: bar `5h / 7d: no data`; Settings `No data yet: no turn on this node has used it.`
- `unifiedWindows` is not in the SDK types: parse defensively, never throw on a malformed event.
- Readings are local to the node: no replication, no change to the `tokens` table or `mergeTokens`.
- Commits with jj (`jj commit -m …`), no AI attribution. Tests: `~/.bun/bin/bun test <files>` and
  `~/.bun/bin/bun run typecheck`; never the full suite. Run `~/.bun/bin/bun install` once first (no `node_modules`).
- Match the code's style: doc comments on every export, the comment density and wording of `src/token.ts`.

## Review Focus

1. **Synthetic or subagent assistant messages** (`model: "<synthetic>"`, zero usage, or `parent_tool_use_id` set) must
   not reset ctx to 0 or to a subagent's context. Pinned in Task 3.
2. **`resetsAt` in milliseconds or seconds, utilization above 1, missing windows** must give a sane reading (ms
   accepted, utilization clamped to [0, 1] for display, missing window null). Pinned in Tasks 1 and 4.
3. **An older reading arriving after a newer one** (two tasks on one token) must not overwrite it. Pinned in Task 1.
4. **A removed token** must not show in `tokenUsage`, and re-adding it may show its old reading. Pinned in Task 1.
5. **A task whose node is an older meddle** (no `context`/`activeUsage` member) must render: treat `undefined` as no
   data. Pinned in Task 5 by the guard in the bar.

---

### Task 1: Readings: parser and local store

**Files:**
- Create: `src/token-usage.ts`
- Modify: `src/store/db.ts` (add to `MIGRATIONS`, after `tokens`)
- Test: `test/token-usage.test.ts`

**Interfaces:**
- Produces:
  - `type UsageWindow = { utilization: number; resetsAt: string | null }` (utilization as sent, 0–1; ISO time)
  - `type UsageReading = { fiveHour: UsageWindow | null; sevenDay: UsageWindow | null; readAt: string }`
  - `usageReadingOf(m: unknown, readAt: string): UsageReading | null`: null unless `m.type === "rate_limit_event"` and
    at least one of `rate_limit_info.unifiedWindows.{five_hour,seven_day}` has a finite numeric `utilization`.
    `resetsAt` is unix seconds, or ms when ≥ 1e12 (as `tokenFaultOf` in `src/engine/session.ts` does); otherwise null.
  - `recordUsage(db: Database, tokenId: string, reading: UsageReading): boolean`: upsert, only when `readAt` is newer
    than the stored row's; true when written. Throws `invalid token id` for an id failing `TOKEN_ID`.
  - `tokenUsages(db: Database): Record<string, UsageReading>`: rows joined to `tokens WHERE removed = 0`.

- [ ] **Step 1: Write the failing tests** in `test/token-usage.test.ts` (open a db with `openDb` the way
  `test/tokens.test.ts` does, add tokens with `addToken`):
  - `usageReadingOf` on the `hello.jsonl` shape (`unifiedWindows.five_hour {utilization: 0.27, resetsAt: 1793406600}`,
    `seven_day {0.33, 1793851200}`) gives `fiveHour: { utilization: 0.27, resetsAt: new Date(1793406600_000).toISOString() }`
    and the same for `sevenDay`, `readAt` as passed.
  - `resetsAt` given in ms (`1793406600_000`) gives the same ISO time.
  - only `seven_day` present → `fiveHour: null`; neither, a non-numeric utilization, no `unifiedWindows`, an
    `assistant` message, `null` → `null`.
  - `recordUsage` then `tokenUsages` returns the reading under the id; a second call with an older `readAt` returns
    false and leaves the newer one; an equal-or-newer one replaces it.
  - after `removeToken`, `tokenUsages` lacks the id; after `addToken` with the same value, it has it again.
  - `recordUsage(db, "nope", r)` throws `invalid token id`.

- [ ] **Step 2: Run** `~/.bun/bin/bun test test/token-usage.test.ts` — expect FAIL (module not found).

- [ ] **Step 3: Implement.** Table, in `MIGRATIONS` with a one-line comment like its neighbours ("Each token's latest
  plan-usage reading on this node (src/token-usage.ts); local, never replicated."):
  `token_usage (token_id TEXT PRIMARY KEY, five_hour_utilization REAL NULL, five_hour_resets_at TEXT NULL,
  seven_day_utilization REAL NULL, seven_day_resets_at TEXT NULL, read_at TEXT NOT NULL)`. The newer-wins upsert is
  one statement: `INSERT … ON CONFLICT (token_id) DO UPDATE SET … WHERE excluded.read_at >= token_usage.read_at`;
  `changes > 0` is the return value.

- [ ] **Step 4: Run** `~/.bun/bin/bun test test/token-usage.test.ts test/tokens.test.ts` — expect PASS.

- [ ] **Step 5: Commit** `jj commit -m "Keep each token's latest plan-usage reading on the node"`

### Task 2: Record readings in turns and publish them on the node

**Files:**
- Modify: `src/tasks/durable.ts` (the `onMessage` of `runTurn`, near line 818)
- Modify: `src/state/contracts.ts` (`nodeState`, after `token`)
- Modify: `src/state/host.ts` (`NodeStore` serve near line 283 and its `events`, `samples`, `pool` handlers; the
  `NodeObject` serve near line 513)
- Test: `test/state.test.ts`

**Interfaces:**
- Consumes: Task 1's `usageReadingOf`, `recordUsage`, `tokenUsages`, `UsageReading`.
- Produces on `NodeObject` (and `NodeStore`):
  - `tokenUsage: Record<string, UsageReading>` — `tokenUsages(db)`.
  - `activeUsage: { tokenId: string; label: string; reading: UsageReading | null } | null` — null when `pickToken`
    gives none; else that token's label and its entry in `tokenUsages(db)` (null when absent).
  - `UsageReadingSchema` exported from `contracts.ts` (windows as `Nullable(Type.Object({ utilization: Type.Number(),
    resetsAt: Nullable(Type.String()) }))`).

- [ ] **Step 1: Write the failing test** in `test/state.test.ts`, extending "a client follows a task through a prompted
  turn over a link" (the `hello.jsonl` turn) after the result: `await until(node.activeUsage, (u) => u?.reading != null)`,
  then expect `node.activeUsage.value` to match `{ tokenId: listTokens(db)[0]!.id, label: listTokens(db)[0]!.label,
  reading: { fiveHour: { utilization: 0.27 }, sevenDay: { utilization: 0.33 } } }` and
  `node.tokenUsage.value[listTokens(db)[0]!.id]` to match the same reading. Before the prompt,
  `node.activeUsage.value` matches `{ reading: null }` and `node.tokenUsage.value` is `{}`. (`connect()` returns `db`.)

- [ ] **Step 2: Run** `~/.bun/bin/bun test test/state.test.ts` — expect FAIL (`activeUsage` undefined).

- [ ] **Step 3: Implement.** In `onMessage`, before the `notify(this.#eventListeners, …)` call so a listener reads it:
  `const reading = usageReadingOf(m, new Date().toISOString()); if (reading !== null) recordUsage(this.#db, picked.id, reading);`.
  In `host.ts`, a `usageNow(cfg, db)` beside `tokenNow` (same doc-comment style) and a `refreshUsage(ctx)` that replaces
  both states (skipping when `ctx.signal.aborted`, as the `pool` handler does). Call it in the `events` handler when
  `m.type === "rate_limit_event"`, in `samples`, and in `pool`. Pass both through in the `NodeObject` serve.

- [ ] **Step 4: Run** `~/.bun/bin/bun test test/state.test.ts test/token-fallback.test.ts` and
  `~/.bun/bin/bun run typecheck` — expect PASS.

- [ ] **Step 5: Commit** `jj commit -m "Record plan-usage readings in turns and publish them on the node"`

### Task 3: Context fill on the task

**Files:**
- Modify: `src/store/events.ts` (beside `latestEventWithField`)
- Modify: `src/state/contracts.ts` (`TaskLogSchema`; `TaskObject` state after `contextUsage`)
- Modify: `src/state/host.ts` (`foldTaskLog`, `EMPTY_TASK_LOG`, `taskLogNow`, the `TaskObject` derive near line 819)
- Test: `test/state.test.ts`

**Interfaces:**
- Produces:
  - `latestMainAssistant(db: Database, taskId: string): EventRecord | null` — newest `assistant` event with
    `json_extract(json, '$.parent_tool_use_id') IS NULL` and `json_extract(json, '$.message.model') != '<synthetic>'`.
  - `TaskObject.context: { tokens: number; model: string | null } | null` — from the newest assistant message folded
    that has no `parent_tool_use_id`, is not `<synthetic>`, and has a `message.usage`: `input_tokens +
    cache_read_input_tokens + cache_creation_input_tokens` (missing ones 0); `model` is `message.model`.

- [ ] **Step 1: Write the failing tests** in `test/state.test.ts`:
  - In the `hello.jsonl` test: `await until(task.context, (c) => c !== null)`; expect `{ tokens: 376, model: "claude-haiku-5-5" }`.
  - In "a task's activation reads its log summary from the newest events…": append (before the 249 filler assistants,
    which have no `message` and so must be skipped by the fold, not by the query) a main-thread assistant with
    `message: { model: "claude-opus-5-5", usage: { input_tokens: 2, cache_read_input_tokens: 1000, cache_creation_input_tokens: 10 } }`,
    then a subagent one (`parent_tool_use_id: "tu1"`, usage 5) and a `<synthetic>` one with zero usage; expect
    `task.context.value` to equal `{ tokens: 1012, model: "claude-opus-5-5" }`. Make the filler skip explicit: change
    the query to also require `json_extract(json, '$.message.usage') IS NOT NULL`.

- [ ] **Step 2: Run** `~/.bun/bin/bun test test/state.test.ts` — expect FAIL.

- [ ] **Step 3: Implement** the helper, the fold branch (`m.type === "assistant"` meeting the rules above), add
  `latestMainAssistant` to the events `taskLogNow` sorts and folds, `context: null` in `EMPTY_TASK_LOG`, the schema
  field as `Nullable(Type.Object({ tokens: Type.Number(), model: Nullable(Type.String()) }))` in both `TaskLogSchema`
  and `TaskObject`, and the derive. Update `foldTaskLog`'s doc comment.

- [ ] **Step 4: Run** `~/.bun/bin/bun test test/state.test.ts test/events.test.ts` and `~/.bun/bin/bun run typecheck` — expect PASS.

- [ ] **Step 5: Commit** `jj commit -m "Fold a task's context fill from its latest main-thread call"`

### Task 4: The meters' model

**Files:**
- Create: `src/dashboard/ui/usage-model.ts`
- Test: `test/ui.test.ts`

**Interfaces:**
- Consumes: `UsageReading`, `UsageWindow` (Task 1, type-only import), `ago` and the `tokens` formatter of
  `sidebar-model.ts` (export `tokens` as `tokenCount`).
- Produces:
  - `type Level = "ok" | "warn" | "bad"`; `levelOf(fraction: number): Level` (≥ 0.95 bad, ≥ 0.80 warn).
  - `STALE_MS = 30 * 60_000`.
  - `type Meter = { label: string; fraction: number; text: string; level: Level; faded: boolean; title: string; note: string | null }`
  - `contextMeter(context: { tokens: number; model: string | null } | null | undefined, contextUsage: unknown): Meter | null`
    — null without context; `label "ctx"`; window = `modelUsage[model].contextWindow` of `contextUsage`; with a window,
    `text "375k / 1M"` and `fraction` tokens/window; without, `text "375k"` and `fraction` NaN (rendered without a
    bar); `title` has the exact count, the model and `usageShort(contextUsage)` as `latest turn: …`.
  - `windowMeter(label: "5h" | "7d", w: UsageWindow | null, readAt: string, now: number): Meter | null` — null for a
    null window; utilization clamped to [0, 1]; past `resetsAt` → fraction 0, `text "0%"`, `faded`, `note "reset"`;
    else `note "resets <time>"` (`HH:MM` today, else weekday + `HH:MM`, via `toLocaleString` with
    `{ weekday: "short", hour: "2-digit", minute: "2-digit" }`); `faded` also when `now - readAt > STALE_MS`; `title`
    `5-hour limit: 27% used, resets 14:30` (`7-day` for `7d`).
  - `readAgo(readAt: string, now: number): string` — `read ${ago(now - Date.parse(readAt))} ago`.

- [ ] **Step 1: Write the failing tests** in `test/ui.test.ts` (fixed `now`, readings built inline):
  - `levelOf(0.79) "ok"`, `levelOf(0.8) "warn"`, `levelOf(0.95) "bad"`.
  - `contextMeter({ tokens: 375_000, model: "m" }, { modelUsage: { m: { contextWindow: 1_000_000 } } })` →
    `{ text: "375k / 1M", fraction: 0.375, level: "ok" }`; 860k → `level "warn"`; unknown model → `text "375k"`;
    `null`/`undefined` → null.
  - `windowMeter("5h", { utilization: 0.27, resetsAt: <now + 1h> }, <now − 2 min>, now)` → `text "27%"`,
    `faded false`, `note` starts `resets`; utilization 1.4 → `text "100%"`, `level "bad"`; resetsAt past → `text "0%"`,
    `faded true`, `note "reset"`; readAt 31 min ago → `faded true`; null window → null.
  - `readAgo` 2 minutes → `"read 2m ago"`.
  - keep the `usageShort` test passing.

- [ ] **Step 2: Run** `~/.bun/bin/bun test test/ui.test.ts` — expect FAIL.

- [ ] **Step 3: Implement** in `usage-model.ts`, pure, no Preact.

- [ ] **Step 4: Run** `~/.bun/bin/bun test test/ui.test.ts` — expect PASS.

- [ ] **Step 5: Commit** `jj commit -m "Add the usage meters' model"`

### Task 5: Meters in the task bar

**Files:**
- Create: `src/dashboard/ui/Usage.tsx` (`UsageMeter`)
- Modify: `src/dashboard/ui/Task.tsx` (`BottomBar`, lines ~794–828, and its comments at lines 2 and 794)
- Modify: `src/dashboard/ui/index.html` (bar styles near line 416; the phone-width rule near line 492)
- Modify: `README.md:1156` (the bar's description: context and plan usage instead of "the latest turn's tokens")

**Interfaces:**
- Consumes: Task 4's `Meter`, `contextMeter`, `windowMeter`, `readAgo`; `task.context`, `task.contextUsage`,
  `node.activeUsage`.
- Produces: `UsageMeter({ meter, wide }: { meter: Meter; wide?: boolean })` — `<span class="usage-meter level-…
  [faded]" title=…>` with a `.usage-k` label, a `.meter` track with an `<i>` fill at `fraction` (no track when
  `fraction` is NaN), the `text`, and, when `wide`, the `note` in `.muted`. Task 6 reuses it with `wide`.

- [ ] **Step 1: Implement.** Replace the `usage` span with: the ctx meter (if any), then, when `activeUsage` (guard
  `?? null` for an older node) has a reading, the `5h` and `7d` meters with the tooltip's second line `token
  "<label>" · <readAgo>`; otherwise `<span class="bar-item">5h / 7d: no data</span>`. Re-render each minute for
  staleness (`useEffect` interval of 60 s bumping state). CSS: meter track 34px × 5px, `var(--line-strong)` track,
  fill `var(--muted)`, `.level-warn` uses `var(--warn)`, `.level-bad` `var(--bad)`, `.faded` opacity 0.55. At phone
  width only the ctx meter stays (extend the existing rule to hide the 5h/7d and no-data items).

- [ ] **Step 2: Verify** `~/.bun/bin/bun run typecheck` and `~/.bun/bin/bun test test/ui.test.ts` pass; then build the
  dashboard and look at it (use the `run` skill) against a node with a finished turn: three meters, tooltips, and the
  phone-width view.

- [ ] **Step 3: Commit** `jj commit -m "Show context and plan usage in the task bar"`

### Task 6: Usage column in Settings

**Files:**
- Modify: `src/dashboard/ui/main.tsx:121` (`<Settings pool={pool} node={node} />`)
- Modify: `src/dashboard/ui/Settings.tsx` (`Settings`, `TokenSection` and its note)
- Modify: `src/dashboard/ui/index.html` (a two-row grid for the cell)

**Interfaces:**
- Consumes: Task 2's `node.tokenUsage`; Task 4's `windowMeter`, `readAgo`; Task 5's `UsageMeter` with `wide`.

- [ ] **Step 1: Implement.** `Settings` takes `node: NodeRef` and passes it to `TokenSection`. A `Usage` header after
  `Status`; per row, with a reading: the `5h` and `7d` meters (`wide`, so with their reset notes) on two lines, then
  `read 2m ago` in `.muted`; a window absent from the reading shows `5h` `no data`; without a reading: `<span
  class="muted">No data yet: no turn on this node has used it.</span>`. Append to the note under the table: "Usage is
  the latest reading turns on this node got for each token: the share of its 5-hour and 7-day plan limits used. A
  token only ever used on another node has none here." Same minute re-render as Task 5.

- [ ] **Step 2: Verify** `~/.bun/bin/bun run typecheck`; open Settings in the running dashboard: the active token with
  a reading, and a token without one saying so.

- [ ] **Step 3: Commit** `jj commit -m "Show each token's plan usage in Settings"`
