# `meddle project remove` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `meddle project remove <id|name>` takes a project out of every node of the pool for good, force-archiving any
task a reconnecting node still runs on it, and keeps archived tasks viewable but not restorable.

**Architecture:** A replicated, add-only `removed_projects` table, served on a new remote type
`meddle.removed-projects` (never a new member of an existing type) and merged by pool sync. Every path that could
rebuild a project checks it first; a per-project lock covers check-then-write paths; one idempotent cleanup per
project (stop tasks, stop the train, delete data) runs on the command, on a merge that adds an entry, and at every
start.

**Tech Stack:** TypeScript on Bun, `bun:sqlite`, chord (`@earendil-works/chord`) remote types over iroh, pi-durable
Harness, Preact dashboard.

**Spec:** `docs/superpowers/specs/2026-11-22-project-remove-design.md`

## Global Constraints

- No new members on existing remote types (`PoolObject`, `TaskObject`, `PeerObject`, …): chord refuses to bind a
  contract whose consumer has a member the provider lacks, across all variants.
- A peer that answers a get of the new type with `ChordError` code `unavailable`, reason `unknown_type`, is an older
  meddle; its `PoolObject` hold carries on unchanged.
- Messages, exactly: `project <short id> was removed` (rebuild refusals, line/branch writers), `project <name> was
  removed` (restore refusals), `project <name> is used by <ids>` (ids comma-separated), `<node label> runs an older
  meddle`, success `removed <short id> (<name>)`, `unknown project: <x>`.
