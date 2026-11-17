// src/projects/graph.ts — a project's commit graph in this node's replica, for the dashboard: the commits under its
// branches and its tasks' lines (`lines.ts`), as of the bookmarks one probe saw. Read-only, and no jj call here
// snapshots a working copy (`--ignore-working-copy`): the replica may be the user's own checkout.
import type { NodeConfig } from "../config";
import { jj } from "../jj";
import { taskNamespace } from "../tasks/manifest";
import { LINE_REMOTE } from "./lines";

/** A branch (a local bookmark, by name), or a task's line in the project (local on its holder, remote elsewhere). */
export type GraphBookmark = { kind: "branch"; name: string } | { kind: "task"; task: string };

export type GraphCommit = {
  commit: string;
  change: string;
  /** Every parent's commit id, whether or not it is in the same read; never the root's. */
  parents: string[];
  /** The description's first line. */
  description: string;
  immutable: boolean;
  /** The committer's timestamp, in ms. */
  time: number;
  bookmarks: GraphBookmark[];
};

/** The most commits a read lists. */
export const GRAPH_MAX = 200;

/** The counted bookmarks and the commits they point at (a conflicted one at each); `key`, the same for the same heads. */
export type GraphProbe = { key: string; heads: Array<{ bookmark: GraphBookmark; commit: string }> };

const FIELD = "\x1f";

/** One line per bookmark: its remote (empty for a local one), name and target commits. */
const PROBE_TEMPLATE = 'if(present, ' + [
  "remote",
  "name",
  'added_targets.map(|c| c.commit_id()).join(",")',
].join(' ++ "\\x1f" ++ ') + ' ++ "\\n")';

/** One line per commit; the description last, since it is the only free text. */
const COMMIT_TEMPLATE = [
  "commit_id",
  "change_id",
  'parents.map(|c| c.commit_id()).join(",")',
  "immutable",
  'committer.timestamp().utc().format("%Y-%m-%dT%H:%M:%S%.3fZ")',
  "description.first_line()",
].join(' ++ "\\x1f" ++ ') + ' ++ "\\n"';

/**
 * The bookmark a probe row counts as, or null: a local bookmark not under `meddle/` is a branch; a task's line in
 * project `projectName` is `meddle/task/<id>/<name>` locally, `task/<id>/<name>@meddle` held elsewhere. Side lines,
 * `base/…@meddle`, `@git` and other remotes' bookmarks are not counted.
 */
function counted(remote: string, name: string, projectName: string): GraphBookmark | null {
  if (remote === "" && !name.startsWith("meddle/")) return { kind: "branch", name };
  const line = remote === "" ? name : remote === LINE_REMOTE ? `meddle/${name}` : null;
  const task = line?.match(/^meddle\/task\/([^/]+)\//)?.[1];
  return task !== undefined && line === `${taskNamespace(task)}${projectName}` ? { kind: "task", task } : null;
}

/** The counted bookmarks in `replica` of project `projectName`, but for the lines of the tasks in `archived`. */
export async function graphProbe(
  cfg: NodeConfig, replica: string, projectName: string, archived: ReadonlySet<string>,
): Promise<GraphProbe> {
  const out = await jj(["--ignore-working-copy", "bookmark", "list", "--all-remotes", "-T", PROBE_TEMPLATE], replica, cfg);
  const heads = new Map<string, { bookmark: GraphBookmark; commit: string }>();
  for (const row of out.split("\n").filter(Boolean)) {
    const [remote = "", name = "", targets = ""] = row.split(FIELD);
    const bookmark = counted(remote, name, projectName);
    if (bookmark === null || (bookmark.kind === "task" && archived.has(bookmark.task))) continue;
    // Keyed so that a line both local and remote here is one head.
    for (const commit of targets.split(",").filter(Boolean)) heads.set(`${JSON.stringify(bookmark)} ${commit}`, { bookmark, commit });
  }
  const keys = [...heads.keys()].sort();
  return { key: keys.join("\n"), heads: keys.map((k) => heads.get(k)!) };
}

/**
 * `commits` as a revset, each checked to be a commit id (they come from a probe a caller may have kept) and named as one:
 * a bookmark named like it would win over a bare id.
 */
function revset(commits: Iterable<string>): string {
  const all = [...new Set(commits)];
  for (const c of all) if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(c)) throw new Error(`not a commit id: ${c}`);
  return all.map((c) => `commit_id(${c})`).join(" | ");
}

/**
 * The commits under the probe's heads (`B`), newest first, at most `limit`, each with the probe's bookmarks on it: from
 * the parent of `defaultBranch`'s commit up (`::B ~ ::(<default>--)`), or all of them (`::B`) when the probe has no
 * such branch; never the root, which is no commit to draw. None when it has no heads.
 */
export async function projectGraph(
  cfg: NodeConfig, replica: string, probe: GraphProbe, defaultBranch: string | null, limit = GRAPH_MAX,
): Promise<GraphCommit[]> {
  if (probe.heads.length === 0) return [];
  const main = probe.heads.filter((h) => h.bookmark.kind === "branch" && h.bookmark.name === defaultBranch).map((h) => h.commit);
  const range = `::(${revset(probe.heads.map((h) => h.commit))})${main.length === 0 ? "" : ` ~ ::((${revset(main)})--)`} ~ root()`;
  const out = await jj(
    ["--ignore-working-copy", "log", "--no-graph", "--limit", String(limit), "-r", range, "-T", COMMIT_TEMPLATE],
    replica, cfg,
  );
  return out.split("\n").filter(Boolean).map((row): GraphCommit => {
    const [commit = "", change = "", parents = "", immutable = "", time = "", ...rest] = row.split(FIELD);
    return {
      commit,
      change,
      // The root is never read: a parent naming it would look like one cut off.
      parents: parents.split(",").filter((p) => p !== "" && !/^0+$/.test(p)),
      description: rest.join(FIELD),
      immutable: immutable === "true",
      time: Date.parse(time),
      bookmarks: probe.heads.filter((h) => h.commit === commit).map((h) => h.bookmark),
    };
  });
}

/** The commits under the probe's heads with no lower bound (`::B`, less the root), newest first, at most `limit`: `Older`. */
export async function olderGraph(cfg: NodeConfig, replica: string, probe: GraphProbe, limit: number): Promise<GraphCommit[]> {
  return projectGraph(cfg, replica, probe, null, limit);
}
