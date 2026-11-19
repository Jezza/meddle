# Merge Train Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The user accepts tasks; each project's train (run by the project's home node) gets their work onto the
default branch: tasks describe and rebase their own work, clean work lands in batches checked by a merge agent with
targeted tests, and `main` moves exactly as a push would.

**Architecture:**
- **Queue:** recorded by the task's holder, as a `queued_at` column on its project line row. So it replicates, survives
  moves and is fenced by epochs like the line itself.
- **Holder side (`TaskRunner`):** accept and unqueue, plus *train turns*: normal durable turns forced to `auto`, with
  an in-process `meddle` MCP server for `decline` and `blame`.
- **Conductor (`src/train/`):** a durable `meddle.train` operation on the home node. Its round logic lives in
  `round.ts` behind injected dependencies (turns, task creation, landing), so it can be tested with real jj repos and
  fake turns.
- **Landing:** goes through `advanceBranch`, which shares its checks with the push hook.

**Tech Stack:** TypeScript on bun, jj 0.46+ (`~/.cargo/bin/jj` is a 0.45.1 dev build with `--colocate`), git
`merge-tree --write-tree`, typebox contracts on `@earendil-works/chord`, `@anthropic-ai/claude-agent-sdk` 0.3.314
(`createSdkMcpServer`, `tool`, zod 4), Preact dashboard.

**Spec:** `docs/superpowers/specs/2026-11-17-merge-train-design.md`

## Global Constraints

- Work from current `main`. Commit each task with jj: `jj commit -m "<imperative, 4-7 words>"`. No AI attribution in
  messages.
- Verify each task with its targeted test files plus `~/.bun/bin/bun run typecheck`. Never run the full suite in a
  task (about 14 minutes). Run it once, in the final review. bun is at `~/.bun/bin/bun`; run
  `~/.bun/bin/bun install --frozen-lockfile` first if `node_modules` is missing.
- Fixed copy and values (from the spec, verbatim):
  - `describe.prompt` default: `Add a description (4-7 words) to your revision(s).`
  - CLAUDE.md line: `Add a description (4-7 words) to each revision you make (jj describe).`
  - Describe turn: `Before your work lands on main: ` + (when any are conflicted) `resolve the conflicts in <changes>, then ` + describe.prompt
  - Rebase turn: `main moved on, and your work no longer merges cleanly with it. Rebase onto main (<commit>), fix the conflicts, run the tests your changes affect (not the full suite), and keep each revision described. If your change no longer makes sense on main, because something it relies on is gone or has changed meaning, call decline with the reason.`
  - Merge task title `Merge <task titles>`. First prompt: `Check that <tasks> work together on main. Merged cleanly as <change>. Run the typecheck and the tests that cover what they change; don't run the full suite, and don't change any files. If a test fails, call blame with the task responsible and what failed. Otherwise: ` + describe.prompt
  - Refusals: `send or clear the waiting prompts first`; `accept handles one project for now; push to land the rest`; `<node> runs an older meddle`.
  - Notice: `<task> includes work from <other task>, which isn't queued`.
- Train turns run with `permissionMode: "auto"`, whatever the task's own setting. Tools: MCP server `meddle`, tools
  `decline(reason)` (task train turns) and `blame(task, reason)` (merge task), allowed without approval
  (`mcp__meddle__decline`, `mcp__meddle__blame`).
- At most 3 follow-up turns for the merge agent, then the train pauses.
- One train per project, on its default branch, run by `project.home`. Accept handles single-project tasks only.
- git ≥ 2.38 (for `merge-tree --write-tree`): add this to README "Install" next to the jj requirement.

## Review Focus

1. **A queued task's node goes offline during its train turn.** The round must not hang: the task sits out as
   `waiting for <node>` and the rest goes on. Test in Task 10.
2. **The user pushes `main` from a checkout while the merge agent is checking.** The landing must be refused and the
   round restart against the new `main`; nothing stale lands. Test in Task 11.
3. **Accept twice, or Accept then an immediate prompt.** Accept is idempotent, and the prompt takes the task off the
   queue as soon as it runs. Test in Task 6.
4. **The home restarts mid-round, with the merge task running.** The round resumes from its checkpoint without
   creating a second merge task. Test in Task 11.
5. **A queued task, or one in the batch, is archived or deleted.** It leaves the queue; if it was in the batch, the
   round restarts without it. Test in Task 10.

## File Structure

