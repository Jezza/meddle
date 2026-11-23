# Train prepare turn Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each queued task gets one turn that rebases it onto main, squashes its own revisions into one, describes it
and names the tests covering it (`ready`); the merge agent runs those tests.

**Architecture:** The train's describe turn (step 1) and rebase/fix turns (step 5) keep their places and their
`TrainTurnKind`s (`describe`, `rebase`, `fix`: no wire change for kinds), but all send one prompt (`preparePrompt`) and
are checked the same way (`#prepared`). A new `ready(tests)` tool records a `train_ready` event; `trainOutcome`
answers `done` with its `tests`. The conductor keeps each task's test list in a new `tests` column of the `trains` table,
keyed by the tip it was given for, and hands it to the round on `Candidate.tests`; `checkBatch` puts the lists into the
merge prompt.

**Tech Stack:** Bun, TypeScript, bun:sqlite, jj/git, zod (tools), TypeBox (contracts).

**Spec:** `docs/superpowers/specs/2026-11-24-train-prepare-turn-design.md`

## Global Constraints

- Bun is `~/.bun/bin/bun` (not on PATH). Typecheck: `~/.bun/bin/bun run typecheck` (it covers `test/` too).
- Run only the test files a task names, never the full suite.
- Commit with jj: `jj commit -m "<4-7 words>"`. No AI attribution.
- Keep `TrainTurnKind` and `RoundStep.step` values unchanged (`describe`/`rebase`/`fix`/`merge`; `describing`/…/`rebasing`), so checkpoints of older rounds and the train page states stay as they are.
- A tool call outcome must survive a restart and a rerun: it is read back from the task's events, as `decline` is, across all attempts of the turn.
- `ready`'s `tests`: at least one non-empty string.
- Comment style: match the surrounding code (doc comments on every export, prose in the spec's words).

## Rewrite modes

How a prepare turn may change a task's own work (`Rewrite`), decided per turn by the round:

| Mode | When | Asked | Checked after the turn |
|---|---|---|---|
| `squash` | its own work is all mutable and holds no other task's work | rebase onto main, squash into one, describe, `ready` | on main (main is an ancestor of the tip), one own revision |
| `rebase` | holds another task's work (`classify(...).foreign` non-empty), in step 5 (doesn't merge cleanly) | rebase its own revisions onto main, describe, `ready` | merges cleanly with main |
| `keep` | holds another task's work, in step 1 | describe what needs it, `ready`; don't squash, don't rebase | — |
| `none` | another task built on it (`#frozen`) | describe what needs it, `ready`; don't rebase or squash | — |

Every mode also checks: `ready` called (a list for the tip), own revisions described and without conflicts.
A frozen task in step 5 still leaves (`FROZEN`), as today.

## Review Focus

- A task the agent squashed and rebased but that forgot `ready`: it sits out with a reason saying so, not loop on prepare turns every round. (Task 4.)
- A round resumed after a restart or a pool-update hold, for tasks whose turn ran but whose list wasn't saved: they get their prepare turn again, they don't sit out. (Task 4.)
- A task with a stored list whose tip changed: stale, prepared again; but the train's own abandoning of leftovers carries the list to the new tip. (Tasks 3, 4.)
- Step 5's checks count own revisions against the new main, not step 1's `B`. (Task 4.)
- A task holding another's work is never asked to squash and never sat out for its revision count or for not sitting on main. (Task 4.)

---

### Task 1: The `ready` tool and its outcome

**Files:**
- Modify: `src/train/tools.ts`
- Modify: `src/engine/session.ts:20-61` (`MeddleEvent`, `isTrainEvent`)
- Modify: `src/state/contracts.ts:64-70` (`TrainTurnOutcomeSchema`)
- Modify: `src/dashboard/ui/thread-model.ts:285-290`
- Test: `test/train-turn.test.ts`; the test file that covers thread-model's `train_decline` rendering (find it with `grep -ln train_decline test`)

