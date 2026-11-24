// Conflict markers an older meddle left in memory files as text (jj materialises a conflict into the working copy, and a
// session that never tidied it up left it there): each block read back into its base and sides and replaced by their
// merge (`mergeLines`), so a node's first publish never spreads markers. jj's "diff" style (`%%%%%%%` sections, a base
// and a side as one diff) and "snapshot" style (`+++++++` sides, `-------` bases) are read.
import { mergeLines } from "./merge-file";

const START = /^<{7,} conflict \d+ of \d+/;
const END = /^>{7,} conflict \d+ of \d+ ends/;
const DIFF = /^%{7,}( |$)/;
const DIFF_MORE = /^\\{7,}( |$)/;
const SIDE = /^\+{7,}( |$)/;
const BASE = /^-{7,}( |$)/;

type Block = { sides: string[][]; bases: string[][] };

const text = (lines: string[]) => (lines.length === 0 ? "" : `${lines.join("\n")}\n`);

/** The merge of a block's sides, each folded into the first over the base before it. */
function resolve(block: Block): string[] {
  if (block.sides.length === 0) return [];
  let acc = text(block.sides[0]!);
  for (let i = 1; i < block.sides.length; i++) acc = mergeLines(text(block.bases[i - 1] ?? []), acc, text(block.sides[i]!));
  return acc === "" ? [] : acc.replace(/\n$/, "").split("\n");
}

/**
 * `content` with every jj conflict block replaced by the merge of its sides; null when it holds none, or a block that
 * can't be read (one never closed, a section of no kind jj writes), which is then left for a person.
 */
export function unmarkConflicts(content: string): string | null {
  const newline = content.endsWith("\n");
  const lines = (newline ? content.slice(0, -1) : content).split("\n");
  const out: string[] = [];
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    if (!START.test(lines[i]!)) {
      out.push(lines[i]!);
      continue;
    }
    const block: Block = { sides: [], bases: [] };
    let section: { kind: "diff"; base: string[]; side: string[] } | { kind: "side" | "base"; lines: string[] } | null = null;
    const close = () => {
      if (section === null) return;
      if (section.kind === "diff") {
        block.bases.push(section.base);
        block.sides.push(section.side);
      } else if (section.kind === "side") block.sides.push(section.lines);
      else block.bases.push(section.lines);
      section = null;
    };
    let ended = false;
    for (i++; i < lines.length; i++) {
      const line = lines[i]!;
      if (END.test(line)) {
        ended = true;
        break;
      }
      if (DIFF.test(line)) {
        close();
        section = { kind: "diff", base: [], side: [] };
      } else if (DIFF_MORE.test(line) && section?.kind === "diff") {
        // The diff's second header line ("to: …").
      } else if (SIDE.test(line)) {
        close();
        section = { kind: "side", lines: [] };
      } else if (BASE.test(line)) {
        close();
        section = { kind: "base", lines: [] };
      } else if (section === null) {
        return null;
      } else if (section.kind === "diff") {
        const body = line.slice(1);
        if (line.startsWith("-")) section.base.push(body);
        else if (line.startsWith("+")) section.side.push(body);
        else if (line.startsWith(" ") || line === "") {
          section.base.push(body);
          section.side.push(body);
        } else return null;
      } else {
        section.lines.push(line);
      }
    }
    if (!ended) return null;
    close();
    out.push(...resolve(block));
    found = true;
  }
  if (!found) return null;
  return out.join("\n") + (newline ? "\n" : "");
}
