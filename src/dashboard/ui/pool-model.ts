// What the pool-wide views compute from their objects' values. Pure: no Preact, no DOM.
import { branchText, siblingRef, type ProjectBranch } from "../../projects/branches";

/** What a move target is chosen by: a row of `PoolObject.nodes`. */
export type MoveCandidate = {
  nodeId: string;
  status: "member" | "removed";
  online: boolean;
  hostsTasks: boolean;
  claudeCodeVersion: string;
};

/** A version that says nothing (a compiled binary reports `unknown`; a node with no summary yet, ""). */
function unknownVersion(version: string): boolean {
  return version === "unknown" || version === "";
}

/**
 * The nodes a task on node `from` (running Claude Code `version`) can move to: other online members that host tasks
 * and run the same, known, Claude Code version (decision 16).
 */
export function moveTargets<N extends MoveCandidate>(nodes: readonly N[], from: string, version: string): N[] {
  if (unknownVersion(version)) return [];
  return nodes.filter((n) => n.nodeId !== from && n.status === "member" && n.online && n.hostsTasks && n.claudeCodeVersion === version);
}

/** A project as a node's summary lists it (`PoolObject.nodes[].projects`). */
export type ListedProject = { id: string; name: string; home: string };

/** What the projects a new task can work in are read from: a row of `PoolObject.nodes`. */
export type ProjectLister = { nodeId: string; status: "member" | "removed"; online: boolean; projects: readonly ListedProject[] };

/**
 * The projects a new task can work in: every project an online member lists, one per id, named as its home lists it
 * (another holder's entry when the home lists nothing), by name then id.
 */
export function projectChoices(nodes: readonly ProjectLister[]): ListedProject[] {
  /** Each id's entry, and whether it is the home's own. */
  const byId = new Map<string, { project: ListedProject; fromHome: boolean }>();
  for (const n of nodes) {
    if (n.status !== "member" || !n.online) continue;
    for (const p of n.projects) {
      const fromHome = p.home === n.nodeId;
      const known = byId.get(p.id);
      if (known === undefined || (fromHome && !known.fromHome)) byId.set(p.id, { project: { id: p.id, name: p.name, home: p.home }, fromHome });
    }
  }
  return [...byId.values()].map((e) => e.project).sort((x, y) => x.name.localeCompare(y.name) || x.id.localeCompare(y.id));
}

/** A bookmark of a project's replica, as `ProjectObject.heads` carries it. */
export type Head = { name: string; remote: string | null; changeId: string; conflicted: boolean };

/** One node's copy of a project, with its branches as that node computes them (`ProjectObject.branches`). */
export type HeldProject = {
  nodeId: string; id: string; name: string; home: string; defaultBranch: string | null;
  heads: readonly Head[]; branches: readonly ProjectBranch[]; contextLoaded: boolean;
};

export type Holder = { nodeId: string; heads: readonly Head[]; contextLoaded: boolean };

/** A project across the pool: the nodes holding a copy of it, and its branches as one of them computes them. */
export type PoolProject = {
  id: string; name: string; home: string; defaultBranch: string | null; branches: readonly ProjectBranch[]; holders: Holder[];
};

/**
 * One row per project id, by name (then id); its name, home, default branch and branches are the home's copy's
 * (another holder's when the home's is not among them; every node computes the same branches once it has the same
 * rows), its holders in `nodeOrder`.
 */
export function mergeProjects(held: readonly HeldProject[], nodeOrder: readonly string[]): PoolProject[] {
  const rank = (nodeId: string) => {
    const i = nodeOrder.indexOf(nodeId);
    return i < 0 ? nodeOrder.length : i;
  };
  const byId = new Map<string, HeldProject[]>();
  for (const p of held) byId.set(p.id, [...(byId.get(p.id) ?? []), p]);
  const rows: PoolProject[] = [];
  for (const [id, copies] of byId) {
    copies.sort((x, y) => rank(x.nodeId) - rank(y.nodeId));
    const named = copies.find((c) => c.nodeId === c.home) ?? copies[0]!;
    rows.push({
      id,
      name: named.name,
      home: named.home,
      defaultBranch: named.defaultBranch,
      branches: named.branches,
      holders: copies.map((c) => ({ nodeId: c.nodeId, heads: c.heads, contextLoaded: c.contextLoaded })),
    });
  }
  return rows.sort((x, y) => x.name.localeCompare(y.name) || x.id.localeCompare(y.id));
}

/** `name` (local) or `name@remote`, then the change's short id or `(conflicted)`. */
export function headText(head: Head): string {
  const where = head.remote === null ? head.name : `${head.name}@${head.remote}`;
  return `${where} ${head.conflicted ? "(conflicted)" : head.changeId.slice(0, 8)}`;
}

/** A branch as the project page lists it: `text` says where it is; a conflicted one names its `siblings`. */
export type BranchLine = { name: string; isDefault: boolean; conflicted: boolean; text: string; siblings: string[] };

/**
 * The project's branches as its page lists them: the default branch first, then by name. A conflicted branch is
 * marked, with its siblings as a checkout fetches them (`meddle/conflict/<b>/<id>@meddle`).
 */
export function branchLines(branches: readonly ProjectBranch[], defaultBranch: string | null): BranchLine[] {
  const lines = branches.map((b): BranchLine => {
    const siblings = b.siblings.map((s) => siblingRef(b.name, s));
    return { name: b.name, isDefault: b.name === defaultBranch, conflicted: b.state === "conflicted", text: branchText(b), siblings };
  });
  return lines.sort((x, y) => Number(y.isDefault) - Number(x.isDefault) || (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
}
