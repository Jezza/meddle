// A project's graph as the Project page draws it: every online node's read merged into rows, each bookmark labelled
// with the nodes that have it there, and the lanes laid out. Pure: no Preact, no DOM.
import type { GraphBookmark, GraphCommit } from "../../projects/graph";

export type NodeGraph = { nodeId: string; graph: readonly GraphCommit[] };

/**
 * A bookmark at a row's commit: `nodes`, the nodes with it here, in input order; `behind`, how many commits its
 * furthest position (another node's) is ahead; `notPushed`, when only one of several loaded nodes has this commit and
 * no other has the bookmark anywhere.
 */
export type Label = { bookmark: GraphBookmark; nodes: string[]; behind: number | null; notPushed: boolean };

/** `commit.bookmarks` are only one node's: `labels` are every node's. */
export type Row = { commit: GraphCommit; labels: Label[] };

/** Every commit once, children before parents and, among those ready, newest first. */
export function mergeGraphs(nodes: readonly NodeGraph[]): Row[] {
  const byId = new Map<string, GraphCommit>();
  const holders = new Map<string, number>();
  // Per bookmark (by key), the nodes with it at each commit.
  const marks = new Map<string, { bookmark: GraphBookmark; at: Map<string, string[]> }>();
  for (const { nodeId, graph } of nodes) {
    for (const c of graph) {
      if (!byId.has(c.commit)) byId.set(c.commit, c);
      holders.set(c.commit, (holders.get(c.commit) ?? 0) + 1);
      for (const bookmark of c.bookmarks) {
        const key = JSON.stringify(bookmark);
        const mark = marks.get(key) ?? { bookmark, at: new Map<string, string[]>() };
        marks.set(key, mark);
        const at = mark.at.get(c.commit) ?? [];
        if (!at.includes(nodeId)) at.push(nodeId);
        mark.at.set(c.commit, at);
      }
    }
  }

  // A node whose graph is not read yet must not make every commit look unpushed.
  const loaded = nodes.filter((n) => n.graph.length > 0).length;
  const order = topoOrder(byId);
  const ancestors = ancestry(byId);
  const labels = new Map<string, Label[]>(order.map((c) => [c.commit, []]));
  for (const { bookmark, at } of marks.values()) {
    for (const [commit, holding] of at) {
      const mine = ancestors(commit);
      let behind: number | null = null;
      for (const other of at.keys()) {
        if (other === commit || !ancestors(other).has(commit)) continue;
        let n = 0;
        for (const a of ancestors(other)) if (!mine.has(a)) n++;
        behind = Math.max(behind ?? 0, n);
      }
      const alone = holders.get(commit) === 1 && new Set([...at.values()].flat()).size === 1;
      labels.get(commit)!.push({ bookmark, nodes: holding, behind, notPushed: loaded > 1 && alone });
    }
  }
  return order.map((commit) => ({ commit, labels: labels.get(commit.commit)! }));
}

/** Children before parents; among the commits whose children are all placed, the newest, then the lowest id. */
function topoOrder(byId: ReadonlyMap<string, GraphCommit>): GraphCommit[] {
  const pending = new Map<string, number>([...byId.keys()].map((id) => [id, 0]));
  for (const c of byId.values()) for (const p of new Set(c.parents)) if (pending.has(p)) pending.set(p, pending.get(p)! + 1);
  const ready = [...byId.values()].filter((c) => pending.get(c.commit) === 0);
  const out: GraphCommit[] = [];
  while (ready.length > 0) {
    let best = 0;
    for (let i = 1; i < ready.length; i++) {
      const a = ready[i]!, b = ready[best]!;
      if (a.time > b.time || (a.time === b.time && a.commit < b.commit)) best = i;
    }
    const c = ready.splice(best, 1)[0]!;
    out.push(c);
    for (const p of new Set(c.parents)) {
      if (!pending.has(p)) continue;
      pending.set(p, pending.get(p)! - 1);
      if (pending.get(p) === 0) ready.push(byId.get(p)!);
    }
  }
  return out;
}

/** A commit's ancestors-or-self within the merged graph, each worked out once. */
function ancestry(byId: ReadonlyMap<string, GraphCommit>): (commit: string) => ReadonlySet<string> {
  const memo = new Map<string, Set<string>>();
  return (commit) => {
    let seen = memo.get(commit);
    if (seen) return seen;
    seen = new Set<string>();
    const stack = [commit];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (seen.has(id) || !byId.has(id)) continue;
      seen.add(id);
      stack.push(...byId.get(id)!.parents);
    }
    memo.set(commit, seen);
    return seen;
  };
}

/** `⌂ a · b`, the nodes with a bookmark here, then ` · n behind` or ` · not pushed`. */
export function atText(label: Label, nodeName: (nodeId: string) => string): string {
  const at = `⌂ ${label.nodes.map(nodeName).join(" · ")}`;
  if (label.behind !== null) return `${at} · ${label.behind} behind`;
  return label.notPushed ? `${at} · not pushed` : at;
}

