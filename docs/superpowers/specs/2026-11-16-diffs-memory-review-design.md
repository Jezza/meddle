# Diffs, memory, review and the project graph

Mockups: https://claude.ai/artifact/Q17UXbbUuB5QMbm5i6aEjQ (dark; boards 1–3, a "today" board for the thread diff).

## Why

Agents in meddle write project memory and jj changes, and the dashboard shows neither. You can't see what a project's
agents have remembered, fix a bad entry, or review a task's work without leaving the dashboard for `jj log`, `jj diff`
and the memory folder. The Project page's Copies table lists each node's bookmarks as text, which doesn't show where
they are relative to each other.

## What

Four pieces, built in this order. Each is its own plan; each later piece reuses the diff view the first one makes.

1. **Diffs in the thread.** The Edit/Write diff that already exists (`DiffView` in `Task.tsx`, `editDiff` in
   `thread-model.ts`) gains old and new line-number columns, and its `@@` hunk rows become bars that open the hidden
   lines: `↑ 413 lines` above the first hunk, `↕ 82 lines` between hunks, `↓ 249 lines` below the last. A click opens
   the 20 lines nearest the change; a second click opens the rest. The lines come from the call's own result
   (`originalFile`, which Claude Code's Edit and Write results carry; the thread model keeps only `structuredPatch`
   today, `thread-model.ts:123`, and has to carry `originalFile` through too), so no request is made. Without
   `originalFile` (a new file, a file too large) the bars are plain text, not buttons, until piece 3 (below). The view moves to its own
   module so 2–4 use it.
2. **Memory** on the Project page: entries, edit, history.
3. **Changes**: a task's jj changes, reviewed in the task pane.
4. **Graph** on the Project page, in place of Copies and Branches.

## Goals, non-goals, anti-goals

- Goals: read and edit a project's memory in the dashboard; see who changed it; review a task's changes as diffs; see
  every node's branches and tasks as one graph.
- Non-goals: accepting, squashing or abandoning changes from the dashboard; comments on lines; side-by-side diffs;
  syntax highlighting in diffs; memory of tasks without a project; editing `MEMORY.md` for the user when an entry is
  added or deleted (it is edited by hand like any entry).
- Anti-goals: a dashboard edit that loses an agent's write, or an agent's write that loses a dashboard edit. Helper
  sentences in the UI: labels are one word where one word will do (see Copy).

## The shared diff view

One component (`src/dashboard/ui/diff.tsx`) and one model (`src/dashboard/ui/diff-model.ts`, pure, tested in
`test/ui.test.ts` or its own file):

- A **file patch**: path, status (modified, added, deleted, renamed), hunks (`oldStart`, `oldLines`, `newStart`,
  `newLines`, lines prefixed `+`, `-`, space), counts added/removed. Built either from Claude Code's
  `structuredPatch` (the thread) or by parsing `jj diff --git` output (memory, changes) — one parser, tested on real jj
  output including new, deleted, renamed and binary files and "\ No newline at end of file".
- **Rows**: what the view draws: numbered lines (old, new, kind) and gaps (where, how many hidden). A gap knows its old
  line range; opening it needs the old file's lines in that range, which the caller supplies: the thread from
  `originalFile`, the others by asking the node (`file` calls below). New line numbers of context are old + the
  running offset.
