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
import { resultError, runTurn, type MeddleEvent, type TokenFault } from "../engine/session";
import { askTitle } from "../engine/title";
import { bookmarkForget, bookmarkSet, changeId } from "../jj";
import { checkTaskRoot, paths } from "../paths";
import { shortId } from "../pool/ids";
import { dedupe } from "../pool/report";
import type { PoolRuntime } from "../pool/runtime";
import { applyProject } from "../projects/applier";
import { loadProjectSettings, parseContext, withTaskRules } from "../projects/context";
import { syncMemoryAfter, syncMemoryBefore } from "../projects/memory-sync";
import type { StreamReader } from "../pool/frames";
import { getProject, listProjects, type Project } from "../projects/project";
import { awaitLine, holdLineRows, reclaimLineRows, releaseLineRows, writeLineRows } from "../projects/lines";
import { branchChanges, lineChanges, listLineRows, mergeLineRows, writeLineRow, type LineRow } from "../pool/rows";
import { ensureServiceRepo, type ReplicaDeps } from "../projects/replicas";
import { place, placementCandidates } from "../pool/placement";
import { appendEvent, latestEventOfType, listEventsTail, type EventRecord } from "../store/events";
import { SqliteSessionStore } from "../store/session-store";
import {
  clearTaskLog,
  countRunningTasks,
  deleteTask,
  getTask,
  getTaskSettings,
  listLiveTasks,
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
import { acceptanceOf, branchTips, type Acceptance, type BranchTips, type LineName } from "./accept";
import { readArchive, unpackArchiveFiles, writeArchive } from "./archive";
import { readManifest, taskGlob, taskNamespace, transcriptPath, writeManifest, type Start, type TaskManifest } from "./manifest";
import { MeddleMove, releaseFolder, type MoveInput } from "./move";
import { promptTitle } from "./names";
import { checkReceivedManifest, dropWorkspace, provisionFromManifest, provisionTask, SAFE_ID } from "./provision";
import { adoptTranscriptSlot, importTask, type Receipt } from "./transfer";

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
  /** Called once `create` made the task, before it answers; a throw fails the call, and the task stays. */
  afterCreate?(taskId: string): void | Promise<void>;
  /** Called as a failed move restores the task's state; a throw stands for a failure there. */
  beforeRestore?(taskId: string): void | Promise<void>;
  /**
   * Called in a move's `prepare` once the task is marked moving, before the step commits; `signal` aborts when the
   * Harness closes (a test stops the node there).
   */
  afterEnterMove?(taskId: string, signal: AbortSignal): void | Promise<void>;
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
   * The node's pool. With it, tasks get a service repo of each project, write their lines as rows (`writeLineRows`)
   * as their agents work and at every turn end, and sync memory around turns; without it, the runner keeps to this
   * node.
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

/** What a retry of an idle task's last turn (one the user interrupted, or that failed) sends into its session. */
export const RETRY_PROMPT =
  "The previous turn did not finish: it was interrupted or failed. Continue where you left off; do not redo work that is already done.";

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
    runner.abortTurnPhase(task.input.taskId, task.input.freshAfter ?? 0);
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
  },
});

type LiveTurn = { query: Query; queue: InputQueue; state: "running" | "waiting" };

/** How long a turn interrupted by a "move now" has to end before it is closed. */
const INTERRUPT_GRACE_MS = 15_000;

/** How long a turn end's apply of a project may spend fetching commits its rows name that are not here yet. */
const APPLY_AT_TURN_END_MS = 5000;
/** How long creating, receiving or restoring a task waits for each of its lines' rows and commits to be here. */
const AWAIT_LINE_MS = 30_000;
/** How long after an agent's file-changing tool call its task's lines are written (`PostToolUse`, once per window). */
const LINE_DEBOUNCE_MS = 5000;
/** How long after a check of a task's acceptance that lacked a commit a row names it is made again. */
const ACCEPT_RETRY_MS = 15_000;
/** How often an accepted idle task whose turn the Harness still holds (a failed turn) looks again for it gone. */
const ACCEPT_TURN_POLL_MS = 500;

