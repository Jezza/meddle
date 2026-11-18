// Serves the node's chord objects. State follows the runner, approvals and metrics through listeners on their
// events (each event a short root of its own); the database and the runner are the truth they are read from.
import { hostname } from "node:os";
import Type from "typebox";
import type { Database } from "bun:sqlite";
import { ChordError, createHost, forbidden, type Ctx, type Host, type Subscribable } from "@earendil-works/chord";
import type { PermissionResult, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Attachment, Prompt } from "../blobs/attachment";
import { checkTaskRoot, type NodeConfig } from "../config";
import type { PendingApproval } from "../engine/approvals";
import { resultError, tokenFaultNotice, tokenFaultOf, type MeddleEvent, type TokenFault } from "../engine/session";
import type { MetricsSampler, NodeMetrics } from "../metrics";
import { peerOf, remoteReason, servePool } from "../pool/object";
import type { PoolRuntime } from "../pool/runtime";
import { EFFORT_LEVELS } from "../pool/settings";
import { acceptPeerLinks } from "../pool/sync";
import { listBranchRows, listLineRows, rowChanges } from "../pool/rows";
import { bookmarkList, gitImport, isJjRepo, JjError } from "../jj";
import { paths } from "../paths";
import { projectBranches } from "../projects/applier";
import { loadBranchContext } from "../projects/context";
import { graphProbe, olderGraph, projectGraph, type GraphCommit, type GraphProbe } from "../projects/graph";
import { memoryChanges, memoryPlacing, MemoryWriteError, syncMemoryBefore, writeMemory } from "../projects/memory-sync";
import { isMemoryPath, memoryDiff, memoryEntries, memoryFile, memoryHistory } from "../projects/memory-view";
import { releaseLineRows } from "../projects/lines";
import { resolveStarts } from "../projects/starts";
import {
  addProjectFromFolder, addProjectFromUpstream, getProject, listProjects, projectChanges, setDefaultBranch,
  type Project,
} from "../projects/project";
import {
  latestEventOfType, latestEventWithField, latestMainAssistant, listEvents, listEventsOfKinds, listEventsTail,
  type EventRecord,
} from "../store/events";
import { getTask, getTaskSettings, listArchivedTasks, listLiveTasks, listTasks, newId } from "../store/records";
import { UNQUEUED_BY_USER, type MoveState, type TaskRunner, type TaskState } from "../tasks/durable";
import {
  ChangesError, changeDiff, changeFile, changesProbe, taskChanges, workspaceFile, type ChangesProbe, type ProjectChanges,
} from "../tasks/changes";
import { taskNamespace, type ManifestProject, type Start, type TaskManifest } from "../tasks/manifest";
import { initialTitle } from "../tasks/names";
import { startTrains } from "../train/train";
import { shortId } from "../pool/ids";
import { listTokens, pickToken } from "../token";
import { activeUsage as activeUsageNow, tokenUsages } from "../token-usage";
import { gated } from "../update/gate";
import { VERSION } from "../version";
import { AGENT_EVENT_KINDS, EMPTY_AGENT_LOG, foldAgentLog, runningCount, servedAgents } from "./agents";
import {
  AgentLogSchema,
  BranchSchema,
  isProgress,
  NodeObject,
  NodeStore,
  PeerObject,
  PROGRESS_KINDS,
  ProjectObject,
  ProjectViewSchema,
  SessionObject,
  SessionViewSchema,
  TaskLogSchema,
  TaskObject,
  type AgentLog,
  type Notification,
  type SessionView,
  type TaskLog,
} from "./contracts";

export { NodeObject, ProjectObject, SessionObject, TaskObject } from "./contracts";

export type NodeHostDeps = {
  cfg: NodeConfig;
  db: Database;
  runner: TaskRunner;
  metrics: MetricsSampler;
  claudeCodeVersion: string;
  /** The node's pool: served as `PoolObject`, and its members' chord links are accepted on this host. */
  pool: PoolRuntime;
  /**
   * Why this node accepts no input now (its new build awaits confirmation: `Updater.inputHold`), or null. While it
   * says, every method of `NodeObject`, `TaskObject` and `PoolObject`'s default variant is refused with it, and
   * `ProjectObject`'s writes of memory. Those would survive a rollback (it restores the database, not the memory repo);
   * they are refused all the same, so a node awaiting confirmation takes no input at all.
   */
  inputHold?(): string | null;
};

type TaskEvent = { taskId: string; seq: number; message: SDKMessage | MeddleEvent };
type Message = { type?: unknown; subtype?: unknown; [key: string]: unknown };
/** A task's `changesProbe`s (`changesProbeNow`). */
type ChangesProbes = {
  key: string | null;
  projects: Array<{ p: ManifestProject; defaultBranch: string | null; probe: ChangesProbe | null }> | null;
};

const NOTIFICATIONS_KEPT = 50;
/**
 * How often an object re-reads what can change without an event telling it (a peer's push, the user's git or jj): a
 * project's graph, branches and memory, a task's lines.
 */
const SLOW_REFRESH_MS = 60_000;
const WINDOW_SIZE = 200;
/** The most changes of a project's memory history one `memoryHistory` call answers. */
const MEMORY_HISTORY_MAX = 200;
/** The most commits `ProjectObject.olderGraph` lists. */
const OLDER_GRAPH_MAX = 2000;

/**
 * A refusal of a memory call whose reason starts with `code` (`changed: …`) as the caller reads it (`remoteReason`).
 * A chord error, as chord takes a plain error's leading `<word>: ` for its own code and drops it on the way.
 */
function memoryRefusal(code: string, message: string): ChordError {
  return new ChordError("unavailable", `${code}: ${message}`);
}

export type PeerObjectDeps = {
  cfg: NodeConfig;
  db: Database;
  /** This node's id: a project's lines are released only on its home. */
  selfId: string;
  claudeCodeVersion: string;
  hostsTasks(): Promise<boolean>;
  /** Fires after a project was added or registered on this node. */
  changes: Subscribable<null>;
  /** Fires when this node's own state may have changed (each metrics sample, each pool change): `hostsTasks` is re-read. */
  recheck?: Subscribable<null>;
  /** Whether a node is a member of this node's pool: only a member may create a task here, or run a train turn. */
  isMember(nodeId: string): boolean;
  /**
   * Receives tasks other nodes move here (each call names the calling node), creates tasks members place here, and runs
   * what a member's merge train asks of the tasks held here: train turns, their status, abandoning leftovers, leaving
   * the queue, discarding a merge task.
   */
  runner: Pick<
    TaskRunner,
    | "receiveTask" | "activateTask" | "abandonTask" | "create" | "prompt" | "nameFromPrompt" | "setModel" | "setEffort" | "trainTurn"
    | "trainStatus" | "abandonLeftovers" | "unqueue" | "discardMergeTask"
  >;
};

/** A project as another node sees it. */
function projectInfo(p: Project): { id: string; name: string; home: string; defaultBranch: string | null } {
  return { id: p.id, name: p.name, home: p.home, defaultBranch: p.defaultBranch };
}