- `src/projects/view.ts` (new): `viewRefs`, `shownAt`, `branchStates`, moved out of `src/git/serve.ts`.
- `src/projects/advance.ts` (new): `advanceBranch`.
- `src/projects/branches.ts`: add `pushRefusal` (the hook's ordered checks, now shared).
- `src/jj.ts`: `workspaceAdd` takes several revisions; new `abandon`, `commitsIn`, `treeOf`.
- `src/git/merge-tree.ts` (new): trial merges.
- `src/pool/rows.ts`, `src/store/db.ts`, `src/state/contracts.ts`: `queuedAt` on line rows.
- `src/tasks/manifest.ts`, `src/projects/starts.ts`, `src/tasks/provision.ts`: multi-parent start; `merge` on the
  manifest.
- `src/tasks/durable.ts`: accept, unqueue, input hooks, train turns, CLAUDE.md refresh.
- `src/engine/options.ts`, `src/train/tools.ts` (new): the per-turn `auto` mode and `meddle` tools.
- `src/train/prompts.ts` (new): the train's prompt texts.
- `src/train/batch.ts` (new): classify commits, pick a batch, merge parents.
- `src/train/round.ts` (new): one round, behind `RoundDeps`.
- `src/train/train.ts` (new): the `meddle.train` durable operation, triggers, the `trains` table, pause and resume.
- `src/state/host.ts`, `src/state/contracts.ts`: TaskObject `accept`/`unqueue`/`queue`, ProjectObject `train` and
  `pause`/`resume`/`retry`, PeerObject `trainTurn`, notification kind `train`.
- `src/cli.ts`, `src/help.ts`: `task accept|unqueue`, `train`.
- `src/pool/settings.ts`, `src/dashboard/ui/Settings.tsx`: `describe.prompt`.
- `src/dashboard/ui/`: `Task.tsx`, `Sidebar.tsx`, `sidebar-model.ts`, `routes.ts`, `main.tsx`, `Train.tsx` (new),
  `train-model.ts` (new).
- `README.md`.

---

### Task 1: One path for moving a branch (`advanceBranch`)

**Files:**
- Create: `src/projects/view.ts`, `src/projects/advance.ts`, `test/advance.test.ts`
- Modify: `src/git/serve.ts` (drop the moved helpers, import them), `src/git/pre-receive.ts:105-130` (call
  `pushRefusal`), `src/projects/branches.ts`, `src/projects/applier.ts:26` (import `VIEW` from view.ts)
- Test: `test/advance.test.ts`, `test/branches.test.ts`, `test/checkouts.test.ts`, `test/git.test.ts`

**Interfaces:**
- Produces:
  - `viewRefs(cfg: NodeConfig, repo: string): Promise<Map<string,string>>`, `branchStates(cfg, repo, rows: BranchRow[], view): Promise<{heads: BranchHeads; stale: string[]}>` (moved unchanged).
  - `pushRefusal(input: {refuse: string|null; pushed: PushedRef[]; heads: BranchHeads; stale: string[]; rows: readonly BranchRow[]; selfId: string; project: string}, g: Graph): Promise<string|null>`: the hook's checks in its order (refuse, `refusePush`, still fetching, `planPush` throwing), returning the hook's exact strings.
  - `advanceBranch(deps: ReplicaDeps & {selfId: string; inputHold?: () => string|null}, projectId: string, branch: string, old: string, next: string): Promise<void>`. It throws `Error` with the refusal text. On top of `pushRefusal`'s, it adds `<branch> is not at <old>` (computed state isn't `single` at `old`) and `<branch>: <next> is not a fast-forward from <old>`.

- [ ] **Step 1: Write failing tests** in `test/advance.test.ts`, using `startPoolNode`/`commitOn`-style helpers from
  `test/applier.test.ts`:
  - `advance moves the branch like a push`: after `advanceBranch(…, "main", B, C)`, `listBranchRows` has this node's
    row at `C`, and the view shows `refs/heads/main` → `C` after `applyProject`.
  - `refuses a branch not at old`: rejects with `main is not at <B>`.
  - `refuses a non-fast-forward`: rejects with `main: <X> is not a fast-forward from <B>`.
  - `refuses a conflicted branch`: rejects with `conflictFix("main", siblings)`.
  - `refuses while fetching`: rejects with `main: this node is still fetching it; push again shortly`.
  - `refuses under an input hold`: rejects with `meddle: <hold>`.
  - In `test/branches.test.ts`, `pushRefusal` follows the check order: the hold wins over a refused ref, and so on.
- [ ] **Step 2: Run** `~/.bun/bin/bun test test/advance.test.ts test/branches.test.ts`. Expected: FAIL
  (`advanceBranch`/`pushRefusal` not defined).
- [ ] **Step 3: Implement.** Move the helpers, add `pushRefusal`, and make the hook call it. Write `advanceBranch`
  under `serialised(repoKey(replica))`; it calls `applyProject(deps, projectId, APPLY_AFTER_PUSH_MS)` after leaving
  the lock. `next` must already be in the replica.
- [ ] **Step 4: Run** `~/.bun/bin/bun test test/advance.test.ts test/branches.test.ts test/checkouts.test.ts test/git.test.ts`
  and `~/.bun/bin/bun run typecheck`. Expected: PASS. The push tests are unchanged and still pass.
- [ ] **Step 5: Commit** `jj commit -m "Move branches through one shared path"`

### Task 2: `describe.prompt`, and describing from the start

