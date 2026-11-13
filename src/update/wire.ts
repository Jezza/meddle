// src/update/wire.ts — what the rollout channel carries between nodes: the rollouts and each node's update record, and
// how two views of them merge. It is its own channel, not rows of PoolObject's sync, so that nodes on different builds
// can always read each other's rollout state: a failed or mismatched node must still be seen, and still say why.
//
// The rules that keep it readable across builds:
// - Every message and record carries `v`, the version of the channel its writer speaks (`ROLLOUT_V`).
// - Readers ignore fields they do not know, and keep them: a record is merged and passed on whole, so a newer node's
//   fields survive an older relay.
// - Fields may be added, never removed or changed in meaning. The frozen minimum, which every build writes and reads, is
//   a node record's `node`, `rev`, `build`, `platform`, `sha256`, `state`, `reason` and `ota`, and a rollout's `id`,
//   `build`, `startedAt`, `participants` and `outcome`.

/** The version of the channel this build writes. */
export const ROLLOUT_V = 1;

/**
 * The OTA protocol version this build speaks: what the steps of a rollout are (fetch, preflight, drain, swap together,
 * health, confirm or roll back) and what each record and state on this channel means for them. Every node advertises
 * it in its record. Bump it only when those steps or their wire meaning change so that a build speaking the old version
 * could not take part correctly; not for a new field older builds may ignore, nor for anything else in the build.
 */
export const OTA_V = 1;

/** The OTA versions this build can drive a rollout of: `meddle update` refuses while an online node speaks another. */
export const OTA_DRIVES: readonly number[] = [1];

/**
 * Where a node is in an update. `idle`: none in progress here (or fetching and checking a binary before it is
 * `staged`); `staged`: the new binary is next to the running one and passed its preflight; `draining`: waiting for its
 * turns to end (`drained` once they have); `swapped`: restarted on the new binary, not yet healthy; `healthy`: serving
 * on it and back in the pool; `failed`: its update failed (`reason` says why).
 */
export type UpdateState = "idle" | "staged" | "draining" | "swapped" | "healthy" | "failed";

export const UPDATE_STATES: readonly UpdateState[] = ["idle", "staged", "draining", "swapped", "healthy", "failed"];

/** A node's own record of its build and its update, written only by the node itself (or its guard). */
export type NodeUpdate = {
  v: number;
  node: string;
  /** Orders the node's own writes: a record with a greater `rev` replaces one with a smaller. */
  rev: number;
  build: string;
  platform: string;
  /** The SHA-256 of the node's binary, taken when it started; absent for a checkout (or a binary it could not read). */
  sha256?: string;
  /** The file at its binary's path no longer hashes to `sha256`: replaced under the running process. */
  binaryChanged?: boolean;
  state: UpdateState;
  /** Why the state is what it is: the failure, for `failed`; else null (or a note, such as why it is not updatable). */
  reason: string | null;
  /** When the node wrote this record (its clock). */
  at: string;
  /** The OTA protocol version the node's build speaks (`OTA_V`); absent only in a record no build writes, read as unknown. */
  ota?: number;
  /** The rollout `state` is about, or null when the node has taken part in none. */
  rollout: string | null;
  /** While `draining`: whether its turns have all ended (or the rollout is forced). */
  drained?: boolean;
  /** While `draining`: the tasks whose turns it waits for. */
  waitingOn?: string[];
  /** What the node is doing within `state`, for people (`fetching`, `preflight`, …); null when nothing. */
  step?: string | null;
  /** Why the node cannot be updated (a checkout, a binary it cannot replace, …), or null when it can. */
  blocked?: string | null;
  /** The update is the node's own, catching up with a confirmed rollout (a late or mismatched node). */
  late?: boolean;
  /** A late update's failure: the start of `serve` it belongs to (the node's own count), retried only at a later one. */
  failedBoot?: number;
} & Record<string, unknown>;

export type RolloutMode = "queued" | "forced";

export type RolloutOutcome =
  | { status: "confirmed"; at: string }
  | { status: "failed"; at: string; node: string | null; reason: string };

/** One binary of a rollout: the platform it is for, and what its file must hash to. */
export type RolloutBinary = { platform: string; sha256: string; size: number };

/** A rollout of a build to the pool. Its fields never change but `mode` and `outcome`, which only grow. */
export type Rollout = {
  v: number;
  id: string;
  build: string;
  binaries: RolloutBinary[];
  startedBy: string;
  startedAt: string;
  mode: RolloutMode;
  /** The binary nodes that were online when it started, and not already on its build. */
  participants: string[];
  /** When it fails unless confirmed. */
  deadline: string;
  /** How long a participant has, from its swap, to report healthy. */
  healthMs: number;
  outcome: RolloutOutcome | null;
} & Record<string, unknown>;

