# The task bar, redesigned

Mockups: https://claude.ai/artifact/Feh8R1M6bdAEoSZN6HGmqM (dark; "Today" against the proposed boards).

## Why

The bottom bar of a task page (`BottomBar`, `src/dashboard/ui/Task.tsx`) shows the task's bookmark name
(`meddle 84f02d7a +1`), which is a dead end: to review or accept the work you find its revision in `jj log` first.
The node you can move the task to sits among the read-only facts on the left, apart from the model and effort, the
other thing you change. With two projects only the first one's line showed.

## What changes

- **Each project with its revision.** Left: one entry per project of the task, in manifest order:
  `◉ <name>` then that project's line as its jj change id (8 chars, monospace). Clicking the id copies the full change
  id to the clipboard. A conflicted line shows `conflicted` in the warn colour instead of an id, not clickable; a
  project with no line yet shows its name alone. The project's own line is the bookmark
  `meddle/task/<task id>/<project name>`; side lines (`.before-<n>` and the like) are no longer shown in the bar.
- **No project:** `◉ no project`, as today.
- **Collapsed:** with three or more projects, and at phone width, the projects collapse to `◉ <first> +N ▾`, which
  opens a popover listing every project with its revision (copy as above).
- **Tokens** follow, after a thin divider; unchanged, hidden at phone width as today.
- **Right:** the node pill (`⌂ host ▾`, Move menu) moves next to the model and effort pill, before it. Archived:
  `⌂ archived on <host>` text in its place.
- The tooltip of a project entry names its workspace (as the project tooltip does today).

## Non-goals

- Adding a project to a running task (the "+" in the mockups): no backend exists; its own design and work, next.
- Reviewing or accepting from the bar.

## Approaches

One sensible way: the bar is one component and its data (`task.manifest`, `task.bookmarks`) already carries every
project's lines. A pure function maps manifest and bookmarks to `{ name, workspace, changeId: string | null,
conflicted }` per project, tested in `test/ui.test.ts`; `BottomBar` renders it.
