# Project page: Graph, Memory and Tasks side by side

## Why

The project page is one column, at most 980px wide: Home, Graph, Branches, Memory (History folded below it), Tasks.
A project with a long history (faff) lists up to 200 commits (2000 after Older) before its memory and tasks, and one
with a lot of memories too (swarm) pushes Tasks further still. On a wide screen the space beside the column goes unused.

## Goals

- Memory and tasks are in view on opening a project, whatever the size of its graph.
- The page uses the width it has.

Non-goals: changing what the graph, memory or tasks show, or how each works (opening, editing, History, Older).

## Approaches

- **Columns, tabs when narrow** (picked). Graph, Memory and Tasks side by side, each scrolling on its own; a narrow
  pane shows one at a time behind tabs.
- **Tabs only.** Mocked up first; dropped because the graph is a lot of page for little reading, and it hides memory
  and tasks behind a click even where there is room for all three.
- **One wider column with the graph in a fixed-height box.** A long memory list still pushes Tasks down.

## Design

- The pane head keeps the name, the id, and gains the home (`· home <hostname>`). `New task` leaves it.
- Below it, three columns, in this order: **Graph**, **Memory**, **Tasks**. Each has a small head (title, count where it
  has one) and scrolls on its own. Memory is the widest (about 1 : 1.5 : 0.8), since an opened entry is what needs room
  to read. The 980px cap goes.
  - Graph: a conflicted or fetching branch (today's Branches list, with its how-to-fix text) at the top of the column,
    then the graph; a holder whose context failed to load shows there too.
  - Memory: the head carries the count, `offline` and `New`; the list and History below as today.
  - Tasks: the head carries the count and `New task`.
- When the pane is narrow (a container query on the pane, as `.bar` does, around 1100px), the columns become tabs —
  Graph · Memory · Tasks, styled as the task's Thread / Changes switch — showing one column at a time. The tab is in the
  hash (`#/project/<id>`, `#/project/<id>/memory`, `#/project/<id>/tasks`), Graph by default; on a wide pane the hash's
  tab is ignored. The Graph tab carries a warning mark while a branch is conflicted.

## Left to the builder

The exact breakpoint and column ratios, and the column heads' styling, judged in the running dashboard.
