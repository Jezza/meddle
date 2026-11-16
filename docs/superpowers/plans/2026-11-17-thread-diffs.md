# Thread Diffs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The thread's Edit/Write diff shows old and new line numbers, and its hidden lines open from bars (`↑ n lines`, `↕ n lines`, `↓ n lines`) using the file Claude Code sent back with the call.

**Architecture:** A pure model (`diff-model.ts`) turns hunks plus the old file's lines into rows: numbered lines and gaps, with gaps opened step by step from a map of what the user opened. A small Preact component (`diff.tsx`) draws those rows and keeps the opened map. The thread model carries `originalFile` through to the tool item; `Task.tsx` swaps its inline `DiffView` for the shared one. Pieces 2–4 of the spec reuse both files.

**Tech Stack:** TypeScript, Bun (`bun test`), Preact, the dashboard's own CSS in `src/dashboard/ui/index.html`.

**Spec:** `docs/superpowers/specs/2026-11-16-diffs-memory-review-design.md` (piece 1, and "The shared diff view").

## Global Constraints

- Gap bar labels exactly: `↑ n lines` above the first hunk, `↕ n lines` between hunks, `↓ n lines` below the last; `line` when n is 1.
- First click opens the 20 hidden lines nearest the change; a second click on what is left opens the rest.
- Without the old file (`originalFile` null or absent) bars show the count but are not buttons, and there is no `↓` bar (its length is unknown).
- No helper text in the UI. Labels per the spec's Copy section.
- No new dependencies. Colours from the existing tokens (`--add`, `--add-bg`, `--del-bg`, `--accent`, `--faint`, `--muted`, `--line`).
- jj, not git: commit with `jj commit -m "<message>"`. No attribution trailers.
- Run only the tests covering the change (the full suite is slow): the commands are given per step.
- If `node_modules` is missing in the workspace, run `bun install --frozen-lockfile` once first.

## Review Focus

- The old file has fewer lines than the hunks imply (a truncated or mismatched `originalFile`): bars must not open onto wrong or missing lines; they show their count and are not buttons. → Task 1, `diffRows refuses to open a gap the file cannot fill`.
- A pure insertion (`oldLines: 0`) or a deletion at the end of the file: gaps and numbers stay right on both sides. → Task 1, `diffRows handles an insertion hunk`.
- `\ No newline at end of file` in a hunk is never a row. → Task 1, asserted in the main `diffRows` test.
- A Write that creates a file: Claude Code sends `type: "create"`, `originalFile: null` and an empty `structuredPatch`, so it draws from the fallback: its lines as additions numbered 1..n in the new column, no bars. → Task 2, `a Write that creates a file numbers its lines`.
- Events logged before this change have no `originalFile`: the diff still draws, with plain-text bars. → Task 1, `diffRows without the file shows counts it cannot open`.

---

### Task 1: The diff model

**Files:**
- Create: `src/dashboard/ui/diff-model.ts`
- Modify: `src/dashboard/ui/thread-model.ts:22-23` (move `Hunk` out; import it back from `diff-model.ts` and re-export it so existing imports keep working)
- Test: `test/diff-model.test.ts`

**Interfaces:**
- Produces (in `diff-model.ts`):
  - `export type Hunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }` — Claude Code's `structuredPatch` convention: `oldStart`/`newStart` are the 1-based first line of the hunk's range, so its old range is `oldStart .. oldStart + oldLines - 1` (empty when `oldLines` is 0, the insertion point being before `oldStart`).
  - `export type GapWhere = "above" | "between" | "below"`
  - `export type DiffRow = { kind: "add" | "del" | "same"; text: string; old?: number; new?: number } | { kind: "gap"; key: number; where: GapWhere; count: number; canOpen: boolean }` — `key` is the first old line of the gap as it was before any opening; it stays the same while the gap shrinks.
  - `export type Opened = ReadonlyMap<number, "step" | "all">` — keyed by gap `key`.
  - `export function diffRows(hunks: readonly Hunk[], file: readonly string[] | null, opened?: Opened): DiffRow[]`
  - `export function gapLabel(row: Extract<DiffRow, { kind: "gap" }>): string`
  - `export function nextOpen(current: "step" | "all" | undefined): "step" | "all"` — `undefined → "step"`, `"step" → "all"`, `"all" → "all"`.
  - `export const GAP_STEP = 20`

