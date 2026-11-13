// src/update/updater.ts — this node's part in pool updates: it keeps the rollout channel's view (merging what peers
// send, sending its own), judges the current rollout (deadlines, participants gone, confirmation, failure: any node
// may), and takes this node through its own update: fetch and preflight the binary, hold turns while draining, swap
// once every participant has drained, report healthy on the new build, and finalize or roll back. A node whose build
// (or binary) is not the pool's catches up on its own the same way (a late update). Every effect on the world goes through `UpdaterDeps`, so
// the state machine runs under test with fake peers and a fake clock.
import { existsSync } from "node:fs";
import { copyFile, mkdir, open, readdir, rename, rm, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CHECKOUT_BUILD, hashFile, hashHandle, statMark, type BuildInfo } from "./build";
import { BadBinary, exchange, fetchBinary, Unavailable, type ChannelNet } from "./channel";
import { inputRefusal } from "./gate";
import {
  clearSwap, readPending, readState, spaceProblem, storedBinary, swapFiles, swapNeeds, writePending, writeState, type Pending,
  type SwapPlan, type UpdateFiles,
} from "./files";
import {
  allDrained, beforeSwap, behindPool, drained, binaryProblem, confirmedRollout, currentRollout, describeWaiting, formatDuration, judge,
  lastFailure, openRollout, poolBuild, recordFor, rolloutDuration, stateIn, waitingOn, type Waiting,
} from "./model";
import {
  byStart, mergeRollout, mergeView, OTA_DRIVES, OTA_V, ROLLOUT_V, type NodeUpdate, type Rollout, type RolloutMessage,
  type RolloutMode, type RolloutOutcome, type RolloutView, type UpdateState,
} from "./wire";

/** Why this node's work is held, by kind; null where it is not. */
export type Holds = {
  /** No turn starts or resumes here (prompts queue). */
  turns: string | null;
  /** No move, archive or restore starts here. */
  work: string | null;
  /** This node takes no tasks (it is out of placement, and refuses creating or receiving one). */
  hosting: string | null;
};

const NO_HOLDS: Holds = { turns: null, work: null, hosting: null };

export type { SwapPlan };

export type UpdaterNet = ChannelNet & {
  online(): string[];
  isOnline(id: string): boolean;
  onPeer(cb: (peerId: string, online: boolean) => void): () => void;
};

export type UpdaterDeps = {
  selfId: string;
  build: BuildInfo;
  files: UpdateFiles;
  net: UpdaterNet;
  isMember(id: string): boolean;
  /** Every member of the pool, this node included. */
  members(): string[];
  /** A node as people read it (`<short id> (<host>)`). */
  name(id: string): string;
  /** The pool's `update.within` and `update.health` (or their defaults), in ms. */
  withinMs(): number;
  healthMs(): number;
  /** Why this node cannot be updated, or null when it can: its binary location, its unit, systemd. */
  blocked(): Promise<string | null>;
  /** Runs the staged binary's preflight; rejects with why it failed. */
  preflight(path: string, build: string): Promise<void>;
  /** The tasks whose turns (or moves) are in flight here: what a queued drain waits for. */
  busy(): Promise<string[]>;
  /** Sets what is held here. Called whenever it changes. */
  hold(holds: Holds): void;
  /** Stops the node and swaps the staged binary in, then restarts (in production it exits and never resolves). */
  swap(plan: SwapPlan): Promise<void>;
  /** Stops the node and restarts it, for the guard to roll back what `pending.json` says (never resolves in production). */
  restart(): Promise<void>;
  log(line: string): void;
  now?(): number;
  /** Fetches a binary from a peer (default `fetchBinary` over `net`). */
  fetch?: typeof fetchBinary;
  /** Exchanges views with a peer (default `exchange` over `net`). */
  exchange?: typeof exchange;
};

/**
 * What `serve` found at start: the stored view, a swap awaiting confirmation (this binary is its new build), which start
 * of `serve` this is, and the SHA-256 of this node's binary and its `statMark` (null for a checkout, or a binary it
 * could not read).
 */
export type UpdaterBoot = { view: RolloutView; awaiting: Pending | null; boot: number; sha256: string | null; stat: string | null };

/** What `meddle update` asks of the node: a rollout of these binaries, or (none given) to force the open one. */
export type StartRequest = {
  binaries: { path: string; buildId: string; platform: string; sha256: string; size: number }[];
  force: boolean;
  withinMs?: number;
};

/** One participant of a rollout as the CLI and the dashboard show it. */
export type ParticipantView = {
  node: string;
  state: UpdateState;
  step: string | null;
  reason: string | null;
  drained: boolean;
  waitingOn: string[];
  online: boolean;
  /** When its record about this rollout last changed (for `swapped`, the swap: its health deadline counts from it), or null. */
  at: string | null;
};

/** A rollout as the CLI and the dashboard show it. */
export type RolloutSummary = {
  id: string;
  build: string;
  mode: RolloutMode;
  startedBy: string;
  startedAt: string;
  deadline: string;
  healthMs: number;
  platforms: string[];
  outcome: RolloutOutcome | null;
  participants: ParticipantView[];
  /** What it still waits on, while open. */
  waiting: Waiting[];
};

/** Every node's build and update state as this node knows them. */
export type NodeBuildView = {
  node: string;
  build: string;
  platform: string;
  state: UpdateState;
  reason: string | null;
  step: string | null;
  late: boolean;
  blocked: string | null;
  /** Behind the pool's build (another build, or a binary not the pool's): it is (or failed) catching up, out of the pool's work. */
  mismatched: boolean;
  /** What is wrong with its binary (`binaryProblem`): replaced on disk, or not its build's; null when nothing is. */
  binary: string | null;
  at: string;
};

/** Everything the CLI and the dashboard read of updates (the `UpdateObject` seam). */
export type UpdateSnapshot = {
  self: string;
  build: BuildInfo;
  /** The build the pool runs (its newest confirmed rollout's), or null before the first. */
  poolBuild: string | null;
  /** The current rollout (open, or the newest one done), or null before any. */
  rollout: RolloutSummary | null;
  /** The newest rollout when it failed, until another starts: its build, node, reason and time. */
  lastFailure: { rollout: string; build: string; node: string | null; reason: string; at: string } | null;
  /** This node runs a new build that is not confirmed yet: it must accept no input. */
  awaitingConfirmation: boolean;
  /** Why turns are held here, or null. */
  held: string | null;
  nodes: NodeBuildView[];
};

