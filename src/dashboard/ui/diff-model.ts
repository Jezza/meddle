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
 * is its first old line as it was before any opening; it stays the same while the gap shrinks. A gap's `count` is
 * null when it is not known yet: the gap below a change whose file has not loaded.
 */
export type DiffRow =
  | { kind: "add" | "del" | "same"; text: string; old?: number; new?: number }
  | { kind: "gap"; key: number; where: GapWhere; count: number | null; canOpen: boolean };

/** How far each gap is open, keyed by gap `key`: `step` shows `GAP_STEP` lines nearest the change, `all` the rest. */
export type Opened = ReadonlyMap<number, "step" | "all">;

/** The lines one step opens of a gap. */
export const GAP_STEP = 20;

type GapRow = Extract<DiffRow, { kind: "gap" }>;

/**
 * How `diffRows` reads its file: `side` says which side of the change it is (the old, by default); `loadable` says
 * a missing file can still come, so its gaps show as openable and there is a gap below of unknown length.
 */
export type DiffOptions = { side?: "old" | "new"; loadable?: boolean };

/**
 * The rows of a change: each hunk's lines, numbered, with a gap for the old lines before, between and after them.
 * A gap opens (`opened`) only when `file` reaches its last line; without `file` there is no gap below, since its
 * length is unknown, unless the file is `loadable`.
 */
export function diffRows(
  hunks: readonly Hunk[], file: readonly string[] | null, opened: Opened = new Map(), opts: DiffOptions = {},
): DiffRow[] {
  const source: Source = { file, side: opts.side ?? "old", loadable: file === null && opts.loadable === true };
  const rows: DiffRow[] = [];
  let prevOldEnd = 0;
  let last: Hunk | undefined;
  for (const raw of hunks) {
    // GNU-style: an insertion at the top reports `oldStart` 0.
    const hunk = raw.oldLines === 0 && raw.oldStart === 0 ? { ...raw, oldStart: 1 } : raw;
    const where = last ? "between" : "above";
    pushGap(rows, where, prevOldEnd + 1, hunk.oldStart - 1, hunk.newStart - hunk.oldStart, source, opened);
    pushHunk(rows, hunk);
    prevOldEnd = hunk.oldStart + hunk.oldLines - 1;
    last = hunk;
  }
  if (!last) return rows;
  if (source.loadable) {
    rows.push({ kind: "gap", key: prevOldEnd + 1, where: "below", count: null, canOpen: true });
  } else if (file) {
    const offset = last.newStart + last.newLines - (last.oldStart + last.oldLines);
    const end = source.side === "new" ? file.length - offset : file.length;
    if (end > prevOldEnd) pushGap(rows, "below", prevOldEnd + 1, end, offset, source, opened);
  }
  return rows;
}

/** Whether `file` is the new side of `hunks`: every added and context line is where the hunks put it. */
export function fitsNewSide(hunks: readonly Hunk[], file: readonly string[]): boolean {
  for (const hunk of hunks) {
    let next = hunk.newStart;
    for (const line of hunk.lines) {
      if (line.startsWith("\\") || line.startsWith("-")) continue;
      if (file[next - 1] !== line.slice(1)) return false;
      next++;
    }
  }
  return true;
}

/** The file a diff's gaps open from, which side of the change it is, and whether it can still load. */
type Source = { file: readonly string[] | null; side: "old" | "new"; loadable: boolean };

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
 * lines further down in the new file, around a gap row for what stays hidden. Old line `o` is the file's line `o`,
 * or its line `o + offset` when the file is the new side.
 */
function pushGap(
  rows: DiffRow[], where: GapWhere, from: number, to: number, offset: number, source: Source, opened: Opened,
): void {
  if (to < from) return;
  const { file } = source;
  const shift = source.side === "new" ? offset : 0;
  const canOpen = file !== null ? file.length >= to + shift : source.loadable;
  const [hideFrom, hideTo] = hidden(where, from, to, canOpen && file !== null ? opened.get(from) : undefined);
  const reveal = (a: number, b: number) => {
    for (let old = a; old <= b; old++) rows.push({ kind: "same", text: file![old + shift - 1]!, old, new: old + offset });
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

/** A gap's label: an arrow for where it opens from and its count, e.g. `↕ 27 lines`, or `↓ lines` with no count. */
export function gapLabel(row: GapRow): string {
  const arrow = row.where === "above" ? "↑" : row.where === "below" ? "↓" : "↕";
  if (row.count === null) return `${arrow} lines`;
  return `${arrow} ${row.count} ${row.count === 1 ? "line" : "lines"}`;
}

/** The next opening of a gap: a step first, then all of it. */
export function nextOpen(current: "step" | "all" | undefined): "step" | "all" {
  return current === undefined ? "step" : "all";
}
