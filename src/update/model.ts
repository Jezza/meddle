// src/update/model.ts — what a view of the rollout channel says: the current rollout, the pool's build, where each
// participant is, and whether a rollout is confirmed, failed or still waiting (and on what). Pure: the updater
// (`./updater.ts`) acts on it.
import { CHECKOUT_BUILD } from "./build";
import { byStart, type NodeUpdate, type Rollout, type RolloutView, type UpdateState } from "./wire";

/** The newest rollout the view knows, or null. */
export function currentRollout(view: RolloutView): Rollout | null {
  return [...view.rollouts].sort(byStart).at(-1) ?? null;
}

/** The newest rollout, when it has no outcome yet. */
export function openRollout(view: RolloutView): Rollout | null {
  const r = currentRollout(view);
  return r !== null && r.outcome === null ? r : null;
}

/** The newest confirmed rollout: the build the pool runs, which a node on another build catches up to. */
export function confirmedRollout(view: RolloutView): Rollout | null {
  return [...view.rollouts].filter((r) => r.outcome?.status === "confirmed").sort(byStart).at(-1) ?? null;
}

/** The build the pool runs (the newest confirmed rollout's), or null before any rollout was confirmed. */
export function poolBuild(view: RolloutView): string | null {
  return confirmedRollout(view)?.build ?? null;
}

/** The newest failed rollout, when no rollout has started since: the failure to show until the next one. */
export function lastFailure(view: RolloutView): Rollout | null {
  const r = currentRollout(view);
  return r?.outcome?.status === "failed" ? r : null;
}

/** Whether a node on `build` is mismatched: a binary whose build is not the pool's (a checkout never is). */
export function mismatched(build: string, pool: string | null): boolean {
  return pool !== null && build !== CHECKOUT_BUILD && build !== pool;
}

/**
 * The SHA-256 a binary of `build` for `platform` must have: what the pool's confirmed rollout names, when `build` is
 * its build; else null (an open or failed rollout of a build, even the pool's own, says nothing about what runs).
 */
export function expectedHash(view: RolloutView, build: string, platform: string): string | null {
  const pool = confirmedRollout(view);
  if (pool === null || pool.build !== build) return null;
  return pool.binaries.find((b) => b.platform === platform)?.sha256 ?? null;
}

/**
 * What is wrong with the binary node `rec` runs, or null: the file was replaced under the running process; it differs
 * from the pool's binary of its build (`expectedHash`); or, with no confirmed rollout of its build to say, from another
 * node's on the same build and platform (both are flagged: neither can be told the right one).
 */
export function binaryProblem(view: RolloutView, rec: NodeUpdate): string | null {
  if (rec.build === CHECKOUT_BUILD) return null;
  if (rec.binaryChanged === true) return "binary on disk changed since start";
  if (rec.sha256 === undefined) return null;
  const expected = expectedHash(view, rec.build, rec.platform);
  if (expected !== null) return expected === rec.sha256 ? null : `binary differs from build ${rec.build}'s`;
  const differs = Object.values(view.nodes).some((n) =>
    n.node !== rec.node && n.build === rec.build && n.platform === rec.platform && n.sha256 !== undefined && n.sha256 !== rec.sha256);
  return differs ? `binary differs from another node's of build ${rec.build}` : null;
}

/**
 * Whether a node with this build, platform and binary hash is behind the pool: on another binary build than the
 * pool's, or on it with a binary that is not the pool's (`mismatched`, with the hash). It catches up meanwhile.
 */
export function behindPool(view: RolloutView, build: string, platform: string, sha256: string | undefined): boolean {
  const pool = poolBuild(view);
  if (mismatched(build, pool)) return true;
  if (pool === null || build !== pool || sha256 === undefined) return false;
  const expected = expectedHash(view, pool, platform);
  return expected !== null && expected !== sha256;
}

/** Node `id`'s record when it is about rollout `r`, else null: it has not started on it. */
export function recordFor(view: RolloutView, r: Rollout, id: string): NodeUpdate | null {
  const rec = view.nodes[id];
  return rec !== undefined && rec.rollout === r.id ? rec : null;
}

/** Node `id`'s state in rollout `r`: its record's, or `idle` while it has none about `r`. */
export function stateIn(view: RolloutView, r: Rollout, id: string): UpdateState {
  return recordFor(view, r, id)?.state ?? "idle";
}

/** A state before the swap: the node's binary and database are still the old ones. */
export function beforeSwap(state: UpdateState): boolean {
  return state === "idle" || state === "staged" || state === "draining";
}

