// A file change's diff as rows: numbered lines and the gaps of unchanged lines between hunks, which open from the file.

/**
 * One hunk of a file change, as Claude Code's `structuredPatch` reports it: lines prefixed `-`, `+` or a space.
 * `oldStart`/`newStart` are the 1-based first line of the hunk's range, so its old range is
 * `oldStart .. oldStart + oldLines - 1` (empty when `oldLines` is 0, the insertion point being before `oldStart`).
 */
export type Hunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] };

/** Where a gap sits: before the first hunk, between two, or after the last. */
export type GapWhere = "above" | "between" | "below";

/**
 * A diff row: a line (numbered in the old file, the new, or both) or a gap of hidden unchanged lines. A gap's `key`
 * is its first old line as it was before any opening; it stays the same while the gap shrinks.
 */
export type DiffRow =
  | { kind: "add" | "del" | "same"; text: string; old?: number; new?: number }
  | { kind: "gap"; key: number; where: GapWhere; count: number; canOpen: boolean };

/** How far each gap is open, keyed by gap `key`: `step` shows `GAP_STEP` lines nearest the change, `all` the rest. */
export type Opened = ReadonlyMap<number, "step" | "all">;

/** The lines one step opens of a gap. */
export const GAP_STEP = 20;

type GapRow = Extract<DiffRow, { kind: "gap" }>;

/**
 * The rows of a change: each hunk's lines, numbered, with a gap for the old lines before, between and after them.
 * A gap opens (`opened`) only when `file`, the old file's lines, reaches its last line; without `file` there is
 * no gap below, since its length is unknown.
 */
export function diffRows(hunks: readonly Hunk[], file: readonly string[] | null, opened: Opened = new Map()): DiffRow[] {
  const rows: DiffRow[] = [];
  let prevOldEnd = 0;
  let last: Hunk | undefined;
  for (const raw of hunks) {
    // GNU-style: an insertion at the top reports `oldStart` 0.
    const hunk = raw.oldLines === 0 && raw.oldStart === 0 ? { ...raw, oldStart: 1 } : raw;
    const where = last ? "between" : "above";
    pushGap(rows, where, prevOldEnd + 1, hunk.oldStart - 1, hunk.newStart - hunk.oldStart, file, opened);
    pushHunk(rows, hunk);
    prevOldEnd = hunk.oldStart + hunk.oldLines - 1;
    last = hunk;
  }
  if (last && file && file.length > prevOldEnd) {
    const offset = last.newStart + last.newLines - (last.oldStart + last.oldLines);
    pushGap(rows, "below", prevOldEnd + 1, file.length, offset, file, opened);
  }
  return rows;
}

/** A hunk's lines as rows, numbered from its starts; `\ No newline at end of file` markers are left out. */
function pushHunk(rows: DiffRow[], hunk: Hunk): void {
  let old = hunk.oldStart;
  let next = hunk.newStart;
  for (const line of hunk.lines) {
    if (line.startsWith("\\")) continue;
    const text = line.slice(1);
    if (line.startsWith("-")) rows.push({ kind: "del", text, old: old++ });
    else if (line.startsWith("+")) rows.push({ kind: "add", text, new: next++ });
    else rows.push({ kind: "same", text, old: old++, new: next++ });
  }
}

/**
 * The gap over old lines `from..to`, opened as far as `opened` says: its revealed lines as `same` rows, `offset`
 * lines further down in the new file, around a gap row for what stays hidden.
 */
function pushGap(
  rows: DiffRow[], where: GapWhere, from: number, to: number, offset: number, file: readonly string[] | null, opened: Opened,
): void {
  if (to < from) return;
  const canOpen = file !== null && file.length >= to;
  const [hideFrom, hideTo] = hidden(where, from, to, canOpen ? opened.get(from) : undefined);
  const reveal = (a: number, b: number) => {
    for (let old = a; old <= b; old++) rows.push({ kind: "same", text: file![old - 1]!, old, new: old + offset });
  };
  reveal(from, hideFrom - 1);
  if (hideTo >= hideFrom) rows.push({ kind: "gap", key: from, where, count: hideTo - hideFrom + 1, canOpen });
  reveal(hideTo + 1, to);
}

/** The old lines of the gap `from..to` that stay hidden, as `[first, last]` (empty when `last < first`). */
function hidden(where: GapWhere, from: number, to: number, open: "step" | "all" | undefined): [number, number] {
  if (open === undefined) return [from, to];
  if (open === "all" || to - from + 1 <= GAP_STEP) return [from, from - 1];
  if (where === "above") return [from, to - GAP_STEP];
  if (where === "below") return [from + GAP_STEP, to];
  return [from + GAP_STEP / 2, to - GAP_STEP / 2];
}

/** A gap's label: an arrow for where it opens from and its count, e.g. `↕ 27 lines`. */
export function gapLabel(row: GapRow): string {
  const arrow = row.where === "above" ? "↑" : row.where === "below" ? "↓" : "↕";
  return `${arrow} ${row.count} ${row.count === 1 ? "line" : "lines"}`;
}

/** The next opening of a gap: a step first, then all of it. */
export function nextOpen(current: "step" | "all" | undefined): "step" | "all" {
  return current === undefined ? "step" : "all";
}