**Interfaces:**
- Produces: `TrainTurnOutcome`'s `done` is `{ kind: "done"; tests?: string[] }`. `MeddleEvent` gains `{ type: "meddle"; subtype: "train_ready"; tests: string[] }`. `TRAIN_TOOLS` is `["mcp__meddle__decline", "mcp__meddle__ready", "mcp__meddle__blame"]`. `trainToolList(kind)` for `describe`/`rebase`/`fix` answers `[decline, ready]`; for `merge` `[blame]`.

- [ ] **Step 1: Write the failing tests** in `test/train-turn.test.ts`, extending the existing tool-list and `trainOutcome` tests (adapt `record`, `recorded`, `start`, `success` to the names the file uses):

```ts
for (const kind of ["describe", "rebase", "fix"] as const) expect(trainToolList(kind, record).map((t) => t.name)).toEqual(["decline", "ready"]);
expect(TRAIN_TOOLS).toEqual(["mcp__meddle__decline", "mcp__meddle__ready", "mcp__meddle__blame"]);
const [, ready] = trainToolList("describe", record);
await ready!.handler({ tests: ["bun test test/a.test.ts"] }, {});
expect(recorded.at(-1)).toEqual({ type: "meddle", subtype: "train_ready", tests: ["bun test test/a.test.ts"] });
const readyEvent = (tests: string[]) => ({ type: "meddle", subtype: "train_ready", tests });
expect(trainOutcome([...start, readyEvent(["a"]), success])).toEqual({ kind: "done", tests: ["a"] });
// The last call counts.
expect(trainOutcome([...start, readyEvent(["a"]), readyEvent(["b"]), success])).toEqual({ kind: "done", tests: ["b"] });
// A decline wins over ready.
expect(trainOutcome([...start, readyEvent(["a"]), recorded[0], success])).toMatchObject({ kind: "declined" });
// A ready from an attempt a restart cut off still counts: the rerun is told not to redo finished work.
expect(trainOutcome([...start, readyEvent(["a"]), { type: "meddle", subtype: "turn_started", at: "", resume: true }, success]))
  .toEqual({ kind: "done", tests: ["a"] });
// Ready, then a failure: failed.
expect(trainOutcome([...start, readyEvent(["a"]), { type: "meddle", subtype: "turn_aborted", at: "" }])).toMatchObject({ kind: "failed" });
```

And a thread-model assertion: a `train_ready` event renders as a status row `Tests: bun test a, bun test b` (copy fixed: `Tests: ` then the commands joined by `, `).

- [ ] **Step 2: Run** `~/.bun/bin/bun test test/train-turn.test.ts` — FAIL (no `ready`).

- [ ] **Step 3: Implement.**
  - `tools.ts`: a `ready` tool after `decline` for non-merge kinds. Description: `"Call this once your work is ready to land, rebased, squashed and described as asked: name the commands that run the tests covering your change, so the merge agent runs them too."` Schema: `{ tests: z.array(z.string().min(1)).min(1).describe("Shell commands that run the tests covering your change, e.g. bun test test/foo.test.ts") }`. Records `train_ready`; answers `"Ready. End your turn."`. `trainOutcome`: keep the latest `train_ready`'s tests over the whole event list (not reset on `turn_started`, like a decline), and attach them to `done`. Update the doc comments of `TrainTurnOutcome`, `TRAIN_TOOLS`, `trainToolList`, `trainOutcome`.
  - `session.ts`: the `train_ready` variant (doc: "The task's agent called meddle's `ready` tool in a train turn, naming the commands that run the tests covering its change."); `isTrainEvent` includes it.
  - `contracts.ts`: `Type.Object({ kind: Type.Literal("done"), tests: Type.Optional(Type.Array(Type.String())) })`.
  - `thread-model.ts`: `case "train_ready"` → status `Tests: ${tests.join(", ")}` (string items only).

- [ ] **Step 4: Run** `~/.bun/bin/bun test test/train-turn.test.ts` and the thread-model test file — PASS. `~/.bun/bin/bun run typecheck` — PASS.

- [ ] **Step 5: Commit** `jj commit -m "Add train ready tool for tests"`

