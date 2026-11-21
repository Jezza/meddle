// The dashboard's views and their location hashes. Pure: no Preact, no DOM.

/** A project page's column a narrow pane shows, its graph when none is named. */
export type ProjectTab = "memory" | "tasks";

export type View =
  /** Nothing chosen: the first task waiting on you, else a new task. */
  | { name: "home" }
  /** A task: its thread, or with `tab`, its changes. */
  | { name: "task"; nodeId: string; id: string; tab?: "changes" }
  /** A new task: in one project, or (null) with none chosen yet. */
  | { name: "new"; projectId: string | null }
  /** A project: its graph, memory and tasks side by side; with `tab`, the one a narrow pane shows (else its graph). */
  | { name: "project"; id: string; tab?: ProjectTab }
  | { name: "add-project" }
  | { name: "node"; nodeId: string }
  /** A project's merge train, watch-only; with `task`, that queued task's row highlighted. */
  | { name: "train"; projectId: string; task?: string }
  | { name: "settings" };

/**
 * The view a location hash names (`#/task/<nodeId>/<taskId>[/changes]`, `#/new[/<projectId>]`,
 * `#/project/<id>[/memory|/tasks]`, `#/projects/add`, `#/node/<nodeId>`, `#/train/<projectId>[/<taskId>]`,
 * `#/settings`), home otherwise (a malformed escape included).
 */
export function viewOf(hash: string): View {
  let parts: string[];
  try {
    parts = hash.split("/").map((p) => decodeURIComponent(p));
  } catch {
    return { name: "home" }; // a malformed escape (`%zz`)
  }
  const [, name, a, b] = parts;
  const given = (s: string | undefined): s is string => s !== undefined && s !== "";
  if (name === "task" && parts.length === 4 && given(a) && given(b)) return { name: "task", nodeId: a, id: b };
  if (name === "task" && parts.length === 5 && given(a) && given(b) && parts[4] === "changes") return { name: "task", nodeId: a, id: b, tab: "changes" };
  if (name === "new" && parts.length === 2) return { name: "new", projectId: null };
  if (name === "new" && parts.length === 3 && given(a)) return { name: "new", projectId: a };
  if (name === "project" && parts.length === 3 && given(a)) return { name: "project", id: a };
  if (name === "project" && parts.length === 4 && given(a) && (b === "memory" || b === "tasks")) return { name: "project", id: a, tab: b };
  if (name === "projects" && a === "add" && parts.length === 3) return { name: "add-project" };
  if (name === "node" && parts.length === 3 && given(a)) return { name: "node", nodeId: a };
  if (name === "train" && parts.length === 3 && given(a)) return { name: "train", projectId: a };
  if (name === "train" && parts.length === 4 && given(a) && given(b)) return { name: "train", projectId: a, task: b };
  if (name === "settings" && parts.length === 2) return { name: "settings" };
  return { name: "home" };
}

/** Opens a task of a node of the pool. */
export type Open = (nodeId: string, taskId: string) => void;

export function hashOf(view: View): string {
  const e = encodeURIComponent;
  switch (view.name) {
    case "home": return "#/";
    case "task": return `#/task/${e(view.nodeId)}/${e(view.id)}${view.tab === "changes" ? "/changes" : ""}`;
    case "new": return view.projectId === null ? "#/new" : `#/new/${e(view.projectId)}`;
    case "project": return `#/project/${e(view.id)}${view.tab === undefined ? "" : `/${view.tab}`}`;
    case "add-project": return "#/projects/add";
    case "node": return `#/node/${e(view.nodeId)}`;
    case "train": return `#/train/${e(view.projectId)}${view.task === undefined ? "" : `/${e(view.task)}`}`;
    case "settings": return "#/settings";
  }
}
