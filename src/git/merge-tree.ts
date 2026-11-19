// What the merge train asks git without a workspace: a commit's tree, and whether commits merge (`git merge-tree`).
import type { NodeConfig } from "../config";
import { git, GitError } from "../jj";

/** The tree `commit` holds in `repo`, as an object id. Rejects when `commit` is no commit there. */
export async function treeOf(cfg: NodeConfig, repo: string, commit: string): Promise<string> {
  return (await git(["rev-parse", "--verify", `${commit}^{tree}`], repo, cfg)).trim();
}

/** What a trial merge came to: the tree of a clean merge, or `null` and the paths that conflict. */
export type TrialMerge = { tree: string; conflicts: string[] } | { tree: null; conflicts: string[] };

/**
 * Merges `commits` of `repo` in a trial, folding left to right: the first with the second, that with the third, and so
 * on, each step a three-way merge from the commits' merge base (git finds it). Nothing is checked out and no ref or
 * workspace is touched; the objects it writes are unreachable. One commit is its own tree. A clean merge has the
 * merged `tree`; one that conflicts at any step has `tree` null and `conflicts`, the paths of the step that failed
 * (git's own verdict, not what a later step would add). Needs git 2.38 (`merge-tree --write-tree`). Rejects when there
 * are no commits, or git fails for another reason (a commit it does not have, unrelated histories).
 */
export async function trialMerge(cfg: NodeConfig, repo: string, commits: readonly string[]): Promise<TrialMerge> {
  const [first, ...rest] = commits;
  if (first === undefined) throw new Error("trialMerge: no commits to merge");
  let merged = first;
  let tree = await treeOf(cfg, repo, first);
  for (const [i, next] of rest.entries()) {
    const step = await mergeTree(cfg, repo, merged, next);
    if (step.tree === null) return step;
    tree = step.tree;
    // The next step needs a commit to merge, whose parents tell git the merge base.
    if (i < rest.length - 1) merged = await tempCommit(cfg, repo, tree, [merged, next]);
  }
  return { tree, conflicts: [] };
}

/** `git merge-tree` of two commits: exit status 0 is a clean merge, 1 a conflict (its paths follow the tree id). */
async function mergeTree(cfg: NodeConfig, repo: string, a: string, b: string): Promise<TrialMerge> {
  // `-z`: paths are NUL-terminated, never quoted.
  const args = ["merge-tree", "--write-tree", "--name-only", "-z", "--no-messages", a, b];
  let out: string;
  let clean: boolean;
  try {
    out = await git(args, repo, cfg);
    clean = true;
  } catch (err) {
    if (!(err instanceof GitError) || err.code !== 1) throw err;
    out = err.stdout;
    clean = false;
  }
  const [tree = "", ...paths] = out.split("\0").filter((part) => part !== "");
  if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new Error(`git ${args.join(" ")} wrote no tree: ${out}`);
  return clean ? { tree, conflicts: [] } : { tree: null, conflicts: paths };
}

/** A commit of `tree` on `parents`, which nothing refers to; it only gives the next `merge-tree` a merge base. */
async function tempCommit(cfg: NodeConfig, repo: string, tree: string, parents: string[]): Promise<string> {
  const args = [
    // An identity of its own: the repo may have none, and the commit is never kept.
    "-c", "user.name=meddle", "-c", "user.email=meddle@meddle.invalid",
    "commit-tree", "--no-gpg-sign", ...parents.flatMap((p) => ["-p", p]), "-m", "trial merge", tree,
  ];
  return (await git(args, repo, cfg)).trim();
}
