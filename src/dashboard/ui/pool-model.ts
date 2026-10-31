// What the pool-wide views compute from their objects' values. Pure: no Preact, no DOM.

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

/** A bookmark of a project's replica, as `ProjectObject.heads` carries it. */
export type Head = { name: string; remote: string | null; changeId: string; conflicted: boolean };

/** One node's copy of a project. */
export type HeldProject = { nodeId: string; id: string; name: string; home: string; heads: readonly Head[]; contextLoaded: boolean };

export type Holder = { nodeId: string; heads: readonly Head[]; contextLoaded: boolean };

/** A project across the pool: the nodes holding a copy of it. */
export type PoolProject = { id: string; name: string; home: string; holders: Holder[] };

/**
 * One row per project id, by name (then id); its name and home are the home's copy's (another holder's when the home's
 * is not among them), its holders in `nodeOrder`.
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