/** Serves `PeerObject` on `host` to `peer:<nodeId>` principals; anyone else is refused `forbidden`. */
export function servePeer(host: Host, deps: PeerObjectDeps): void {
  const { db } = deps;
  const projectsNow = () => listProjects(db).map(projectInfo);
  host.serve(PeerObject, (_input, principal, self) => {
    const from = peerOf(principal);
    if (from === null) throw forbidden("peers only");
    const state = PeerObject.def.variants.peer.state;
    const projects = self.state("projects", state.projects, { init: projectsNow });
    const hostsTasks = self.state("hostsTasks", state.hostsTasks, { init: () => deps.hostsTasks() });
    /** The task root can come and go while the node runs: re-read it whenever a peer may be deciding on a move. */
    const refreshHostsTasks = async (ctx: Ctx) => {
      const now = await deps.hostsTasks();
      if (!ctx.signal.aborted && now !== hostsTasks.value) hostsTasks.replace(ctx, now);
    };
    self.on("projects", deps.changes, async (_event, ctx) => {
      projects.replace(ctx, projectsNow());
      await refreshHostsTasks(ctx);
    });
    // Peers pick move targets by `hostsTasks` before asking anything, so a task root that comes back must show here.
    if (deps.recheck !== undefined) self.on("recheck", deps.recheck, (_event, ctx) => refreshHostsTasks(ctx));
    return {
      variant: "peer",
      projects,
      claudeCodeVersion: self.state("claudeCodeVersion", state.claudeCodeVersion, deps.claudeCodeVersion),
      hostsTasks,
      projectInfo: async ({ id }) => {
        const found = getProject(db, id);
        return found === null ? null : projectInfo(found);
      },
      receiveTask: async ({ manifest, claudeCodeVersion, lineRows }, ctx) => {
        const result = await deps.runner.receiveTask(manifest, from, claudeCodeVersion, lineRows);
        await refreshHostsTasks(ctx);
        return result;
      },
      activateTask: ({ taskId, followUp }) => deps.runner.activateTask(taskId, from, followUp),
      abandonTask: ({ taskId }) => deps.runner.abandonTask(taskId, from),
      rowsOf: ({ projectId }) => {
        if (!deps.isMember(from)) throw forbidden("members only");
        return { lineRows: listLineRows(db, projectId), branchRows: listBranchRows(db, projectId) };
      },
      taskHeld: ({ id }) => {
        if (!deps.isMember(from)) throw forbidden("members only");
        // A `moved` row is what a task that went on left here: it holds nothing.
        const row = getTask(db, id);
        return row !== null && row.state !== "moved";
      },
      trainTurn: ({ taskId, kind, text }) => {
        if (!deps.isMember(from)) throw forbidden("members only");
        return deps.runner.trainTurn(taskId, kind, text);
      },
      trainTasks: ({ taskIds }) => {
        if (!deps.isMember(from)) throw forbidden("members only");
        return deps.runner.trainStatus(taskIds);
      },
      abandonLeftovers: ({ taskId, commits }) => {
        if (!deps.isMember(from)) throw forbidden("members only");
        return deps.runner.abandonLeftovers(taskId, commits);
      },
      unqueueTask: ({ taskId, reason }) => {
        if (!deps.isMember(from)) throw forbidden("members only");
        return deps.runner.unqueue(taskId, reason);
      },
      discardTask: ({ taskId }) => {
        if (!deps.isMember(from)) throw forbidden("members only");
        return deps.runner.discardMergeTask(taskId);
      },
      // Refused like a local create (no task root, no usable token, …) before any prompt is taken.
      createTaskAt: async ({ title, taskId, starts, prompt, attachments = [], nameFromPrompt, model, effort, merge }) => {
        if (!deps.isMember(from)) throw forbidden("members only");
        const manifest = await deps.runner.create({ title, taskId, starts, ...(merge === undefined ? {} : { merge }) });
        if (model !== undefined) await deps.runner.setModel(manifest.id, model);
        if (effort !== undefined) await deps.runner.setEffort(manifest.id, effort);
        const first = firstPrompt(prompt, attachments);
        if (first !== null && nameFromPrompt === true) void deps.runner.nameFromPrompt(manifest.id, title, first.text);
        if (first !== null) await deps.runner.prompt(manifest.id, first.text, first.attachments);
        return { manifest };
      },
    };
  });
}

/**
 * A new task's first prompt: `text` (absent is blank) with `attachments`; null, and no first prompt sent, for a blank
 * text with none.
 */
function firstPrompt(text: string | null | undefined, attachments: Attachment[]): Prompt | null {
  const t = text ?? "";
  return t.trim() === "" && attachments.length === 0 ? null : { text: t, attachments };
}

/**
 * A refresh of `cell` from `read`, one read at a time: triggers that arrive while one reads make one more read after
 * it (a turn's end follows its start closely, and what it changed must not wait for the slow timer). The cell is
 * replaced only when the value changed.
 */
function latest<T>(read: () => Promise<T>, cell: { readonly value: T; replace(ctx: Ctx, value: T): void }): (ctx: Ctx) => Promise<void> {
  let reading = false;
  let again = false;
  return async (ctx) => {
    if (reading) {
      again = true;
      return;
    }
    reading = true;
    try {
      do {
        again = false;
        const next = await read();
        if (ctx.signal.aborted) return;
        if (JSON.stringify(next) !== JSON.stringify(cell.value)) cell.replace(ctx, next);
      } while (again);
    } finally {
      reading = false;
    }
  };
}

/**
 * A host named `node` serving `NodeObject`, `ProjectObject`, `TaskObject`, `SessionObject`, `PoolObject` and
 * `PeerObject`. The runner is given the pool (a no-op when it was built with it), so tasks created here replicate
 * projects homed elsewhere.
 */
