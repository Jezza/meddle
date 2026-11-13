// What the dashboard shows of pool updates, computed from `UpdateObject`'s values: whether the blind covers it, a
// rollout's participants and deadlines, what a draining rollout waits on, the last failure, and the nodes that get a
// red dot. Pure: no Preact, no DOM.
import type { NodeBuildView, RolloutSummary } from "../../update/updater";
import { ago } from "./sidebar-model";

/** What the dashboard reads of `UpdateObject`. */
export type UpdateView = {
  build: { buildId: string; platform: string };
  poolBuild: string | null;
  rollout: RolloutSummary | null;
  lastFailure: { rollout: string; build: string; node: string | null; reason: string; at: string } | null;
  awaitingConfirmation: boolean;
  nodes: readonly NodeBuildView[];
};

/** A participant that has swapped (or is past it): its binary and database are the new build's until confirmation. */
function pastSwap(p: RolloutSummary["participants"][number]): boolean {
  return p.state === "swapped" || p.state === "healthy";
}

/**
 * Whether the blind covers the dashboard: this node awaits confirmation of its new build, or the open rollout has begun
 * to swap. From then until the pool confirms or rolls back, its participants accept no input.
 */
export function blinded(u: Pick<UpdateView, "awaitingConfirmation" | "rollout">): boolean {
  if (u.awaitingConfirmation) return true;
  const r = u.rollout;
  return r !== null && r.outcome === null && r.participants.some(pastSwap);
}

/** The open rollout before any participant swaps (fetching, preflight, draining), or null: what the bar shows. */
export function draining(u: Pick<UpdateView, "awaitingConfirmation" | "rollout">): RolloutSummary | null {
  const r = u.rollout;
  return r !== null && r.outcome === null && !blinded(u) ? r : null;
}

/** One participant as the blind and the bar list it. */
export type ParticipantLine = {
  node: string;
  /** Its state in one word: its step while it has one (`fetching`, `preflight`), else `drained` or its state. */
  state: string;
  /** What else is known: the turns it waits for, why it failed, that it is offline. */
  detail: string | null;
  /** When it fails unless healthy (ISO): its swap plus the rollout's health deadline; null before it swaps. */
  healthBy: string | null;
  failed: boolean;
};

export function participantLines(r: RolloutSummary): ParticipantLine[] {
  return r.participants.map((p) => {
    const state = p.state === "draining" && (p.drained || r.mode === "forced") ? "drained" : p.step ?? p.state;
    const details = [
      ...(p.state === "draining" && !p.drained && r.mode !== "forced" && p.waitingOn.length > 0 ? [`${p.waitingOn.length} ${p.waitingOn.length === 1 ? "turn" : "turns"}`] : []),
      ...(p.state === "failed" && p.reason !== null ? [p.reason] : []),
      ...(!p.online ? ["offline"] : []),
    ];
    const healthBy = p.state === "swapped" && p.at !== null ? new Date(Date.parse(p.at) + r.healthMs).toISOString() : null;
    return { node: p.node, state, detail: details.length === 0 ? null : details.join(", "), healthBy, failed: p.state === "failed" };
  });
}

/** What a rollout waits on, per node: the tasks whose turns it waits for (none: it waits on the node itself). */
export function waits(r: RolloutSummary): Array<{ node: string; turns: string[]; step: string }> {
  return r.waiting.map((w) => ({ node: w.node, turns: w.turns, step: w.step ?? w.state }));
}

/** The time left until `deadline` (ISO), as its largest whole unit (`12m`), or `0s` once it has passed. */
export function timeLeft(deadline: string, now: number): string {
  return ago(Date.parse(deadline) - now);
}

/** The last rollout's failure, as the bar says it, with the rollout it is of (dismissed per rollout); null when none. */
export function failureText(u: Pick<UpdateView, "lastFailure">, name: (id: string) => string): { rollout: string; text: string } | null {
  const f = u.lastFailure;
  if (f === null) return null;
  return { rollout: f.rollout, text: `Update to ${f.build} failed${f.node === null ? "" : ` on ${name(f.node)}`}: ${f.reason}` };
}

/**
 * Why a node gets the red dot, or null: it is behind the pool's build, so it is out of the pool's work until it has
 * caught up (its own update failed, and says why; it cannot be updated; or it is still catching up), or its binary is
 * not to be trusted (replaced on disk since it started, or not its build's).
 */
export function buildAlert(n: NodeBuildView | undefined, poolBuild: string | null): string | null {
  if (n === undefined) return null;
  if (n.mismatched && n.state === "failed") return `Update failed: ${n.reason ?? "no reason given"}`;
  if (n.binary !== null) return `${n.binary[0]!.toUpperCase()}${n.binary.slice(1)}`;
  if (!n.mismatched) return null;
  const behind = `On build ${n.build}, not the pool's ${poolBuild ?? "build"}`;
  if (n.blocked !== null) return `${behind}; cannot be updated: ${n.blocked}`;
  return `${behind}; catching up (${n.step ?? n.state})`;
}

/** Each node's red-dot reason (`buildAlert`), by id: the nodes the dashboard flags. */
export function buildAlerts(u: Pick<UpdateView, "nodes" | "poolBuild">): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const n of u.nodes) {
    const why = buildAlert(n, u.poolBuild);
    if (why !== null) out.set(n.node, why);
  }
  return out;
}