**Files:**
- Modify: `src/pool/settings.ts:8,66,94`, `src/dashboard/ui/Settings.tsx:82`, `src/help.ts:166-174`,
  `src/tasks/provision.ts:21`, `src/tasks/durable.ts:935` (turn start)
- Test: `test/settings.test.ts`, `test/provision.test.ts:107`, `test/durable.test.ts`

**Interfaces:**
- Produces: `DESCRIBE_PROMPT = "Add a description (4-7 words) to your revision(s)."`, and `PoolSettings.describePrompt(): string`, which falls back to it when the setting is unset or empty.

- [ ] **Step 1: Write failing tests:**
  - `describe.prompt defaults and can be set`: unset gives the default constant; after set it gives the value; a value
    with `\n` is refused.
  - `generatedClaudeMd asks for descriptions`: extend the exact-text test at provision.test.ts:107 with the CLAUDE.md
    line.
  - `a turn rewrites a stale CLAUDE.md`: overwrite `<task>/CLAUDE.md` with old text, prompt, wait for the turn's end;
    the file now equals `generatedClaudeMd(...)`.
- [ ] **Step 2: Run** `~/.bun/bin/bun test test/settings.test.ts test/provision.test.ts test/durable.test.ts`.
  Expected: FAIL.
- [ ] **Step 3: Implement.** Add `describe\.prompt` to `SETTING_KEY` and the accessor; add the line to
  `generatedClaudeMd`; in `runTurnPhase`, after `readManifest`, rewrite `<task>/CLAUDE.md` when it differs. Add the
  key to the dashboard list and the `config set` help.
- [ ] **Step 4: Run** the same tests and the typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `jj commit -m "Ask agents to describe every revision"`

### Task 3: jj and git helpers for the train

**Files:**
- Create: `src/git/merge-tree.ts`, `test/merge-tree.test.ts`
- Modify: `src/jj.ts` (`workspaceAdd` :142, new helpers)
- Test: `test/jj.test.ts`, `test/merge-tree.test.ts`

**Interfaces:**
- Produces:
  - `workspaceAdd(repo: string, name: string, path: string, revisions: string | readonly string[], cfg?: NodeConfig): Promise<void>`: one `-r` per revision.
  - `abandon(repo: string, revset: string, cfg?: NodeConfig, opts?: {ignoreWorkingCopy?: boolean}): Promise<void>`.
  - `type CommitInfo = {changeId: string; commitId: string; parents: string[]; empty: boolean; conflict: boolean; description: string; mutable: boolean}`, and `commitsIn(cwd: string, revset: string, cfg?: NodeConfig): Promise<CommitInfo[]>`. It runs with `--ignore-working-copy`; `mutable` is evaluated in `cwd`'s config, so run it in a task workspace to get that task's view.
  - `treeOf(cfg: NodeConfig, repo: string, commit: string): Promise<string>` (`git rev-parse <c>^{tree}`).
  - `trialMerge(cfg: NodeConfig, repo: string, commits: readonly string[]): Promise<{tree: string; conflicts: string[]} | {tree: null; conflicts: string[]}>`. It folds `git merge-tree --write-tree --name-only` left to right over `commits`, through temporary commits made with `git commit-tree`. `tree: null` means it conflicts, and `conflicts` lists the paths.

- [ ] **Step 1: Write failing tests:**
  - `workspaceAdd with two revisions makes a merge`: the new working copy's parents equal both.
  - `abandon drops empty leftovers`.
  - `commitsIn reports empty, conflict, description and mutability`.
  - `trialMerge` (merge-tree.test.ts): two disjoint edits give a tree; two edits of one line give `tree: null` and
    `conflicts: ["f.txt"]`; three commits fold.
- [ ] **Step 2: Run** `~/.bun/bin/bun test test/jj.test.ts test/merge-tree.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Update `provisionTask` and `provisionFromManifest` to pass their single revision; they
  still type-check unchanged. Add the git ≥ 2.38 line to README "Install".
- [ ] **Step 4: Run** the tests, plus `test/provision.test.ts`, plus the typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `jj commit -m "Add helpers for trial merges"`

### Task 4: Start a task on a merge of several commits

**Files:**
- Modify: `src/tasks/manifest.ts:28,46`, `src/state/contracts.ts:22-26` (`StartSchema`), `src/projects/starts.ts`
  (new resolver), `src/tasks/provision.ts:186-249`, `src/tasks/durable.ts:417-440` (`create` waits for every base)
- Test: `test/provision.test.ts`, `test/create-starts.test.ts`

**Interfaces:**
- Consumes: `workspaceAdd(…, revisions[])` (Task 3).
- Produces:
  - `Start` gains `parents?: string[]`. When set, the line row's `commit` is `parents[0]`, `base` is `parents`, and
    the workspace starts on a new commit with all of them (child mode).
  - `TaskManifest` gains `merge?: {project: string; batch: string[]}` (task ids). A merge task carries it.
  - `mergeStartAt(deps: StartDeps, request: {projectId: string; taskId: string; parents: string[]}): Promise<Start>`.
  - `create()` waits until every base commit is present, not only `commit`.
  - A node whose summary is older than this feature refuses to receive a start with `parents`, with
    `<node> runs an older meddle`.

- [ ] **Step 1: Write failing tests:**
  - `a multi-parent start makes a merge workspace`: the workspace's `@-` parents equal `parents`, the line row's base
    equals `parents`, and `workspaceImmutableHeads` covers every parent.
  - `create waits for all bases`, in create-starts.
- [ ] **Step 2: Run** `~/.bun/bin/bun test test/provision.test.ts test/create-starts.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Use `parents[0]` as `parent` for `contextTextAt`.
- [ ] **Step 4: Run** the tests, plus `test/starts.test.ts test/move.test.ts`, plus the typecheck. Expected: PASS
  (moves still take one parent per project).