export function createNodeHost(deps: NodeHostDeps): Host {
  const { cfg, db, runner, metrics, pool } = deps;
  runner.attachPool(pool);
  const approvals = runner.approvals;
  const events: Subscribable<TaskEvent> = {
    subscribe: (cb) => runner.onEvent((taskId, seq, message) => cb({ taskId, seq, message })),
  };
  const states: Subscribable<{ taskId: string; state: TaskState }> = {
    subscribe: (cb) => runner.onState((taskId, state) => cb({ taskId, state })),
  };
  const lives: Subscribable<{ taskId: string }> = {
    subscribe: (cb) => runner.onLive((taskId) => cb({ taskId })),
  };
  const manifests: Subscribable<{ taskId: string }> = {
    subscribe: (cb) => runner.onManifest((taskId) => cb({ taskId })),
  };
  const settingsChanges: Subscribable<{ taskId: string }> = {
    subscribe: (cb) => runner.onSettings((taskId) => cb({ taskId })),
  };
  const queuedChanges: Subscribable<{ taskId: string }> = {
    subscribe: (cb) => runner.onQueued((taskId) => cb({ taskId })),
  };
  const acceptances: Subscribable<{ taskId: string }> = {
    subscribe: (cb) => runner.onAcceptance((taskId) => cb({ taskId })),
  };
  // A task queued on its project's train, or leaving it (`reason`).
  const queueChanges: Subscribable<{ taskId: string; reason: string | null }> = {
    subscribe: (cb) => runner.onQueue((taskId, _queue, reason) => cb({ taskId, reason })),
  };
  const moves: Subscribable<{ taskId: string; move: MoveState | null }> = {
    subscribe: (cb) => runner.onMove((taskId, move) => cb({ taskId, move })),
  };
  const approvalChanges: Subscribable<null> = { subscribe: (cb) => approvals.onChange(() => cb(null)) };
  const samples: Subscribable<NodeMetrics> = { subscribe: (cb) => metrics.onSample(cb) };
  const poolChanges: Subscribable<null> = { subscribe: (cb) => pool.onChange(() => cb(null)) };
  const slowTicks: Subscribable<null> = {
    subscribe: (cb) => {
      const timer = setInterval(() => cb(null), SLOW_REFRESH_MS);
      timer.unref();
      return () => clearInterval(timer);
    },
  };

  const host = createHost({ name: "node", self: "node" });
  servePool(host, { ...pool.objectDeps, inputHold: deps.inputHold });
  servePeer(host, {
    cfg,
    db,
    selfId: pool.identity.id,
    claudeCodeVersion: deps.claudeCodeVersion,
    hostsTasks: async () => (await checkTaskRoot(cfg)).ok,
    changes: projectChanges,
    isMember: (id) => pool.store.isMember(id),
    recheck: {
      subscribe: (cb) => {
        const offSamples = metrics.onSample(() => cb(null));
        const offPool = pool.onChange(() => cb(null));
        return () => { offSamples(); offPool(); };
      },
    },
    runner,
  });
  acceptPeerLinks(pool.net, host, (id) => pool.store.isMember(id));

  host.serve(NodeStore, (_input, _principal, self) => {
    const taskIds = self.state("taskIds", NodeStore.def.members.taskIds, { init: () => listLiveTasks(db).map((t) => t.id) });
    const archivedIds = self.state("archivedIds", NodeStore.def.members.archivedIds, { init: () => listArchivedTasks(db).map((t) => t.id) });
    const projectIds = self.state("projectIds", NodeStore.def.members.projectIds, { init: projectIdsNow });
    const token = self.state("token", NodeStore.def.members.token, { init: () => tokenNow(cfg, db) });
    const tokenUsage = self.state("tokenUsage", NodeStore.def.members.tokenUsage, { init: () => tokenUsages(db) });
    const activeUsage = self.state("activeUsage", NodeStore.def.members.activeUsage, { init: () => activeUsageNow(cfg, db) });
    const metricsNow = self.state("metrics", NodeStore.def.members.metrics, { init: () => metrics.latest() });
    const hostsTasks = self.state("hostsTasks", NodeStore.def.members.hostsTasks, { init: async () => (await checkTaskRoot(cfg)).ok });
    const hostingProblem = self.state("hostingProblem", NodeStore.def.members.hostingProblem, {
      init: async () => {
        const check = await checkTaskRoot(cfg);
        return check.ok ? null : check.reason;
      },
    });
    const models = self.state("models", NodeStore.def.members.models, []);
    const notifications = self.state("notifications", NodeStore.def.members.notifications, []);
    const efforts = self.state("efforts", NodeStore.def.members.efforts, { init: effortsNow });
    const chosenModels = self.state("chosenModels", NodeStore.def.members.chosenModels, { init: chosenModelsNow });
    /** Tasks whose current turn's messages reported a token fault (until their next `turn_started`). */
    const faulted = new Set<string>();
    /** Tasks whose last event was a `token_fault` for no usable token: the `turn_failed` after it is the same failure. */
    const noTokenFailures = new Set<string>();
    /** Pending request ids already notified, so each request is announced once. */
    const announced = self.state("announced", Type.Array(Type.String()), []);
    // The merge trains of the projects homed here run as long as the host does.
    self.resource("trains", {
      version: 1,
      open: () => startTrains({ cfg, db, pool, runner, ...(deps.inputHold === undefined ? {} : { inputHold: deps.inputHold }) }),
      close: (stop) => stop(),
    });

    /** The task root, jj and git can come and go while the node runs. */
    const refreshHostsTasks = async (ctx: Ctx) => {
      const check = await checkTaskRoot(cfg);
      if (ctx.signal.aborted) return;
      if (check.ok !== hostsTasks.value) hostsTasks.replace(ctx, check.ok);
      const problem = check.ok ? null : check.reason;
      if (problem !== hostingProblem.value) hostingProblem.replace(ctx, problem);
    };

    /** A reading recorded, a token picked or removed: the readings and the active token's are read again. */
    const refreshUsage = async (ctx: Ctx) => {
      const active = await activeUsageNow(cfg, db);
      if (ctx.signal.aborted) return;
      tokenUsage.replace(ctx, tokenUsages(db));
      activeUsage.replace(ctx, active);
    };

    const notify = (ctx: Ctx, n: Omit<Notification, "id" | "at">) => {
      const note = { id: crypto.randomUUID(), at: new Date().toISOString(), ...n };
      notifications.replace(ctx, [...notifications.value, note].slice(-NOTIFICATIONS_KEPT));
    };

    self.on("events", events, async ({ taskId, message }, ctx) => {
      const m = message as Message;
      const afterNoToken = noTokenFailures.delete(taskId);
      if (tokenFaultOf(message as SDKMessage) !== null) faulted.add(taskId);
      // The turn recorded the reading before this event went out.
      if (m.type === "rate_limit_event") await refreshUsage(ctx);
      if (m.type === "result") {
        const error = resultError(m);
        // A turn its token failed says so in the `token_fault` that follows (or reruns with the next token): one
        // notification, not a `failed` as well.
        if (error === null) notify(ctx, { taskId, kind: "finished", text: "Turn finished" });
        else if (!faulted.has(taskId)) notify(ctx, { taskId, kind: "failed", text: `Turn ended: ${error}` });
      } else if (m.type === "meddle" && m.subtype === "turn_started") {
        faulted.delete(taskId);
      } else if (m.type === "meddle" && m.subtype === "turn_failed") {
        if (!afterNoToken) notify(ctx, { taskId, kind: "failed", text: `Turn failed: ${String(m.error)}` });
      } else if (m.type === "meddle" && m.subtype === "token_fault") {
        const fault = m.fault as TokenFault | { kind: "none" };
        if (fault.kind === "none") noTokenFailures.add(taskId);
        if (m.rerun !== true) notify(ctx, { taskId, kind: "token", text: tokenFaultNotice(m) });
      } else if (m.type === "system" && m.subtype === "init") {
        // The turn's query is live from its first message on, so its model list is asked for here.
        const query = runner.liveQuery(taskId);
        if (query === null) return;
        try {
          const list = await query.supportedModels();
          models.replace(ctx, list.filter((info) => info.value !== "default").map((info) => ({
            value: info.value,
            resolvedModel: info.resolvedModel ?? null,
            displayName: info.displayName,
            description: info.description,
            efforts: info.supportsEffort === false ? [] : info.supportedEffortLevels ?? [...EFFORT_LEVELS],
          })));
        } catch {
          // keep the previous list
        }
      }
    });
    // A model or effort chosen at creation (here or by a peer) or brought by a move shows without a turn.
    self.on("settings", settingsChanges, ({ taskId }, ctx) => {
      const { model, effort } = getTaskSettings(db, taskId);
      const { [taskId]: _model, ...models } = chosenModels.value;
      const { [taskId]: _effort, ...rest } = efforts.value;
      if (chosenModels.value[taskId] !== model) chosenModels.replace(ctx, model === undefined ? models : { ...models, [taskId]: model });
      if (efforts.value[taskId] !== effort) efforts.replace(ctx, effort === undefined ? rest : { ...rest, [taskId]: effort });
    });
    self.on("approvals", approvalChanges, (_event, ctx) => {
      const pending = approvals.pending();
      const known = new Set(announced.value);
      for (const req of pending) {
        if (known.has(req.requestId)) continue;
        const question = req.toolName === "AskUserQuestion";
        notify(ctx, { taskId: req.taskId, kind: question ? "question" : "approval", text: question ? questionText(req) : `${req.toolName} needs approval` });
      }
      announced.replace(ctx, pending.map((req) => req.requestId));
    });
    self.on("samples", samples, async (sample, ctx) => {
      metricsNow.replace(ctx, sample);
      token.replace(ctx, await tokenNow(cfg, db));
      await refreshUsage(ctx);
      await refreshHostsTasks(ctx);
    });
    // A move that failed says where and why; the task is live here again.
    self.on("moves", moves, ({ taskId, move }, ctx) => {
      if (move?.error) notify(ctx, { taskId, kind: "move", text: `Move to ${shortId(move.to)} failed at ${move.phase}: ${move.error}` });
    });
    /** The running count the pool last heard from here (placement reads it from the roster). */
    let reportedRunning = runner.running();
    // A task received from another node, or created for one, turns live through the runner; a moved or archived one
    // leaves (an archived one joins `archivedIds`). The pool hears of a new or gone task, and of one that started or
    // stopped running, now.
    self.on("taskStates", states, (_event, ctx) => {
      const ids = listLiveTasks(db).map((t) => t.id);
      const archived = listArchivedTasks(db).map((t) => t.id);
      if (archived.join() !== archivedIds.value.join()) archivedIds.replace(ctx, archived);
      const running = runner.running();
      const changed = ids.join() !== taskIds.value.join();
      if (changed) taskIds.replace(ctx, ids);
      if (changed || running !== reportedRunning) {
        reportedRunning = running;
        void pool.refresh();
      }
    });
    // A project added or registered elsewhere than through this object (a replica a task needed); the pool hears of it
    // now, as placement reads where projects are from the roster.
    self.on("projects", projectChanges, (_event, ctx) => {
      projectIds.replace(ctx, projectIdsNow());
      void pool.refresh();
    });
    // A token pulled from a peer, marked or removed changes what is usable without a metrics sample.
    self.on("pool", poolChanges, async (_event, ctx) => {
      const next = await tokenNow(cfg, db);
      // The host may have closed while the file was read (a change as the node shuts down).
      if (!ctx.signal.aborted) token.replace(ctx, next);
      await refreshUsage(ctx);
      await refreshHostsTasks(ctx);
    });

    return {
      nodeId: self.state("nodeId", NodeStore.def.members.nodeId, pool.identity.id),
      hostname: self.state("hostname", NodeStore.def.members.hostname, hostname()),
      version: self.state("version", NodeStore.def.members.version, VERSION),
      claudeCodeVersion: self.state("claudeCodeVersion", NodeStore.def.members.claudeCodeVersion, deps.claudeCodeVersion),
      taskRoot: self.state("taskRoot", NodeStore.def.members.taskRoot, cfg.taskRoot),
      hostsTasks,
      hostingProblem,
      metrics: metricsNow,
      token,
      tokenUsage,
      activeUsage,
      taskIds,
      archivedIds,
      projectIds,
      models,
      notifications,
      efforts,
      chosenModels,
      createTask: async ({ title: given, projects, prompt, attachments = [], node, model, effort }, ctx) => {
        // Named here, before it goes anywhere, so that a peer of any version gets a title. Untitled, it starts with a
        // made-up name, not waiting on Haiku: the node it is on names it from its prompt afterwards.
        const title = initialTitle(given);
        const nameFromPrompt = title !== given;
        const selfId = pool.identity.id;
        const withFiles = attachments.length > 0;
        const target = node === "here" ? selfId : node ?? await placeTask(projects.map((p) => p.id), withFiles);
        if (target !== selfId && !pool.store.isMember(target)) throw new Error(`no such node: ${target}`);
        // An older meddle would drop them: refused before anything is written.
        const refusal = withFiles && target !== selfId ? runner.noAttachmentsOn(target) : null;
        if (refusal !== null) throw new Error(refusal);
        // This node writes each start's line row now, before the task exists: a creation that certainly failed releases
        // them; one the target may have made all the same (its answer was lost) keeps them while the target holds the
        // task.
        const taskId = newId();
        const deps = { cfg, db, selfId, pool };
        let starts: Start[];
        try {
          starts = await resolveStarts(deps, taskId, projects);
        } catch (err) {
          releaseLineRows(db, taskId, []);
          throw err;
        }
        const first = firstPrompt(prompt, attachments);
        if (target === selfId) {
          let manifest: TaskManifest;
          try {
            manifest = await runner.create({ title, taskId, starts });
            if (model !== undefined) await runner.setModel(taskId, model);
            if (effort !== undefined) await runner.setEffort(taskId, effort);
          } catch (err) {
            // A task made all the same (a failure after it) keeps its lines.
            if (getTask(db, taskId) !== null) throw err;
            releaseLineRows(db, taskId, []);
            throw err;
          }
          if (!taskIds.value.includes(manifest.id)) taskIds.replace(ctx, [...taskIds.value, manifest.id]);
          // The pool sees the new task count now, not at the next periodic refresh.
          void pool.refresh();
          if (first !== null && nameFromPrompt) void runner.nameFromPrompt(manifest.id, title, first.text);
          if (first !== null) await runner.prompt(manifest.id, first.text, first.attachments);
          return { manifest, nodeId: selfId };
        }
        try {
          const manifest = await createOn(target, {
            title, taskId, starts, prompt: first?.text ?? null, nameFromPrompt,
            ...(withFiles ? { attachments } : {}),
            ...(model === undefined ? {} : { model }),
            ...(effort === undefined ? {} : { effort }),
          });
          return { manifest, nodeId: target };
        } catch (err) {
          if (err instanceof CreationSent) {
            const held = await heldOn(target, taskId);
            if (held !== false) {
              const why = held ? `${shortId(target)} has task ${taskId} all the same` : `${shortId(target)} may have task ${taskId}`;
              throw new Error(`${err.message}; ${why}: its lines stay`);
            }
          }
          releaseLineRows(db, taskId, []);
          throw err;
        }
      },
      addProjectFromFolder: async ({ path, name, projectId }, ctx) => {
        const project = await addProjectFromFolder(cfg, db, path, pool.identity.id, name, projectId);
        projectIds.replace(ctx, projectIdsNow());
        return project;
      },
      addProjectFromUpstream: async ({ url, name }, ctx) => {
        const project = await addProjectFromUpstream(cfg, db, url, pool.identity.id, name);
        projectIds.replace(ctx, projectIdsNow());
        return project;
      },
      setDefaultBranch: async ({ projectId, branch }) => {
        const project = setDefaultBranch(db, projectId, branch);
        if (project === null) throw new Error(`no project ${shortId(projectId)}`);
        return project;
      },
      dismiss: ({ id }, ctx) => {
        notifications.replace(ctx, notifications.value.filter((n) => n.id !== id));
      },
      // Answered once the change shows, so a select does not snap back between the answer and the `settings` event.
      setModel: async ({ taskId, model }, ctx) => {
        await runner.setModel(taskId, model);
        const { [taskId]: _, ...rest } = chosenModels.value;
        chosenModels.replace(ctx, model === undefined ? rest : { ...rest, [taskId]: model });
      },
      setEffort: async ({ taskId, effort }, ctx) => {
        await runner.setEffort(taskId, effort);
        efforts.replace(ctx, { ...efforts.value, [taskId]: effort });
      },
    };
  }, { lifetime: "host" });

  host.serve(NodeObject, (_input, _principal, self) => {
    const store = self.get(NodeStore, {});
    return gated({
      variant: "default",
      nodeId: store.nodeId,
      hostname: store.hostname,
      version: store.version,
      claudeCodeVersion: store.claudeCodeVersion,
      taskRoot: store.taskRoot,
      hostsTasks: store.hostsTasks,
      hostingProblem: store.hostingProblem,
      metrics: store.metrics,
      token: store.token,
      tokenUsage: store.tokenUsage,
      activeUsage: store.activeUsage,
      taskIds: store.taskIds,
      archivedIds: store.archivedIds,
      projectIds: store.projectIds,
      models: store.models,
      notifications: store.notifications,
      createTask: (input, ctx) => store.createTask(input, ctx),
      addProjectFromFolder: (input, ctx) => store.addProjectFromFolder(input, ctx),
      addProjectFromUpstream: (input, ctx) => store.addProjectFromUpstream(input, ctx),
      setDefaultBranch: (input, ctx) => store.setDefaultBranch(input, ctx),
      dismiss: (input, ctx) => store.dismiss(input, ctx),
    }, deps.inputHold);
  });

  host.serve(ProjectObject, ({ id }, _principal, self) => {
    const project = self.state("project", ProjectViewSchema, {
      init: async () => {
        const found = getProject(db, id);
        if (found === null) throw new Error(`unknown project: ${id}`);
        let contextLoaded = true;
        try {
          // No task: the project's files as its default branch has them.
          await loadBranchContext(cfg, found.replica, found.defaultBranch);
        } catch {
          contextLoaded = false;
        }
        return { ...found, contextLoaded };
      },
    });
    /**
     * The last full read of the graph: what it read, the probe it read under (`olderGraph` reads under it too) and that
     * probe's key with the default branch. Kept apart from the cell, which a dropped refresh leaves behind.
     */
    let read: { at: string; probe: GraphProbe; value: GraphCommit[] } | null = null;
    /**
     * The replica's graph (`projectGraph`), or the last full read's while the counted bookmarks and the default branch
     * are as it had them, or whenever jj cannot read it. The git refs are imported first: a peer's push lands in `.git`.
     */
    const graphNow = async (): Promise<GraphCommit[]> => {
      const found = getProject(db, id);
      if (found === null) return read?.value ?? [];
      try {
        await gitImport(found.replica, cfg);
        const probe = await graphProbe(cfg, found.replica, found.name, archivedOf(id));
        const at = JSON.stringify([probe.key, found.defaultBranch]);
        if (read !== null && at === read.at) return read.value;
        read = { at, probe, value: await projectGraph(cfg, found.replica, probe, found.defaultBranch) };
        return read.value;
      } catch {
        return read?.value ?? [];
      }
    };
    const graph = self.state("graph", ProjectObject.def.variants.default.state.graph, { init: graphNow });
    const refreshGraph = latest(graphNow, graph);
    self.on("projects", projectChanges, (_event, ctx) => refreshGraph(ctx));
    // A task of this project changed state: a turn's end moved (and pushed) its line, or a move fetched or forgot one.
    self.on("taskStates", states, ({ taskId }, ctx) => {
      if (taskHasProject(taskId, id)) return refreshGraph(ctx);
    });
    // Bookmarks a peer pushes into the replica's `.git`, or the user's git, tell nothing: a slow re-read (which imports
    // the git refs first) catches them.
    self.on("ticks", slowTicks, (_event, ctx) => refreshGraph(ctx));
    /** The project's branches as this node computes them; [] while (or whenever) they cannot be read. */
    const branchesNow = async () => {
      try {
        return await projectBranches({ cfg, db }, id);
      } catch {
        return [];
      }
    };
    const branches = self.state("branches", Type.Array(BranchSchema), { init: branchesNow });
    const refreshBranches = latest(branchesNow, branches);
    // Any row change, a push of another node's that waits for its commit included (still fetching until admitted).
    // An archive flips a line row: its line leaves the graph.
    self.on("rows", rowChanges, async (projectId, ctx) => {
      if (projectId !== id) return;
      await refreshBranches(ctx);
      await refreshGraph(ctx);
    });
    self.on("branchTicks", slowTicks, (_event, ctx) => refreshBranches(ctx));

    const memoryRepo = paths(cfg).memory(id);
    /** Where `memory` and the memory working copy's parent are (`memoryPlacing`, read without a snapshot); null without a repo. */
    const memoryHeadNow = async () => {
      try {
        return (await memoryPlacing(cfg, memoryRepo)).trim();
      } catch {
        return null;
      }
    };
    const memoryHead = self.state("memoryHead", ProjectObject.def.variants.default.state.memoryHead, { init: memoryHeadNow });
    const refreshMemoryHead = latest(memoryHeadNow, memoryHead);
    /**
     * On the project's home, with no task of it live here, brings the memory working copy onto `memory`: a peer's push
     * moves only the bookmark, and the entries are read from disk. With one live its turn end does it. What this moves
     * tells `memoryChanges` again, and that second run finds nothing to move.
     */
    const followHome = async () => {
      if (getProject(db, id)?.home !== pool.identity.id || !(await isJjRepo(memoryRepo))) return;
      // Asked just before the sync queues for its lock: a turn starting later queues its own sync behind this one.
      if (!runner.projectLive(id)) await syncMemoryBefore({ cfg, db, pool }, id, false);
    };
    self.on("memory", memoryChanges, async (projectId, ctx) => {
      if (projectId !== id) return;
      await followHome();
      await refreshMemoryHead(ctx);
    });
    // A push that landed while no one here listened left the working copy behind: caught up once the object is live.
    self.task(async (ctx) => {
      await followHome();
      await refreshMemoryHead(ctx);
    });
    self.on("memoryTicks", slowTicks, (_event, ctx) => refreshMemoryHead(ctx));
    /** The memory repo, for a read; refused without one. */
    const readable = async () => {
      if (!(await isJjRepo(memoryRepo))) throw memoryRefusal("no-repo", "no memory replica here");
      return memoryRepo;
    };
    const memoryPath = (path: string) => {
      if (!isMemoryPath(path)) throw memoryRefusal("path", `not a memory file: ${JSON.stringify(path)}`);
      return path;
    };
    /** A write of memory, its refusals (`MemoryWriteError`) with their code first; any other failure as it is. */
    const write = async (path: string, text: string | null, base: string | null) => {
      try {
        return await writeMemory({ cfg, db, pool }, id, path, text, base, () => runner.projectLive(id));
      } catch (err) {
        if (err instanceof MemoryWriteError) throw memoryRefusal(err.code, err.message);
        throw err;
      }
    };

    return {
      variant: "default",
      id: self.derive([project], (p) => p.id),
      name: self.derive([project], (p) => p.name),
      source: self.derive([project], (p) => p.source),
      replica: self.derive([project], (p) => p.replica),
      home: self.derive([project], (p) => p.home),
      defaultBranch: self.derive([project], (p) => p.defaultBranch ?? null),
      contextLoaded: self.derive([project], (p) => p.contextLoaded),
      graph,
      branches,
      memoryHead,
      memoryEntries: async () => memoryEntries(cfg, await readable()),
      memoryFile: async ({ path, change }) => memoryFile(cfg, await readable(), memoryPath(path), change),
      memoryHistory: async ({ before, limit, path }) => memoryHistory(cfg, await readable(), {
        ...(before === undefined ? {} : { before }),
        limit: Math.min(MEMORY_HISTORY_MAX, Math.max(1, Math.trunc(limit))),
        ...(path === undefined ? {} : { path: memoryPath(path) }),
      }),
      memoryDiff: async ({ change }) => memoryDiff(cfg, await readable(), change),
      olderGraph: async ({ limit }) => {
        const found = getProject(db, id);
        if (found === null) throw new ChordError("unavailable", `unknown: no project ${id}`);
        const probe = read?.probe ?? await graphProbe(cfg, found.replica, found.name, archivedOf(id));
        return olderGraph(cfg, found.replica, probe, Math.min(OLDER_GRAPH_MAX, Math.max(1, Math.trunc(limit))));
      },
      ...gated({
        writeMemory: ({ path, text, base }: { path: string; text: string; base: string | null }) => write(path, text, base),
        deleteMemory: ({ path, base }: { path: string; base: string | null }) => write(path, null, base),
      }, deps.inputHold),
    };
  });

  host.serve(TaskObject, ({ id }, _principal, self) => {
    const store = self.get(NodeStore, {});
    const members = TaskObject.def.variants.default.state;
    // From the row, not the task folder: a task that moved away has a row and nothing else.
    const manifest = self.state("manifest", members.manifest, { init: () => manifestOf(id) });
    const state = self.state("state", members.state, { init: () => runner.state(id) });
    const move = self.state("move", members.move, { init: () => runner.moveState(id) });
    const movedTo = self.state("movedTo", members.movedTo, { init: () => getTask(db, id)?.moved_to ?? null });
    const archivedOn = self.state("archivedOn", members.archivedOn, { init: () => archivedOnNow(id) });
    const acceptance = self.state("acceptance", members.acceptance, { init: () => runner.acceptance(id) });
    const queue = self.state("queue", members.queue, { init: () => runner.queue(id) });
    const pending = self.state("pending", members.pending, { init: () => approvals.pending(id) });
    const queued = self.state("queued", members.queued, { init: () => runner.queued(id).map((p) => p.text) });
    const queuedPrompts = self.state("queuedPrompts", members.queuedPrompts, { init: () => runner.queued(id) });
    const log = self.state("log", TaskLogSchema, { init: () => taskLogNow(id) });
    const agentLog = self.state("agentLog", AgentLogSchema, { init: () => agentLogNow(id) });
    /** Whether a turn's Claude Code process is live: what an agent the log leaves running needs to be running. */
    const liveTurn = self.state("liveTurn", Type.Boolean(), { init: () => runner.liveQuery(id) !== null });
    const agents = self.derive([agentLog, liveTurn], (l, live) => servedAgents(l, live));
    const bookmarks = self.state("bookmarks", members.bookmarks, { init: () => taskBookmarksNow(id) });
    // Read once the object is up (`self.task` below), not before: a dashboard opens one per task it lists.
    const changes = self.state("changes", members.changes, { init: () => [] });
    const activityAt = self.state("activityAt", members.activityAt, { init: () => getTask(db, id)?.updated_at ?? "" });
    /** Brings `queue` up to the task's line row: what Accept, Unqueue, the user's input and an archive write, and a move brings. */
    const refreshQueue = (ctx: Ctx) => {
      const now = runner.queue(id);
      if (JSON.stringify(now) !== JSON.stringify(queue.value)) queue.replace(ctx, now);
    };
    /** Brings the manifest and the activity time up to the row (a rename, a restore). */
    const refreshRow = (ctx: Ctx) => {
      const row = getTask(db, id);
      if (row === null) return;
      if (row.manifest !== JSON.stringify(manifest.value)) manifest.replace(ctx, JSON.parse(row.manifest) as TaskManifest);
      if (row.updated_at !== activityAt.value) activityAt.replace(ctx, row.updated_at);
    };
    const refreshBookmarks = latest(() => taskBookmarksNow(id), bookmarks);
    /** The probe key (`changesProbeNow`) `changes` was last read in full at; null before, and after an incomplete read. */
    let probed: string | null = null;
    const refreshChanges = latest(async () => {
      const probe = await changesProbeNow(id);
      if (probe.key !== null && probe.key === probed) return changes.value;
      const { read, complete } = await taskChangesNow(id, probe, changes.value);
      // A project that failed is read again on the next trigger, whatever the probe says then.
      probed = complete ? probe.key : null;
      return read;
    }, changes);
    /**
     * Both read off the task's lines, so re-read on the same triggers. The bookmarks first: their listing imports what
     * was pushed into the replica's git.
     */
    const refreshLines = async (ctx: Ctx) => {
      await refreshBookmarks(ctx);
      await refreshChanges(ctx);
    };

    /** Follows the runner's live turn: its process ends before its `idle` state does, and starts after its `running`. */
    const refreshLiveTurn = (ctx: Ctx) => {
      const live = runner.liveQuery(id) !== null;
      if (live !== liveTurn.value) liveTurn.replace(ctx, live);
    };
    /** Brings the cells up to the runner, the approvals and the event log. */
    const catchUpLog = (ctx: Ctx) => {
      const fresh = listEvents(db, id, { fromSeq: log.value.lastSeq + 1 });
      if (fresh.length > 0) {
        log.replace(ctx, foldTaskLog(log.value, fresh));
        const agents = foldAgentLog(agentLog.value, fresh);
        if (agents !== agentLog.value) agentLog.replace(ctx, agents);
      }
      refreshLiveTurn(ctx);
    };
    self.on("events", events, (event, ctx) => { if (event.taskId === id) catchUpLog(ctx); });
    self.on("states", states, (event, ctx) => {
      if (event.taskId !== id) return;
      state.replace(ctx, event.state);
      const to = getTask(db, id)?.moved_to ?? null;
      if (to !== movedTo.value) movedTo.replace(ctx, to);
      const on = archivedOnNow(id);
      if (on !== archivedOn.value) archivedOn.replace(ctx, on);
      refreshRow(ctx);
      refreshLiveTurn(ctx);
      // A task received from another node comes with its line rows, and so its queue.
      refreshQueue(ctx);
      // A turn's end set (and pushed) them; a move fetched or forgot them.
      return refreshLines(ctx);
    });
    self.on("manifests", manifests, (event, ctx) => { if (event.taskId === id) refreshRow(ctx); });
    self.on("projects", projectChanges, (_event, ctx) => refreshLines(ctx));
    // What the agent bookmarks during a turn, or the user by hand, tells nothing: a slow re-read catches it.
    self.on("ticks", slowTicks, (_event, ctx) => refreshLines(ctx));
    self.on("moves", moves, (event, ctx) => { if (event.taskId === id) move.replace(ctx, event.move); });
    self.on("acceptances", acceptances, (event, ctx) => { if (event.taskId === id) acceptance.replace(ctx, runner.acceptance(id)); });
    self.on("queues", queueChanges, (event, ctx) => { if (event.taskId === id) refreshQueue(ctx); });
    self.on("approvals", approvalChanges, (_event, ctx) => pending.replace(ctx, approvals.pending(id)));
    /** Brings `queued` and `queuedPrompts` up to the runner. */
    const refreshQueued = (ctx: Ctx) => {
      const now = runner.queued(id);
      queued.replace(ctx, now.map((p) => p.text));
      queuedPrompts.replace(ctx, now);
    };
    self.on("queued", queuedChanges, (event, ctx) => { if (event.taskId === id) refreshQueued(ctx); });
    self.on("lives", lives, (event, ctx) => { if (event.taskId === id) refreshLiveTurn(ctx); });
    // What changed between the cells' init and the listeners starting.
    self.task(async (ctx) => {
      state.replace(ctx, runner.state(id));
      move.replace(ctx, runner.moveState(id));
      movedTo.replace(ctx, getTask(db, id)?.moved_to ?? null);
      archivedOn.replace(ctx, archivedOnNow(id));
      acceptance.replace(ctx, runner.acceptance(id));
      refreshQueue(ctx);
      pending.replace(ctx, approvals.pending(id));
      refreshQueued(ctx);
      refreshRow(ctx);
      catchUpLog(ctx);
      await refreshChanges(ctx);
    });

    const answer = (requestId: string, result: (req: PendingApproval) => PermissionResult) => {
      const req = approvals.pending(id).find((r) => r.requestId === requestId);
      if (req === undefined) throw new Error(`no pending request ${requestId}`);
      approvals.answer(requestId, result(req));
    };

    /** Task `id`'s projects for a read of its changes; refused while it is not live here. */
    const here = (): ManifestProject[] => {
      const row = getTask(db, id);
      if (row === null) throw new ChordError("unavailable", `unknown: no task ${id}`);
      if (row.state === "moved") throw new ChordError("unavailable", `moved: the task is on ${row.moved_to ?? "another node"}`);
      if (row.state === "archived") throw new ChordError("unavailable", `archived: the task is archived on ${row.archived_on ?? "a node"}`);
      return (JSON.parse(row.manifest) as TaskManifest).projects;
    };
    const projectOf = (projectId: string): ManifestProject => {
      const p = here().find((q) => q.id === projectId);
      if (p === undefined) throw new ChordError("invalid", `project: not a project of the task: ${JSON.stringify(projectId)}`);
      return p;
    };
    /**
     * A read of the task's changes, its refusals (`ChangesError`) with their code first, and jj's failures (an id that
     * is gone) as `jj: <jj's first line>`; any other failure as it is.
     */
    const read = async <T>(run: () => Promise<T>): Promise<T> => {
      try {
        return await run();
      } catch (err) {
        if (err instanceof ChangesError) throw new ChordError("invalid", err.message);
        if (err instanceof JjError) {
          const line = err.stderr.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? `exited with code ${err.code}`;
          throw new ChordError("invalid", `jj: ${line}`);
        }
        throw err;
      }
    };

    return gated({
      variant: "default",
      manifest,
      state,
      pending,
      queued,
      queuedPrompts,
      lastSeq: self.derive([log], (l) => l.lastSeq),
      permissionMode: self.derive([log], (l) => l.permissionMode),
      model: self.derive([store.chosenModels], (c) => c[id] ?? null),
      effort: self.derive([store.efforts], (e) => e[id] ?? null),
      contextUsage: self.derive([log], (l) => l.contextUsage),
      agents,
      // Chord pushes a derived value only when it differs, so a progress frame leaves this alone for the sidebars.
      agentsRunning: self.derive([agents], (list) => runningCount(list)),
      context: self.derive([log], (l) => l.context),
      move,
      movedTo,
      archivedOn,
      acceptance,
      queue,
      bookmarks,
      changes,
      activityAt,
      prompt: async ({ text, attachments = [] }) => {
        if (text.trim() === "" && attachments.length === 0) throw new Error("a prompt needs text or an attachment");
        return { queued: (await runner.prompt(id, text, attachments)) === "queued" };
      },
      rename: async ({ title }) => { await runner.rename(id, title); },
      interrupt: () => runner.interrupt(id),
      sendNow: async () => { await runner.sendNow(id); },
      takeBackQueued: async () => ({ prompts: await runner.takeBackQueued(id) }),
      accept: () => runner.accept(id),
      unqueue: () => runner.unqueue(id, UNQUEUED_BY_USER),
      retry: () => runner.retry(id),
      approve: async ({ requestId, updatedInput }) => {
        answer(requestId, (req) => ({ behavior: "allow", updatedInput: updatedInput ?? req.input }));
      },
      deny: async ({ requestId, message, interrupt }) => {
        answer(requestId, () => ({ behavior: "deny", message, ...(interrupt !== undefined ? { interrupt } : {}) }));
      },
      answerQuestion: async ({ requestId, answers }) => {
        answer(requestId, (req) => ({ behavior: "allow", updatedInput: { ...req.input, answers } }));
      },
      setPermissionMode: ({ mode }) => runner.setPermissionMode(id, mode),
      setModel: ({ model }, ctx) => store.setModel({ taskId: id, ...(model === undefined ? {} : { model }) }, ctx),
      setEffort: ({ effort }, ctx) => store.setEffort({ taskId: id, effort }, ctx),
      moveTo: ({ nodeId, now }) => runner.moveTo(id, nodeId, now),
      cancelMove: () => runner.cancelMove(id),
      moveNow: async () => runner.hurryMove(id),
      archive: () => runner.archive(id),
      // Here (`"here"`, this node's id), on another node through a move from the archive, or (null) where placement says.
      restore: ({ node }) => runner.restore(id, node),
      delete: () => runner.deleteTask(id),
      // Reads: not held while an update awaits confirmation.
      changeDiff: ({ project, change, from }) => read(() => changeDiff(cfg, projectOf(project), change, from)),
      changeFile: ({ project, rev, path }) => read(() => changeFile(cfg, projectOf(project), rev, path)),
      workspaceFile: ({ path }) => read(() => workspaceFile(cfg, here(), id, path)),
    }, deps.inputHold, ["changeDiff", "changeFile", "workspaceFile"]);
  });

  host.serve(SessionObject, ({ taskId }, _principal, self) => {
    const view = self.state("view", SessionViewSchema, {
      init: () => {
        runner.state(taskId); // an unknown task fails the activation
        // The window's events, then the stream deltas after the newest of them, which make up `live`.
        const tail = listEventsTail(db, taskId, { limit: WINDOW_SIZE, excludeTypes: [...PROGRESS_KINDS] });
        const streaming = listEvents(db, taskId, { fromSeq: (tail.at(-1)?.seq ?? 0) + 1 });
        return foldSession(EMPTY_SESSION, [...tail, ...streaming]);
      },
    });
    const catchUp = (ctx: Ctx) => {
      const fresh = listEvents(db, taskId, { fromSeq: view.value.lastSeq + 1 });
      if (fresh.length > 0) view.replace(ctx, foldSession(view.value, fresh));
    };
    self.on("events", events, (event, ctx) => { if (event.taskId === taskId) catchUp(ctx); });
    self.task(async (ctx) => catchUp(ctx));

    return {
      variant: "default",
      window: self.derive([view], (v) => v.window),
      fromSeq: self.derive([view], (v) => v.window[0]?.seq ?? 0),
      live: self.derive([view], (v) => v.live),
      loadEarlier: async ({ beforeSeq, limit }) => {
        if (beforeSeq <= 1 || limit <= 0) return [];
        return listEventsTail(db, taskId, { beforeSeq, limit, excludeTypes: [...PROGRESS_KINDS] });
      },
    };
  });

  /** The node task `taskId` is archived on, while it is archived; null otherwise (and for a task with no row). */
  function archivedOnNow(taskId: string): string | null {
    const row = getTask(db, taskId);
    return row?.state === "archived" ? row.archived_on : null;
  }

  /**
   * Every local bookmark under task `taskId`'s namespace in each of its projects' replicas (the manifest's order); a
   * replica jj cannot list contributes none. Read without the repo lock, so a `TaskObject` never waits on a push.
   */
  async function taskBookmarksNow(taskId: string): Promise<Array<{ project: string; name: string; changeId: string }>> {
    const row = getTask(db, taskId);
    if (row === null) return [];
    const ns = taskNamespace(taskId);
    const found: Array<{ project: string; name: string; changeId: string }> = [];
    for (const p of (JSON.parse(row.manifest) as TaskManifest).projects) {
      const replica = getProject(db, p.id)?.replica;
      if (replica === undefined) continue;
      try {
        // Not under the repo lock (held across a push's network round trips), like `graph`: the listing never
        // snapshots, and what it catches mid-push the next trigger corrects.
        for (const b of await bookmarkList(replica, cfg)) {
          if (b.remote === null && b.name.startsWith(ns)) found.push({ project: p.id, name: b.name, changeId: b.changeId });
        }
      } catch {
        // listed again on the next trigger
      }
    }
    return found;
  }

  /**
   * Task `taskId`'s changes in each of its projects (the manifest's order), read off `probe` (`changesProbeNow`); []
   * while it is not live here (moved, archived). A project whose probe or read failed keeps its entry in `previous`
   * (`complete` false). Without the repo lock, like `taskBookmarksNow`: `taskChanges` never snapshots.
   */
  async function taskChangesNow(
    taskId: string, probe: ChangesProbes, previous: readonly ProjectChanges[],
  ): Promise<{ read: ProjectChanges[]; complete: boolean }> {
    if (probe.projects === null) return { read: [], complete: true };
    const all = await Promise.all(probe.projects.map(async ({ p, defaultBranch, probe: rows }) => {
      if (rows === null) return null;
      return taskChanges(cfg, p, taskId, { defaultBranch, probe: rows }).catch(() => null);
    }));
    const read = all.flatMap((c, i) => {
      if (c !== null) return [c];
      const kept = previous.find((q) => q.project === probe.projects![i]!.p.id);
      return kept === undefined ? [] : [kept];
    });
    return { read, complete: all.every((c) => c !== null) };
  }

  /**
   * What task `taskId`'s changes are read from: each project's `changesProbe` for its default branch, one jj call per
   * project, or null for one whose call failed; `projects` null while the task is not live here (or has no row). `key`
   * stands for them all, null when one failed (or there is no row), so that the changes are read then.
   */
  async function changesProbeNow(taskId: string): Promise<ChangesProbes> {
    const row = getTask(db, taskId);
    if (row === null) return { key: null, projects: null };
    // Its changes are [] then, whatever its lines are.
    if (row.state === "moved" || row.state === "archived") return { key: row.state, projects: null };
    const projects = await Promise.all((JSON.parse(row.manifest) as TaskManifest).projects.map(async (p) => {
      const defaultBranch = getProject(db, p.id)?.defaultBranch ?? null;
      const probe = await changesProbe(cfg, p, taskId, defaultBranch).catch(() => null);
      return { p, defaultBranch, probe };
    }));
    const key = projects.some((q) => q.probe === null) ? null : JSON.stringify(projects.map((q) => `${q.p.id} ${q.probe!.key}`));
    return { key, projects };
  }

  function manifestOf(taskId: string): TaskManifest {
    const row = getTask(db, taskId);
    if (row === null) throw new Error(`unknown task: ${taskId}`);
    return JSON.parse(row.manifest) as TaskManifest;
  }

  /** The tasks whose lines in project `projectId` are archived. */
  function archivedOf(projectId: string): Set<string> {
    return new Set(listLineRows(db, projectId).filter((r) => r.archived).map((r) => r.task));
  }

  /** Whether task `taskId` (its row's manifest) works in project `projectId`. */
  function taskHasProject(taskId: string, projectId: string): boolean {
    const row = getTask(db, taskId);
    if (row === null) return false;
    return (JSON.parse(row.manifest) as TaskManifest).projects.some((p) => p.id === projectId);
  }

  /**
   * Creates task `input.taskId` on member `target` (`PeerObject.createTaskAt`), its first prompt with it. Rejects
   * `<node> runs an older meddle` before sending a start with `parents` to a node that does not say it takes them, and
   * `CreationSent` once the request went out: the target may have made the task all the same.
   */
  async function createOn(
    target: string,
    input: {
      title: string; taskId: string; starts: Start[]; prompt: string | null; attachments?: Attachment[];
      nameFromPrompt: boolean; model?: string; effort?: string;
    },
  ): Promise<TaskManifest> {
    // A node older than `Start.parents` would start on the first parent alone: refused before anything is sent.
    const refusal = input.starts.some((s) => s.parents !== undefined) ? runner.noMergeStartsOn(target) : null;
    if (refusal !== null) throw new Error(refusal);
    const peer = await pool.peerRef(target, PeerObject);
    try {
      if (peer.variant !== "peer") throw new Error(`${shortId(target)} did not serve the peer variant of PeerObject`);
      try {
        return (await peer.createTaskAt(input)).manifest;
      } catch (err) {
        // Said here, the peer's reason (no task root, no usable token, …) would read as this node's own.
        throw new CreationSent(`${shortId(target)}: ${remoteReason(err)}`);
      }
    } finally {
      peer.release();
    }
  }

  /** Whether node `target` holds task `taskId` (`PeerObject.taskHeld`); null when it cannot say. */
  async function heldOn(target: string, taskId: string): Promise<boolean | null> {
    if (!pool.net.isOnline(target)) return null;
    let peer: Awaited<ReturnType<typeof pool.peerRef<typeof PeerObject>>>;
    try {
      peer = await pool.peerRef(target, PeerObject);
    } catch {
      return null;
    }
    try {
      return peer.variant === "peer" ? await peer.taskHeld({ id: taskId }) : null;
    } catch {
      return null;
    } finally {
      peer.release();
    }
  }

  /**
   * The node `place` picks for a new task of `projectIds`, from the roster and this node's live numbers; `withFiles`
   * (its first prompt has attachments), only a node that takes them.
   */
  async function placeTask(projectIds: string[], withFiles: boolean): Promise<string> {
    return runner.chooseNode(projectIds, withFiles ? (id) => runner.noAttachmentsOn(id) === null : undefined);
  }

  function projectIdsNow(): string[] {
    return listProjects(db).map((p) => p.id);
  }

  /** Each task's chosen model, from the tasks' stored settings. */
  function chosenModelsNow(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const t of listTasks(db)) {
      const { model } = getTaskSettings(db, t.id);
      if (model !== undefined) out[t.id] = model;
    }
    return out;
  }

  /** Each task's chosen effort, from the tasks' stored settings. */
  function effortsNow(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const t of listTasks(db)) {
      const { effort } = getTaskSettings(db, t.id);
      if (effort !== undefined) out[t.id] = effort;
    }
    return out;
  }

  /** A task's agents from its `task_*` and `turn_started` events alone, not its whole log. */
  function agentLogNow(taskId: string): AgentLog {
    return foldAgentLog(EMPTY_AGENT_LOG, listEventsOfKinds(db, taskId, AGENT_EVENT_KINDS));
  }

  /** A task's log summary from its newest `init`, mode-carrying `status` and `result` and its newest seq, not its whole log. */
  function taskLogNow(taskId: string): TaskLog {
    // Not every status carries a mode (compaction notices do not), so the newest status alone can hide a mode change.
    const latest = [
      latestEventOfType(db, taskId, "system", "init"),
      latestEventWithField(db, taskId, "system", "status", "permissionMode"),
      latestEventOfType(db, taskId, "result"),
      latestMainAssistant(db, taskId),
    ].filter((e) => e !== null).sort((a, b) => a.seq - b.seq);
    const log = foldTaskLog(EMPTY_TASK_LOG, latest);
    return { ...log, lastSeq: listEventsTail(db, taskId, { limit: 1 })[0]?.seq ?? 0 };
  }

  return host;
}

