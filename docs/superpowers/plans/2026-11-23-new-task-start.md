# New task start picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the dashboard's New task pick where each project starts (default branch, another branch, a task's line,
or any revision), with hints searched from the project's loaded graph.

**Architecture:** A new `ProjectObject.resolve` on the node checks a typed revision with `startAt`'s own resolution. A
pure `start-model.ts` turns a project's graph into ranked hints. `NewTask.tsx` shows each project's start on its pill
and a popover to change it, sending `rev` in `createTask`, which the node already takes.

**Tech Stack:** Bun, TypeScript, Preact, chord remote objects, jj 0.45.

**Spec:** `docs/superpowers/specs/2026-11-23-new-task-start-design.md`

## Global Constraints

- Child mode only; `mode` is never sent from the dashboard.
- `rev` sent: none for the default branch, the branch name for another branch, the full commit id otherwise.
- Refusals are `startAt`'s own text: `no revision <rev> in <project>`, `<rev> names <n> revisions in <project>`.
- No heading in the popover; field placeholder `branch, task, or revision`; at most 8 hint rows.
- Dashboard copy is terse: no explanatory sentences.

## Review Focus

- A branch and the default branch on the same commit: the row takes the default (sends no `rev`).
- A query of whitespace only: treated as empty (no node call).
- The node answering an older query after a newer one: only the newest answer shows.
- A project removed from the New task while its start is picked: its start is dropped, not sent.
- A node older than this change (no `resolve`): its failure shows as the error, hints still work.

---

### Task 1: `ProjectObject.resolve`

**Files:**
- Modify: `src/projects/graph.ts` (row parsing shared; new `graphCommit`)
- Modify: `src/projects/starts.ts` (export `resolveRev`)
- Modify: `src/state/contracts.ts` (ProjectObject method), `src/state/host.ts` (serve it)
- Test: `test/graph.test.ts`, `test/state.test.ts`

**Interfaces:**
- Produces: `graphCommit(cfg, replica, commit: string, probe: GraphProbe | null): Promise<GraphCommit>` and
  `ProjectObject.resolve({ rev: string }): GraphCommit`.

- [ ] Test `graphCommit reads one commit with the probe's bookmarks on it`: for `c3`, `commit === c3`, `description ===
  "c3"`, `bookmarks` contains `{ kind: "branch", name: "main" }`, parents `[c2]`.
- [ ] In `state.test.ts`'s graph test: `view.resolve({ rev: "main" })` resolves to the graph's `main` commit;
  `view.resolve({ rev: "nope" })` rejects with `/no revision nope in/`.
- [ ] Implement; run `~/.bun/bin/bun test test/graph.test.ts test/state.test.ts` and typecheck; commit.

### Task 2: `start-model.ts` hints

**Files:**
- Create: `src/dashboard/ui/start-model.ts`
- Modify: `src/dashboard/ui/pool-model.ts` (`ListedProject.defaultBranch: string | null`, from the home's listing)
- Test: `test/start-model.test.ts`, `test/ui.test.ts` (projectChoices expectations)

**Interfaces:**
- Produces:
  - `type StartHint = { commit: GraphCommit; rev: string | null; isDefault: boolean }`
  - `startHints(graph: readonly GraphCommit[], query: string, defaultBranch: string | null, title: (task: string) => string | null, max = 8): StartHint[]`
  - `hintOf(commit: GraphCommit, defaultBranch: string | null): StartHint` (also for a node-resolved commit)
  - `marked(text: string, query: string, prefix: boolean): Array<{ text: string; hit: boolean }>`

Rules: one hint per commit. Empty (trimmed) query: commits with a branch or a task line only. Else a commit matches when
a branch name or its task's title contains the query, its description contains it, or its change or commit id starts
with it (case-insensitive). Order: the default branch's commit, then commits with branches (by first branch name),
then with task lines, then the rest, newest first within each. `rev`: null on the default branch's commit, else its
first branch by name, else the commit id.

- [ ] Tests: empty query order; `place` matches branch name, title and description; `qrs`-style id prefix matches
  change and commit ids but not mid-id; default+branch on one commit is the default; max 8; `marked` splits.
- [ ] Implement; run the two test files; commit.

### Task 3: The pill, the popover, the graph marker

**Files:**
- Modify: `src/dashboard/ui/NewTask.tsx`, `src/dashboard/ui/Graph.tsx`, `src/dashboard/ui/index.html` (CSS)

- [ ] NewTask: `starts: Record<string, { rev: string; label: string; title: string }>`; pill `◉ name <button
  class="start">· label</button> ×`, muted unless picked; removing a project drops its start; `createTask` sends
  `{ id, rev }` for picked ones.
- [ ] `StartPopover`: loads `ProjectObject` from the home if online and listing it, else the first online lister;
  input + hints (`startHints` on its `graph`); ↑↓/Enter/Escape; when no hints and query non-blank, `resolve` after
  300 ms, newest answer only; refusal in red.
- [ ] Graph: the default branch's pill gets class `default`, title `default branch`.
- [ ] Typecheck, `test/ui.test.ts`, check in a browser against a running node; commit.
