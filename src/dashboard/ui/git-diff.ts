// `jj diff --git` output as file patches: each file's path, what happened to it, its hunks and its line counts.
import type { Hunk } from "./diff-model";

/** One file's change in a git-style diff. `oldPath` is set for a rename; a binary change has no hunks. */
export type FilePatch = {
  path: string;
  oldPath?: string;
  status: "modified" | "added" | "deleted" | "renamed";
  binary: boolean;
  hunks: Hunk[];
  added: number;
  removed: number;
};

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * The file patches of `jj diff --git` text, in order. A hunk's start with a count of 0 is read one on, since git
 * writes the line before an empty range and `Hunk` wants its first line. `\ No newline at end of file` markers stay
 * in a hunk's lines but are not counted.
 */
export function parseGitDiff(text: string): FilePatch[] {
  const patches: FilePatch[] = [];
  const lines = text.split("\n");
  let patch: FilePatch | undefined;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i++]!;
    if (line.startsWith("diff --git ")) {
      patch = { path: headerPath(line.slice("diff --git ".length)), status: "modified", binary: false, hunks: [], added: 0, removed: 0 };
      patches.push(patch);
      continue;
    }
    if (!patch) continue;
    const head = HUNK_HEAD.exec(line);
    if (head) {
      const oldLines = head[2] === undefined ? 1 : Number(head[2]);
      const newLines = head[4] === undefined ? 1 : Number(head[4]);
      const hunk: Hunk = {
        oldStart: Number(head[1]) + (oldLines === 0 ? 1 : 0), oldLines,
        newStart: Number(head[3]) + (newLines === 0 ? 1 : 0), newLines,
        lines: [],
      };
      // The hunk's lines run until both its counts are spent, plus any no-newline marker after the last.
      let old = oldLines;
      let next = newLines;
      while (i < lines.length) {
        const body = lines[i]!;
        if (body.startsWith("\\")) hunk.lines.push(body);
        else if (old === 0 && next === 0) break;
        else if (body.startsWith("-")) { old--; patch.removed++; hunk.lines.push(body); }
        else if (body.startsWith("+")) { next--; patch.added++; hunk.lines.push(body); }
        else if (body.startsWith(" ") || body === "") { old--; next--; hunk.lines.push(` ${body.slice(1)}`); }
        else break;
        i++;
      }
      patch.hunks.push(hunk);
    } else if (line.startsWith("new file mode")) patch.status = "added";
    else if (line.startsWith("deleted file mode")) patch.status = "deleted";
    else if (line.startsWith("rename from ")) { patch.oldPath = line.slice("rename from ".length); patch.status = "renamed"; }
    else if (line.startsWith("rename to ")) patch.path = line.slice("rename to ".length);
    else if (line.startsWith("Binary files ")) patch.binary = true;
    else if (line.startsWith("+++ b/")) patch.path = line.slice("+++ b/".length);
    else if (line.startsWith("--- a/") && patch.status === "deleted") patch.path = line.slice("--- a/".length);
  }
  return patches;
}

/**
 * The path from a `diff --git a/<old> b/<new>` header's rest: `<new>`, read as the two halves when they match. jj
 * writes paths as they are, never quoted.
 */
function headerPath(rest: string): string {
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest.slice(2, half) === rest.slice(half + 3)) return rest.slice(half + 3);
  const b = rest.lastIndexOf(" b/");
  return b >= 0 ? rest.slice(b + 3) : rest;
}
