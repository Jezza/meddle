// How the synced scopes stand on this node, as `meddle status` prints them from the database alone (the node may be
// down): the profile always, a project's memory only when it is not in step. A scope is behind a peer whose admitted
// head is another commit than this node's, or whose head waits for its commit; a head of other merge rules says so.
import type { HeadRow } from "../pool/heads";
import { RULE_VERSION } from "./merge-file";
import { parseScopeKey } from "./scope";

export type Standing = "legacy" | "seed" | "pool" | "none";

/** Status lines for the scopes `rows` (admitted) and `waiting` name, this node being `self`. */
export function scopeLines(
  rows: readonly HeadRow[], waiting: readonly HeadRow[], self: string, profile: Standing,
  names: { node(id: string): string; project(id: string): string | null },
): string[] {
  const keys = [...new Set([...rows, ...waiting].map((r) => r.scope))].sort((a, b) => (a === "profile" ? -1 : b === "profile" ? 1 : a < b ? -1 : 1));
  const lines: string[] = [];
  if (profile === "legacy") lines.push("profile legacy (meddle profile import makes one the pool's)");
  else if (profile === "none") lines.push("profile none");
  for (const key of keys) {
    const scope = parseScopeKey(key);
    if (scope === null || (scope.kind === "profile" && (profile === "legacy" || profile === "none"))) continue;
    const mine = rows.find((r) => r.scope === key && r.node === self)?.commit ?? null;
    const behind = new Map<string, boolean>();
    for (const r of rows) if (r.scope === key && r.node !== self && r.commit !== null && (r.commit !== mine || r.rule !== RULE_VERSION)) behind.set(r.node, r.rule !== RULE_VERSION);
    for (const r of waiting) if (r.scope === key && r.node !== self && !behind.has(r.node)) behind.set(r.node, r.rule !== RULE_VERSION);
    const label = scope.kind === "profile" ? "profile" : `memory ${names.project(scope.projectId) ?? scope.projectId.slice(0, 10)}`;
    if (behind.size === 0) {
      if (scope.kind === "profile") lines.push("profile in step");
      continue;
    }
    const who = [...behind.keys()].sort().map(names.node).join(", ");
    lines.push(`${label} behind ${who}${[...behind.values()].every((other) => other) ? " (other merge rules)" : ""}`);
  }
  if (profile !== "legacy" && profile !== "none" && !keys.includes("profile")) lines.unshift("profile in step");
  return lines;
}