/**
 * How long a participant may be offline (or asleep) before it has swapped: past it, it fails the rollout. Once every
 * participant has drained, a drained one that is offline may be down for its swap (its `swapped` not heard): it gets
 * as long as a swapped one, the health deadline and `PEER_HEALTH_GRACE_MS`.
 */
export const OFFLINE_MS = 60_000;
/**
 * How much longer than the health deadline peers give a participant from its `swapped`: it sends that before it copies
 * its databases and restarts, and its own deadline (the guard's) counts from after the copy.
 */
export const PEER_HEALTH_GRACE_MS = 60_000;
/** How long after serving a new build with no member online the node counts as rejoined all the same. */
export const REJOIN_GRACE_MS = 20_000;
/** How often the updater looks again of itself (deadlines, drains) and exchanges views with every online peer. */
export const TICK_MS = 5_000;
export const GOSSIP_MS = 15_000;
/** How often the node looks at its binary's stat (and hashes it again if that changed), for one replaced under it. */
export const BINARY_CHECK_MS = 5 * 60_000;
/** How long a swap waits for its `swapped` to reach the online peers before it goes down. */
const FLUSH_MS = 5_000;
/** How long a participant waits before it looks again for a member that has its binary. */
const SOURCE_RETRY_MS = 30_000;

/**
 * No member online could give the binary. A participant looks again later (its rollout's deadline bounds it); a late
 * node's update fails, unless no member was online to ask at all.
 */
class NoSource extends Error {
  constructor(message: string, readonly asked: number) {
    super(message);
  }
}

function messageOf(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim();
}

function sameHolds(a: Holds, b: Holds): boolean {
  return a.turns === b.turns && a.work === b.work && a.hosting === b.hosting;
}

/** A new rollout's id: 12 random hex digits. */
function newRolloutId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, "0")).join("");
}

export class Updater {
  readonly #deps: UpdaterDeps;
  readonly #self: string;
  readonly #build: BuildInfo;
  #view: RolloutView;
  /** The swap this binary is the new build of, until it is confirmed or rolled back. */
  #awaiting: Pending | null;
  /** Which start of `serve` this is (counted in `state.json`): a late update that failed is retried at a later one. */
  readonly #boot: number;
  /** The SHA-256 of this node's binary when it started, or null (a checkout, or unreadable). */
  readonly #sha256: string | null;
  /** The file at the binary's path no longer hashes to `#sha256`. */
  #binaryChanged = false;
  /** The binary's `statMark` when it last hashed to `#sha256`, when to look at it again, and whether a look is under way. */
  #binaryStat: string | null;
  #binaryCheckAt: number;
  #binaryChecking = false;
  /** When `serve` finished starting (ms), or null before. */
  #servingAt: number | null = null;
  /** The fetch and preflight in flight, for which rollout. */
  #job: { rollout: string; step: string; cancelled: boolean } | null = null;
  /** When a participant may look again for a member with its binary. */
  #sourceRetryAt = 0;
  /** The builds `meddle update` is putting into the store now: not pruned before their rollout is in the view. */
  readonly #storing = new Set<string>();
  #broadcastQueued = false;
  #swapping = false;
  #blocked: string | null = null;
  /** Since when each participant of a rollout has been offline, as this node saw it (absent while online). */
  readonly #offlineSince = new Map<string, number>();
  /** When this node first saw each participant swapped, by `<rollout>/<node>`. */
  readonly #swapSeen = new Map<string, number>();
  /** When this node first saw each rollout: its deadline counts from then, on this node's clock. */
  readonly #rolloutSeen = new Map<string, number>();
  #holds: Holds | null = null;
  #chain: Promise<void> = Promise.resolve();
  #persisting: Promise<void> = Promise.resolve();
  #timers: ReturnType<typeof setInterval>[] = [];
  #unsubscribe: (() => void) | null = null;
  #stopped = false;
  readonly #listeners = new Set<() => void>();

