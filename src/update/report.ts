// src/update/report.ts — pool updates in `meddle status`: this node's build and any swap in progress, the pool's build,
// every node's build and update state, and the current rollout (or the last one, with its failure). Read from the
// update's files, so it works while the node is down for its swap. Pure: the CLI reads the files.
import { CHECKOUT_BUILD, type BuildInfo } from "./build";
import type { Pending } from "./files";
import { behindPool, binaryProblem, currentRollout, describeWaiting, poolBuild, waitingOn } from "./model";
import type { NodeUpdate, RolloutView } from "./wire";

/** What a swap in progress here is doing, in words. */
function pendingText(p: Pending): string {
  return p.phase === "swapped" ? `awaiting confirmation of build ${p.build}` : p.phase === "swapping" ? `swapping to build ${p.build}` : `rolling back from build ${p.build}`;
}

/** A node's update state in words: `idle`, `draining (waiting on 0012)`, `failed: <reason>`, with what else is known. */
export function nodeStateText(rec: NodeUpdate, view: RolloutView): string {
  const pool = poolBuild(view);
  const binary = binaryProblem(view, rec);
  const step = rec.state === "draining"
    ? (rec.drained === true ? " (drained)" : (rec.waitingOn ?? []).length > 0 ? ` (waiting on ${rec.waitingOn!.join(", ")})` : "")
    : rec.step != null ? ` (${rec.step})` : "";
  const notes = [
    ...(behindPool(view, rec.build, rec.platform, rec.sha256) ? [`behind the pool's build ${pool}`] : []),
    ...(binary !== null ? [binary] : []),
    ...(rec.blocked != null && rec.build !== CHECKOUT_BUILD ? [`cannot be updated: ${rec.blocked}`] : []),
  ];
  const why = rec.state === "failed" && rec.reason !== null ? `: ${rec.reason}` : "";
  return `${rec.state}${step}${notes.map((n) => `, ${n}`).join("")}${why}`;
}

/**
 * `meddle status`'s update lines: `build <id> (<platform>)` (and the swap in progress here), `pool build <id>` once one
 * was confirmed, `node <name> build <id> <state>` for every node the rollout channel told this one of (this node
 * first), and `rollout <build> (<mode>) <status>` for the current rollout, with what it waits on or why it failed.
 */
export function statusLines(build: BuildInfo, view: RolloutView, pending: Pending | null, self: string | null, name: (id: string) => string): string[] {
  const pool = poolBuild(view);
  const lines = [`build ${build.buildId} (${build.platform})${pending === null ? "" : `, ${pendingText(pending)}`}`];
  if (pool !== null) lines.push(`pool build ${pool}`);
  const recs = Object.values(view.nodes).sort((a, b) => Number(b.node === self) - Number(a.node === self) || name(a.node).localeCompare(name(b.node)));
  for (const rec of recs) lines.push(`node ${name(rec.node)} build ${rec.build} ${nodeStateText(rec, view)}`);
  const r = currentRollout(view);
  if (r !== null) {
    const status = r.outcome === null
      ? `in progress until ${r.deadline}, waiting on ${describeWaiting(waitingOn(view, r), name)}`
      : r.outcome.status === "confirmed" ? `confirmed at ${r.outcome.at}`
      : `failed at ${r.outcome.at}${r.outcome.node === null ? "" : ` on ${name(r.outcome.node)}`}: ${r.outcome.reason}`;
    lines.push(`rollout ${r.build} (${r.mode}) ${status}`);
  }
  return lines;
}
