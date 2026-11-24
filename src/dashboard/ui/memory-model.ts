// What the Project page's Memory and History sections decide without a DOM: which node to read memory from, who a
// change of the history was, why a write was refused, and an entry's text without its frontmatter.
import { isMemoryPath, remoteReason } from "../../projects/memory-names";
import type { MemoryChange } from "../../projects/memory-view";

/**
 * Where memory is read from and written to: this node when it holds the project, else the first online holder (every
 * holder's memory is the pool's, kept in step); null when no node holding the project is online.
 */
export function memorySource(self: string, holders: readonly string[], online: readonly string[]): { nodeId: string; editable: boolean } | null {
  if (holders.includes(self)) return { nodeId: self, editable: true };
  const holder = holders.find((h) => online.includes(h));
  return holder === undefined ? null : { nodeId: holder, editable: true };
}

/** Who made a change: a task (its title, or its id when unknown here), the dashboard, an import; "" for anything else. */
export function changeWho(c: MemoryChange, taskTitle: (id: string) => string | null): { label: string; taskId: string | null } {
  if (c.kind === "task" && c.task !== null) return { label: taskTitle(c.task) ?? c.task, taskId: c.task };
  if (c.kind === "dashboard") return { label: "Dashboard", taskId: null };
  if (c.kind === "import") return { label: "Imported", taskId: null };
  return { label: "", taskId: null };
}

/** The word a refused write shows beside `Save`: the file changed since it was opened. */
export function writeError(err: unknown): "Changed" | null {
  return remoteReason(err).startsWith("changed:") ? "Changed" : null;
}

/** Whether a read failed because the node holds no memory repo of the project (nothing to show). */
export function noMemoryRepo(err: unknown): boolean {
  return remoteReason(err).startsWith("no-repo:");
}

/** `text` without the `---` block at its top (a block never closed is kept). */
export function stripFrontmatter(text: string): string {
  const m = /^---[ \t]*\r?\n(?:.*\r?\n)*?---[ \t]*(?:\r?\n|$)/.exec(text);
  return m === null ? text : text.slice(m[0].length);
}

/** Whether `New` may save as `name`: a memory file's name that no listed entry has (a listed one is edited instead). */
export function canSaveNew(name: string, listed: readonly string[]): boolean {
  return isMemoryPath(name) && !listed.includes(name);
}

/** History rows as loaded: newest first, and whether `Older` has more below them. */
export type HistoryRows = { list: MemoryChange[]; more: boolean };

/**
 * The rows after reading the first page (`size` changes) again: that page on top, then the loaded rows below its
 * last change, so rows already open or paged in stay. A short page is the whole history; a page whose last change
 * was never loaded replaces what was.
 */
export function mergeFirstPage(loaded: HistoryRows | null, first: MemoryChange[], size: number): HistoryRows {
  if (first.length < size) return { list: first, more: false };
  const at = loaded?.list.findIndex((c) => c.change === first.at(-1)!.change) ?? -1;
  if (loaded === null || at < 0) return { list: first, more: true };
  return { list: [...first, ...loaded.list.slice(at + 1)], more: loaded.more };
}
