# Project Page Columns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Project page shows Graph, Memory and Tasks as three columns that scroll on their own, and as tabs when the pane is narrow.

**Architecture:** The project route gains an optional `tab` (`memory` | `tasks`; Graph when absent). `ProjectPage` renders a
`.project` wrapper (a CSS size container) holding the pane head and three `.proj-col` sections; a container query on
`.project` below 1100px shows the tab switch in the head and only the column whose tab is in the hash. `Memory` renders
its column's head and body itself, so its count, `offline` and `New` sit in the column head.

**Tech Stack:** TypeScript, Preact, Bun (`bun test`, `tsc`), CSS in `src/dashboard/ui/index.html`.

**Spec:** `docs/superpowers/specs/2026-11-18-project-page-columns-design.md`

**Mockup:** `.superpowers/brainstorm/736674-1794960091/content/project-columns-v2.html` (classes `.cols`, `.col`,
`.col-head`, `.col-body`, `.branches`; the "Memory wider" widths).

## Global Constraints

- Column order Graph, Memory, Tasks; widths about `1fr 1.5fr 0.8fr`; the 980px cap does not apply on this page.
- Pane head: folder mark, name, id, `· home <hostname>`. No `New task` there.
- Tasks column head: `Tasks`, its count, `New task` (a link to `hashOf({ name: "new", projectId: id })`) at the right.
- Memory column head: `Memory`, its count, `offline` flag when read-only, `New` at the right.
- Narrow: pane narrower than 1100px, by a container query on the page's own wrapper (as `.bar` does at
  `index.html:416-427`), never a media query, so hiding the sidebar can bring the columns back.
- Tabs styled as `.task-tabs` (`Task.tsx:185-190`), labels `Graph`, `Memory <n>`, `Tasks <n>`; the Graph tab carries a
  `--warn` mark while any branch is conflicted.
- Hashes: `#/project/<id>` (Graph), `#/project/<id>/memory`, `#/project/<id>/tasks`.
- jj, not git: `jj commit -m "<msg>" <paths>`. No attribution trailers. Run only the tests each step names, plus
  `~/.bun/bin/bun run typecheck`; never the full suite.

## Review Focus

- A wide pane opened at `#/project/<id>/memory` shows all three columns, not only Memory. → Task 2, check 2.
- Hiding the sidebar on a window just under 1100px + 290px wide switches tabs back to columns. → Task 2, check 3.
- An entry's `History` button scrolls the Memory column to History, not the page or another column. → Task 2, check 4.
- Switching tabs keeps what `Older` read in the graph (the page is not remounted: `key={view.id}` stays). → Task 2, check 5.
- A project without a memory repo, or with no online holder: the columns stay in place, each saying why it is empty, and
  Tasks still lists the project's tasks. → Task 2, check 6.

---

### Task 1: A project's tab in its hash

**Files:**
- Modify: `src/dashboard/ui/routes.ts`
- Test: `test/ui.test.ts:22-43`

**Interfaces:**
- Produces: `View` member `{ name: "project"; id: string; tab?: ProjectTab }` and `export type ProjectTab = "memory" | "tasks"`
  in `routes.ts`. `hashOf` appends `/memory` or `/tasks`; `viewOf` reads them back, leaving `tab` absent for Graph.

- [ ] **Step 1: Write the failing test.** In `viewOf and hashOf round-trip every route`, add to `views`:
  `{ name: "project", id: "p1", tab: "memory" }`, `{ name: "project", id: "p1", tab: "tasks" }`; and after the loop:

```ts
expect(hashOf({ name: "project", id: "p/1", tab: "memory" })).toBe("#/project/p%2F1/memory");
expect(viewOf("#/project/p1")).not.toHaveProperty("tab");
expect(viewOf("#/project/p1/graph")).toEqual({ name: "home" });
expect(viewOf("#/project/p1/other")).toEqual({ name: "home" });
```

- [ ] **Step 2: Run it to see it fail.** `~/.bun/bin/bun test test/ui.test.ts` — FAIL on the round-trip.
- [ ] **Step 3: Implement** the `ProjectTab` type, the `tab?` field, and both directions in `routes.ts`; update the
  `viewOf` doc comment's hash list (`#/project/<id>[/memory|/tasks]`).
- [ ] **Step 4: Run it to see it pass.** `~/.bun/bin/bun test test/ui.test.ts` and `~/.bun/bin/bun run typecheck` — PASS.
- [ ] **Step 5: Commit.** `jj commit -m "Name a project page's tab in its hash" src/dashboard/ui/routes.ts test/ui.test.ts`

### Task 2: Graph, Memory and Tasks side by side

