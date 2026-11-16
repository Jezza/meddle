// A file change's diff: its rows numbered in the old file and the new, with bars for the hidden lines between hunks.
import { useMemo, useState } from "preact/hooks";
import { type DiffRow, diffRows, gapLabel, type Hunk, nextOpen, type Opened } from "./diff-model";

/** A change's hunks as rows; a click on a gap opens it from `file`, the old file's lines, a step and then the rest. */
export function DiffView({ hunks, file }: { hunks: readonly Hunk[]; file: readonly string[] | null }) {
  const [opened, setOpened] = useState<Opened>(new Map());
  const rows = useMemo(() => diffRows(hunks, file, opened), [hunks, file, opened]);
  const open = (key: number) => setOpened((current) => new Map(current).set(key, nextOpen(current.get(key))));
  return <div class="diff"><DiffRows rows={rows} onOpen={open} /></div>;
}

/** Diff rows as lines: old and new numbers, the sign, the text; a gap is a bar, a button when it can open. */
export function DiffRows({ rows, onOpen }: { rows: readonly DiffRow[]; onOpen?: (key: number) => void }) {
  return (
    <>
      {rows.map((row, i) => {
        if (row.kind === "gap") {
          return row.canOpen && onOpen !== undefined
            ? <button key={`g${row.key}`} type="button" class="dl gap" onClick={() => onOpen(row.key)}>{gapLabel(row)}</button>
            : <div key={`g${row.key}`} class="dl gap">{gapLabel(row)}</div>;
        }
        return (
          <div key={i} class={`dl ${row.kind}`}>
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