- Dashboard: Restore disabled, tooltip exactly `Project removed`; no other text.
- No undo, no confirmation prompt, CLI only.
- Code style: match surrounding code (long-line TSDoc comments in the files' own voice, no new comment density).
- Commits: jj. After each task: `jj describe -m "<4-7 word description>" && jj new`.
- Tests: run only the named test files plus `~/.bun/bin/bun run typecheck`; never the full suite. Bun is at
  `~/.bun/bin/bun` (not on PATH).

## Review Focus

1. A node offline during the removal reconnects with a running turn and queued prompts on the project → the turn is
   cut off, the queue dropped, the task archived and viewable, and no row/repo/memory dir is left. (Task 6 test.)
2. The node restarts between writing the entry and finishing cleanup → the next start finishes it, and a turn the
   Harness reruns at open is aborted, not left running. (Task 6 test.)
3. An offline member's stale summary still lists the project → `project list` and name resolution no longer show it,
   and the name `meddle` resolves to the remaining project. (Task 2 test.)
4. One member runs an older meddle → sync of roster/settings/tokens/rows with it still works, and the command is
   refused `<node> runs an older meddle`. (Task 5 test.)
5. Running the command twice by id → the second prints the same `removed <short id> (<name>)` and changes nothing.
   (Task 6 test.)

---

### Task 1: The removed list

**Files:**
- Create: `src/pool/removed.ts`
- Modify: `src/store/db.ts` (one `MIGRATIONS` entry)
- Test: `test/removed.test.ts`

**Interfaces:**
- Produces (all in `src/pool/removed.ts`):
  - `type RemovedProject = { id: string; name: string; removedAt: string; removedBy: string }`
  - `isRemoved(db: Database, projectId: string): boolean`
  - `listRemoved(db: Database): RemovedProject[]` (by `removedAt`, then id)
  - `removedIds(db: Database): Set<string>`
  - `markRemoved(db: Database, entry: RemovedProject): boolean` — true when added; an id already there keeps its entry.
  - `mergeRemoved(db: Database, rows: readonly RemovedProject[]): string[]` — ids newly added; rows failing shape
    checks (id not `SAFE_ID`, `removedAt` not ISO as in `pool/store.ts` `ISO_TIME`, which this task exports) are skipped.
  - `removedChanges: Subscribable<string>` — told each newly added id (build it the way `rows.ts` builds `rowChanges`).
    Like every such topic it fires for every node in the process: a listener checks its own db (`isRemoved`).
  - `removed.ts` stays db-only (no imports from `object.ts`/`rows.ts`): `rows.ts` imports it, so anything else here
    would make a cycle.
- Table: `removed_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, removed_at TEXT NOT NULL, removed_by TEXT NOT NULL)`,
  with a one-line comment in `db.ts`'s voice.

- [ ] **Step 1: Write the failing tests** in `test/removed.test.ts` against `openDb(":memory:")`:
  - `markRemoved adds once and keeps the first entry`: second `markRemoved` with the same id, other name → `false`;
    `listRemoved` has one entry with the first name.
  - `mergeRemoved returns only new ids and skips malformed rows`: merge `[a, b, {id:"../x",…}]` after `markRemoved(a)`
    → `["b"]`; `isRemoved(db, "../x")` false.
  - `removedChanges tells each new id`: subscribe, `mergeRemoved([a, a, b])` → told `a`, `b` once each.
- [ ] **Step 2: Run** `~/.bun/bin/bun test test/removed.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** `src/pool/removed.ts` and the migration.
- [ ] **Step 4: Run** the test file and `~/.bun/bin/bun run typecheck` → PASS.
- [ ] **Step 5: Commit** `jj describe -m "Add replicated removed projects list" && jj new`.

### Task 2: Nothing rebuilds a removed project

**Files:**
- Modify: `src/pool/rows.ts`, `src/projects/lines.ts`, `src/projects/replicas.ts`, `src/projects/applier.ts`,
  `src/pool/object.ts`, `src/git/serve.ts` (caller of `rosterProjectIds`), `src/projects/project.ts`,
  `src/store/records.ts`
- Test: `test/rows.test.ts`, `test/replicas.test.ts`, `test/applier.test.ts`, `test/placement.test.ts`,
  `test/projects.test.ts`

**Interfaces:**
- Consumes: Task 1's `isRemoved`, `removedIds`, `removedChanges`.
- Produces:
  - `rows.ts`: `mergeLineRows` / `mergeBranchRows` skip rows of removed projects (not counted as rejected);
    `writeLineRow`, `setQueued`, `writeBranchRow` throw `project <short id> was removed`;
    `deleteProjectRows(db: Database, projectId: string): void` deletes its `line_rows`, `branch_rows`,
    `branch_rows_waiting` in one transaction and tells `rowChanges`.
  - `lines.ts`: `writeLineRows`, `holdLineRows`, `reclaimLineRows`, `releaseLineRows` skip removed projects (so a move
    rollback of a task with several projects still reclaims the others).
  - `replicas.ts`: `ensureServiceRepo` throws `project <short id> was removed` as its first statement;
    `makeServiceRepo` re-checks right before `registerReplica` (removing what it built and throwing); `cloneMemory`
    returns without cloning for a removed id; `rosterProjectIds(pool: PoolRuntime, db: Database): Set<string>` and
    `rosterProject` / `findProject` leave removed ids out (update all callers: `applier.ts`, `replicas.ts`,
    `git/serve.ts`); `settled(cfg: NodeConfig, projectId: string): Promise<void>` resolves once any `making` /
    `cloning` of the project in flight has settled (fulfilled or not).
  - `applier.ts`: `serviceRepo` throws `project <short id> was removed` before its `getProject` early return; `run(id)`
    for a removed id deletes it from `retry` and returns; `all()` leaves removed ids out.
  - `object.ts`: `nodeOf(..., removed: ReadonlySet<string> = new Set())` drops removed ids from `projects`; the default
    variant's `nodes` derive takes the removed set as an input that `removedChanges` refreshes.
  - `records.ts`: `deleteProjectRow(db: Database, id: string): void`. `project.ts`: `forgetProject(db: Database, id:
    string): void` (deletes the row, then `changed()`).

- [ ] **Step 1: Write the failing tests:**
  - `rows.test.ts` `rows of a removed project are dropped and not written`: after `markRemoved(p)`, `mergeLineRows` /
    `mergeBranchRows` of p's rows → `changed` empty, tables empty; `writeLineRow` / `writeBranchRow` / `setQueued` for
    p throw `project <short> was removed`; rows of another project still merge.
  - `rows.test.ts` `deleteProjectRows clears all three tables of one project only`.
  - `rows.test.ts` `reclaimLineRows skips a removed project and reclaims the rest` (task with projects p, q; p
    removed → q's rows written, no throw).
  - `replicas.test.ts` `a removed project is never rebuilt from a peer`: two pool nodes, project on A, B holds it;
    on B delete the row and repo, `markRemoved`; `ensureServiceRepo(B, id)` rejects `project <short> was removed`;
    `rosterProjectIds(B.pool, B.db)` lacks it while A's summary still lists it; B's `replicas/<id>` absent.
  - `applier.test.ts` `the applier leaves a removed project alone`: as above, then a row change for it → after a pass,
    no row, no repo, and the retry set does not keep it (no log line `no service repo` for it after two intervals).
  - `placement.test.ts` `nodeOf leaves removed projects out of a summary`.
  - `projects.test.ts` `a name resolves to the one project left once its twin is removed` (Review Focus 3): two
    projects named `meddle` in two summaries (one from an offline node), one removed → `resolveProject(poolProjects(
    nodes filtered by nodeOf), "meddle")` returns the other's id.
- [ ] **Step 2: Run** `~/.bun/bin/bun test test/rows.test.ts test/replicas.test.ts test/applier.test.ts
  test/placement.test.ts test/projects.test.ts` → the new tests FAIL.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run** the same files plus `test/git.test.ts test/starts.test.ts` and typecheck → PASS.
- [ ] **Step 5: Commit** `jj describe -m "Refuse rebuilding removed projects" && jj new`.

### Task 3: Stop and forget a project's train

**Files:**
- Modify: `src/train/train.ts`
- Test: `test/train.test.ts`

**Interfaces:**
- Consumes: `isRemoved`.
- Produces:
  - `updateTrain` returns the current (or default) row without writing for a removed id.
  - `#home(projectId)` answers null for a removed id, so `#kick` / `#start` start no new round while cleanup runs
    (force-archiving fires `lineChanges`, which kicks).
  - `Conductor.forget(projectId: string): void`: clears that project's `timer` / `retry` timeouts, deletes its
    `#trains`, `#rounds`, `#seen`, `#titles` entries.
  - `export async function forgetTrain(harness: Harness, db: Database, projectId: string): Promise<void>`: aborts each
    non-terminal `meddle.train` record whose `input.projectId` matches **directly** (`harness.inspect` +
    `harness.abortTask(id, BACKGROUND_CONTEXT)`: the conductor slot may not be bound yet at startup), then
    `slotOf(harness).current?.forget(projectId)`, then deletes the `trains` row.

- [ ] **Step 1: Write the failing tests** in `train.test.ts`:
  - `forgetting a project's train aborts its round and keeps its row gone`: start a round (the file's round helpers /
    `fakeMerge`), `markRemoved` + `forgetTrain` → the `meddle.train` record is terminal `aborted`, `SELECT * FROM
    trains WHERE project = ?` empty, and stays empty after the round's would-be end and after `pauseTrain(db, id, "x")`.
  - `a removed project starts no new round`: `markRemoved`, then a queued line row change for it → no new
    `meddle.train` record.
- [ ] **Step 2: Run** `~/.bun/bin/bun test test/train.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `test/train.test.ts test/train-round.test.ts` and typecheck → PASS.
- [ ] **Step 5: Commit** `jj describe -m "Forget a removed project's train" && jj new`.

### Task 4: The runner — forced stop, restore refusal, project locks

**Files:**
- Create: `src/projects/locks.ts`
- Modify: `src/tasks/durable.ts`
- Test: `test/archive.test.ts`, `test/move.test.ts`

**Interfaces:**
- Consumes: `isRemoved`.
- Produces:
  - `src/projects/locks.ts`: `withProjectLocks<T>(projectIds: readonly string[], fn: () => Promise<T>): Promise<T>` —
    `serialised` on key `project\0<id>` for each distinct id, taken in sorted order (no deadlock between two tasks of
    the same projects). Not re-entrant: nothing inside `fn` may take a project lock.
  - `TaskRunner.stopForRemoval(projectId: string): Promise<{ done: string[]; deferred: string[] }>`. For each task row
    whose manifest names the project:
    - `archived`, `moved`: left alone.
    - `receiving`: under `serialised(taskKey(id))`, `#discard(row)`.
    - otherwise, in this order (the reservation first, so no turn can start mid-stop: `#prompt`, `startQueued`,
      `#startTrainTurn` and `checkMove` all refuse a task in `#archiving`, and `failMove`'s `startQueued` with them):
      1. `#archiving.add(id)` (skip the task if it is already there: an archive is under way);
      2. drop the queue (live steers via `takeBack()`, the `queued` column, `#emitQueued`);
      3. when moving: `cancelMove`; on its "too late" refusal or after it, wait until `#moving` no longer has the task,
         re-read the row, and leave it alone if now `moved` or `archived` (release the reservation);
      4. `harness.abortTask` on every non-terminal `meddle.turn` record of the task — parked, durable or live — then
         poll (250 ms) until `#durableTurn(id)` is undefined, deleting `#pending`'s entry (`abortTurnPhase` never
         clears it). While the runner's `turns` hold is set the Harness only marks the abort, so instead of waiting
         the task goes in `deferred` (release the reservation);
      5. `#archive(id, false, { force: true })`, which runs under the reservation already held.
  - `#archive(taskId, accepted, opts: { force?: boolean } = {})`: `force` skips the `#holds.work` check, both
    `#refuseArchive` calls, the `#archiving.has` refusal (the caller holds the reservation) and the `#durableTurn`
    "task is running" check (the turn was made terminal); everything else unchanged.
  - `restore()` (first check after the row lookup), `restoreHere()` and `checkMove`'s `fromArchive` branch throw
    `project <name> was removed` when any manifest project is removed (name from the manifest).
  - `create` (from the project loop at ~508 to the task's line writes at ~531), `receiveTask` (~1408–1420) and
    `#restoreHereLocked` (~1821–1844) run their window inside `withProjectLocks(manifest project ids, …)` and, first
    inside it, throw `project <short id> was removed` for a removed project.

- [ ] **Step 1: Write the failing tests:**
  - `archive.test.ts` `stopForRemoval cuts a running turn off, drops the queue and archives` (use the file's
    `MEDDLE_FIXTURE_STALL` pattern at ~369): running task + one queued prompt → after `stopForRemoval`, state
    `archived`, `queuedOf(row)` empty, no non-terminal `meddle.turn` record, events still readable.
  - `archive.test.ts` `a task of a removed project cannot be restored`: archive a task, `markRemoved` → `restore(id,
    null)` and `restoreHere(id)` reject `project <name> was removed`; the archive file is still there.
  - `move.test.ts` `stopForRemoval aborts a parked turn` (use `standInRunner` at ~1309, changing its `abortTask` stub
    to drop the record from what `inspect` answers): parked `meddle.turn` record → `abortTask` called with its id, task
    archived.
  - `move.test.ts` `stopForRemoval discards a task being received and leaves a moved one`.
  - `move.test.ts` `stopForRemoval defers a task while turns are held`: `setHolds({ turns: "x", … })`, parked turn →
    `deferred` has it, task not archived, reservation released (a later `archive` is not refused "being archived").
  - `archive.test.ts` `create waits for a removal under way and then refuses`: hold `withProjectLocks([p])` open,
    start `create` for p, `markRemoved`, release → `create` rejects `project <short> was removed`, no task row.
- [ ] **Step 2: Run** `~/.bun/bin/bun test test/archive.test.ts test/move.test.ts` → new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `test/archive.test.ts test/move.test.ts test/durable.test.ts test/create-starts.test.ts` and
  typecheck → PASS.
- [ ] **Step 5: Commit** `jj describe -m "Force-stop tasks of removed projects" && jj new`.

### Task 5: The remote type and its sync

**Files:**
- Create: `src/pool/removed-object.ts` (serving the type; keeps `removed.ts` db-only)
- Modify: `src/state/contracts.ts`, `src/pool/sync.ts`, `src/pool/runtime.ts`, `src/state/host.ts`,
  `test/pool-helpers.ts` (the test nodes serve the new type; an option leaves it out, for an "older" node)
- Test: `test/sync.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `contracts.ts`: `RemovedProjectSchema` and `RemovedProjectsObject = remote("meddle.removed-projects", { version: 1,
    input: {}, host: hostNamed("node"), variants: { default: { state: { removed: Array(RemovedProjectSchema) },
    methods: { remove: method(Object({ id: String() }), RemovedProjectSchema) } }, peer: { state: { removed:
    Array(RemovedProjectSchema) } } } })`. Variants chosen by principal exactly as `servePool` chooses `PoolObject`'s.
  - `removed-object.ts`: `serveRemovedProjects(host: Host, deps: { db: Database; inputHold: …as servePool's;
    remove(id: string): Promise<RemovedProject> }): void`; state refreshed from `listRemoved` on `removedChanges`
    (only when its own db changed); the default variant `gated(..., deps.inputHold)` as `servePool` does
    (`object.ts:233`). Called in `host.ts` beside `servePool`.
  - `sync.ts`: after the `PoolObject` hold succeeds, a separate hold of the peer's `RemovedProjectsObject` (its own
    try/catch, its own retry 1 s doubling to 30 s; it never drops the `PoolObject` view). Its `removed` state goes
    through `mergeRemoved`. `unavailable`/`unknown_type` marks the peer older, is not reported through `onError`, and
    stops retrying until reconnect. `PoolSync.removedSupport(peerId: string): "held" | "older" | "pending"`.
  - `runtime.ts`: `PoolRuntime.removedSupport(peerId)` passes it through.

- [ ] **Step 1: Write the failing tests** in `sync.test.ts`:
  - `a removal on one node reaches the others`: three nodes; `markRemoved` on A → B and C `isRemoved` within the
    file's `until`; C started after the removal (or brought online later) gets it too.
  - `a peer without the removed list still syncs and reads as older` (Review Focus 4): one node made with the
    helpers' leave-it-out option → the other's `removedSupport(it)` is `"older"`, a setting set on it still arrives,
    and no error was reported.
- [ ] **Step 2: Run** `~/.bun/bin/bun test test/sync.test.ts` → FAIL.
- [ ] **Step 3: Implement.** `serveRemovedProjects`' `remove` is wired to a stub that throws `not ready` here; Task 6
  replaces it.
- [ ] **Step 4: Run** `test/sync.test.ts test/pool-state.test.ts` and typecheck → PASS.
- [ ] **Step 5: Commit** `jj describe -m "Sync removed projects between nodes" && jj new`.

### Task 6: Cleanup, the remove action, startup sweep

**Files:**
- Create: `src/projects/removal.ts`
- Modify: `src/cli.ts` (`serve` wiring only), `src/state/host.ts` (wire `remove`), `src/projects/replicas.ts` if
  `settled` needs it
- Test: `test/removal.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5 (`settled`, `forgetProject`, `deleteProjectRows`, `forgetTrain`, `stopForRemoval`,
  `withProjectLocks`, `markRemoved`, `removedSupport`).
- Produces (in `src/projects/removal.ts`):
  - `type RemovalDeps = ReplicaDeps & { runner: TaskRunner }`
  - `cleanupRemoved(deps: RemovalDeps, projectId: string): Promise<void>` — returns at once unless
    `isRemoved(deps.db, id)` (topics fire for every node in the process); idempotent; serialised per project on a key
    of its own (`removal\0<id>`, not the project lock, so it can wait for a `create` holding that); in order:
    `settled`, `withProjectLocks([id], async () => {})` (a barrier: a `create` / `receiveTask` / restore that took
    the lock before the entry landed has inserted its task by then), `forgetTrain` (before the tasks, so no round
    drives them), `runner.stopForRemoval` — if it `deferred` any task, stop here (the turns hold is set; the watch
    reruns cleanup when it lifts) — then under `withProjectLocks([id])`: `forgetProject`, `rm`
    `paths(cfg).replica(id)` and `paths(cfg).memory(id)` (recursive, force), `deleteProjectRows`. A failure is logged
    `meddle: project <short>: cleanup: <message>` and left for the next sweep.
  - `sweepRemoved(deps: RemovalDeps): Promise<void>` — `cleanupRemoved` for every removed id, one after another.
  - `watchRemoved(deps: RemovalDeps): () => void` — `removedChanges` → `cleanupRemoved(id)`, and `runner.onHolds` →
    `sweepRemoved` when the `turns` hold lifts.
  - `removeProject(deps: RemovalDeps, projectId: string): Promise<RemovedProject>`:
    - already removed → that entry, nothing else;
    - no row here and no roster summary lists it → `unknown project: <id>`;
    - any online member with `removedSupport` not `"held"` → `<node label> runs an older meddle` (pending counts as
      older: the hold has not answered yet);
    - line rows of it with `archived` false, `commit` not null and `holder` not a roster-`removed` node → `project
      <name> is used by <task ids>`;
    - else `markRemoved({ id, name, removedAt: now, removedBy: self })`, `await cleanupRemoved`, return the entry.
  - `cli.ts serve`: after `await host.ready()` and before `startApplier`: `node.stopRemovedWatch = watchRemoved(...)`
    first (stopped in `shutdown`; entries merged from here on are not missed), then `void sweepRemoved(...)`, **not
    awaited** (on a held boot it defers until the updater lifts the hold, after startup).

- [ ] **Step 1: Write the failing tests** in `test/removal.test.ts` (use `poolNodes` / `twoPoolNodes`, `createTask`;
  the helpers do not run `serve`, so each test starts `watchRemoved` on each node itself; there is no helper to take a
  node offline, so the reconnect case is split: Task 5's sync test covers late delivery, the test below covers what
  the node does on receiving the entry):
  - `removing a project clears it from every node`: two nodes, project with an archived task → `removeProject` on A →
    on both: no project row, no `replicas/<id>`, no `memory/<id>`, no line/branch rows, no `trains` row; the archived
    task's events still listed; `restore` refused.
  - `a live task blocks removal`: idle task on B → `removeProject` on A rejects `project <name> is used by <id>`.
  - `removing twice answers the same` (Review Focus 5).
  - `a node receiving a removal force-archives its busy task` (Review Focus 1): B (`MEDDLE_FIXTURE_STALL`) holds a
    running task with a queued prompt; `mergeRemoved` the entry into B's db as sync would (bypassing `removeProject`'s
    used-by refusal) → B's task archived, queue empty, its events readable, project data gone on B; A untouched.
  - `a restart finishes an interrupted cleanup` (Review Focus 2): `MEDDLE_FIXTURE_STALL` task running; `markRemoved`
    directly in the db; close and reopen the node's harness, runner and host (write a local `restart` like
    `train.test.ts`'s at ~112, which is not exported) so the Harness reruns the turn → `sweepRemoved` → data gone,
    the `meddle.turn` record terminal `aborted`.
  - `a held boot defers cleanup until the hold lifts`: `setHolds({ turns: "x", … })`, running task, `markRemoved`,
    `sweepRemoved` resolves with data still present; lift the hold → data gone.
  - `a removal on another node in the process does nothing here`: two nodes not linked; `markRemoved` on A only → B
    keeps the project.
- [ ] **Step 2: Run** `~/.bun/bin/bun test test/removal.test.ts` → FAIL.
- [ ] **Step 3: Implement** and wire.
- [ ] **Step 4: Run** `test/removal.test.ts test/sync.test.ts test/archive.test.ts` and typecheck → PASS.
- [ ] **Step 5: Commit** `jj describe -m "Clean up removed projects on nodes" && jj new`.

### Task 7: The CLI command

**Files:**
- Modify: `src/cli.ts`, `src/help.ts`
- Test: `test/cli.test.ts`, `test/help.test.ts`

**Interfaces:**
- Consumes: `RemovedProjectsObject` default variant (`removed` state, `remove` method).
- Produces: `meddle project remove <id|name>`:
  - resolves with `poolProjects` / `resolveProject` over the `PoolObject` nodes; an id (or 12-hex prefix) in the
    `removed` state resolves to that entry instead;
  - collects tasks like `task list` (`collectTasks`) and refuses `project <name> is used by <ids>` for tasks not
    `archived`/`moved` whose manifest names it;
  - calls `remove({ id })`, prints `removed <short id> (<name>)`, exits 0; errors print as other commands' do.
  - `help.ts` entry in the Projects section after `project status`: usage `project remove <id|name>`, summary
    `Remove a project from every node of the pool.`, details covering: refused while a task that is not archived uses
    it or a member runs an older meddle; every node deletes its row, service repo, memory, line and branch rows and
    train; a node offline then does it when it reconnects, stopping and archiving any task of it it still runs;
    archived tasks stay listed and cannot be restored; checkouts are not touched; no undo; needs the node running.

- [ ] **Step 1: Write the failing tests:** `cli.test.ts` `project remove removes and prints the project` (via the
  `meddle(args, env)` helper against `startServe`): add a second project, remove it by name → stdout
  `removed <short> (<name>)`, `project list` no longer shows it; again by id → same line. `help.test.ts`
  `help lists project remove`: `meddle help` output contains `project remove <id|name>` (the file has no per-command
  check, so assert it explicitly).
- [ ] **Step 2: Run** `~/.bun/bin/bun test test/cli.test.ts test/help.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same and typecheck → PASS.
- [ ] **Step 5: Commit** `jj describe -m "Add project remove CLI command" && jj new`.

### Task 8: Dashboard — Restore greyed out

**Files:**
- Modify: `src/dashboard/ui/sidebar-model.ts` (the decision), `src/dashboard/ui/Task.tsx` (the "Restore ▾" button,
  ~250), `src/dashboard/ui/Sidebar.tsx` (the "Restore…" `MenuItem`, ~157), `src/dashboard/ui/sources.tsx` (bind
  `RemovedProjectsObject` on the dashboard's own node and expose its removed ids)
- Test: `test/ui.test.ts`

**Interfaces:**
- Consumes: `RemovedProjectsObject` default variant's `removed`.
- Produces: `restoreBlocked(projectIds: readonly string[], removed: ReadonlySet<string>): string | null` in
  `sidebar-model.ts` — `"Project removed"` when any id is removed, else null. The two Restore triggers are
  `disabled` with `title` set to it when it is not null (`RestoreMenu` itself, the node-choice popover, is
  unchanged). No other UI text.

- [ ] **Step 1: Write the failing test** in `ui.test.ts` (it tests pure `*-model.ts` functions):
  `restoreBlocked says Project removed when any of the task's projects is removed` (one removed of two → the string;
  none → null).
- [ ] **Step 2: Run** `~/.bun/bin/bun test test/ui.test.ts` → FAIL.
- [ ] **Step 3: Implement** the helper and wire both triggers.
- [ ] **Step 4: Run** `test/ui.test.ts` (it also builds the bundle) and typecheck → PASS.
- [ ] **Step 5: Commit** `jj describe -m "Grey out restore for removed projects" && jj new`.
