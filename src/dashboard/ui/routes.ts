// The dashboard's views and their location hashes. Pure: no Preact, no DOM.

export type View = { name: "pool" } | { name: "task"; nodeId: string; id: string } | { name: "projects" } | { name: "settings" };

/** The view a location hash names (`#/task/<nodeId>/<taskId>`, `#/projects`, `#/settings`), the pool otherwise (a malformed escape included). */
export function viewOf(hash: string): View {
  const parts = hash.split("/");
  const [, name] = parts;
  if (name === "task" && parts.length === 4) {
    const [, , nodeId, id] = parts;
    if (nodeId !== "" && id !== "") {
      try {
        return { name: "task", nodeId: decodeURIComponent(nodeId!), id: decodeURIComponent(id!) };
      } catch {
        // A malformed escape (`%zz`): no task, the pool.
      }
    }
  }
  if (name === "projects" || name === "settings") return { name };
  return { name: "pool" };
}

/** Opens a task of a node of the pool. */
export type Open = (nodeId: string, taskId: string) => void;

export function hashOf(view: View): string {
  return view.name === "task" ? `#/task/${encodeURIComponent(view.nodeId)}/${encodeURIComponent(view.id)}` : `#/${view.name}`;
}
