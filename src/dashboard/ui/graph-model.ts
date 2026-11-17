// A project's graph as the Project page draws it: every online node's read merged into rows, each bookmark labelled
// with the nodes that have it there, and the lanes laid out. Pure: no Preact, no DOM.
import type { GraphBookmark, GraphCommit } from "../../projects/graph";

export type NodeGraph = { nodeId: string; graph: readonly GraphCommit[] };

/**
 * A bookmark at a row's commit: `nodes`, the nodes with it here, in input order; `behind`, how many commits its
 * furthest position (another node's) is ahead; `notPushed`, when only one of several nodes has this commit.
 */
export type Label = { bookmark: GraphBookmark; nodes: string[]; behind: number | null; notPushed: boolean };

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
      labels.get(commit)!.push({ bookmark, nodes: holding, behind, notPushed: nodes.length > 1 && holders.get(commit) === 1 });
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
 * branch's from its furthest position, then each commit continuing its first parent's chain if no newer child has.
 * Chains take the leftmost lane free over their rows, oldest bottom first, and a head's chain holds its lane up to the
 * top row: so rows added at the top move no earlier commit.
 */
export function layoutLanes(rows: readonly Row[], defaultBranch: string | null): { rows: Laid[]; lanes: number } {
  const index = new Map(rows.map((r, i) => [r.commit.commit, i]));
  const chainOf: number[] = new Array(rows.length).fill(-1);
  const chains: number[][] = [];

  const head = defaultBranch === null ? -1
    : rows.findIndex((r) => r.labels.some((l) => l.bookmark.kind === "branch" && l.bookmark.name === defaultBranch));
  if (head >= 0) {
    const chain: number[] = [];
    for (let i: number | undefined = head; i !== undefined; i = index.get(rows[i]!.commit.parents[0] ?? "")) {
      chainOf[i] = 0;
      chain.push(i);
    }
    chains.push(chain);
  }
  // Per row, whether any row has it as a parent, and the first row that has it as a second parent.
  const child: boolean[] = new Array(rows.length).fill(false);
  const merged: number[] = new Array(rows.length).fill(Infinity);
  for (let i = 0; i < rows.length; i++) {
    if (chainOf[i] === -1) {
      chainOf[i] = chains.length;
      chains.push([i]);
    }
    for (const [n, id] of rows[i]!.commit.parents.entries()) {
      const p = index.get(id);
      if (p === undefined) continue;
      child[p] = true;
      if (n > 0) merged[p] = Math.min(merged[p]!, i);
      // Rows run newest first, so the first child to get here is the newest.
      else if (chainOf[p] === -1) {
        chainOf[p] = chainOf[i]!;
        chains[chainOf[i]!]!.push(p);
      }
    }
  }

  // The rows a chain's lane is held over: from the top row for a head (and the default branch), else from its first
  // merging child; to its bottom commit's first parent, where its line curves in.
  const span = chains.map((chain, k) => {
    const top = chain[0]!, bottom = chain.at(-1)!;
    const from = !child[top] || (k === 0 && head >= 0) ? 0 : Math.min(top, ...chain.map((i) => merged[i]!));
    return { from, to: index.get(rows[bottom]!.commit.parents[0] ?? "") ?? bottom };
  });

  // The default branch first, then oldest bottom first.
  const byAge = chains.map((_, k) => k).sort((a, b) => (head >= 0 && (a === 0 || b === 0) ? a - b : chains[b]!.at(-1)! - chains[a]!.at(-1)!));
  const laneOf: number[] = new Array(chains.length).fill(0);
  const held: Array<Array<{ from: number; to: number }>> = [];
  for (const k of byAge) {
    const s = span[k]!;
    let lane = 0;
    while (held[lane]?.some((h) => h.from <= s.to && s.from <= h.to)) lane++;
    (held[lane] ??= []).push(s);
    laneOf[k] = lane;
  }

  const laid: Laid[] = rows.map((_, i) => ({ lane: laneOf[chainOf[i]!]!, segs: [] }));
  const add = (i: number, kind: Seg["kind"], lane: number) => {
    if (!laid[i]!.segs.some((s) => s.kind === kind && s.lane === lane)) laid[i]!.segs.push({ kind, lane });
  };
  for (let i = 0; i < rows.length; i++) {
    const own = laid[i]!.lane;
    for (const [n, p] of rows[i]!.commit.parents.entries()) {
      const j = index.get(p);
      if (j === undefined) {
        add(i, "stub", own);
        continue;
      }
      const theirs = laid[j]!.lane;
      // A first parent's line runs down the child's lane and curves in; a second parent's curves out to the parent's.
      const lane = n === 0 ? own : theirs;
      add(i, own === theirs || n === 0 ? "down" : "out", lane);
      for (let r = i + 1; r < j; r++) add(r, "through", lane);
      add(j, own === theirs || n > 0 ? "up" : "in", lane);
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
