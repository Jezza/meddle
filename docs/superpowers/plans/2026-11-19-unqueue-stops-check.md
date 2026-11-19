# Unqueue Stops the Check — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a task in the batch being checked leaves the queue (Unqueue, a message, archiving), the check stops at
once: the merge agent's turn is interrupted, the merge task is discarded, and the round starts over without that task.

**Architecture:** The conductor already sees every line change (`#lineChanged` in `src/train/train.ts`), and
discarding a merge task already interrupts its turn first (`#discard`). The conductor marks the round as changed and
discards the merge task. The interrupted merge turn then surfaces as a new `BatchChanged` error from the production
`turn` dep, and `Round.#check` maps it to "round again" rather than `stuck`, so the train doesn't pause.

**Tech Stack:** TypeScript on bun; existing train modules.

**Spec:** `docs/superpowers/specs/2026-11-17-merge-train-design.md`, "The queue" (a message to a task whose batch is
being checked runs at once and unqueues it) and "Pauses and stopping" (Unqueue: the check stops at once). Both are the
user's calls from 2026-11-19.

## Global Constraints

- Same as the merge-train plan: commit with jj (`jj commit -m "<imperative, 4-7 words>"`, no AI attribution); verify
  with targeted test files plus `~/.bun/bin/bun run typecheck`, never the full suite in the task.
- "However the task leaves the queue during the check" covers Unqueue, a user message (it runs at once and unqueues,
  per Task 6's input hooks), archiving, and a decline recorded on another of the task's turns.
- A stopped check never pauses the train and never sits a task out. It is "round again".

## Review Focus

1. **The task leaves just as the merge turn ends on its own.** No double discard, and no stuck pause. The round still
   starts over without the task, or lands the rest if the check had already finished and `#unchanged` catches it.
2. **The merge task is on another node.** The interrupt reaches it through the existing members-only discard path,
   which `#holderOf`/`mergeNodes` route.
3. **A message is sent to a batch task during the check.** It runs, unqueues the task, and the check stops: this is the
   composition the user asked for.

---

### Task 16: Stop the check when a batch task leaves the queue

**Files:**
- Modify: `src/train/round.ts` (export `BatchChanged`; `#check`'s catch maps it to "again", after discarding),
  `src/train/train.ts` (`#lineChanged`: detect a batch task leaving during `checking`; the round's state records it;
  production `turn` and `createMergeTask` throw `BatchChanged` once it is recorded), `README.md` (the unqueue-during-
  check sentences now say the check stops at once).
- Test: `test/train.test.ts`, `test/train-round.test.ts`

**Interfaces:**
- Produces: `export class BatchChanged extends Error` in `src/train/round.ts`, constructed with the leaving task's id
  (`taskId: string` field). `Round.#check` (and the `land` loop) treat it as "the batch changed": discard the merge task
  if one exists, return `again: true` without pausing, and sit nobody out.

- [ ] **Step 1: Write failing tests**
  - `train.test.ts` `unqueueing a batch task stops the check at once`: two queued tasks are checked by a merge turn that
    stalls (`MEDDLE_FIXTURE_STALL`, or the conductor's turn hook). Unqueue one task. Then:
    - the merge turn is interrupted promptly, without waiting for the stall;
    - the merge task is discarded;
    - the train isn't paused;
    - the next round lands the other task alone, as a fast-forward if it sits on `B`, otherwise with a fresh check;
    - the unqueued task is not in what lands.
  - `train.test.ts` `a message to a batch task during the check stops it too`: as above, but the user prompts the task
    instead of unqueueing it. The task leaves the queue with `you sent it a prompt`, and the check stops.
  - `train-round.test.ts` `BatchChanged from the merge turn rounds again without pausing`: with a fake `turn` that throws
    `BatchChanged`, `runRound` returns `{landed: null, again: true, paused: null}`, the merge task is discarded, and
    nobody sits out.
- [ ] **Step 2: Run** `~/.bun/bin/bun test test/train.test.ts test/train-round.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Keep it to the seams named above. The discard is idempotent, so the conductor's discard and
  the round's discard-on-`BatchChanged` can both run safely. Record the leaving task so the next round's
  `candidates()` excludes it naturally; it is no longer queued.
- [ ] **Step 4: Run** `~/.bun/bin/bun test test/train.test.ts test/train-round.test.ts test/train-merge.test.ts test/queue.test.ts`
  and `~/.bun/bin/bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `jj commit -m "Stop the check when a task leaves"`
