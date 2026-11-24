// Pure: the dashboard bundle imports it too.

/** The task id a `SendMessage`'s `to` names (a task's 12 hex, a trailing ` [ref]` dropped), or null for anything else. */
export function taskTarget(to: unknown): string | null {
  if (typeof to !== "string") return null;
  const bare = to.trim().replace(/\s*\[[0-9a-f]+\]$/, "");
  return /^[0-9a-f]{12}$/.test(bare) ? bare : null;
}