- [ ] **Step 5: Commit** `jj commit -m "Start a task on several parents"`

### Task 5: Record the queue on line rows

**Files:**
- Modify: `src/pool/rows.ts` (`LineRow`, `LineRecord`, `acceptLine`, `lineOf`, `putLine`, `writeLineRow`),
  `src/store/db.ts:134` (`ADDED_COLUMNS` `{table:"line_rows", column:"queued_at", type:"TEXT"}`),
  `src/state/contracts.ts:737` (`LineRowSchema` gains `queuedAt: Type.Optional(Nullable(Type.String()))`)
- Test: `test/rows.test.ts`, `test/move.test.ts`

**Interfaces:**
- Produces:
  - `LineRow.queuedAt: string | null`. `writeLineRow` keeps the stored value when the caller passes no `queuedAt`.
  - `queuedAt` is not part of `lineContent`, so an older node's copy, which lacks the field, never wins a tie.
  - `setQueued(db: Database, project: string, task: string, name: string, queuedAt: string|null): LineRow`: writes at
    `seen_seq+1` and keeps everything else.

- [ ] **Step 1: Write failing tests:**
  - `queuedAt replicates through merge`.
  - `writers that omit queuedAt keep it`: `writeLineRows` after `setQueued` keeps it.
  - `an older relay without the field doesn't clear it`: an equal-seq row without the field.
  - `a moved task stays queued` (move.test.ts): after a move, the target's row still has `queuedAt`.
- [ ] **Step 2: Run** `~/.bun/bin/bun test test/rows.test.ts test/move.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, covering every writer listed by `grep -n writeLineRow src`.
- [ ] **Step 4: Run** the tests, plus `test/lines.test.ts test/sync.test.ts test/applier.test.ts`, plus the
  typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `jj commit -m "Record queued tasks on line rows"`

### Task 6: Accept and Unqueue on the task's holder

**Files:**
- Modify: `src/tasks/durable.ts` (`accept`, `unqueue`, hooks in `#prompt` :496, `sendNow` :745, `retry` :868,
  `startQueued` :610, `#archive` :1480, delete), `src/state/contracts.ts` (TaskObject: methods `accept`, `unqueue`;
  state `queue: Nullable({queuedAt, project})`), `src/state/host.ts:881-936`
- Create: `test/queue.test.ts`

**Interfaces:**
- Consumes: `setQueued` (Task 5).
- Produces:
  - `TaskRunner.accept(taskId: string): Promise<void>`. It is idempotent, and refuses with these exact messages:
    - no work to land: `nothing to land: the task's work is already on <branch>`;
    - archived or moving: the existing state messages;
    - prompts waiting: `send or clear the waiting prompts first`;
    - work in several projects: `accept handles one project for now; push to land the rest`;
    - a merge task: `a merge task lands with its train`.
  - `TaskRunner.unqueue(taskId: string, reason: string): Promise<void>`.
  - `TaskRunner.onQueue(cb: (taskId: string, queue: {queuedAt: string; project: string} | null, reason: string | null) => void): () => void`.
  - **Unqueue reasons** (fixed strings):
    - `you unqueued it`;
    - `you sent it a prompt`: a prompt or steer from the user, Send now, or Retry once it runs. Approvals don't count;
    - `archived`.

- [ ] **Step 1: Write failing tests** in `test/queue.test.ts`, using `setupNode`, `createTask` and the `hello.jsonl`
  fixture:
  - `accept queues an idle task with work`: the project line row's `queuedAt` is set.
  - `accept is idempotent`: `queuedAt` doesn't change on a second call.
  - `accept refuses waiting prompts`.
  - `accept refuses two projects` (use `secondProject` from accept.test.ts).
  - `a prompt after accept unqueues`: once the turn has started, `queuedAt` is `null` with reason `you sent it a prompt`.
  - `approving doesn't unqueue` (`approval.jsonl`).
  - `archiving unqueues`.
  - `accepting a running task keeps it queued until its turn ends`.
