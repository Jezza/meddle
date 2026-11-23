# Where a new task starts, picked in the dashboard

## Why

The dashboard's New task always starts each project on its default branch (`NewTask.tsx` sends only `{ id }`), and
nothing on screen says which branch that is: the project page marks the default branch only in its list of conflicted
or fetching branches. The default is right most of the time; sometimes a task should start on another branch, or on a
revision whose name or id you already know. The CLI can (`task new --project X --rev R`); the dashboard can't.

## What changes

Picked from mockups (`new-task-start-v3.html`, frames 1–7).

**The project pill says where it starts.** `◉ meddle · main ×`: after the name, the start, muted while it is the
default branch (from the pool's project listing, `NodeProject.defaultBranch`). A start other than the default reads in
the normal colour: a branch by name, a revision by its short change id (8), its description in the tooltip. Clicking
the start opens the start popover. Picking the default branch again goes back to the default: no second ×.

**The start popover** (above the pill, as the other composer menus): a field (`branch, task, or revision`, focused)
and hints under it; no heading. Each hint is one row: a branch or task-line pill as the graph draws them, the short
change id, the description; the default branch's row says `default` at its right.

- Empty field: the default branch, the other branches by name, then live tasks' lines, newest first.
- Typing filters the project's loaded graph (the commits the project page reads, up to 200) in the browser, case
  insensitive: branch names and task titles containing the text, descriptions containing it, and change or commit ids
  starting with it. The matched part is highlighted. One row per commit, its branches and lines on it.
- ↑↓ move the highlight (the first row to start), Enter or a click takes it, Escape closes.
- When nothing loaded matches and the field isn't empty, the node resolves the text as a jj revset (debounced):
  one revision shows as a hint row with its date at the right; otherwise its refusal (`no revision kzx in meddle`,
  `q names 14 revisions in meddle`) shows in red in place of hints, and Enter does nothing.

What a pick sends as the project's `rev` in `createTask`: the default branch, none (as today); another branch, its
name; any other hint, its full commit id, so the task starts on exactly the revision shown. Always child mode.

**A new `ProjectObject.resolve({ rev })`** on the node the hints come from: the one revision `rev` names in that
node's service repo, as a `GraphCommit`, refused with `startAt`'s own messages (shares `resolveRev`).

**The graph marks the default branch** (`Graph.tsx`'s `Pill`): its pill in the accent tint, titled `default branch`.

## Approaches

- A: the popover with only the node's check of what you typed. B: the same with a live check while typing. C: start
  from a commit in the project graph ("New task here"). C was dropped: you usually know the name or id already, and
  the graph is a detour. B was picked, then grew into hints searching the loaded graph after "does it actually
  search?"; the node's check stayed only for what isn't loaded.
- Edit-in-place (`--edit`) stays CLI-only: its refusals and risks to a checkout don't belong in a one-click picker.

## Calls left to the builder (marked as mine)

- Where hints come from: the project's home if it is online, else the first online node holding it, through its
  `ProjectObject` (its `graph`, `branches` and the new `resolve`). One holder's graph has every branch and line.
- At most 8 hint rows; branches before lines before other commits, then newest first.
- A project with no default branch: the pill's start reads `· no default` in the warning colour, and Start gives the
  node's refusal as today until a start is picked.
- The hint matching lives in a pure model file (`start-model.ts`) with its own tests.

## Non-goals

- Picking a start from the project graph; edit mode; a merge of several revisions.
- Searching beyond the loaded graph other than resolving exactly what was typed.
