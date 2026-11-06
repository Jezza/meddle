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
import { bookmarkForget, bookmarkList, bookmarkSet, changeId } from "../jj";
import { checkTaskRoot, paths } from "../paths";
import { shortId } from "../pool/ids";
import { dedupe } from "../pool/report";
import type { PoolRuntime } from "../pool/runtime";
import { loadContext, loadProjectSettings } from "../projects/context";
import { syncMemoryAfter, syncMemoryBefore } from "../projects/memory-sync";
import type { StreamReader } from "../pool/frames";
import { getProject, listProjects, type Project } from "../projects/project";
import { fetchLines, giveBackLines, holdLines, releaseOnHome, writeLines } from "../projects/lines";
import { ensureReplica, fetchSync, type ReplicaDeps } from "../projects/replicas";
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
import { readArchive, unpackArchiveFiles, writeArchive } from "./archive";
import { readManifest, taskGlob, taskNamespace, transcriptPath, writeManifest, type ReceivedManifest, type Start, type TaskManifest } from "./manifest";
import { MeddleMove, releaseFolder, type MoveInput } from "./move";
import { checkReceivedManifest, dropWorkspace, provisionFromManifest, provisionTask, SAFE_ID, scopeIfUnscoped } from "./provision";
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
   * The node's pool. With it, tasks replicate projects homed elsewhere, start where their homes resolve, push their
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
    runner.abortTurnPhase(task.input.taskId, task.input.freshAfter ?? 0);
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
  },
});

type LiveTurn = { query: Query; queue: InputQueue; state: "running" | "waiting" };

