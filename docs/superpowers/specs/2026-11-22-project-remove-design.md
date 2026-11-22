# `meddle project remove`

## Intent

A project, once added, can never leave the pool: there is no command for it, and deleting one by hand on a node does not
hold, since every node recreates a project any member reports holding (`ensureServiceRepos`, `rosterProjectIds`) or has
rows for (the applier). The case that prompted this: `/home/jezza/projects/meddle` was added as a new project
(`a801aef45dac`) when a checkout of the existing `meddle` (`ffc17aa0e7ff`) was meant, so the name `meddle` now names two
projects and `--project meddle` / `checkout meddle` are refused.

`meddle project remove <id|name>` takes a project out of the whole pool: every node, now or when it next connects. It
serves both undoing a mistaken add and retiring a real project with history.

## Goals

- Removes the project from every node: its row, service repo (`replicas/<id>`), memory repo (`memory/<id>`), line rows,
  branch rows (and `branch_rows_waiting`), and `trains` row.
- Stays removed: no node recreates it, whatever it hears from peers, rows, roster summaries or a restore-move.
- A node offline at the time removes it when it reconnects.
- Refused while a task that is not archived uses the project.
- Archived tasks of the project stay viewable exactly as now (dashboard and `task list`), and cannot be restored.
- Frees the name: once removed, the name resolves to the remaining project of that name.

## Non-goals

- No undo. The data is gone; adding the folder or URL again makes a new project with a new id.
- No confirmation prompt (`task delete` and `pool remove` have none).
- No dashboard control for removing; CLI only.
- Checkouts and the folder or upstream a project was added from are never touched; their `meddle` remote just stops
  answering.

## Anti-goals

- A removal that comes back: any path that rebuilds a removed project's row or service repo is a bug.
- Archived tasks that stop being viewable, or a task left running on a project whose data is deleted.
- Explanatory text in the UI. A task of a removed project shows Restore greyed out with a tooltip; nothing else.

## Approaches

1. **A replicated list of removed projects, merged in pool sync like removed tokens.** *(chosen)* Each node holds the
   list, served by a new remote type next to `PoolObject` and merged from every peer (add-only: an entry is id, removed at, removed by). A node that
   learns of a removal deletes its copy of the project and refuses everything of it from then on. Offline nodes catch up
   on reconnect. Cost: a new kind of synced record and a schema addition.
2. **A pool setting `project.removed.<id>`.** Reuses the settings merge, but it would show in `config list`, and
   `config unset` would resurrect the project half-built. Rejected as a hack.
3. **The home decides.** Replicas drop a project their home stops listing. Fails while the home is offline, where
   offline and removed look the same. Rejected.

## Design


### The removed list

- A table of removed projects (`id`, `removed_at`, `removed_by`), add-only, never pruned (rows are tiny). Precedents:
  tokens' `removed` rows (`token.ts` `mergeTokens`) and the roster's `removed` status.
- *(Review:)* carried on a **new remote type** (e.g. `meddle.removedProjects`), not as a member of `PoolObject`. chord
  refuses to bind a contract whose consumer side has a member the provider lacks (`contract_mismatch`, see
  `olderHolder` in `src/train/surface.ts`), so a new `PoolObject` member would make every new node's hold of an older
  peer fail, cutting it off from that peer's roster, settings, tokens and rows. The sync holds the new type next to
  `PoolObject` for each peer; a peer that does not serve it (unknown type, `not_in_variant`) is an older one, and its
  `PoolObject` hold carries on as now.
- A merge that adds an entry runs this node's cleanup (below) for it.

### What "removed" means on a node

**Cleanup** is one function per project id, idempotent and serialised per project (one at a time; a second caller waits
for the first). *(Review:)* it does not run only when an entry first arrives: it runs on that, on the command, and at
every start for each removed id that still has anything here (row, `replicas/<id>`, `memory/<id>`, line or branch rows,
a `trains` row, a task not archived), so a crash or failure midway is finished on the next start. It first waits for
any `ensureServiceRepo` (`making`) or memory clone (`cloning`) of the project already in flight, then:

