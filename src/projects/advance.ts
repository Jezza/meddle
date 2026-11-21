// Moving a branch from inside the node, as a checkout's push would: through the same checks (`pushRefusal`), recorded as
// this node's branch rows (`planPush`), then applied. Only `git/serve.ts`'s receive-pack path wrote branch rows before;
// the merge train lands work on main here, so a landing and a push can't drift apart.
import { shortId } from "../pool/ids";
import { listBranchRows, writeBranchRow } from "../pool/rows";
import { repoKey, serialised } from "../serial";
import { applyProject, gitGraph } from "./applier";
import { planPush, pushRefusal, type PushedRef } from "./branches";
import { getProject } from "./project";
import type { ReplicaDeps } from "./replicas";
import { branchStates, viewRefs } from "./view";

/** How long a push waits, once recorded, for the view to be applied from the rows before it is done. */
export const APPLY_AFTER_PUSH_MS = 5000;

/**
 * Moves branch `branch` of project `projectId` from `old` to `next`, as a push of it from a checkout here would: under
 * the replica's lock, from the rows and the view as they stand, the push's checks (`pushRefusal`: `inputHold`'s reason
 * when the node takes no input, a conflicted branch, a branch the view shows behind its rows) and then this node's
 * row for it, written as `planPush` plans it. Once it is out of the lock the project is applied (`APPLY_AFTER_PUSH_MS`),
 * so the view and the service repo show it when this returns; a failure to apply is logged, the branch having moved.
 *
 * It also refuses what a checkout's git would have: a branch that is not `single` at `old` (`<branch> is not at <old>`),
 * and a `next` that does not descend from it (`<branch>: <next> is not a fast-forward from <old>`). A refusal rejects
 * with its text. `next` must already be in the replica. The view only changes when `applyProject` runs, so there is no
 * `holdView`, and no recording to retry.
 */
export async function advanceBranch(
  deps: ReplicaDeps & { selfId: string; inputHold?: () => string | null },
  projectId: string, branch: string, old: string, next: string,
): Promise<void> {
  const project = getProject(deps.db, projectId);
  if (project === null) throw new Error(`no project ${shortId(projectId)} on this node`);
  const repo = project.replica;
  await serialised(repoKey(repo), async () => {
    const rows = listBranchRows(deps.db, projectId);
    const { heads, stale } = await branchStates(deps.cfg, repo, rows, await viewRefs(deps.cfg, repo));
    const graph = gitGraph(deps.cfg, repo);
    const pushed: PushedRef[] = [{ ref: `refs/heads/${branch}`, old, new: next }];
    const refused = await pushRefusal(
      { refuse: deps.inputHold?.() ?? null, pushed, heads, stale, rows, selfId: deps.selfId, project: projectId }, graph,
    );
    if (refused !== null) throw new Error(refused);
    const at = heads.find((h) => h.branch === branch)?.commits ?? [];
    if (at.length !== 1 || at[0] !== old) throw new Error(`${branch} is not at ${old}`);
    if (!(await graph.isAncestor(old, next))) throw new Error(`${branch}: ${next} is not a fast-forward from ${old}`);
    for (const row of await planPush(deps.selfId, projectId, pushed, rows, graph)) writeBranchRow(deps.db, deps.selfId, row);
  });
  await applyProject(deps, projectId, APPLY_AFTER_PUSH_MS).catch((err: unknown) => {
    deps.log?.(`meddle: advance: project ${shortId(projectId)} was not applied after moving ${branch}: ${err instanceof Error ? err.message : String(err)}`);
  });
}
