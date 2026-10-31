// Serves the node's chord objects. State follows the runner, approvals and metrics through listeners on their
// events (each event a short root of its own); the database and the runner are the truth they are read from.
import { hostname } from "node:os";
import Type from "typebox";
import type { Database } from "bun:sqlite";
import { createHost, type Ctx, type Host, type Subscribable } from "@earendil-works/chord";
import type { PermissionResult, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { checkTaskRoot, type NodeConfig } from "../config";
import type { PendingApproval } from "../engine/approvals";
import { resultError, type MeddleEvent } from "../engine/session";
import type { MetricsSampler, NodeMetrics } from "../metrics";
import { loadContext } from "../projects/context";
import { addProjectFromFolder, addProjectFromUpstream, getProject, listProjects } from "../projects/project";
import { latestEventOfType, latestEventWithField, listEvents, listEventsTail, type EventRecord } from "../store/events";
import { getTaskSettings, listTasks } from "../store/records";
import type { TaskRunner, TaskState } from "../tasks/durable";
import { readManifest } from "../tasks/manifest";
import { tokenStatus } from "../token";
import { VERSION } from "../version";
import {
  NodeObject,
  NodeStore,
  ProjectObject,
  ProjectViewSchema,
  SessionObject,
  SessionViewSchema,
  TaskLogSchema,
  TaskObject,
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
};

type TaskEvent = { taskId: string; seq: number; message: SDKMessage | MeddleEvent };
type Message = { type?: unknown; subtype?: unknown; [key: string]: unknown };

const NOTIFICATIONS_KEPT = 50;
const WINDOW_SIZE = 200;

/** A host named `node` serving `NodeObject`, `ProjectObject`, `TaskObject` and `SessionObject`. */
export function createNodeHost(deps: NodeHostDeps): Host {
  const { cfg, db, runner, metrics } = deps;
  const approvals = runner.approvals;
  const events: Subscribable<TaskEvent> = {
    subscribe: (cb) => runner.onEvent((taskId, seq, message) => cb({ taskId, seq, message })),
  };
  const states: Subscribable<{ taskId: string; state: TaskState }> = {
    subscribe: (cb) => runner.onState((taskId, state) => cb({ taskId, state })),
  };
  const approvalChanges: Subscribable<null> = { subscribe: (cb) => approvals.onChange(() => cb(null)) };
  const samples: Subscribable<NodeMetrics> = { subscribe: (cb) => metrics.onSample(cb) };

  const host = createHost({ name: "node", self: "node" });

  host.serve(NodeStore, (_input, _principal, self) => {
    const taskIds = self.state("taskIds", NodeStore.def.members.taskIds, { init: () => listTasks(db).map((t) => t.id) });
    const projectIds = self.state("projectIds", NodeStore.def.members.projectIds, { init: projectIdsNow });
    const token = self.state("token", NodeStore.def.members.token, { init: () => tokenNow(cfg) });
    const metricsNow = self.state("metrics", NodeStore.def.members.metrics, { init: () => metrics.latest() });
    const hostsTasks = self.state("hostsTasks", NodeStore.def.members.hostsTasks, { init: async () => (await checkTaskRoot(cfg)).ok });
    const models = self.state("models", NodeStore.def.members.models, []);
    const notifications = self.state("notifications", NodeStore.def.members.notifications, []);
    const efforts = self.state("efforts", NodeStore.def.members.efforts, { init: effortsNow });
    /** Pending request ids already notified, so each request is announced once. */
    const announced = self.state("announced", Type.Array(Type.String()), []);

    const notify = (ctx: Ctx, n: Omit<Notification, "id" | "at">) => {
      const note = { id: crypto.randomUUID(), at: new Date().toISOString(), ...n };
      notifications.replace(ctx, [...notifications.value, note].slice(-NOTIFICATIONS_KEPT));
    };

    self.on("events", events, async ({ taskId, message }, ctx) => {
      const m = message as Message;
      if (m.type === "result") {
        const error = resultError(m);
        notify(ctx, error === null ? { taskId, kind: "finished", text: "Turn finished" } : { taskId, kind: "failed", text: `Turn ended: ${error}` });
      } else if (m.type === "meddle" && m.subtype === "turn_failed") {
        notify(ctx, { taskId, kind: "failed", text: `Turn failed: ${String(m.error)}` });
      } else if (m.type === "system" && m.subtype === "init") {
        // The turn's query is live from its first message on, so its model list is asked for here.
        const query = runner.liveQuery(taskId);
        if (query === null) return;
        try {
          const list = await query.supportedModels();
          models.replace(ctx, list.map((info) => info.value));
        } catch {
          // keep the previous list
        }
      }
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
      token.replace(ctx, await tokenNow(cfg));
    });

    return {
      hostname: self.state("hostname", NodeStore.def.members.hostname, hostname()),
      version: self.state("version", NodeStore.def.members.version, VERSION),
      claudeCodeVersion: self.state("claudeCodeVersion", NodeStore.def.members.claudeCodeVersion, deps.claudeCodeVersion),
      taskRoot: self.state("taskRoot", NodeStore.def.members.taskRoot, cfg.taskRoot),
      hostsTasks,
      metrics: metricsNow,
      token,
      taskIds,
      projectIds,
      models,
      notifications,
      efforts,
      createTask: async (input, ctx) => {
        const manifest = await runner.create(input);
        if (!taskIds.value.includes(manifest.id)) taskIds.replace(ctx, [...taskIds.value, manifest.id]);
        return manifest;
      },
      addProjectFromFolder: async ({ path, name }, ctx) => {
        const project = await addProjectFromFolder(cfg, db, path, name);
        projectIds.replace(ctx, projectIdsNow());
        return project;
      },
      addProjectFromUpstream: async ({ url, name }, ctx) => {
        const project = await addProjectFromUpstream(cfg, db, url, name);
        projectIds.replace(ctx, projectIdsNow());
        return project;
      },
      dismiss: ({ id }, ctx) => {
        notifications.replace(ctx, notifications.value.filter((n) => n.id !== id));
      },
      setEffort: async ({ taskId, effort }, ctx) => {
        await runner.setEffort(taskId, effort);
        efforts.replace(ctx, { ...efforts.value, [taskId]: effort });
      },
    };
  }, { lifetime: "host" });

  host.serve(NodeObject, (_input, _principal, self) => {
    const store = self.get(NodeStore, {});
    return {
      variant: "default",
      hostname: store.hostname,
      version: store.version,
      claudeCodeVersion: store.claudeCodeVersion,
      taskRoot: store.taskRoot,
      hostsTasks: store.hostsTasks,
      metrics: store.metrics,
      token: store.token,
      taskIds: store.taskIds,
      projectIds: store.projectIds,
      models: store.models,
      notifications: store.notifications,
      createTask: (input, ctx) => store.createTask(input, ctx),
      addProjectFromFolder: (input, ctx) => store.addProjectFromFolder(input, ctx),
      addProjectFromUpstream: (input, ctx) => store.addProjectFromUpstream(input, ctx),
      dismiss: (input, ctx) => store.dismiss(input, ctx),
    };
  });

  host.serve(ProjectObject, ({ id }, _principal, self) => {
    const project = self.state("project", ProjectViewSchema, {
      init: async () => {
        const found = getProject(db, id);
        if (found === null) throw new Error(`unknown project: ${id}`);
        let contextLoaded = true;
        try {
          await loadContext(found.replica);
        } catch {
          contextLoaded = false;
        }
        return { ...found, contextLoaded };
      },
    });
    return {
      variant: "default",
      id: self.derive([project], (p) => p.id),
      name: self.derive([project], (p) => p.name),
      source: self.derive([project], (p) => p.source),
      replica: self.derive([project], (p) => p.replica),
      contextLoaded: self.derive([project], (p) => p.contextLoaded),
    };
  });

  host.serve(TaskObject, ({ id }, _principal, self) => {
    const store = self.get(NodeStore, {});
    const members = TaskObject.def.variants.default.state;
    const manifest = self.state("manifest", members.manifest, { init: () => readManifest(cfg, id) });
    const state = self.state("state", members.state, { init: () => runner.state(id) });
    const pending = self.state("pending", members.pending, { init: () => approvals.pending(id) });
    const log = self.state("log", TaskLogSchema, { init: () => taskLogNow(id) });

    /** Brings the cells up to the runner, the approvals and the event log. */
    const catchUpLog = (ctx: Ctx) => {
      const fresh = listEvents(db, id, { fromSeq: log.value.lastSeq + 1 });
      if (fresh.length > 0) log.replace(ctx, foldTaskLog(log.value, fresh));
    };
    self.on("events", events, (event, ctx) => { if (event.taskId === id) catchUpLog(ctx); });
    self.on("states", states, (event, ctx) => { if (event.taskId === id) state.replace(ctx, event.state); });
    self.on("approvals", approvalChanges, (_event, ctx) => pending.replace(ctx, approvals.pending(id)));
    // What changed between the cells' init and the listeners starting.
    self.task(async (ctx) => {
      state.replace(ctx, runner.state(id));
      pending.replace(ctx, approvals.pending(id));
      catchUpLog(ctx);
    });

    const answer = (requestId: string, result: (req: PendingApproval) => PermissionResult) => {
      const req = approvals.pending(id).find((r) => r.requestId === requestId);
      if (req === undefined) throw new Error(`no pending request ${requestId}`);
      approvals.answer(requestId, result(req));
    };

    return {
      variant: "default",
      manifest,
      state,
      pending,
      lastSeq: self.derive([log], (l) => l.lastSeq),
      permissionMode: self.derive([log], (l) => l.permissionMode),
      model: self.derive([log], (l) => l.model),
      effort: self.derive([store.efforts], (e) => e[id] ?? null),
      contextUsage: self.derive([log], (l) => l.contextUsage),
      prompt: ({ text }) => runner.prompt(id, text),
      interrupt: () => runner.interrupt(id),
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
      setModel: ({ model }) => runner.setModel(id, model),
      setEffort: ({ effort }, ctx) => store.setEffort({ taskId: id, effort }, ctx),
    };
  });

  host.serve(SessionObject, ({ taskId }, _principal, self) => {
    const view = self.state("view", SessionViewSchema, {
      init: () => {
        runner.state(taskId); // an unknown task fails the activation
        // The window's events, then the stream deltas after the newest of them, which make up `live`.
        const tail = listEventsTail(db, taskId, { limit: WINDOW_SIZE, excludeTypes: ["stream_event"] });
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
        return listEventsTail(db, taskId, { beforeSeq, limit, excludeTypes: ["stream_event"] });
      },
    };
  });

  function projectIdsNow(): string[] {
    return listProjects(db).map((p) => p.id);
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

  /** A task's log summary from its newest `init`, mode-carrying `status` and `result` and its newest seq, not its whole log. */
  function taskLogNow(taskId: string): TaskLog {
    // Not every status carries a mode (compaction notices do not), so the newest status alone can hide a mode change.
    const latest = [
      latestEventOfType(db, taskId, "system", "init"),
      latestEventWithField(db, taskId, "system", "status", "permissionMode"),
      latestEventOfType(db, taskId, "result"),
    ].filter((e) => e !== null).sort((a, b) => a.seq - b.seq);
    const log = foldTaskLog(EMPTY_TASK_LOG, latest);
    return { ...log, lastSeq: listEventsTail(db, taskId, { limit: 1 })[0]?.seq ?? 0 };
  }

  return host;
}

async function tokenNow(cfg: NodeConfig): Promise<{ present: boolean; expiresAt: string | null }> {
  const status = await tokenStatus(cfg);
  return { present: status.present, expiresAt: status.expiresAt ?? null };
}

function questionText(req: PendingApproval): string {
  const questions = req.input.questions;
  const first = Array.isArray(questions) ? (questions[0] as { question?: unknown } | undefined)?.question : undefined;
  return typeof first === "string" ? first : "Claude has a question";
}

// ─── folding the event log into a task's log summary and a session's view ───

const EMPTY_TASK_LOG: TaskLog = { lastSeq: 0, permissionMode: null, model: null, contextUsage: null };

/** `permissionMode` and `model` from the latest `system` `init` or `status`; `contextUsage` from the latest `result`. */
function foldTaskLog(log: TaskLog, events: EventRecord[]): TaskLog {
  const next = { ...log };
  for (const { seq, message } of events) {
    next.lastSeq = seq;
    const m = message as Message;
    if (m.type === "system" && (m.subtype === "init" || m.subtype === "status")) {
      if (typeof m.permissionMode === "string") next.permissionMode = m.permissionMode;
      if (typeof m.model === "string") next.model = m.model;
    } else if (m.type === "result") {
      next.contextUsage = { usage: m.usage ?? null, modelUsage: m.modelUsage ?? null };
    }
  }
  return next;
}

const EMPTY_SESSION: SessionView = { lastSeq: 0, window: [], live: null };

function isStreamEvent(e: EventRecord): boolean {
  return (e.message as Message).type === "stream_event";
}

/**
 * Appends events to the window (the newest `WINDOW_SIZE`, `stream_event`s left out). A `stream_event`'s text or
 * thinking delta goes to `live` instead, which the next other event clears.
 */
function foldSession(view: SessionView, events: EventRecord[]): SessionView {
  let window = view.window;
  let live = view.live;
  const added: SessionView["window"] = [];
  for (const e of events) {
    if (!isStreamEvent(e)) {
      added.push(e);
      live = null;
      continue;
    }
    const event = (e.message as { event?: { type?: string; delta?: { type?: string; text?: string; thinking?: string } } }).event;
    const delta = event?.type === "content_block_delta" ? event.delta : undefined;
    if (delta?.type === "text_delta") live = { text: (live?.text ?? "") + (delta.text ?? ""), thinking: live?.thinking ?? "" };
    else if (delta?.type === "thinking_delta") live = { text: live?.text ?? "", thinking: (live?.thinking ?? "") + (delta.thinking ?? "") };
  }
  if (added.length > 0) window = [...window, ...added].slice(-WINDOW_SIZE);
  return { lastSeq: events.at(-1)?.seq ?? view.lastSeq, window, live };
}