/** Whether this node holds a usable token now (`pickToken`), and when that token expires. */
async function tokenNow(cfg: NodeConfig, db: Database): Promise<{ present: boolean; expiresAt: string | null }> {
  const picked = await pickToken(cfg, db);
  if (picked === null) return { present: false, expiresAt: null };
  return { present: true, expiresAt: listTokens(db).find((t) => t.id === picked.id)?.expiresAt ?? null };
}

function questionText(req: PendingApproval): string {
  const questions = req.input.questions;
  const first = Array.isArray(questions) ? (questions[0] as { question?: unknown } | undefined)?.question : undefined;
  return typeof first === "string" ? first : "Claude has a question";
}

// ─── folding the event log into a task's log summary and a session's view ───

const EMPTY_TASK_LOG: TaskLog = { lastSeq: 0, permissionMode: null, contextUsage: null, context: null };

/**
 * `permissionMode` from the latest `system` `init` or `status`; `contextUsage` from the latest `result`; `context` from
 * the latest main-thread assistant message with usage that Claude Code did not make up (`latestMainAssistant`).
 */
function foldTaskLog(log: TaskLog, events: EventRecord[]): TaskLog {
  const next = { ...log };
  for (const { seq, message } of events) {
    next.lastSeq = seq;
    const m = message as Message;
    if (m.type === "system" && (m.subtype === "init" || m.subtype === "status")) {
      if (typeof m.permissionMode === "string") next.permissionMode = m.permissionMode;
    } else if (m.type === "result") {
      next.contextUsage = { usage: m.usage ?? null, modelUsage: m.modelUsage ?? null };
    } else if (m.type === "assistant") {
      const context = contextOf(m);
      if (context !== null) next.context = context;
    }
  }
  return next;
}