- [ ] **Step 2: Run** `~/.bun/bin/bun test test/queue.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** User input hooks clear `queuedAt` when the input *runs* (start of a queued prompt, a
  steer accepted into a live user turn, Send now, Retry). Train turns (Task 7) never clear it.
- [ ] **Step 4: Run** the test, plus `test/durable.test.ts test/accept.test.ts test/archive.test.ts`, plus the
  typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `jj commit -m "Accept and unqueue tasks"`

### Task 7: Train turns: `auto` mode, the `meddle` tools, holding user input

**Files:**
- Create: `src/train/tools.ts`, `src/train/prompts.ts`, `test/train-turn.test.ts`
- Modify: `src/engine/options.ts:17,81-125` (`EngineInput.extraMcpServers`, `allowedTools`), `src/tasks/durable.ts`
  (`TurnInput.train`, `#engineInput`, `#prompt` while a train turn is live), `package.json` (add `zod` at the
  bun.lock version, 4.6.7), `src/state/contracts.ts` (PeerObject `trainTurn`), `src/state/host.ts` (serve it),
  `src/engine/session.ts:19` (MeddleEvent `train_turn{kind}`, `train_decline{reason}`, `train_blame{task, reason}`),
  `src/dashboard/ui/thread-model.ts:262` (render them), `src/cli.ts:1130` (ignore them)

