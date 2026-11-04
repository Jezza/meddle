// The dashboard's views and their location hashes. Pure: no Preact, no DOM.

export type View =
  /** Nothing chosen: the first task waiting on you, else a new task. */
  | { name: "home" }
  | { name: "task"; nodeId: string; id: string }
  /** A new task: in one project, or (null) with none chosen yet. */
  | { name: "new"; projectId: string | null }
  | { name: "project"; id: string }
  | { name: "add-project" }
  | { name: "node"; nodeId: string }
  | { name: "settings" };

/**
 * The view a location hash names (`#/task/<nodeId>/<taskId>`, `#/new[/<projectId>]`, `#/project/<id>`,
 * `#/projects/add`, `#/node/<nodeId>`, `#/settings`), home otherwise (a malformed escape included).
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
  if (name === "new" && parts.length === 2) return { name: "new", projectId: null };
  if (name === "new" && parts.length === 3 && given(a)) return { name: "new", projectId: a };
  if (name === "project" && parts.length === 3 && given(a)) return { name: "project", id: a };
  if (name === "projects" && a === "add" && parts.length === 3) return { name: "add-project" };
  if (name === "node" && parts.length === 3 && given(a)) return { name: "node", nodeId: a };
  if (name === "settings" && parts.length === 2) return { name: "settings" };
  return { name: "home" };
}

/** Opens a task of a node of the pool. */
export type Open = (nodeId: string, taskId: string) => void;

export function hashOf(view: View): string {
  const e = encodeURIComponent;
  switch (view.name) {
    case "home": return "#/";
    case "task": return `#/task/${e(view.nodeId)}/${e(view.id)}`;
    case "new": return view.projectId === null ? "#/new" : `#/new/${e(view.projectId)}`;
    case "project": return `#/project/${e(view.id)}`;
    case "add-project": return "#/projects/add";
    case "node": return `#/node/${e(view.nodeId)}`;
    case "settings": return "#/settings";
  }
}
