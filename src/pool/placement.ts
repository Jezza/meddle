// Where a new task runs: pure, from what the roster says of each node (decision 6: never by asking a peer).
import type { RosterRow } from "./store";

/** A node a new task could run on, as placement sees it. `limit` 0 is no limit. */
export type Candidate = {
  nodeId: string;
  online: boolean;
  hostsTasks: boolean;
  running: number;
  taskCount: number;
  projects: { id: string; home: string }[];
  limit: number;
};

/** The task's projects (the first is the primary) and the nodes it could run on. */
export type PlacementInput = { projectIds: string[]; nodes: Candidate[] };

/** This node as placement sees it: its own numbers, live rather than as last reported. */
export type SelfCandidate = Omit<Candidate, "online">;

/**
 * The candidates for a new task: every other member of the roster as its last summary says (a summary from an older
 * meddle has no `running`, `limit` or `projects`: 0, 0 and []; a member never heard from hosts no tasks), online as
 * `isOnline` says, then this node, always online, with its live numbers. A member `isGone` says is gone is left out
 * altogether: its work counts as lost, so neither its load nor the projects it holds (nor its word on where they
 * live) weigh in.
 */
export function placementCandidates(
  rows: RosterRow[], isOnline: (id: string) => boolean, self: SelfCandidate, isGone: (id: string) => boolean = () => false,
): Candidate[] {
  const others = rows
    .filter((r) => r.nodeId !== self.nodeId && r.status === "member" && !isGone(r.nodeId))
    .map((r): Candidate => {
      const s = r.summary;
      return {
        nodeId: r.nodeId,
        online: isOnline(r.nodeId),
        hostsTasks: s?.hostsTasks ?? false,
        running: s?.running ?? 0,
        taskCount: s?.taskCount ?? 0,
        projects: (s?.projects ?? []).map((p) => ({ id: p.id, home: p.home })),
        limit: s?.limit ?? 0,
      };
    });
  return [...others, { ...self, online: true }];
}

/** Fewest running, then fewest tasks, then the smaller id. */
function byLoad(a: Candidate, b: Candidate): number {
  return a.running - b.running || a.taskCount - b.taskCount || (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0);
}

/**
 * The node a new task runs on. Only an online node with a task root and room under its running limit can take it. Of
 * those: the primary project's home; else the least loaded of the nodes holding every project; else the least loaded
 * (`byLoad`). A project's home is what any candidate's `projects` says of it, the home's own word first. With no
 * projects only the load counts.
 */
export function place(input: PlacementInput): { nodeId: string } | { error: string } {
  const homes = new Map<string, string>();
  for (const n of input.nodes) {
    for (const p of n.projects) if (!homes.has(p.id) || p.home === n.nodeId) homes.set(p.id, p.home);
  }
  const hosting = input.nodes.filter((n) => n.online && n.hostsTasks);
  if (hosting.length === 0) return { error: "no online node hosts tasks" };
  const open = hosting.filter((n) => n.limit === 0 || n.running < n.limit);
  if (open.length === 0) return { error: "every node is at its running limit" };
  const primary = input.projectIds[0];
  if (primary !== undefined) {
    const home = open.find((n) => n.nodeId === homes.get(primary));
    if (home !== undefined) return { nodeId: home.nodeId };
    const holders = open.filter((n) => input.projectIds.every((id) => n.projects.some((p) => p.id === id)));
    if (holders.length > 0) return { nodeId: holders.sort(byLoad)[0]!.nodeId };
  }
  return { nodeId: [...open].sort(byLoad)[0]!.nodeId };
}