---

### Task 2: Prompts, `Candidate.tests`, and the merge prompt

**Files:**
- Modify: `src/train/prompts.ts`
- Modify: `src/train/batch.ts` (`Candidate`)
- Modify: `src/train/merge.ts` (`checkBatch` builds the merge prompt from `batch`)
- Modify: `src/train/train.ts` (`#candidates`: `tests: null` for now)
- Test: `test/train-turn.test.ts` (prompt copy; its `mergePrompt` call sites), `test/train-merge.test.ts`, `test/train-batch.test.ts` and `test/train-round.test.ts` (only `Candidate` literals get `tests`)

**Interfaces:**
- Produces:
  - `Candidate` gains `tests: string[] | null`: the commands its agent named for its current tip; null when none.
  - `export type Rewrite = "squash" | "rebase" | "keep" | "none";` (see Rewrite modes)
  - `export function preparePrompt(p: { main: string; rewrite: Rewrite; describe: boolean; conflicted: string[]; report?: string }, prompt: string): string` — `describe`: the task has undescribed or conflicted commits of its own (only read for `keep`/`none`; `squash`/`rebase` always include the describe prompt); `conflicted`: their change ids (only named for `keep`/`none`).
  - `export function mergePrompt(tasks: Array<{ task: string; tests: string[] | null }>, change: string, prompt: string): string`
  - `describePrompt` and `rebasePrompt` stay in this task (Task 4 still uses them until it switches); Task 4 removes them.

- [ ] **Step 1: Write the failing tests** in `test/train-turn.test.ts`. Exact copy (`D` = `"If your change no longer makes sense on main, because something it relies on is gone or has changed meaning, call decline with the reason."`, `P` = the describe prompt, `T` = `"Run the tests your change affects (not the full suite), then call ready with the commands that run them."`):

```ts
const base = { main: "abc", describe: true, conflicted: [] as string[] };
expect(preparePrompt({ ...base, rewrite: "squash" }, P)).toBe(
  `Before your work lands on main: rebase it onto main (abc) and fix any conflicts, run the tests your change affects (not the full suite), squash your revisions into one, then ${P} Then call ready with the commands that run those tests. ${D}`);
expect(preparePrompt({ ...base, rewrite: "rebase" }, P)).toBe(
  `Before your work lands on main: rebase your own revisions onto main (abc) and fix any conflicts, run the tests your change affects (not the full suite), then ${P} Then call ready with the commands that run those tests. ${D}`);
expect(preparePrompt({ ...base, rewrite: "keep", conflicted: ["k1", "k2"] }, P)).toBe(
  `Before your work lands on main: it holds another task's work, so don't rebase or squash it. Resolve the conflicts in k1 and k2, then ${P} ${T} ${D}`);
expect(preparePrompt({ ...base, rewrite: "none" }, P)).toBe(
  `Before your work lands on main: another task builds on your revisions, so don't rebase or squash them. ${P} ${T} ${D}`);
// Nothing to describe: no describe prompt.
expect(preparePrompt({ ...base, rewrite: "none", describe: false }, P)).toBe(
  `Before your work lands on main: another task builds on your revisions, so don't rebase or squash them. ${T} ${D}`);
expect(preparePrompt({ ...base, rewrite: "squash", report: "test four fails" }, P)).toBe(
  `The merge agent that checked your work together with other tasks on main reported: test four fails\n\n${preparePrompt({ ...base, rewrite: "squash" }, P)}`);
expect(mergePrompt([{ task: "A (t1)", tests: ["bun test a", "bun test b"] }, { task: "B (t2)", tests: ["bun test c"] }], "kx", P)).toBe(
  "Check that A (t1) and B (t2) work together on main. Merged cleanly as kx. Their agents name the tests that cover their changes: " +
  "A (t1): `bun test a`, `bun test b`; B (t2): `bun test c`. Run the typecheck, those tests, and any others the combination needs; " +
  `don't run the full suite, and don't change any files. If a test fails, call blame with the task responsible and what failed. Otherwise: ${P}`);
