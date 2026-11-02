import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { PermissionMode, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { forbidden, isChordError } from "@earendil-works/chord";
import { awaitWithContext, BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { defineTask, type Harness, type TaskInspection, type TaskRuntime } from "@earendil-works/pi-durable";
import type { NodeConfig } from "../config";
import { Approvals } from "../engine/approvals";
import { InputQueue } from "../engine/input";
import type { EngineInput } from "../engine/options";
import { promptEvent, runTurn, type MeddleEvent, type TokenFault } from "../engine/session";
import { bookmarkForget, bookmarkList, bookmarkSet, changeId, workspaceForget } from "../jj";
import { checkTaskRoot, paths } from "../paths";
import { shortId } from "../pool/ids";
import { dedupe } from "../pool/report";
import type { PoolRuntime } from "../pool/runtime";
import { loadContext, loadProjectSettings } from "../projects/context";
import { syncMemoryAfter, syncMemoryBefore } from "../projects/memory-sync";
import type { StreamReader } from "../pool/frames";
import { getProject, type Project } from "../projects/project";
import { ensureRemote, ensureReplica, fetchBookmarks, pushBookmark, trunkFor, type ReplicaDeps } from "../projects/replicas";
import { appendEvent, latestEventOfType, listEventsTail, type EventRecord } from "../store/events";
import { SqliteSessionStore } from "../store/session-store";
import {
  clearTaskLog,
  deleteTask,
  getTask,
  getTaskSettings,
  listTasks,
  queuedOf,
  updateTask,
  updateTaskSettings,
  type TaskRow,
  type TaskSettings,
} from "../store/records";
import { markToken, pickToken } from "../token";
import { repoKey, serialised } from "../serial";
import { claudeCodeVersion } from "../version";
import { readManifest, transcriptPath, type TaskManifest } from "./manifest";
import { MeddleMove, type MoveInput } from "./move";
import { checkReceivedManifest, provisionFromManifest, provisionTask } from "./provision";
import { importTask, type Receipt } from "./transfer";

export type TaskState = "idle" | "running" | "waiting" | "receiving" | "moving" | "moved" | "archived";

/**
 * One turn's input. `freshAfter` (the first turn of a task received from another node): the cut-off check looks only at
 * events after this seq, so a turn the sender ended (by moving the task) is never taken for one this node must carry on.
 */
type TurnInput = { taskId: string; prompt: string; freshAfter?: number };
/**
 * Where a turn is. `tokenRetries`: how often `run` was entered again after the turn's token failed it (at most once). A
 * checkpoint stored by an older meddle has none: read it as 0.
 */
type TurnCheckpoint = { phase: "run"; tokenRetries?: number } | { phase: "finish" };
/** Installed by `openHarness`: how a phase finds the Harness it runs in. */
export type MeddleHooks = { harness(): Harness };

/** Test hooks of a runner. */
export type RunnerHooks = {
  /** Called as `activateTask` starts, before anything else; a throw fails the call. */
  beforeActivate?(taskId: string): void | Promise<void>;
  /** Called once `activateTask` made the task live, before it answers. */
  afterActivate?(taskId: string): void | Promise<void>;
  /** Called as `receiveTask` starts its work on the task (after its checks, in the task's serialised section). */
  beforeReceive?(taskId: string): void | Promise<void>;
  /** Called as a failed move restores the task's state; a throw stands for a failure there. */
  beforeRestore?(taskId: string): void | Promise<void>;
  /** Called once a turn's `token_fault` with `rerun: true` is in the log, before the `run` phase enters itself again. */
  afterTokenFault?(taskId: string): void | Promise<void>;
  /** The time a move gives the target to answer `activateTask` (default 30 s). */
  callMs?: number;
};

/** A move of a task in progress here: where to, the step it is at, and the error that is failing it (if any). */
export type MoveState = { to: string; phase: string; error: string | null };

export type RunnerDeps = {
  claudePath?: string;
  claudeRuntime?: "bun" | "node";
  extraEnv?: Record<string, string>;
  /**
   * The node's pool. With it, tasks replicate projects homed elsewhere, start from the home's trunk, push their
   * bookmarks to the home and sync memory around turns; without it, the runner keeps to this node.
   */
  pool?: PoolRuntime;
  /** Where `meddle: git: …` lines go (each distinct line at most once a minute); default `console.error`. */
  log?(line: string): void;
  /** Tests only. */
  hooks?: RunnerHooks;
};

/** One TaskRunner per Harness; a phase may start before its runner exists, so it waits for it. */
type RunnerSlot = PromiseWithResolvers<TaskRunner> & { bound: boolean };
const runners = new WeakMap<Harness, RunnerSlot>();

function runnerSlot(harness: Harness): RunnerSlot {
  let slot = runners.get(harness);
  if (slot === undefined) {
    slot = { ...Promise.withResolvers<TaskRunner>(), bound: false };
    runners.set(harness, slot);
  }
  return slot;
}

/** The TaskRunner of the Harness a phase of a meddle task runs in. */
export async function runnerFor(runtime: { hooks: TaskRuntime<unknown, unknown, unknown, MeddleHooks>["hooks"] }, context: Context): Promise<TaskRunner> {
  let harness: Harness | undefined;
  await runtime.hooks.each("harness", (get) => { harness = get(); });
  if (harness === undefined) throw new Error("the meddle extension is not installed");
  return awaitWithContext(runnerSlot(harness).promise, context);
}

/** What a rerun of a cut-off turn sends into the resumed session instead of the turn's prompt. */
export const CARRY_ON_PROMPT =
  "The meddle service restarted while you were working on the previous message. Continue where you left off; do not redo work that is already done.";

/** What the rerun of a turn whose token failed it sends into the resumed session instead of the turn's prompt. */
export const TOKEN_RETRY_PROMPT =
  "The previous attempt at this message failed because the login it used hit a usage limit; meddle switched to another login. If you had not started on it, start now; otherwise continue where you left off and do not redo finished work.";

/** How long a token that hit a limit the SDK gave no reset time for is left alone. */
const EXHAUSTED_DEFAULT_MS = 3600_000;

/**
 * One Claude Code turn of a task. `run` drives the turn; a rerun after a crash resumes the task's
 * session and tells Claude to carry on. A turn whose token failed it (a usage limit, a refused login) enters `run` once
 * more, through a sleep until now, with the next token. `finish` does the bookkeeping once the turn is over, so a rerun
 * from there skips the turn.
 */
export const MeddleTurn = defineTask<TurnInput, TurnCheckpoint, null, MeddleHooks>({
  name: "meddle.turn",
  version: 1,
  initial: () => ({ phase: "run", tokenRetries: 0 }),
  phases: {
    // Commits nothing before the turn ends: a commit would be progress to pi-durable and start its restart count
    // over, so a turn that kept crashing the process would never park. Whether this is a rerun comes from the log.
    // A token rerun is a sleep, which is progress too; it happens at most once per turn (`tokenRetries`).
    run: async (task, runtime, context) => {
      const runner = await runnerFor(runtime, context);
      const checkpoint = task.state.checkpoint;
      const tokenRetries = checkpoint.phase === "run" ? checkpoint.tokenRetries ?? 0 : 0;
      const outcome = await runner.runTurnPhase(task.input, tokenRetries, context);
      if (outcome === "rerun") {
        await runtime.sleepUntil(runtime.now(), { phase: "run", tokenRetries: 1 }, context);
        return;
      }
      await runtime.commit(() => ({ status: "running", checkpoint: { phase: "finish" } }), context);
    },
    finish: async (task, runtime, context) => {
      const runner = await runnerFor(runtime, context);
      await runner.finishTurnPhase(task.input.taskId, context);
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
      runner.completeTurn(task.input.taskId);
    },
  },
  abort: async (task, runtime, context) => {
    const runner = await runnerFor(runtime, context);
    runner.abortTurnPhase(task.input.taskId);
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
  },
});

type LiveTurn = { query: Query; queue: InputQueue; state: "running" | "waiting" };

/** How long a turn interrupted by a "move now" has to end before it is closed. */
const INTERRUPT_GRACE_MS = 15_000;

/** The key that serialises a task's receive, import, activation and abandonment. */
function taskKey(taskId: string): string {
  return `task\0${taskId}`;
}

function messageOf(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim();
}

/** Creates tasks and drives their turns as durable `meddle.turn` tasks on one Harness. */
export class TaskRunner {
  readonly approvals = new Approvals();
  #cfg: NodeConfig;
  #db: Database;
  #harness: Harness;
  #deps: RunnerDeps;
  #sessionStore: SqliteSessionStore;
  #live = new Map<string, LiveTurn>();
  /**
   * The primary project of each task whose turn is live, from its start (memory sync included) to the end of its
   * `finish` (memory sync included), so whether a project is live here needs no manifest.
   */
  #primaries = new Map<string, string>();
  #pool: PoolRuntime | undefined;
  #log: (line: string) => void;
  /** Tasks whose new `meddle.turn` is being created or has not started running yet. */
  #pending = new Set<string>();
  #eventListeners = new Set<(taskId: string, seq: number, message: SDKMessage | MeddleEvent) => void>();
  #stateListeners = new Set<(taskId: string, state: TaskState) => void>();
  /**
   * The moves of tasks running here (decision 11). While a task is in it, its turns do not write its state, prompts are
   * queued and the rest is refused; its row says `moving` for a restart and the dashboard.
   */
  #moving = new Map<string, MoveState>();
  #moveListeners = new Set<(taskId: string, move: MoveState | null) => void>();
  /** Woken whenever a turn of the task ends (completed, failed or aborted): a move waits for it. */
  #turnWaiters = new Map<string, Set<() => void>>();

  constructor(cfg: NodeConfig, db: Database, harness: Harness, deps: RunnerDeps) {
    this.#cfg = cfg;
    this.#db = db;
    this.#harness = harness;
    this.#deps = deps;
    this.#pool = deps.pool;
    const sink = deps.log ?? ((line: string) => console.error(line));
    this.#log = dedupe((line) => sink(line));
    this.#sessionStore = new SqliteSessionStore(db);
    const slot = runnerSlot(harness);
    if (slot.bound) throw new Error("this Harness already has a TaskRunner");
    slot.bound = true;
    slot.resolve(this);
    this.approvals.onChange(() => this.#syncWaiting());
    if (this.#pool !== undefined) this.#sweepOrphans();
  }

  /**
   * Gives a runner built before the pool its pool, before any turn runs. Attaching the pool it already has is a no-op;
   * another one is refused.
   */
  attachPool(pool: PoolRuntime): void {
    if (this.#pool === pool) return;
    if (this.#pool !== undefined) throw new Error("this TaskRunner already has a pool");
    this.#pool = pool;
    this.#sweepOrphans();
  }

  /**
   * Provisions a task. With a pool, each project is first replicated here when it is homed elsewhere and unknown
   * (cloned from its home), and the task starts from the home's trunk.
   */
  async create(input: { title: string; projectIds: string[] }): Promise<TaskManifest> {
    if ((await pickToken(this.#cfg, this.#db)) === null) throw new Error("no usable token");
    const deps = this.#replicaDeps();
    if (deps === null) return provisionTask(this.#cfg, this.#db, input);
    const parents: Record<string, string> = {};
    for (const id of input.projectIds) {
      if (id in parents) continue; // provisionTask refuses the duplicate
      parents[id] = await trunkFor(deps, await ensureReplica(deps, id));
    }
    return provisionTask(this.#cfg, this.#db, { ...input, parents });
  }

  /**
   * Steers the live turn, or starts a new durable turn when the task is idle. A task left `running`
   * with no live turn here is reconciled against the Harness: a turn still pending there refuses the
   * prompt, a parked one is retried and refuses it too; with none, the task is idle again and the
   * prompt starts a turn.
   */
  async prompt(taskId: string, text: string): Promise<void> {
    const row = this.#row(taskId);
    if (row.state === "archived") throw new Error(`task is archived: ${taskId}`);
    refuseReceiving(row);
    refuseMoved(row);
    if (this.#isMoving(row)) {
      // Queued prompts travel with the task, and its export reads them once the handoff has begun: one sent after that
      // would be left behind.
      if (this.#moving.get(taskId)?.phase !== "prepare") throw new Error("task is moving; send it again once it has arrived");
      this.#enqueue(taskId, text);
      return;
    }
    let stale = false;
    if (row.state === "running" || row.state === "waiting") {
      const live = this.#live.get(taskId);
      if (live !== undefined) {
        // Sent first: after the turn's `result` its input is closed while the turn is still live, and a steer then
        // is refused rather than logged as sent.
        if (live.queue.ended) throw new Error("the turn just ended; send it as a new prompt");
        this.#send(taskId, live.queue, text, "now");
        return;
      }
      const turn = await this.#durableTurn(taskId);
      if (turn !== undefined && isParked(turn)) {
        await this.#harness.retryTask(turn.record.id, BACKGROUND_CONTEXT);
        throw new Error("the task's interrupted turn is being retried; send your message again once it is idle");
      }
      if (turn !== undefined) throw new Error("task is resuming");
      stale = true;
    }
    // Prompts queued while the task moved run first, one turn each; this one waits its turn behind them.
    if (queuedOf(this.#row(taskId)).length > 0) {
      if (stale) this.#setState(taskId, "idle");
      this.#enqueue(taskId, text);
      await this.startQueued(taskId);
      return;
    }
    // Reserved before the first await, so a concurrent prompt cannot create a second turn.
    if (this.#pending.has(taskId)) throw new Error("task has a pending turn");
    this.#pending.add(taskId);
    try {
      if (stale) this.#setState(taskId, "idle");
      await this.#createTurn({ taskId, prompt: text });
    } catch (err) {
      this.#pending.delete(taskId);
      throw err;
    }
  }

  /** Creates the task's next `meddle.turn`; the caller has reserved it in `#pending`. */
  async #createTurn(input: TurnInput): Promise<void> {
    const root = await this.#harness.root(BACKGROUND_CONTEXT);
    await root.commit((tx) => tx.createTask(MeddleTurn, input, { ownership: { kind: "conversation" } }), BACKGROUND_CONTEXT);
  }

  /**
   * Starts the task's next turn from its queued prompts (decision 13 as amended: one turn per text, in order) when it
   * is idle with a prompt queued and no turn pending or live; otherwise does nothing. The text leaves `queued` only
   * once its turn is created, so a crash never loses it; a crash in the moment between the two runs it twice.
   * `completeTurn` calls this after every turn, so the queue drains turn by turn. A moving task's queue waits for the
   * node it goes to. `freshAfter`: see `TurnInput`.
   */
  async startQueued(taskId: string, options: { freshAfter?: number } = {}): Promise<void> {
    const row = getTask(this.#db, taskId);
    if (row === null || row.state !== "idle" || this.#moving.has(taskId) || this.#pending.has(taskId) || this.#live.has(taskId)) return;
    const [head] = queuedOf(row);
    if (head === undefined) return;
    this.#pending.add(taskId);
    try {
      await this.#createTurn({ taskId, prompt: head, ...(options.freshAfter === undefined ? {} : { freshAfter: options.freshAfter }) });
    } catch (err) {
      this.#pending.delete(taskId);
      throw err;
    }
    // Only appends happened meanwhile (a prompt joins the tail; this is the one taker, kept single by `#pending`).
    this.#db.transaction(() => {
      const rest = queuedOf(this.#row(taskId)).slice(1);
      updateTask(this.#db, taskId, { queued: rest.length === 0 ? null : JSON.stringify(rest) });
    })();
  }

  /** Appends `text` to the task's queued prompts. */
  #enqueue(taskId: string, text: string): void {
    this.#db.transaction(() => {
      updateTask(this.#db, taskId, { queued: JSON.stringify([...queuedOf(this.#row(taskId)), text]) });
    })();
  }

  /** Sends `text` into a live turn's input and records it as a user event. */
  #send(taskId: string, queue: InputQueue, text: string, priority: "now" | "next"): void {
    queue.push(text, priority);
    this.#record(taskId, promptEvent(text));
  }

  /** Appends an event to the task's log and tells the listeners. */
  #record(taskId: string, event: SDKMessage | MeddleEvent): void {
    const seq = appendEvent(this.#db, taskId, event);
    notify(this.#eventListeners, (cb) => cb(taskId, seq, event));
  }

  /**
   * Marks token `id` as its fault says, for the whole pool: `exhausted` until the SDK's reset time (an hour from now when
   * it gave none) with the limit's type, or `disabled` with the error. A token no longer listed is left alone. Returns
   * the fault as marked (its `until` the one stored).
   */
  async #markFault(id: string, fault: TokenFault): Promise<TokenFault> {
    let marked: TokenFault;
    if (fault.kind === "exhausted") {
      marked = { ...fault, until: fault.until ?? new Date(Date.now() + EXHAUSTED_DEFAULT_MS).toISOString() };
      markToken(this.#db, id, "exhausted", marked.until, markDetail(fault.type));
    } else {
      marked = fault;
      markToken(this.#db, id, "disabled", null, markDetail(fault.reason));
    }
    try {
      await this.#pool?.tokenChanged();
    } catch (err) {
      this.#log(`meddle: tokens: could not tell the pool of token ${id}'s mark: ${messageOf(err)}`);
    }
    return marked;
  }

  async interrupt(taskId: string): Promise<void> {
    this.#refuseElsewhere(taskId);
    await this.#liveQueryOrThrow(taskId).interrupt();
  }

  /** Switches the live turn's permission mode, if any, and keeps it for the task's later turns. */
  async setPermissionMode(taskId: string, mode: PermissionMode): Promise<void> {
    this.#refuseElsewhere(taskId);
    await this.liveQuery(taskId)?.setPermissionMode(mode);
    updateTaskSettings(this.#db, taskId, { permissionMode: mode });
  }

  /** Switches the live turn's model, if any, and keeps it for the task's later turns; none is the default. */
  async setModel(taskId: string, model?: string): Promise<void> {
    this.#refuseElsewhere(taskId);
    await this.liveQuery(taskId)?.setModel(model);
    updateTaskSettings(this.#db, taskId, { model });
  }

  /** Effort for the task's later turns; a live turn keeps its own. */
  async setEffort(taskId: string, effort: string): Promise<void> {
    this.#refuseElsewhere(taskId);
    updateTaskSettings(this.#db, taskId, { effort });
  }

  /** The model, effort and permission mode the task's next turn starts with, where the user chose one. */
  settings(taskId: string): TaskSettings {
    this.#row(taskId);
    return getTaskSettings(this.#db, taskId);
  }

  /** Runs the task's turn again after pi-durable's restart limit parked it. */
  async retry(taskId: string): Promise<void> {
    this.#refuseElsewhere(taskId);
    const turn = await this.#durableTurn(taskId);
    if (turn === undefined || !isParked(turn)) throw new Error(`no parked turn for task ${taskId}`);
    await this.#harness.retryTask(turn.record.id, BACKGROUND_CONTEXT);
  }

  onEvent(cb: (taskId: string, seq: number, message: SDKMessage | MeddleEvent) => void): () => void {
    this.#eventListeners.add(cb);
    return () => { this.#eventListeners.delete(cb); };
  }

  onState(cb: (taskId: string, state: TaskState) => void): () => void {
    this.#stateListeners.add(cb);
    return () => { this.#stateListeners.delete(cb); };
  }

  state(taskId: string): TaskState {
    return this.#row(taskId).state as TaskState;
  }

  liveQuery(taskId: string): Query | null {
    return this.#live.get(taskId)?.query ?? null;
  }

  /**
   * The `run` phase of `meddle.turn`: drives the turn to its end with the first usable token. A rerun that resumes the
   * session sends `CARRY_ON_PROMPT` (the turn was cut off) or `TOKEN_RETRY_PROMPT` (its token failed it) instead of the
   * prompt. When the turn's token hit a limit or was refused, the token is marked for the pool; `"rerun"` when this was
   * the turn's first try (`tokenRetries` 0) and another token is usable now, so the phase enters itself again.
   * Not for callers outside this module.
   */
  async runTurnPhase(input: TurnInput, tokenRetries: number, context: Context): Promise<"done" | "rerun"> {
    const { taskId } = input;
    let failureLogged = false; // the turn's own turn_failed is in the log
    try {
      const cutOff = lastTurnCutOff(this.#db, taskId, input.freshAfter ?? 0);
      const row = this.#row(taskId);
      const started = row.started === 1;
      const moving = this.#isMoving(row);
      this.#db.transaction(() => updateTask(this.#db, taskId, moving ? { started: 1 } : { started: 1, state: "running" }))();
      this.#pending.delete(taskId);
      if (!moving) this.#emitState(taskId, "running");
      const manifest = await readManifest(this.#cfg, taskId);
      const primary = manifest.primaryProjectId;
      const deps = this.#replicaDeps();
      if (deps !== null) {
        const live = this.#projectLiveElsewhere(taskId, primary);
        this.#primaries.set(taskId, primary);
        await syncMemoryBefore(deps, primary, live, this.#log);
      }
      // Resume only a session whose transcript Claude Code wrote, not one a turn merely set out to create.
      const resume = started && existsSync(transcriptPath(this.#cfg, manifest));
      const picked = await pickToken(this.#cfg, this.#db);
      if (picked === null) {
        this.#record(taskId, tokenFaultEvent(null, { kind: "none" }, false));
        throw new Error("no usable token");
      }
      const queue = new InputQueue();
      let fault = null as TokenFault | null; // set by onTokenFault, as `done` settles
      const { query, done } = runTurn({
        input: await this.#engineInput(taskId, manifest, resume, picked.value),
        // Without a session to resume, a rerun has nothing to carry on from and sends the prompt again.
        prompt: resume && cutOff === "token" ? TOKEN_RETRY_PROMPT : resume && cutOff === "restart" ? CARRY_ON_PROMPT : input.prompt,
        db: this.#db,
        approvals: this.approvals,
        queue,
        ...(context.abortSignal !== undefined ? { signal: context.abortSignal } : {}),
        onMessage: (m, seq) => {
          if (m.type === "meddle" && m.subtype === "turn_failed") failureLogged = true;
          notify(this.#eventListeners, (cb) => cb(taskId, seq, m));
        },
        onTokenFault: (f) => { fault = f; },
      });
      this.#live.set(taskId, { query, queue, state: "running" });
      try {
        await done;
      } catch (err) {
        // A turn that ended without a result after its token failed it fails as before; the token is marked all the same.
        if (fault !== null) await this.#markFault(picked.id, fault).catch(() => {});
        throw err;
      } finally {
        // The task stays in `#primaries` until `finish` has synced its memory.
        this.#live.delete(taskId);
      }
      if (fault === null) return "done";
      const marked = await this.#markFault(picked.id, fault);
      const next = await pickToken(this.#cfg, this.#db);
      const rerun = tokenRetries === 0 && next !== null && next.id !== picked.id;
      this.#record(taskId, tokenFaultEvent(picked, marked, rerun));
      if (!rerun) return "done";
      await this.#deps.hooks?.afterTokenFault?.(taskId);
      return "rerun";
    } catch (err) {
      this.#primaries.delete(taskId);
      // A turn that failed before it ran (no token, a bad context.toml, …) says why in the log like any other.
      if (!context.abortSignal?.aborted && !failureLogged) this.#logFailure(taskId, err);
      this.#failTurn(taskId, context);
      throw err;
    }
  }

  /**
   * The `finish` phase of `meddle.turn`: moves the task's bookmarks; with a pool, pushes each to its project's home
   * when that is another node and syncs the primary project's memory, unless another task of that project is live
   * here (decision 15: the last of them to end commits for all). A failed push or sync is logged, never thrown: the
   * turn completed, and the next turn end tries again. Not for callers outside this module.
   */
  async finishTurnPhase(taskId: string, context: Context): Promise<void> {
    try {
      let manifest: TaskManifest;
      let moved: TaskBookmark[];
      try {
        manifest = await readManifest(this.#cfg, taskId);
        moved = await this.setTaskBookmarks(manifest);
      } catch (err) {
        this.#failTurn(taskId, context);
        throw err;
      }
      const deps = this.#replicaDeps();
      if (deps === null) return;
      for (const m of moved) await this.#pushToHome(deps, m);
      const primary = manifest.primaryProjectId;
      const live = this.#projectLiveElsewhere(taskId, primary);
      // Decided and dropped in one go: of two tasks ending together, the second then sees the first gone and syncs.
      // A task that syncs stays live for others until its sync is done, so a turn starting meanwhile defers its own.
      if (live) this.#primaries.delete(taskId);
      await syncMemoryAfter(deps, primary, live, this.#log);
    } finally {
      this.#primaries.delete(taskId);
    }
  }

  /** Whether a task other than `taskId` whose primary project is `projectId` has a turn live (or syncing) here. */
  #projectLiveElsewhere(taskId: string, projectId: string): boolean {
    return [...this.#primaries].some(([id, p]) => id !== taskId && p === projectId);
  }

  /** Points each of the task's bookmarks at its workspace's working-copy change; what it set. */
  async setTaskBookmarks(manifest: TaskManifest): Promise<TaskBookmark[]> {
    const set: TaskBookmark[] = [];
    for (const p of manifest.projects) {
      const workspace = join(paths(this.#cfg).task(manifest.id), p.workspace);
      const bookmark = `meddle/task/${manifest.id}/${p.name}`;
      const change = await changeId(workspace, this.#cfg);
      // Not under another task's push to the same replica (pushBookmark takes the same key).
      await serialised(repoKey(p.replica), () => bookmarkSet(p.replica, bookmark, change, this.#cfg));
      set.push({ projectId: p.id, replica: p.replica, bookmark, change });
    }
    return set;
  }

  /** Pushes a task bookmark to its project's home when that is another node; a failure is logged. */
  async #pushToHome(deps: ReplicaDeps, m: TaskBookmark): Promise<void> {
    const home = getProject(this.#db, m.projectId)?.home;
    if (home === undefined || home === "" || home === deps.pool.identity.id) return;
    try {
      if (!deps.pool.net.isOnline(home)) throw new Error(`home ${shortId(home)} is offline`);
      await pushBookmark(this.#cfg, m.replica, home, m.bookmark, m.change);
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim();
      this.#log(`meddle: git: push of ${m.bookmark} to ${shortId(home)} failed: ${message}`);
    }
  }

  // ─── receiving a moved task ───

  /**
   * Prepares to receive task `manifest.id` from node `from`: refused unless both report the same, known Claude Code
   * version, this node hosts tasks and has a pool, and no other copy of the task is here (a partial one still being
   * received from `from` is abandoned first: the sender's handoff ran again). Replicates each project (from its home),
   * fetches the task's bookmarks from `from`, and provisions the task at the fetched changes as `receiving`.
   */
  async receiveTask(manifest: TaskManifest, from: string, version: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const ours = claudeCodeVersion();
    if (version !== ours || ours === "unknown" || version === "unknown") return { ok: false, reason: `claude code ${ours} here, ${version} there` };
    if (!(await checkTaskRoot(this.#cfg)).ok) return { ok: false, reason: "this node does not host tasks" };
    const deps = this.#replicaDeps();
    if (deps === null) return { ok: false, reason: "this node has no pool" };
    try {
      checkReceivedManifest(manifest);
    } catch (err) {
      return { ok: false, reason: messageOf(err) };
    }
    const taskId = manifest.id;
    return serialised<{ ok: true } | { ok: false; reason: string }>(taskKey(taskId), async () => {
      await this.#deps.hooks?.beforeReceive?.(taskId);
      const existing = getTask(this.#db, taskId);
      if (existing !== null) {
        // A `moved` row is what is left of the task's earlier stay here: it is coming back.
        const replaces = existing.state === "moved" || (existing.state === "receiving" && existing.receiving_from === from);
        if (!replaces) return { ok: false, reason: `task ${taskId} already exists here` };
        await this.#discard(existing);
      } else {
        await this.#clearLeftovers(manifest);
      }
      try {
        const parents: Record<string, string> = {};
        for (const p of manifest.projects) {
          parents[p.id] = await this.#fetchTaskChange(await ensureReplica(deps, p.id), from, `meddle/task/${taskId}/${p.name}`);
        }
        await provisionFromManifest(this.#cfg, this.#db, manifest, parents, "receiving");
        updateTask(this.#db, taskId, { receiving_from: from });
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: messageOf(err) };
      }
    });
  }

  /** Fetches `bookmark` from node `from` into the project's replica (never tracking it); the change it points at. */
  async #fetchTaskChange(project: Project, from: string, bookmark: string): Promise<string> {
    const remote = shortId(from);
    return serialised(repoKey(project.replica), async () => {
      await ensureRemote(this.#cfg, project.replica, from, { kind: "project", id: project.id });
      await fetchBookmarks(this.#cfg, project.replica, from, [bookmark]);
      const found = (await bookmarkList(project.replica, this.#cfg)).find((b) => b.name === bookmark && b.remote === remote);
      if (found === undefined || found.conflicted || found.changeId === "") throw new Error(`bookmark ${bookmark}@${remote} is conflicted`);
      return found.changeId;
    });
  }

  /**
   * Imports the task `from` sends over a `blob` stream into its `receiving` row (what an earlier attempt imported is
   * replaced), keeping its settings, queued prompts and turn count. Refused `forbidden` unless the task is being
   * received from `from`.
   */
  async importIncoming(taskId: string, from: string, reader: StreamReader): Promise<Receipt> {
    return serialised(taskKey(taskId), async () => {
      const row = this.#receivingFrom(taskId, from);
      clearTaskLog(this.#db, taskId, row.session_id);
      const got = await importTask(this.#cfg, this.#db, reader, { taskId });
      updateTask(this.#db, taskId, {
        settings: got.settings === null ? null : JSON.stringify(got.settings),
        queued: got.queued.length === 0 ? null : JSON.stringify(got.queued),
        turns: got.turns,
      });
      return got.receipt;
    });
  }

  /**
   * Makes a task received from `from` live here (`idle`); a follow-up joins the front of its queued prompts, which
   * then run one turn each, in order (`startQueued`). A task already activated is a no-op: the sender's commit ran
   * again, also when this node has moved the task on since. Refused `forbidden` when this node has no copy of the
   * task or is receiving it from another node. Every answer is definite, so the sender can tell it from a lost one:
   * `ok: true` when this node activated the task, `ok: false` when activating it failed and it did not (its received
   * copy stays, for the sender to abandon).
   */
  async activateTask(taskId: string, from: string, followUp: string | null): Promise<{ ok: boolean }> {
    return serialised(taskKey(taskId), async () => {
      // Received and no longer being received: this node activated it (a `receiveTask` replaces any earlier row with a
      // `receiving` one), even if it has moved the task on since.
      const activated = () => {
        const current = getTask(this.#db, taskId);
        return current !== null && current.receiving_from === null && current.state !== "receiving";
      };
      try {
        await this.#deps.hooks?.beforeActivate?.(taskId);
        if (activated()) return { ok: true };
        const row = this.#receivingFrom(taskId, from);
        const queued = [...(followUp === null ? [] : [followUp]), ...queuedOf(row)];
        updateTask(this.#db, taskId, { state: "idle", receiving_from: null, queued: queued.length === 0 ? null : JSON.stringify(queued) });
      } catch (err) {
        if (isChordError(err, "forbidden")) throw err;
        if (activated()) return { ok: true };
        this.#log(`meddle: move: could not activate ${taskId} from ${shortId(from)}: ${messageOf(err)}`);
        return { ok: false };
      }
      this.#emitState(taskId, "idle");
      try {
        // However the sender's last turn ended, this one starts the task's stay here: it is never a rerun of that.
        await this.startQueued(taskId, { freshAfter: listEventsTail(this.#db, taskId, { limit: 1 })[0]?.seq ?? 0 });
      } catch (err) {
        // The task is here now; its prompts stay queued, and the next prompt starts them.
        this.#log(`meddle: move: task ${taskId} is here, but its queued prompts did not start a turn: ${messageOf(err)}`);
      }
      await this.#deps.hooks?.afterActivate?.(taskId);
      return { ok: true };
    });
  }

  /**
   * Removes a task still being received from `from`: its rows, folder and config dir, workspaces and (except on a
   * project's home, where they are the backup) its task bookmarks. An unknown task is a no-op; any other is refused
   * `forbidden`.
   */
  async abandonTask(taskId: string, from: string): Promise<void> {
    await serialised(taskKey(taskId), async () => {
      if (getTask(this.#db, taskId) === null) return;
      await this.#discard(this.#receivingFrom(taskId, from));
    });
  }

  /** Abandons every task still `receiving`: a move that did not finish before this node stopped. */
  async abandonOrphans(): Promise<void> {
    for (const orphan of listTasks(this.#db).filter((t) => t.state === "receiving")) {
      await serialised(taskKey(orphan.id), async () => {
        const row = getTask(this.#db, orphan.id);
        if (row?.state !== "receiving") return;
        try {
          await this.#discard(row);
        } catch (err) {
          this.#log(`meddle: move: could not abandon the partly received task ${orphan.id}: ${messageOf(err)}`);
        }
      });
    }
  }

  #sweepOrphans(): void {
    this.abandonOrphans().catch((err: unknown) => this.#log(`meddle: move: could not abandon partly received tasks: ${messageOf(err)}`));
    this.reconcileMoves().catch((err: unknown) => this.#log(`meddle: move: could not reconcile moving tasks: ${messageOf(err)}`));
  }

  /**
   * Makes each task whose row says `moving` live here again when no move of it can go on: there is no `meddle.move` of
   * it left in the Harness (one that faulted, or a rollback that could not finish), or its move was parked by the
   * restart limit before the receipt (`prepare`, `handoff`), which is then aborted as well. The task gets the state the
   * Harness gives it (a turn rerunning keeps it `running`, never `idle`) and its queued prompts start. A move parked in
   * `commit` is left alone: the target may have the task.
   */
  async reconcileMoves(): Promise<void> {
    const rows = listTasks(this.#db).filter((t) => t.state === "moving");
    if (rows.length === 0) return;
    const { tasks } = await this.#harness.inspect(BACKGROUND_CONTEXT);
    const moves = new Map<string, TaskInspection>();
    for (const t of tasks) if (t.record.kind === MeddleMove.definition.name) moves.set((t.record.input as MoveInput).taskId, t);
    for (const row of rows) {
      await serialised(taskKey(row.id), async () => {
        if (this.#moving.has(row.id) || getTask(this.#db, row.id)?.state !== "moving") return;
        const move = moves.get(row.id);
        if (move === undefined) {
          await this.#release(row.id, `meddle: move: ${row.id} was left moving with no move in progress; it is live here again`);
          return;
        }
        const phase = (move.record.state as { checkpoint?: { phase?: string } }).checkpoint?.phase;
        if (!isParked(move) || (phase !== "prepare" && phase !== "handoff")) return;
        const { to } = move.record.input as MoveInput;
        await this.#release(row.id, `meddle: move: ${row.id} to ${shortId(to)} at ${phase} parked; released`);
        // Its abort finds the task live here again and only drops what the target may hold of it.
        await this.#harness.abortTask(move.record.id, BACKGROUND_CONTEXT);
      });
    }
  }

  /** Makes a task left `moving` live here again: its state as the Harness has it, `line` logged, its queue started. */
  async #release(taskId: string, line: string): Promise<void> {
    try {
      await this.#restoreState(taskId);
    } catch (err) {
      // Never left `moving` with no move behind it.
      this.#log(`meddle: move: could not tell whether ${taskId} has a turn running: ${messageOf(err)}`);
      this.#setState(taskId, this.#knownState(taskId));
    }
    this.#log(line);
    await this.startQueued(taskId).catch((err: unknown) => {
      this.#log(`meddle: move: task ${taskId}'s next queued prompt did not start a turn: ${messageOf(err)}`);
    });
  }

  /** The task's row when it is being received from `from`; otherwise refused `forbidden`. */
  #receivingFrom(taskId: string, from: string): TaskRow {
    const row = getTask(this.#db, taskId);
    if (row === null || row.state !== "receiving" || row.receiving_from !== from) throw forbidden(`not receiving ${taskId} from ${shortId(from)}`);
    return row;
  }

  /**
   * What a receive that died while provisioning (the process stopped; no row was written) left of a task this node
   * has no row for: its folder and its workspaces.
   */
  async #clearLeftovers(manifest: TaskManifest): Promise<void> {
    const task = paths(this.#cfg).task(manifest.id);
    if (!existsSync(task)) return;
    for (const p of manifest.projects) {
      const replica = getProject(this.#db, p.id)?.replica;
      if (replica !== undefined) await workspaceForget(replica, `meddle-${manifest.id}`, this.#cfg).catch(() => {});
    }
    await rm(task, { recursive: true, force: true });
  }

  /** Removes a received task's workspaces, task bookmarks (not on the home), folder and rows. */
  async #discard(row: TaskRow): Promise<void> {
    const manifest = JSON.parse(row.manifest) as TaskManifest;
    const self = this.#pool?.identity.id;
    for (const p of manifest.projects) {
      await workspaceForget(p.replica, `meddle-${row.id}`, this.#cfg).catch(() => {});
      if (self !== undefined && getProject(this.#db, p.id)?.home === self) continue;
      const bookmark = `meddle/task/${row.id}/${p.name}`;
      await serialised(repoKey(p.replica), () => bookmarkForget(p.replica, bookmark, this.#cfg)).catch(() => {});
    }
    await rm(paths(this.#cfg).task(row.id), { recursive: true, force: true });
    deleteTask(this.#db, row.id, row.session_id);
  }

  // ─── moving a task to another node ───

  /**
   * Starts moving task `taskId` to node `to` (a durable `meddle.move`); with `now`, a live turn is interrupted rather
   * than waited for. Refused, before anything starts, as `checkMove` says, or when the task's turn is parked. Resolves
   * once the move has started; `onMove` and `onState` tell how it goes.
   */
  async moveTo(taskId: string, to: string, now: boolean): Promise<void> {
    const row = this.#row(taskId);
    this.checkMove(row, to);
    // Reserved before the first await: one move per task.
    const reservation: MoveState = { to, phase: "prepare", error: null };
    this.#moving.set(taskId, reservation);
    try {
      const turn = await this.#durableTurn(taskId);
      if (turn !== undefined && isParked(turn)) throw new Error("the task's turn is parked; retry it first");
      const input: MoveInput = { taskId, to, now };
      const root = await this.#harness.root(BACKGROUND_CONTEXT);
      await root.commit((tx) => tx.createTask(MeddleMove, input, { ownership: { kind: "conversation" } }), BACKGROUND_CONTEXT);
    } catch (err) {
      if (this.#moving.get(taskId) === reservation) {
        this.#moving.delete(taskId);
        // A turn that ended meanwhile left its state to the move.
        await this.#restoreState(taskId);
      }
      throw err;
    }
  }

  /**
   * Throws why task `row` cannot move to `to` (decision 16): it is not live here (received, moved, archived) or is
   * already moving (unless `own`: the move's own steps check again), there is no pool, `to` is this node, not a
   * member, offline or hosts no tasks, or the two report different or unknown Claude Code versions.
   */
  checkMove(row: TaskRow, to: string, own = false): void {
    refuseReceiving(row);
    refuseMoved(row);
    if (row.state === "archived") throw new Error(`task is archived: ${row.id}`);
    if (!own && this.#isMoving(row)) throw new Error("task is moving");
    const pool = this.#pool;
    if (pool === undefined) throw new Error("this node has no pool");
    const short = shortId(to);
    if (to === pool.identity.id) throw new Error("the task is already on this node");
    if (!pool.store.isMember(to)) throw new Error(`${short} is not a member of this pool`);
    if (!pool.net.isOnline(to)) throw new Error(`${short} is offline`);
    const summary = pool.store.row(to)?.summary ?? null;
    if (summary === null || !summary.hostsTasks) throw new Error(`${short} does not host tasks`);
    const ours = claudeCodeVersion();
    const theirs = summary.claudeCodeVersion;
    if (ours !== theirs || ours === "unknown" || theirs === "unknown") throw new Error(`claude code ${ours} here, ${theirs} there`);
  }

  onMove(cb: (taskId: string, move: MoveState | null) => void): () => void {
    this.#moveListeners.add(cb);
    return () => { this.#moveListeners.delete(cb); };
  }

  /** The task's move in progress here, or null. */
  moveState(taskId: string): MoveState | null {
    return this.#moving.get(taskId) ?? null;
  }

  /** What a move's steps work with. Not for callers outside this module and `move.ts`. */
  moveDeps(): { cfg: NodeConfig; db: Database; pool: PoolRuntime; log(line: string): void; callMs: number | undefined } {
    if (this.#pool === undefined) throw new Error("this node has no pool");
    return { cfg: this.#cfg, db: this.#db, pool: this.#pool, log: this.#log, callMs: this.#deps.hooks?.callMs };
  }

  /**
   * Throws `task is no longer moving` unless the task's row says `moving`: a step of a move that was already rolled back
   * here (its own end never recorded) must not hand the task over or activate it.
   */
  requireMoving(taskId: string): void {
    if (this.#row(taskId).state !== "moving") throw new Error("task is no longer moving");
  }

  /** Whether the task is moving here: a step of its move holds it, or its row says so. */
  isMovingHere(taskId: string): boolean {
    return this.#isMoving(this.#row(taskId));
  }

  /** The move of the task to `to` is at `phase`: held here, the row says `moving`, and both are told. */
  enterMove(taskId: string, to: string, phase: string): void {
    this.#moving.set(taskId, { to, phase, error: null });
    if (this.#row(taskId).state !== "moving") this.#setState(taskId, "moving");
    this.#emitMove(taskId);
  }

  /**
   * Resolves once the task has no turn here: none pending, live, finishing or reran by the Harness. With `interrupt`,
   * a live turn that has not yet had its `result` is interrupted (after `onCut`), and closed when it has not ended
   * `INTERRUPT_GRACE_MS` later. Throws when the turn is parked or `context` aborts.
   */
  async awaitTurnEnd(taskId: string, interrupt: boolean, context: Context, onCut: () => Promise<void>): Promise<void> {
    let cutting: Query | null = null;
    let cutAt = 0;
    for (;;) {
      context.abortSignal?.throwIfAborted();
      const live = this.#live.get(taskId);
      const busy = live !== undefined || this.#pending.has(taskId);
      const turn = busy ? undefined : await this.#durableTurn(taskId);
      if (!busy && turn === undefined) return;
      if (turn !== undefined && isParked(turn)) throw new Error("the task's turn is parked");
      if (interrupt && live !== undefined && (cutting === live.query || !live.queue.ended)) {
        if (cutting !== live.query) {
          cutting = live.query;
          cutAt = Date.now();
          await onCut();
          await live.query.interrupt().catch(() => {});
        } else if (Date.now() - cutAt > INTERRUPT_GRACE_MS) {
          live.query.close();
        }
      }
      await this.#nextTurnEnd(taskId, 250, context);
    }
  }

  /** Resolves when a turn of the task ends, after `ms`, or when `context` aborts. */
  #nextTurnEnd(taskId: string, ms: number, context: Context): Promise<void> {
    return new Promise<void>((resolve) => {
      const waiters = this.#turnWaiters.get(taskId) ?? new Set<() => void>();
      this.#turnWaiters.set(taskId, waiters);
      const done = () => {
        clearTimeout(timer);
        waiters.delete(done);
        if (waiters.size === 0 && this.#turnWaiters.get(taskId) === waiters) this.#turnWaiters.delete(taskId);
        context.abortSignal?.removeEventListener("abort", done);
        resolve();
      };
      waiters.add(done);
      const timer = setTimeout(done, ms);
      context.abortSignal?.addEventListener("abort", done, { once: true });
    });
  }

  /**
   * The task now lives on `to`: its row says `moved` and where (its queue went with it), it is no longer moving, and
   * that is told.
   */
  completeMove(taskId: string, to: string): void {
    updateTask(this.#db, taskId, { state: "moved", moved_to: to, queued: null });
    this.#moving.delete(taskId);
    this.#emitState(taskId, "moved");
    this.#emitMove(taskId);
  }

  /**
   * Ends a move that did not happen: the task is live here again (idle, or its turn's state), the prompts queued
   * meanwhile run, and the failure is logged once and told (`onMove` with the error, then null).
   */
  async failMove(taskId: string, to: string, phase: string, error: string): Promise<void> {
    // First, before anything that can throw: the row must never be left `moving` with no move behind it (nor be written
    // `idle` over a turn this runner knows is live).
    const row = getTask(this.#db, taskId);
    const restore = row !== null && row.state !== "moved";
    if (restore) updateTask(this.#db, taskId, { state: this.#knownState(taskId) });
    this.#moving.set(taskId, { to, phase, error });
    this.#emitMove(taskId);
    this.#moving.delete(taskId);
    if (restore) {
      try {
        await this.#deps.hooks?.beforeRestore?.(taskId);
        await this.#restoreState(taskId);
      } catch (err) {
        this.#log(`meddle: move: could not tell whether ${taskId} has a turn running: ${messageOf(err)}`);
        this.#emitState(taskId, this.#row(taskId).state as TaskState);
      }
    }
    this.#emitMove(taskId);
    this.#log(`meddle: move: ${taskId} failed at ${phase}: ${error}`);
    this.startQueued(taskId).catch((err: unknown) => {
      this.#log(`meddle: move: task ${taskId}'s next queued prompt did not start a turn: ${messageOf(err)}`);
    });
  }

  /** The state of the task's turn as this runner alone knows it (live or pending), without asking the Harness. */
  #knownState(taskId: string): "idle" | "running" | "waiting" {
    return this.#live.get(taskId)?.state ?? (this.#pending.has(taskId) ? "running" : "idle");
  }

  /** Writes the state the task's turn has, if any (`running` for one between its phases), else `idle`. */
  async #restoreState(taskId: string): Promise<void> {
    const live = this.#live.get(taskId);
    const busy = live !== undefined || this.#pending.has(taskId) || (await this.#durableTurn(taskId)) !== undefined;
    this.#setState(taskId, live?.state ?? (busy ? "running" : "idle"));
  }

  #isMoving(row: TaskRow): boolean {
    return this.#moving.has(row.id) || row.state === "moving";
  }

  /** Refuses what only a task live here takes (interrupt, retry, settings): received, moved and moving tasks. */
  #refuseElsewhere(taskId: string): void {
    const row = this.#row(taskId);
    refuseReceiving(row);
    refuseMoved(row);
    if (this.#isMoving(row)) throw new Error("task is moving");
  }

  #emitMove(taskId: string): void {
    const move = this.#moving.get(taskId) ?? null;
    notify(this.#moveListeners, (cb) => cb(taskId, move === null ? null : { ...move }));
  }

  /** What the replica and memory functions need, or null without a pool. */
  #replicaDeps(): ReplicaDeps | null {
    return this.#pool === undefined ? null : { cfg: this.#cfg, db: this.#db, pool: this.#pool };
  }

  /** After the turn's terminal commit: count it and make the task idle. Not for callers outside this module. */
  completeTurn(taskId: string): void {
    updateTask(this.#db, taskId, { turns: this.#row(taskId).turns + 1 });
    this.#turnState(taskId, "idle");
    this.startQueued(taskId).catch((err: unknown) => {
      this.#log(`meddle: move: task ${taskId}'s next queued prompt did not start a turn: ${messageOf(err)}`);
    });
  }

  /** The `abort` phase of `meddle.turn`; not for callers outside this module. */
  abortTurnPhase(taskId: string): void {
    this.#primaries.delete(taskId);
    this.#live.get(taskId)?.query.close();
    this.#turnState(taskId, "idle");
  }

  /**
   * A turn path's state change: written and told, except while the task moves (the row says `moving`, and the move is
   * told the turn ended instead). An `idle` is the end of the turn.
   */
  #turnState(taskId: string, state: "idle" | "running" | "waiting"): void {
    if (!this.#isMoving(this.#row(taskId))) this.#setState(taskId, state);
    if (state === "idle") this.#turnOver(taskId);
  }

  /** Wakes whatever waits for the end of the task's turn. */
  #turnOver(taskId: string): void {
    const waiters = this.#turnWaiters.get(taskId);
    if (waiters === undefined) return;
    this.#turnWaiters.delete(taskId);
    for (const wake of waiters) wake();
  }

  /** Appends a `turn_failed` for `err` and tells the listeners; a failure to do so never hides `err`. */
  #logFailure(taskId: string, err: unknown): void {
    const failed: MeddleEvent = { type: "meddle", subtype: "turn_failed", at: new Date().toISOString(), error: String(err) };
    try {
      const seq = appendEvent(this.#db, taskId, failed);
      notify(this.#eventListeners, (cb) => cb(taskId, seq, failed));
    } catch (logErr) {
      console.error(`meddle: could not log the failure of task ${taskId}'s turn:`, logErr);
    }
  }

  /** A turn that failed of itself ends the task's turn; an aborted one (close, abortTask) stays running for its rerun or abort handler. */
  #failTurn(taskId: string, context: Context): void {
    this.#pending.delete(taskId);
    if (!context.abortSignal?.aborted) this.#turnState(taskId, "idle");
  }

  /** The task's live `meddle.turn` as the Harness sees it, if any. */
  async #durableTurn(taskId: string): Promise<TaskInspection | undefined> {
    const { tasks } = await this.#harness.inspect(BACKGROUND_CONTEXT);
    return tasks.find((t) => t.record.kind === MeddleTurn.definition.name && (t.record.input as TurnInput).taskId === taskId);
  }

  async #engineInput(
    taskId: string,
    manifest: TaskManifest,
    resume: boolean,
    token: string,
  ): Promise<Omit<EngineInput, "prompt" | "canUseTool" | "onPermissionDenied">> {
    const contexts = [];
    for (const p of manifest.projects) contexts.push(await loadContext(p.replica));
    const projectSettings = [];
    if (manifest.projects.length > 1) {
      for (const p of manifest.projects) projectSettings.push(await loadProjectSettings(p.replica));
    }
    const input: Omit<EngineInput, "prompt" | "canUseTool" | "onPermissionDenied"> = {
      cfg: this.#cfg,
      manifest,
      contexts,
      projectSettings,
      token,
      sessionStore: this.#sessionStore,
      resume,
    };
    const { model, effort, permissionMode } = getTaskSettings(this.#db, taskId);
    if (model !== undefined) input.model = model;
    if (effort !== undefined) input.effort = effort;
    if (permissionMode !== undefined) input.permissionMode = permissionMode;
    if (this.#deps.claudePath !== undefined) input.claudePath = this.#deps.claudePath;
    if (this.#deps.claudeRuntime !== undefined) input.claudeRuntime = this.#deps.claudeRuntime;
    if (this.#deps.extraEnv !== undefined) input.extraEnv = this.#deps.extraEnv;
    return input;
  }

  /** `waiting` while a live turn has an approval pending, `running` otherwise. Never throws into Approvals. */
  #syncWaiting(): void {
    for (const [taskId, live] of this.#live) {
      const state = this.approvals.pending(taskId).length > 0 ? "waiting" : "running";
      if (state === live.state) continue;
      live.state = state;
      try {
        this.#turnState(taskId, state);
      } catch (err) {
        console.error(`meddle: could not record task ${taskId} as ${state}:`, err);
      }
    }
  }

  #liveQueryOrThrow(taskId: string): Query {
    const query = this.liveQuery(taskId);
    if (query === null) throw new Error("task is not running");
    return query;
  }

  #row(taskId: string): TaskRow {
    const row = getTask(this.#db, taskId);
    if (row === null) throw new Error(`unknown task: ${taskId}`);
    return row;
  }

  #setState(taskId: string, state: TaskState): void {
    updateTask(this.#db, taskId, { state });
    this.#emitState(taskId, state);
  }

  #emitState(taskId: string, state: TaskState): void {
    notify(this.#stateListeners, (cb) => cb(taskId, state));
  }
}

/** Refuses a task that is still being received. */
function refuseReceiving(row: TaskRow): void {
  if (row.state === "receiving") throw new Error("task is being received");
}

/** Refuses a task that has moved to another node. */
function refuseMoved(row: TaskRow): void {
  if (row.state === "moved") throw new Error(`task has moved to ${shortId(row.moved_to ?? "")}`);
}

/** One task bookmark `setTaskBookmarks` set. */
type TaskBookmark = { projectId: string; replica: string; bookmark: string; change: string };

/** Calls each listener; one that throws is logged and never reaches the turn that told it. */
function notify<T>(listeners: Set<T>, call: (cb: T) => void): void {
  for (const cb of [...listeners]) {
    try {
      call(cb);
    } catch (err) {
      console.error("meddle: a task listener threw:", err);
    }
  }
}

/**
 * Why this run of the task's turn is a rerun, if it is: of the events that start or end a turn (after `afterSeq`), the
 * newest is a `token_fault` with `rerun` set (`"token"`: the turn's token failed it, the next one takes over), or a
 * `turn_started` (the process died mid-turn) or `turn_aborted` (a close interrupted it) (`"restart"`). A `result`, a
 * `turn_failed`, a `token_fault` without `rerun`, or none means a first attempt (null). A process that dies between a
 * turn's `result` and the commit of its `finish` checkpoint (milliseconds), or between its `result` and its
 * `token_fault`, has its rerun send the prompt again: the one replay this accepts.
 */
function lastTurnCutOff(db: Database, taskId: string, afterSeq: number): "token" | "restart" | null {
  const latest = [
    latestEventOfType(db, taskId, "meddle", "turn_started"),
    latestEventOfType(db, taskId, "meddle", "turn_aborted"),
    latestEventOfType(db, taskId, "meddle", "turn_failed"),
    latestEventOfType(db, taskId, "meddle", "token_fault"),
    latestEventOfType(db, taskId, "result"),
  ].reduce<EventRecord | null>((a, b) => (b !== null && b.seq > afterSeq && (a === null || b.seq > a.seq) ? b : a), null);
  if (latest === null) return null;
  const m = latest.message as { type?: unknown; subtype?: unknown; rerun?: unknown };
  if (m.type !== "meddle") return null;
  if (m.subtype === "token_fault") return m.rerun === true ? "token" : null;
  return m.subtype === "turn_started" || m.subtype === "turn_aborted" ? "restart" : null;
}

/** The `token_fault` event for the token a turn ran with (null: none was usable). */
function tokenFaultEvent(
  token: { id: string; label: string } | null, fault: TokenFault | { kind: "none" }, rerun: boolean,
): MeddleEvent {
  return {
    type: "meddle", subtype: "token_fault", at: new Date().toISOString(),
    tokenId: token?.id ?? null, label: token?.label ?? null, fault, rerun,
  };
}

/** A token mark's detail from what the SDK said: kept when a peer would accept it (short, no control characters). */
function markDetail(s: string | null): string | null {
  return s !== null && s.length <= 256 && !/[\x00-\x1f\x7f-\x9f]/.test(s) ? s : null;
}

function isParked(turn: TaskInspection): boolean {
  return turn.state.kind === "blocked" && turn.state.reason === "restart_limit";
}
