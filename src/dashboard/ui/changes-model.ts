// What the Changes view says about a task's changes. Pure: no Preact, no DOM.
import type { ProjectChanges, TaskChange } from "../../tasks/changes";
import type { FilePatch } from "./git-diff";

/** The non-empty changes of every project: the count beside `Changes`. */
export function changeCount(projects: readonly ProjectChanges[]): number {
  return projects.reduce((n, p) => n + p.changes.filter((c) => !c.empty).length, 0);
}

/** `n changes on <start>`, n the project's non-empty changes; the files and `+n −n` are drawn beside it. */
export function summary(p: ProjectChanges): string {
  const n = p.changes.filter((c) => !c.empty).length;
  return `${n} ${n === 1 ? "change" : "changes"} on ${p.start}`;
}

/** A diff's file count and lines added and removed. */
export function totals(patches: readonly FilePatch[]): { files: number; added: number; removed: number } {
  return patches.reduce((t, f) => ({ files: t.files + 1, added: t.added + f.added, removed: t.removed + f.removed }), { files: 0, added: 0, removed: 0 });
}

/** A change's row label: `Working copy`, else its description's first line, else its short change id. */
export function changeLabel(c: TaskChange): string {
  if (c.workingCopy) return "Working copy";
  return c.description.split("\n")[0]!.trim() || c.change.slice(0, 8);
}