/** What a node holds of the channel, and what it sends: every rollout it knows and every node's newest record. */
export type RolloutView = { rollouts: Rollout[]; nodes: Record<string, NodeUpdate> };

/** The message one node sends another on a `rollout` stream. */
export type RolloutMessage = { v: number; rollouts: Rollout[]; nodes: NodeUpdate[] };

/** How many rollouts a view keeps: the newest ones. */
export const KEEP_ROLLOUTS = 10;
/** The most node records a message may carry (more are dropped): a pool is a handful of machines. */
const MAX_NODES = 512;
/** The longest a reason a peer sends is kept, in characters. */
export const MAX_REASON = 2000;

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const NODE_ID = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9._-]{1,64}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export function emptyView(): RolloutView {
  return { rollouts: [], nodes: {} };
}

const isString = (v: unknown): v is string => typeof v === "string";
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** Text a peer chose, as it may be shown: no control characters but newline and tab, bounded. */
export function cleanText(text: string, max = MAX_REASON): string {
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "?").slice(0, max);
}

/** A node record as a peer sent it, with what this build reads checked; null when its frozen minimum is not there. */
export function parseNodeUpdate(raw: unknown): NodeUpdate | null {
  if (!isObject(raw)) return null;
  const { v, node, rev, build, platform, state, reason, at, rollout } = raw;
  if (typeof v !== "number" || v < 1 || !isString(node) || !NODE_ID.test(node)) return null;
  if (typeof rev !== "number" || !Number.isFinite(rev) || !isString(build) || !ID.test(build)) return null;
  if (!isString(platform) || platform.length > 64 || !UPDATE_STATES.includes(state as UpdateState)) return null;
  if (reason !== null && !isString(reason)) return null;
  const out: NodeUpdate = {
    ...raw,
    v, node, rev, build, platform,
    state: state as UpdateState,
    reason: reason === null ? null : cleanText(reason),
    at: isString(at) && ISO.test(at) ? at : new Date(0).toISOString(),
    rollout: isString(rollout) && ID.test(rollout) ? rollout : null,
  };
  if (out.ota !== undefined && !(Number.isSafeInteger(out.ota) && (out.ota as number) > 0)) delete out.ota;
  if (out.sha256 !== undefined && !(isString(out.sha256) && SHA256.test(out.sha256))) delete out.sha256;
  if (out.binaryChanged !== undefined && typeof out.binaryChanged !== "boolean") delete out.binaryChanged;
  if (out.drained !== undefined && typeof out.drained !== "boolean") delete out.drained;
  if (out.waitingOn !== undefined && !(Array.isArray(out.waitingOn) && out.waitingOn.every(isString))) delete out.waitingOn;
  if (out.step !== undefined && out.step !== null && !isString(out.step)) delete out.step;
  if (out.blocked !== undefined && out.blocked !== null && !isString(out.blocked)) delete out.blocked;
  if (out.late !== undefined && typeof out.late !== "boolean") delete out.late;
  if (out.failedBoot !== undefined && typeof out.failedBoot !== "number") delete out.failedBoot;
  return out;
}

function parseOutcome(raw: unknown): RolloutOutcome | null | undefined {
  if (raw === null) return null;
  if (!isObject(raw) || !isString(raw.at) || !ISO.test(raw.at)) return undefined;
  if (raw.status === "confirmed") return { ...raw, status: "confirmed", at: raw.at };
  if (raw.status === "failed" && isString(raw.reason) && (raw.node === null || (isString(raw.node) && NODE_ID.test(raw.node)))) {
    return { ...raw, status: "failed", at: raw.at, node: raw.node, reason: cleanText(raw.reason) };
  }
  return undefined;
}

/** A rollout as a peer sent it, checked; null when what this build needs of it is not there. */
export function parseRollout(raw: unknown): Rollout | null {
  if (!isObject(raw)) return null;
  const { v, id, build, binaries, startedBy, startedAt, mode, participants, deadline, healthMs } = raw;
  if (typeof v !== "number" || v < 1 || !isString(id) || !ID.test(id) || !isString(build) || !ID.test(build)) return null;
  if (!isString(startedAt) || !ISO.test(startedAt) || !isString(deadline) || !ISO.test(deadline)) return null;
  if (!Array.isArray(participants) || !participants.every((p) => isString(p) && NODE_ID.test(p))) return null;
  const outcome = parseOutcome(raw.outcome ?? null);
  if (outcome === undefined) return null;
  const bins = Array.isArray(binaries)
    ? binaries.filter((b): b is RolloutBinary =>
      isObject(b) && isString(b.platform) && isString(b.sha256) && SHA256.test(b.sha256) && typeof b.size === "number")
    : [];
  return {
    ...raw,
    v, id, build,
    binaries: bins.map((b) => ({ platform: b.platform, sha256: b.sha256, size: b.size })),
    startedBy: isString(startedBy) ? startedBy : "",
    startedAt,
    mode: mode === "forced" ? "forced" : "queued",
    participants: [...new Set(participants)].sort(),
    deadline,
    healthMs: typeof healthMs === "number" && healthMs > 0 ? healthMs : 120_000,
    outcome,
  };
}

