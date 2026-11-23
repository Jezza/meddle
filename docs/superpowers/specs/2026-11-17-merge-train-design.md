# The merge train: accept tasks, and meddle lands them on main

> Changed since: tasks are prepared in one turn (rebase, squash, describe, `ready(tests)`), and the merge agent runs
> the tests they name. See [2026-11-24-train-prepare-turn-design.md](2026-11-24-train-prepare-turn-design.md).

## Why

Getting a task's work onto `main` is one decision, but today it takes a procedure of a dozen or more jj steps, and
any of them can go wrong. On 2026-11-17, merging Gem's task `c6f5613aeff0` took about 20 operations in eight minutes:
three `jj undo`s, two `jj edit --ignore-immutable`, a backwards push to rewind `main`, a divergent change abandoned
by hand, and `--allow-empty-description` on every push. The user named four problems:

1. **Descriptions are missing.** meddle tells agents only "commit with jj" (`generatedClaudeMd`,
   `src/tasks/provision.ts`). Live lines carry commits with real changes and no description, and older moves left
   empty, undescribed changes on lines (stopped by `80dc4e8647ad`'s `resumeEmpty`, but existing ones remain).
2. **Merge commits need a description too**, but the merge happens in the user's checkout, outside any agent's world.
3. **Fixing a description moves the line.** Asking the agent to describe its commit rewrote it while the user was
   merging. The push then held an older version, which didn't count as accepting the task, and had to be rewound.
4. **The user has to drive every step correctly**: fetch, merge, describe, move the bookmark, push, with the right
   flags, in the right order, against lines that may move.

## What it is

The user **accepts** tasks. Each accepted task joins its project's **train** and shows as **Queued**. The train lands
queued work on the project's default branch by itself:

- each task describes its own revisions;
- tasks that no longer apply cleanly on `main` are told to rebase onto it and fix their conflicts, by their own
  agents, which know their work;
- clean work is landed in batches. When several tasks merge cleanly together, a **merge agent** checks the combined
  result with targeted tests and describes the merge, and then `main` moves, exactly as a push would move it.

A landed task's work is on `main`, so meddle's existing acceptance makes it **Accepted** and archives it, as today.
The user runs no jj commands and writes no descriptions. Their checkout sees the result on its next fetch.

Words, as the user chose them: the button is **Accept**, the in-between state is **Queued**, and **Accepted** keeps
its meaning today (the task's work is on a branch, so it is archived). Accept leads to Accepted, but can still fall
through: a task whose premise broke leaves the train.

## Goals

- The user's only step is Accept. When to land, how to batch, and who fixes what are the train's job.
- Everything that lands is described. Each task describes its own revisions; the merge agent describes the merge.
- Conflicts are fixed by the task that has them, by rebasing onto `main`. The task's agent knows its work.
- A combined batch is checked before it lands: the merge agent runs the typecheck and the tests covering what the
  batch touches. The full suite (about 14 minutes for meddle) is never run by the train.
- `main` only ever moves to a checked result, and only through the same path as a push.
- A task whose change no longer makes sense on `main` leaves the train with its agent's reason, instead of being
  forced on.
- Revisions are described from the start: every task's CLAUDE.md asks for it.

## Non-goals

- Deciding what's ready. The user decides, by accepting.
- Trains for branches other than a project's default branch.
- The merge agent fixing code. It checks and describes; fixes go back to the task responsible.
- Pushing to an upstream (GitHub). That stays the user's.
- Replacing push-based acceptance. A checkout push that contains a task's line still accepts it, as today.

## Anti-goals (a failure even if it technically works)

- `main` gets something other than the tasks' work as their agents left it, merged cleanly, plus descriptions.
- A commit gets rewritten after another task has built on it, making divergent changes.
- A queued task's newer, unreviewed work lands because the user kept working in it after accepting.
- The user is asked to run jj, write a description, or clean up after meddle for work to land.

## How the train runs

### The queue

- **Accept** (a task action) queues the task on its project's train: its line's effective head is above its base and
  not already on the project's default branch. Idle and running tasks can be accepted. A running one waits in the
  queue until its turn ends. Refused: no work to land, archived, moving, prompts already waiting (`send or clear the
  waiting prompts first`, so nothing newer than what the user accepted runs after it), and, for now, work in more
  than one project (`accept handles one project for now; push to land the rest`). Tasks with several projects are
  for later, alongside attaching projects to tasks (designer's call).
- The queue is recorded by the task's holder, alongside the task's line rows, so it replicates and moves with the
  task (the exact shape is the builder's).
- **Leaving the queue:** the user's **Unqueue**; or the task's agent declining (below); or any input from the user
  that would run in the task after Accept, since its work is about to change and the user accepted the version before
  it: a new prompt, a steer into the turn that was running when Accept was pressed, Send now, or Retry. Answering an
  approval doesn't count: it continues the work the user accepted. A task that leaves shows why, and can be accepted
  again (designer's call).
- While the train runs a turn of its own on a task (a describe, rebase or fix turn), messages the user sends to it
  wait, and Send now has no effect on the train's turn. When that turn ends, a message that was waiting runs, and the
  task leaves the queue for the reason above.
- A message to a task whose batch is being checked runs at once. Like any other input, it takes the task off the
  queue: it's an unqueue plus the message, and the check stops as for Unqueue (see "Pauses and stopping") (the user's
  call).

### The conductor

Each project's train is run by the project's home node, so one node decides batches and moves the branch. When the
home is offline, the train waits, and shows `waiting for <home>`. Its work is a durable operation, `meddle.train`,
modelled on `MeddleMove` (`src/tasks/move.ts`): checkpoints survive a restart, it's registered in
`src/tasks/harness.ts`, and it counts as busy for update drains (`busyTasks`). One round runs at a time per train.

A round starts when something could change the outcome: a task is queued, a queued task's turn ends, the branch
moves, a train turn finishes, or Retry or Resume is pressed. A round's batch is fixed once picked: a task queued
mid-round waits for the next round, which starts as soon as this one lands or fails.

**Order.** The queue keeps the order tasks were accepted in, but within a round the train tries bigger work first
(step 2), so a queue position doesn't promise landing order. The dashboard shows no position numbers for that reason.

**Permissions.** Every train turn (a task's describe, rebase or fix turn, and the merge agent's turns) runs in the
`auto` permission mode, whatever the task's own mode is (the user's call). The task's own mode is untouched for the
user's turns. The `blame` and `decline` tools need no approval.

### A round

Let `B` be the branch's commit, and the **eligible** tasks the queued ones that are idle, on an online node, and not in
a train turn.

**1. Fix descriptions.** Every commit an eligible task would land, in `B..H`, must end up pushable upstream as it is:
`jj git push` refuses a commit with conflicts, and an empty commit with no description. For each commit that needs
fixing, find its owner: the task whose line made it, in whose workspace it is still mutable.

- Owned by the task: the train abandons empty, undescribed, non-merge leftovers itself. For undescribed or conflicted
  commits it gives the task a train turn: `Before your work lands on main: ` + (if any are conflicted)
  `resolve the conflicts in <changes>, then ` + the `describe.prompt` setting (default: the user's own wording,
  `Add a description (4-7 words) to your revision(s).`).
- Not the task's to fix (unowned, for example the user's own `@` that the task started from, or frozen because another
  task has built on it): the task leaves the queue, naming the commit and why.

**Commits that aren't the task's own** (the user's call). Landing a task lands every commit in `B..H`, and some may
not be its own:

- **The revision it started from, and what's below it:** the user's `@` when the task was started from their checkout,
  or a feature branch given with `--rev`. These land with the task, since the user chose that starting point. They
  still have to be pushable (described, no conflicts).
- **Another task's work** that the task's agent merged in (or that the task was started on). It lands only if that
  task is queued too, and then they land together (step 3). Otherwise the task is held back, staying queued but not
  eligible, with a notice: `<task> includes work from <other task>, which isn't queued`. Accepting the other task, or
  Unqueue, settles it.

**2. Pick a batch.** Order the eligible tasks by the size of their work, biggest first. Trial-merge them with `B`
without touching any workspace (builder's choice of mechanism, for example `git merge-tree`), adding each task that
still merges cleanly with `B` and the batch so far.

- A task that doesn't merge cleanly with `B` alone is marked **to rebase**.
- A task that merges with `B` but not with the batch waits for the next round.

**3. Check the batch.** The merge's parents are the heads of the batch's tips and `B`, so a tip that's an ancestor of
another is dropped. Usually `B` is dropped, because the tasks started from the current `main`. **Stacked tasks
supersede**: when a queued task contains another queued task's work (it merged that line, or started on it), the
contained task's tip drops out. Landing the containing task carries it along, and both are accepted in one go, with
no parent-then-child merges. The contained task is merged separately only if it has moved on since, because its
newer commits aren't in the other. The tasks' tips come
first, then `B` if it remains, matching how the user merges by hand (`jj new vnnpplvq main`).

- **One head left** (a single task already on top of `B`): no merge is needed. That task's work has already been
  tested by its own agent after its last rebase, or the user accepted it as is. Go to step 4.
- **Otherwise**, start a **merge task** with this project, placed like any new task (the home first, when it can host
  tasks; designer's call). The conductor drives it through the same calls it uses for train turns on tasks of other
  nodes. Its workspace starts on a new commit with those parents (`jj workspace add -r … -r …`; `createTask` needs a multi-parent start, and a line already allows several
  bases). Its title is `Merge <task titles>`, and its first prompt:
  > Check that `<tasks>` work together on main. Merged cleanly as `<change>`. Run the typecheck and the tests that
  > cover what they change; don't run the full suite, and don't change any files. If a test fails, call `blame` with
  > the task responsible and what failed. Otherwise: `<describe.prompt>`

  The merge task, and only it, gets a meddle tool **`blame(task, reason)`**. meddle already passes MCP servers to
  agents through the SDK options (`mcpServers`, `src/engine/options.ts`), so this can be an in-process server there.
  A tool call is a clear signal, which parsing the agent's reply wouldn't be.
- After its turn, if it blamed a task: that task leaves the batch and gets a fix turn (step 5), and the round starts
  over with the rest of the batch and a fresh merge task. The merge task is discarded (archived and deleted).
- Otherwise verify: the merge task's line head `L` is the merge itself (same change, same parents), has a description
  and no conflicts, and its tree equals the clean merge's tree (the merge agent changed no files). If not, give it a
  follow-up turn naming what's wrong; after a few rounds without progress (builder's choice, around three) the train
  pauses.

**4. Land.** Move the branch from `B` to `L` (or to the single head) exactly as a push to the conductor would. This
needs a node-internal **advance**, because only `git/serve.ts`'s receive-pack path writes branch rows today:

- factor `viewRefs`/`branchStates` out of `serve.ts`, and add `advanceBranch(deps, project, branch, old, new)`, which
  runs under `serialised(repoKey(replica))`: read the rows, refuse unless the branch is `single` at `old` and not
  stale, honour `inputHold`, check a fast-forward (`gitGraph.isAncestor(old, new)`; the server never checked that,
  because git clients do), run `refusePush` and `planPush`, then `writeBranchRow` for each planned row;
- then call `applyProject` outside the lock, as the push path does;
- the push path in `serve.ts` uses the same factored code, so the train and a push can't drift apart.

If the branch moved since `B` (someone pushed), the advance is refused. The round starts over against the new `B`; a
batch that still merges cleanly is checked again.

Release the train's hold on the batch's tasks *before* writing the branch row, or call acceptance again afterwards:
`#acceptOnce` skips tasks that aren't idle, running or waiting. Each holder's usual acceptance then archives its task,
and the conductor's archives the merge task. A merge task never outlives its batch.

**5. Rebase and fix.** After landing (or straight away, if nothing landed), each task marked to rebase gets a train
turn:

> main moved on, and your work no longer merges cleanly with it. Rebase onto main (`<commit>`), fix the conflicts,
> run the tests your changes affect (not the full suite), and keep each revision described. If your change no longer
> makes sense on main, because something it relies on is gone or has changed meaning, call `decline` with the reason.

A blamed task gets the same turn, opening with what the merge agent reported. During train turns, the task gets a
meddle tool **`decline(reason)`**: calling it takes the task off the queue, with that reason shown. A task can only
rebase its own mutable commits. If it can't (another task has built on them), it leaves the queue saying so.

When a train turn ends, the task is eligible again, and the next round starts.

### Pauses and stopping

- **A task sits out** when its train turn fails (after meddle's own reruns for tokens), or ends without doing its job
  (revisions still undescribed or conflicted, or still not merging cleanly after a rebase). It stays queued but isn't
  eligible: the train page shows it as sitting out, and a notice gives the reason, with **Retry** (also on its row).
  Only Retry brings it back, so the train never sends the same prompt round after round (designer's call). A task whose node is offline sits out too, as
  `waiting for <node>`, and comes back by itself when the node does.
- **The merge agent gets stuck** (several follow-ups without a verdict), **or its turn fails:** the train pauses,
  with `Paused: <reason>` and **Retry**.
- **Pause / Resume** (the user's): Pause holds the train. Train turns already running finish, since no agent is cut
  off mid-work, but nothing lands and no new round starts. The train stays paused, across restarts, until Resume.
  Resume carries on, and the round checks again first, in case the branch moved meanwhile. It's for "I'm about to push
  to main myself; hold off".
- **Unqueue** takes a single task off, at any time. If it's in the batch being checked, the check stops at once: the
  merge agent's turn is interrupted, the merge task is discarded, and the round starts over without it (the user's
  call: the merge agent must stop including a task the user took off the train). This applies however the task leaves
  the queue during the check: Unqueue, a message, archiving. That covers the other reason for stopping a round, so
  there's no Stop.

Things that need the user (a task that left the train, a task sitting out) are shown as **dashboard notices**, the
existing top-right notices that failed turns and moves use, until dismissed (see "The dashboard").

## Surfaces

- **CLI:**
  - `meddle task accept <task-id>...` queues tasks;
  - `meddle task unqueue <task-id>...` takes them off;
  - `meddle train [<project>]` prints the queue, with each task's state, and the current round's batch and step. With
    `--follow` it keeps printing until the queue is empty. `meddle train pause|resume [<project>]` pauses and resumes.

  The first two are refused while an update awaits confirmation, like other task commands. Help entries in
  `src/help.ts`.
- **Dashboard:** see "The dashboard" below.
- **Contracts:** `TaskObject` gains `accept`, `unqueue`, a train-turn entry point for the conductor, and a queue-state
  cell. `ProjectObject` gains the train's state (queue, round, step) and `retry`/`pause`/`resume`. An older node lacks
  these members, which the UI tolerates as it does other optional members. A task on an older node can't be accepted
  (`<node> runs an older meddle`).

## The dashboard

Mockups: `.superpowers/brainstorm/` in this task. The settled screens are `task-head.html`, `accept-and-watch.html`
(parts 1 and 3) and `train-from-banner.html`; the user then dropped the history column, the queue numbers, Stop and
every banner, as described here.

The user accepts where they've just looked at the work, so Accept lives on the task. The train page is for watching.

- **Accepting:**
  - in the task page's header actions, after Retry and Archive. Unlike Archive (idle tasks only), Accept also shows
    while a turn runs, since a running task can be queued. The header's buttons are shared by the Thread and Changes
    tabs, so Accept is at hand while reviewing the Changes;
  - in the task's ⋯ menu in the sidebar (also on right-click), first, above Rename, Move to… and Archive.
- **A queued task:** its sidebar row carries a 🚂, and its header says `🚂 queued` next to its state, the way it says
  `partly accepted` today. That 🚂 links to the train page. Its Accept button and menu item become **Unqueue**. No
  banner. Archiving a queued task takes it off the train.
- **The train page**, one per project, from a 🚂 Train entry under the project in the sidebar (with the queue's
  length), or from a queued task's 🚂 (which highlights that task's row). It shows only what's live, in two columns:
  - **Queued:** each task with its state (turn running, describing, rebasing onto main, sitting out, waiting for its
    node) and Unqueue;
  - **This round:** the steps (describing, picking, checking, landing); the **merge task** as a card of its own (what
    it's testing, typecheck status, Open); and the batch's tasks hanging under it;
  - **Pause / Resume** in the page header (`Paused: <reason>` with Retry when the merge agent got stuck).

  No history: landed batches are on `main` in the project's graph, and their tasks are archived.
- **Issues are notices only.** A task that leaves the train, or sits out, raises a top-right notice (as failed turns
  and moves do), with Open task and, for one that left, Accept again. Dismissing it clears it. Afterwards the task
  is a normal task again. The reason stays in its conversation as a meddle line, and Accept is back in its header and
  menu.
- **Train turns** appear in the task's conversation like any prompt, marked as meddle's.
- **The merge task** shows in the sidebar under its project while it exists (`🚂 Merge <titles>`), and is archived
  with its batch.
- **Settings:** `describe.prompt`.

## Descriptions from the start

- `generatedClaudeMd` adds a line to every project task's CLAUDE.md:
  `Add a description (4-7 words) to each revision you make (jj describe).`
- Live tasks never get CLAUDE.md rewritten today. Rewrite it at the start of each turn when its content differs, so
  existing tasks pick up the line.

## Setting

`describe.prompt`: one line (settings reject newlines), at most 4096 characters, default
`Add a description (4-7 words) to your revision(s).` It goes in `SETTING_KEY` (`src/pool/settings.ts`), with a
`describePrompt()` accessor and default constant, the dashboard's `SETTING_KEYS`, and the `config set` help. An older
node drops the key with its usual log line.

## Approaches considered

1. **Take, prompt only.** Send each task "merge main into your line, resolve, describe", and check at turn end. The
   fragile steps move to the agents.
2. **Take, each task merges `main` into its own line** (the first draft). One task per take, several merges for
   several tasks, and a failed take leaves a merge in the task's line.
3. **Take, with a merge agent resolving conflicts** (the second draft). One action for several tasks, but the
   resolver lacks the authors' context, a relaxed content check had to allow its rework, and the user still drove
   each take.
4. **A merge train (chosen).** The user accepts; the train batches clean work, sends conflicts back to the tasks
   that have them, and checks batches with targeted tests. It puts each job with whoever is best placed: deciding
   with the user, fixing with the author, checking and describing the combination with a merge agent.

## Starting point

Plan from current `main`, not this task's base. `main` gained `80dc4e8647ad` (`resumeEmpty`), `vnnpplvq` ("Restore
accepted tasks onto their branch", touching `durable.ts`, `move.ts` and `starts.ts`), and `pkvwqwvt`/`lpnrvoks`
(a turn stays open while it has background work, so such a task is running, not idle, and isn't eligible).

## Left to the builder

- How the queue is stored and replicated with the task's line rows, and how a moved task keeps its place.
- How the conductor asks a holder for a train turn and learns its outcome, and how a holder tells "the train is
  using this task" apart from a user turn (for waiting prompts and unqueueing).
- The trial-merge mechanism, and how "size of work" is measured (lines changed is fine).
- The jj helpers this needs (`new` with several parents, `abandon`, conflict, description and tree queries), and where
  they live. `src/jj.ts` has none of them yet; `memory-sync.ts` and `changes.ts` have patterns.
- The multi-parent start in `createTask` and `provisionTask`, and how its line rows record several bases.
- How the `blame` and `decline` tools reach only the turns that need them (an in-process MCP server in the SDK
  options is the expected route), and how a call is recorded so the train sees it after the turn.
- The number of follow-ups before a pause.
- Test layout. Cover: advance shared with push; accept and unqueue (including by a new prompt, and for a running
  task); describe turns and leftovers abandoned; a commit the task can't fix; batching (biggest first, a task that
  conflicts with `B`, a task that conflicts only with the batch, dropped redundant parents, the single-head case);
  the merge agent's check, `blame` and the smaller batch after it; verify catching a changed file; the branch moving
  before landing; rebase turns and `decline`; a task on an offline node; pause, Retry and Stop; restart in each
  step; the conductor offline; the CLAUDE.md line; the setting.