/** How long a turn interrupted by a "move now" has to end before it is closed. */
const INTERRUPT_GRACE_MS = 15_000;

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
  /** Woken whenever a turn of the task ends (completed, failed or aborted): a move waits for it. */
  #turnWaiters = new Map<string, Set<() => void>>();
  /** Tasks being archived: until the row says `archived`, no turn or move of them starts. */
  #archiving = new Set<string>();
  /** Tasks being restored here (`restoreHere`): no restore-move of them starts meanwhile. */
  #restoring = new Set<string>();
  /** Tasks whose last write of their line failed: written again when the home comes online (`#pushAgain`). */
  #unpushed = new Set<string>();

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
    this.scopeUnscoped().catch((err: unknown) => this.#log(`meddle: could not scope the workspaces of older tasks: ${messageOf(err)}`));
    if (this.#pool !== undefined) {
      this.#watchHomes(this.#pool);
      this.#sweepOrphans();
    }
  }

  /**
   * Scopes every workspace of each live task here that has no scope of its own (`scopeIfUnscoped`): a task made before
   * meddle scoped its workspaces, whose agent jj's default `immutable_heads()` would forbid its own work once a turn end
   * writes it to the task's line. Runs as the runner starts, each task under its key; a workspace that fails is logged.
   */
  async scopeUnscoped(): Promise<void> {
    for (const { id } of listLiveTasks(this.#db)) {
      await serialised(taskKey(id), async () => {
        const row = getTask(this.#db, id);
        if (row === null || row.state === "moved" || row.state === "receiving" || row.state === "archived") return;
        let projects: ReceivedManifest["projects"];
        try {
          projects = (JSON.parse(row.manifest) as ReceivedManifest).projects ?? [];
        } catch {
          return;
        }
        for (const p of projects) {
          const workspace = join(paths(this.#cfg).task(id), p.workspace);
          try {
            if (await scopeIfUnscoped(this.#cfg, workspace, id, p.base)) this.#log(`meddle: scoped the workspace ${workspace} of the older task ${id} to its line`);
          } catch (err) {
            this.#log(`meddle: could not scope the workspace ${workspace} of task ${id}: ${messageOf(err)}`);
          }
        }
      });
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
    this.#watchHomes(pool);
    this.#sweepOrphans();
  }

  /**
   * Provisions task `taskId` (with no project, or several) from the starts its projects' homes resolved (`startAt`),
   * in order, the first the primary. With a pool, each project is first replicated here when it is homed elsewhere and
   * unknown (cloned from its home); a `line` start on a project homed elsewhere fetches the task's line from the home
   * (`fetchLines`), which brings its commit; a `sync` start takes the commit `fetchSync` gives (the copy fetched last
   * when the home is offline). Refused for an id that is not one path segment, or that a task here already has.
   */
  async create(input: { title: string; taskId: string; starts: Start[] }): Promise<TaskManifest> {
    const { taskId, starts } = input;
    if (!SAFE_ID.test(taskId)) throw new Error(`invalid task id: ${taskId}`);
    if (getTask(this.#db, taskId) !== null) throw new Error(`task ${taskId} exists here`);
    if ((await pickToken(this.#cfg, this.#db)) === null) throw new Error("no usable token");
    const deps = this.#replicaDeps();
    /** Commits of the sync starts, by project. */
    const synced: Record<string, string> = {};
    /** The replicas the task's line was fetched into: forgotten there again when the create fails. */
    const fetched: string[] = [];
    let manifest: TaskManifest;
    try {
      for (const start of starts) {
        const project = deps === null ? getProject(this.#db, start.projectId) : await ensureReplica(deps, start.projectId);
        if (project === null) throw new Error(`unknown project: ${start.projectId}`);
        if (start.kind === "sync") {
          if (deps === null) throw new Error(`${project.name}: a sync start needs the pool`);
          synced[start.projectId] = await fetchSync(deps, project, start.branch);
        } else if (deps !== null && project.home !== deps.pool.identity.id) {
          fetched.push(project.replica);
          const lines = await fetchLines(this.#cfg, project.replica, project, project.home, taskId, "home");
          if (!lines.some((l) => l.name === project.name && l.commitId === start.commit)) {
            throw new Error(`the line of ${project.name} on ${shortId(project.home)} is not at ${start.commit.slice(0, 12)}`);
          }
        }
      }
      manifest = await provisionTask(this.#cfg, this.#db, { title: input.title, taskId, starts, synced });
    } catch (err) {
      for (const replica of fetched) await this.#forgetBookmarks(replica, taskId).catch(() => {});
      throw err;
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
    updateTaskSettings(this.#db, taskId, { permissionMode: mode });
  }

  /** Switches the live turn's model, if any, and keeps it for the task's later turns; none is the default. */
  async setModel(taskId: string, model?: string): Promise<void> {
    this.#refuseElsewhere(taskId);
    await this.liveQuery(taskId)?.setModel(model);
    updateTaskSettings(this.#db, taskId, { model });
  }

  /**
   * Renames the task: its row (title and manifest) and the manifest in its folder. Refused while it is not live here
   * (moving, moved, being received or archived) and for a blank title. Answers the new manifest.
   */
  async rename(taskId: string, title: string): Promise<TaskManifest> {
    const trimmed = title.trim();
    if (trimmed === "") throw new Error("a task's title cannot be blank");
    this.#refuseElsewhere(taskId);
    const manifest: TaskManifest = { ...(JSON.parse(this.#row(taskId).manifest) as TaskManifest), title: trimmed };
    await writeManifest(this.#cfg, manifest);
    updateTask(this.#db, taskId, { title: trimmed, manifest: JSON.stringify(manifest) });
    notify(this.#manifestListeners, (cb) => cb(taskId, manifest));
    return manifest;
  }

  onManifest(cb: (taskId: string, manifest: TaskManifest) => void): () => void {
    this.#manifestListeners.add(cb);
    return () => { this.#manifestListeners.delete(cb); };
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
   * The `finish` phase of `meddle.turn`: moves the task's bookmarks; with a pool, writes the task's line on each
   * project's home and gives back what the task no longer keeps (`#pushLinesOf`), and syncs the primary project's
   * memory, unless another task of that project is live here (decision 15: the last of them to end commits for all). A
   * failed write or sync is logged, never thrown: the turn completed, a write is made again when the home comes online,
   * and the next turn end tries again. Not for callers outside this module.
   */
  async finishTurnPhase(taskId: string, context: Context): Promise<void> {
    try {
      let manifest: TaskManifest;
      try {
        manifest = await readManifest(this.#cfg, taskId);
        await this.setTaskBookmarks(manifest);
      } catch (err) {
        this.#failTurn(taskId, context);
        throw err;
      }
      const deps = this.#replicaDeps();
      if (deps === null) return;
      await this.#pushLinesOf(deps, manifest, true);
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
      // Not under a write of the line from the same repo (`holdLines` takes the same key). Without a snapshot: on the
      // home, the replica is the user's own checkout.
      await serialised(repoKey(p.replica), () => bookmarkSet(p.replica, bookmark, change, this.#cfg, { ignoreWorkingCopy: true }));
    }
  }

  /**
   * Writes task `taskId`'s line from its bookmarks here to each project's home (`holdLines`: on the home itself, the
   * home repo's line; elsewhere a forced push): what a turn end writes, and what a move writes as it begins (its caller
   * sets the bookmarks first). Nothing without a pool, or for a task whose row is gone, `receiving` or `moved`: a former
   * holder never writes over its receiver's newer line. A failed write is logged as `meddle: push: …` and made again
   * when that home comes online.
   */
  async pushTaskLines(taskId: string): Promise<void> {
    const deps = this.#replicaDeps();
    const row = getTask(this.#db, taskId);
    if (deps === null || row === null) return;
    await this.#pushLinesOf(deps, JSON.parse(row.manifest) as TaskManifest, false);
  }

  /**
   * `pushTaskLines` of `manifest`'s task, and with `giveBack` (a turn end), for each project whose write went through,
   * the release on the home of what the task no longer keeps (`giveBackLines`; a failure is logged as
   * `meddle: give back: …`). The task is remembered while a write of it has failed (`#unpushed`), and forgotten once one
   * writes every project.
   */
  async #pushLinesOf(deps: ReplicaDeps, manifest: TaskManifest, giveBack: boolean): Promise<void> {
    const taskId = manifest.id;
    const state = getTask(this.#db, taskId)?.state;
    if (state === undefined || state === "receiving" || state === "moved") {
      this.#unpushed.delete(taskId);
      return;
    }
    const self = deps.pool.identity.id;
    let failed = false;
    for (const p of manifest.projects) {
      const project = getProject(this.#db, p.id);
      if (project === null || project.home === "") continue;
      const { home } = project;
      try {
        if (home !== self && !deps.pool.net.isOnline(home)) throw new Error(`home ${shortId(home)} is offline`);
        await holdLines(this.#cfg, self, p.replica, project, taskId);
      } catch (err) {
        failed = true;
        this.#log(`meddle: push: ${taskNamespace(taskId)}* to ${shortId(home)} failed: ${messageOf(err)}`);
        continue;
      }
      if (!giveBack) continue;
      await giveBackLines(deps, p.replica, project, taskId, p.name).catch((err: unknown) => {
        this.#log(`meddle: give back: ${taskNamespace(taskId)}* on ${shortId(home)} failed: ${messageOf(err)}`);
      });
    }
    if (failed) this.#unpushed.add(taskId);
    else this.#unpushed.delete(taskId);
  }

  /**
   * Once home `home` comes online: writes again the line of each task whose last write failed and that has a project
   * homed there (`pushTaskLines`), unless it is moving (the move writes it) or gone from this node.
   */
  async #pushAgain(home: string): Promise<void> {
    for (const taskId of [...this.#unpushed]) {
      const row = getTask(this.#db, taskId);
      if (row === null) {
        this.#unpushed.delete(taskId);
        continue;
      }
      if (this.#isMoving(row)) continue;
      const manifest = JSON.parse(row.manifest) as TaskManifest;
      if (!manifest.projects.some((p) => getProject(this.#db, p.id)?.home === home)) continue;
      await this.pushTaskLines(taskId);
    }
  }

  /**
   * Writes a task's line again when one of its homes comes online (`#pushAgain`). Which writes failed before this
   * runner started is not known: every live task with a project homed on another node is written again when that home
   * comes online, as if its last write had failed.
   */
  #watchHomes(pool: PoolRuntime): void {
    const self = pool.identity.id;
    const elsewhere = (projectId: string) => {
      const home = getProject(this.#db, projectId)?.home ?? "";
      return home !== "" && home !== self;
    };
    for (const row of listLiveTasks(this.#db)) {
      if (((JSON.parse(row.manifest) as Partial<TaskManifest>).projects ?? []).some((p) => elsewhere(p.id))) this.#unpushed.add(row.id);
    }
    pool.net.onPeer((peer, online) => {
      if (!online) return;
      this.#pushAgain(peer).catch((err: unknown) => this.#log(`meddle: push: could not push again to ${shortId(peer)}: ${messageOf(err)}`));
    });
  }

  /**
   * Before a move's handoff: sets the task's bookmarks (`setTaskBookmarks`) and, for each project homed on this node,
   * writes its line (`writeLines`), which the target fetches: this node serves the target the home's line. Throws when
   * such a write fails: the target would fetch an older line.
   */
  async setHandoffBookmarks(manifest: TaskManifest): Promise<void> {
    const self = this.#pool?.identity.id;
    await this.setTaskBookmarks(manifest);
    for (const p of manifest.projects) {
      if (self === undefined || getProject(this.#db, p.id)?.home !== self) continue;
      await writeLines(this.#cfg, p.replica, manifest.id);
    }
  }

  // ─── receiving a moved task ───

  /**
   * Prepares to receive task `manifest.id` from node `from`: refused unless both report the same, known Claude Code
   * version, this node hosts tasks and has a pool, and no other copy of the task is here (a partial one still being
   * received from `from` is abandoned first: the sender's handoff ran again). Replicates each project (from its home),
   * fetches the task's bookmarks from `from` (`#fetchLine`), and provisions the task at the fetched commits as
   * `receiving`.
   */
  async receiveTask(manifest: ReceivedManifest, from: string, version: string): Promise<{ ok: true } | { ok: false; reason: string }> {
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
      /** The replicas this receive fetched the task's bookmarks into: forgotten there again when it fails. */
      const fetched: string[] = [];
      try {
        const parents: Record<string, string> = {};
        for (const p of manifest.projects) {
          const project = await ensureReplica(deps, p.id);
          fetched.push(project.replica);
          parents[p.id] = await this.#fetchLine(project, from, taskId, p.name);
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
   * Fetches task `taskId`'s bookmarks from node `from` into the project's replica here, as its local bookmarks under the
   * task's namespace (`fetchLines`, which drops the ones `from` does not have): from the project's home, the task's
   * line, or failing that the home repo's own bookmarks of the task (where an older meddle kept a task archived before
   * lines); from another node, that holder's own bookmarks. The project's bookmark `meddle/task/<id>/<name>` must be
   * there (else `bookmark <b> not found on <short>`). Its commit.
   */
  async #fetchLine(project: Project, from: string, taskId: string, name: string): Promise<string> {
    const fromHome = from === project.home;
    let lines = await fetchLines(this.#cfg, project.replica, project, from, taskId, fromHome ? "home" : "holder");
    if (fromHome && !lines.some((l) => l.name === name)) lines = await fetchLines(this.#cfg, project.replica, project, from, taskId, "holder");
    const commit = lines.find((l) => l.name === name)?.commitId;
    if (commit === undefined) throw new Error(`bookmark ${taskNamespace(taskId)}${name} not found on ${shortId(from)}`);
    return commit;
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
      return got.receipt;
    });
  }

  /**
   * Makes a task received from `from` live here (`idle`); a follow-up joins the front of its queued prompts, which
   * then run one turn each, in order (`startQueued`), and writes its line on its homes (`pushTaskLines`). A task
   * already activated is a no-op: the sender's commit ran
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
      // The line as it came, to its homes: the sender's last write may have failed, and once its row says `moved` it
      // never writes again. A home that is offline gets it when it comes back (`#unpushed`). Not awaited: the sender
      // waits for this answer.
      void this.pushTaskLines(taskId).catch((err: unknown) => this.#log(`meddle: push: ${taskNamespace(taskId)}* failed: ${messageOf(err)}`));
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
    await this.#unstage(taskId);
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
  async #clearLeftovers(manifest: ReceivedManifest): Promise<void> {
    const task = paths(this.#cfg).task(manifest.id);
    if (!existsSync(task)) return;
    for (const p of manifest.projects) {
      const replica = getProject(this.#db, p.id)?.replica;
      if (replica !== undefined) await dropWorkspace(this.#cfg, replica, `meddle-${manifest.id}`, join(task, p.workspace));
    }
    await rm(task, { recursive: true, force: true });
  }

  /** Removes a received task's workspaces, every bookmark under its namespace (not on the home), folder and rows. */
  async #discard(row: TaskRow): Promise<void> {
    const manifest = JSON.parse(row.manifest) as TaskManifest;
    const self = this.#pool?.identity.id;
    for (const p of manifest.projects) {
      await dropWorkspace(this.#cfg, p.replica, `meddle-${row.id}`, join(paths(this.#cfg).task(row.id), p.workspace));
      if (self !== undefined && getProject(this.#db, p.id)?.home === self) continue;
      await serialised(repoKey(p.replica), () => bookmarkForget(p.replica, taskGlob(row.id), this.#cfg)).catch(() => {});
    }
    await rm(paths(this.#cfg).task(row.id), { recursive: true, force: true });
    deleteTask(this.#db, row.id, row.session_id);
  }

  // ─── archiving a task ───

  /**
   * Archives idle task `taskId` on this node (spec 21.4): refused (`task is <state>`, `task has queued prompts`) unless
   * its row is `idle` with nothing queued and no turn of it is live, pending or in the Harness, and it is not moving.
   * Sets its bookmarks; a project's home on another node must be online (else `cannot archive: home <short> of
   * <project> is offline`), and each home takes the task's line (`holdLines`, whose failure rejects the archive): once
   * a node off the home forgets the task's bookmarks, the home's line is the only copy, and it stays there while the
   * task is archived. Then writes the archive to `<data>/archives/<id>.json.gz`, records the row `archived` here (its
   * event and transcript rows stay) and takes the folder off this node (`releaseFolder`: on a project's home its
   * bookmarks stay). A refused or failed archive leaves the task idle and in place.
   */
  async archive(taskId: string): Promise<void> {
    const pool = this.#pool;
    if (pool === undefined) throw new Error("this node has no pool");
    const self = pool.identity.id;
    if (this.#archiving.has(taskId)) throw new Error("task is being archived");
    this.#refuseArchive(this.#row(taskId));
    // Reserved before the first await: no prompt, queued turn or move starts meanwhile. Under the task's key, so a
    // restore or delete waits until the folder is gone.
    this.#archiving.add(taskId);
    try {
      await serialised(taskKey(taskId), async () => {
        if ((await this.#durableTurn(taskId)) !== undefined) throw new Error("task is running");
        this.#refuseArchive(this.#row(taskId));
        const manifest = await readManifest(this.#cfg, taskId);
        const holds: Array<{ project: Project; replica: string }> = [];
        for (const p of manifest.projects) {
          const project = getProject(this.#db, p.id);
          if (project === null || project.home === "") throw new Error(`cannot archive: project ${p.name} has no known home`);
          if (project.home !== self && !pool.net.isOnline(project.home)) {
            throw new Error(`cannot archive: home ${shortId(project.home)} of ${p.name} is offline`);
          }
          holds.push({ project, replica: p.replica });
        }
        await this.setTaskBookmarks(manifest);
        for (const { project, replica } of holds) await holdLines(this.#cfg, self, replica, project, taskId);
        this.#unpushed.delete(taskId);
        await writeArchive(this.#cfg, this.#db, taskId, paths(this.#cfg).archiveFile(taskId));
        // Recorded before the folder goes: a node that stops in between has an archived task whose leftovers a
        // restore clears, never an idle one without its folder.
        updateTask(this.#db, taskId, { state: "archived", archived_on: self, archived_at: new Date().toISOString() });
        try {
          await releaseFolder(this.#cfg, this.#db, self, taskId);
        } catch (err) {
          this.#log(`meddle: archive: ${taskId} is archived, but its folder could not be removed: ${messageOf(err)}`);
        }
      });
    } finally {
      this.#archiving.delete(taskId);
    }
    this.#emitState(taskId, "archived");
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
   * Restores task `taskId`, archived on this node, here: each project's workspace starts on the task's project bookmark
   * (on the project's home, the local one; elsewhere, fetched from the home's line with the rest of the task's
   * bookmarks (`#fetchLine`), and the home must be online: else `cannot restore: home <short> of <project> is
   * offline`), the folder is provisioned from the
   * manifest and the archive's files are unpacked into it (a task without a project's transcript into this node's
   * slot). The row is `idle` again, no longer archived, and the archive is deleted. On failure, what it made is taken
   * off again and the task stays archived. While it runs, another restore of the task is refused (`task is being
   * restored`).
   */
  async restoreHere(taskId: string): Promise<TaskManifest> {
    const pool = this.#pool;
    if (pool === undefined) throw new Error("this node has no pool");
    const self = pool.identity.id;
    if (this.#restoring.has(taskId)) throw new Error("task is being restored");
    // Reserved before the first await: the row says `archived` until the restore is done, and a restore-move of it
    // started meanwhile would take the task away from under it.
    this.#restoring.add(taskId);
    try {
      return await this.#restoreHereLocked(taskId, self, pool);
    } finally {
      this.#restoring.delete(taskId);
    }
  }

  /** `restoreHere`'s work, under the task's key; the caller holds the reservation. */
  async #restoreHereLocked(taskId: string, self: string, pool: PoolRuntime): Promise<TaskManifest> {
    return serialised(taskKey(taskId), async () => {
      const row = this.#row(taskId);
      // A restore-move of it has started (its row still says `archived` until its `prepare` runs).
      if (this.#moving.has(taskId)) throw new Error("task is moving");
      if (row.state !== "archived") throw new Error(`task is ${row.state}`);
      if (row.archived_on !== self) throw new Error(`task is archived on ${shortId(row.archived_on ?? "another node")}`);
      const manifest = JSON.parse(row.manifest) as ReceivedManifest;
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
          const bookmark = `${taskNamespace(taskId)}${p.name}`;
          if (project.home === self) {
            parents[p.id] = await this.#localTaskChange(project, bookmark);
            continue;
          }
          if (!pool.net.isOnline(project.home)) throw new Error(`cannot restore: home ${shortId(project.home)} of ${p.name} is offline`);
          parents[p.id] = await this.#fetchLine(project, project.home, taskId, p.name);
        }
        restored = await provisionFromManifest(this.#cfg, this.#db, manifest, parents, "idle", { keepRow: true });
        await unpackArchiveFiles(this.#cfg, taskId, archive);
        await adoptTranscriptSlot(this.#cfg, this.#db, restored);
        updateTask(this.#db, taskId, { state: "idle", archived_on: null, archived_at: null, manifest: JSON.stringify(restored) });
      } catch (err) {
        // Back to what an archived task has here: no folder, no workspace, and (off the home) no task bookmarks.
        await releaseFolder(this.#cfg, this.#db, self, taskId).catch(() => {});
        throw err;
      }
      await rm(file, { force: true });
      this.#emitState(taskId, "idle");
      return restored;
    });
  }

  /** The change the local bookmark `bookmark` of `project`'s replica points at; throws when it is missing or conflicted. */
  async #localTaskChange(project: Project, bookmark: string): Promise<string> {
    const listed = await serialised(repoKey(project.replica), () => bookmarkList(project.replica, this.#cfg));
    const found = listed.find((b) => b.name === bookmark && b.remote === null);
    if (found === undefined) throw new Error(`bookmark ${bookmark} is missing`);
    if (found.conflicted || found.changeId === "") throw new Error(`bookmark ${bookmark} is conflicted`);
    return found.changeId;
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
   * Stages an archived task's bookmarks for its restore-move (decision 8): for each project homed on another node, the
   * home must be online (else `home <short> of <project> is offline`, checked for all before any fetch); the task's
   * line is fetched from the home into the project's replica here as its local bookmarks (`#fetchLine`, which drops
   * what an earlier unstage that failed left; the project's own must be there), so the target's `receiveTask` fetches
   * them from here. On a project's home, the target fetches the home's line.
   */
  async stageNamespace(manifest: TaskManifest): Promise<void> {
    const deps = this.#replicaDeps();
    if (deps === null) throw new Error("this node has no pool");
    const self = deps.pool.identity.id;
    const homes: Array<{ project: Project; name: string }> = [];
    for (const p of manifest.projects) {
      const project = getProject(this.#db, p.id);
      if (project === null) throw new Error(`unknown project: ${p.id}`);
      if (project.home === self) continue;
      if (!deps.pool.net.isOnline(project.home)) throw new Error(`home ${shortId(project.home)} of ${p.name} is offline`);
      homes.push({ project, name: p.name });
    }
    for (const { project, name } of homes) await this.#fetchLine(project, project.home, manifest.id, name);
  }

  /**
   * What an archived task has off its projects' homes again: no task bookmarks (staged by a restore-move that did not
   * happen), no folder, no workspace. A no-op unless the row says `archived`; best effort (logged).
   */
  async #unstage(taskId: string): Promise<void> {
    if (getTask(this.#db, taskId)?.state !== "archived") return;
    const self = this.#pool?.identity.id;
    if (self === undefined) return;
    await releaseFolder(this.#cfg, this.#db, self, taskId).catch((err: unknown) => {
      this.#log(`meddle: move: ${taskId} is archived again, but its staged bookmarks were not forgotten: ${messageOf(err)}`);
    });
  }

  /**
   * Deletes task `taskId` from this node: only an `archived` or `moved` one (else `task is <state>`). What is left of its
   * folder goes first (an archive whose folder removal was cut short, a move whose cleanup has not run: the folder, the
   * workspaces and, off a project's home, the task's bookmarks), then, with a pool, its bookmarks in each project's
   * repo here (on the home too) and, for an archived task (a moved one lives on elsewhere), its whole line on each home
   * (`releaseOnHome`: a home that is offline, or whose release fails, is left to its janitor, logged), then its archive
   * (or a move's leftover), then its row, event log and transcript rows.
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
        await releaseFolder(this.#cfg, this.#db, deps.pool.identity.id, taskId);
        await this.#releaseTask(deps, manifest, row.state === "archived");
      } else await this.#clearLeftovers(manifest);
      const p = paths(this.#cfg);
      await rm(p.archiveFile(taskId), { force: true });
      await rm(p.movedFile(taskId), { force: true });
      deleteTask(this.#db, taskId, row.session_id);
      // Told with the state it had: whoever lists this node's tasks reads them again.
      this.#emitState(taskId, row.state as TaskState);
    });
  }

  /**
   * What `deleteTask` takes off the projects' repos, with a pool: the task's bookmarks in each, and, with `release`, its
   * line on each home (logged when that fails or the home is offline).
   */
  async #releaseTask(deps: ReplicaDeps, manifest: TaskManifest, release: boolean): Promise<void> {
    const taskId = manifest.id;
    this.#unpushed.delete(taskId);
    for (const p of manifest.projects) {
      const project = getProject(this.#db, p.id);
      if (project === null) continue;
      await this.#forgetBookmarks(p.replica, taskId).catch(() => {});
      if (!release || project.home === "") continue;
      await releaseOnHome(deps, project, taskId, []).catch((err: unknown) => {
        this.#log(`meddle: delete: the line of ${taskId} on ${shortId(project.home)} was not released (its janitor will): ${messageOf(err)}`);
      });
    }
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
    this.#moving.delete(taskId);
    this.#hurried.delete(taskId);
    this.#cancelling.delete(taskId);
    this.#emitState(taskId, "moved");
    this.#emitMove(taskId);
  }

  /**
   * Ends a move that did not happen: the task is live here again (idle, or its turn's state), the prompts queued
   * meanwhile run, and the failure is logged once and told (`onMove` with the error, then null). A restore-move's task
   * is archived here again instead, its staged bookmarks forgotten off its projects' homes.
   */
  async failMove(taskId: string, to: string, phase: string, error: string | null): Promise<void> {
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
      await this.#unstage(taskId);
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
    // A state change goes with a queue that travelled, arrived or was dropped (a move, an archive).
    this.#emitQueued(taskId);
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