1. Stops and archives each task it holds that is not archived and uses the project (normally none: the command refuses
   while one exists, but a node that was offline may hold one). *(Decided: forced, not waited for.)* Per state
   *(review: `update --force` only skips draining, so there is no in-process cut to reuse; `discardMergeTask` is the
   precedent)*:
   - live (`idle`, `running`, `waiting`): interrupt the turn (`awaitTurnEnd(…, true)`), and abort a parked or durable
     turn in the Harness so it does not resume with `CARRY_ON_PROMPT` after a restart; cancel a move in flight; drop
     queued prompts; then archive through a new forced path beside `#archive` that skips `#refuseArchive` and `#holds`;
   - `receiving`: discard it (`#discard`), so the sender's `activateTask` cannot make it live;
   - `moved`: left alone (it is not this node's task any more).
2. Stops the project's merge train here *(review)*: aborts its `MeddleTrain` Harness task and drops the conductor's
   in-memory entries (`#trains`/`#rounds`), so a round cut off later does not write the `trains` row again.
3. Deletes the project's row, service repo (`row.replica`, always under `replicas/<id>`), memory repo, line rows, branch
   rows, waiting branch rows and `trains` row.

**From then on**, for a removed id. *(Review:)* each check sits at the top of its function, before any early return
for a project already here, and paths that check then write hold the project's lock (the cleanup's) from the check to
their last write, so a removal landing midway either waits for them (and cleanup then undoes what they made) or makes
them refuse:

- `ensureServiceRepo`, `makeServiceRepo` and the applier's `serviceRepo` reject `project <short id> was removed`; with
  the applier, `task new` / starts (`create`, `startAt`), git serve's catch-up and a restore-move's `receiveTask` all go
  through these. `cloneMemory` / `ensureMemoryReplica` do not recreate `memory/<id>`.
- `create`, `receiveTask` and `restoreHere` hold the lock from their check to the task row's insert.
- `rosterProjectIds` leaves it out; the applier drops it from its `retry` set and passes.
- `mergeLineRows` / `mergeBranchRows` drop incoming rows of it, and *(review)* so do the local writers,
  `writeLineRow` / `writeBranchRow` (a move rollback's `reclaimLineRows`, `startAt`'s `writeLine`, a checkout push's
  branch rows).
- `updateTrain` does nothing for it.
- The node's summary does not list it (it holds no row).
- *(Builder-check call:)* every reader of roster summaries ignores it, filtered at the source the readers share (the
  `PoolObject`'s node list and `rosterProjectIds`), because an offline member's roster row keeps its last summary
  indefinitely and would otherwise keep the project listed and its name ambiguous. That covers `poolProjects` /
  `resolveProject` (`project list`, `checkout`, `task new`, `train`) and the dashboard's Projects view, sidebar and
  project choices.
- `task restore` is refused `project <name> was removed`: checked at the top of `restore()` in `durable.ts`, and also in
  `restoreHere` (public) and `checkMove`'s `fromArchive` branch.

### The command

`meddle project remove <id|name>`, needs the node running.

- Resolves like the other project commands (an id, or a name exactly one project has); `unknown project: <x>` otherwise.
  *(Review:)* an id already in the removed list answers `removed <short id> (<name>)` again, adding nothing (its name
  no longer resolves, since summaries are filtered).
- Refused `<node> runs an older meddle` while an online member runs a meddle that does not serve the removed list
  (it would keep rebuilding the project), as the train does.
- Refused `project <name> is used by <ids>` when a task that is not archived uses it. Two sources: every online node's
  tasks (the way `task list` collects them: `NodeObject` task ids and each `TaskObject`'s manifest and state), and the
  line rows this node holds that are not archived, which also cover tasks held on offline nodes. *(Builder-check call:)*
  line rows that are released (`commit` null: a failed `task new`, a train's release) or held by a node the roster marks
  `removed` do not count, so a dead laptop is got past with `pool remove`, and a failed task creation never blocks
  removal.
- Otherwise writes the entry here, runs cleanup here, and prints `removed <short id> (<name>)`; sync carries the entry
  to the rest of the pool.
- A `project remove` entry in `help.ts`.

### Dashboard

- *(Review:)* the "project removed" state is computed on the dashboard's own node, from its removed list and the task's
  manifest project ids, not as a new `TaskObject` member (that would stop a new dashboard binding an older node's
  `TaskObject`, the same contract problem as above).
- Restore (the `RestoreMenu` in the task page and the sidebar) is disabled for such a task, with a tooltip:
  `Project removed`. No other text anywhere.
- Projects view and sidebar need nothing new beyond the summary filtering above.

## Constraints

- Archived-task viewing reads the holder's `tasks` row, `events` and saved manifest (`state/host.ts` TaskObject).
  *(Review:)* `TaskObject.queue` also reads line rows and `bookmarks` reads the replica through `getProject`; both
  already answer null or skip once the rows and repo are gone. Keep it that way.
- Archive files (`archives/<task>.json.gz`) are per task and hold no repo content: leave them.
- No new members on existing remote types (`PoolObject`, `TaskObject`, …): new state goes on new types, and a peer that
  lacks one is treated as older.
- Tests: the affected test files and the typecheck, not the full suite.

## Left to the builder

- Table and column names, the schema migration, the new remote type's name and shape.
- Where cleanup and the per-project lock live (a module in `src/projects/`).
- How the "older meddle" check finds a peer without the new type.
- What git serve answers a checkout fetching a removed project (refusing as an unknown repo is enough).
