// A file change's diff: its rows numbered in the old file and the new, with bars for the hidden lines between hunks.
import { useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { type DiffRow, diffRows, fitsNewSide, gapLabel, type GapWhere, type Hunk, nextOpen, type Opened } from "./diff-model";
import type { FilePatch } from "./git-diff";

/** What a diff's head shows: the file's path, what happened to it, its line counts and whether it is binary. */
export type DiffHead = { path: string; status: FilePatch["status"]; added: number; removed: number; binary?: boolean };

/** A file's lines once a load has landed: `null` when it came back empty-handed or did not fit. */
type Loaded = { file: readonly string[] | null };

/**
 * A change's hunks as rows; a click on a gap opens it from the file's lines, a step and then the rest. The file is
 * `file`, or else what `load` gives on the first click; `side` says whether it is the old side (the default) or the
 * new, which must fit the hunks to be used. With `head`, a head above the rows names the file and has `Expand`,
 * which opens every gap at once; `closed` starts with only the head, whose path then shows and hides the rows.
 */
export function DiffView({ hunks, file: given, load, side = "old", head, closed }: {
  hunks: readonly Hunk[];
  file: readonly string[] | null;
  load?: () => Promise<readonly string[] | null>;
  side?: "old" | "new";
  head?: DiffHead;
  closed?: boolean;
}) {
  const [opened, setOpened] = useState<Opened>(new Map());
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [shut, setShut] = useState(closed === true);
  const loading = useRef<Promise<Loaded> | null>(null);
  const file = given ?? loaded?.file ?? null;
  const loadable = given === null && load !== undefined && loaded === null;
  const rows = useMemo(() => diffRows(hunks, file, opened, { side, loadable }), [hunks, file, opened, side, loadable]);
  const box = useRef<HTMLDivElement>(null);
  // The row below an opened `↑` gap and where it was, so the box scrolls to keep it in place once the lines show.
  const anchor = useRef<{ row: HTMLElement; top: number } | null>(null);
  useLayoutEffect(() => {
    const kept = anchor.current;
    anchor.current = null;
    if (kept && box.current) box.current.scrollTop += kept.row.offsetTop - kept.top;
  });
  // The file to open gaps from, loading it first when it can still come; null when there is none to use. A load that
  // failed is tried again on the next click, its bars buttons still.
  const fileNow = async (): Promise<readonly string[] | null> => {
    if (!loadable) return file;
    const pending = loading.current ??= load!().then(
      (lines) => ({ file: lines !== null && (side === "old" || fitsNewSide(hunks, lines)) ? lines : null }),
    );
    let result: Loaded;
    try {
      result = await pending;
    } catch {
      if (loading.current === pending) loading.current = null;
      return null;
    }
    setLoaded(result);
    return result.file;
  };
  const open = async (key: number, where: GapWhere, bar: HTMLElement) => {
    if ((await fileNow()) === null) return;
    const below = bar.nextElementSibling;
    if (where === "above" && below instanceof HTMLElement) anchor.current = { row: below, top: below.offsetTop };
    setOpened((current) => new Map(current).set(key, nextOpen(current.get(key))));
  };
  const expand = async () => {
    const lines = await fileNow();
    if (lines === null) return;
    setOpened((current) => {
      const all = new Map(current);
      for (const row of diffRows(hunks, lines, current, { side })) if (row.kind === "gap" && row.canOpen) all.set(row.key, "all");
      return all;
    });
  };
  const body = !head?.binary && !shut;
  return (
    <div ref={box} class={opened.size > 0 ? "diff open" : "diff"}>
      {head && (
        <div class="diff-head">
          {closed !== undefined && !head.binary
            ? <button type="button" class="path" aria-expanded={!shut} onClick={() => setShut((s) => !s)}>{head.path}</button>
            : <span class="path">{head.path}</span>}
          {head.status !== "modified" && <span class="tag">{head.status === "added" ? "new" : head.status}</span>}
          {head.binary
            ? <span class="tag">binary</span>
            : <span><span class="add">+{head.added}</span> <span class="del">−{head.removed}</span></span>}
          {body && rows.some((row) => row.kind === "gap" && row.canOpen) && <button type="button" onClick={expand}>Expand</button>}
        </div>
      )}
      {body && <DiffRows rows={rows} onOpen={open} />}
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
