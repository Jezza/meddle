// Where a new task's project starts, as the New task's start popover offers it: hints from the project's graph, matched
// to what was typed, and where to read that graph. Pure: no Preact, no DOM.
import type { GraphCommit } from "../../projects/graph";

/**
 * A start to offer: `commit`, and the `rev` a new task is created with to start there: null on the default branch's
 * commit (where a task starts anyway), else its first branch by name, else its commit id.
 */
export type StartHint = { commit: GraphCommit; rev: string | null; isDefault: boolean };

/** The most hints offered at once. */
export const HINTS_MAX = 8;

/** A row of `PoolObject.nodes` as far as where a project's starts are read from goes. */
export type StartLister = {
  nodeId: string; status: "member" | "removed"; online: boolean;
  projects: readonly { id: string; home: string; defaultBranch?: string | null }[];
};

const branchesOf = (c: GraphCommit) => c.bookmarks.flatMap((b) => (b.kind === "branch" ? [b.name] : [])).sort();
const tasksOf = (c: GraphCommit) => c.bookmarks.flatMap((b) => (b.kind === "task" ? [b.task] : []));

/** `commit` as a hint: the default branch's, a branch's, or a revision's. */
export function hintOf(commit: GraphCommit, defaultBranch: string | null): StartHint {
  const branches = branchesOf(commit);
  const isDefault = defaultBranch !== null && branches.includes(defaultBranch);
  return { commit, rev: isDefault ? null : branches[0] ?? commit.commit, isDefault };
}

/**
 * The hints for `query` in `graph`, at most `max`, one per commit. A blank query offers the commits a branch or a task's
 * line is on; else a commit matches (ignoring case) when a branch's name, its task's title (`title`) or its description
 * contains the query, or its change or commit id starts with it. The default branch's commit comes first, then those
 * with branches (by their first name), then those with lines, then the rest; newest first within each.
 */
export function startHints(
  graph: readonly GraphCommit[], query: string, defaultBranch: string | null, title: (task: string) => string | null, max = HINTS_MAX,
): StartHint[] {
  const q = query.trim().toLowerCase();
  const has = (text: string) => text.toLowerCase().includes(q);
  const matches = (c: GraphCommit) => q === ""
    ? c.bookmarks.length > 0
    : branchesOf(c).some(has) || tasksOf(c).some((t) => has(title(t) ?? "")) || has(c.description)
      || c.change.startsWith(q) || c.commit.startsWith(q);
  const rank = (h: StartHint) => (h.isDefault ? 0 : branchesOf(h.commit).length > 0 ? 1 : tasksOf(h.commit).length > 0 ? 2 : 3);
  const hints = graph.filter(matches).map((c) => hintOf(c, defaultBranch));
  return hints.sort((x, y) => rank(x) - rank(y)
    || (rank(x) === 1 ? branchesOf(x.commit)[0]!.localeCompare(branchesOf(y.commit)[0]!) : 0)
    || y.commit.time - x.commit.time).slice(0, max);
}

/**
 * `text` cut where it matches `query` (ignoring case, a blank one nowhere): at its start only when `prefix`, else its
 * first match. Each part says whether it is the match.
 */
export function marked(text: string, query: string, prefix: boolean): Array<{ text: string; hit: boolean }> {
  const q = query.trim().toLowerCase();
  const at = q === "" ? -1 : prefix ? (text.toLowerCase().startsWith(q) ? 0 : -1) : text.toLowerCase().indexOf(q);
  if (at < 0) return [{ text, hit: false }];
  const parts = [{ text: text.slice(0, at), hit: false }, { text: text.slice(at, at + q.length), hit: true }, { text: text.slice(at + q.length), hit: false }];
  return parts.filter((p) => p.text !== "");
}

/** The node to read project `projectId`'s starts from: its home while online and listing it, else the first that is. */
export function startSource(nodes: readonly StartLister[], selfId: string, projectId: string): string | null {
  const listing = nodes.filter((n) => (n.nodeId === selfId || (n.status === "member" && n.online)) && n.projects.some((p) => p.id === projectId));
  const home = listing.find((n) => n.projects.some((p) => p.id === projectId && p.home === n.nodeId));
  return (home ?? listing[0])?.nodeId ?? null;
}

/** Project `projectId`'s default branch as its home lists it (another holder's listing while the home's has none). */
export function defaultBranchOf(nodes: readonly StartLister[], projectId: string): string | null {
  const listed = nodes.flatMap((n) => n.projects.filter((p) => p.id === projectId).map((p) => ({ p, own: p.home === n.nodeId })));
  const known = listed.filter((l) => l.p.defaultBranch != null).sort((x, y) => Number(y.own) - Number(x.own));
  return known[0]?.p.defaultBranch ?? null;
}
