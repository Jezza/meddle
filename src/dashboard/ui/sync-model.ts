// What a node's page says of its synced scopes without a DOM: a row for each scope not in step with the pool, by what it
// waits on; nothing for one that is.
import type { ScopeState } from "../../scopes/scope";

/** The rows for `scopes`: `Profile` or `Memory of <project>`, and how far behind or what it waits for. */
export function syncRows(
  scopes: readonly ScopeState[], nodeName: (id: string) => string, projectName: (id: string) => string | null,
): Array<{ label: string; text: string }> {
  const rows: Array<{ label: string; text: string }> = [];
  for (const s of scopes) {
    const fetch = s.waiting.filter((w) => w.why === "fetch").map((w) => nodeName(w.node));
    const rule = s.waiting.filter((w) => w.why === "rule").map((w) => nodeName(w.node));
    const parts = [
      ...(s.behind > 0 ? [`${s.behind} behind`] : []),
      ...(fetch.length > 0 ? [`waiting for ${fetch.join(", ")}`] : []),
      ...(rule.length > 0 ? [`other merge rules: ${rule.join(", ")}`] : []),
    ];
    if (parts.length === 0) continue;
    const id = s.scope.startsWith("memory/") ? s.scope.slice("memory/".length) : null;
    rows.push({ label: id === null ? "Profile" : `Memory of ${projectName(id) ?? id}`, text: parts.join(" · ") });
  }
  return rows;
}