/**
 * One line drawn in a row: `through` a lane top to bottom; `up` top to the node and `down` node to bottom (its own
 * lane); `in` from a lane's top curving into the node (a child on that lane); `out` from the node curving to a lane's
 * bottom (a second parent on that lane); `stub` a short dashed line under the node, to a parent outside the graph.
 */
export type Seg = { kind: "through" | "up" | "down" | "in" | "out" | "stub"; lane: number };

export type Laid = { lane: number; segs: Seg[] };

/**
 * Each row's lane and lines, and the most lanes any row uses. Commits form chains along first parents: the default
 * branch's from its furthest position, then each commit continuing its first parent's chain if no older child has.
 * Chains take the leftmost lane free over their rows, oldest bottom first, and a head's chain holds its lane up to the
 * top row: so rows added at the top move no earlier commit.
 */
export function layoutLanes(rows: readonly Row[], defaultBranch: string | null): { rows: Laid[]; lanes: number } {
  const index = new Map(rows.map((r, i) => [r.commit.commit, i]));
  const firstParent = (i: number) => index.get(rows[i]!.commit.parents[0] ?? "");
  const chainOf: number[] = new Array(rows.length).fill(-1);
  const chains: number[][] = [];

  const head = defaultBranch === null ? -1
    : rows.findIndex((r) => r.labels.some((l) => l.bookmark.kind === "branch" && l.bookmark.name === defaultBranch));
  if (head >= 0) {
    const chain: number[] = [];
    for (let i: number | undefined = head; i !== undefined; i = firstParent(i)) {
      chainOf[i] = 0;
      chain.push(i);
    }
    chains.push(chain);
  }
  // Bottom up, so the oldest child continues: a new child never takes a chain from one already drawn. Chains are so
  // made oldest bottom first, after the default branch's.
  const continued = chainOf.map((k) => k === 0);
  for (let i = rows.length - 1; i >= 0; i--) {
    if (chainOf[i] !== -1) continue;
    const p = firstParent(i);
    if (p !== undefined && !continued[p]) {
      continued[p] = true;
      chainOf[i] = chainOf[p]!;
      chains[chainOf[i]!]!.unshift(i);
    } else {
      chainOf[i] = chains.length;
      chains.push([i]);
    }
  }

  // A second parent's line runs down its chain's lane, unless a newer commit of that chain is in the way: then it
  // takes a lane of its own, a detour.
  const merged = new Map<number, number>();
  const detours: Array<{ from: number; to: number }> = [];
  for (let i = 0; i < rows.length; i++) {
    for (const id of rows[i]!.commit.parents.slice(1)) {
      const j = index.get(id);
      if (j === undefined) continue;
      const chain = chains[chainOf[j]!]!;
      const newer = chain[chain.indexOf(j) - 1];
      if (newer === undefined) {
        if (!merged.has(j)) merged.set(j, i);
      } else if (newer > i) detours.push({ from: i, to: j });
    }
  }

  // A chain holds its lane from the top row (the default branch, or a top never merged), else from where its top is
  // merged; down to its bottom commit's first parent, where its line curves in.
  const held: Array<Array<{ from: number; to: number }>> = [];
  const take = (s: { from: number; to: number }) => {
    let lane = 0;
    while (held[lane]?.some((h) => h.from <= s.to && s.from <= h.to)) lane++;
    (held[lane] ??= []).push(s);
    return lane;
  };
  const laneOf = chains.map((chain, k) => take({
    from: k === 0 && head >= 0 ? 0 : merged.get(chain[0]!) ?? 0,
    to: firstParent(chain.at(-1)!) ?? chain.at(-1)!,
  }));
  const detourLane = new Map(detours.map((d) => [`${d.from} ${d.to}`, take(d)]));

  const laid: Laid[] = rows.map((_, i) => ({ lane: laneOf[chainOf[i]!]!, segs: [] }));
  const add = (i: number, kind: Seg["kind"], lane: number) => {
    if (!laid[i]!.segs.some((s) => s.kind === kind && s.lane === lane)) laid[i]!.segs.push({ kind, lane });
  };
  for (let i = 0; i < rows.length; i++) {
    const own = laid[i]!.lane;
    for (const [n, id] of rows[i]!.commit.parents.entries()) {
      const j = index.get(id);
      if (j === undefined) {
        add(i, "stub", own);
        continue;
      }
      const theirs = laid[j]!.lane;
      // A first parent's line runs down the child's lane and curves in; a second parent's curves out to the parent's
      // lane, or to its detour and in again.
      const lane = n === 0 ? own : detourLane.get(`${i} ${j}`) ?? theirs;
      add(i, lane === own ? "down" : "out", lane);
      for (let r = i + 1; r < j; r++) add(r, "through", lane);
      add(j, lane === theirs ? "up" : "in", lane);
    }
  }
  const lanes = laid.reduce((m, r) => Math.max(m, r.lane + 1, ...r.segs.map((s) => s.lane + 1)), 0);
  return { rows: laid, lanes };
}

/** Some commit's parent is not in `rows`: there is more to read below. */
export function hasOlder(rows: readonly Row[]): boolean {
  const ids = new Set(rows.map((r) => r.commit.commit));
  return rows.some((r) => r.commit.parents.some((p) => !ids.has(p)));
}
