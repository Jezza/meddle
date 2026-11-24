# One prepare turn: rebase, squash, describe

Changes the merge train ([2026-11-17-merge-train-design.md](2026-11-17-merge-train-design.md)) so each task lands as one
commit, based on main, with its agent naming the tests that cover it.

## Why

Agents often leave many revisions, and the train lands every one of them on main. A task should land as one described
commit. The task's own agent is also the one that knows which tests its change affects; the merge agent starts cold and
guesses from the diff.

## Goals

- Each task's own work lands as one commit; a batch is still joined by the merge commit (one commit per task, merged).
- A task is rebased onto main before it lands, in the same turn that squashes and describes it.
- The merge agent runs the tests each task's agent named, plus any the combination needs.

## Non-goals

- Agents messaging each other (the shared `sessions` registry). The train still sends every turn; revisit later.
- Squashing stacked work (below).
- Keeping every waiting task on the newest main (strict rebasing): see Re-preparing.

## Approaches

- **A. Each task squashes its own line in a train turn (picked).** The task's line moves to the squashed commit, so
  acceptance by containment, the merge step and the single-head landing are unchanged. The agent that knows the work
  describes it.
- **B. The train squashes while checking.** Builds a squashed commit per task inside the merge task. Main would stop
  containing the tasks' lines, so landed tasks need accepting by hand, single heads need their own path, and stacked
  tasks bring the old revisions back. Rejected: much more change.
- **Parallel trial merges while tasks prepare.** Rejected: a rebase that fixes conflicts changes trees, so the trial
  merge must run again after anyway.

## Design

### The prepare turn

The describe turn and the rebase turn become one turn kind, `prepare`. Its prompt:

> Before your work lands on main: rebase it onto main (`<B>`) and fix any conflicts, run the tests your change affects
> (not the full suite), squash your revisions into one, then `<describe.prompt>`. Then call ready with the test commands
> that cover your change. If your change no longer makes sense on main, because something it relies on is gone or has
> changed meaning, call decline with the reason.

A task the merge agent blamed gets the same turn, opening with the agent's report (as the fix turn does now).

The turn's tools are `decline(reason)` (as today) and a new `ready(tests)`: `tests` is a list of shell commands
(`bun test test/train-merge.test.ts`, say), at least one. Like `decline`, a call is recorded as an event
(`train_ready`) and read by `trainOutcome`, so it survives a restart. It needs no approval.

### When a task gets one

In step 1 (Describing, renamed Preparing), a task gets a prepare turn when any of:

- its own revisions (`ownWork`) are more than one, or one is undescribed or conflicted;
- the train has no test list for its current tip.

A task that doesn't merge cleanly with `B` (today's "marked to rebase") gets its prepare turn in step 5, which runs
straight away when nothing lands.

The last makes every task prepare at least once, so every task is rebased onto main and names its tests before it
lands. All prepare turns run at once, as describe turns do now.

### After the turn

The turn did its job when: it called `ready`; `B` is an ancestor of the tip; the task's own work is one revision,
described and without conflicts. Leftovers are abandoned first, as now. Otherwise the task sits out, as now. The test
list is stored with the tip it was given for, and survives restarts; a tip that changes makes it stale.

### Re-preparing

Lenient: after a landing, a waiting task is prepared again only if one of the conditions above holds (in practice, it no
longer merges cleanly). A task that still merges cleanly lands as it is, with its test list; the merge agent's run covers
the combination. Strict re-rebasing would cost a turn per waiting task per landing.

Step 5 keeps its place: tasks marked to rebase and blamed tasks get prepare turns right after the landing, onto the new
main.

### The merge agent

Its prompt names each task's tests:

> Check that `<tasks>` work together on main. Merged cleanly as `<change>`. Their agents name the tests that cover their
> changes: `<task>`: `<commands>`; … Run the typecheck, those, and any others the combination needs; don't run the full
> suite, and don't change any files. If a test fails, call blame with the task responsible and what failed. Otherwise:
> `<describe.prompt>`

Nothing else about the check changes. A single head lands as it is, as now: its agent tested it on main in its prepare
turn.

### Not squashed

- **Work another task has built on** (another line contains its own revisions): rewriting it would make the other task
  carry the old revisions. It keeps today's handling: a describe-only turn when undescribed or conflicted, and it leaves
  the queue when it would need a rebase. It isn't squashed or rebased. It still needs a test list, so its prepare turn
  asks it not to rewrite anything but to call `ready`.
- **Work that holds another task's line** (the agent merged it, or started on it): its own work has a merge inside, so
  it can't become one plain commit. In step 1 its prepare turn neither rebases nor squashes it (`keep`): it describes
  what needs it and calls `ready`. A step-5 turn rebases its own revisions, and must leave the work merging cleanly
  with main, not on it: rebasing it onto main would rewrite the other task's commits it holds.
- **Work that started off main** (on a checkout's `@`, or a `--rev` above main): its start lands with it, so rebasing
  onto main would drop it. In step 1 it is squashed where it is (`squash-here`); step 5 rebases it as before.

A task on a node running a meddle older than `ready` can't name its tests, so it sits out until that node is updated.

## Docs

README's merge train section (steps 1 and 5, the turn kinds, `train` states `describing` and `rebasing onto main`),
`src/help.ts`, and the `describe.prompt` setting's row.

## Left to the builder

- Where the test lists live (the train's durable per-task state) and how they're keyed to the tip.
- Whether the `train` state names change (`describing` → `preparing`), and keeping old checkpoints readable on resume.
- The exact prompt wording for the built-on case.