/** The key that serialises a task's receive, import, activation and abandonment (exported for tests). */
export function taskKey(taskId: string): string {
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
  #queuedListeners = new Set<(taskId: string) => void>();
  /** Per task, the `queued` its listeners were last told (JSON); none told means `[]`. */
  #toldQueued = new Map<string, string>();
  /**
   * The moves of tasks running here (decision 11). While a task is in it, its turns do not write its state, prompts are
   * queued and the rest is refused; its row says `moving` for a restart and the dashboard.
   */
  #moving = new Map<string, MoveState>();
  /** Tasks whose move waiting for the turn was told to interrupt it (`hurryMove`). */
  #hurried = new Set<string>();
  /** Tasks whose move is being aborted because it was cancelled (`cancelMove`), not because it failed. */
  #cancelling = new Set<string>();
  #moveListeners = new Set<(taskId: string, move: MoveState | null) => void>();
  #manifestListeners = new Set<(taskId: string, manifest: TaskManifest) => void>();
  /** Told whenever a task's stored settings (model, effort, permission mode) change here. */
  #settingsListeners = new Set<(taskId: string) => void>();
  /** Woken whenever a turn of the task ends (completed, failed or aborted): a move waits for it. */
  #turnWaiters = new Map<string, Set<() => void>>();
  /** Tasks being archived: until the row says `archived`, no turn or move of them starts. */
  #archiving = new Set<string>();
  /** Tasks being restored here (`restoreHere`): no restore-move of them starts meanwhile. */
  #restoring = new Set<string>();
  /**
   * Per task, the write of its lines its agent's last file-changing tool call scheduled (`#filesChanged`), and the
   * write in flight: one at a time, so that a turn end's write is never overtaken by an earlier one.
   */
  #lineWrites = new Map<string, { timer: ReturnType<typeof setTimeout> | undefined; running: Promise<void> }>();
  /** Per live task held here, whether its work is accepted, as its last check found (`acceptance`). */
  #acceptance = new Map<string, Acceptance>();
  /** Per task, the check of its acceptance running, and whether another was asked for meanwhile. */
  #acceptChecks = new Map<string, { again: boolean }>();
  /** Per task, the check of its acceptance made again later: the last one lacked a commit a row names. */
  #acceptRetries = new Map<string, ReturnType<typeof setTimeout>>();
  #acceptanceListeners = new Set<(taskId: string, acceptance: Acceptance) => void>();
  /** Per task, the accepted idle task waiting for its turn to leave the Harness (`#awaitTurnGone`). */
  #acceptTurnWaits = new Set<string>();
  /** Tasks whose check lacked a commit a row names, and those whose lack is logged already (once per task). */
  #acceptPending = new Set<string>();
  #acceptPendingLogged = new Set<string>();
  /**
   * Per project, its branches as a check reads them (`branchTips`), computed once per change of its branch rows
   * (`#branchVersions`) for every task checked; a reading that lacked a commit is not kept.
   */
  #tips = new Map<string, { version: number; tips: Promise<BranchTips> }>();
  #branchVersions = new Map<string, number>();
  /** Stops the checks of tasks' acceptance on row changes (`#watchAcceptance`). */
  #stopAcceptance: (() => void) | undefined;
  #closed = false;

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
    if (this.#pool !== undefined) {
      this.#sweepOrphans();
      this.#watchAcceptance();
    }
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
    this.#watchAcceptance();
  }

  /** Stops checking whether tasks' work is accepted, and drops the checks scheduled for later. */
  close(): void {
    this.#closed = true;
    this.#stopAcceptance?.();
    this.#stopAcceptance = undefined;
    for (const timer of this.#acceptRetries.values()) clearTimeout(timer);
    this.#acceptRetries.clear();
    this.#tips.clear();
  }

  /**
   * Provisions task `taskId` (with no project, or several) from the starts the node asked resolved (`startAt`), in
   * order, the first the primary. With a pool, each project gets a service repo here when it has none
   * (`ensureServiceRepo`), each start's line must reach it first (`awaitLine`: its row, and its commit fetched), and
   * once the task is provisioned this node takes each line, one epoch up, and applies the project (which forgets the
   * line's remote ref now that the task's own bookmark holds it). Refused for an id that is not one path segment, or
   * that a task here already has.
   */
  async create(input: { title: string; taskId: string; starts: Start[] }): Promise<TaskManifest> {
    const { taskId, starts } = input;
    if (!SAFE_ID.test(taskId)) throw new Error(`invalid task id: ${taskId}`);
    if (getTask(this.#db, taskId) !== null) throw new Error(`task ${taskId} exists here`);
    if ((await pickToken(this.#cfg, this.#db)) === null) throw new Error("no usable token");
    const deps = this.#replicaDeps();
    const names = new Map<string, string>();
    for (const start of starts) {
      const project = deps === null ? getProject(this.#db, start.projectId) : await ensureServiceRepo(deps, start.projectId);
      if (project === null) throw new Error(`unknown project: ${start.projectId}`);
      names.set(start.projectId, project.name);
      if (deps === null) continue;
      const at = await awaitLine(deps, start.projectId, taskId, project.name, AWAIT_LINE_MS);
      if (at !== start.commit) throw new Error(`the line of ${project.name} is not at ${start.commit.slice(0, 12)}`);
    }
    const manifest = await provisionTask(this.#cfg, this.#db, { title: input.title, taskId, starts });
    if (deps !== null) {
      const self = deps.pool.identity.id;
      for (const start of starts) {
        const name = names.get(start.projectId)!;
        const row = listLineRows(this.#db, start.projectId, taskId).find((r) => r.name === name);
        if (row !== undefined && row.commit !== null) {
          writeLineRow(this.#db, { ...row, holder: self, epoch: row.epoch + 1 });
        }
        await applyProject(deps, start.projectId, APPLY_AT_TURN_END_MS).catch((err: unknown) => {
          this.#log(`meddle: apply: project ${shortId(start.projectId)} as ${taskId} was created failed: ${messageOf(err)}`);
        });
      }
    }
    // The new task is live here: whoever lists this node's tasks hears of it, whichever node asked for it.
    this.#emitState(manifest.id, "idle");
    await this.#deps.hooks?.afterCreate?.(manifest.id);
    return manifest;
  }

  /**
   * Haiku's title for a new task whose first prompt is `prompt` (`askTitle`), run with this node's first usable token
   * and its Claude Code; null when no token is usable or the query failed. It does not mark the token: a turn will.
   */
  async askTitle(prompt: string): Promise<string | null> {
    const picked = await pickToken(this.#cfg, this.#db);
    if (picked === null) return null;
    return askTitle(prompt, {
      cfg: this.#cfg,
      token: picked.value,
      ...(this.#deps.claudePath === undefined ? {} : { claudePath: this.#deps.claudePath }),
      ...(this.#deps.claudeRuntime === undefined ? {} : { claudeRuntime: this.#deps.claudeRuntime }),
      ...(this.#deps.extraEnv === undefined ? {} : { extraEnv: this.#deps.extraEnv }),
    });
  }

  /** How many of this node's tasks are in state `running` or `waiting`. */
  running(): number {
    return countRunningTasks(this.#db);
  }

  /**
   * Steers the live turn, or starts a new durable turn when the task is idle; a busy task is never refused a prompt.
   * A steer goes into the turn's input, for Claude Code to take into the running turn at its next chance (or as a
   * turn of its own once that one ends), and is `queued` until it does. A prompt the live turn can no longer take (its
   * input closed with its `result`), or for a turn that is being created, resumed by the Harness or retried after it
   * was parked (which this retries), is queued for the task's next turn. A task left `running` with no turn here or in
   * the Harness is idle again, and the prompt starts a turn. Answers `"turn"` when the text started a turn, `"queued"`
   * when it waits to be taken (a steer, or a prompt for a later turn).
   */
  async prompt(taskId: string, text: string): Promise<"turn" | "queued"> {
    const row = this.#row(taskId);
    if (row.state === "archived") throw new Error(`task is archived: ${taskId}`);
    if (this.#archiving.has(taskId)) throw new Error("task is being archived");
    refuseReceiving(row);
    refuseMoved(row);
    if (this.#isMoving(row)) {
      // A restore-move sends the archive's row, which has no queue: nothing sent meanwhile would travel.
      if (row.archived_on !== null) throw new Error("task is being restored; send it again once it has arrived");
      // Queued prompts travel with the task, and its export reads them once the handoff has begun: one sent after that
      // would be left behind.
      if (this.#moving.get(taskId)?.phase !== "prepare") throw new Error("task is moving; send it again once it has arrived");
      this.#enqueue(taskId, text);
      return "queued";
    }
    let stale = false;
    if (row.state === "running" || row.state === "waiting") {
      const live = this.#live.get(taskId);
      if (live !== undefined) {
        // After the turn's `result` its input is closed while the turn is still live: the prompt waits for the next.
        if (live.queue.ended) return this.#enqueueNext(taskId, text);
        this.#send(taskId, live.queue, text);
        return "queued";
      }
      const turn = await this.#durableTurn(taskId);
      if (turn !== undefined && isParked(turn)) await this.#harness.retryTask(turn.record.id, BACKGROUND_CONTEXT);
      if (turn !== undefined) return this.#enqueueNext(taskId, text);
      stale = true;
    }
    // Prompts queued while the task moved run first, one turn each; this one waits its turn behind them.
    if (queuedOf(this.#row(taskId)).length > 0) {
      if (stale) this.#setState(taskId, "idle");
      return this.#enqueueNext(taskId, text);
    }
    // Reserved before the first await, so a concurrent prompt cannot create a second turn: it waits for the next.
    if (this.#pending.has(taskId)) return this.#enqueueNext(taskId, text);
    this.#pending.add(taskId);
    try {
      if (stale) this.#setState(taskId, "idle");
      await this.#createTurn({ taskId, prompt: text });
    } catch (err) {
      this.#pending.delete(taskId);
      throw err;
    }
    return "turn";
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
    if (this.#archiving.has(taskId)) return;
    const [head] = queuedOf(row);
    if (head === undefined) return;
    this.#pending.add(taskId);
    try {
      await this.#createTurn({ taskId, prompt: head, ...(options.freshAfter === undefined ? {} : { freshAfter: options.freshAfter }) });
    } catch (err) {
      this.#pending.delete(taskId);
      throw err;
    }
    // This is the one taker, kept single by `#pending`; meanwhile a prompt may join the tail, or the steers a turn
    // ended without the front, so the first copy of the text goes.
    this.#db.transaction(() => {
      const queued = queuedOf(this.#row(taskId));
      const at = queued.indexOf(head);
      const rest = at === -1 ? queued : [...queued.slice(0, at), ...queued.slice(at + 1)];
      updateTask(this.#db, taskId, { queued: rest.length === 0 ? null : JSON.stringify(rest) });
    })();
    this.#emitQueued(taskId);
  }

  /** What the task has been sent and not started on, oldest first: its live turn's untaken steers, then its queue. */
  queued(taskId: string): string[] {
    const live = this.#live.get(taskId)?.queue.untaken().map((u) => u.text) ?? [];
    return [...live, ...queuedOf(this.#row(taskId))];
  }

  /** Called whenever what `queued` answers for a task changes. */
  onQueued(cb: (taskId: string) => void): () => void {
    this.#queuedListeners.add(cb);
    return () => { this.#queuedListeners.delete(cb); };
  }

  /** Tells the queued listeners when the task's `queued` differs from what they were last told. */
  #emitQueued(taskId: string): void {
    const row = getTask(this.#db, taskId);
    const now = row === null ? "[]" : JSON.stringify(this.queued(taskId));
    if ((this.#toldQueued.get(taskId) ?? "[]") === now) return;
    this.#toldQueued.set(taskId, now);
    notify(this.#queuedListeners, (cb) => cb(taskId));
  }

  /** Appends `text` to the task's queued prompts. */
  #enqueue(taskId: string, text: string): void {
    this.#db.transaction(() => {
      updateTask(this.#db, taskId, { queued: JSON.stringify([...queuedOf(this.#row(taskId)), text]) });
    })();
    this.#emitQueued(taskId);
  }

  /** Queues `text` for the task's next turn, which starts now if the task is idle meanwhile. */
  async #enqueueNext(taskId: string, text: string): Promise<"queued"> {
    this.#enqueue(taskId, text);
    await this.startQueued(taskId);
    return "queued";
  }

  /** Puts the texts a turn ended without taking ahead of the task's queued prompts, which came after them. */
  #requeueFront(taskId: string, texts: string[]): void {
    if (texts.length === 0) return;
    this.#db.transaction(() => {
      updateTask(this.#db, taskId, { queued: JSON.stringify([...texts, ...queuedOf(this.#row(taskId))]) });
    })();
  }

  /** Sends `text` into a live turn's input, for Claude Code to take at its next chance; it is logged when taken. */
  #send(taskId: string, queue: InputQueue, text: string): void {
    queue.push(text, "next");
    this.#emitQueued(taskId);
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
    this.#updateSettings(taskId, { permissionMode: mode });
  }

  /** Switches the live turn's model, if any, and keeps it for the task's later turns; none is the default. */
  async setModel(taskId: string, model?: string): Promise<void> {
    this.#refuseElsewhere(taskId);
    await this.liveQuery(taskId)?.setModel(model);
    this.#updateSettings(taskId, { model });
  }

  /**
   * Renames the task: its row (title and manifest) and the manifest in its folder. Refused while it is not live here
   * (moving, moved, being received or archived) and for a blank title. Answers the new manifest.
   */
  async rename(taskId: string, title: string): Promise<TaskManifest> {
    return (await this.#rename(taskId, title))!;
  }

  /**
   * Names task `taskId`, created with the made-up title `placeholder` (`initialTitle`), from its first prompt
   * (`promptTitle`: Haiku's title, else the prompt's first line) once that answers, unless the task was renamed
   * meanwhile (its title is no longer `placeholder`). Never rejects: a task that moved or was archived meanwhile keeps
   * the title it has.
   */
  async nameFromPrompt(taskId: string, placeholder: string, prompt: string): Promise<void> {
    try {
      const title = await promptTitle(prompt, (p) => this.askTitle(p));
      if (title !== null) await this.#rename(taskId, title, placeholder);
    } catch (err) {
      this.#log(`meddle: could not name task ${taskId} from its prompt: ${messageOf(err)}`);
    }
  }

  /**
   * `rename`, one at a time per task, so that a rename's check and its write are not split by another's; with `from`,
   * only while the title is still `from` (null otherwise, and nothing changes).
   */
  #rename(taskId: string, title: string, from?: string): Promise<TaskManifest | null> {
    return serialised(`title\0${taskId}`, async () => {
      const trimmed = title.trim();
      if (trimmed === "") throw new Error("a task's title cannot be blank");
      this.#refuseElsewhere(taskId);
      const row = this.#row(taskId);
      if (from !== undefined && row.title !== from) return null;
      const manifest: TaskManifest = { ...(JSON.parse(row.manifest) as TaskManifest), title: trimmed };
      await writeManifest(this.#cfg, manifest);
      updateTask(this.#db, taskId, { title: trimmed, manifest: JSON.stringify(manifest) });
      notify(this.#manifestListeners, (cb) => cb(taskId, manifest));
      return manifest;
    });
  }

  onManifest(cb: (taskId: string, manifest: TaskManifest) => void): () => void {
    this.#manifestListeners.add(cb);
    return () => { this.#manifestListeners.delete(cb); };
  }

  /** Effort for the task's later turns; a live turn keeps its own. */
  async setEffort(taskId: string, effort: string): Promise<void> {
    this.#refuseElsewhere(taskId);
    this.#updateSettings(taskId, { effort });
  }

  onSettings(cb: (taskId: string) => void): () => void {
    this.#settingsListeners.add(cb);
    return () => { this.#settingsListeners.delete(cb); };
  }

  /** Stores a change to the task's settings and tells the `onSettings` listeners. */
  #updateSettings(taskId: string, patch: Parameters<typeof updateTaskSettings>[2]): void {
    updateTaskSettings(this.#db, taskId, patch);
    notify(this.#settingsListeners, (cb) => cb(taskId));
  }

  /** The model, effort and permission mode the task's next turn starts with, where the user chose one. */
  settings(taskId: string): TaskSettings {
    this.#row(taskId);
    return getTaskSettings(this.#db, taskId);
  }

  /**
   * Runs the task's turn again: one pi-durable's restart limit parked, else (an idle task that has had a turn) a new
   * turn that carries on in the session with `RETRY_PROMPT`, for a turn that was interrupted or failed.
   */
  async retry(taskId: string): Promise<void> {
    this.#refuseElsewhere(taskId);
    const turn = await this.#durableTurn(taskId);
    if (turn !== undefined && isParked(turn)) {
      await this.#harness.retryTask(turn.record.id, BACKGROUND_CONTEXT);
      return;
    }
    if (this.#row(taskId).state === "idle" && latestEventOfType(this.#db, taskId, "meddle", "turn_started") !== null) {
      await this.prompt(taskId, RETRY_PROMPT);
      return;
    }
    throw new Error(`nothing to retry for task ${taskId}`);
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
   * prompt. When the turn's token hit a limit or was refused, the token is marked for the pool. When the turn also ended
   * with an error, a `token_fault` is logged, and `"rerun"` is returned when this was the turn's first try
   * (`tokenRetries` 0, and this run is not already the rerun) and another token is usable now, so the phase enters
   * itself again. A turn that succeeded all the same is done.
   * Not for callers outside this module.
   */
  async runTurnPhase(input: TurnInput, tokenRetries: number, context: Context): Promise<"done" | "rerun"> {
    const { taskId } = input;
    let failureLogged = false; // the turn's own turn_failed is in the log
    try {
      const cutOff = lastTurnCutOff(this.#db, taskId, input.freshAfter ?? 0);
      // A stop after the fault was logged but before the sleep was committed re-enters with the old checkpoint.
      const retries = cutOff === "token" ? Math.max(tokenRetries, 1) : tokenRetries;
      const row = this.#row(taskId);
      const started = row.started === 1;
      const moving = this.#isMoving(row);
      this.#db.transaction(() => updateTask(this.#db, taskId, moving ? { started: 1 } : { started: 1, state: "running" }))();
      this.#pending.delete(taskId);
      if (!moving) this.#emitState(taskId, "running");
      const manifest = await readManifest(this.#cfg, taskId);
      const primary = manifest.primaryProjectId;
      const deps = this.#replicaDeps();
      // A task without a project has no memory to sync.
      if (deps !== null && primary !== null) {
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
          if (m.type === "user") this.#emitQueued(taskId); // a steer it took is logged
        },
        onTokenFault: (f) => { fault = f; },
      });
      this.#live.set(taskId, { query, queue, state: "running" });
      let result: Awaited<typeof done>;
      try {
        result = await done;
      } catch (err) {
        // A turn that ended without a result after its token failed it fails as before; the token is marked all the same.
        if (fault !== null) await this.#markFault(picked.id, fault).catch(() => {});
        throw err;
      } finally {
        // Steers Claude Code did not take wait for the next turn. The task stays in `#primaries` until `finish` has
        // synced its memory.
        this.#requeueFront(taskId, queue.untaken().map((u) => u.text));
        this.#live.delete(taskId);
        this.#emitQueued(taskId);
      }
      if (fault === null) return "done";
      const marked = await this.#markFault(picked.id, fault);
      // Only a turn that failed reruns (a limit Claude Code retried past still ends in a success).
      if (resultError(result) === null) return "done";
      const next = await pickToken(this.#cfg, this.#db);
      const another = next !== null && next.id !== picked.id;
      const rerun = retries === 0 && another;
      this.#record(taskId, tokenFaultEvent(picked, marked, rerun, !rerun && another));
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
   * The `finish` phase of `meddle.turn`: moves the task's bookmarks; with a pool, writes its lines as rows, once more
   * after any write its agent's tool calls scheduled (`writeTaskLines`), applies each project's rows here
   * (`applyProject`: puts back a branch bookmark its agent moved), and syncs the primary project's memory, unless
   * another task of that project is live here (decision 15: the last of them to end commits for all). A failed
   * bookmark or row write fails the turn; a failed apply or sync is logged, never thrown: the turn completed, the
   * applier applies again on the next row change, and the next turn end tries again. Not for callers outside this
   * module.
   */
  async finishTurnPhase(taskId: string, context: Context): Promise<void> {
    try {
      let manifest: TaskManifest;
      const deps = this.#replicaDeps();
      try {
        manifest = await readManifest(this.#cfg, taskId);
        if (deps === null) await this.setTaskBookmarks(manifest);
        else await this.writeTaskLines(taskId);
      } catch (err) {
        this.#failTurn(taskId, context);
        throw err;
      }
      if (deps === null) return;
      for (const p of manifest.projects) {
        await applyProject(deps, p.id, APPLY_AT_TURN_END_MS).catch((err: unknown) => {
          this.#log(`meddle: apply: project ${shortId(p.id)} at the turn end of ${taskId} failed: ${messageOf(err)}`);
        });
      }
      const primary = manifest.primaryProjectId;
      if (primary === null) return; // no project: no bookmarks moved, no memory
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

  /** Points each of the task's project bookmarks at its workspace's working-copy change. */
  async setTaskBookmarks(manifest: TaskManifest): Promise<void> {
    for (const p of manifest.projects) {
      const workspace = join(paths(this.#cfg).task(manifest.id), p.workspace);
      const bookmark = `${taskNamespace(manifest.id)}${p.name}`;
      const change = await changeId(workspace, this.#cfg);
      // Without a snapshot of the service repo's own working copy: only the task's workspace is snapshotted.
      await serialised(repoKey(p.replica), () => bookmarkSet(p.replica, bookmark, change, this.#cfg, { ignoreWorkingCopy: true }));
    }
  }

  /**
   * Writes task `taskId`'s lines as rows from its workspaces here (`writeLineRows`), with this node their holder: what
   * a turn end writes, and what a move writes as it begins and hands the task over. Drops the write its agent's tool
   * calls scheduled (this one covers it), then writes on the task's chain of writes (`#writeLinesNext`), after the one
   * in flight. Nothing without a pool, or for a task whose row is gone, `receiving`, `moved` or `archived` by the time
   * its turn on the chain comes: a former holder never writes over its receiver's newer rows. A failure is thrown.
   */
  async writeTaskLines(taskId: string): Promise<void> {
    await this.#dropScheduledLines(taskId);
    await this.#writeLinesNext(taskId);
  }

  /**
   * After an agent's file-changing tool call (`PostToolUse`): writes the task's lines `LINE_DEBOUNCE_MS` later, once
   * for every call made meanwhile. A failed write is logged (`meddle: line: …`); the turn end writes them again. A turn
   * that ends without its `finish` (failed, aborted) drops it (`#dropScheduledLines`).
   */
  #filesChanged(taskId: string): void {
    const entry = this.#lineWrites.get(taskId) ?? { timer: undefined, running: Promise.resolve() };
    if (entry.timer !== undefined) return;
    this.#lineWrites.set(taskId, entry);
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      this.#writeLinesNext(taskId).catch((err: unknown) => {
        this.#log(`meddle: line: the lines of ${taskId} were not written: ${messageOf(err)}`);
      });
    }, LINE_DEBOUNCE_MS);
    entry.timer.unref?.();
  }

  /**
   * Every write of task `taskId`'s lines goes through here: once the write in flight, if any, is done, writes them
   * (`writeLineRows`, with `archived` as given) unless there is no pool, or the task's row is gone, `receiving`,
   * `moved` or `archived` by then. One at a time per task, in the order asked. Each write is followed by a check of
   * the task's acceptance (`#checkAcceptance`): a row already as written fires no row change.
   */
  #writeLinesNext(taskId: string, options: { archived?: boolean } = {}): Promise<void> {
    const entry = this.#lineWrites.get(taskId) ?? { timer: undefined, running: Promise.resolve() };
    this.#lineWrites.set(taskId, entry);
    const write = entry.running.catch(() => {}).then(async () => {
      const deps = this.#replicaDeps();
      const row = getTask(this.#db, taskId);
      if (deps === null || row === null || row.state === "receiving" || row.state === "moved" || row.state === "archived") return;
      await writeLineRows(deps, JSON.parse(row.manifest) as TaskManifest, options);
      this.#checkAcceptance(taskId);
    });
    entry.running = write;
    const forget = () => {
      if (this.#lineWrites.get(taskId) === entry && entry.running === write && entry.timer === undefined) this.#lineWrites.delete(taskId);
    };
    write.then(forget, forget);
    return write;
  }

  /** Drops the write of the task's lines its agent's tool calls scheduled; resolves once none is in flight. */
  async #dropScheduledLines(taskId: string): Promise<void> {
    const entry = this.#lineWrites.get(taskId);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    entry.timer = undefined;
    await entry.running.catch(() => {});
  }

  // ─── receiving a moved task ───

  /**
   * Prepares to receive task `manifest.id` from node `from`: refused unless both report the same, known Claude Code
   * version, this node hosts tasks and has a pool, and no other copy of the task is here (a partial one still being
   * received from `from` is abandoned first: the sender's handoff ran again). Merges the task's line rows `from` sent
   * with the request (`lineRows`, its last write of them; rows of other tasks or projects are dropped), so that it
   * never starts from a stale row; gets a service repo of each project, sets the task's bookmarks from its line rows
   * (`#takeLines`, the commits fetched by id), and provisions the task at them as `receiving`. Writes no row: the rows
   * stay `from`'s until the task is activated here, and a receive abandoned or refused leaves none of this node's.
   */
  async receiveTask(
    manifest: TaskManifest, from: string, version: string, lineRows: readonly LineRow[],
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const ours = claudeCodeVersion();
    if (version !== ours || ours === "unknown" || version === "unknown") return { ok: false, reason: `claude code ${ours} here, ${version} there` };
    const hosting = await checkTaskRoot(this.#cfg);
    if (!hosting.ok) return { ok: false, reason: `this node does not host tasks: ${hosting.reason}` };
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
      const projects = new Set(manifest.projects.map((p) => p.id));
      mergeLineRows(this.#db, lineRows.filter((r) => r.task === taskId && projects.has(r.project)));
      /** The repos this receive set the task's bookmarks in: forgotten there again when it fails. */
      const fetched: string[] = [];
      try {
        const parents: Record<string, string> = {};
        for (const p of manifest.projects) {
          const project = await ensureServiceRepo(deps, p.id);
          fetched.push(project.replica);
          parents[p.id] = await this.#takeLines(deps, project, taskId, p.name);
        }
        await provisionFromManifest(this.#cfg, this.#db, manifest, parents, "receiving");
        updateTask(this.#db, taskId, { receiving_from: from });
        return { ok: true };
      } catch (err) {
        for (const replica of fetched) await this.#forgetBookmarks(replica, taskId).catch(() => {});
        return { ok: false, reason: messageOf(err) };
      }
    });
  }

  /**
   * Sets task `taskId`'s bookmarks under its namespace in `project`'s repo here from its line rows of the project, each
   * once jj here has its commit (`awaitLine`, which fetches it by id; `line <t>/<n> is not here yet` past
   * `AWAIT_LINE_MS`), dropping any other bookmark there under the namespace. The project's own line (`name`) is waited
   * for first, its row too. Returns its commit.
   */
  async #takeLines(deps: ReplicaDeps, project: Project, taskId: string, name: string): Promise<string> {
    const commits = new Map([[name, await awaitLine(deps, project.id, taskId, name, AWAIT_LINE_MS)]]);
    for (const r of listLineRows(this.#db, project.id, taskId)) {
      if (r.commit !== null && r.name !== name) commits.set(r.name, await awaitLine(deps, project.id, taskId, r.name, AWAIT_LINE_MS));
    }
    await serialised(repoKey(project.replica), async () => {
      await bookmarkForget(project.replica, taskGlob(taskId), this.#cfg, { ignoreWorkingCopy: true });
      for (const [line, commit] of commits) {
        await bookmarkSet(project.replica, `${taskNamespace(taskId)}${line}`, commit, this.#cfg, { ignoreWorkingCopy: true });
      }
    });
    return commits.get(name)!;
  }

  /** Forgets every bookmark under task `taskId`'s namespace in `repo`, never snapshotting its working copy. */
  async #forgetBookmarks(repo: string, taskId: string): Promise<void> {
    await serialised(repoKey(repo), () => bookmarkForget(repo, taskGlob(taskId), this.#cfg, { ignoreWorkingCopy: true }));
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
      // The manifest checked as the task was received, not the stream's copy.
      await adoptTranscriptSlot(this.#cfg, this.#db, JSON.parse(row.manifest) as TaskManifest);
      updateTask(this.#db, taskId, {
        settings: got.settings === null ? null : JSON.stringify(got.settings),
        queued: got.queued.length === 0 ? null : JSON.stringify(got.queued),
        turns: got.turns,
      });
      notify(this.#settingsListeners, (cb) => cb(taskId));
      return got.receipt;
    });
  }

  /**
   * Makes a task received from `from` live here (`idle`); a follow-up joins the front of its queued prompts, which
   * then run one turn each, in order (`startQueued`), and its lines' rows are this node's, one epoch up
   * (`holdLineRows`, in the same transaction as the row's state: a failure to hold them is no activation). A task
   * already activated is a no-op: the sender's commit ran again, also when this node has moved the task on since. Refused `forbidden` when this node has no copy of the
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
        const pool = this.#pool;
        // One transaction: an activation holds the task's lines, or did not happen (and the sender rolls back).
        this.#db.transaction(() => {
          updateTask(this.#db, taskId, { state: "idle", receiving_from: null, queued: queued.length === 0 ? null : JSON.stringify(queued) });
          // Its lines are this node's from now on: once its row says `moved`, the sender never writes them again.
          if (pool !== undefined) holdLineRows(this.#db, pool.identity.id, taskId);
        }).immediate();
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
   * Removes a task still being received from `from`: its rows, folder and config dir, workspaces and task bookmarks.
   * An unknown task is a no-op; any other is refused `forbidden`.
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
   * Removes the task's folder and forgets its workspaces, when the folder is here: what a receive that died while
   * provisioning left of a task this node has no row for, or what an archive stopped between its row update and the
   * folder's removal left of an archived one (cleared before a restore).
   */
  async #clearLeftovers(manifest: TaskManifest): Promise<void> {
    const task = paths(this.#cfg).task(manifest.id);
    if (!existsSync(task)) return;
    for (const p of manifest.projects) {
      const replica = getProject(this.#db, p.id)?.replica;
      if (replica !== undefined) await dropWorkspace(this.#cfg, replica, `meddle-${manifest.id}`, join(task, p.workspace));
    }
    await rm(task, { recursive: true, force: true });
  }

  /**
   * Removes a received task's workspaces, every bookmark under its namespace, folder and rows. Its line rows stay the
   * sender's: the applier keeps their refs.
   */
  async #discard(row: TaskRow): Promise<void> {
    const manifest = JSON.parse(row.manifest) as TaskManifest;
    for (const p of manifest.projects) {
      await dropWorkspace(this.#cfg, p.replica, `meddle-${row.id}`, join(paths(this.#cfg).task(row.id), p.workspace));
      await serialised(repoKey(p.replica), () => bookmarkForget(p.replica, taskGlob(row.id), this.#cfg)).catch(() => {});
    }
    await rm(paths(this.#cfg).task(row.id), { recursive: true, force: true });
    deleteTask(this.#db, row.id, row.session_id);
  }

  // ─── archiving a task ───

  /**
   * Archives idle task `taskId` on this node (spec 21.4): refused (`task is <state>`, `task has queued prompts`) unless
   * its row is `idle` with nothing queued and no turn of it is live, pending or in the Harness, and it is not moving.
   * Writes its lines' rows a last time, archived (`writeLineRows`): kept, held by this node, and out of the view
   * checkouts fetch. Then writes the archive to `<data>/archives/<id>.json.gz`, records the row `archived` here (its
   * event and transcript rows stay), takes the folder and the task's bookmarks off this node (`releaseFolder`) and
   * applies each project here (logged when that fails), so that its lines are refs of the rows again. No other node is
   * asked anything. A refused or failed archive leaves the task idle and in place.
   */
  async archive(taskId: string): Promise<void> {
    await this.#archive(taskId, false);
  }

  /**
   * `archive`, by hand or (`accepted`) because the task's work was accepted. An accepted task's lines are written as
   * they are now (`#writeLinesNext`, not archived), and its acceptance checked again on them under the task's key: a
   * task no longer accepted is left idle and in place (false). Otherwise it is archived as by hand, and once its folder
   * is gone, each line a branch contains is released (`releaseLineRows`): the branch holds that work. Every other line
   * (a side line no branch contains) stays held here and archived, as a manual archive leaves it. Returns whether
   * the task was archived.
   */
  async #archive(taskId: string, accepted: boolean): Promise<boolean> {
    const deps = this.#replicaDeps();
    if (deps === null) throw new Error("this node has no pool");
    const self = deps.pool.identity.id;
    if (this.#archiving.has(taskId)) throw new Error("task is being archived");
    this.#refuseArchive(this.#row(taskId));
    // Reserved before the first await: no prompt, queued turn or move starts meanwhile. Under the task's key, so a
    // restore or delete waits until the folder is gone.
    this.#archiving.add(taskId);
    let archived = false;
    try {
      archived = await serialised(taskKey(taskId), async () => {
        if ((await this.#durableTurn(taskId)) !== undefined) throw new Error("task is running");
        const row = this.#row(taskId);
        this.#refuseArchive(row);
        // On the task's chain of writes, after any in flight; one its last turn's tool calls scheduled is dropped.
        await this.#dropScheduledLines(taskId);
        /** The lines to release: those a branch contains, read from the rows as archived. */
        let release: LineName[] = [];
        if (accepted) {
          const manifest = JSON.parse(row.manifest) as TaskManifest;
          await this.#writeLinesNext(taskId);
          const tipsOf = (id: string) => this.#tipsOf(deps, id);
          if ((await acceptanceOf(deps, manifest, tipsOf)).verdict !== "accepted") return false;
          await this.#writeLinesNext(taskId, { archived: true });
          release = (await acceptanceOf(deps, manifest, tipsOf)).contained;
        } else await this.#writeLinesNext(taskId, { archived: true });
        await writeArchive(this.#cfg, this.#db, taskId, paths(this.#cfg).archiveFile(taskId));
        // Recorded before the folder goes: a node that stops in between has an archived task whose leftovers a
        // restore clears, never an idle one without its folder.
        updateTask(this.#db, taskId, { state: "archived", archived_on: self, archived_at: new Date().toISOString() });
        try {
          await releaseFolder(this.#cfg, this.#db, taskId);
        } catch (err) {
          this.#log(`meddle: archive: ${taskId} is archived, but its folder could not be removed: ${messageOf(err)}`);
        }
        for (const project of new Set(release.map((l) => l.project))) {
          const out = new Set(release.filter((l) => l.project === project).map((l) => l.name));
          const keep = listLineRows(this.#db, project, taskId).map((r) => r.name).filter((name) => !out.has(name));
          releaseLineRows(this.#db, taskId, keep, project);
        }
        await this.#applyProjects(deps, row, "was archived");
        return true;
      });
    } finally {
      this.#archiving.delete(taskId);
    }
    if (archived) {
      // What its acceptance was is no news about an archived task.
      this.#forgetAcceptance(taskId);
      this.#emitState(taskId, "archived");
    }
    return archived;
  }

  /**
   * Applies each project of task `row` here (`applyProject`, bounded): its line rows' refs at once, not at the
   * applier's next pass. A failure is logged (`meddle: apply: project <short> as <id> <what> failed: …`).
   */
  async #applyProjects(deps: ReplicaDeps, row: TaskRow, what: string): Promise<void> {
    for (const p of (JSON.parse(row.manifest) as TaskManifest).projects) {
      await applyProject(deps, p.id, APPLY_AT_TURN_END_MS).catch((err: unknown) => {
        this.#log(`meddle: apply: project ${shortId(p.id)} as ${row.id} ${what} failed: ${messageOf(err)}`);
      });
    }
  }

  /** Throws why task `row` cannot be archived now, as `archive` says. */
  #refuseArchive(row: TaskRow): void {
    if (this.#isMoving(row)) throw new Error("task is moving");
    const live = this.#live.get(row.id);
    if (live !== undefined) throw new Error(`task is ${live.state}`);
    if (this.#pending.has(row.id)) throw new Error("task is running");
    if (row.state !== "idle") throw new Error(`task is ${row.state}`);
    if (queuedOf(row).length > 0) throw new Error("task has queued prompts");
  }

  /**
   * Restores task `taskId`, archived on this node, here: the task's bookmarks come back from its line rows, held here
   * (`#takeLines`), and each project's workspace starts on its project's line; the folder is provisioned from the
   * manifest and the archive's files are unpacked into it (a task without a project's transcript into this node's
   * slot). The row is `idle` again, no longer archived, its lines' rows live again (`holdLineRows`, then applied here),
   * and the archive is deleted. No other node is asked anything. On failure, what it made is taken off again and the
   * task stays archived. While it runs, another restore of the task is refused (`task is being restored`).
   */
  async restoreHere(taskId: string): Promise<TaskManifest> {
    const deps = this.#replicaDeps();
    if (deps === null) throw new Error("this node has no pool");
    if (this.#restoring.has(taskId)) throw new Error("task is being restored");
    // Reserved before the first await: the row says `archived` until the restore is done, and a restore-move of it
    // started meanwhile would take the task away from under it.
    this.#restoring.add(taskId);
    try {
      return await this.#restoreHereLocked(taskId, deps);
    } finally {
      this.#restoring.delete(taskId);
    }
  }

  /** `restoreHere`'s work, under the task's key; the caller holds the reservation. */
  async #restoreHereLocked(taskId: string, deps: ReplicaDeps): Promise<TaskManifest> {
    const self = deps.pool.identity.id;
    return serialised(taskKey(taskId), async () => {
      const row = this.#row(taskId);
      // A restore-move of it has started (its row still says `archived` until its `prepare` runs).
      if (this.#moving.has(taskId)) throw new Error("task is moving");
      if (row.state !== "archived") throw new Error(`task is ${row.state}`);
      if (row.archived_on !== self) throw new Error(`task is archived on ${shortId(row.archived_on ?? "another node")}`);
      const manifest = JSON.parse(row.manifest) as TaskManifest;
      const file = paths(this.#cfg).archiveFile(taskId);
      const archive = await readArchive(file);
      // What a node that stopped while archiving it left.
      await this.#clearLeftovers(manifest);
      let restored: TaskManifest;
      try {
        const parents: Record<string, string> = {};
        for (const p of manifest.projects) {
          const project = getProject(this.#db, p.id);
          if (project === null) throw new Error(`unknown project: ${p.id}`);
          parents[p.id] = await this.#takeLines(deps, project, taskId, p.name);
        }
        restored = await provisionFromManifest(this.#cfg, this.#db, manifest, parents, "idle", { keepRow: true });
        await unpackArchiveFiles(this.#cfg, taskId, archive);
        await adoptTranscriptSlot(this.#cfg, this.#db, restored);
        updateTask(this.#db, taskId, { state: "idle", archived_on: null, archived_at: null, manifest: JSON.stringify(restored) });
      } catch (err) {
        // Back to what an archived task has here: no folder, no workspace, no task bookmarks.
        await releaseFolder(this.#cfg, this.#db, taskId).catch(() => {});
        throw err;
      }
      holdLineRows(this.#db, self, taskId);
      await this.#applyProjects(deps, this.#row(taskId), "was restored");
      await rm(file, { force: true });
      this.#emitState(taskId, "idle");
      return restored;
    });
  }

  /**
   * Restores task `taskId`, archived on this node, on node `node` (spec 21.4): `"here"` or this node's id restores it
   * here (`restoreHere`); another node's id moves it there from its archive (a `meddle.move` with `fromArchive`, refused
   * first as `checkMove` says); null lets placement pick the node over the roster, as for a new task of the manifest's
   * projects (the primary's home first). Resolves with the node once the restore is done here, or once the move has
   * started (`onMove` and `onState` tell how it goes).
   */
  async restore(taskId: string, node: string | null): Promise<{ nodeId: string }> {
    const pool = this.#pool;
    if (pool === undefined) throw new Error("this node has no pool");
    const self = pool.identity.id;
    const row = this.#row(taskId);
    if (this.#restoring.has(taskId)) throw new Error("task is being restored");
    if (this.#moving.has(taskId)) throw new Error("task is moving");
    if (row.state !== "archived") throw new Error(`task is ${row.state}`);
    if (row.archived_on !== self) throw new Error(`task is archived on ${shortId(row.archived_on ?? "another node")}`);
    let target: string;
    if (node === "here" || node === self) target = self;
    else if (node !== null) {
      this.checkMove(row, node, false, true);
      target = node;
    } else {
      const manifest = JSON.parse(row.manifest) as TaskManifest;
      const ids = manifest.projects.map((p) => p.id);
      const primary = manifest.primaryProjectId;
      // Only nodes the restore-move could go to: placement never picks one `checkMove` then refuses (another or an
      // unknown Claude Code version, …). This node stays a candidate: a restore here is no move.
      const movable = (nodeId: string) => {
        try {
          this.checkMove(row, nodeId, false, true);
          return true;
        } catch {
          return false;
        }
      };
      target = await this.chooseNode(primary === null ? ids : [primary, ...ids.filter((id) => id !== primary)], movable);
    }
    if (target === self) {
      await this.restoreHere(taskId);
      return { nodeId: self };
    }
    await this.moveTo(taskId, target, false, true);
    return { nodeId: target };
  }

  /**
   * The node a task of `projectIds` (the first is the primary) goes to when none is named: `place` over every member
   * as the roster last heard of it and this node as it is now, leaving out the other nodes `accept` refuses. Refused
   * with placement's reason, or this node's own when no other node is online.
   */
  async chooseNode(projectIds: string[], accept: (nodeId: string) => boolean = () => true): Promise<string> {
    const pool = this.#pool;
    if (pool === undefined) throw new Error("this node has no pool");
    const self = {
      nodeId: pool.identity.id,
      hostsTasks: (await checkTaskRoot(this.#cfg)).ok,
      running: this.running(),
      taskCount: listLiveTasks(this.#db).length,
      projects: listProjects(this.#db).map((p) => ({ id: p.id, home: p.home })),
      limit: pool.settings.runningLimit(),
    };
    const nodes = placementCandidates(pool.store.roster(), (id) => pool.net.isOnline(id), self, (id) => pool.isGone(id))
      .filter((n) => n.nodeId === self.nodeId || accept(n.nodeId));
    const choice = place({ projectIds, nodes });
    if (!("error" in choice)) return choice.nodeId;
    // Alone (the only member, or the only one online): the reason is this node's own.
    if (!nodes.some((n) => n.online && n.nodeId !== self.nodeId)) {
      if (!self.hostsTasks) throw new Error("this node has no task root");
      if (self.limit > 0 && self.running >= self.limit) throw new Error("this node is at its running limit; use --here");
    }
    throw new Error(choice.error);
  }

  /**
   * Deletes task `taskId` from this node: only an `archived` or `moved` one (else `task is <state>`). What is left of its
   * folder goes first (an archive whose folder removal was cut short, a move whose cleanup has not run: the folder, the
   * workspaces and the task's bookmarks), then, with a pool, its bookmarks in each project's repo here and, for an
   * archived task (a moved one lives on elsewhere), its whole line: every row released (`releaseLineRows`), applied
   * here at once. No other node is asked anything. Then its archive (or a move's leftover), then its row, event log
   * and transcript rows.
   */
  async deleteTask(taskId: string): Promise<void> {
    await serialised(taskKey(taskId), async () => {
      const row = this.#row(taskId);
      if (this.#moving.has(taskId)) throw new Error("task is moving");
      if (row.state !== "archived" && row.state !== "moved") {
        throw new Error(`task is ${row.state}${row.state === "idle" ? "; only an archived task is deleted: archive it first" : ""}`);
      }
      const deps = this.#replicaDeps();
      const manifest = JSON.parse(row.manifest) as TaskManifest;
      if (deps !== null) {
        await releaseFolder(this.#cfg, this.#db, taskId);
        await this.#releaseTask(deps, manifest, row.state === "archived");
      } else await this.#clearLeftovers(manifest);
      const p = paths(this.#cfg);
      await rm(p.archiveFile(taskId), { force: true });
      await rm(p.movedFile(taskId), { force: true });
      deleteTask(this.#db, taskId, row.session_id);
      this.#forgetAcceptance(taskId);
      // Told with the state it had: whoever lists this node's tasks reads them again.
      this.#emitState(taskId, row.state as TaskState);
    });
  }

  /**
   * What `deleteTask` takes off the projects' repos, with a pool: the task's bookmarks in each, and, with `release`, its
   * line (`releaseLineRows`), applied here at once.
   */
  async #releaseTask(deps: ReplicaDeps, manifest: TaskManifest, release: boolean): Promise<void> {
    const taskId = manifest.id;
    for (const p of manifest.projects) {
      if (getProject(this.#db, p.id) === null) continue;
      await this.#forgetBookmarks(p.replica, taskId).catch(() => {});
      if (!release) continue;
      releaseLineRows(this.#db, taskId, [], p.id);
      // Its released rows applied here now: the line's refs (and its base's) go at once, not at the applier's next pass.
      await applyProject(deps, p.id, APPLY_AT_TURN_END_MS).catch((err: unknown) => {
        this.#log(`meddle: apply: project ${shortId(p.id)} as ${taskId} was deleted failed: ${messageOf(err)}`);
      });
    }
  }

  // ─── accepting a task's work ───

  /**
   * Whether task `taskId`'s work is accepted (`acceptance`), as this node, its holder, last checked: `"partly"` when a
   * branch contains the lines of some of its projects only. `"no"` for a task never checked here.
   */
  acceptance(taskId: string): Acceptance {
    return this.#acceptance.get(taskId) ?? "no";
  }

  /** Called whenever what `acceptance` answers for a task changes. */
  onAcceptance(cb: (taskId: string, acceptance: Acceptance) => void): () => void {
    this.#acceptanceListeners.add(cb);
    return () => { this.#acceptanceListeners.delete(cb); };
  }

  /**
   * Checks the acceptance of each live task here whose project's branch rows change (`branchChanges`: a push here or on
   * another node), of a task whose own line rows change (`lineChanges`), and of every live task here once, now.
   */
  #watchAcceptance(): void {
    if (this.#stopAcceptance !== undefined || this.#closed) return;
    const live = (): TaskRow[] => {
      try {
        return listLiveTasks(this.#db);
      } catch {
        return []; // a closed database: the node has stopped
      }
    };
    const stopBranches = branchChanges.subscribe((projectId) => {
      this.#branchVersions.set(projectId, (this.#branchVersions.get(projectId) ?? 0) + 1);
      for (const row of live()) if (manifestNames(row, projectId)) this.#checkAcceptance(row.id);
    });
    const stopLines = lineChanges.subscribe(({ task }) => {
      let row: TaskRow | null;
      try {
        row = getTask(this.#db, task);
      } catch {
        return;
      }
      if (row !== null && row.state !== "moved" && row.state !== "receiving" && row.state !== "archived") this.#checkAcceptance(task);
    });
    this.#stopAcceptance = () => {
      stopBranches();
      stopLines();
    };
    for (const row of live()) this.#checkAcceptance(row.id);
  }

  /** Project `projectId`'s branches as the current version of its branch rows computes them (`branchTips`), cached. */
  #tipsOf(deps: ReplicaDeps, projectId: string): Promise<BranchTips> {
    const version = this.#branchVersions.get(projectId) ?? 0;
    const cached = this.#tips.get(projectId);
    if (cached !== undefined && cached.version === version) return cached.tips;
    const tips = branchTips(deps, projectId);
    const entry = { version, tips };
    this.#tips.set(projectId, entry);
    const drop = () => { if (this.#tips.get(projectId) === entry) this.#tips.delete(projectId); };
    // A reading that lacked a commit (or failed) is read again next time: the commit may have come since.
    tips.then((t) => { if (t.error !== null) drop(); }, drop);
    return tips;
  }

  /**
   * Checks whether task `taskId`'s work is accepted (`#acceptOnce`), once the write that asked for it is done: one check
   * per task at a time, and one more after it when asked for meanwhile (its own archive's row writes ask for one, which
   * finds the task archived). A failure is logged (`meddle: accept: …`).
   */
  #checkAcceptance(taskId: string): void {
    if (this.#pool === undefined || this.#closed) return;
    const running = this.#acceptChecks.get(taskId);
    if (running !== undefined) {
      running.again = true;
      return;
    }
    const check = { again: true };
    this.#acceptChecks.set(taskId, check);
    void (async () => {
      while (check.again && !this.#closed) {
        check.again = false;
        // Never inside the write that asked for it (rows are written in transactions): after it.
        await Promise.resolve();
        try {
          await this.#acceptOnce(taskId);
        } catch (err) {
          this.#log(`meddle: accept: could not check whether ${taskId}'s work is accepted: ${messageOf(err)}`);
        }
      }
      this.#acceptChecks.delete(taskId);
    })();
  }

  /**
   * Checks task `taskId`'s acceptance (`acceptanceOf`) when it is live here and neither moving nor being archived, and
   * records it. A task accepted, and idle with nothing queued, is archived with its lines released (`#archive`); one
   * mid-turn is checked again as its turn ends (`#turnState`). A check that lacked a commit a row names is made again
   * `ACCEPT_RETRY_MS` later.
   */
  async #acceptOnce(taskId: string): Promise<void> {
    const deps = this.#replicaDeps();
    const checkable = (row: TaskRow | null): row is TaskRow =>
      row !== null && (row.state === "idle" || row.state === "running" || row.state === "waiting")
      && !this.#isMoving(row) && !this.#archiving.has(taskId);
    const row = getTask(this.#db, taskId);
    if (deps === null || !checkable(row)) return;
    const manifest = JSON.parse(row.manifest) as TaskManifest;
    if (manifest.projects.length === 0) return;
    const { verdict, pending } = await acceptanceOf(deps, manifest, (id) => this.#tipsOf(deps, id));
    const now = getTask(this.#db, taskId);
    if (this.#closed || !checkable(now)) return;
    this.#setAcceptance(taskId, verdict);
    if (pending === null) {
      this.#acceptPending.delete(taskId);
      this.#acceptPendingLogged.delete(taskId);
    } else if (!this.#acceptPending.has(taskId)) this.#acceptPending.add(taskId);
    else if (!this.#acceptPendingLogged.has(taskId)) {
      // Still lacking after a retry: said once per task, until a check lacks nothing.
      this.#acceptPendingLogged.add(taskId);
      this.#log(`meddle: accept: whether ${taskId}'s work is accepted is not known yet: ${pending}`);
    }
    if (pending !== null && !this.#acceptRetries.has(taskId)) {
      const timer = setTimeout(() => {
        this.#acceptRetries.delete(taskId);
        this.#checkAcceptance(taskId);
      }, ACCEPT_RETRY_MS);
      timer.unref?.();
      this.#acceptRetries.set(taskId, timer);
    }
    if (verdict !== "accepted") return;
    try {
      this.#refuseArchive(now);
    } catch {
      return; // mid-turn, or prompts queued: checked again as its turn ends
    }
    if ((await this.#durableTurn(taskId)) !== undefined) {
      // A failed turn left idle while the Harness still holds it: checked again once it is gone.
      this.#awaitTurnGone(taskId);
      return;
    }
    try {
      await this.#archive(taskId, true);
    } catch (err) {
      this.#log(`meddle: accept: ${taskId}'s work is accepted, but the task was not archived: ${messageOf(err)}`);
    }
  }

  /**
   * Checks task `taskId`'s acceptance again once the Harness no longer holds a turn of it, looking every
   * `ACCEPT_TURN_POLL_MS` while the task stays idle here (a turn that starts again checks at its own end).
   */
  #awaitTurnGone(taskId: string): void {
    if (this.#acceptTurnWaits.has(taskId)) return;
    this.#acceptTurnWaits.add(taskId);
    void (async () => {
      try {
        while (!this.#closed && getTask(this.#db, taskId)?.state === "idle") {
          if ((await this.#durableTurn(taskId)) === undefined) {
            this.#checkAcceptance(taskId);
            return;
          }
          await Bun.sleep(ACCEPT_TURN_POLL_MS);
        }
      } catch {
        // A closed node: nothing to check.
      } finally {
        this.#acceptTurnWaits.delete(taskId);
      }
    })();
  }

  /** Drops what this node knows of task `taskId`'s acceptance: it is archived, moved away or deleted. */
  #forgetAcceptance(taskId: string): void {
    this.#setAcceptance(taskId, "no");
    clearTimeout(this.#acceptRetries.get(taskId));
    this.#acceptRetries.delete(taskId);
    this.#acceptPending.delete(taskId);
    this.#acceptPendingLogged.delete(taskId);
  }

  /** Records task `taskId`'s acceptance, and tells the listeners when it changed (`"no"` is kept as none). */
  #setAcceptance(taskId: string, verdict: Acceptance): void {
    if (this.acceptance(taskId) === verdict) return;
    if (verdict === "no") this.#acceptance.delete(taskId);
    else this.#acceptance.set(taskId, verdict);
    notify(this.#acceptanceListeners, (cb) => cb(taskId, verdict));
  }

  // ─── moving a task to another node ───

  /**
   * Starts moving task `taskId` to node `to` (a durable `meddle.move`); with `now`, a live turn is interrupted rather
   * than waited for; with `fromArchive`, the task archived here is restored there from its archive (`restore`). Refused, before anything starts, as `checkMove` says, or when the task's turn is parked. Resolves
   * once the move has started; `onMove` and `onState` tell how it goes.
   */
  async moveTo(taskId: string, to: string, now: boolean, fromArchive = false): Promise<void> {
    const row = this.#row(taskId);
    this.checkMove(row, to, false, fromArchive);
    // Reserved before the first await: one move per task.
    const reservation: MoveState = { to, phase: "prepare", error: null };
    this.#moving.set(taskId, reservation);
    try {
      const turn = await this.#durableTurn(taskId);
      if (turn !== undefined && isParked(turn)) throw new Error("the task's turn is parked; retry it first");
      const input: MoveInput = { taskId, to, now, ...(fromArchive ? { fromArchive: true } : {}) };
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
   * member, offline or hosts no tasks, or the two report different or unknown Claude Code versions. With
   * `fromArchive` (a restore-move) it is the other way round: the task must be archived here, or (`own`, a rerun of
   * `prepare`) moving with its row still naming this node as where it is archived.
   */
  checkMove(row: TaskRow, to: string, own = false, fromArchive = false): void {
    refuseReceiving(row);
    refuseMoved(row);
    if (fromArchive) {
      const self = this.#pool?.identity.id;
      // `prepare` runs again after it marked the task moving (a restart before its checkpoint).
      const rerun = own && row.state === "moving" && row.archived_on !== null && row.archived_on === self;
      if (!rerun) {
        if (row.state !== "archived") throw new Error(`task is ${row.state}`);
        if (row.archived_on !== self) throw new Error(`task is archived on ${shortId(row.archived_on ?? "another node")}`);
      }
      // Only the move's own steps pass a reservation: an archive still finishing, or another move.
      if (!own && this.#archiving.has(row.id)) throw new Error("task is being archived");
      if (!own && this.#restoring.has(row.id)) throw new Error("task is being restored");
      if (!own && this.#isMoving(row)) throw new Error("task is moving");
    } else {
      if (row.state === "archived") throw new Error(`task is archived: ${row.id}`);
      if (this.#archiving.has(row.id)) throw new Error("task is being archived");
      if (!own && this.#isMoving(row)) throw new Error("task is moving");
    }
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
  moveDeps(): {
    cfg: NodeConfig; db: Database; pool: PoolRuntime; log(line: string): void; callMs: number | undefined; hooks: RunnerHooks | undefined;
  } {
    if (this.#pool === undefined) throw new Error("this node has no pool");
    return { cfg: this.#cfg, db: this.#db, pool: this.#pool, log: this.#log, callMs: this.#deps.hooks?.callMs, hooks: this.#deps.hooks };
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
      // `hurryMove` turns a move that waits into a "move now" while it waits.
      if ((interrupt || this.#hurried.has(taskId)) && live !== undefined && (cutting === live.query || !live.queue.ended)) {
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
   * Cancels the task's move, which then ends with the task live here (or archived here again, for a restore-move), its
   * turn untouched, and anything sent to the target dropped there. Only while the move waits for the turn or hands the
   * task over: once the target holds the whole task (`commit`) it is refused, and a move that got there meanwhile
   * completes (refused afterwards with where the task went).
   */
  async cancelMove(taskId: string): Promise<void> {
    const move = this.#moving.get(taskId);
    if (move === undefined) throw new Error("task is not moving");
    if (move.phase !== "prepare" && move.phase !== "handoff") {
      throw new Error(`too late to cancel: ${shortId(move.to)} has the task and is taking it over`);
    }
    const { tasks } = await this.#harness.inspect(BACKGROUND_CONTEXT);
    const record = tasks.find(
      (t) => t.record.kind === MeddleMove.definition.name && (t.record.input as MoveInput).taskId === taskId && t.record.state.status !== "terminal",
    );
    if (record === undefined) throw new Error("task is not moving");
    this.#cancelling.add(taskId);
    try {
      await this.#harness.abortTask(record.record.id, BACKGROUND_CONTEXT);
    } catch (err) {
      this.#cancelling.delete(taskId);
      throw err;
    }
    if (getTask(this.#db, taskId)?.state === "moved") throw new Error(`too late to cancel: the task moved to ${shortId(move.to)}`);
  }

  /** Whether the move being aborted was cancelled (`cancelMove`); forgets it. For `meddle.move`'s `abort`. */
  takeCancel(taskId: string): boolean {
    return this.#cancelling.delete(taskId);
  }

  /**
   * Makes the task's move, while it waits for the running turn to end, interrupt that turn instead ("move now"):
   * refused once the move is past waiting.
   */
  hurryMove(taskId: string): void {
    const move = this.#moving.get(taskId);
    if (move === undefined) throw new Error("task is not moving");
    if (move.phase !== "prepare") throw new Error("the move is no longer waiting for the turn");
    this.#hurried.add(taskId);
  }

  /**
   * The task now lives on `to`: its row says `moved` and where (its queue went with it), it is no longer moving, and
   * that is told.
   */
  completeMove(taskId: string, to: string): void {
    updateTask(this.#db, taskId, { state: "moved", moved_to: to, queued: null });
    // Its acceptance is the node it went to's to tell.
    this.#forgetAcceptance(taskId);
    this.#moving.delete(taskId);
    this.#hurried.delete(taskId);
    this.#cancelling.delete(taskId);
    this.#emitState(taskId, "moved");
    this.#emitMove(taskId);
  }

  /**
   * Ends a move that did not happen: the task is live here again (idle, or its turn's state), the prompts queued
   * meanwhile run, and the failure is logged once and told (`onMove` with the error, then null). A restore-move's task
   * is archived here again instead. A move that got to `commit` (the target may have activated the task, and so taken
   * its lines one epoch up) takes the task's line rows back above any epoch the target could have written
   * (`reclaimLineRows`); before it, the target wrote none.
   */
  async failMove(taskId: string, to: string, phase: string, error: string | null): Promise<void> {
    // First, before anything that can throw: the row must never be left `moving` with no move behind it (nor be written
    // `idle` over a turn this runner knows is live).
    const row = getTask(this.#db, taskId);
    const restore = row !== null && row.state !== "moved";
    if (restore) updateTask(this.#db, taskId, { state: this.#knownState(taskId) });
    const pool = this.#pool;
    if (restore && phase === "commit" && pool !== undefined) {
      try {
        reclaimLineRows(this.#db, pool.identity.id, taskId, row.archived_on !== null);
      } catch (err) {
        this.#log(`meddle: move: ${taskId}'s lines were not taken back from ${shortId(to)}: ${messageOf(err)}`);
      }
    }
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
    this.#hurried.delete(taskId);
    this.#log(error === null ? `meddle: move: ${taskId} to ${shortId(to)} cancelled at ${phase}` : `meddle: move: ${taskId} failed at ${phase}: ${error}`);
    this.startQueued(taskId).catch((err: unknown) => {
      this.#log(`meddle: move: task ${taskId}'s next queued prompt did not start a turn: ${messageOf(err)}`);
    });
  }

  /**
   * The state of the task's turn as this runner alone knows it (live or pending), without asking the Harness; with
   * none, `archived` for a task archived here (a restore-move's), else `idle`.
   */
  #knownState(taskId: string): "idle" | "running" | "waiting" | "archived" {
    return this.#live.get(taskId)?.state ?? (this.#pending.has(taskId) ? "running" : this.#restingState(taskId));
  }

  /**
   * Writes the state the task's turn has, if any (`running` for one between its phases), else `archived` for a task
   * archived here (a restore-move's), else `idle`.
   */
  async #restoreState(taskId: string): Promise<void> {
    const live = this.#live.get(taskId);
    const busy = live !== undefined || this.#pending.has(taskId) || (await this.#durableTurn(taskId)) !== undefined;
    this.#setState(taskId, live?.state ?? (busy ? "running" : this.#restingState(taskId)));
  }

  /** A task's state with no turn: `archived` when its row says where it is archived, else `idle`. */
  #restingState(taskId: string): "idle" | "archived" {
    return getTask(this.#db, taskId)?.archived_on != null ? "archived" : "idle";
  }

  #isMoving(row: TaskRow): boolean {
    return this.#moving.has(row.id) || row.state === "moving";
  }

  /** Refuses what only a task live here takes (interrupt, retry, settings): received, moved, archived and moving tasks. */
  #refuseElsewhere(taskId: string): void {
    const row = this.#row(taskId);
    refuseReceiving(row);
    refuseMoved(row);
    if (row.state === "archived") throw new Error(`task is archived: ${taskId}`);
    if (this.#isMoving(row)) throw new Error("task is moving");
  }

  #emitMove(taskId: string): void {
    const move = this.#moving.get(taskId) ?? null;
    notify(this.#moveListeners, (cb) => cb(taskId, move === null ? null : { ...move }));
  }

  /** What the replica and memory functions need, or null without a pool. */
  #replicaDeps(): ReplicaDeps | null {
    return this.#pool === undefined ? null : { cfg: this.#cfg, db: this.#db, pool: this.#pool, log: this.#log };
  }

  /** After the turn's terminal commit: count it and make the task idle. Not for callers outside this module. */
  completeTurn(taskId: string): void {
    updateTask(this.#db, taskId, { turns: this.#row(taskId).turns + 1 });
    this.#turnState(taskId, "idle");
    this.startQueued(taskId).catch((err: unknown) => {
      this.#log(`meddle: move: task ${taskId}'s next queued prompt did not start a turn: ${messageOf(err)}`);
    });
  }

  /**
   * The `abort` phase of `meddle.turn`; not for callers outside this module. An abort between a `token_fault` that
   * reruns the turn and the rerun's `turn_started` leaves no `turn_aborted` from `runTurn`: one is logged here, so the
   * task's next new turn is not taken for that rerun (and sent `TOKEN_RETRY_PROMPT` in place of its own prompt).
   */
  abortTurnPhase(taskId: string, freshAfter = 0): void {
    if (lastTurnCutOff(this.#db, taskId, freshAfter) === "token") {
      try {
        this.#record(taskId, { type: "meddle", subtype: "turn_aborted", at: new Date().toISOString() });
      } catch (err) {
        this.#log(`meddle: could not log the abort of task ${taskId}'s turn: ${messageOf(err)}`);
      }
    }
    this.#primaries.delete(taskId);
    this.#live.get(taskId)?.query.close();
    // No `finish` follows: a write its tool calls scheduled would land after whatever comes next (a move's).
    void this.#dropScheduledLines(taskId);
    this.#turnState(taskId, "idle");
  }

  /**
   * A turn path's state change: written and told, except while the task moves (the row says `moving`, and the move is
   * told the turn ended instead). An `idle` is the end of the turn.
   */
  #turnState(taskId: string, state: "idle" | "running" | "waiting"): void {
    if (!this.#isMoving(this.#row(taskId))) this.#setState(taskId, state);
    if (state === "idle") {
      this.#turnOver(taskId);
      // A task whose work was accepted mid-turn is archived now, if it still is.
      this.#checkAcceptance(taskId);
    }
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
    // No `finish` follows: a write its tool calls scheduled would land after whatever comes next (a move's).
    void this.#dropScheduledLines(taskId);
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
    // A project's meddle context is the one captured at the task's start, from the task's row: not `task.json` nor the
    // workspace, which its agent can edit. The row alone names the projects, their workspaces and their contexts; a
    // project `task.json` names that the row lacks fails the turn.
    // Claude Code settings are the workspace's, as Claude Code itself reads them.
    const workspaceOf = (p: TaskManifest["projects"][number]) => join(paths(this.#cfg).task(manifest.id), p.workspace);
    const own = (JSON.parse(this.#row(taskId).manifest) as TaskManifest).projects;
    for (const p of manifest.projects) {
      if (!own.some((o) => o.id === p.id)) throw new Error(`task.json names project ${p.id}, which is not one of the task's`);
    }
    const contexts = [];
    for (const p of own) {
      contexts.push(parseContext(p.context));
    }
    const projectSettings = [];
    if (manifest.projects.length > 1) {
      for (const p of manifest.projects) projectSettings.push(await loadProjectSettings(workspaceOf(p)));
    }
    const input: Omit<EngineInput, "prompt" | "canUseTool" | "onPermissionDenied"> = {
      cfg: this.#cfg,
      manifest,
      contexts: withTaskRules(contexts, taskId),
      projectSettings,
      token,
      sessionStore: this.#sessionStore,
      resume,
    };
    // With a pool, the task's lines follow its agent's work (`#filesChanged`).
    if (this.#pool !== undefined) input.onFilesChanged = () => this.#filesChanged(taskId);
    const chosen = getTaskSettings(this.#db, taskId);
    const { permissionMode } = chosen;
    const model = chosen.model ?? this.#pool?.settings.defaultModel() ?? undefined;
    const effort = chosen.effort ?? this.#pool?.settings.defaultEffort() ?? undefined;
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
    // A state change goes with a queue that travelled, arrived or was dropped (a move, an archive).
    this.#emitQueued(taskId);
  }
}

/** Whether task `row`'s manifest names project `projectId`. */
function manifestNames(row: TaskRow, projectId: string): boolean {
  try {
    return (JSON.parse(row.manifest) as TaskManifest).projects.some((p) => p.id === projectId);
  } catch {
    return false;
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
  token: { id: string; label: string } | null, fault: TokenFault | { kind: "none" }, rerun: boolean, retried = false,
): MeddleEvent {
  return {
    type: "meddle", subtype: "token_fault", at: new Date().toISOString(),
    tokenId: token?.id ?? null, label: token?.label ?? null, fault, rerun, ...(retried ? { retried: true as const } : {}),
  };
}

/** A token mark's detail from what the SDK said: kept when a peer would accept it (short, no control characters). */
function markDetail(s: string | null): string | null {
  return s !== null && s.length <= 256 && !/[\x00-\x1f\x7f-\x9f]/.test(s) ? s : null;
}

function isParked(turn: TaskInspection): boolean {
  return turn.state.kind === "blocked" && turn.state.reason === "restart_limit";
}