- **Head** (memory and changes only; the thread's row already names the file): path, `+n −n`, and `Expand`, which
  opens every gap at once: the whole file at that revision, its changed lines still marked.
- Styling: the existing `.diff` / `.dl` rules and `--add`, `--add-bg`, `--del-bg` tokens, widened to two number
  columns; gap bars use the accent colour.

## Memory (piece 2)

Each project's memory is the jj repo `<data dir>/memory/<project id>`, shared under the `memory` bookmark, home on the
project's home node (`src/memory.ts`, `src/projects/memory-sync.ts`).

**Where the dashboard asks.** The project's home: the dashboard opens that node's `ProjectObject` (it already holds a
link to every online node). When the home is offline, Memory shows the entries and history of any online holder,
read-only, with `offline` beside the heading and no Edit/Delete/New.

**ProjectObject gains:**

- state `memoryHead`: the change id the `memory` bookmark points at (null without a memory repo), re-read after every
  memory sync, every dashboard write on this node, and every peer push into the memory repo (`src/git/serve.ts`,
  where it already runs `gitImport`): on the home that is how `memory` mostly moves. The dashboard re-fetches what it
  shows when it changes.
- `memoryEntries()`: every file in the memory repo's working copy on this node, i.e. what agents here read and write,
  uncommitted writes of a turn in progress included (path, size, a hash of its content, and for a `.md` file with
  frontmatter its `name`, `description`, `metadata.type`), plus for each the change that last touched it (when, which
  task or "dashboard"). `MEMORY.md` is listed first as `Index`.
- `memoryFile({ path, change? })`: a file's text in the working copy, or at a change.
- `memoryHistory({ before?, limit })`: changes to `memory`, newest first: change id, time, node, task (id and title, or
  null for a dashboard edit or the import), files with `+n −n`.
- `memoryDiff({ change })`: that change's `jj diff --git` against its parent.
- `writeMemory({ path, text, base })` and `deleteMemory({ path, base })`, home only. `base` is the content hash the
  entry had when you opened it (null for a new file). Refused when the file on disk no longer hashes to `base`: an
  agent or a peer changed it while you edited. The dashboard then shows `Changed` and reloads the entry from disk,
  keeping your text in the box to copy from. Paths are confined to the memory repo (no `..`, no absolute).

**How a write happens.** Under both the turn syncs' lock (`serialised("memory-sync\0<path>")` in `memory-sync.ts`)
and the lock a peer's push into the repo takes (`serialised(repoKey(repo))` in `src/git/serve.ts`), so neither a sync
nor a push can land halfway through:

1. When `@` does not descend from `memory` (a peer pushed meanwhile): rebase it onto `memory` as `syncMemoryBefore`
   does, unless a task of the project has a turn live here; then refuse with `Busy` (moving the working copy under a
   running agent is what the turn syncs avoid too). The dashboard says `Busy` beside `Save`; you try again.
2. Check `base` (above), write or remove the file.
3. `jj commit -m "memory: dashboard" <path>`: only that path goes in. Other files an agent mid-turn left uncommitted
   stay in `@` for its turn end. If the agent had an uncommitted edit to this same file, you saw it when you opened the
   entry (reads come from disk) and wrote on top of it, so nothing is lost.
4. Move `memory` onto the new commit. No push: it is the home. The next turn of any task on any node fetches it as
   today.

The turn end's `syncMemoryAfter` has the same gap today (a peer's push between its rebase and its `bookmark set
--allow-backwards` drops the peer's commit from `memory`); it takes the push lock too, as part of this piece.

**Which task wrote it.** Turn-end commits today read `memory from <node short id>`. They become
`memory from <node short id>: task <task id>` (the task whose turn end commits it), so history can name the task. A
turn end skipped while another task of the project was live commits both tasks' writes later under the second task:
history names that one. Accepted; not worth tracking. Old commits keep their message and show the node only.

**UI** (board 2): section `Memory` with the entry count and `New`; one row per entry: name, description, type tag;
open: the text rendered as markdown, then `<when> · <task>` and `Edit`, `History`, `Delete`. Edit shows the raw file
(frontmatter included) in a monospace textarea with `Save` and `Cancel`. `New` asks for a file name and opens an empty
editor. `History` on an entry filters the History section to that file. Section `History`, closed by default: one row
per change (change id, when, task link or `Dashboard` or `Imported`, node, files, `+n −n`), opening to its diffs.

## Changes (piece 3)

A task's work per project is its line: the bookmark `meddle/task/<id>/<project name>`, which meddle keeps on the
workspace's working-copy change (`src/projects/lines.ts:71`), in the replica on the task's node. The work is measured
from the task's start, the manifest's per-project `base` (`src/tasks/manifest.ts:15`), not from the default branch: a
task started on another task's change or on a branch other than the default lists only its own changes, and a project
without a default branch still works.

**TaskObject gains** (served by the task's node; refused for a moved or archived task, whose view says so instead):

- state `changes`: per project of the task, the changes `<base>..<line>` (`base` the manifest's commits, joined with
  `|`), newest first; the first is the working copy. Each: change id, description's first line, files, `+n −n`,
  empty, conflicted. Re-read when the task's bookmarks are (turn end, state change, every 60 s).
- `changeDiff({ project, change | "all" })`: `jj diff --git` of one change against its parent, or for "all" from the
  start (`base`) to the line.
- `changeFile({ project, change, path })`: a file's lines at a change (for gap bars and `Expand`).
- `workspaceFile({ path })`: a file's lines as they are now in the task's workspace (`path` absolute, confined to the
  task's workspaces). For the thread: Claude Code leaves `originalFile` out of Edit/Write results for files over
  about 10 KB (64% of 841 real results checked), so their bars could not open. With this call, a thread diff
  without `originalFile` reads the file as it is now and opens its bars from it, read as the new side (a revealed old
  line `o` is `file[o + offset - 1]`; the `↓` gap ends at `file.length - offset`), only when every new-side line of
  its hunks (`+` and context) matches the file at its new number; otherwise the bars stay plain. The file is fetched
  once, when the diff is first shown open. The diff model gains this new-side reading (`side: "old" | "new"`), which
  pieces 2 and 3 can use too. Chosen over turning on Claude Code's file checkpointing (exact old files, but per-turn
  backups to replay patches on, and copies of every edited file in the task's config folder).

**UI** (board 3): the task header gets a `Thread | Changes n` switch (n = the count of non-empty changes; hidden for a
task without a project). Changes: a summary line (`n changes on <start>`, where `<start>` is a bookmark on the base
commit if it has one, e.g. `main`, else its short change id; files; `+n −n`); on the left the changes as a small graph
from the working copy (labelled `Working copy`, `empty` when it is) down to the start, `All changes` first and
selected; on the right that selection's files, each a diff (open when it has at most 200 changed lines, else closed).
A task with several projects picks the project with a small selector above the list.

## Graph (piece 4)

**ProjectObject gains** state `graph`, re-read like `heads`: the commits in this node's replica from the default
branch's parent up to every branch and task line (at most 200, newest first): commit id, change id, parents, first
line of description, whether immutable, and the bookmarks on it. Without a default branch, the 200 newest commits
under those bookmarks.

Which bookmarks count, and under what name, since they differ between nodes (`src/projects/lines.ts:1`,
`applier.ts:299`): a task line is `meddle/task/<id>/<name>` on its holder and the remote bookmark
`task/<id>/<name>@meddle` elsewhere; both are reported as task `<id>`, project `<name>`. Branches are reported by
branch name. Left out: `base/…@meddle` refs, `@git` copies, the lines of archived tasks (as the Tasks list hides
them), and side lines (`.before-<n>` and the like).

**The dashboard** merges every online holder's `graph` by commit id. Each bookmark on a commit is labelled with the
nodes that have it there. A bookmark a node has at an ancestor of where others have it shows as behind on that node
(`⌂ laptop · 1 behind`); a commit only one node has shows `not pushed` beside its bookmark. Task bookmarks show the
task's title (from the pool's task index) and link to it. Lanes are laid out by a pure function (tested), drawn in
SVG per row as on board 2. `Older` at the bottom shows the next 200 from the home.

The **Copies** table goes. Its "context failed to load" note shows beside the node's name where the graph labels that
node. The **Branches** section stays only for branches that are conflicted or fetching, and only when there are any:
a conflicted branch's siblings live under refs jj does not import (`applier.ts:9`), so the graph can't draw them, and
a fetching branch has no commit here yet. A healthy branch appears only in the graph.

## Copy

Labels are one word where one word will do. No helper sentences. The labels: `Thread`, `Changes`, `All changes`,
`Working copy`, `Expand`, `Memory`, `New`, `Edit`, `History`, `Delete`, `Save`, `Cancel`, `Index`, `Dashboard`,
`Imported`, `Graph`, `Older`, `offline`, `Changed`, `Busy`; gap bars `↑ n lines`, `↕ n lines`, `↓ n lines`. (The
mockups say `New entry` and `Whole file`; these are `New` and `Expand`.)

## Approaches

- **Unified diffs from the node, drawn by the dashboard; hidden lines fetched on demand (chosen).** jj produces the
  diff, a small parser reads it; the thread already has Claude Code's patch and the original file. No dependency, the
  dashboard's own styles.
- Whole files before and after, diffed in the dashboard: needs a diff library and sends whole files for every change.
- A ready-made renderer (diff2html): its styling fights the dashboard's tokens; a heavy dependency for little gain.

Memory writes: **on the home, under the turn syncs' lock, committing only the edited path (chosen)**, against writing
on whichever node the dashboard is on and pushing like a turn end (two places a write can conflict instead of one, and
a node with a live task skips its sync, delaying the write).

## Left to the builder

- Exact method and state names; whether `memoryEntries` is a method or state.
- Parsing details of frontmatter (a small YAML subset is enough: the files are Claude Code's own memory format).
- Lane layout algorithm, as long as it is stable as rows are added at the top.
- Tests: the diff parser, gap computation, the graph merge and lane layout as pure functions; memory write/delete
  against a real jj repo like `test/memory-sync.test.ts`; the `base` refusal; that a write leaves another uncommitted
  file in `@` alone.
