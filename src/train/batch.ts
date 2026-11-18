// What a round of the merge train asks of the work it would land, read from the project's repo without touching a
// workspace: which commits need fixing and who may fix them (`classify`), which queued tasks merge cleanly with the
// branch together (`pickBatch`), and what the merge's parents are (`mergeParents`).
import type { NodeConfig } from "../config";
import { trialMerge } from "../git/merge-tree";
import { changesIn, commitsIn, git, type CommitInfo } from "../jj";
import type { LineRow } from "../pool/rows";
import type { Graph } from "../projects/branches";
import { workspaceImmutableHeads } from "../tasks/provision";

/**
 * A task as a round sees it: its work's `tip` (its line's effective head, `effectiveHead`), the commits it was started
 * from (`base`), the workspace holding it on this node (`null` when the task is on another node), and the `size` of
 * its work (`sizeOf`).
 */
export type Candidate = { taskId: string; title: string; tip: string; base: string[]; workspace: string | null; size: number };

/**
 * What landing a task would land, in `B..tip`, as the spec's step 1 sorts it (commit ids, the oldest first):
 * - `leftovers`: empty, undescribed, non-merge commits the task owns, which the train abandons itself;
 * - `toFix`: the commits the task owns that are undescribed or conflicted, which need a describe turn, and, of those,
 *   the `conflicted` ones;
 * - `foreign`: the other tasks whose work is in there (each once), and whether they are queued;
 * - `unfixable`: undescribed or conflicted commits that are immutable in the task's workspace (the revision it started
 *   from, or work another task has built on), each with why.
 * A commit of another task's is in none of the other lists: it is that task's to fix.
 */
export type Classified = {
  leftovers: string[];
  toFix: string[];
  conflicted: string[];
  foreign: Array<{ taskId: string; queued: boolean }>;
  unfixable: Array<{ commit: string; reason: string }>;
};

/** A jj revset of the commits `bases` and below; a base this repo lacks counts for nothing. */
function below(bases: readonly string[]): string {
  return bases.length === 0 ? "none()" : `::(${bases.map((b) => `present(${b})`).join(" | ")})`;
}

/**
 * The commits `landing` selects, each with whether the task may change it. In the task's workspace that is its own jj
 * view. For a task on another node there is no workspace here: its view is read from its scoped `immutable_heads()`
 * (`workspaceImmutableHeads`) as this repo's bookmarks have it.
 */
async function landingCommits(cfg: NodeConfig, repo: string, c: Candidate, landing: string): Promise<CommitInfo[]> {
  if (c.workspace !== null) return commitsIn(c.workspace, landing, cfg);
  const commits = await commitsIn(repo, landing, cfg);
  const frozen = new Set((await changesIn(repo, `(${landing}) & ::(${workspaceImmutableHeads(c.taskId, c.base)})`, cfg)).map((k) => k.commitId));
  return commits.map((k) => ({ ...k, mutable: !frozen.has(k.commitId) }));
}

/**
 * The commits of `landing` that belong to the other tasks' lines (a commit belongs to a line when it is in
 * `::line.commit ~ ::line.base`), by task, in the order the tasks' rows come. A line released, archived (an archived
 * row can briefly still be queued) or whose commit this repo lacks names nothing, and neither does one that has `c`'s
 * tip in it: that task is stacked on `c` (it merged `c`'s line, or started on it), so `c`'s commits in it are still
 * `c`'s own, and the stacked task is the one that reports `c` as foreign. One query when there is nothing foreign, the
 * usual case.
 *
 * Which of two tasks made a commit that is in both lines can't be told from the graph when neither contains the other
 * (one merged the other's line, and that one has moved on since): each reports the other as foreign for it, which
 * holds a task back with a notice rather than land work that may not be its own.
 */
async function foreignWork(cfg: NodeConfig, repo: string, c: Candidate, landing: string, lines: readonly LineRow[]): Promise<Map<string, Set<string>>> {
  const others = lines.filter((l) => l.task !== c.taskId && !l.archived && l.commit !== null);
  const work = new Map<string, Set<string>>();
  if (others.length === 0) return work;
  const set = (l: LineRow) => `(::present(${l.commit}) ~ ${below(l.base)})`;
  if ((await changesIn(repo, `(${landing}) & (${others.map(set).join(" | ")})`, cfg)).length === 0) return work;

  const stacked = new Set((await changesIn(repo, `${c.tip}:: & (${others.map((l) => `present(${l.commit})`).join(" | ")})`, cfg)).map((k) => k.commitId));
  const sets = new Map<string, string[]>();
  for (const l of others) if (!stacked.has(l.commit!)) sets.set(l.task, [...(sets.get(l.task) ?? []), set(l)]);
  for (const [task, taskSets] of sets) {
    const found = await changesIn(repo, `(${landing}) & (${taskSets.join(" | ")})`, cfg);
    if (found.length > 0) work.set(task, new Set(found.map((k) => k.commitId)));
  }
  return work;
}

