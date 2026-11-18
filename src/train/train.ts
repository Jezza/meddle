// The merge train's conductor (the spec's "The conductor"). Each project's train is run by its home node: whenever
// something could change a round's outcome (a task queued, a queued task's turn ending, the branch moving, Resume or
// Retry) and the train is not paused, the home runs a round (`runRound`) as a durable `meddle.train`, one at a time per
// project. A round's checkpoints survive a restart, which resumes it. Where a round is, why the train is paused, and
// the tasks sitting out or held back are kept in the `trains` table: a round left unfinished (paused, or failed) is
// resumed from there by the next. What a round asks of a task goes to this node's runner when this node holds the task,
// and to its holder over the pool otherwise.
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { Ref, Subscribable } from "@earendil-works/chord";
import { awaitWithContext, BACKGROUND_CONTEXT, withAbortSignal, type Context } from "@earendil-works/chord/context";
import { defineTask, type Harness, type TaskInspection, type TaskRuntime } from "@earendil-works/pi-durable";
import type { NodeConfig } from "../config";
import { changesIn, commitsIn, type CommitInfo } from "../jj";
import { paths } from "../paths";
import { shortId } from "../pool/ids";
import { remoteReason } from "../pool/object";
import { dedupe } from "../pool/report";
import { branchChanges, lineChanges, listLineRows, type LineRow } from "../pool/rows";
import type { PoolRuntime } from "../pool/runtime";
import { advanceBranch } from "../projects/advance";
import { catchUp } from "../projects/applier";
import { releaseLineRows } from "../projects/lines";
import { getProject, listProjects, projectChanges, type Project } from "../projects/project";
import type { ReplicaDeps } from "../projects/replicas";
import { defaultBranchCommit, mergeStartAt, type StartDeps } from "../projects/starts";
import { PeerObject } from "../state/contracts";
import { getTask, listTasks, newId } from "../store/records";
import { containedIn, effectiveHead } from "../tasks/accept";
import type { MeddleHooks, TaskRunner, TrainTaskStatus } from "../tasks/durable";
import type { TaskManifest } from "../tasks/manifest";
import { sizeOf, type Candidate } from "./batch";
import { NodeOffline, runRound, TaskGone, waitingFor, type RoundDeps, type RoundResult, type RoundStep } from "./round";

/** What `meddle.train` is given: the project whose train runs a round. */
export type TrainInput = { projectId: string };

/**
 * Where a round is, as its `meddle.train` checkpoints it: `idle` before it starts, then the round's own steps
 * (`RoundStep`). pi-durable names a task's phases by `phase`; a round has one.
 */
export type TrainCheckpoint = { phase: "round" } & (RoundStep | { step: "idle" });

type TrainRuntime = TaskRuntime<TrainInput, TrainCheckpoint, null, MeddleHooks>;
type PeerRef = Extract<Ref<typeof PeerObject>, { variant: "peer" }>;

/**
 * A queued task as the train's page shows it: its own turn running (`turn running`), in a describe or a rebase (or fix)
 * turn of the train's (`describing`, `rebasing onto main`), in the batch being checked or landed (`in the batch`),
 * sitting out until Retry (`sitting out`), waiting for its node to come back (`waiting for <node>`), or none of these,
 * waiting in the queue (`queued`).
 */
export type QueuedTaskState =
  | "queued" | "turn running" | "describing" | "rebasing onto main" | "in the batch" | "sitting out" | `waiting for ${string}`;

/**
 * A project's train: why it is paused (null: it runs), where its round is (null when none is under way or left
 * unfinished), and its queue in the order tasks were accepted, each with its state and the reason for it (why it sits
 * out, or the notice that holds it back).
 */
export type TrainState = {
  paused: string | null;
  round: RoundStep | null;
  queued: Array<{ taskId: string; state: QueuedTaskState; reason: string | null }>;
};

/** What the conductor of a node needs: the node's config, database, pool and runner, and its input gate. */
export type TrainDeps = {
  cfg: NodeConfig;
  db: Database;
  pool: PoolRuntime;
  runner: TaskRunner;
  /** Why this node takes no input now (an update awaits confirmation), or null: a landing is refused with it. */
  inputHold?: () => string | null;
  /** Where `meddle: train: …` lines go (each distinct line at most once a minute); default `console.error`. */
  log?: (line: string) => void;
};

/** How long a round waits after rounds in a row that landed nothing and asked for another: at first, then doubling. */
const PACE_FIRST_MS = 1000;
const PACE_MAX_MS = 30_000;
/** How long a train paused by a refusal that passes by itself (an input hold, a branch being fetched) waits for Retry. */
const AUTO_RETRY_MS = 30_000;
/** How often the conductor looks for a round no event starts (a task elsewhere idle again, a hold lifted). */
const LOOK_MS = 20_000;
/** How long catching up on a project's rows and commits from the peers may take, for a round. */
const CATCH_UP_MS = 5000;
/** Why a train pauses whose round the restart limit parked. */
const PARKED = "its round was cut off by restarts too often";

function messageOf(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim();
}

/** The user paused the train: a round stops before anything new starts, and nothing lands. */
class TrainPaused extends Error {
  constructor() {
    super("the train is paused");
    this.name = "TrainPaused";
  }
}

// ─── the trains table ───

/** A project's train as the `trains` table keeps it. */
type TrainRow = { paused: string | null; sitting: Record<string, string>; held: Record<string, string>; round: RoundStep | null };
type TrainRecord = { paused: string | null; sitting: string; held: string; round: string | null };