type Usage = { input_tokens?: unknown; cache_read_input_tokens?: unknown; cache_creation_input_tokens?: unknown };

/** The context a main-thread assistant message's call sent, or null for a subagent's, a synthetic one or no usage. */
function contextOf(m: Message): TaskLog["context"] {
  if (m.parent_tool_use_id != null) return null;
  const message = m.message as { model?: unknown; usage?: Usage | null } | undefined;
  const usage = message?.usage;
  if (usage === undefined || usage === null || message?.model === "<synthetic>") return null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    tokens: n(usage.input_tokens) + n(usage.cache_read_input_tokens) + n(usage.cache_creation_input_tokens),
    model: typeof message?.model === "string" ? message.model : null,
  };
}

const EMPTY_SESSION: SessionView = { lastSeq: 0, window: [], live: null };

type StreamEvent = {
  type?: string;
  content_block?: { type?: unknown; name?: unknown };
  delta?: { type?: string; text?: string; thinking?: string };
};

function isStreamEvent(e: EventRecord): boolean {
  return (e.message as Message).type === "stream_event";
}

/**
 * Appends events to the window (the newest `WINDOW_SIZE`, progress frames left out). A `stream_event`'s text or
 * thinking delta goes to `live` instead, and the start of a content block says which kind streams; the next other
 * event clears it.
 */
