// The view of a project repo (`refs/namespaces/view/`): what the applier wrote from the rows, which a checkout fetches
// from and pushes to. Reading it, and the branches' states as the rows give them next to it, is what a checkout's push
// (`git/serve.ts`) and a node-internal advance of a branch (`advance.ts`) are both judged from.
import type { NodeConfig } from "../config";
import { git } from "../jj";
import type { BranchRow } from "../pool/rows";
import { gitGraph } from "./applier";
import { computeBranch, type BranchHeads } from "./branches";

/** The git namespace a project repo is served to a checkout as. */
export const NAMESPACE = "view";
export const VIEW = `refs/namespaces/${NAMESPACE}/`;

/** The refs of the view, by name as a checkout sees them (`refs/…`, the namespace stripped), with their commits. */
export async function viewRefs(cfg: NodeConfig, repo: string): Promise<Map<string, string>> {
  const out = await git(["for-each-ref", "--format=%(refname) %(objectname)", VIEW], repo, cfg);
  const refs = new Map<string, string>();
  for (const line of out.split("\n")) {
    const at = line.lastIndexOf(" ");
    if (at <= 0) continue;
    const ref = line.slice(VIEW.length, at);
    // `HEAD` is the applier's symref, never pushed.
    if (ref.startsWith("refs/")) refs.set(ref, line.slice(at + 1));
  }
  return refs;
}

/** Where the view shows branch `branch`: its own ref and its siblings' (`meddle/conflict/<b>/<id>`), as one key. */
function shownAt(view: Map<string, string>, branch: string): string {
  const conflicts = `refs/heads/meddle/conflict/${branch}/`;
  const siblings = [...view].filter(([ref]) => ref.startsWith(conflicts) && !ref.slice(conflicts.length).includes("/"));
  return JSON.stringify([view.get(`refs/heads/${branch}`) ?? null, siblings.map(([, commit]) => commit).sort()]);
}

/**
 * Each branch's heads from the project's rows, for the hook: its commit, or its siblings while conflicted. And the
 * branches the view does not show where the rows put them (`stale`): a row the applier has not applied yet (or whose
 * commit this repo lacks, so its heads are unknown), which a checkout's jj has not seen either. A push to one of them
 * is refused until the view catches up: judged against rows the pusher never saw, it would drop them.
 */
export async function branchStates(
  cfg: NodeConfig, repo: string, rows: BranchRow[], view: Map<string, string>,
): Promise<{ heads: BranchHeads; stale: string[] }> {
  const byBranch = new Map<string, BranchRow[]>();
  for (const r of rows) byBranch.set(r.branch, [...(byBranch.get(r.branch) ?? []), r]);
  // A branch the view shows with no rows at all is out of date too.
  for (const ref of view.keys()) {
    if (ref.startsWith("refs/heads/") && !ref.startsWith("refs/heads/meddle/") && ref !== "refs/heads/meddle") {
      const branch = ref.slice("refs/heads/".length);
      if (!byBranch.has(branch)) byBranch.set(branch, []);
    }
  }
  const graph = gitGraph(cfg, repo);
  const heads: BranchHeads = [];
  const stale: string[] = [];
  for (const [branch, branchRows] of byBranch) {
    let state: Awaited<ReturnType<typeof computeBranch>>;
    try {
      state = await computeBranch(branchRows, graph);
    } catch {
      // git could not read the graph (every admitted row's commit is here): refused, as for a view behind its rows.
      stale.push(branch);
      continue;
    }
    let expected: string;
    if (state.kind === "single") {
      heads.push({ branch, commits: [state.commit] });
      expected = JSON.stringify([state.commit, []]);
    } else if (state.kind === "conflicted") {
      heads.push({ branch, commits: state.siblings });
      expected = JSON.stringify([state.served, [...state.siblings].sort()]);
    } else {
      expected = JSON.stringify([null, []]);
    }
    if (shownAt(view, branch) !== expected) stale.push(branch);
  }
  return { heads, stale };
}
