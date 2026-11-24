// A scope: one directory synced across the pool. The profile (one per pool) or a project's memory (one per project).
// Each node holds it as a jj repo (`repo.ts`) whose bookmark is the node's head, published as a head row
// (`src/pool/heads.ts`) under the scope's key.
import type { NodeConfig } from "../config";
import { paths } from "../paths";

export type Scope = { kind: "profile" } | { kind: "memory"; projectId: string };

/** A project id as a scope key may carry it: what `SAFE_ID` admits. */
const PROJECT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The scope's key: `profile`, or `memory/<project id>`. */
export function scopeKey(s: Scope): string {
  return s.kind === "profile" ? "profile" : `memory/${s.projectId}`;
}

/** The scope a key names, or null for anything else. */
export function parseScopeKey(key: string): Scope | null {
  if (key === "profile") return { kind: "profile" };
  const match = /^memory\/(.+)$/.exec(key);
  return match !== null && PROJECT_ID.test(match[1]!) ? { kind: "memory", projectId: match[1]! } : null;
}

/** The bookmark a node's head of the scope is. */
export function scopeBookmark(s: Scope): "profile" | "memory" {
  return s.kind;
}

/** Where the scope's repo is on this node. */
export function scopeDir(cfg: NodeConfig, s: Scope): string {
  return s.kind === "profile" ? paths(cfg).profile : paths(cfg).memory(s.projectId);
}

/** The project of a memory scope, else null. */
export function scopeProject(s: Scope): string | null {
  return s.kind === "memory" ? s.projectId : null;
}

/** How a scope stands on a node: its head, how many peer heads are not merged yet, and why each waits. */
export type ScopeState = {
  scope: string;
  head: string | null;
  behind: number;
  waiting: Array<{ node: string; why: "fetch" | "rule" | "seed" }>;
};