/** Whether participant `id` has drained: its turns are over (or forced), or it has gone on to swap. */
export function drained(view: RolloutView, r: Rollout, id: string): boolean {
  const rec = recordFor(view, r, id);
  if (rec === null) return false;
  if (rec.state === "draining") return rec.drained === true || r.mode === "forced";
  return rec.state === "swapped" || rec.state === "healthy";
}

/** Every participant has drained: they may all swap. */
export function allDrained(view: RolloutView, r: Rollout): boolean {
  return r.participants.every((p) => drained(view, r, p));
}

/**
 * What a rollout still waits on: each participant not yet healthy, its state, and the turns it waits for. A participant
 * that has drained is not waited on, unless it is offline (`isOnline`): the others do not swap without it, and it fails
 * the rollout if it stays away.
 */
export type Waiting = { node: string; state: UpdateState; step: string | null; turns: string[] };

export function waitingOn(view: RolloutView, r: Rollout, isOnline: (id: string) => boolean = () => true): Waiting[] {
  return r.participants.flatMap((p) => {
    const rec = recordFor(view, r, p);
    const state = rec?.state ?? "idle";
    if (state === "healthy") return [];
    if (beforeSwap(state) && !isOnline(p)) return [{ node: p, state, step: "offline", turns: [] }];
    if (state === "draining" && drained(view, r, p)) return [];
    const turns = state === "draining" && r.mode !== "forced" && rec?.drained !== true ? rec?.waitingOn ?? [] : [];
    return [{ node: p, state, step: rec?.step ?? null, turns }];
  });
}

/** How long a rollout has to be confirmed: its deadline less its start, both on its starter's clock. */
export function rolloutDuration(r: Rollout): number {
  return Date.parse(r.deadline) - Date.parse(r.startedAt);
}

/** `30m`, `2m`, `90s`, `1h30m`: a duration as people write one. */
export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  return `${h > 0 ? `${h}h` : ""}${m > 0 ? `${m}m` : ""}${rest > 0 ? `${rest}s` : ""}`;
}

/** A duration as `meddle update --within` and the `update.*` settings take it (`90s`, `30m`, `1h`), in ms; null when not one. */
export function parseDuration(text: string): number | null {
  const m = /^(\d+)(s|m|h)$/.exec(text.trim());
  if (m === null) return null;
  const n = Number(m[1]);
  const ms = n * (m[2] === "s" ? 1000 : m[2] === "m" ? 60_000 : 3_600_000);
  return Number.isSafeInteger(ms) && ms > 0 ? ms : null;
}

/** `pi's turn in task 0012`, `pi (fetching)`: what a waiting participant is waiting for, with `name` naming nodes. */
export function describeWaiting(w: Waiting[], name: (id: string) => string): string {
  if (w.length === 0) return "nothing";
  return w.map((x) => {
    if (x.turns.length > 0) return x.turns.map((t) => `${name(x.node)}'s turn in task ${t}`).join(", ");
    return `${name(x.node)} (${x.step ?? x.state})`;
  }).join(", ");
}

/**
 * The outcome a rollout has now, as far as this view says, or null while it is still open: confirmed once every
 * participant reported healthy; failed when a participant failed, or when `now` is past `deadlineAt`. The caller says
 * when that is on its own clock (from when it first saw the rollout, so that a starter's clock does not decide it), and
 * which nodes are online; health deadlines and participants gone offline are the updater's to judge (they count from
 * when it saw each swap, and each node go).
 */
export function judge(
  view: RolloutView, r: Rollout, now: number, name: (id: string) => string,
  opts: { deadlineAt?: number; isOnline?: (id: string) => boolean } = {},
): { status: "confirmed" } | { status: "failed"; node: string | null; reason: string } | null {
  if (r.participants.length > 0 && r.participants.every((p) => stateIn(view, r, p) === "healthy")) return { status: "confirmed" };
  const failed = r.participants.find((p) => stateIn(view, r, p) === "failed");
  if (failed !== undefined) {
    return { status: "failed", node: failed, reason: recordFor(view, r, failed)?.reason ?? "it failed" };
  }
  if (now > (opts.deadlineAt ?? Date.parse(r.deadline))) {
    const waiting = describeWaiting(waitingOn(view, r, opts.isOnline), name);
    return { status: "failed", node: null, reason: `not confirmed within ${formatDuration(rolloutDuration(r))}: waiting on ${waiting}` };
  }
  return null;
}