- [ ] **Step 1: Write the failing tests** in `test/diff-model.test.ts`

Use one fixture for the first four tests: a 100-line file `file = Array.from({ length: 100 }, (_, i) => \`l${i + 1}\`)` and

```ts
const hunks = [
  { oldStart: 30, oldLines: 3, newStart: 30, newLines: 4, lines: [" a", "-b", "+B", "+c", " d"] },
  { oldStart: 60, oldLines: 1, newStart: 61, newLines: 1, lines: ["-x", "+y", "\\ No newline at end of file"] },
];
```

- `diffRows numbers old and new lines and puts a gap around every hunk`: `diffRows(hunks, file)` equals
  ```ts
  [
    { kind: "gap", key: 1, where: "above", count: 29, canOpen: true },
    { kind: "same", text: "a", old: 30, new: 30 },
    { kind: "del", text: "b", old: 31 },
    { kind: "add", text: "B", new: 31 },
    { kind: "add", text: "c", new: 32 },
    { kind: "same", text: "d", old: 32, new: 33 },
    { kind: "gap", key: 33, where: "between", count: 27, canOpen: true },
    { kind: "del", text: "x", old: 60 },
    { kind: "add", text: "y", new: 61 },
    { kind: "gap", key: 61, where: "below", count: 40, canOpen: true },
  ]
  ```
- `a step opens the 20 lines nearest the change`, each with `opened = new Map([[key, "step"]])`:
  - above (`key 1`): the gap becomes `{ key: 1, count: 9 }` followed by `same` rows old 10..29 with `new === old` and `text === file[old - 1]`.
  - between (`key 33`): `same` rows old 33..42 (new 34..43), then the gap `{ key: 33, count: 7 }`, then `same` rows old 50..59 (new 51..60).
  - below (`key 61`): `same` rows old 61..80 (new 62..81), then the gap `{ key: 61, count: 20 }`.
- `all opens every hidden line`: with every key mapped to `"all"`, the result has no gap rows and 100 old-numbered rows (`same` + `del`) in order.
- `diffRows without the file shows counts it cannot open`: `diffRows(hunks, null)` has the above gap `{ count: 29, canOpen: false }`, the between gap `{ count: 27, canOpen: false }`, no below gap; `opened` is ignored.
- `diffRows handles an insertion hunk`: `diffRows([{ oldStart: 5, oldLines: 0, newStart: 5, newLines: 1, lines: ["+n"] }], tenLines)` equals above gap `{ key: 1, count: 4 }`, `{ kind: "add", text: "n", new: 5 }`, below gap `{ key: 5, count: 6 }`; opening the below gap with `"all"` gives `same` rows old 5..10 with new 6..11. A hunk starting at line 1 has no above gap; a hunk ending on the file's last line has no below gap. Real Claude Code results also carry `{ oldStart: 0, oldLines: 0, newStart: 1, … }` (an insertion at the top, GNU-style): it gives the same rows as `oldStart: 1` (no above gap, below gap from line 1).
- `diffRows refuses to open a gap the file cannot fill`: with `hunks` and a 50-line file, the below gap is absent and gaps whose range runs past line 50 have `canOpen: false` (the between gap 33..59 here); gaps inside the file stay openable.
- `gapLabel and nextOpen`: `gapLabel` gives `"↑ 29 lines"`, `"↕ 27 lines"`, `"↓ 40 lines"`, and `"↑ 1 line"` for a count of 1; `nextOpen(undefined) === "step"`, `nextOpen("step") === "all"`, `nextOpen("all") === "all"`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/diff-model.test.ts`
Expected: FAIL, `Cannot find module '../src/dashboard/ui/diff-model'`.

- [ ] **Step 3: Implement `diff-model.ts`**

Read a hunk with `oldLines: 0` and `oldStart: 0` as `oldStart: 1`. Walk the hunks keeping the old and new position. Before each hunk, the gap is old lines `prevOldEnd + 1 .. hunk.oldStart - 1` (`prevOldEnd` starts at 0); its offset for revealed lines is `hunk.newStart - hunk.oldStart`. After the last hunk, the gap runs to `file.length` with offset `(last.newStart + last.newLines) - (last.oldStart + last.oldLines)`, only when `file` is non-null and longer. Skip lines starting with `\`. A gap opened with `"step"` reveals, of its range: above, the last `GAP_STEP` lines; below, the first `GAP_STEP`; between, `GAP_STEP / 2` from each end (all of it when the range is at most `GAP_STEP`). Revealed lines are `same` rows `{ text: file[old - 1], old, new: old + offset }`. A gap is `canOpen` only when `file` is non-null and `file.length` reaches its last line; otherwise `opened` is ignored for it. A gap with nothing left hidden is not a row.

In `thread-model.ts`, replace the `Hunk` declaration with `import type { Hunk } from "./diff-model";` and `export type { Hunk };`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/diff-model.test.ts test/thread-model.test.ts`
Expected: PASS (thread-model tests unchanged and still green).