// Only the tasks with a list are named.
expect(mergePrompt([{ task: "A (t1)", tests: ["bun test a"] }, { task: "B (t2)", tests: null }], "kx", P)).toContain("changes: A (t1): `bun test a`. Run");
// No lists at all: today's wording.
expect(mergePrompt([{ task: "A (t1)", tests: null }, { task: "B (t2)", tests: null }], "kx", P)).toBe(
  "Check that A (t1) and B (t2) work together on main. Merged cleanly as kx. Run the typecheck and the tests that cover what they change; " +
  `don't run the full suite, and don't change any files. If a test fails, call blame with the task responsible and what failed. Otherwise: ${P}`);
```

For `keep`/`none` the middle is: the conflicts clause `Resolve the conflicts in <listed>, then ` when `conflicted` is non-empty, then `${P} ` when `describe`, then `T`. Update the file's existing `mergePrompt(string[], …)` call sites (around :351, :354) to the new shape. In `test/train-merge.test.ts`, give the candidates `tests` and update its expectation to `mergePrompt([{ task: "Fix one (t1)", tests: [...] }, …], merge.changeId, DESCRIBE)`.

- [ ] **Step 2: Run** `~/.bun/bin/bun test test/train-turn.test.ts test/train-merge.test.ts` — FAIL.

- [ ] **Step 3: Implement** `preparePrompt`, the new `mergePrompt`, `Candidate.tests`, `checkBatch`'s `mergePrompt(batch.map((c) => ({ task: label(c), tests: c.tests })), change, input.prompt)`, and `tests: null` in `#candidates`. Add `tests: null` to every `Candidate` literal in the test fixtures (`train-batch`, `train-merge`, `train-round`'s fixture `candidates()`).

- [ ] **Step 4: Run** `~/.bun/bin/bun test test/train-turn.test.ts test/train-merge.test.ts test/train-batch.test.ts test/train-round.test.ts` — PASS (round behaviour is unchanged yet). Typecheck — PASS.

- [ ] **Step 5: Commit** `jj commit -m "Prepare prompt and merge test lists"`

---

### Task 3: Keeping test lists in the train

