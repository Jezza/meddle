// test/diff-model.test.ts
import { test, expect } from "bun:test";
import { diffRows, gapLabel, nextOpen, type DiffRow, type Hunk } from "../src/dashboard/ui/diff-model";

const file = Array.from({ length: 100 }, (_, i) => `l${i + 1}`);
const hunks: Hunk[] = [
  { oldStart: 30, oldLines: 3, newStart: 30, newLines: 4, lines: [" a", "-b", "+B", "+c", " d"] },
  { oldStart: 60, oldLines: 1, newStart: 61, newLines: 1, lines: ["-x", "+y", "\\ No newline at end of file"] },
];
const tenLines = Array.from({ length: 10 }, (_, i) => `t${i + 1}`);

type Gap = Extract<DiffRow, { kind: "gap" }>;
const gaps = (rows: DiffRow[]) => rows.filter((r): r is Gap => r.kind === "gap");
/** `same` rows revealed from the file for old lines `from..to`, `shift` lines further down in the new file. */
const revealed = (from: number, to: number, shift: number, lines: readonly string[] = file): DiffRow[] =>
  Array.from({ length: to - from + 1 }, (_, i) => {
    const old = from + i;
    return { kind: "same", text: lines[old - 1]!, old, new: old + shift };
  });
const gap = (key: number, where: Gap["where"], count: number, canOpen = true): Gap =>
  ({ kind: "gap", key, where, count, canOpen });

test("diffRows numbers old and new lines and puts a gap around every hunk", () => {
  expect(diffRows(hunks, file)).toEqual([
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
  ]);
});

test("a step opens the 20 lines nearest the change", () => {
  const above = diffRows(hunks, file, new Map([[1, "step"]]));
  expect(above.slice(0, 21)).toEqual([gap(1, "above", 9), ...revealed(10, 29, 0)]);
  expect(above[21]).toEqual({ kind: "same", text: "a", old: 30, new: 30 });

  const between = diffRows(hunks, file, new Map([[33, "step"]]));
  const start = between.findIndex((r) => r.kind === "same" && r.old === 33);
  expect(between.slice(start, start + 21)).toEqual([...revealed(33, 42, 1), gap(33, "between", 7), ...revealed(50, 59, 1)]);
  expect(between[start + 21]).toEqual({ kind: "del", text: "x", old: 60 });

  const below = diffRows(hunks, file, new Map([[61, "step"]]));
  expect(below.slice(-21)).toEqual([...revealed(61, 80, 1), gap(61, "below", 20)]);
});

test("all opens every hidden line", () => {
  const rows = diffRows(hunks, file, new Map([[1, "all"], [33, "all"], [61, "all"]]));
  expect(gaps(rows)).toEqual([]);
  const old = rows.flatMap((r) => (r.kind === "same" || r.kind === "del" ? [r.old] : []));
  expect(old).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
});

test("diffRows without the file shows counts it cannot open", () => {
  const expected = [gap(1, "above", 29, false), gap(33, "between", 27, false)];
  expect(gaps(diffRows(hunks, null))).toEqual(expected);
  expect(gaps(diffRows(hunks, null, new Map([[1, "all"], [33, "step"]])))).toEqual(expected);
});

test("diffRows handles an insertion hunk", () => {
  const insertion: Hunk = { oldStart: 5, oldLines: 0, newStart: 5, newLines: 1, lines: ["+n"] };
  expect(diffRows([insertion], tenLines)).toEqual([
    gap(1, "above", 4),
    { kind: "add", text: "n", new: 5 },
    gap(5, "below", 6),
  ]);
  expect(diffRows([insertion], tenLines, new Map([[5, "all"]])).slice(2)).toEqual(revealed(5, 10, 1, tenLines));

  // A hunk at the first line has no gap above; one ending on the last line has none below.
  const first: Hunk = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-t1", "+u1"] };
  expect(diffRows([first], tenLines)[0]).toEqual({ kind: "del", text: "t1", old: 1 });
  const last: Hunk = { oldStart: 10, oldLines: 1, newStart: 10, newLines: 1, lines: ["-t10", "+u10"] };
  expect(diffRows([last], tenLines).at(-1)).toEqual({ kind: "add", text: "u10", new: 10 });

  // GNU-style insertion at the top reads as starting at line 1.
  const top = (oldStart: number): Hunk => ({ oldStart, oldLines: 0, newStart: 1, newLines: 1, lines: ["+n"] });
  const rows = diffRows([top(0)], tenLines);
  expect(rows).toEqual(diffRows([top(1)], tenLines));
  expect(rows).toEqual([{ kind: "add", text: "n", new: 1 }, gap(1, "below", 10)]);
});

test("diffRows refuses to open a gap the file cannot fill", () => {
  const short = file.slice(0, 50);
  expect(gaps(diffRows(hunks, short))).toEqual([gap(1, "above", 29), gap(33, "between", 27, false)]);
  const opened = diffRows(hunks, short, new Map([[1, "all"], [33, "all"]]));
  expect(gaps(opened)).toEqual([gap(33, "between", 27, false)]);
});

test("gapLabel and nextOpen", () => {
  expect(gapLabel(gap(1, "above", 29))).toBe("↑ 29 lines");
  expect(gapLabel(gap(33, "between", 27))).toBe("↕ 27 lines");
  expect(gapLabel(gap(61, "below", 40))).toBe("↓ 40 lines");
  expect(gapLabel(gap(1, "above", 1))).toBe("↑ 1 line");
  expect(nextOpen(undefined)).toBe("step");
  expect(nextOpen("step")).toBe("all");
  expect(nextOpen("all")).toBe("all");
});