function foldSession(view: SessionView, events: EventRecord[]): SessionView {
  let window = view.window;
  let live = view.live;
  const added: SessionView["window"] = [];
  for (const e of events) {
    if (!isStreamEvent(e)) {
      if (isProgress(e.message as Message)) continue;
      added.push(e);
      live = null;
      continue;
    }
    const event = (e.message as { event?: StreamEvent }).event;
    if (event?.type === "content_block_start" && typeof event.content_block?.type === "string") {
      const { type, name } = event.content_block;
      live = { text: live?.text ?? "", thinking: live?.thinking ?? "", block: type };
      if (typeof name === "string") live.tool = name;
      continue;
    }
    const delta = event?.type === "content_block_delta" ? event.delta : undefined;
    if (delta?.type === "text_delta") live = { ...live, text: (live?.text ?? "") + (delta.text ?? ""), thinking: live?.thinking ?? "" };
    else if (delta?.type === "thinking_delta") live = { ...live, text: live?.text ?? "", thinking: (live?.thinking ?? "") + (delta.thinking ?? "") };
  }
  if (added.length > 0) window = [...window, ...added].slice(-WINDOW_SIZE);
  return { lastSeq: events.at(-1)?.seq ?? view.lastSeq, window, live };
}

/** A create sent to another node that failed: the target may have made the task all the same (its answer lost). */
class CreationSent extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CreationSent";
  }
}