**Files:**
- Modify: `src/store/db.ts` (`ADDED_COLUMNS`: `{ table: "trains", column: "tests", type: "TEXT NOT NULL DEFAULT '{}'" }`, commented in the file's style; update the `trains` comment)
- Modify: `src/train/train.ts` (`TrainRow`, `TrainRecord`, `readTrain`, `updateTrain`, `#prune` incl. its early return, `#candidates`, the round deps)
- Modify: `src/train/round.ts` (`RoundDeps.saveTests` declaration and its doc line in `RoundDeps`'s comment; the test fixture in `test/train-round.test.ts` gets a `saveTests` that stores and logs `save <id>`)
- Test: `test/train.test.ts`

**Interfaces:**
- Consumes: `Candidate.tests` (Task 2).
- Produces:
  - `export function saveTrainTests(db: Database, projectId: string, taskId: string, tip: string, tests: string[]): void` in train.ts, beside `retryTask`.
  - `export function trainTests(db: Database, projectId: string): Record<string, { tip: string; tests: string[] }>` (read side, for `#candidates` and tests).
  - `RoundDeps.saveTests(taskId: string, tip: string, tests: string[]): Promise<void>`; the conductor's calls `live()` then `saveTrainTests`.
  - `#candidates` sets `c.tests` to the stored list when its `tip` equals the candidate's tip, else null.

- [ ] **Step 1: Write the failing tests** in `test/train.test.ts`, using its node harness:
  - `"a task's test list is kept with its tip, and dropped when it leaves the queue"`: `saveTrainTests(n.db, P, t.id, tip, ["bun test a"])` → `trainTests(n.db, P)` equals `{ [t.id]: { tip, tests: ["bun test a"] } }`; after the task is unqueued and the conductor prunes (however the file already triggers `#prune`: a round or unqueue path), the entry is gone.

- [ ] **Step 2: Run** `~/.bun/bin/bun test test/train.test.ts -t "test list"` — FAIL.

- [ ] **Step 3: Implement** as in Interfaces.

- [ ] **Step 4: Run** `~/.bun/bin/bun test test/train.test.ts -t "test list"` — PASS; typecheck — PASS. (The rest of train.test.ts is Task 4's to fix.)

- [ ] **Step 5: Commit** `jj commit -m "Keep train test lists per task"`

---

### Task 4: The round prepares tasks

**Files:**
- Modify: `src/train/round.ts`, `src/train/prompts.ts` (remove `describePrompt`, `rebasePrompt`)
- Modify: `test/train-round.test.ts`, `test/train.test.ts`, `test/state.test.ts`, `test/train-turn.test.ts` (old prompt functions → `preparePrompt`)

**Interfaces:**
- Consumes: `preparePrompt`, `Rewrite` (Task 2); `RoundDeps.saveTests`, `Candidate.tests` (Task 3); `TrainTurnOutcome.done.tests` (Task 1); `ownWork`, `classify`, `trialMerge`.
- Produces (internal): `#turn(taskId, kind, text): Promise<{ tests: string[] | null } | null>` (null: it didn't end as asked); `#fix` answers `{ turned: boolean; tests: string[] | null } | null`.

**Behaviour:**

- **Mode.** `rewrite` per the Rewrite modes table: `none` when any own commit (`ownWork(cfg, repo, main, c, lines)`) is immutable; else `keep` (step 1) / `rebase` (step 5) when `classify(...).foreign` is non-empty; else `squash`. `main` is `this.B` in step 1 and the branch's new commit in step 5; `lines` is `this.#lines` in step 1 and a fresh `deps.lines()` read in step 5. `#frozen` takes `main` and `lines` as arguments.
- **Own revisions** (for `squash` only): `ownWork(...)` minus `classify(...).leftovers`.
- **Step 1, `#settle`.** After today's checks (unfixable → leave, foreign unqueued → hold back), a task is `work` when it has `toFix`, leftovers, or needs a prepare turn: `rewrite === "squash"` with more than one own revision, or `c.tests === null`. Its turn (when it needs one: `toFix`, several revisions, or no list) is `kind: "describe"`, text `preparePrompt({ main: this.B, rewrite, describe: toFix.length > 0, conflicted }, this.prompt)`. A task with only leftovers gets no turn, as today.
- **Step 1, after the turns.** Read again (`fresh`, as today). For each task back from `#fix`: if it had a turn and it answered `tests`, `saveTests(id, freshTip, tests)` and set the fresh candidate's `tests`; if it had no turn (only leftovers abandoned) and its old candidate had `tests`, carry them: `saveTests(id, freshTip, oldTests)` and set them. Then `#settle(fresh, turned)` as today (it handles leave/hold back/`toFix`-still-there sit-out and later leftovers), then, if ready, `#prepared(c, this.B, rewrite)`; a problem sits it out.
- **`#prepared(c, main, rewrite)`** answers the first problem, as the sit-out reason, or null:
  1. `c.tests === null`: `"its prepare turn didn't call ready"`;
  2. `rewrite === "squash"` and `main` is not an ancestor of the tip: `"its work isn't on main after its prepare turn"`;
  3. `rewrite === "rebase"` and the tip doesn't merge cleanly with `main` (`#conflicts`): `STILL_CONFLICTS`;
  4. own commits still undescribed or conflicted (`classify(...).toFix` against `main`): `"<changes> is/are still undescribed or conflicted after its prepare turn"` (today's wording, `describe` → `prepare`);
  5. `rewrite === "squash"` and more than one own revision: `"its work is still <n> revisions after its prepare turn"`.
- **`#settle`'s `turned` becomes three-way:** `type Turned = "no" | "now" | "resumed"`.
  - `"no"`: as described above (may answer `work` with a prepare turn).
  - `"now"` (it had its prepare turn in this round): the prepare-turn conditions never answer `work`. After today's checks (leave, hold back, leftovers, `toFix` still there → sit out), the task goes to `#prepared`; any problem sits it out with that reason. So a turn that didn't call `ready`, or didn't squash, sits the task out in this round and is never asked again until Retry.
  - `"resumed"` (named by the round's `describing` checkpoint as asked): run `#prepared` with problem 1 skipped. A problem sits the task out. With none, a missing list (`c.tests === null`) answers `work` with a prepare turn again, because the list was lost to a restart or a hold. Otherwise the task is `ready`.
- **Step 5 for `asked` tasks** (resumed `rebasing` checkpoint): the same as `"resumed"`, using step 5's `#prepared(c, main, rewrite)`. This replaces the unconditional `STILL_CONFLICTS` sit-out: a problem sits the task out, a missing list alone gives the prepare turn again, and anything else counts as done (`again`).
- **Step 5 (`rebase`).** `toRebase` tasks get `kind: "rebase"`, blamed tasks `kind: "fix"`, text `preparePrompt({ main, rewrite, describe: true, conflicted: [], report? }, this.prompt)` with `rewrite` `squash` or `rebase` (frozen tasks leave with `FROZEN`, as today). After the turns, read `candidates()` and `lines()` afresh, save lists as in step 1, then `#prepared(c, main, rewrite)`; a problem sits the task out, none sets `again`. `#unclean` is subsumed by problem 2 (a `squash` task must be on main): remove it, and the `isAncestor` part of today's `still` check.
- **Docs in code.** Update `runRound`'s doc steps 1 and 5, `Settled`, and the class comments, in the file's voice.

- [ ] **Step 1: Update the round fixture** (`test/train-round.test.ts`). `Task` gains `tests: { tip: string; tests: string[] } | null`; `task()` sets `{ tip, tests: ["bun test"] }` unless `over` says otherwise (`tests: null` for none); `candidates()` sets `tests` only when the stored tip is the current tip; `saveTests` (Task 3) stores `{ tip, tests }`. A non-merge turn whose behaviour returns nothing answers `{ kind: "done", tests: ["bun test"] }`. Replace every `describePrompt`/`rebasePrompt` expectation with the matching `preparePrompt(...)`.

- [ ] **Step 2: Update existing round tests whose meaning changes:**
  - :224 "a conflicting task gets a rebase turn…": prompt `preparePrompt({ main: fresh, rewrite: "squash", describe: true, conflicted: [] }, DESCRIBE)`.
  - :245 "a rebase turn that leaves the work conflicting…": sit-out reason now `its work isn't on main after its prepare turn`.
  - :253 "decline takes a task off": prompt `preparePrompt({ main: B, rewrite: "squash", describe: true, conflicted: [] }, DESCRIBE)`.
  - :298 "a described task lands…": the behaviour also squashes the draft, left and merge into one revision on B (e.g. `jj squash` them into a new commit on B with the resolved file, bookmark moved); the prompt has `describe: true`; it still lands in the same round.
  - :322 "the train abandons a task's empty leftovers itself": `first` and `second` would now be two own revisions needing a squash. Keep the test's point with one real revision: `empty` on B, then `first` on `empty`; assert `abandoned` is `[["t1", [empty]]]`, `turns` is `[]` (the list carried to the new tip), and it lands `first` rewritten onto B.
  - :387 "blame drops the culprit…": fix turn text `preparePrompt({ main: L.commitId, rewrite: "squash", describe: true, conflicted: [], report: "test four fails" }, DESCRIBE)`.
  - :666, :681: reasons/prompts per problem 2 and the new prompt text.
  - Any other test that now fails: decide from the Behaviour section, and list the change in the commit's task report.

- [ ] **Step 3: Write the new failing round tests:**
  - `"a task of several revisions gets a prepare turn and lands as one"`: t1 = two described commits on B; the behaviour squashes them into one (bookmark moved) → one `describe` turn with the `squash` prompt; lands its single commit; the list is saved for the new tip.
  - `"a task without a test list is prepared, and lands with the list it named"`: single described commit, `tests: null`; behaviour returns `{ kind: "done", tests: ["bun test x"] }`; with a second clean task in the batch, the merge turn's text contains ``Task t1 (t1): `bun test x` ``.
  - `"a prepare turn that doesn't call ready sits the task out"`: behaviour returns `{ kind: "done" }` → `satOut` `[["t1", "its prepare turn didn't call ready"]]`; nothing lands.
  - `"a prepare turn that leaves several revisions sits the task out"`: behaviour does nothing → `its work is still 2 revisions after its prepare turn`.
  - `"a stale test list prepares the task again"`: stored list for an older tip → a prepare turn.
  - `"a resumed round asks again a task whose list was lost"`: `run({ step: "describing", batch: ["t1"], mergeTask: null })` with t1 `tests: null` and one described revision → t1 gets a turn (not sat out) and lands.
  - `"a task holding another task's work is asked to keep it"`: the stacked pair setup of :371 with the top task `tests: null` and two own revisions → its prompt has `rewrite: "keep"`, and it isn't sat out for its revision count; the pair lands.
  - `"a task another builds on is asked only for its tests"`: the bottom of a stack, `tests: null` → prompt `rewrite: "none"`, `describe: false`.
  - `"a rebase turn counts revisions against the new main"`: the `movedOn()` setup; after t1 lands, t2's rebase behaviour puts one revision on the new main → not sat out.

- [ ] **Step 4: Run** `~/.bun/bin/bun test test/train-round.test.ts` — the new tests FAIL.

- [ ] **Step 5: Implement** the Behaviour in `round.ts`; remove `describePrompt`/`rebasePrompt` and switch `test/train-turn.test.ts`'s uses to `preparePrompt`.

- [ ] **Step 6: Fix the integration stand-ins.** In `test/train.test.ts`, `fakeMerge` answers non-merge turns it doesn't otherwise handle with `{ kind: "done", tests: ["bun test"] }` instead of falling through to the real turn (which calls no tools); every `n.hooks.trainTurn`/`B.hooks.trainTurn` that returns `{ kind: "done" }` for a task turn (around :383, :445, :486, :563 `others`, :597, :693) returns it with `tests: ["bun test"]`; same in `test/state.test.ts` (:1027, :1060). Where a test's task has several revisions and its stand-in doesn't squash, give the task one revision instead.

- [ ] **Step 7: Run** `~/.bun/bin/bun test test/train-round.test.ts test/train-merge.test.ts test/train-batch.test.ts test/train-turn.test.ts test/train.test.ts test/state.test.ts` — PASS; typecheck — PASS.

- [ ] **Step 8: Commit** `jj commit -m "Prepare queued tasks in one turn"`

---

### Task 5: Docs

**Files:**
- Modify: `README.md` (The merge train: steps 1, 3's merge prompt, 5; "Sitting out"; the `ready` tool beside `decline` and `blame`; the `describe.prompt` setting row)
- Modify: `src/help.ts` (around :171 and :352-354, the "describe or rebase" turn wording)
- Modify: `docs/superpowers/specs/2026-11-24-train-prepare-turn-design.md`: in "Not squashed", work holding another task's line is not rebased in step 1 (`keep`); a step-5 rebase must leave it merging cleanly, not on main. "When a task gets one": "doesn't merge cleanly with B" is handled by step 5, which runs straight away when nothing lands. Add: a holder on an older meddle offers no `ready`, so its tasks sit out until it is upgraded.
- Modify: `docs/superpowers/specs/2026-11-17-merge-train-design.md`: one line at its top pointing to the new spec for what changed.

- [ ] **Step 1:** Rewrite those README parts: the prepare turn's conditions; the four prompt shapes quoted as `preparePrompt` produces them with the default describe prompt; `ready(tests)`; the merge prompt with lists; the new sit-out reasons. Keep the surrounding voice.
- [ ] **Step 2:** `grep -rn "rebasePrompt\|describePrompt\|Rebase onto main (" README.md src test` — nothing stale.
- [ ] **Step 3: Commit** `jj commit -m "Document the train prepare turn"`