  constructor(deps: UpdaterDeps, boot: UpdaterBoot) {
    this.#deps = deps;
    this.#self = deps.selfId;
    this.#build = deps.build;
    this.#view = boot.view;
    this.#awaiting = boot.awaiting;
    this.#boot = boot.boot;
    this.#sha256 = boot.sha256;
    this.#binaryStat = boot.stat;
    const now = this.#now();
    this.#binaryCheckAt = now + BINARY_CHECK_MS;
    for (const r of this.#view.rollouts) for (const p of r.participants) if (p !== this.#self) this.#offlineSince.set(p, now);
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now();
  }

  /** Starts the timers and listens for peers: each one that comes online is sent this node's view. */
  run(): void {
    this.#unsubscribe = this.#deps.net.onPeer((id, online) => {
      // A peer back online is heard out before this node acts: its news (an outcome) may change what to do.
      if (online) void this.#exchangeWith(id).then(() => this.poke());
      else void this.poke();
    });
    this.#timers.push(setInterval(() => this.poke(), TICK_MS), setInterval(() => this.#broadcast(), GOSSIP_MS));
    for (const t of this.#timers) t.unref?.();
    this.poke();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    for (const t of this.#timers) clearInterval(t);
    this.#timers = [];
    this.#unsubscribe?.();
    if (this.#job !== null) this.#job.cancelled = true;
    await this.#chain.catch(() => {});
    await this.#persisting.catch(() => {});
  }

  /** Called whenever the snapshot may have changed. */
  onChange(cb: () => void): () => void {
    this.#listeners.add(cb);
    return () => { this.#listeners.delete(cb); };
  }

  #emit(): void {
    for (const cb of [...this.#listeners]) {
      try {
        cb();
      } catch (err) {
        this.#deps.log(`meddle: update: a listener threw: ${messageOf(err)}`);
      }
    }
  }

  /** `serve` has started completely (database open, Claude Code in place, dashboard listening). */
  serving(): void {
    this.#servingAt = this.#now();
    this.poke();
  }

  /** Looks at everything again, after the steps before it; resolves once this one is done. */
  poke(): Promise<void> {
    this.#chain = this.#chain.then(() => this.#step()).catch((err: unknown) => {
      this.#deps.log(`meddle: update: ${messageOf(err)}`);
    });
    return this.#chain;
  }

  /** The view as it stands (tests, and the channel's answers). */
  view(): RolloutView {
    return this.#view;
  }

  /** Merges a peer's message (the channel calls this), and answers with this node's view. */
  received(_from: string, msg: RolloutMessage): RolloutView {
    this.#merge(msg);
    return this.#view;
  }

  /**
   * The binary this node can serve, opened: one `meddle update` gave it for an open rollout, or its own when it runs
   * that build and binary (`sha256` is the one it started from). Its own is hashed through the very handle it is then
   * streamed from, so what was checked is what is sent; one that no longer hashes to it was replaced under the running
   * process, and is reported (`binaryChanged`) and served no more. A read that fails serves nothing, and flags nothing.
   */
  async binaryFor(build: string, platform: string, sha256: string): Promise<FileHandle | null> {
    const stored = storedBinary(this.#deps.files, build, platform);
    if (existsSync(stored)) return open(stored, "r").catch(() => null);
    const own = this.#build.buildId === build && this.#build.platform === platform && this.#sha256 === sha256;
    if (!own || this.#binaryChanged || this.#swapping || this.#stopped) return null;
    const handle = await open(this.#deps.files.exec, "r").catch(() => null);
    if (handle === null) return null;
    const got = await hashHandle(handle).catch(() => null);
    if (got?.sha256 === sha256) return handle;
    await handle.close();
    if (got !== null) this.#changed();
    return null;
  }

  /**
   * Looks at the binary's stat, and only when that changed hashes it again: still the binary it started from (touched,
   * say), or replaced under the running process (`#changed`). A stat or read that fails is looked at again later.
   */
  async #checkBinary(): Promise<void> {
    if (this.#sha256 === null || this.#binaryChanged || this.#binaryChecking) return;
    this.#binaryChecking = true;
    try {
      const mark = await statMark(this.#deps.files.exec).catch(() => null);
      if (mark === null || mark === this.#binaryStat) return;
      const got = await hashFile(this.#deps.files.exec).catch(() => null);
      if (got === null) return;
      if (got.sha256 === this.#sha256) this.#binaryStat = mark;
      else this.#changed();
    } finally {
      this.#binaryChecking = false;
    }
  }

  /** The binary at its path is not the one this node started from: reported, and served no more. Its own swap's is not. */
  #changed(): void {
    if (this.#stopped || this.#swapping || this.#binaryChanged) return;
    this.#binaryChanged = true;
    this.#deps.log(`meddle: update: ${this.#deps.files.exec} changed on disk since this node started`);
    this.#own({});
  }

  #merge(msg: Pick<RolloutMessage, "rollouts" | "nodes">): void {
    const { view, changed } = mergeView(this.#view, msg, this.#self);
    if (!changed) return;
    this.#view = view;
    this.#persist();
    this.#emit();
    void this.poke();
  }

  #persist(): void {
    const view = this.#view;
    this.#persisting = this.#persisting
      .then(() => writeState(this.#deps.files, { self: this.#self, view, boots: this.#boot }))
      .catch((err: unknown) => this.#deps.log(`meddle: update: writing the rollout state failed: ${messageOf(err)}`));
  }

  /** Sends this node's view to every online member, and merges their answers. */
  #broadcast(): void {
    if (this.#stopped) return;
    for (const id of this.#deps.net.online()) {
      if (this.#deps.isMember(id)) void this.#exchangeWith(id);
    }
  }

  /** `#broadcast` once the changes of this moment are all made. */
  #broadcastSoon(): void {
    if (this.#broadcastQueued) return;
    this.#broadcastQueued = true;
    setTimeout(() => {
      this.#broadcastQueued = false;
      this.#broadcast();
    }, 10);
  }

  async #exchangeWith(id: string): Promise<boolean> {
    if (this.#stopped) return false;
    try {
      const answer = await (this.#deps.exchange ?? exchange)(this.#deps.net, id, this.#view);
      if (answer !== null) this.#merge(answer);
      return true;
    } catch {
      // The peer went, or speaks no rollout channel (an older meddle): the next exchange tries again.
      return false;
    }
  }

  /** Writes a change of this node's own record, its `rev` above the last, and tells the pool. */
  #own(patch: Partial<NodeUpdate>): void {
    const prev = this.#view.nodes[this.#self];
    const base: NodeUpdate = prev ?? {
      v: ROLLOUT_V, node: this.#self, rev: 0, build: this.#build.buildId, platform: this.#build.platform, state: "idle",
      reason: null, at: new Date(this.#now()).toISOString(), rollout: null,
    };
    const next: NodeUpdate = {
      ...base, ...patch, v: ROLLOUT_V, node: this.#self, build: this.#build.buildId, platform: this.#build.platform, ota: OTA_V,
      sha256: this.#sha256 ?? undefined, binaryChanged: this.#binaryChanged || undefined,
    };
    if (next.sha256 === undefined) delete next.sha256;
    if (next.binaryChanged === undefined) delete next.binaryChanged;
    // A failure belongs to this start: a node behind the pool tries again at a later one, not in this one (`#step`).
    if (next.state === "failed" && base.state !== "failed") next.failedBoot = this.#boot;
    const keys = ["state", "reason", "rollout", "drained", "waitingOn", "step", "blocked", "late", "build", "platform", "ota", "sha256", "binaryChanged", "failedBoot"] as const;
    if (prev !== undefined && keys.every((k) => JSON.stringify(prev[k] ?? null) === JSON.stringify(next[k] ?? null))) return;
    next.rev = Math.max(this.#now(), base.rev + 1);
    next.at = new Date(this.#now()).toISOString();
    this.#view = { ...this.#view, nodes: { ...this.#view.nodes, [this.#self]: next } };
    this.#persist();
    this.#emit();
    this.#broadcastSoon();
  }

  /** Changes a rollout here (an outcome, its mode) and tells the pool. */
  #setRollout(id: string, patch: Partial<Pick<Rollout, "outcome" | "mode">>): void {
    const r = this.#view.rollouts.find((x) => x.id === id);
    if (r === undefined) return;
    const merged = mergeRollout({ ...r, ...patch, outcome: patch.outcome ?? r.outcome }, r);
    this.#view = { ...this.#view, rollouts: this.#view.rollouts.map((x) => (x.id === id ? merged : x)) };
    if (merged.outcome !== null && r.outcome === null) {
      this.#deps.log(merged.outcome.status === "confirmed"
        ? `meddle: update: build ${r.build} confirmed`
        : `meddle: update: build ${r.build} failed${merged.outcome.node === null ? "" : ` on ${this.#deps.name(merged.outcome.node)}`}: ${merged.outcome.reason}`);
    }
    this.#persist();
    this.#emit();
    this.#broadcastSoon();
  }

  #setHolds(next: Holds): void {
    if (this.#holds !== null && sameHolds(this.#holds, next)) return;
    this.#holds = next;
    this.#deps.hold(next);
    this.#emit();
  }

  #trackPresence(now: number): void {
    for (const r of this.#view.rollouts) {
      for (const p of r.participants) {
        if (p === this.#self) continue;
        if (this.#deps.net.isOnline(p)) this.#offlineSince.delete(p);
        else if (!this.#offlineSince.has(p)) this.#offlineSince.set(p, now);
      }
    }
  }

  #offlineFor(id: string, now: number): number {
    if (id === this.#self) return 0;
    const since = this.#offlineSince.get(id);
    return since === undefined ? 0 : now - since;
  }

  async #step(): Promise<void> {
    if (this.#stopped || this.#swapping) return;
    const now = this.#now();
    this.#trackPresence(now);
    this.#blocked = await this.#deps.blocked().catch((err: unknown) => messageOf(err));
    this.#own({ blocked: this.#blocked });
    this.#supersede();
    this.#judge(now);
    await this.#prune();
    if (now >= this.#binaryCheckAt) {
      this.#binaryCheckAt = now + BINARY_CHECK_MS;
      void this.#checkBinary().catch((err: unknown) => this.#deps.log(`meddle: update: checking the binary failed: ${messageOf(err)}`));
    }
    if (this.#build.buildId === CHECKOUT_BUILD) {
      this.#setHolds(NO_HOLDS);
      return;
    }
    if (this.#awaiting !== null) return this.#stepAwaiting(now);
    const r = currentRollout(this.#view);
    const open = r !== null && r.outcome === null ? r : null;
    /** The rollout this node is to update to now, if any, and the holds of a node that waits instead. */
    let target: { r: Rollout; late: boolean } | null = null;
    let waiting: Holds = NO_HOLDS;
    // Its part in the open rollout, whatever build it runs: a node behind the pool's takes part like any other.
    if (open !== null && open.participants.includes(this.#self)) {
      target = { r: open, late: false };
    } else {
      const pool = confirmedRollout(this.#view);
      const behind = this.#behind();
      if (pool !== null && behind !== null) {
        const own = recordFor(this.#view, pool, this.#self);
        const mine = this.#view.nodes[this.#self];
        const of = this.#view.rollouts.find((x) => x.id === mine?.rollout);
        if (open !== null) {
          // An open rollout settles first: the build to catch up to may change.
          const later = `${behind}; it updates once build ${open.build}'s rollout is over`;
          waiting = { turns: later, work: later, hosting: later };
        } else if (mine?.state === "failed" && this.#boot <= (mine.failedBoot ?? 0) && of !== undefined && byStart(of, pool) >= 0) {
          // An update that failed (late, or in a rollout since the pool's) is tried again at a later start (not the one
          // its rollback caused, which its failure belongs to), for a newer rollout, or by `meddle update`, not over
          // and over.
          const failed = `${behind}, and its update failed: ${mine.reason ?? "unknown"}`;
          waiting = { turns: failed, work: failed, hosting: failed };
        } else {
          // A failure tried again, or an update that went through once (a binary since replaced by another): anew.
          if (own?.state === "failed" || own?.state === "healthy") this.#own({ state: "idle", rollout: pool.id, reason: null, step: null, late: true });
          target = { r: pool, late: true };
        }
      }
    }
    // Whatever this node had started for any other rollout goes.
    await this.#abandon(target?.r.id ?? null);
    if (target !== null) return this.#stepPart(target.r, target.late, now);
    this.#setHolds(waiting);
  }

  /** Two rollouts started at once: the older one is failed as superseded, so that only the newest is open. */
  #supersede(): void {
    const sorted = [...this.#view.rollouts].sort(byStart);
    for (const r of sorted.slice(0, -1)) {
      if (r.outcome === null) {
        this.#setRollout(r.id, { outcome: { status: "failed", at: new Date(this.#now()).toISOString(), node: null, reason: "superseded by a rollout started at the same time" } });
      }
    }
  }

  /**
   * Decides the open rollout's outcome where the view allows: its deadline counts from when this node first saw it; a
   * participant offline before it swapped fails it (after `OFFLINE_MS`, or once all have drained, a drained one after
   * as long as a swapped one gets); and each swap's health deadline counts from when this node first saw it swapped.
   */
  #judge(now: number): void {
    const r = currentRollout(this.#view);
    if (r === null || r.outcome !== null) return;
    const view = this.#view;
    let verdict = judge(view, r, now, this.#deps.name, { deadlineAt: this.#deadlineOf(r), isOnline: (id) => this.#online(id) });
    const swapTime = r.healthMs + PEER_HEALTH_GRACE_MS;
    const allIn = allDrained(view, r);
    const gone = r.participants.find((p) => beforeSwap(stateIn(view, r, p))
      && this.#offlineFor(p, now) > (allIn && drained(view, r, p) ? swapTime : OFFLINE_MS));
    if (verdict === null && gone !== undefined) verdict = { status: "failed", node: gone, reason: `${this.#deps.name(gone)} went offline` };
    if (verdict === null) {
      for (const p of r.participants) {
        const key = `${r.id}/${p}`;
        if (stateIn(view, r, p) !== "swapped") {
          this.#swapSeen.delete(key);
          continue;
        }
        const seen = this.#swapSeen.get(key) ?? now;
        this.#swapSeen.set(key, seen);
        if (now - seen > swapTime) {
          verdict = { status: "failed", node: p, reason: `not healthy within ${formatDuration(r.healthMs)} of its swap` };
          break;
        }
      }
    }
    const at = new Date(now).toISOString();
    const outcome: RolloutOutcome | null = verdict === null ? null
      : verdict.status === "confirmed" ? { status: "confirmed", at } : { status: "failed", at, node: verdict.node, reason: verdict.reason };
    if (outcome !== null) this.#setRollout(r.id, { outcome });
  }

  /** When rollout `r` fails unless confirmed, on this node's clock: its duration from when this node first saw it. */
  #deadlineOf(r: Rollout): number {
    let seen = this.#rolloutSeen.get(r.id);
    if (seen === undefined) {
      seen = this.#now();
      this.#rolloutSeen.set(r.id, seen);
    }
    return seen + rolloutDuration(r);
  }

  #online(id: string): boolean {
    return id === this.#self || this.#deps.net.isOnline(id);
  }

  /**
   * Prunes the binaries `meddle update` gave this node to serve: it keeps only those of an open rollout (and of one
   * `meddle update` is storing now). After it, every node serves only the binary it runs.
   */
  async #prune(): Promise<void> {
    const { files } = this.#deps;
    const keep = new Set([openRollout(this.#view)?.build, ...this.#storing]);
    for (const name of await readdir(files.binaries).catch(() => [] as string[])) {
      if (!keep.has(name)) await rm(join(files.binaries, name), { recursive: true, force: true });
    }
  }

  /**
   * This node's own update to rollout `r` (the pool's open one, or with `late` the confirmed one it catches up to):
   * fetch and preflight, then drain, then swap (a pool participant once every participant has drained; a late node
   * once it has).
   */
  /** How this node is behind the pool, in words (`this node runs build A, the pool runs B`), or null when it is not. */
  #behind(): string | null {
    const pool = poolBuild(this.#view);
    if (pool === null || !behindPool(this.#view, this.#build.buildId, this.#build.platform, this.#sha256 ?? undefined)) return null;
    return this.#build.buildId === pool ? `this node's binary differs from build ${pool}'s` : `this node runs build ${this.#build.buildId}, the pool runs ${pool}`;
  }

  async #stepPart(r: Rollout, late: boolean, now: number): Promise<void> {
    // A node behind the pool's build stays out of its work (moves, hosting) while it updates, late or a participant.
    const gap = this.#behind();
    const behind = gap === null ? null : `${gap}; it is updating`;
    const updating = `update in progress (build ${r.build})`;
    const holdTurns = behind ?? updating;
    const rec = recordFor(this.#view, r, this.#self);
    const state = rec?.state ?? "idle";
    if (state === "failed") {
      // A pool participant's failure fails the rollout (`#judge`); a node behind the pool's build stays out of its work.
      const failed = `${behind ?? updating}; its update failed: ${rec?.reason ?? "unknown"}`;
      return this.#setHolds(behind !== null ? { turns: failed, work: failed, hosting: failed } : NO_HOLDS);
    }
    if (this.#blocked !== null && beforeSwap(state)) {
      // A node that cannot be updated (it was told so up front, or it changed since) fails its update.
      this.#own({ state: "failed", rollout: r.id, reason: `cannot be updated: ${this.#blocked}`, step: null, late });
      return this.#poke();
    }
    if (state === "idle") {
      this.#setHolds({ turns: holdTurns, work: behind, hosting: behind });
      if (this.#job === null || this.#job.rollout !== r.id) {
        if (now < this.#sourceRetryAt) return;
        this.#runStage(r, late);
      }
      this.#own({ state: "idle", rollout: r.id, reason: null, step: this.#job?.step ?? "fetching", late, drained: false, waitingOn: [] });
      return;
    }
    if (state === "staged") {
      this.#own({ state: "draining", rollout: r.id, step: null, drained: r.mode === "forced", waitingOn: [], late });
      return this.#poke();
    }
    if (state === "draining") {
      const busy = r.mode === "forced" ? [] : await this.#deps.busy();
      const drainedNow = busy.length === 0;
      // Drained: moves, archives and restores wait too, so that nothing starts between now and the swap.
      this.#setHolds({ turns: holdTurns, work: drainedNow ? (behind ?? updating) : behind, hosting: behind });
      this.#own({ state: "draining", rollout: r.id, drained: drainedNow, waitingOn: busy, late, step: null });
      // Together: every participant drained, and each other one online (or already swapped), so that none of them can
      // have news this node has not heard.
      const together = () => r.participants.every((p) =>
        p === this.#self || this.#deps.net.isOnline(p) || !beforeSwap(stateIn(this.#view, r, p)));
      const ready = late ? drainedNow : drainedNow && allDrained(this.#view, r) && together();
      if (ready) await this.#swap(r, late);
      return;
    }
    // `swapped` or `healthy` in this rollout, yet not awaiting it, and no rollback recorded: the process went down
    // before its swap could happen or say why. A failure, not a retry, which could go round again.
    this.#own({ state: "failed", rollout: r.id, reason: "the swap did not happen", step: null, late });
  }

  /** Steps again once this step is over (a state just written leads to the next). */
  #poke(): void {
    queueMicrotask(() => void this.poke());
  }

  /** Fetches and preflights the binary for `r`, in the background; its end is recorded and steps again. */
  #runStage(r: Rollout, late: boolean): void {
    const job = { rollout: r.id, step: "fetching", cancelled: false };
    this.#job = job;
    void (async () => {
      try {
        await this.#stage(r, job);
        if (job.cancelled) return;
        this.#job = null;
        this.#own({ state: "staged", rollout: r.id, reason: null, step: null, late });
      } catch (err) {
        if (job.cancelled) return;
        this.#job = null;
        if (err instanceof NoSource && (!late || err.asked === 0)) {
          this.#sourceRetryAt = this.#now() + SOURCE_RETRY_MS;
          this.#own({ state: "idle", rollout: r.id, reason: messageOf(err), step: "waiting for a member with the binary", late });
        } else {
          await rm(this.#deps.files.staged, { force: true }).catch(() => {});
          this.#own({ state: "failed", rollout: r.id, reason: messageOf(err), step: null, late });
        }
      }
      void this.poke();
    })();
  }

  /**
   * Puts the binary for `r` at the staged path (from this node's store, else from a member that has it) and preflights
   * it. First, the disk must have room for it and for the swap's database copy.
   */
  async #stage(r: Rollout, job: { step: string; cancelled: boolean }): Promise<void> {
    const { files } = this.#deps;
    const want = r.binaries.find((b) => b.platform === this.#build.platform);
    if (want === undefined) throw new Error(`build ${r.build} has no binary for ${this.#build.platform}`);
    const full = { build: r.build, platform: want.platform, sha256: want.sha256, size: want.size };
    const ready = existsSync(files.staged) && (await hashFile(files.staged).catch(() => null))?.sha256 === want.sha256;
    const short = await spaceProblem(await swapNeeds(files, ready ? 0 : want.size));
    if (short !== null) throw new Error(short);
    if (!ready) {
      await rm(files.staged, { force: true });
      const stored = storedBinary(files, r.build, want.platform);
      if (existsSync(stored) && (await hashFile(stored)).sha256 === want.sha256) {
        await copyFile(stored, files.stagedPart);
        await rename(files.stagedPart, files.staged);
      } else {
        await this.#fetchFromPool(r, full, files.staged);
      }
    }
    if (job.cancelled) return;
    job.step = "preflight";
    this.#own({ step: "preflight" });
    await this.#deps.preflight(files.staged, r.build).catch((err: unknown) => {
      throw new Error(`preflight failed: ${messageOf(err)}`);
    });
  }

  /**
   * Fetches a binary of `r` into `dest` from an online member, the rollout's starter first, then those that run it.
   * None that could give it: `NoSource`. One that sent a wrong binary: the next is asked, and if none gives the right
   * one, that is the failure. This node's own disk failing is the failure at once.
   */
  async #fetchFromPool(r: Rollout, want: { build: string; platform: string; sha256: string; size: number }, dest: string): Promise<void> {
    const online = this.#deps.net.online().filter((id) => this.#deps.isMember(id));
    const rank = (id: string) => {
      if (id === r.startedBy) return 0;
      const rec = this.#view.nodes[id];
      return rec?.build === r.build && rec.platform === want.platform && rec.sha256 === want.sha256 ? 1 : 2;
    };
    const candidates = [...online].sort((a, b) => rank(a) - rank(b));
    const unavailable: string[] = [];
    const bad: string[] = [];
    for (const id of candidates) {
      try {
        await (this.#deps.fetch ?? fetchBinary)(this.#deps.net, id, want, dest);
        return;
      } catch (err) {
        if (err instanceof BadBinary) bad.push(messageOf(err));
        else if (err instanceof Unavailable) unavailable.push(messageOf(err));
        else throw new Error(`could not keep the binary here: ${messageOf(err)}`);
      }
    }
    if (bad.length > 0) throw new Error(`no member sent the ${want.platform} binary of build ${want.build}: ${bad.join("; ")}`);
    throw new NoSource(`no member online has the ${want.platform} binary of build ${want.build}${unavailable.length > 0 ? ` (${unavailable.join("; ")})` : ""}`, candidates.length);
  }

  /** Reports `swapped`, makes sure the pool heard (within `FLUSH_MS`), and swaps: the node goes down and restarts. */
  async #swap(r: Rollout, late: boolean): Promise<void> {
    this.#swapping = true;
    this.#own({ state: "swapped", rollout: r.id, step: null, drained: true, waitingOn: [], late });
    await this.#flush();
    const plan: SwapPlan = {
      rollout: r.id, build: r.build, previousBuild: this.#build.buildId, platform: this.#build.platform, healthMs: r.healthMs,
      late,
    };
    this.#deps.log(`meddle: update: swapping to build ${r.build}${late ? " (catching up with the pool)" : ""}`);
    try {
      await this.#deps.swap(plan);
    } catch (err) {
      this.#swapping = false;
      this.#own({ state: "failed", rollout: r.id, reason: `the swap failed: ${messageOf(err)}`, step: null, late });
    }
  }

  /** Exchanges views with every online member, waiting at most `FLUSH_MS`. */
  async #flush(): Promise<void> {
    const peers = this.#deps.net.online().filter((id) => this.#deps.isMember(id));
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(peers.map((id) => this.#exchangeWith(id))),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, FLUSH_MS); }),
    ]);
    clearTimeout(timer);
  }

  /**
   * Drops what this node started for a rollout it is no longer part of (it failed or was superseded): the fetch in
   * flight, the staged binary, the holds, and a `staged` or `draining` record (back to `idle`). A `failed` record stays:
   * the failure is the news.
   */
  async #abandon(keep: string | null): Promise<void> {
    if (this.#job !== null && this.#job.rollout !== keep) {
      this.#job.cancelled = true;
      this.#job = null;
      await rm(this.#deps.files.staged, { force: true }).catch(() => {});
      await rm(this.#deps.files.stagedPart, { force: true }).catch(() => {});
    }
    const own = this.#view.nodes[this.#self];
    if (own === undefined || own.rollout === null || own.rollout === keep) return;
    if (!(own.state === "staged" || own.state === "draining" || (own.state === "idle" && own.step != null))) return;
    const r = this.#view.rollouts.find((x) => x.id === own.rollout);
    await rm(this.#deps.files.staged, { force: true }).catch(() => {});
    const why = r?.outcome?.status === "failed" ? `the rollout failed: ${r.outcome.reason}` : null;
    this.#own({ state: "idle", reason: why, step: null, drained: false, waitingOn: [] });
  }

  /**
   * On the new build, before confirmation: reports `swapped` until serving and back in the pool, then `healthy`; rolls
   * back when the rollout fails; finalizes once the rollout is confirmed (a late node's already is, so it finalizes once
   * healthy). Its own health deadline is the guard's: `serve` exits when it passes unhealthy (`watchHealth`), however
   * far it got, and the guard rolls it back.
   */
  async #stepAwaiting(now: number): Promise<void> {
    const p = this.#awaiting!;
    const awaiting = `update in progress: build ${p.build} awaits confirmation`;
    this.#setHolds({ turns: awaiting, work: awaiting, hosting: awaiting });
    const r = this.#view.rollouts.find((x) => x.id === p.rollout) ?? null;
    const mine = r === null ? "swapped" : stateIn(this.#view, r, this.#self);
    if (r?.outcome?.status === "failed" && !p.late) {
      // Its own failure (as it or another node judged it), or the pool's elsewhere.
      const self = mine === "failed" || r.outcome.node === this.#self;
      const reason = mine === "failed" ? this.#view.nodes[this.#self]?.reason ?? r.outcome.reason
        : self ? r.outcome.reason : `the rollout failed: ${r.outcome.reason}`;
      return this.#rollBackSelf(p, { failed: self, reason });
    }
    if (mine === "healthy") {
      if (r?.outcome?.status === "confirmed") await this.#finalize();
      return;
    }
    if (mine !== "swapped") this.#own({ state: "swapped", rollout: p.rollout, step: null, late: p.late, reason: null, drained: true, waitingOn: [] });
    if (this.#servingAt !== null && this.#rejoined(now)) {
      this.#own({ state: "healthy", rollout: p.rollout, step: null, late: p.late, reason: null });
      this.#awaiting = { ...p, healthy: true, starts: 0 };
      await writePending(this.#deps.files, this.#awaiting);
      if (r?.outcome?.status === "confirmed") await this.#finalize();
    }
  }

  /**
   * Serving, and connected to a member: at once in a pool of one, else once a member is online, or after serving for
   * `REJOIN_GRACE_MS` with none online (a node with no online peers is rejoined once it serves; the grace lets the
   * connections it does have come up first).
   */
  #rejoined(now: number): boolean {
    if (this.#deps.members().every((id) => id === this.#self)) return true;
    const peers = this.#deps.net.online().filter((id) => this.#deps.isMember(id));
    return peers.length > 0 || (this.#servingAt !== null && now - this.#servingAt >= REJOIN_GRACE_MS);
  }

  /** Has the guard roll this node back on its restart (binary and databases), recording why first. */
  async #rollBackSelf(p: Pending, outcome: { failed: boolean; reason: string }): Promise<void> {
    if (this.#swapping) return;
    this.#swapping = true;
    this.#deps.log(`meddle: update: rolling back to build ${p.previousBuild}: ${outcome.reason}`);
    await writePending(this.#deps.files, { ...p, phase: "rollback", failed: outcome.failed, reason: outcome.reason });
    await this.#flush();
    await this.#deps.restart();
  }

  /** The rollout is confirmed here: the database copy, the previous binary and the swap record go, and the holds lift. */
  async #finalize(): Promise<void> {
    const p = this.#awaiting!;
    await clearSwap(swapFiles(this.#deps.files, p));
    this.#awaiting = null;
    this.#deps.log(`meddle: update: build ${p.build} confirmed here`);
    this.#setHolds(NO_HOLDS);
    this.#emit();
  }

  /**
   * Starts a rollout (`meddle update <binaries>`), or forces the open one (`--force`, with no binaries or the open
   * rollout's own). Refused, before anything changes: binaries of different builds, or two for one platform; a rollout
   * already in progress; an online binary node that has not reported its build, speaks an OTA version this build cannot
   * drive, cannot be updated, or has no binary for its platform; no node to update. Every online binary node not on the
   * build, or not on its binary, takes part, one behind the pool's build (its own update failed) included: so the
   * pool's own build may be rolled out again, to update just the nodes behind it. Returns the rollout as it starts.
   */
  async startRollout(req: StartRequest): Promise<{ rollout: string; build: string; escalated: boolean; participants: string[] }> {
    const open = currentRollout(this.#view)?.outcome === null ? currentRollout(this.#view) : null;
    const builds = [...new Set(req.binaries.map((b) => b.buildId))];
    if (builds.length > 1) throw new Error(`the binaries are of different builds (${builds.join(", ")})`);
    const platforms = req.binaries.map((b) => b.platform);
    const twice = platforms.find((p, i) => platforms.indexOf(p) !== i);
    if (twice !== undefined) throw new Error(`two binaries for ${twice}`);
    if (open !== null) {
      if (req.force && (builds.length === 0 || builds[0] === open.build)) {
        if (open.mode !== "forced") this.#setRollout(open.id, { mode: "forced" });
        await this.poke();
        return { rollout: open.id, build: open.build, escalated: true, participants: open.participants };
      }
      throw new Error(`a rollout is already in progress (build ${open.build}); --force forces it, or wait for it to end`);
    }
    if (builds.length === 0) throw new Error(req.force ? "no rollout is in progress to force" : "give the binaries to roll out");
    const build = builds[0]!;
    // Every online binary node takes part, unless it already runs the build's binary; each must be able to.
    await this.poke();
    const online = [this.#self, ...this.#deps.net.online().filter((id) => id !== this.#self && this.#deps.isMember(id))];
    const participants: string[] = [];
    let current = 0;
    for (const id of online) {
      const rec = this.#view.nodes[id];
      const who = this.#deps.name(id);
      if (rec === undefined) throw new Error(`${who} has not reported its build yet (it may run a meddle older than updates); try again shortly`);
      if (rec.build === CHECKOUT_BUILD) continue;
      // On the build already, with its binary: nothing to do. A binary that is not the rollout's, or was replaced on
      // disk, is updated like any other.
      const want = req.binaries.find((b) => b.platform === rec.platform);
      if (rec.build === build && rec.binaryChanged !== true && (want === undefined || rec.sha256 === undefined || rec.sha256 === want.sha256)) {
        current++;
        continue;
      }
      // A node the rollout drives must speak an OTA version this build can drive.
      if (rec.ota === undefined || !OTA_DRIVES.includes(rec.ota)) {
        throw new Error(`${who} speaks OTA version ${rec.ota ?? "unknown"}, which this build cannot drive (it drives ${OTA_DRIVES.join(", ")})`);
      }
      if (rec.blocked != null) throw new Error(`${who} cannot be updated: ${rec.blocked}`);
      if (!platforms.includes(rec.platform)) throw new Error(`no binary for ${who}'s platform, ${rec.platform}`);
      participants.push(id);
    }
    if (participants.length === 0) {
      if (poolBuild(this.#view) === build) throw new Error(`the pool already runs build ${build}, and no node needs it`);
      throw new Error(current > 0 ? `the pool already runs build ${build}` : "no online node can take it: each runs from a checkout");
    }
    // The binaries are this node's to serve: copied into its store, each checked against its hash (and not pruned
    // meanwhile: the rollout is not in the view yet).
    const { files } = this.#deps;
    this.#storing.add(build);
    try {
      for (const b of req.binaries) {
        const dest = storedBinary(files, build, b.platform);
        await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
        await copyFile(b.path, `${dest}.part`);
        const got = await hashFile(`${dest}.part`);
        if (got.sha256 !== b.sha256 || got.size !== b.size) {
          await rm(`${dest}.part`, { force: true });
          throw new Error(`${b.path} changed while it was read`);
        }
        await rename(`${dest}.part`, dest);
      }
    } catch (err) {
      this.#storing.delete(build);
      throw err;
    }
    // Started after the newest rollout this node knows, whatever its clock says: the newest start is the open rollout.
    const newest = currentRollout(this.#view);
    const startedAt = Math.max(this.#now(), newest === null ? 0 : Date.parse(newest.startedAt) + 1);
    const within = req.withinMs ?? this.#deps.withinMs();
    const r: Rollout = {
      v: ROLLOUT_V,
      id: newRolloutId(),
      build,
      binaries: req.binaries.map((b) => ({ platform: b.platform, sha256: b.sha256, size: b.size })),
      startedBy: this.#self,
      startedAt: new Date(startedAt).toISOString(),
      mode: req.force ? "forced" : "queued",
      participants: participants.sort(),
      deadline: new Date(startedAt + within).toISOString(),
      healthMs: this.#deps.healthMs(),
      outcome: null,
    };
    this.#view = { ...this.#view, rollouts: [...this.#view.rollouts, r] };
    this.#rolloutSeen.set(r.id, this.#now());
    this.#storing.delete(build);
    this.#deps.log(`meddle: update: rolling out build ${build} (${r.mode}) to ${participants.map((p) => this.#deps.name(p)).join(", ")}`);
    this.#persist();
    this.#emit();
    this.#broadcastSoon();
    await this.poke();
    return { rollout: r.id, build, escalated: false, participants: r.participants };
  }

  /**
   * Why this node accepts no input now, or null: from its database copy (it runs the new build, awaiting confirmation)
   * until the pool confirms or it rolls back, since a rollback's restore would wipe anything it accepted.
   */
  inputHold(): string | null {
    return this.#awaiting === null ? null : inputRefusal(this.#awaiting.build);
  }

  /** What is held here now (turns), or null. */
  held(): string | null {
    return this.#holds?.turns ?? null;
  }

  /** The builds and update states of the pool, and the current rollout, for the CLI and the dashboard. */
  snapshot(): UpdateSnapshot {
    const view = this.#view;
    const pool = confirmedRollout(view)?.build ?? null;
    const r = currentRollout(view);
    const failed = lastFailure(view);
    const online = (id: string) => this.#online(id);
    return {
      self: this.#self,
      build: this.#build,
      poolBuild: pool,
      rollout: r === null ? null : {
        id: r.id, build: r.build, mode: r.mode, startedBy: r.startedBy, startedAt: r.startedAt, healthMs: r.healthMs,
        // On this node's clock (it judges by it), not the starter's.
        deadline: new Date(this.#deadlineOf(r)).toISOString(),
        platforms: r.binaries.map((b) => b.platform),
        outcome: r.outcome,
        participants: r.participants.map((p) => {
          const rec = recordFor(view, r, p);
          return {
            node: p, state: rec?.state ?? "idle", step: rec?.step ?? null, reason: rec?.reason ?? null, drained: rec?.drained === true,
            waitingOn: rec?.waitingOn ?? [], online: online(p), at: rec?.at ?? null,
          };
        }),
        waiting: r.outcome === null ? waitingOn(view, r, online) : [],
      },
      lastFailure: failed === null || failed.outcome?.status !== "failed" ? null : {
        rollout: failed.id, build: failed.build, node: failed.outcome.node, reason: failed.outcome.reason, at: failed.outcome.at,
      },
      awaitingConfirmation: this.#awaiting !== null,
      held: this.held(),
      nodes: Object.values(view.nodes).map((n) => ({
        node: n.node, build: n.build, platform: n.platform, state: n.state, reason: n.reason, step: n.step ?? null,
        late: n.late === true, blocked: n.blocked ?? null, mismatched: behindPool(view, n.build, n.platform, n.sha256),
        binary: binaryProblem(view, n), at: n.at,
      })),
    };
  }

  /** What the rollout waits on, in words (`pi's turn in task 0012`), or null when none is open. */
  waitingText(): string | null {
    const r = currentRollout(this.#view);
    if (r === null || r.outcome !== null) return null;
    return describeWaiting(waitingOn(this.#view, r, (id) => this.#online(id)), this.#deps.name);
  }
}

/**
 * What `serve` reads before it opens anything (after `settleSwap`): the stored view, a swap this binary is the new
 * build of (awaiting confirmation), which start this is, counted in `state.json`, and its binary's SHA-256.
 */
export async function bootUpdate(files: UpdateFiles, build: BuildInfo): Promise<UpdaterBoot> {
  const state = await readState(files);
  const boot = state.boots + 1;
  await writeState(files, { ...state, boots: boot });
  const pending = await readPending(files);
  const awaiting = pending !== null && pending.phase === "swapped" && pending.build === build.buildId ? pending : null;
  const stat = build.buildId === CHECKOUT_BUILD ? null : await statMark(files.exec).catch(() => null);
  const sha256 = stat === null ? null : (await hashFile(files.exec).catch(() => null))?.sha256 ?? null;
  return { view: state.view, awaiting, boot, sha256, stat };
}

/** Whether a node starting with `boot` holds its turns from the start: on an unconfirmed build, or behind the pool's. */
export function holdsAtBoot(boot: UpdaterBoot, build: BuildInfo): boolean {
  if (build.buildId === CHECKOUT_BUILD) return false;
  return boot.awaiting !== null || behindPool(boot.view, build.buildId, build.platform, boot.sha256 ?? undefined);
}
