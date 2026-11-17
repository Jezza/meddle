// What the Changes view says about a task's changes. Pure: no Preact, no DOM.
import type { ProjectChanges, TaskChange } from "../../tasks/changes";
import type { FilePatch } from "./git-diff";

/** The non-empty changes of every project: the count beside `Changes`. */
export function changeCount(projects: readonly ProjectChanges[]): number {
  return projects.reduce((n, p) => n + p.changes.filter((c) => !c.empty).length, 0);
}

/** `n changes`, n the project's non-empty changes: the summary line's start, ` on <start>` and the files drawn after it. */
export function summary(p: ProjectChanges): string {
  const n = p.changes.filter((c) => !c.empty).length;
  return `${n} ${n === 1 ? "change" : "changes"}`;
}

/**
 * A short hash of a file's patch (its hunks, status and old path): the same for the same patch, so that a file's
 * diff read again unchanged keeps what was opened in it. FNV-1a, 32 bits.
 */
export function patchHash(patch: FilePatch): string {
  const text = JSON.stringify([patch.status, patch.oldPath ?? null, patch.hunks]);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

/** A diff's file count and lines added and removed. */
export function totals(patches: readonly FilePatch[]): { files: number; added: number; removed: number } {
  return patches.reduce((t, f) => ({ files: t.files + 1, added: t.added + f.added, removed: t.removed + f.removed }), { files: 0, added: 0, removed: 0 });
}

/**
 * A row of the file tree: a folder, named for the folders it runs on through while each holds only the next
 * (`dashboard/ui`) and with its whole path; or a file, by its name.
 */
export type FileNode =
  | { kind: "dir"; name: string; path: string; children: FileNode[] }
  | { kind: "file"; name: string; patch: FilePatch };

/** A diff's files as a tree: in each folder its folders first, then its files, each by name, case aside. */
export function fileTree(patches: readonly FilePatch[]): FileNode[] {
  type Dir = { dirs: Map<string, Dir>; files: FilePatch[] };
  const root: Dir = { dirs: new Map(), files: [] };
  for (const patch of patches) {
    let dir = root;
    for (const part of patch.path.split("/").slice(0, -1)) {
      let sub = dir.dirs.get(part);
      if (sub === undefined) dir.dirs.set(part, sub = { dirs: new Map(), files: [] });
      dir = sub;
    }
    dir.files.push(patch);
  }
  const nodes = (dir: Dir, prefix: string): FileNode[] => [
    ...[...dir.dirs].sort(([a], [b]) => byName(a, b)).map(([part, sub]): FileNode => {
      let name = part;
      while (sub.files.length === 0 && sub.dirs.size === 1) {
        const [next, only] = sub.dirs.entries().next().value!;
        name += `/${next}`;
        sub = only;
      }
      return { kind: "dir", name, path: prefix + name, children: nodes(sub, `${prefix + name}/`) };
    }),
    ...dir.files.map((patch): FileNode => ({ kind: "file", name: patch.path.slice(prefix.length), patch }))
      .sort((a, b) => byName(a.name, b.name)),
  ];
  return nodes(root, "");
}

/** A tree's files top to bottom: the order their diffs are drawn in. */
export function treeFiles(nodes: readonly FileNode[]): FilePatch[] {
  return nodes.flatMap((n) => n.kind === "dir" ? treeFiles(n.children) : [n.patch]);
}

function byName(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0;
}

/** A change's row label: `Working copy`, else its description's first line, else its short change id. */
export function changeLabel(c: TaskChange): string {
  if (c.workingCopy) return "Working copy";
  return c.description.split("\n")[0]!.trim() || c.change.slice(0, 8);
}