function parsed<T>(text: string | null, fallback: T): T {
  if (text === null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function readTrain(db: Database, projectId: string): TrainRow {
  const r = db.query<TrainRecord, [string]>("SELECT paused, sitting, held, round FROM trains WHERE project = ?").get(projectId);
  if (r === null) return { paused: null, sitting: {}, held: {}, round: null };
  return { paused: r.paused, sitting: parsed(r.sitting, {}), held: parsed(r.held, {}), round: parsed<RoundStep | null>(r.round, null) };
}

/** Changes project `projectId`'s train row as `change` says, in one transaction (made when it has none). */
function updateTrain(db: Database, projectId: string, change: (t: TrainRow) => TrainRow): TrainRow {
  return db.transaction(() => {
    const t = change(readTrain(db, projectId));
    db.query(
      `INSERT INTO trains (project, paused, sitting, held, round) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (project) DO UPDATE SET
         paused = excluded.paused, sitting = excluded.sitting, held = excluded.held, round = excluded.round`,
    ).run(projectId, t.paused, JSON.stringify(t.sitting), JSON.stringify(t.held), t.round === null ? null : JSON.stringify(t.round));
    return t;
  }).immediate();
}

function without(entries: Record<string, string>, drop: (taskId: string) => boolean): Record<string, string> {
  return Object.fromEntries(Object.entries(entries).filter(([taskId]) => !drop(taskId)));
}

const trainListeners = new Set<(projectId: string) => void>();

/** Fires with a project's id when its train was paused or resumed, or a task of it retried, on this node. */
export const trainChanges: Subscribable<string> = {
  subscribe(cb) {
    trainListeners.add(cb);
    return () => { trainListeners.delete(cb); };
  },
};

function tell(projectId: string): void {
  for (const cb of [...trainListeners]) {
    try {
      cb(projectId);
    } catch {
      // A listener's failure is its own.
    }
  }
}

/**
 * Pauses project `projectId`'s train for `reason` (the user's Pause), or (null) lets it run again: Resume, and the
 * train's Retry after it paused by itself. Paused, a round under way lets its running turns finish but lands nothing and
 * starts nothing new, and no round starts, across restarts too. Running again, a round starts, resuming from where the
 * last one stopped (a merge task it left is discarded and the batch checked afresh).
 */
export function pauseTrain(db: Database, projectId: string, reason: string | null): void {
  updateTrain(db, projectId, (t) => ({ ...t, paused: reason }));
  tell(projectId);
}

/** Retry for task `taskId` of project `projectId`'s train: it no longer sits out, and a round starts. */
export function retryTask(db: Database, projectId: string, taskId: string): void {
  updateTrain(db, projectId, (t) => ({ ...t, sitting: without(t.sitting, (id) => id === taskId) }));
  tell(projectId);
}

/** Project `project`'s queue: the tasks' own lines (the project's name) queued, live, in the order they were accepted. */
function queueOf(db: Database, project: Pick<Project, "id" | "name">): LineRow[] {
  return listLineRows(db, project.id)
    .filter((r) => r.name === project.name && r.queuedAt !== null && !r.archived && r.commit !== null)
    .sort((a, b) => a.queuedAt!.localeCompare(b.queuedAt!) || a.task.localeCompare(b.task));
}

/**
 * Project `projectId`'s train (`TrainState`): its queue from the tasks' line rows, each task's state from the train's
 * row and its round's step; `turn running` only for a task this node holds (another node's tasks show as `queued`).
 */
export function trainState(db: Database, projectId: string): TrainState {
  const train = readTrain(db, projectId);
  const project = getProject(db, projectId);
  const { round } = train;
  const queued = project === null ? [] : queueOf(db, project).map((r): TrainState["queued"][number] => {
    const sitting = train.sitting[r.task];
    if (sitting !== undefined) {
      return { taskId: r.task, state: sitting.startsWith("waiting for ") ? (sitting as QueuedTaskState) : "sitting out", reason: sitting };
    }
    if (round !== null && round.batch.includes(r.task) && round.step !== "picking") {
      const state = round.step === "describing" ? "describing" : round.step === "rebasing" ? "rebasing onto main" : "in the batch";
      return { taskId: r.task, state, reason: null };
    }
    const task = getTask(db, r.task);
    if (task?.state === "running" || task?.state === "waiting") return { taskId: r.task, state: "turn running", reason: null };
    return { taskId: r.task, state: "queued", reason: train.held[r.task] ?? null };
  });
  return { paused: train.paused, round, queued };
}

// ─── the durable round ───

/** The conductor of the node a Harness runs on, once it runs: a round's phase waits for it, as a turn waits for its runner. */
class ConductorSlot {
  current: Conductor | null = null;
  readonly #waiters = new Set<(c: Conductor) => void>();

  bind(c: Conductor): void {
    this.current = c;
    for (const wake of [...this.#waiters]) wake(c);
    this.#waiters.clear();
  }

  unbind(c: Conductor): void {
    if (this.current === c) this.current = null;
  }

  async get(context: Context): Promise<Conductor> {
    if (this.current !== null) return this.current;
    const { promise, resolve } = Promise.withResolvers<Conductor>();
    this.#waiters.add(resolve);
    try {
      return await awaitWithContext(promise, context);
    } finally {
      this.#waiters.delete(resolve);
    }
  }
}

const slots = new WeakMap<Harness, ConductorSlot>();

function slotOf(harness: Harness): ConductorSlot {
  let slot = slots.get(harness);
  if (slot === undefined) {
    slot = new ConductorSlot();
    slots.set(harness, slot);
  }
  return slot;
}

async function conductorFor(runtime: TrainRuntime, context: Context): Promise<Conductor> {
  let harness: Harness | undefined;
  await runtime.hooks.each("harness", (get) => { harness = get(); });
  if (harness === undefined) throw new Error("the meddle extension is not installed");
  return slotOf(harness).get(context);
}

function isParked(t: TaskInspection): boolean {
  return t.state.kind === "blocked" && t.state.reason === "restart_limit";
}

/** The round step of a checkpoint past `idle`. */
function stepOf(checkpoint: TrainCheckpoint): RoundStep | null {
  if (checkpoint.step === "idle") return null;
  return { step: checkpoint.step, batch: [...checkpoint.batch], mergeTask: checkpoint.mergeTask };
}

/**
 * One round of a project's train (`runRound`), on its home. It starts at `idle` and resumes from the round left
 * unfinished in the `trains` table, if any; from a checkpoint past `idle` (a restart cut it off), from there. Each of
 * the round's checkpoints is committed and kept in the table. A round that ends lets the table forget it; one that
 * pauses the train records why (unless the user paused it) and is kept for Retry, as is one that failed. A round of a
 * project not homed here, or of a paused train, does nothing. Cut off by the node stopping, it records nothing and runs
 * again from its checkpoint after the restart.
 */
export const MeddleTrain = defineTask<TrainInput, TrainCheckpoint, null, MeddleHooks>({
  name: "meddle.train",
  version: 1,
  initial: () => ({ phase: "round", step: "idle" }),
  phases: {
    round: async (task, runtime, phaseContext) => {
      const signals = phaseContext.abortSignal ? [phaseContext.abortSignal, runtime.signal] : [runtime.signal];
      const context = withAbortSignal(AbortSignal.any(signals), phaseContext);
      const conductor = await conductorFor(runtime, context);
      await conductor.run(task.input.projectId, task.state.checkpoint, runtime, context);
    },
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
  },
});

/**
 * How a round ended, for what comes next: it ran (`result`; `transient`, the reason it paused when that passes by
 * itself), the user paused the train under it (`held`), it failed (`error`), or no round ran (`skipped`).
 */
type Ended =
  | { kind: "round"; result: RoundResult; transient: string | null }
  | { kind: "held" }
  | { kind: "failed"; error: unknown }
  | { kind: "skipped" };

/** What a round keeps while it runs: its `B`, whether it read its candidates yet, and why a landing was refused for now. */
type RoundRun = { B: string | null; first: boolean; transient: string | null };

/** How one project's train runs on its home. */
type ProjectTrain = {
  /** A `meddle.train` of it is live in the Harness. */
  running: boolean;
  /** Something happened while it ran (or while a round was due): one more round after it. */
  pending: boolean;
  /** Rounds in a row that landed nothing and asked for another: the next waits `pace(streak)`. */
  streak: number;
  notBefore: number;
  /** The next round, held back by pacing. */
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Retry of a pause that passes by itself. */
  retry: ReturnType<typeof setTimeout> | undefined;
  /** A round was due while the runner held turns or work (a pool update): started once the hold lifts. */
  heldUp: boolean;
};

/** Rejects once `signal` aborts: the Harness is closing, or the phase's invocation ended. */
function closed(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const stop = () => reject(new Error("the round stops with the node"));
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
  });
}

function pace(streak: number): number {
  return streak <= 0 ? 0 : Math.min(PACE_FIRST_MS * 2 ** (streak - 1), PACE_MAX_MS);
}

/**
 * Runs the merge trains of the projects homed on this node (`project.home`), until the returned stop. A project's round
 * starts when one of its tasks is queued or leaves the queue, when a queued task's line moves or its turn ends here, when
 * its branch moves, on Resume or Retry, when a node that held tasks sitting out comes back, and when a task of it held
 * elsewhere is found idle again (looked for every 20 s): one round at a time, none while the train is paused, none while
 * a pool update holds turns or work here (started once it lifts), and only when a task waits in the queue or a round is
 * left to resume. After a round that asked for another, the next starts at once after a landing, and after rounds in a
 * row that landed nothing it waits 1 s, doubling to 30 s. A train paused by a refusal that passes by itself (an input
 * hold, a branch still being fetched) is retried after 30 s. Rounds run only on the home; other nodes run none of
 * them.
 *
 * At its start, a round the restart limit parked is aborted and pauses its train, a second live round of a project is
 * aborted, and each merge task this node holds for a train homed here that no round names, and whose merge is not on
 * the branch, is discarded: one a round made and lost to a restart.
 */
export function startTrains(deps: TrainDeps): () => void {
  const conductor = new Conductor(deps);
  conductor.start();
  return () => conductor.stop();
}

class Conductor {
  readonly #cfg: NodeConfig;
  readonly #db: Database;
  readonly #pool: PoolRuntime;
  readonly #runner: TaskRunner;
  readonly #harness: Harness;
  readonly #selfId: string;
  readonly #inputHold: (() => string | null) | undefined;
  readonly #log: (line: string) => void;
  #stopped = false;
  /** Rounds start once the Harness's rounds are known and the orphans swept. */
  #ready = false;
  readonly #stops: Array<() => void> = [];
  readonly #trains = new Map<string, ProjectTrain>();
  /** What each queued task's own line was as last seen (`queuedAt`, commit, holder), by project and task. */
  readonly #seen = new Map<string, string>();
  /** The titles of tasks held elsewhere, as their holders last said. */
  readonly #titles = new Map<string, string>();
  #looker: ReturnType<typeof setInterval> | undefined;

  constructor(deps: TrainDeps) {
    this.#cfg = deps.cfg;
    this.#db = deps.db;
    this.#pool = deps.pool;
    this.#runner = deps.runner;
    this.#harness = deps.runner.harness;
    this.#selfId = deps.pool.identity.id;
    this.#inputHold = deps.inputHold;
    this.#log = dedupe(deps.log ?? ((line) => console.error(line)));
  }

  start(): void {
    /** Out of the event's own stack (a row write's, say), and never thrown into it. */
    const later = (f: () => void | Promise<void>) => queueMicrotask(() => {
      if (this.#stopped) return;
      Promise.resolve().then(f).catch((err: unknown) => this.#log(`meddle: train: ${messageOf(err)}`));
    });
    this.#stops.push(
      lineChanges.subscribe(({ project, task }) => later(() => this.#lineChanged(project, task))),
      branchChanges.subscribe((project) => later(() => this.#kick(project))),
      trainChanges.subscribe((project) => later(() => this.#kick(project))),
      projectChanges.subscribe(() => later(() => { for (const p of this.#homeProjects()) this.#kick(p.id); })),
      this.#runner.onState((taskId, state) => { if (state === "idle") later(() => this.#taskIdle(taskId)); }),
      this.#pool.net.onPeer((nodeId, online) => { if (online) later(() => this.#nodeBack(nodeId)); }),
    );
    this.#looker = setInterval(() => later(() => this.#look()), LOOK_MS);
    this.#looker.unref?.();
    this.#init().catch((err: unknown) => this.#log(`meddle: train: the conductor did not start: ${messageOf(err)}`));
  }

  stop(): void {
    this.#stopped = true;
    for (const stop of this.#stops.splice(0)) stop();
    clearInterval(this.#looker);
    for (const t of this.#trains.values()) {
      clearTimeout(t.timer);
      clearTimeout(t.retry);
    }
    slotOf(this.#harness).unbind(this);
  }

  /** What the Harness holds of rounds, the orphan merge tasks swept, then every train homed here looked at. */
  async #init(): Promise<void> {
    const { tasks } = await this.#harness.inspect(BACKGROUND_CONTEXT);
    const named = new Set<string>();
    for (const t of tasks) {
      if (t.record.kind !== MeddleTrain.definition.name || t.record.state.status === "terminal") continue;
      const { projectId } = t.record.input as TrainInput;
      const checkpoint = (t.record.state as { checkpoint?: TrainCheckpoint }).checkpoint;
      const step = checkpoint === undefined ? null : stepOf(checkpoint);
      if (step?.mergeTask != null) named.add(step.mergeTask);
      const train = this.#train(projectId);
      if (isParked(t)) {
        // A round that kept stopping the node waits for the user; Retry resumes it from its checkpoint.
        updateTrain(this.#db, projectId, (r) => ({ ...r, paused: r.paused ?? PARKED, round: step ?? r.round }));
        await this.#harness.abortTask(t.record.id, BACKGROUND_CONTEXT).catch((err: unknown) => {
          this.#log(`meddle: train: the parked round of project ${shortId(projectId)} was not aborted: ${messageOf(err)}`);
        });
      } else if (train.running) {
        await this.#harness.abortTask(t.record.id, BACKGROUND_CONTEXT).catch(() => {});
      } else train.running = true;
    }
    for (const p of this.#homeProjects()) {
      const kept = readTrain(this.#db, p.id).round?.mergeTask;
      if (kept != null) named.add(kept);
    }
    await this.#sweep(named);
    if (this.#stopped) return;
    this.#ready = true;
    slotOf(this.#harness).bind(this);
    for (const p of this.#homeProjects()) this.#kick(p.id);
  }

  /**
   * Discards each merge task this node holds for a train homed here that no round names (`named`) and whose merge is
   * not on the branch: a round made it and lost it to a restart.
   */
  async #sweep(named: ReadonlySet<string>): Promise<void> {
    const home = new Map(this.#homeProjects().map((p) => [p.id, p]));
    for (const row of listTasks(this.#db)) {
      if (row.state === "archived" || row.state === "moved" || row.state === "receiving" || named.has(row.id)) continue;
      const merge = (JSON.parse(row.manifest) as TaskManifest).merge;
      const project = merge === undefined ? undefined : home.get(merge.project);
      if (project === undefined) continue;
      try {
        // A merge that landed is left to acceptance, which archives it.
        const line = this.#ownLine(project, row.id);
        if (line?.commit != null) {
          const head = await effectiveHead(this.#cfg, project.replica, line.commit);
          if (await containedIn(this.#cfg, project.replica, head, [await defaultBranchCommit(this.#startDeps(), project)])) continue;
        }
        await this.#runner.discardMergeTask(row.id);
        this.#log(`meddle: train: discarded merge task ${row.id} of ${project.name}, which no round names`);
      } catch (err) {
        this.#log(`meddle: train: merge task ${row.id} of ${project.name}, which no round names, was not discarded: ${messageOf(err)}`);
      }
    }
  }

  // ─── when rounds start ───

  #train(projectId: string): ProjectTrain {
    let t = this.#trains.get(projectId);
    if (t === undefined) {
      t = { running: false, pending: false, streak: 0, notBefore: 0, timer: undefined, retry: undefined, heldUp: false };
      this.#trains.set(projectId, t);
    }
    return t;
  }

  #homeProjects(): Project[] {
    return listProjects(this.#db).filter((p) => p.home === this.#selfId);
  }

  #home(projectId: string): Project | null {
    const project = getProject(this.#db, projectId);
    return project !== null && project.home === this.#selfId ? project : null;
  }

  /** Something could change the outcome of a round of project `projectId`'s train: one starts, or one more after it. */
  #kick(projectId: string): void {
    if (this.#stopped || !this.#ready || this.#home(projectId) === null) return;
    const t = this.#train(projectId);
    if (t.running || t.timer !== undefined) {
      t.pending = true;
      return;
    }
    const wait = t.notBefore - Date.now();
    if (wait <= 0) {
      this.#start(projectId);
      return;
    }
    t.timer = setTimeout(() => {
      t.timer = undefined;
      this.#start(projectId);
    }, wait);
    t.timer.unref?.();
  }

  #start(projectId: string): void {
    const project = this.#home(projectId);
    if (this.#stopped || project === null) return;
    const t = this.#train(projectId);
    if (t.running) {
      t.pending = true;
      return;
    }
    const train = readTrain(this.#db, projectId);
    if (train.paused !== null) return;
    const holds = this.#runner.holds();
    if (holds.turns !== null || holds.work !== null) {
      t.heldUp = true;
      return;
    }
    t.heldUp = false;
    const waiting = queueOf(this.#db, project).some((r) => train.sitting[r.task] === undefined);
    if (!waiting && train.round === null) return;
    t.running = true;
    t.pending = false;
    this.#createRound(projectId).catch((err: unknown) => {
      this.#log(`meddle: train: a round of ${project.name} did not start: ${messageOf(err)}`);
      this.#ended(projectId, { kind: "failed", error: err });
    });
  }

  async #createRound(projectId: string): Promise<void> {
    const root = await this.#harness.root(BACKGROUND_CONTEXT);
    await root.commit((tx) => tx.createTask(MeddleTrain, { projectId }, { ownership: { kind: "conversation" } }), BACKGROUND_CONTEXT);
  }

  /** A round of project `projectId`'s train ended (`ended`): another starts when it asked for one or something happened. */
  #ended(projectId: string, ended: Ended): void {
    const t = this.#train(projectId);
    t.running = false;
    if (this.#stopped) return;
    if (ended.kind === "round" && ended.result.paused !== null && ended.transient !== null) this.#retryLater(projectId, ended.transient);
    const again = ended.kind === "failed" || (ended.kind === "round" && ended.result.again);
    if (!again && !t.pending) {
      t.streak = 0;
      return;
    }
    const fresh = ended.kind === "skipped" || ended.kind === "held" || (ended.kind === "round" && ended.result.landed !== null);
    t.streak = fresh ? 0 : t.streak + 1;
    t.notBefore = Date.now() + pace(t.streak);
    t.pending = false;
    this.#kick(projectId);
  }

  /** Retries project `projectId`'s train after `AUTO_RETRY_MS`, if it is still paused for `reason`. */
  #retryLater(projectId: string, reason: string): void {
    const t = this.#train(projectId);
    clearTimeout(t.retry);
    t.retry = setTimeout(() => {
      t.retry = undefined;
      if (!this.#stopped && readTrain(this.#db, projectId).paused === reason) pauseTrain(this.#db, projectId, null);
    }, AUTO_RETRY_MS);
    t.retry.unref?.();
  }

  /**
   * A line row of task `taskId` changed: a round starts when its own line was queued, left the queue, or moved while
   * queued (another node's task ends its turn so here). Leaving the queue also drops what the train kept of it.
   */
  #lineChanged(projectId: string, taskId: string): void {
    const project = this.#home(projectId);
    if (project === null) return;
    const row = this.#ownLine(project, taskId);
    const queued = row !== undefined && row.queuedAt !== null && !row.archived && row.commit !== null;
    const key = `${projectId}\0${taskId}`;
    const now = queued ? JSON.stringify([row.queuedAt, row.commit, row.holder]) : null;
    const was = this.#seen.get(key) ?? null;
    if (now === null) this.#seen.delete(key);
    else this.#seen.set(key, now);
    if (!queued) this.#prune(project);
    if (now !== was) this.#kick(projectId);
  }

  /** A task here went idle (a turn of it ended): a round of the train it is queued on starts. */
  #taskIdle(taskId: string): void {
    for (const r of listLineRows(this.#db, undefined, taskId)) {
      if (r.queuedAt !== null && !r.archived && r.holder === this.#selfId) this.#kick(r.project);
    }
  }

  /** Node `nodeId` is back: its tasks no longer sit out waiting for it. */
  #nodeBack(nodeId: string): void {
    const reason = waitingFor(this.#nodeName(nodeId));
    for (const p of this.#homeProjects()) {
      if (!Object.values(readTrain(this.#db, p.id).sitting).includes(reason)) continue;
      updateTrain(this.#db, p.id, (t) => ({ ...t, sitting: without(t.sitting, (id) => t.sitting[id] === reason) }));
      this.#kick(p.id);
    }
  }

  /**
   * What no event tells: a round due while turns or work were held starts once the hold lifts, and one starts when a
   * task held elsewhere (neither sitting out nor held back) is idle again, its turn having ended without moving its line.
   */
  async #look(): Promise<void> {
    for (const p of this.#homeProjects()) {
      const t = this.#train(p.id);
      if (t.running || t.timer !== undefined) continue;
      if (t.heldUp) {
        this.#kick(p.id);
        continue;
      }
      const train = readTrain(this.#db, p.id);
      if (train.paused !== null) continue;
      const elsewhere = new Map<string, string[]>();
      for (const r of queueOf(this.#db, p)) {
        if (r.holder === this.#selfId || train.sitting[r.task] !== undefined || train.held[r.task] !== undefined) continue;
        elsewhere.set(r.holder, [...(elsewhere.get(r.holder) ?? []), r.task]);
      }
      for (const [holder, taskIds] of elsewhere) {
        if (!this.#pool.net.isOnline(holder)) continue;
        const states = await this.#callPeer(holder, (peer) => peer.trainTasks({ taskIds })).catch(() => []);
        if (states.some((s) => s.state === "idle")) {
          this.#kick(p.id);
          break;
        }
      }
    }
  }

  /** Drops what project `project`'s train keeps of tasks no longer queued (sitting out, held back). */
  #prune(project: Project): void {
    const train = readTrain(this.#db, project.id);
    const queued = new Set(queueOf(this.#db, project).map((r) => r.task));
    const gone = (taskId: string) => !queued.has(taskId);
    if (!Object.keys(train.sitting).some(gone) && !Object.keys(train.held).some(gone)) return;
    updateTrain(this.#db, project.id, (t) => ({ ...t, sitting: without(t.sitting, gone), held: without(t.held, gone) }));
  }

  // ─── a round ───

  /** Runs a round of project `projectId`'s train in its `meddle.train`, from `checkpoint`, and ends the task. */
  async run(projectId: string, checkpoint: TrainCheckpoint, runtime: TrainRuntime, context: Context): Promise<void> {
    const stopping = () => this.#stopped || runtime.signal.aborted;
    let ended: Ended = { kind: "failed", error: new Error("the round did not end") };
    try {
      ended = await this.#round(projectId, checkpoint, runtime, context, stopping);
    } finally {
      if (!stopping()) this.#ended(projectId, ended);
    }
  }

  async #round(
    projectId: string, checkpoint: TrainCheckpoint, runtime: TrainRuntime, context: Context, stopping: () => boolean,
  ): Promise<Ended> {
    if (stopping()) return this.#halt(runtime);
    const end = async (ended: Ended): Promise<Ended> => {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
      return ended;
    };
    const train = readTrain(this.#db, projectId);
    const project = this.#home(projectId);
    const at = stepOf(checkpoint);
    if (project === null || project.defaultBranch === null || train.paused !== null) {
      // Kept for when the train runs again.
      if (at !== null) updateTrain(this.#db, projectId, (t) => ({ ...t, round: at }));
      return end({ kind: "skipped" });
    }
    this.#prune(project);
    const round: RoundRun = { B: null, first: true, transient: null };
    const deps = this.#roundDeps(project, round, runtime, context, stopping);
    let result: RoundResult;
    try {
      const running = runRound(deps, this.#cfg, project.replica, this.#pool.settings.describePrompt(), at ?? train.round ?? undefined);
      // The Harness closing ends the phase at once (a turn the round waits for may take long); what the round does
      // after that is refused (`deps`), and it settles unheard.
      running.catch(() => {});
      result = await Promise.race([running, closed(runtime.signal)]);
    } catch (err) {
      if (stopping()) return this.#halt(runtime);
      if (err instanceof TrainPaused) return end({ kind: "held" });
      this.#log(`meddle: train: a round of ${project.name} failed: ${messageOf(err)}`);
      return end({ kind: "failed", error: err });
    }
    if (stopping()) return this.#halt(runtime);
    const paused = result.paused;
    if (paused !== null) {
      updateTrain(this.#db, projectId, (t) => ({ ...t, paused: t.paused ?? paused }));
      return end({ kind: "round", result, transient: round.transient === paused ? paused : null });
    }
    updateTrain(this.#db, projectId, (t) => ({ ...t, round: null }));
    return end({ kind: "round", result, transient: null });
  }

  /**
   * A round cut off as the node stops: it records nothing, and its phase ends as the Harness closes (never before:
   * pi-durable would take the end for a fault), to run again from its checkpoint.
   */
  async #halt(runtime: TrainRuntime): Promise<never> {
    await closed(runtime.signal).catch(() => {});
    throw new Error("the round stops with the node");
  }

  /**
   * What a round of project `project`'s train asks of the world (`RoundDeps`), from here: a task this node holds through
   * the runner, one held elsewhere through its holder's `PeerObject` (an offline holder is `NodeOffline`). Every call
   * is refused once the node stops.
   */
  #roundDeps(project: Project, round: RoundRun, runtime: TrainRuntime, context: Context, stopping: () => boolean): RoundDeps {
    const projectId = project.id;
    const live = () => {
      if (stopping()) throw new Error("the round stops with the node");
    };
    const checkpoint = async (step: RoundStep) => {
      live();
      // Paused: nothing new starts. A merge task named as it is made is still recorded, for the round to discard.
      if (step.mergeTask === null && readTrain(this.#db, projectId).paused !== null) throw new TrainPaused();
      await runtime.commit(() => ({ status: "running", checkpoint: { phase: "round", ...step } }), context);
      const kept: RoundStep = { step: step.step, batch: [...step.batch], mergeTask: step.mergeTask };
      updateTrain(this.#db, projectId, (t) => ({ ...t, round: kept }));
    };
    return {
      projectId,
      branch: async () => {
        live();
        const B = await defaultBranchCommit(this.#startDeps(), getProject(this.#db, projectId) ?? project);
        round.B ??= B;
        return B;
      },
      candidates: async () => {
        live();
        return this.#candidates(project, round);
      },
      lines: async () => {
        live();
        return listLineRows(this.#db, projectId);
      },
      title: async (taskId) => {
        live();
        return this.#title(project, taskId);
      },
      abandonLeftovers: async (taskId, commits) => {
        live();
        await this.#onHolder(project, taskId, (r) => r.abandonLeftovers(taskId, commits), (peer) => peer.abandonLeftovers({ taskId, commits }));
      },
      advance: async (old, next) => {
        live();
        await this.#advance(project, round, old, next);
      },
      leave: async (taskId, reason) => {
        live();
        await this.#leave(project, taskId, reason);
      },
      sitOut: async (taskId, reason) => {
        live();
        this.#sitOut(project, taskId, reason);
      },
      holdBack: async (taskId, notice) => {
        live();
        updateTrain(this.#db, projectId, (t) => ({ ...t, held: { ...t.held, [taskId]: notice } }));
      },
      checkpoint,
      createMergeTask: async (input) => {
        live();
        return this.#createMergeTask(project, input, checkpoint);
      },
      turn: async (taskId, kind, text) => {
        live();
        return this.#onHolder(project, taskId, (r) => r.trainTurn(taskId, kind, text), (peer) => peer.trainTurn({ taskId, kind, text }));
      },
      head: async (taskId) => {
        live();
        return this.#head(project, taskId);
      },
      discard: async (taskId) => {
        live();
        await this.#discard(project, taskId);
      },
    };
  }

  /**
   * The eligible tasks of project `project`'s queue (`RoundDeps.candidates`): queued, not sitting out, idle on their
   * holder (this node's runner, or the holder's `trainTasks`), each tip the line's effective head as this node's repo has
   * it, caught up from the peers first when a task elsewhere is idle. A task whose holder is offline sits out, waiting
   * for it. The tasks of the batch the round is checking or landing stay in: they are idle meanwhile. The first call of
   * a round drops the held-back notices of the tasks it answers: each round decides that afresh.
   */
  async #candidates(project: Project, round: RoundRun): Promise<Candidate[]> {
    const self = this.#selfId;
    const waiting = () => {
      const { sitting } = readTrain(this.#db, project.id);
      return queueOf(this.#db, project).filter((r) => sitting[r.task] === undefined);
    };
    let rows = waiting();
    const status = new Map<string, TrainTaskStatus>();
    for (const s of await this.#runner.trainStatus(rows.filter((r) => r.holder === self).map((r) => r.task))) status.set(s.taskId, s);
    const elsewhere = new Map<string, string[]>();
    for (const r of rows) if (r.holder !== self) elsewhere.set(r.holder, [...(elsewhere.get(r.holder) ?? []), r.task]);
    for (const [holder, taskIds] of elsewhere) {
      try {
        for (const s of await this.#callPeer(holder, (peer) => peer.trainTasks({ taskIds }))) status.set(s.taskId, s);
      } catch (err) {
        if (err instanceof NodeOffline) for (const taskId of taskIds) this.#sitOut(project, taskId, waitingFor(err.node));
        else this.#log(`meddle: train: ${this.#nodeName(holder)} did not say how its tasks queued on ${project.name} stand: ${messageOf(err)}`);
      }
    }
    // What tasks elsewhere did since (a turn's end) is caught up on: their rows, and the commits those name.
    if (rows.some((r) => r.holder !== self && status.get(r.task)?.state === "idle")) {
      await catchUp(this.#replicaDeps(), project.id, CATCH_UP_MS).catch((err: unknown) => {
        this.#log(`meddle: train: could not catch up on ${project.name}: ${messageOf(err)}`);
      });
      rows = waiting();
    }
    const B = round.B ?? await defaultBranchCommit(this.#startDeps(), project);
    const out: Candidate[] = [];
    for (const r of rows) {
      const s = status.get(r.task);
      // A commit not here yet (still being fetched) waits for a later round.
      if (s?.state !== "idle" || r.commit === null || !(await this.#present(project, r.commit))) continue;
      const tip = await effectiveHead(this.#cfg, project.replica, r.commit);
      const title = s.title ?? r.task;
      this.#titles.set(r.task, title);
      out.push({
        taskId: r.task, title, tip, base: [...r.base], workspace: r.holder === self ? this.#workspaceOf(project, r.task) : null,
        size: await sizeOf(this.#cfg, project.replica, B, tip),
      });
    }
    if (round.first) {
      round.first = false;
      const ids = new Set(out.map((c) => c.taskId));
      if (Object.keys(readTrain(this.#db, project.id).held).some((id) => ids.has(id))) {
        updateTrain(this.#db, project.id, (t) => ({ ...t, held: without(t.held, (id) => ids.has(id)) }));
      }
    }
    return out;
  }

  /** How notices name task `taskId`: its title, from here or as its holder says, else its id. */
  async #title(project: Project, taskId: string): Promise<string> {
    const row = getTask(this.#db, taskId);
    if (row !== null) return row.title;
    const known = this.#titles.get(taskId);
    if (known !== undefined) return known;
    const holder = this.#holderOf(project, taskId);
    if (holder === null || holder === this.#selfId) return taskId;
    const [s] = await this.#callPeer(holder, (peer) => peer.trainTasks({ taskIds: [taskId] })).catch(() => []);
    if (s?.title != null) this.#titles.set(taskId, s.title);
    return s?.title ?? taskId;
  }

  /**
   * Moves the branch from `old` to `next` (`advanceBranch`), refused while the train is paused. No task of the batch is
   * kept from being idle by the train meanwhile (its merge task's turn has ended), so each holder's acceptance archives
   * the tasks the move lands, and the merge task. A refusal that passes by itself (the node takes no input for now, or
   * it is still fetching the branch) is noted, for the pause it brings to be retried.
   */
  async #advance(project: Project, round: RoundRun, old: string, next: string): Promise<void> {
    if (readTrain(this.#db, project.id).paused !== null) throw new TrainPaused();
    const branch = getProject(this.#db, project.id)?.defaultBranch ?? project.defaultBranch;
    if (branch === null) throw new Error(`${project.name} has no default branch`);
    try {
      await advanceBranch({ ...this.#replicaDeps(), selfId: this.#selfId, ...(this.#inputHold === undefined ? {} : { inputHold: this.#inputHold }) }, project.id, branch, old, next);
    } catch (err) {
      const why = messageOf(err);
      if ((this.#inputHold?.() ?? null) !== null || /still fetching/.test(why)) round.transient = `landing was refused: ${why}`;
      throw err;
    }
  }

  /** Task `taskId` leaves the queue for `reason`, on its holder (a decline has done so there already); a failure is logged. */
  async #leave(project: Project, taskId: string, reason: string): Promise<void> {
    try {
      await this.#onHolder(project, taskId, (r) => r.unqueue(taskId, reason), (peer) => peer.unqueueTask({ taskId, reason }));
    } catch (err) {
      this.#log(`meddle: train: ${taskId} did not leave the queue of ${project.name} (${reason}): ${messageOf(err)}`);
    }
    const gone = (id: string) => id === taskId;
    updateTrain(this.#db, project.id, (t) => ({ ...t, sitting: without(t.sitting, gone), held: without(t.held, gone) }));
  }

  /** Task `taskId` sits out for `reason`, while it is queued. */
  #sitOut(project: Project, taskId: string, reason: string): void {
    const row = this.#ownLine(project, taskId);
    if (row === undefined || row.queuedAt === null || row.archived) return;
    updateTrain(this.#db, project.id, (t) => ({ ...t, sitting: { ...t.sitting, [taskId]: reason } }));
  }

  /**
   * Makes a merge task (`MergeDeps.createMergeTask`): placed like a new task (the home first, when it hosts tasks; never
   * a node that starts no task on a merge), on a start on `parents` (`mergeStartAt`), its manifest naming the batch. Its
   * id is checkpointed before anything is made, so a round cut off meanwhile discards what was made of it.
   */
  async #createMergeTask(
    project: Project, input: { projectId: string; parents: string[]; title: string; batch: string[] }, checkpoint: (step: RoundStep) => Promise<void>,
  ): Promise<{ taskId: string; nodeId: string }> {
    const taskId = newId();
    await checkpoint({ step: "checking", batch: input.batch, mergeTask: taskId });
    const target = await this.#runner.chooseNode([input.projectId], (id) => this.#runner.noMergeStartsOn(id) === null);
    const start = await mergeStartAt(this.#startDeps(), { projectId: input.projectId, taskId, parents: input.parents });
    const merge = { project: input.projectId, batch: [...input.batch] };
    try {
      if (target === this.#selfId) await this.#runner.create({ title: input.title, taskId, starts: [start], merge });
      else {
        const refusal = this.#runner.noMergeStartsOn(target);
        if (refusal !== null) throw new Error(refusal);
        await this.#callPeer(target, (peer) => peer.createTaskAt({ title: input.title, taskId, starts: [start], prompt: null, nameFromPrompt: false, merge }));
      }
    } catch (err) {
      // A task made all the same keeps its line, for the round to discard.
      const made = target === this.#selfId ? getTask(this.#db, taskId) !== null : await this.#heldOn(target, taskId);
      if (made === false) releaseLineRows(this.#db, taskId, [], project.id);
      throw err;
    }
    return { taskId, nodeId: target };
  }

  /**
   * The head of merge task `taskId`'s line as this node's repo has it (`MergeDeps.head`): its line written again from
   * its workspace when it is here, caught up from its holder otherwise, through `effectiveHead`. `TaskGone` only when it
   * is known to be gone: its line archived or released, its row here deleted or archived, its holder removed from the
   * pool. `NodeOffline` when its holder is offline.
   */
  async #head(project: Project, taskId: string): Promise<CommitInfo> {
    const gone = () => new TaskGone(taskId);
    let row = this.#ownLine(project, taskId);
    if (row === undefined || row.commit === null || row.archived) throw gone();
    if (row.holder === this.#selfId) {
      const task = getTask(this.#db, taskId);
      if (task === null || task.state === "archived") {
        // A start written here for a task never made (or made elsewhere, which then holds its line one epoch up).
        if (task === null) releaseLineRows(this.#db, taskId, [], project.id);
        throw gone();
      }
      await this.#runner.writeTaskLines(taskId);
    } else {
      if (this.#pool.store.row(row.holder)?.status !== "member") throw gone();
      if (!this.#pool.net.isOnline(row.holder)) throw new NodeOffline(this.#nodeName(row.holder));
      await catchUp(this.#replicaDeps(), project.id, CATCH_UP_MS);
    }
    row = this.#ownLine(project, taskId);
    if (row === undefined || row.commit === null || row.archived) throw gone();
    if (!(await this.#present(project, row.commit))) throw new Error(`the line of ${taskId} (${row.commit.slice(0, 12)}) is not here yet`);
    const tip = await effectiveHead(this.#cfg, project.replica, row.commit);
    const [head] = await commitsIn(project.replica, tip, this.#cfg);
    if (head === undefined) throw new Error(`no commit ${tip.slice(0, 12)} in ${project.name}`);
    return head;
  }

  /**
   * Discards merge task `taskId` (`MergeDeps.discard`): archived then deleted on its node, its turn interrupted first.
   * One whose holder was removed from the pool is gone already. A start written here for a task never made here is
   * released.
   */
  async #discard(project: Project, taskId: string): Promise<void> {
    const holder = this.#holderOf(project, taskId) ?? this.#selfId;
    if (holder === this.#selfId) await this.#runner.discardMergeTask(taskId);
    else if (this.#pool.store.row(holder)?.status === "member") await this.#callPeer(holder, (peer) => peer.discardTask({ taskId }));
    const left = this.#ownLine(project, taskId);
    if (getTask(this.#db, taskId) === null && left?.holder === this.#selfId && left.commit !== null) releaseLineRows(this.#db, taskId, [], project.id);
  }

  // ─── where tasks are ───

  /** Task `taskId`'s own line of project `project` (the line named after it): the one its queue and its head are on. */
  #ownLine(project: Project, taskId: string): LineRow | undefined {
    return listLineRows(this.#db, project.id, taskId).find((r) => r.name === project.name);
  }

  /** The node holding task `taskId`: its own line's holder, else this node when it has the task live; null otherwise. */
  #holderOf(project: Project, taskId: string): string | null {
    const row = this.#ownLine(project, taskId);
    if (row !== undefined) return row.holder;
    const task = getTask(this.#db, taskId);
    return task !== null && task.state !== "moved" && task.state !== "archived" ? this.#selfId : null;
  }

  /** Runs `local` with this node's runner when it holds task `taskId`, else `remote` on its holder (`#callPeer`). */
  async #onHolder<T>(project: Project, taskId: string, local: (runner: TaskRunner) => Promise<T>, remote: (peer: PeerRef) => Promise<T>): Promise<T> {
    const holder = this.#holderOf(project, taskId);
    if (holder === null) throw new Error(`no node holds task ${taskId}`);
    return holder === this.#selfId ? local(this.#runner) : this.#callPeer(holder, remote);
  }

  /**
   * Calls node `nodeId`'s `PeerObject` through a Ref taken for the call. `NodeOffline` when the node is offline, or
   * goes offline during the call (a dropped link); another failure with the node's reason.
   */
  async #callPeer<T>(nodeId: string, call: (peer: PeerRef) => Promise<T>): Promise<T> {
    const offline = () => new NodeOffline(this.#nodeName(nodeId));
    if (!this.#pool.net.isOnline(nodeId)) throw offline();
    let ref: Ref<typeof PeerObject>;
    try {
      ref = await this.#pool.peerRef(nodeId, PeerObject);
    } catch (err) {
      if (!this.#pool.net.isOnline(nodeId) || messageOf(err).startsWith("not connected")) throw offline();
      throw err;
    }
    try {
      if (ref.variant !== "peer") throw new Error(`${this.#nodeName(nodeId)} did not serve the peer variant of PeerObject`);
      return await call(ref);
    } catch (err) {
      if (!this.#pool.net.isOnline(nodeId)) throw offline();
      throw new Error(remoteReason(err));
    } finally {
      ref.release();
    }
  }

  /** Whether node `nodeId` holds task `taskId` (`PeerObject.taskHeld`); null when it cannot say. */
  async #heldOn(nodeId: string, taskId: string): Promise<boolean | null> {
    try {
      return await this.#callPeer(nodeId, (peer) => peer.taskHeld({ id: taskId }));
    } catch {
      return null;
    }
  }

  /** How notices name node `nodeId`: its hostname, else its short id. */
  #nodeName(nodeId: string): string {
    const row = this.#pool.store.row(nodeId);
    return row?.summary?.hostname ?? row?.hostname ?? shortId(nodeId);
  }

  /** Task `taskId`'s workspace of project `project` here, or null. */
  #workspaceOf(project: Project, taskId: string): string | null {
    const row = getTask(this.#db, taskId);
    const p = row === null ? undefined : (JSON.parse(row.manifest) as TaskManifest).projects.find((q) => q.id === project.id);
    return p === undefined ? null : join(paths(this.#cfg).task(taskId), p.workspace);
  }

  /** Whether jj in project `project`'s repo here knows `commit`. */
  async #present(project: Project, commit: string): Promise<boolean> {
    return (await changesIn(project.replica, `present(${commit})`, this.#cfg)).length > 0;
  }

  #replicaDeps(): ReplicaDeps {
    return { cfg: this.#cfg, db: this.#db, pool: this.#pool, log: this.#log };
  }

  #startDeps(): StartDeps {
    return { cfg: this.#cfg, db: this.#db, selfId: this.#selfId, pool: this.#pool, log: this.#log };
  }
}