/** A message as a peer sent it: its rollouts and records, each checked, the bad ones dropped. Null when not one. */
export function parseMessage(line: string): RolloutMessage | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObject(raw) || typeof raw.v !== "number") return null;
  const rollouts = Array.isArray(raw.rollouts) ? raw.rollouts.map(parseRollout).filter((r): r is Rollout => r !== null) : [];
  const nodes = Array.isArray(raw.nodes)
    ? raw.nodes.slice(0, MAX_NODES).map(parseNodeUpdate).filter((n): n is NodeUpdate => n !== null)
    : [];
  return { v: raw.v, rollouts: rollouts.slice(-KEEP_ROLLOUTS * 2), nodes };
}

/** A view as a message: what a node sends. */
export function messageOf(view: RolloutView): RolloutMessage {
  return { v: ROLLOUT_V, rollouts: view.rollouts, nodes: Object.values(view.nodes) };
}

/** Rollouts oldest first: by `startedAt`, then by id. */
export function byStart(a: Rollout, b: Rollout): number {
  return a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

const OUTCOME_RANK = { open: 0, failed: 1, confirmed: 2 } as const;

/**
 * Which of two outcomes of one rollout stands: confirmed over failed over none (a confirmation means every participant
 * reported healthy, which a failure decided on a deadline, with less known, cannot undo); of two failures, the
 * earlier, then the one naming the smaller node id.
 */
export function mergeOutcome(a: RolloutOutcome | null, b: RolloutOutcome | null): RolloutOutcome | null {
  const rank = (o: RolloutOutcome | null) => OUTCOME_RANK[o?.status ?? "open"];
  if (rank(a) !== rank(b)) return rank(a) > rank(b) ? a : b;
  if (a === null || b === null || a.status !== "failed" || b.status !== "failed") return a;
  if (a.at !== b.at) return a.at < b.at ? a : b;
  return (a.node ?? "") <= (b.node ?? "") ? a : b;
}

/** Two copies of one rollout as one: forced if either is, and the outcome that stands. */
export function mergeRollout(a: Rollout, b: Rollout): Rollout {
  return {
    ...b,
    ...a,
    mode: a.mode === "forced" || b.mode === "forced" ? "forced" : "queued",
    outcome: mergeOutcome(a.outcome, b.outcome),
  };
}

/** Whether two copies of a rollout say the same about what can change. */
function sameRollout(a: Rollout, b: Rollout): boolean {
  return a.mode === b.mode && JSON.stringify(a.outcome) === JSON.stringify(b.outcome);
}

/**
 * Folds a peer's message into `view`: each rollout merged with this view's copy (`mergeRollout`), only the newest
 * `KEEP_ROLLOUTS` kept; each node record taken when its `rev` is greater (a node's own word about itself). Records of
 * `self` are never taken from a peer: this node is the one that knows. Returns the new view and whether it changed.
 */
export function mergeView(view: RolloutView, msg: Pick<RolloutMessage, "rollouts" | "nodes">, self: string | null = null): { view: RolloutView; changed: boolean } {
  let changed = false;
  const rollouts = new Map(view.rollouts.map((r) => [r.id, r]));
  for (const remote of msg.rollouts) {
    const local = rollouts.get(remote.id);
    if (local === undefined) {
      rollouts.set(remote.id, remote);
      changed = true;
      continue;
    }
    const merged = mergeRollout(local, remote);
    if (!sameRollout(merged, local)) {
      rollouts.set(remote.id, merged);
      changed = true;
    }
  }
  const sorted = [...rollouts.values()].sort(byStart);
  const kept = sorted.slice(-KEEP_ROLLOUTS);
  if (kept.length !== view.rollouts.length) changed = true;
  const nodes = { ...view.nodes };
  for (const remote of msg.nodes) {
    if (remote.node === self) continue;
    const local = nodes[remote.node];
    if (local !== undefined && local.rev >= remote.rev) continue;
    nodes[remote.node] = remote;
    changed = true;
  }
  return { view: changed ? { rollouts: kept, nodes } : view, changed };
}
