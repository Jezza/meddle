// A file change's diff: its rows numbered in the old file and the new, with bars for the hidden lines between hunks.
import { useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { type DiffRow, diffRows, gapLabel, type GapWhere, type Hunk, nextOpen, type Opened } from "./diff-model";
import type { FilePatch } from "./git-diff";

/** What a diff's head shows: the file's path, what happened to it and its line counts. */
export type DiffHead = { path: string; status: FilePatch["status"]; added: number; removed: number };

/**
 * A change's hunks as rows; a click on a gap opens it from `file`, the old file's lines, a step and then the rest.
 * With `head`, a head above the rows names the file and has `Expand`, which opens every gap at once.
 */
export function DiffView({ hunks, file, head }: { hunks: readonly Hunk[]; file: readonly string[] | null; head?: DiffHead }) {
  const [opened, setOpened] = useState<Opened>(new Map());
  const rows = useMemo(() => diffRows(hunks, file, opened), [hunks, file, opened]);
  const box = useRef<HTMLDivElement>(null);
  // The row below an opened `↑` gap and where it was, so the box scrolls to keep it in place once the lines show.
  const anchor = useRef<{ row: HTMLElement; top: number } | null>(null);
  useLayoutEffect(() => {
    const kept = anchor.current;
    anchor.current = null;
    if (kept && box.current) box.current.scrollTop += kept.row.offsetTop - kept.top;
  });
  const open = (key: number, where: GapWhere, bar: HTMLElement) => {
    const below = bar.nextElementSibling;
    if (where === "above" && below instanceof HTMLElement) anchor.current = { row: below, top: below.offsetTop };
    setOpened((current) => new Map(current).set(key, nextOpen(current.get(key))));
  };
  const expand = () => setOpened((current) => {
    const all = new Map(current);
    for (const row of rows) if (row.kind === "gap" && row.canOpen) all.set(row.key, "all");
    return all;
  });
  return (
    <div ref={box} class={opened.size > 0 ? "diff open" : "diff"}>
      {head && (
        <div class="diff-head">
          <span class="path">{head.path}</span>
          {head.status !== "modified" && <span class="tag">{head.status === "added" ? "new" : head.status}</span>}
          <span><span class="add">+{head.added}</span> <span class="del">−{head.removed}</span></span>
          {rows.some((row) => row.kind === "gap" && row.canOpen) && <button type="button" onClick={expand}>Expand</button>}
        </div>
      )}
      <DiffRows rows={rows} onOpen={open} />
    </div>
  );
}

/** Diff rows as lines: old and new numbers, the sign, the text; a gap is a bar, a button when it can open. */
export function DiffRows({ rows, onOpen }: {
  rows: readonly DiffRow[];
  onOpen?: (key: number, where: GapWhere, bar: HTMLElement) => void;
}) {
  return (
    <>
      {rows.map((row, i) => {
        if (row.kind === "gap") {
          return row.canOpen && onOpen !== undefined
            ? (
              <button key={`g${row.key}`} type="button" class="dl gap" onClick={(e) => onOpen(row.key, row.where, e.currentTarget)}>
                {gapLabel(row)}
              </button>
            )
            : <div key={`g${row.key}`} class="dl gap">{gapLabel(row)}</div>;
        }
        return (
          <div key={row.kind === "add" ? (row.new !== undefined ? `n${row.new}` : i) : row.old !== undefined ? `o${row.old}` : i} class={`dl ${row.kind}`}>
            <span class="n">{row.old ?? ""}</span>
            <span class="n">{row.new ?? ""}</span>
            <span class="s">{row.kind === "add" ? "+" : row.kind === "del" ? "-" : " "}</span>
            {row.text}
          </div>
        );
      })}
    </>
  );
}
