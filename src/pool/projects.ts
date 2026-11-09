// The pool's projects as the roster lists them: `meddle project list` and `--project <id|name>`. Pure: they read what
// each node's summary says (decision 6), never a peer.
import { shortId } from "./ids";

/** A node of the roster as `PoolObject.nodes` gives it: its status and the projects its summary lists. */
export type ProjectHolder = { nodeId: string; status: string; projects: ReadonlyArray<{ id: string; name: string; home: string }> };

/** One project of the pool: named as its home lists it, held by every node whose summary lists it (by node id). */
export type PoolProject = { id: string; name: string; home: string; holders: string[] };

/**
 * Every project the members' summaries list (this node's included, as `nodes` has it), one per id, by name then id.
 * A project's name and home are its home's entry when the home lists it, else the first holder's.
 */
export function poolProjects(nodes: readonly ProjectHolder[]): PoolProject[] {
  const byId = new Map<string, PoolProject>();
  for (const node of nodes) {
    if (node.status === "removed") continue;
    for (const p of node.projects) {
      const row = byId.get(p.id);
      if (row === undefined) byId.set(p.id, { id: p.id, name: p.name, home: p.home, holders: [node.nodeId] });
      else {
        if (!row.holders.includes(node.nodeId)) row.holders.push(node.nodeId);
        if (node.nodeId === p.home) Object.assign(row, { name: p.name, home: p.home });
      }
    }
  }
  const rows = [...byId.values()];
  for (const row of rows) row.holders.sort();
  return rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** `<id>  <name>  home <short>  on <short,short,…>`. */
export function projectLine(p: PoolProject, paint: { project(id: string): string; node(id: string): string } = { project: (id) => id, node: shortId }): string {
  return `${paint.project(p.id)}  ${p.name}  home ${paint.node(p.home)}  on ${p.holders.map(paint.node).join(",")}`;
}

/** The shape of a project id (`newId`). */
const PROJECT_ID = /^[0-9a-f]{12}$/;

/**
 * The project `x` names: a project's id, the name of exactly one project of the pool, or the start of exactly one
 * project's id (a name wins over a prefix). Throws `ambiguous project name: <x>` when several have that name, and
 * `ambiguous project: <x> (<ids>)` when several ids start with it; when none matches, an id-shaped `x` (12 hex
 * digits) passes through for the node to ask the members, and anything else throws `unknown project: <x>`.
 */
export function resolveProject(projects: readonly PoolProject[], x: string): string {
  if (projects.some((p) => p.id === x)) return x;
  const named = projects.filter((p) => p.name === x);
  if (named.length > 1) throw new Error(`ambiguous project name: ${x}`);
  if (named.length === 1) return named[0]!.id;
  // A project id (`newId`: 12 hex digits) the roster does not list yet: the node asks the members, as before.
  if (PROJECT_ID.test(x)) return x;
  const prefixed = x === "" ? [] : projects.filter((p) => p.id.startsWith(x));
  if (prefixed.length === 1) return prefixed[0]!.id;
  if (prefixed.length > 1) throw new Error(`ambiguous project: ${x} (${prefixed.map((p) => p.id).sort().join(", ")})`);
  throw new Error(`unknown project: ${x}`);
}
