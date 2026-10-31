import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { PermissionMode, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { awaitWithContext, BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { defineTask, type Harness, type TaskInspection, type TaskRuntime } from "@earendil-works/pi-durable";
import type { NodeConfig } from "../config";
import { Approvals } from "../engine/approvals";
import { InputQueue } from "../engine/input";
import type { EngineInput } from "../engine/options";
import { promptEvent, runTurn, type MeddleEvent } from "../engine/session";
import { bookmarkSet, changeId } from "../jj";
import { paths } from "../paths";
import { shortId } from "../pool/ids";
import { dedupe } from "../pool/report";
import type { PoolRuntime } from "../pool/runtime";
import { loadContext, loadProjectSettings } from "../projects/context";
import { syncMemoryAfter, syncMemoryBefore } from "../projects/memory-sync";
import { getProject } from "../projects/project";
import { ensureReplica, pushBookmark, trunkFor, type ReplicaDeps } from "../projects/replicas";
import { appendEvent, latestEventOfType, type EventRecord } from "../store/events";
import { SqliteSessionStore } from "../store/session-store";
import { getTask, getTaskSettings, updateTask, updateTaskSettings, type TaskRow, type TaskSettings } from "../store/records";
import { getToken } from "../token";
import { readManifest, transcriptPath, type TaskManifest } from "./manifest";
import { provisionTask } from "./provision";

export type TaskState = "idle" | "running" | "waiting" | "archived";

type TurnInput = { taskId: string; prompt: string };
type TurnCheckpoint = { phase: "run" } | { phase: "finish" };
/** Installed by `openHarness`: how a phase finds the Harness it runs in. */
type MeddleHooks = { harness(): Harness };
type TurnRuntime = TaskRuntime<TurnInput, TurnCheckpoint, null, MeddleHooks>;

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

async function runnerFor(runtime: TurnRuntime, context: Context): Promise<TaskRunner> {
  let harness: Harness | undefined;
  await runtime.hooks.each("harness", (get) => { harness = get(); });
  if (harness === undefined) throw new Error("the meddle extension is not installed");
  return awaitWithContext(runnerSlot(harness).promise, context);
}

/** What a rerun of a cut-off turn sends into the resumed session instead of the turn's prompt. */
export const CARRY_ON_PROMPT =
  "The meddle service restarted while you were working on the previous message. Continue where you left off; do not redo work that is already done.";

/**
 * One Claude Code turn of a task. `run` drives the turn; a rerun after a crash resumes the task's
 * session and tells Claude to carry on. `finish` does the bookkeeping once the turn is over, so a rerun
 * from there skips the turn.
 */
export const MeddleTurn = defineTask<TurnInput, TurnCheckpoint, null, MeddleHooks>({
  name: "meddle.turn",
  version: 1,
  initial: () => ({ phase: "run" }),
  phases: {
    // Commits nothing before the turn ends: a commit would be progress to pi-durable and start its restart count
    // over, so a turn that kept crashing the process would never park. Whether this is a rerun comes from the log.
    run: async (task, runtime, context) => {
      const runner = await runnerFor(runtime, context);
      await runner.runTurnPhase(task.input, context);
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
   * The primary project of each task whose turn is live or syncing memory to start, so whether a project is live here
   * needs no manifest.
   */
  #primaries = new Map<string, string>();
  #pool: PoolRuntime | undefined;
  #log: (line: string) => void;
  /** Tasks whose new `meddle.turn` is being created or has not started running yet. */
  #pending = new Set<string>();
  #eventListeners = new Set<(taskId: string, seq: number, message: SDKMessage | MeddleEvent) => void>();
  #stateListeners = new Set<(taskId: string, state: TaskState) => void>();

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
  }

  /**
   * Gives a runner built before the pool its pool, before any turn runs. Attaching the pool it already has is a no-op;
   * another one is refused.
   */
  attachPool(pool: PoolRuntime): void {
    if (this.#pool === pool) return;
    if (this.#pool !== undefined) throw new Error("this TaskRunner already has a pool");
    this.#pool = pool;
  }

  /**
   * Provisions a task. With a pool, each project is first replicated here when it is homed elsewhere and unknown
   * (cloned from its home), and the task starts from the home's trunk.
   */
  async create(input: { title: string; projectIds: string[] }): Promise<TaskManifest> {
    const token = await getToken(this.#cfg);
    if (token === null || token === "") throw new Error("no token set");
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
    let stale = false;
    if (row.state === "running" || row.state === "waiting") {
      const live = this.#live.get(taskId);
      if (live !== undefined) {
        // Sent first: after the turn's `result` its input is closed while the turn is still live, and a steer then
        // is refused rather than logged as sent.
        if (live.queue.ended) throw new Error("the turn just ended; send it as a new prompt");
        live.queue.push(text, "now");
        const steer = promptEvent(text);
        const seq = appendEvent(this.#db, taskId, steer);
        notify(this.#eventListeners, (cb) => cb(taskId, seq, steer));
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
    // Reserved before the first await, so a concurrent prompt cannot create a second turn.
    if (this.#pending.has(taskId)) throw new Error("task has a pending turn");
    this.#pending.add(taskId);
    try {
      if (stale) this.#setState(taskId, "idle");
      const root = await this.#harness.root(BACKGROUND_CONTEXT);
      await root.commit(
        (tx) => tx.createTask(MeddleTurn, { taskId, prompt: text }, { ownership: { kind: "conversation" } }),
        BACKGROUND_CONTEXT,
      );
    } catch (err) {
      this.#pending.delete(taskId);
      throw err;
    }
  }

  async interrupt(taskId: string): Promise<void> {
    await this.#liveQueryOrThrow(taskId).interrupt();
  }

  /** Switches the live turn's permission mode, if any, and keeps it for the task's later turns. */
  async setPermissionMode(taskId: string, mode: PermissionMode): Promise<void> {
    this.#row(taskId);
    await this.liveQuery(taskId)?.setPermissionMode(mode);
    updateTaskSettings(this.#db, taskId, { permissionMode: mode });
  }

  /** Switches the live turn's model, if any, and keeps it for the task's later turns; none is the default. */
  async setModel(taskId: string, model?: string): Promise<void> {
    this.#row(taskId);
    await this.liveQuery(taskId)?.setModel(model);
    updateTaskSettings(this.#db, taskId, { model });
  }

  /** Effort for the task's later turns; a live turn keeps its own. */
  async setEffort(taskId: string, effort: string): Promise<void> {
    this.#row(taskId);
    updateTaskSettings(this.#db, taskId, { effort });
  }

  /** The model, effort and permission mode the task's next turn starts with, where the user chose one. */
  settings(taskId: string): TaskSettings {
    this.#row(taskId);
    return getTaskSettings(this.#db, taskId);
  }

  /** Runs the task's turn again after pi-durable's restart limit parked it. */
  async retry(taskId: string): Promise<void> {
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
   * The `run` phase of `meddle.turn`: drives the turn to its end. A rerun of a cut-off turn that resumes the
   * session sends `CARRY_ON_PROMPT` instead of the prompt. Not for callers outside this module.
   */
  async runTurnPhase(input: TurnInput, context: Context): Promise<void> {
    const { taskId } = input;
    let failureLogged = false; // the turn's own turn_failed is in the log
    try {
      const rerun = lastTurnCutOff(this.#db, taskId);
      const started = this.#row(taskId).started === 1;
      this.#db.transaction(() => updateTask(this.#db, taskId, { started: 1, state: "running" }))();
      this.#pending.delete(taskId);
      this.#emitState(taskId, "running");
      const manifest = await readManifest(this.#cfg, taskId);
      const primary = manifest.primaryProjectId;
      const deps = this.#replicaDeps();
      if (deps !== null) {
        const live = [...this.#primaries].some(([id, p]) => id !== taskId && p === primary);
        this.#primaries.set(taskId, primary);
        await syncMemoryBefore(deps, primary, live, this.#log);
      }
      // Resume only a session whose transcript Claude Code wrote, not one a turn merely set out to create.
      const resume = started && existsSync(transcriptPath(this.#cfg, manifest));
      const queue = new InputQueue();
      const { query, done } = runTurn({
        input: await this.#engineInput(taskId, manifest, resume),
        // Without a session to resume, a rerun has nothing to carry on from and sends the prompt again.
        prompt: rerun && resume ? CARRY_ON_PROMPT : input.prompt,
        db: this.#db,
        approvals: this.approvals,
        queue,
        ...(context.abortSignal !== undefined ? { signal: context.abortSignal } : {}),
        onMessage: (m, seq) => {
          if (m.type === "meddle" && m.subtype === "turn_failed") failureLogged = true;
          notify(this.#eventListeners, (cb) => cb(taskId, seq, m));
        },
      });
      this.#live.set(taskId, { query, queue, state: "running" });
      try {
        await done;
      } finally {
        this.#live.delete(taskId);
        this.#primaries.delete(taskId);
      }
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
   * when that is another node and syncs the primary project's memory. A failed push or sync is logged, never thrown:
   * the turn completed, and the next turn end tries again. Not for callers outside this module.
   */
  async finishTurnPhase(taskId: string, context: Context): Promise<void> {
    let manifest: TaskManifest;
    const moved: Array<{ projectId: string; replica: string; bookmark: string; change: string }> = [];
    try {
      manifest = await readManifest(this.#cfg, taskId);
      for (const p of manifest.projects) {
        const workspace = join(paths(this.#cfg).task(taskId), p.workspace);
        const bookmark = `meddle/task/${taskId}/${p.name}`;
        const change = await changeId(workspace, this.#cfg);
        await bookmarkSet(p.replica, bookmark, change, this.#cfg);
        moved.push({ projectId: p.id, replica: p.replica, bookmark, change });
      }
    } catch (err) {
      this.#failTurn(taskId, context);
      throw err;
    }
    const deps = this.#replicaDeps();
    if (deps === null) return;
    for (const m of moved) await this.#pushToHome(deps, m);
    await syncMemoryAfter(deps, manifest.primaryProjectId, this.#log);
  }

  /** Pushes a task bookmark to its project's home when that is another node; a failure is logged. */
  async #pushToHome(deps: ReplicaDeps, m: { projectId: string; replica: string; bookmark: string; change: string }): Promise<void> {
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

  /** What the replica and memory functions need, or null without a pool. */
  #replicaDeps(): ReplicaDeps | null {
    return this.#pool === undefined ? null : { cfg: this.#cfg, db: this.#db, pool: this.#pool };
  }

  /** After the turn's terminal commit: count it and make the task idle. Not for callers outside this module. */
  completeTurn(taskId: string): void {
    updateTask(this.#db, taskId, { turns: this.#row(taskId).turns + 1 });
    this.#setState(taskId, "idle");
  }

  /** The `abort` phase of `meddle.turn`; not for callers outside this module. */
  abortTurnPhase(taskId: string): void {
    this.#live.get(taskId)?.query.close();
    this.#setState(taskId, "idle");
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
    if (!context.abortSignal?.aborted) this.#setState(taskId, "idle");
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
  ): Promise<Omit<EngineInput, "prompt" | "canUseTool" | "onPermissionDenied">> {
    const token = await getToken(this.#cfg);
    if (token === null || token === "") throw new Error("no token set");
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
        this.#setState(taskId, state);
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
 * Whether the task's last turn was cut off, so this run is its rerun: of the events that start or end a turn, the
 * newest is a `turn_started` (the process died mid-turn) or a `turn_aborted` (a close interrupted it). A `result` or
 * `turn_failed`, or none, means a first attempt. A process that dies between a turn's `result` and the commit of its
 * `finish` checkpoint (milliseconds) has its rerun send the prompt again: the one replay this accepts.
 */
function lastTurnCutOff(db: Database, taskId: string): boolean {
  const latest = [
    latestEventOfType(db, taskId, "meddle", "turn_started"),
    latestEventOfType(db, taskId, "meddle", "turn_aborted"),
    latestEventOfType(db, taskId, "meddle", "turn_failed"),
    latestEventOfType(db, taskId, "result"),
  ].reduce<EventRecord | null>((a, b) => (b !== null && (a === null || b.seq > a.seq) ? b : a), null);
  const subtype = (latest?.message as { subtype?: unknown } | undefined)?.subtype;
  return latest !== null && (latest.message as { type?: unknown }).type === "meddle" && (subtype === "turn_started" || subtype === "turn_aborted");
}

function isParked(turn: TaskInspection): boolean {
  return turn.state.kind === "blocked" && turn.state.reason === "restart_limit";
}
