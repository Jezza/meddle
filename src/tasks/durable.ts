import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { PermissionMode, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { awaitWithContext, BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { defineTask, type Harness, type TaskId, type TaskRuntime } from "@earendil-works/pi-durable";
import type { NodeConfig } from "../config";
import { Approvals } from "../engine/approvals";
import { InputQueue } from "../engine/input";
import type { EngineInput } from "../engine/options";
import { runTurn, type MeddleEvent } from "../engine/session";
import { bookmarkSet, changeId } from "../jj";
import { paths } from "../paths";
import { loadContext, loadProjectSettings } from "../projects/context";
import { SqliteSessionStore } from "../store/session-store";
import { getTask, updateTask, type TaskRow } from "../store/records";
import { getToken } from "../token";
import { readManifest, type TaskManifest } from "./manifest";
import { provisionTask } from "./provision";

export type TaskState = "idle" | "running" | "waiting" | "archived";

type TurnInput = { taskId: string; prompt: string };
type TurnCheckpoint = { phase: "run" };
/** Installed by `openHarness`: how a phase finds the Harness it runs in. */
type MeddleHooks = { harness(): Harness };
type TurnRuntime = TaskRuntime<TurnInput, TurnCheckpoint, null, MeddleHooks>;

export type RunnerDeps = { claudePath?: string; claudeRuntime?: "bun" | "node"; extraEnv?: Record<string, string> };

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

/** One Claude Code turn of a task. A rerun after a crash resumes the task's session. */
export const MeddleTurn = defineTask<TurnInput, TurnCheckpoint, null, MeddleHooks>({
  name: "meddle.turn",
  version: 1,
  initial: () => ({ phase: "run" }),
  phases: {
    run: async (task, runtime, context) => {
      const runner = await runnerFor(runtime, context);
      await runner.runTurnPhase(task.id, task.input, context);
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
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
  /** Task id → the durable id of its unfinished `meddle.turn`, as far as this process knows. */
  #turns = new Map<string, TaskId>();
  #models = new Map<string, string | undefined>();
  #efforts = new Map<string, string>();
  #eventListeners = new Set<(taskId: string, seq: number, message: SDKMessage | MeddleEvent) => void>();
  #stateListeners = new Set<(taskId: string, state: TaskState) => void>();

  constructor(cfg: NodeConfig, db: Database, harness: Harness, deps: RunnerDeps) {
    this.#cfg = cfg;
    this.#db = db;
    this.#harness = harness;
    this.#deps = deps;
    this.#sessionStore = new SqliteSessionStore(db);
    const slot = runnerSlot(harness);
    if (slot.bound) throw new Error("this Harness already has a TaskRunner");
    slot.bound = true;
    slot.resolve(this);
    this.approvals.onChange(() => this.#syncWaiting());
  }

  async create(input: { title: string; projectIds: string[] }): Promise<TaskManifest> {
    const token = await getToken(this.#cfg);
    if (token === null || token === "") throw new Error("no token set");
    return provisionTask(this.#cfg, this.#db, input);
  }

  /** Steers the live turn, or starts a new durable turn when the task is idle. */
  async prompt(taskId: string, text: string): Promise<void> {
    const row = this.#row(taskId);
    if (row.state === "archived") throw new Error(`task is archived: ${taskId}`);
    if (row.state === "running" || row.state === "waiting") {
      const live = this.#live.get(taskId);
      if (live === undefined) throw new Error("task has no live turn");
      live.queue.push(text, "now");
      return;
    }
    if (this.#turns.has(taskId)) throw new Error("task has a pending turn");
    const root = await this.#harness.root(BACKGROUND_CONTEXT);
    const id = await root.commit(
      (tx) => tx.createTask(MeddleTurn, { taskId, prompt: text }, { ownership: { kind: "conversation" } }),
      BACKGROUND_CONTEXT,
    );
    this.#turns.set(taskId, id);
  }

  async interrupt(taskId: string): Promise<void> {
    await this.#liveQueryOrThrow(taskId).interrupt();
  }

  async setPermissionMode(taskId: string, mode: PermissionMode): Promise<void> {
    await this.#liveQueryOrThrow(taskId).setPermissionMode(mode);
  }

  /** Switches the live turn's model, if any, and keeps it for the task's later turns. */
  async setModel(taskId: string, model?: string): Promise<void> {
    this.#models.set(taskId, model);
    await this.liveQuery(taskId)?.setModel(model);
  }

  /** Effort for the task's later turns; a live turn keeps its own. */
  async setEffort(taskId: string, effort: string): Promise<void> {
    this.#efforts.set(taskId, effort);
  }

  /** Runs a turn parked by pi-durable's restart limit again. */
  async retry(taskId: string): Promise<void> {
    const id = this.#turns.get(taskId);
    if (id === undefined) throw new Error(`unknown task: ${taskId}`);
    await this.#harness.retryTask(id, BACKGROUND_CONTEXT);
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

  /** The `run` phase of `meddle.turn`; not for callers outside this module. */
  async runTurnPhase(durableId: TaskId, input: TurnInput, context: Context): Promise<void> {
    const { taskId } = input;
    this.#turns.set(taskId, durableId);
    const resume = this.#row(taskId).started === 1;
    this.#db.transaction(() => updateTask(this.#db, taskId, { started: 1, state: "running" }))();
    this.#emitState(taskId, "running");
    const queue = new InputQueue();
    try {
      const engineInput = await this.#engineInput(taskId, resume);
      const { query, done } = runTurn({
        input: engineInput,
        prompt: input.prompt,
        db: this.#db,
        approvals: this.approvals,
        queue,
        ...(context.abortSignal !== undefined ? { signal: context.abortSignal } : {}),
        onMessage: (m, seq) => { for (const cb of [...this.#eventListeners]) cb(taskId, seq, m); },
      });
      this.#live.set(taskId, { query, queue, state: "running" });
      try {
        await done;
      } finally {
        this.#live.delete(taskId);
      }
      const row = this.#row(taskId);
      updateTask(this.#db, taskId, { turns: row.turns + 1 });
      for (const p of engineInput.manifest.projects) {
        const workspace = join(paths(this.#cfg).task(taskId), p.workspace);
        await bookmarkSet(p.replica, `meddle/task/${taskId}/${p.name}`, await changeId(workspace));
      }
    } catch (err) {
      // An abort (close, abortTask) leaves the task running: a rerun resumes it, or the abort handler settles it.
      if (!context.abortSignal?.aborted) this.#endTurn(taskId);
      throw err;
    }
    this.#endTurn(taskId);
  }

  /** The `abort` phase of `meddle.turn`; not for callers outside this module. */
  abortTurnPhase(taskId: string): void {
    this.#live.get(taskId)?.query.close();
    this.#endTurn(taskId);
  }

  #endTurn(taskId: string): void {
    this.#turns.delete(taskId);
    this.#setState(taskId, "idle");
  }

  async #engineInput(taskId: string, resume: boolean): Promise<Omit<EngineInput, "prompt" | "canUseTool" | "onPermissionDenied">> {
    const manifest = await readManifest(this.#cfg, taskId);
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
    const model = this.#models.get(taskId);
    const effort = this.#efforts.get(taskId);
    if (model !== undefined) input.model = model;
    if (effort !== undefined) input.effort = effort;
    if (this.#deps.claudePath !== undefined) input.claudePath = this.#deps.claudePath;
    if (this.#deps.claudeRuntime !== undefined) input.claudeRuntime = this.#deps.claudeRuntime;
    if (this.#deps.extraEnv !== undefined) input.extraEnv = this.#deps.extraEnv;
    return input;
  }

  /** `waiting` while a live turn has an approval pending, `running` otherwise. */
  #syncWaiting(): void {
    for (const [taskId, live] of this.#live) {
      const state = this.approvals.pending(taskId).length > 0 ? "waiting" : "running";
      if (state === live.state) continue;
      live.state = state;
      this.#setState(taskId, state);
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
    for (const cb of [...this.#stateListeners]) cb(taskId, state);
  }
}