- [ ] **Step 5: Commit**

```bash
jj commit -m "Number a diff's old and new lines and open its gaps"
```

---

### Task 2: The thread uses the shared diff view

**Files:**
- Create: `src/dashboard/ui/diff.tsx`
- Modify: `src/dashboard/ui/thread-model.ts` (tool result gains `original`; `editDiff` returns hunks; `DiffLine` goes)
- Modify: `src/dashboard/ui/Task.tsx:16` (imports), `:484-509` (`ToolRow` uses the new view), `:524-538` (remove the inline `DiffView`)
- Modify: `src/dashboard/ui/index.html:252-260` (the `.diff` / `.dl` rules)
- Test: `test/thread-model.test.ts:111-155` (the three `editDiff` tests)

**Interfaces:**
- Consumes: `Hunk`, `DiffRow`, `Opened`, `diffRows`, `gapLabel`, `nextOpen` from Task 1.
- Produces:
  - `ToolItem.result` gains `original?: string[]`: `tool_use_result.originalFile` split into lines when it is a string (same rule as the existing `textLines`: a final newline is not one more line). Absent when null or missing.
  - `export function editDiff(tool: ToolItem): { hunks: Hunk[]; fallback: DiffRow[]; added: number; removed: number }` — `hunks` is the result's patch (empty when there is none); `fallback` is used only when `hunks` is empty: the input's old lines as `del` and new lines as `add` rows, unnumbered (today's fallback), except a Write, whose `content` lines are `add` rows numbered `new: 1..n`. `added`/`removed` count `+`/`-` lines of the hunks, else of the fallback.
  - In `diff.tsx`: `export function DiffView({ hunks, file }: { hunks: readonly Hunk[]; file: readonly string[] | null })` — keeps `opened` in state; a click on a gap sets `opened[key] = nextOpen(opened[key])`. And `export function DiffRows({ rows, onOpen }: { rows: readonly DiffRow[]; onOpen?: (key: number) => void })`, the presentational part both use (`ToolRow` renders `fallback` with it directly).
  - Markup per row: `<div class="dl add|del|same"><span class="n">{old}</span><span class="n">{new}</span><span class="s">+|-| </span>{text}</div>`; a gap that can open is `<button type="button" class="dl gap">`, one that can't is `<div class="dl gap">`, both containing `gapLabel(row)`.

- [ ] **Step 1: Update the failing tests** in `test/thread-model.test.ts`

- `an Edit's result keeps its patch and the original file`: same events as today's test plus `originalFile: "a\nb\nz\n"` in `tool_use_result`; expect `edit.result?.original` to equal `["a", "b", "z"]` and `editDiff(edit)` to equal `{ hunks: [<the one valid hunk>], fallback: [], added: 2, removed: 1 }`.
- `editDiff without a patch falls back to the input's lines`: today's assertions, with `lines` replaced by `fallback` and `hunks: []` (e.g. `{ hunks: [], fallback: [{ kind: "del", text: "a" }, { kind: "del", text: "b" }, { kind: "add", text: "c" }], added: 1, removed: 2 }`).
- `a Write that creates a file numbers its lines`: a Write with input `{ file_path: "/w/n.ts", content: "x\ny\n" }` and result `tool_use_result: { type: "create", filePath: "/w/n.ts", content: "x\ny\n", structuredPatch: [], originalFile: null }`; `edit.result?.original` is undefined and `editDiff(edit)` equals `{ hunks: [], fallback: [{ kind: "add", text: "x", new: 1 }, { kind: "add", text: "y", new: 2 }], added: 2, removed: 0 }`.
- Delete `editDiff numbers each hunk from its own start` (numbering is now `diffRows`'s, covered in Task 1).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/thread-model.test.ts`
Expected: FAIL on the three tests above (`original` undefined; `editDiff` still returns `lines`).

- [ ] **Step 3: Implement the model change** in `thread-model.ts`: read `originalFile` beside `structuredPatch` in `addUser`, set `result.original`; reshape `editDiff`; drop `DiffLine`.

- [ ] **Step 4: Implement `diff.tsx` and wire it into `Task.tsx`**

In `ToolRow`, render `diff.hunks.length > 0 ? <DiffView hunks={diff.hunks} file={result?.original ?? null} /> : diff.fallback.length > 0 && <div class="diff"><DiffRows rows={diff.fallback} /></div>`. The `SMALL_DIFF` open rule keeps using `diff.added + diff.removed`. Remove the inline `DiffView` and the `DiffLine` import.

- [ ] **Step 5: Update the CSS** in `index.html`

Replace the `.dl` block (`.dl`, `.dl .n`, `.dl .s`, `.dl.add`, `.dl.del`, `.dl.hunk`) so that: each row has two `.n` cells (40px each, right-aligned, `--faint`) and the `.s` cell (14px), so text starts 94px in; `.dl.add` / `.dl.del` keep their backgrounds and sign colours; `.dl.hunk` goes. Add:

```css
.dl.gap { width: 100%; padding: 2px 10px 2px 94px; border: none; border-radius: 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); background: none; color: var(--muted); font: 11.5px system-ui, sans-serif; text-align: left; }
.dl.gap:first-child { border-top: none; }
.dl.gap:last-child { border-bottom: none; }
button.dl.gap { color: var(--accent); background: color-mix(in srgb, var(--accent) 6%, transparent); cursor: pointer; }
button.dl.gap:hover:not(:disabled) { background: color-mix(in srgb, var(--accent) 12%, transparent); }
```

- [ ] **Step 6: Run the tests, typecheck and the bundle build**

Run: `bun test test/thread-model.test.ts test/diff-model.test.ts && bun test test/ui.test.ts -t "the dashboard bundle builds" && bun run typecheck`
Expected: all PASS, no type errors.

- [ ] **Step 7: Check it in the real dashboard**

Use the `run` skill to start the dashboard against a task that has an Edit with an `originalFile` (any task run after this change; make one Edit if needed). Confirm: two number columns; `↑`/`↕`/`↓` bars with counts; first click reveals 20 lines, second the rest; a Write of a new file shows no bars; in dark mode the bars and diff colours read correctly. Take a screenshot for the hand-back.

- [ ] **Step 8: Commit**

```bash
jj commit -m "Open a thread diff's hidden lines from the file the call saw"
```