**Files:**
- Modify: `src/dashboard/ui/main.tsx:118` (pass `tab={view.tab}` to `ProjectPage`)
- Modify: `src/dashboard/ui/Projects.tsx:28-142` (`ProjectPage`)
- Modify: `src/dashboard/ui/Memory.tsx` (`MemoryOn`, `MemoryLoaded`: render the column's head and body)
- Modify: `src/dashboard/ui/index.html` (styles after `/* ─── a project's memory ─── */`)
- Test: `test/ui.test.ts` (`the dashboard bundle builds`), and the checks below in the running dashboard

**Interfaces:**
- Consumes: `ProjectTab`, and `hashOf({ name: "project", id, tab })` from Task 1.
- Produces: `ProjectPage({ hosts, pool, index, id, tab }: { …; tab: ProjectTab | undefined })`.
  `Memory` keeps its props; it now renders `<div class="col-head">…</div><div class="col-body">…</div>` in every state
  (loading, the object's error, no memory repo — body `No memory for this project.` — and loaded), for `ProjectPage` to
  wrap in its `<section class="proj-col">`.

- [ ] **Step 1: Pass the tab.** `main.tsx:118` passes `tab={view.tab}`; `key={view.id}` stays as it is.
- [ ] **Step 2: Restructure `ProjectPage`.**
  - Outer `<div class="project">` (container) holding `PaneHead` and `<div class="proj-cols">`.
  - Head: folder, name, id, `<span class="muted">· home <hostname></span>` (title the node id); then `bar-gap` and
    `<nav class="task-tabs proj-tabs">` with the three links (`aria-current="page"` on the shown one). The `<dl>` Home
    and the head's `New task` go.
  - Each column a `<section class={`proj-col${shown === key ? " on" : ""}`}>`, `shown` being `tab ?? "graph"`.
  - Graph column: head `Graph`; body: the not-loaded message when `project === undefined`, else Branches (as today, with
    its how-to-fix text), the context-failed lines, then `Graph`. Drop the `<h3>Graph</h3>` and `<h3>Branches</h3>`
    headings (a small `Branches` label above the list is fine).
  - Memory column: `<Memory …/>` when `memory !== null`, else a head `Memory` and the not-loaded message.
  - Tasks column: head `Tasks`, count, `bar-gap`, `New task`; body the task list as today.
  - The Graph tab's warning: `branches.some((b) => b.conflicted)`.
- [ ] **Step 3: Move Memory's head into the column head.** `MemoryLoaded`'s `.sec` head becomes
  `<div class="col-head">` with the same children; the error, editor, list and History go in `<div class="col-body">`.
  `MemoryOn`'s error and loading states, and the no-repo case (today `return null`), render the head and a body as in
  the Interfaces block. `showHistory`'s `scrollIntoView` stays; it scrolls the column.
- [ ] **Step 4: Styles.** In `index.html`:
  - `.project { display: flex; flex-direction: column; height: 100%; min-height: 0; container-type: inline-size; }`
  - `.proj-cols { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.5fr) minmax(0, 0.8fr); }`
  - `.proj-col` a flex column with a right border (none on the last); `.col-head` as the mockup's (a row: title, count,
    gap, button; bottom border; `flex: none`); `.col-body { flex: 1; overflow-y: auto; }` with the page's padding.
  - `.proj-tabs { display: none; }`
  - `@container (max-width: 1100px)`: `.proj-tabs { display: flex; }`, `.proj-cols { grid-template-columns: minmax(0, 1fr); }`,
    `.proj-col:not(.on) { display: none; }`, `.proj-col { border-right: none; }`.
  - `.sec` margins no longer apply to Memory's head; keep `.sec` for History.
- [ ] **Step 5: Build and typecheck.** `~/.bun/bin/bun test test/ui.test.ts` and `~/.bun/bin/bun run typecheck` — PASS.
- [ ] **Step 6: Check it in the running dashboard** (the `run` skill), on a project with a long graph and many memories:
  1. A wide pane shows Graph, Memory, Tasks side by side, each scrolling on its own; New task opens a new task in the
     project.
  2. Opened at `#/project/<id>/memory` on a wide pane, all three columns show.
  3. Narrowed below 1100px, the tabs show and one column at a time; Graph by default; hiding the sidebar brings the
     columns back.
  4. An opened entry's `History` scrolls the Memory column to History.
  5. Read `Older` in the graph, switch to Memory and back: the older rows are still there.
  6. A project whose holders are offline: each column says why it is empty; Tasks still lists its tasks.
- [ ] **Step 7: Commit.** `jj commit -m "Show a project's graph, memory and tasks side by side" src/dashboard/ui/main.tsx src/dashboard/ui/Projects.tsx src/dashboard/ui/Memory.tsx src/dashboard/ui/index.html`
