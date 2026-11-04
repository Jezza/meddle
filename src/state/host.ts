// Serves the node's chord objects. State follows the runner, approvals and metrics through listeners on their
// events (each event a short root of its own); the database and the runner are the truth they are read from.
import { hostname } from "node:os";
import Type from "typebox";
import type { Database } from "bun:sqlite";
import { createHost, forbidden, type Ctx, type Host, type Subscribable } from "@earendil-works/chord";
import type { PermissionResult, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { checkTaskRoot, type NodeConfig } from "../config";
import type { PendingApproval } from "../engine/approvals";
import { resultError, tokenFaultNotice, tokenFaultOf, type MeddleEvent, type TokenFault } from "../engine/session";
import type { MetricsSampler, NodeMetrics } from "../metrics";
import { peerOf, servePool } from "../pool/object";
import type { PoolRuntime } from "../pool/runtime";
import { acceptPeerLinks } from "../pool/sync";
import { bookmarkList } from "../jj";
import { loadContext } from "../projects/context";
import { addProjectFromFolder, addProjectFromUpstream, getProject, listProjects, projectChanges, type Project } from "../projects/project";
import { latestEventOfType, latestEventWithField, listEvents, listEventsTail, type EventRecord } from "../store/events";
import { claimHomelessProjects, getTask, getTaskSettings, listArchivedTasks, listLiveTasks, listTasks } from "../store/records";
import type { MoveState, TaskRunner, TaskState } from "../tasks/durable";
import { taskNamespace, type TaskManifest } from "../tasks/manifest";
import { taskTitle } from "../tasks/names";
import { shortId } from "../pool/ids";
import { listTokens, pickToken } from "../token";
import { VERSION } from "../version";
import {
  HeadSchema,
  NodeObject,
  NodeStore,
  PeerObject,
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
  /** The node's pool: served as `PoolObject`, and its members' chord links are accepted on this host. */
  pool: PoolRuntime;
};

type TaskEvent = { taskId: string; seq: number; message: SDKMessage | MeddleEvent };
type Message = { type?: unknown; subtype?: unknown; [key: string]: unknown };

const NOTIFICATIONS_KEPT = 50;
/** How often a `ProjectObject` re-reads its replica's bookmarks when nothing told it they changed (pushes from peers). */
const HEADS_REFRESH_MS = 60_000;
const WINDOW_SIZE = 200;

export type PeerObjectDeps = {
  db: Database;
  claudeCodeVersion: string;
  hostsTasks(): Promise<boolean>;
  /** Fires after a project was added or registered on this node. */
  changes: Subscribable<null>;
  /** Fires when this node's own state may have changed (each metrics sample, each pool change): `hostsTasks` is re-read. */
  recheck?: Subscribable<null>;
  /** Whether a node is a member of this node's pool: only a member may create a task here. */
  isMember(nodeId: string): boolean;
  /** Receives tasks other nodes move here (each call names the calling node), and creates tasks members place here. */
  runner: Pick<TaskRunner, "receiveTask" | "activateTask" | "abandonTask" | "create" | "prompt">;
};

/** A project as another node sees it. */
function projectInfo(p: Project): { id: string; name: string; home: string } {
  return { id: p.id, name: p.name, home: p.home };
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
      receiveTask: async ({ manifest, claudeCodeVersion }, ctx) => {
        const result = await deps.runner.receiveTask(manifest, from, claudeCodeVersion);
        await refreshHostsTasks(ctx);
        return result;
      },
      activateTask: ({ taskId, followUp }) => deps.runner.activateTask(taskId, from, followUp),
      abandonTask: ({ taskId }) => deps.runner.abandonTask(taskId, from),
      // Refused like a local create (no task root, no usable token, …) before any prompt is taken.
      createTask: async ({ title, projectIds, prompt }) => {
        if (!deps.isMember(from)) throw forbidden("members only");
        const manifest = await deps.runner.create({ title, projectIds });
        if (prompt !== null) await deps.runner.prompt(manifest.id, prompt);
        return { manifest };
      },
    };
  });
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
 * `PeerObject`. Projects from before projects had a home get this node as theirs. The runner is given the pool (a
 * no-op when it was built with it), so tasks created here replicate projects homed elsewhere.
 */
