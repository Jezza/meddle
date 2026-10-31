// Whether Settings lets this node join another pool, and what it says about it. Pure: no Preact, no DOM.

export type JoinState = { blocked: boolean; hint: string | null };

/**
 * As `joinPool` decides it: only a node that is itself a member and shares its pool with other members is blocked. A
 * node removed from its pool is in no pool with anyone, however many members its roster still lists, and may join.
 */
export function joinStateOf(nodes: readonly { nodeId: string; status: "member" | "removed" }[], selfId: string): JoinState {
  const self = nodes.find((n) => n.nodeId === selfId);
  if (self?.status === "removed") {
    return { blocked: false, hint: "This node was removed from its pool; paste a new ticket to join again." };
  }
  const othersPresent = self?.status === "member" && nodes.some((n) => n.status === "member" && n.nodeId !== selfId);
  return othersPresent
    ? { blocked: true, hint: "This node already shares a pool with other members; remove them first to join another." }
    : { blocked: false, hint: null };
}
