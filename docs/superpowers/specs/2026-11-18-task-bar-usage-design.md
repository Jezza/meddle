# Usage and context in the task bar and Settings

Mockups (local, not committed): option A of `.superpowers/brainstorm/1292012-1794968181/content/task-bar-usage.html`
for the bar, and `settings-usage.html` beside it for Settings.

## Why

A task's page gives no sense of how much room is left: how full its context window is, or how close the login its
turns run on is to its 5-hour and 7-day plan limits. Today the first sign is a token marked `exhausted` and a turn
switching login. The user's own Claude Code status line shows all three; the task bar should too, and Settings should show
each token's usage beside its status. The bar's current
`41k in · 2.1k out` sums every API call of the latest turn, so it reads like a context size but is not one.

## What changes

The bar's token text (`BottomBar`, `src/dashboard/ui/Task.tsx`) is replaced by three labelled meters, after the thin
divider that follows the projects:

```
◉ meddle 8303819c ⧉ │ ctx ▰▱▱ 375k / 1M   5h ▰▱▱ 27%   7d ▰▱▱ 12%        ⌂ zen ▾ [auto] [Opus 5.5] [high]
```

- **ctx:** the context the task's latest main-thread API call sent (input + cache read + cache creation tokens) over
  the main model's context window, as `375k / 1M`. Its tooltip gives exact counts, the model, and the latest turn's
  summed tokens (the text the bar shows today).
- **5h / 7d:** the plan utilization of the login the task's node will run its next turn on, as a percentage. Each
  tooltip: `5-hour limit: 27% used, resets 14:30`, then `token "<label>" · read 2 min ago`.
- Each meter is a short bar (about 34px) beside its number. At 80% and over it and its number turn the warn colour,
  at 95% the bad colour.
- **Stale:** a 5h/7d reading over 30 minutes old is faded; a window whose reset time has passed reads 0% (faded).
- **No data** is said, not hidden: `5h / 7d: no data` when the node has no reading for its active token (an API-key
  login, or one no turn has used yet). ctx alone stays hidden before the task's first API call.
- At phone width only ctx stays (the bar hides its other items there today).

## Settings

The Tokens table (`TokenSection`, `src/dashboard/ui/Settings.tsx`) gains a **Usage** column after Status. Per token:
two rows, `5h` and `7d`, each a meter, its percentage and its reset time (`resets 14:30`, `resets Fri 09:00`, or
`reset` once passed, reading 0%), then `read 2 min ago` beneath. Same colours and staleness as the bar. A token with
no reading: `No data yet: no turn on this node has used it.` The note under the table gains a sentence: the usage is
the latest reading turns on this node got for each token, so a token only ever used on another node has none here.

## Where the numbers come from

- **Context.** Fill: the `usage` of the latest assistant message with no `parent_tool_use_id`, folded from the task
  log in `foldTaskLog` (`src/state/host.ts`) so it moves during a turn, not only at its end. Window: `contextWindow`
  of that assistant message's `model` in the latest `result`'s `modelUsage` (already folded as `contextUsage`). Before a task's first result the
  window is unknown and ctx shows the token count alone, without a meter.
- **Plan limits.** Every `rate_limit_event` Claude Code emits (about one per API call, whatever its `status`) carries
  `rate_limit_info.unifiedWindows.{five_hour,seven_day}.{utilization (0–1), resetsAt (unix s)}`. This is the source
  Claude Code's own status line uses (its `rate_limits`, present "while the API reports it and its resets_at has not
  passed"). It is not in the SDK's types, so it is read defensively: anything missing or malformed is ignored.

## Approaches

1. **Each task's own last reading,** folded from its log like `contextUsage`. Smallest, but an idle task keeps its
   last turn's numbers while others on the same login move on, two tasks disagree, and the log does not say which
   token a turn used.
2. **The token's latest reading on this node** *(chosen)*. Each turn records the readings it sees against the token it
   picked; the bar shows the reading of the token the node's next turn will use. Every task on a node agrees, the
   numbers are the freshest the node has, and the bar follows a switch to the next login.
3. **As 2, replicated across the pool.** Freshest everywhere, but readings arrive about once per API call: on the
   token rows they would churn replication and race the exhausted/disabled marks, so it needs its own replicated table
   and merge. Left for later, if one node's numbers prove to lag.

## Design (approach 2)

- **Store:** a local, unreplicated table `token_usage (token_id PRIMARY KEY, five_hour_utilization,
  five_hour_resets_at, seven_day_utilization, seven_day_resets_at, read_at)` in `src/store/db.ts`. A window absent from
  a reading is stored as null. A row is only replaced by a newer `read_at`. Readings are only ever read joined to the tokens not removed, so a removed
  token's reading goes with it.
- **Record:** in the turn loop (`src/tasks/durable.ts`, where `picked` is known), each `rate_limit_event` with
  `unifiedWindows` writes a reading for `picked.id`.
- **Publish:** `NodeObject` gains `tokenUsage: Record<tokenId, { fiveHour, sevenDay, readAt }>` (Settings, from the
  dashboard's own node, which `Body` already holds) and `activeUsage: { tokenId, label, reading } | null` (the bar, from
  the task's node, which it already holds). Both refresh when a reading lands, on pool changes and on each metrics
  sample. They go on the node, not the pool object, because the bar's `pool` is the dashboard's own node and a task may
  run on another.
- **Tests:** the reading parser (well-formed, partial, malformed, `resetsAt` in s or ms), the store's newer-wins
  write, the context fold (main thread only, model pick), and the bar model's formatting, thresholds and staleness.

## Non-goals

- `meddle token list` showing readings.
- Polling a login no turn is using, or the SDK's experimental `/usage` API.
- Replicating readings across the pool (approach 3).

## Left to the builder

Exact meter widths and spacing, tooltip wording beyond the above, and whether the bar model lives in
`sidebar-model.ts` beside `usageShort` or a file of its own.