export function createNodeHost(deps: NodeHostDeps): Host {
  const { cfg, db, runner, metrics, pool } = deps;
  claimHomelessProjects(db, pool.identity.id);
  runner.attachPool(pool);
  const approvals = runner.approvals;
  const events: Subscribable<TaskEvent> = {
    subscribe: (cb) => runner.onEvent((taskId, seq, message) => cb({ taskId, seq, message })),
  };
  const states: Subscribable<{ taskId: string; state: TaskState }> = {
    subscribe: (cb) => runner.onState((taskId, state) => cb({ taskId, state })),
  };
  const manifests: Subscribable<{ taskId: string }> = {
    subscribe: (cb) => runner.onManifest((taskId) => cb({ taskId })),
  };
  const moves: Subscribable<{ taskId: string; move: MoveState | null }> = {
    subscribe: (cb) => runner.onMove((taskId, move) => cb({ taskId, move })),
  };
  const approvalChanges: Subscribable<null> = { subscribe: (cb) => approvals.onChange(() => cb(null)) };
  const samples: Subscribable<NodeMetrics> = { subscribe: (cb) => metrics.onSample(cb) };
  const poolChanges: Subscribable<null> = { subscribe: (cb) => pool.onChange(() => cb(null)) };
  const headTicks: Subscribable<null> = {
    subscribe: (cb) => {
      const timer = setInterval(() => cb(null), HEADS_REFRESH_MS);
      timer.unref();
      return () => clearInterval(timer);
    },
  };

  const host = createHost({ name: "node", self: "node" });
  servePool(host, pool.objectDeps);
  servePeer(host, {
    db,
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
    /** Tasks whose current turn's messages reported a token fault (until their next `turn_started`). */
    const faulted = new Set<string>();
    /** Tasks whose last event was a `token_fault` for no usable token: the `turn_failed` after it is the same failure. */
    const noTokenFailures = new Set<string>();
    /** Pending request ids already notified, so each request is announced once. */
    const announced = self.state("announced", Type.Array(Type.String()), []);

    /** The task root, jj and git can come and go while the node runs. */
    const refreshHostsTasks = async (ctx: Ctx) => {
      const check = await checkTaskRoot(cfg);
      if (ctx.signal.aborted) return;
      if (check.ok !== hostsTasks.value) hostsTasks.replace(ctx, check.ok);
      const problem = check.ok ? null : check.reason;
      if (problem !== hostingProblem.value) hostingProblem.replace(ctx, problem);
    };

    const notify = (ctx: Ctx, n: Omit<Notification, "id" | "at">) => {
      const note = { id: crypto.randomUUID(), at: new Date().toISOString(), ...n };
      notifications.replace(ctx, [...notifications.value, note].slice(-NOTIFICATIONS_KEPT));
    };

    self.on("events", events, async ({ taskId, message }, ctx) => {
      const m = message as Message;
      const afterNoToken = noTokenFailures.delete(taskId);
      if (tokenFaultOf(message as SDKMessage) !== null) faulted.add(taskId);
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
      token.replace(ctx, await tokenNow(cfg, db));
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
      taskIds,
      archivedIds,
      projectIds,
      models,
      notifications,
      efforts,
      createTask: async ({ title: given, projectIds: ids, prompt, node }, ctx) => {
        // Named here, before it goes anywhere, so that a peer of any version gets a title.
        const title = taskTitle(given, prompt);
        const selfId = pool.identity.id;
        const target = node === "here" ? selfId : node ?? await placeTask(ids);
        if (target === selfId) {
          const manifest = await runner.create({ title, projectIds: ids });
          if (!taskIds.value.includes(manifest.id)) taskIds.replace(ctx, [...taskIds.value, manifest.id]);
          // The pool sees the new task count now, not at the next periodic refresh.
          void pool.refresh();
          if (prompt !== undefined && prompt !== null) await runner.prompt(manifest.id, prompt);
          return { manifest, nodeId: selfId };
        }
        if (!pool.store.isMember(target)) throw new Error(`no such node: ${target}`);
        const peer = await pool.peerRef(target, PeerObject);
        try {
          if (peer.variant !== "peer") throw new Error(`${shortId(target)} did not serve the peer variant of PeerObject`);
          let manifest: TaskManifest;
          try {
            ({ manifest } = await peer.createTask({ title, projectIds: ids, prompt: prompt ?? null }));
          } catch (err) {
            // Said here, the peer's reason (no task root, no usable token, …) would read as this node's own.
            throw new Error(`${shortId(target)}: ${remoteReason(err)}`);
          }
          return { manifest, nodeId: target };
        } finally {
          peer.release();
        }
      },
      addProjectFromFolder: async ({ path, name }, ctx) => {
        const project = await addProjectFromFolder(cfg, db, path, pool.identity.id, name);
        projectIds.replace(ctx, projectIdsNow());
        return project;
      },
      addProjectFromUpstream: async ({ url, name }, ctx) => {
        const project = await addProjectFromUpstream(cfg, db, url, pool.identity.id, name);
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
      nodeId: store.nodeId,
      hostname: store.hostname,
      version: store.version,
      claudeCodeVersion: store.claudeCodeVersion,
      taskRoot: store.taskRoot,
      hostsTasks: store.hostsTasks,
      hostingProblem: store.hostingProblem,
      metrics: store.metrics,
      token: store.token,
      taskIds: store.taskIds,
      archivedIds: store.archivedIds,
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
    /** The replica's bookmarks; [] while (or whenever) jj cannot list them. */
    const headsNow = async () => {
      const found = getProject(db, id);
      if (found === null) return [];
      try {
        return await bookmarkList(found.replica, cfg);
      } catch {
        return [];
      }
    };
    const heads = self.state("heads", Type.Array(HeadSchema), { init: headsNow });
    const refreshHeads = latest(headsNow, heads);
    self.on("projects", projectChanges, (_event, ctx) => refreshHeads(ctx));
    // A task of this project changed state: a turn's end moved (and pushed) its bookmark, or a move fetched or forgot one.
    self.on("taskStates", states, ({ taskId }, ctx) => {
      if (taskHasProject(taskId, id)) return refreshHeads(ctx);
    });
    // Bookmarks a peer pushes into the replica's `.git`, or the user's git, tell nothing: a slow re-read (which imports
    // the git refs first) catches them.
    self.on("ticks", headTicks, (_event, ctx) => refreshHeads(ctx));
    return {
      variant: "default",
      id: self.derive([project], (p) => p.id),
      name: self.derive([project], (p) => p.name),
      source: self.derive([project], (p) => p.source),
      replica: self.derive([project], (p) => p.replica),
      home: self.derive([project], (p) => p.home),
      contextLoaded: self.derive([project], (p) => p.contextLoaded),
      heads,
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
    const pending = self.state("pending", members.pending, { init: () => approvals.pending(id) });
    const log = self.state("log", TaskLogSchema, { init: () => taskLogNow(id) });
    const bookmarks = self.state("bookmarks", members.bookmarks, { init: () => taskBookmarksNow(id) });
    const activityAt = self.state("activityAt", members.activityAt, { init: () => getTask(db, id)?.updated_at ?? "" });
    /** Brings the manifest and the activity time up to the row (a rename, a restore). */
    const refreshRow = (ctx: Ctx) => {
      const row = getTask(db, id);
      if (row === null) return;
      if (row.manifest !== JSON.stringify(manifest.value)) manifest.replace(ctx, JSON.parse(row.manifest) as TaskManifest);
      if (row.updated_at !== activityAt.value) activityAt.replace(ctx, row.updated_at);
    };
    const refreshBookmarks = latest(() => taskBookmarksNow(id), bookmarks);

    /** Brings the cells up to the runner, the approvals and the event log. */
    const catchUpLog = (ctx: Ctx) => {
      const fresh = listEvents(db, id, { fromSeq: log.value.lastSeq + 1 });
      if (fresh.length > 0) log.replace(ctx, foldTaskLog(log.value, fresh));
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
      // A turn's end set (and pushed) them; a move fetched or forgot them.
      return refreshBookmarks(ctx);
    });
    self.on("manifests", manifests, (event, ctx) => { if (event.taskId === id) refreshRow(ctx); });
    self.on("projects", projectChanges, (_event, ctx) => refreshBookmarks(ctx));
    // What the agent bookmarks during a turn, or the user by hand, tells nothing: a slow re-read catches it.
    self.on("ticks", headTicks, (_event, ctx) => refreshBookmarks(ctx));
    self.on("moves", moves, (event, ctx) => { if (event.taskId === id) move.replace(ctx, event.move); });
    self.on("approvals", approvalChanges, (_event, ctx) => pending.replace(ctx, approvals.pending(id)));
    // What changed between the cells' init and the listeners starting.
    self.task(async (ctx) => {
      state.replace(ctx, runner.state(id));
      move.replace(ctx, runner.moveState(id));
      movedTo.replace(ctx, getTask(db, id)?.moved_to ?? null);
      archivedOn.replace(ctx, archivedOnNow(id));
      pending.replace(ctx, approvals.pending(id));
      refreshRow(ctx);
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
      move,
      movedTo,
      archivedOn,
      bookmarks,
      activityAt,
      prompt: ({ text }) => runner.prompt(id, text),
      rename: async ({ title }) => { await runner.rename(id, title); },
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
      moveTo: ({ nodeId, now }) => runner.moveTo(id, nodeId, now),
      cancelMove: () => runner.cancelMove(id),
      moveNow: async () => runner.hurryMove(id),
      archive: () => runner.archive(id),
      // Here (`"here"`, this node's id), on another node through a move from the archive, or (null) where placement says.
      restore: ({ node }) => runner.restore(id, node),
      delete: () => runner.deleteTask(id),
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
        // Not under the repo lock (held across a push's network round trips), like `heads`: the listing never
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

  function manifestOf(taskId: string): TaskManifest {
    const row = getTask(db, taskId);
    if (row === null) throw new Error(`unknown task: ${taskId}`);
    return JSON.parse(row.manifest) as TaskManifest;
  }

  /** Whether task `taskId` (its row's manifest) works in project `projectId`. */
  function taskHasProject(taskId: string, projectId: string): boolean {
    const row = getTask(db, taskId);
    if (row === null) return false;
    return (JSON.parse(row.manifest) as TaskManifest).projects.some((p) => p.id === projectId);
  }

  /** The node `place` picks for a new task of `projectIds`, from the roster and this node's live numbers. */
  async function placeTask(projectIds: string[]): Promise<string> {
    return runner.chooseNode(projectIds);
  }

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

/** A peer's error as it said it: without the `<code>: ` (or `<code>/<reason>: `) a chord error's message starts with. */
function remoteReason(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && err.message.startsWith(code)) return err.message.replace(/^[^:]*: /, "");
  return err.message;
}
