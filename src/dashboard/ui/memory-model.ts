// What the Project page's Memory and History sections decide without a DOM: which node to read memory from, who a
// change of the history was, why a write was refused, and an entry's text without its frontmatter.
import type { MemoryChange } from "../../projects/memory-view";

/**
 * Where memory is read from: the project's home while it is online (writes go there), else the first online holder,
 * read-only; null when no node holding the project is online.
 */
export function memorySource(home: string, holders: readonly string[], online: readonly string[]): { nodeId: string; editable: boolean } | null {
  if (online.includes(home)) return { nodeId: home, editable: true };
  const holder = holders.find((h) => h !== home && online.includes(h));
  return holder === undefined ? null : { nodeId: holder, editable: false };
}

/** Who made a change: a task (its title, or its id when unknown here), the dashboard, an import; "" for anything else. */
export function changeWho(c: MemoryChange, taskTitle: (id: string) => string | null): { label: string; taskId: string | null } {
  if (c.kind === "task" && c.task !== null) return { label: taskTitle(c.task) ?? c.task, taskId: c.task };
  if (c.kind === "dashboard") return { label: "Dashboard", taskId: null };
  if (c.kind === "import") return { label: "Imported", taskId: null };
  return { label: "", taskId: null };
}

/** A refused memory write's reason, the error's message without chord's leading `<code>: ` (or `<code>/<reason>: `). */
function reasonOf(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && err.message.startsWith(code)) return err.message.replace(/^[^:]*: /, "");
  return err.message;
}

/** The word a refused write shows beside `Save`: the file changed since it was opened, or a live turn is behind memory. */
export function writeError(err: unknown): "Changed" | "Busy" | null {
  const reason = reasonOf(err);
  if (reason.startsWith("changed:")) return "Changed";
  if (reason.startsWith("busy:")) return "Busy";
  return null;
}

/** Whether a read failed because the node holds no memory repo of the project (nothing to show). */
export function noMemoryRepo(err: unknown): boolean {
  return reasonOf(err).startsWith("no-repo:");
}

/** A memory file's name as the dashboard can write it (the pattern `isMemoryPath` checks on the node). */
export function isMemoryName(path: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(path);
}

/** `text` without the `---` block at its top (a block never closed is kept). */
export function stripFrontmatter(text: string): string {
  const m = /^---[ \t]*\r?\n(?:.*\r?\n)*?---[ \t]*(?:\r?\n|$)/.exec(text);
  return m === null ? text : text.slice(m[0].length);
}