/**
 * Sorts what landing candidate `c` would land (`B..c.tip`, with `B` the branch's commit) as the spec's step 1 does
 * (`Classified`). `lines` are the project's line rows and `queued` the ids of its queued tasks.
 * - A commit that is undescribed (no description but whitespace) or conflicted has to be fixed to be pushable. When the
 *   task may change it (it is mutable in the task's workspace) it is `toFix`, or, an empty undescribed non-merge
 *   commit, a leftover to abandon. When it may not, it is `unfixable`: the commits below `c.base` are that, since a
 *   workspace never changes its base, and so is anything another task has built on.
 * - A commit that is in another task's line is that task's work: `foreign`, and left alone otherwise (but not when that
 *   task is stacked on this one: see `foreignWork`; the commits are this task's, and frozen in its workspace by the other's line).
 * A merge is told from a leftover by its parents and its conflicts, never by `empty`: jj calls a merge it has left
 * conflicted empty.
 */
export async function classify(
  cfg: NodeConfig, repo: string, B: string, c: Candidate, queued: ReadonlySet<string>, lines: readonly LineRow[],
): Promise<Classified> {
  const landing = `(::${c.tip} ~ ::${B})`;
  const commits = await landingCommits(cfg, repo, c, landing);
  const work = await foreignWork(cfg, repo, c, landing, lines);
  const others = new Set([...work.values()].flatMap((commitIds) => [...commitIds]));

  const result: Classified = {
    leftovers: [], toFix: [], conflicted: [], unfixable: [],
    foreign: [...work.keys()].map((taskId) => ({ taskId, queued: queued.has(taskId) })),
  };
  // `jj log` lists children first.
  for (const k of commits.reverse()) {
    if (others.has(k.commitId)) continue;
    const undescribed = k.description.trim() === "";
    const problems = [...(k.conflict ? ["has conflicts"] : []), ...(undescribed ? ["has no description"] : [])];
    if (problems.length === 0) continue;
    if (!k.mutable) {
      result.unfixable.push({ commit: k.commitId, reason: `${problems.join(" and ")}, and it is not the task's to change` });
    } else if (k.empty && undescribed && k.parents.length === 1 && !k.conflict) {
      result.leftovers.push(k.commitId);
    } else {
      result.toFix.push(k.commitId);
      if (k.conflict) result.conflicted.push(k.commitId);
    }
  }
  return result;
}

/**
 * The commits of `B..c.tip` that are candidate `c`'s own, children first: neither the revision it started from and what
 * is below it (`c.base`) nor another task's work (as `classify` tells it), each with whether `c` may change it
 * (`mutable`, read as `classify` reads it). What a rebase of `c`'s work would have to rewrite.
 */
export async function ownWork(cfg: NodeConfig, repo: string, B: string, c: Candidate, lines: readonly LineRow[]): Promise<CommitInfo[]> {
  const landing = `(::${c.tip} ~ ::${B} ~ ${below(c.base)})`;
  const work = await foreignWork(cfg, repo, c, landing, lines);
  const others = new Set([...work.values()].flatMap((commitIds) => [...commitIds]));
  return (await landingCommits(cfg, repo, c, landing)).filter((k) => !others.has(k.commitId));
}

/**
 * Splits `eligible` (queued tasks that are idle, online and not in a train turn) by how they meet the branch's commit
 * `B`: the biggest first (`size`; the queue's order among equals), a task whose trial merge with `B` is clean joins the
 * `batch` when its merge with `B` and the batch so far is clean too, and otherwise waits for the next round (`later`).
 * A task that doesn't merge cleanly with `B` alone is to `rebase`. Trial merges touch no workspace (`trialMerge`).
 */
export async function pickBatch(
  cfg: NodeConfig, repo: string, B: string, eligible: readonly Candidate[],
): Promise<{ batch: Candidate[]; rebase: Candidate[]; later: Candidate[] }> {
  const batch: Candidate[] = [];
  const rebase: Candidate[] = [];
  const later: Candidate[] = [];
  // Array.prototype.sort is stable.
  for (const c of [...eligible].sort((a, b) => b.size - a.size)) {
    if ((await trialMerge(cfg, repo, [B, c.tip])).tree === null) rebase.push(c);
    else if (batch.length === 0 || (await trialMerge(cfg, repo, [B, ...batch.map((b) => b.tip), c.tip])).tree !== null) batch.push(c);
    else later.push(c);
  }
  return { batch, rebase, later };
}

/**
 * The parents of a batch's merge: the heads of `tips` and `B`, so that a commit that is an ancestor of another of them
 * is dropped, and no commit comes twice. The tips come first, in the order given, then `B` if it remains (usually it
 * doesn't, since the tasks started from the current branch). A task whose tip is below another's drops out when the
 * other contains its work, so that a stack lands in one go; one that has moved on since has a tip the other doesn't
 * contain, and stays.
 */
export async function mergeParents(g: Graph, B: string, tips: readonly string[]): Promise<string[]> {
  const commits = [...new Set([...tips, B])];
  const heads: string[] = [];
  for (const c of commits) {
    let covered = false;
    for (const d of commits) {
      if (d !== c && (await g.isAncestor(c, d))) {
        covered = true;
        break;
      }
    }
    if (!covered) heads.push(c);
  }
  return heads;
}

/** The size of the work between `B` and `tip`: the lines changed, insertions and deletions (`git diff --shortstat`). */
export async function sizeOf(cfg: NodeConfig, repo: string, B: string, tip: string): Promise<number> {
  const out = await git(["diff", "--shortstat", B, tip], repo, cfg);
  const count = (pattern: RegExp) => Number(pattern.exec(out)?.[1] ?? 0);
  return count(/(\d+) insertions?\(\+\)/) + count(/(\d+) deletions?\(-\)/);
}