**Interfaces:**
- Produces:
  - `type TrainTurnKind = "describe" | "rebase" | "fix" | "merge"`.
  - `type TrainTurnOutcome = {kind: "done"} | {kind: "declined"; reason: string} | {kind: "blamed"; task: string; reason: string} | {kind: "failed"; reason: string}`.
  - `TaskRunner.trainTurn(taskId: string, kind: TrainTurnKind, text: string): Promise<TrainTurnOutcome>`. It runs a
    durable turn with `TurnInput.train = {kind}` and records `train_turn` with the prompt text, shown as meddle's.
  - `trainTools(kind: TrainTurnKind, record: (e: MeddleEvent) => void): McpSdkServerConfigWithInstance`. The server
    is named `meddle`; `blame` is given for `merge` turns, `decline` for the others.
  - Prompts (`src/train/prompts.ts`), built from the Global Constraints copy:
    - `describePrompt(prompt: string, conflicted: string[]): string`;
    - `rebasePrompt(commit: string, report?: string): string` (the fix turn prepends the merge agent's report);
    - `mergePrompt(tasks: string[], change: string, prompt: string): string`;
    - `mergeTitle(titles: string[]): string`.
  - PeerObject `trainTurn({taskId, kind, text}) → TrainTurnOutcome`, so the conductor can drive another node.
- Behaviour:
  - A train turn's options have `permissionMode: "auto"`, `mcpServers.meddle` and
    `allowedTools: ["mcp__meddle__decline", "mcp__meddle__blame"]`.
  - While a train turn is live or pending, user prompts are queued, never steered into it, and Send now answers
    `nothing_waiting`.

- [ ] **Step 1: Write failing tests:**
  - `train turns force auto`: capture `buildOptions` input with a task whose mode is `default`; the train turn's is
    `auto` and the user's next turn is `default`.
  - `the tools record calls`: call the `decline` handler directly; a `train_decline` event is recorded and the outcome
    is `declined`.
  - `prompts hold during a train turn`: prompt while a train turn runs (`MEDDLE_FAKE_STALL`); the prompt is queued,
    not steered, and runs after.
  - `the prompts match the spec copy`: exact strings.
  - `trainTurn runs on another node`: twoPoolNodes, through `PeerObject.trainTurn`.
- [ ] **Step 2: Run** `~/.bun/bin/bun test test/train-turn.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The fake Claude Code can't make MCP calls, so the handlers are tested directly.
- [ ] **Step 4: Run** the test, plus `test/options.test.ts test/durable.test.ts test/thread-model.test.ts test/engine.test.ts`,
  plus the typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `jj commit -m "Run train turns in auto mode"`

### Task 8: Classify commits and pick a batch

**Files:**
- Create: `src/train/batch.ts`, `test/train-batch.test.ts`

**Interfaces:**
- Consumes: `commitsIn`, `trialMerge`, `treeOf` (Task 3); `listLineRows`; `effectiveHead` (accept.ts:50); `gitGraph`.
- Produces:
  - `type Candidate = {taskId: string; title: string; tip: string; base: string[]; workspace: string | null; size: number}`.
    `workspace` is null when the task is on another node.
  - `classify(cfg: NodeConfig, repo: string, B: string, c: Candidate, queued: ReadonlySet<string>, lines: readonly LineRow[]): Promise<Classified>`, where
    `Classified = {leftovers: string[]; toFix: string[]; conflicted: string[]; foreign: Array<{taskId: string; queued: boolean}>; unfixable: Array<{commit: string; reason: string}>}`.
    The spec's rules:
    - commits below `c.base` that aren't on `B` land as they are, but must be pushable;
    - commits of another task's line go in `foreign`;
    - an undescribed or conflicted commit that's immutable in the task's workspace goes in `unfixable`.
  - `pickBatch(cfg, repo, B: string, eligible: readonly Candidate[]): Promise<{batch: Candidate[]; rebase: Candidate[]; later: Candidate[]}>`:
    sorted by `size`, biggest first, adding each candidate whose trial merge with `B` and the batch so far is clean.
  - `mergeParents(g: Graph, B: string, tips: readonly string[]): Promise<string[]>`: the heads of `tips ∪ {B}`, the
    tips in order first, then `B` if it remains.
  - `sizeOf(cfg, repo, B, tip): Promise<number>`: lines changed (`git diff --shortstat`).

- [ ] **Step 1: Write failing tests** in `test/train-batch.test.ts`, with temp colocated repos made the way
  `test/provision.test.ts` makes them:
  - `classify finds leftovers, undescribed and conflicted commits`.
  - `classify lets the starting revision land`.
  - `classify flags another task's work as foreign` (queued or not).
  - `classify reports frozen undescribed commits as unfixable`.
  - `pickBatch takes biggest first`.
  - `pickBatch marks a conflict with B for rebase`.
  - `pickBatch defers a conflict with the batch`.
  - `mergeParents drops B and contained tips` (stacked tasks supersede).
  - `mergeParents keeps a moved-on parent`.
- [ ] **Step 2: Run** `~/.bun/bin/bun test test/train-batch.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the test and the typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `jj commit -m "Pick batches for the train"`

### Task 9: The merge task: create, check, verify, discard

**Files:**
- Create: `src/train/merge.ts`, `test/train-merge.test.ts`

**Interfaces:**
- Consumes: `mergeStartAt` and `TaskManifest.merge` (Task 4), `trainTurn` and the prompts (Task 7), `mergeParents`
  and `trialMerge` (Tasks 8, 3).
- Produces:
  - `type MergeDeps = {createMergeTask(input: {projectId: string; parents: string[]; title: string; batch: string[]}): Promise<{taskId: string; nodeId: string}>; turn(taskId: string, kind: TrainTurnKind, text: string): Promise<TrainTurnOutcome>; head(taskId: string): Promise<CommitInfo>; discard(taskId: string): Promise<void>}`.
    In production, `createMergeTask` places the task like a new one (`chooseNode`, then `createTaskAt`), and
    `discard` archives and then deletes it.
  - `checkBatch(deps: MergeDeps, cfg: NodeConfig, repo: string, input: {projectId: string; B: string; batch: Candidate[]; prompt: string}): Promise<MergeVerdict>`, where
    `MergeVerdict = {kind: "ready"; mergeTask: string; L: string} | {kind: "blamed"; task: string; reason: string} | {kind: "stuck"; reason: string}`.
    It verifies the line head is the merge (same change and parents), has a description and no conflicts, and that
    its tree equals the clean trial merge's tree. It gives at most 3 follow-up turns, then returns `stuck`. A
    `blamed` verdict discards the merge task.

- [ ] **Step 1: Write failing tests**, with fake `MergeDeps` whose `turn` edits a real temp repo:
  - `a described clean merge is ready`.
  - `a changed file is caught`: the fake edits a file; after 3 follow-ups the verdict is `stuck`.
  - `blame discards the merge task`.
  - `a missing description gets a follow-up`: it describes on the 2nd turn and comes back `ready`.
- [ ] **Step 2: Run** `~/.bun/bin/bun test test/train-merge.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the test and the typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `jj commit -m "Check train batches with merge tasks"`

### Task 10: One round of the train

**Files:**
- Create: `src/train/round.ts`, `test/train-round.test.ts`

**Interfaces:**
- Consumes: Tasks 8 and 9; `advanceBranch` (Task 1); `trainTurn` (Task 7).
- Produces:
  - `type RoundDeps = MergeDeps & {branch(): Promise<string>; candidates(): Promise<Candidate[]>; abandonLeftovers(taskId: string, commits: string[]): Promise<void>; advance(old: string, next: string): Promise<void>; leave(taskId: string, reason: string): Promise<void>; sitOut(taskId: string, reason: string): Promise<void>; holdBack(taskId: string, notice: string): Promise<void>; checkpoint(step: RoundStep): Promise<void>}`.
  - `type RoundStep = {step: "describing" | "picking" | "checking" | "landing" | "rebasing"; batch: string[]; mergeTask: string | null}`.
  - `runRound(deps: RoundDeps, cfg: NodeConfig, repo: string, prompt: string, resume?: RoundStep): Promise<RoundResult>`, where
    `RoundResult = {landed: string | null; again: boolean; paused: string | null}`.
    The spec's steps 1–5:
    1. describe turns (and leftovers);
    2. pick;
    3. check (no merge task for a single head);
    4. land through `advance`: when the branch moved, `again: true`;
    5. rebase and fix turns.
  - Outcomes:
    - **`declined`:** `leave`, with the reason.
    - **`failed`, or a turn that didn't do its job:** `sitOut`, with the reason.
    - **A rejected offline call:** `sitOut` with `waiting for <node>`.
    - **A foreign task that isn't queued:** `holdBack`, with the notice from Global Constraints.
    - **Unfixable commits:** `leave`, naming the commit and why.
    - **A task marked to rebase whose own commits are immutable in its workspace:** `leave` with
      `another task builds on this work, so it can't rebase`.
    - **A `blamed` verdict:** the culprit gets a fix turn, and the round continues with the rest of the batch and a
      fresh merge task.

- [ ] **Step 1: Write failing tests** with fake deps over temp repos:
  - `one task on top of main fast-forwards without a merge task`.
  - `two clean tasks land as one checked merge`.
  - `a conflicting task gets a rebase turn after the batch lands`.
  - `decline takes a task off`.
  - `a failed describe sits the task out`.
  - `an offline node sits out and the rest lands` (Review Focus 1).
  - `a foreign unqueued task holds back with the notice`.
  - `a stacked pair lands once`.
  - `blame drops the culprit and lands the rest`.
  - `a frozen task that needs a rebase leaves`.
  - `a task archived or unqueued mid-round leaves and the round restarts` (Review Focus 5).
- [ ] **Step 2: Run** `~/.bun/bin/bun test test/train-round.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the test and the typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `jj commit -m "Run a round of the train"`

### Task 11: The conductor: durable rounds, triggers, pause and resume

**Files:**
- Create: `src/train/train.ts`, `test/train.test.ts`
- Modify: `src/store/db.ts` (table `trains(project TEXT PRIMARY KEY, paused TEXT, sitting TEXT NOT NULL DEFAULT '{}', held TEXT NOT NULL DEFAULT '{}')`),
  `src/tasks/harness.ts:24` (register `MeddleTrain`), `src/tasks/durable.ts:380` (`busyTasks` counts `meddle.train`),
  `src/state/host.ts` (start the conductor for projects homed here)

**Interfaces:**
- Consumes: `runRound` (Task 10).
- Produces:
  - `MeddleTrain = defineTask<{projectId: string}, RoundStep | {step: "idle"}, null, MeddleHooks>`, named `meddle.train`.
  - `startTrains(deps): () => void`. For each project with `home === selfId`, it starts a round when one of these
    happens:
    - `lineChanges` on a row's `queuedAt`;
    - a queued task's turn ends;
    - `branchChanges`;
    - Resume or Retry.
    
    At most one round runs per project, and it does nothing while paused. With the home offline there is nothing to
    do: other nodes run no trains.
  - `pauseTrain(db, projectId, reason: string | null)` and `trainState(db, projectId): TrainState`, where
    `TrainState = {paused: string | null; round: RoundStep | null; queued: Array<{taskId: string; state: "turn running" | "describing" | "rebasing onto main" | "in the batch" | "sitting out" | "waiting for <node>"; reason: string | null}>}`.
  - `retryTask(projectId, taskId)`: clears its sitting-out entry.
  - Sitting-out and held-back entries persist in `trains`. A node coming back online clears its `waiting for <node>`
    entries.

- [ ] **Step 1: Write failing tests**, using `twoPoolNodes` and line rows written directly:
  - `a queued task triggers a round on the home only`.
  - `pause holds landing and survives a restart`: restart the node while paused; nothing lands until `resume`.
  - `a restart mid-round resumes without a second merge task` (Review Focus 4).
  - `a push during checking restarts the round against the new main` (Review Focus 2): push through a checkout with
    `pushMain` from checkouts.test.ts while the fake merge turn stalls.
  - `retry brings a sitting-out task back`.
- [ ] **Step 2: Run** `~/.bun/bin/bun test test/train.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Release the train's hold on the batch's tasks *before* `advance`, so `#acceptOnce`
  archives them, as in the spec's step 4.
- [ ] **Step 4: Run** the test, plus `test/update-holds.test.ts test/accept.test.ts`, plus the typecheck. Expected:
  PASS.
- [ ] **Step 5: Commit** `jj commit -m "Conduct trains on the home node"`

### Task 12: Notices and the API for the train

**Files:**
- Modify: `src/state/contracts.ts:96` (notification kind `train`, with `action?: "accept" | "retry"`), ProjectObject
  (state `train: TrainState`; methods `pause({reason?})`, `resume({})`, `retry({taskId})`), `src/state/host.ts:343-412`
  (notify on leave, sit out and hold back), `src/dashboard/ui/main.tsx:147-178` (add `train` to `TOASTED`; buttons
  Open task, plus Accept again or Retry by `action`)
- Test: `test/state.test.ts`

**Interfaces:**
- Consumes: `onQueue` (Task 6); `trainState`, `pauseTrain`, `retryTask` (Task 11).
- Produces: notices with these texts:
  - `<title> left meddle's train: <reason>` (action `accept`);
  - `<title> is sitting out: <reason>` (action `retry`);
  - `<task> includes work from <other task>, which isn't queued` (no action).

- [ ] **Step 1: Write failing tests:**
  - `leaving the train raises a train notice`.
  - `the project serves the train state and pauses`.
- [ ] **Step 2: Run** `~/.bun/bin/bun test test/state.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the test, plus `test/token-fallback.test.ts`, plus the typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `jj commit -m "Notify when tasks leave the train"`

### Task 13: CLI: `task accept`, `task unqueue`, `train`

**Files:**
- Modify: `src/cli.ts` (USAGE :61-86, routes :1591-1623, `readOnly` :1523), `src/help.ts:274-367`
- Test: `test/help.test.ts`, `test/cli.test.ts` (or the file that covers `task archive`)

**Interfaces:**
- Consumes: TaskObject `accept`/`unqueue`, ProjectObject `train`/`pause`/`resume` (on the home, through
  `connect(`/ws/node/${home}`)`).
- Produces:
  - `meddle task accept <task-id>...`, which prints `queued <id> on <project>'s train`;
  - `meddle task unqueue <task-id>...`;
  - `meddle train [<project>] [--follow]`: the queue with each task's state, then the round's step, batch and merge
    task;
  - `meddle train pause|resume [<project>]`.
  
  Plain `train` is read-only during an update hold. When the task's node serves no `accept` (an older meddle),
  `task accept` fails with `<node> runs an older meddle`. The dashboard hides Accept for such a task.

- [ ] **Step 1: Write failing tests:**
  - help entries exist and `usageFor(["task","accept"])` prints its forms;
  - `train` output formatting, as a pure function `trainText(state: TrainState, titles: Map<string,string>): string`.
- [ ] **Step 2: Run** `~/.bun/bin/bun test test/help.test.ts test/cli.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same tests and the typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `jj commit -m "Accept tasks and watch trains from the CLI"`

### Task 14: Dashboard: Accept on the task, the train page

**Files:**
- Create: `src/dashboard/ui/Train.tsx`, `src/dashboard/ui/train-model.ts`
- Modify:
  - `src/dashboard/ui/Task.tsx:171-238`: Accept after Archive (shown while idle or running, not when queued, not on
    merge tasks), Unqueue when queued, and `🚂 queued` beside the state like `partly accepted`.
  - `src/dashboard/ui/Sidebar.tsx:46-54,108-167`: a `🚂 Train` entry per project showing the count of its queued
    tasks; a 🚂 chip on queued rows; Accept or Unqueue first in the ⋯ menu.
  - `src/dashboard/ui/sidebar-model.ts:5-22` (`TaskEntry.queued: boolean`, `merge: boolean`) and `sources.tsx:96-107`.
  - `src/dashboard/ui/routes.ts:6-59`: `View` gains `{name: "train"; projectId: string; task?: string}`.
  - `main.tsx:115-127`.
- Test: `test/ui.test.ts`

**Interfaces:**
- Consumes: TaskObject `queue`, `accept`, `unqueue`; ProjectObject `train`, `pause`, `resume`, `retry` (read from the
  project's home, as `memorySource` does).
- Produces: `trainColumns(state: TrainState, tasks: ReadonlyMap<string, {title: string}>): {queued: Array<{taskId: string; title: string; state: string}>; round: {steps: Array<{name: string; done: boolean; now: boolean}>; mergeTask: string | null; batch: Array<{taskId: string; title: string}>} | null; paused: string | null}`.

- [ ] **Step 1: Write failing tests** in `test/ui.test.ts`:
  - the `train` route round-trips through `viewOf`/`hashOf`;
  - `trainColumns` puts the batch under the merge task and marks the current step;
  - `groupTasks` counts queued tasks per project;
  - the bundle builds.
- [ ] **Step 2: Run** `~/.bun/bin/bun test test/ui.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The layout follows the spec's "The dashboard" and the settled mockups:
  - two columns, Queued and This round;
  - the merge task as a card, with the batch under it;
  - Pause/Resume in the head;
  - no history, no position numbers, no banners;
  - the `task` parameter highlights its row.
- [ ] **Step 4: Run** the test and the typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `jj commit -m "Show the train in the dashboard"`

### Task 15: README

**Files:**
- Modify: `README.md`:
  - :25 (git ≥ 2.38, if Task 3 didn't add it);
  - :347 (`describe.prompt` row);
  - :431-436 (task commands);
  - :770-789 ("Taking a task's work": the train, Accept, and pushes still accepting);
  - :1142-1154 (sidebar, notices, head actions);
  - :1171-1175 (project page, train page);
  - :1197 (settings list).

- [ ] **Step 1: Write the sections**, from the spec's "What it is", "How the train runs" and "The dashboard", in the
  README's register.
- [ ] **Step 2: Check** `grep -n "there is no command for it" README.md`: no match left.
- [ ] **Step 3: Commit** `jj commit -m "Document the merge train"`
