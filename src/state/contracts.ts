// The node's chord objects: what the dashboard and the CLI watch and steer over a link.
import Type from "typebox";
import { hostNamed, local, method, remote } from "@earendil-works/chord";

const Nullable = <S extends Type.TSchema>(schema: S) => Type.Union([schema, Type.Null()]);

export const TaskStateSchema = Type.Union([
  Type.Literal("idle"),
  Type.Literal("running"),
  Type.Literal("waiting"),
  /** Being moved here from another node: not live here until the sender activates it. */
  Type.Literal("receiving"),
  /** Being moved to another node: prompts are queued for it there. */
  Type.Literal("moving"),
  /** Moved to another node (`movedTo`); nothing of it is left here but its row. */
  Type.Literal("moved"),
  /** Archived on `archivedOn`: its rows and archive are there, its folder is not; it renders read-only. */
  Type.Literal("archived"),
]);

export const TaskManifestSchema = Type.Object({
  id: Type.String(),
  title: Type.String(),
  sessionId: Type.String(),
  projects: Type.Array(Type.Object({
    id: Type.String(),
    name: Type.String(),
    replica: Type.String(),
    workspace: Type.String(),
    parent: Type.String(),
  })),
  /** Null for a task without a project. */
  primaryProjectId: Nullable(Type.String()),
  createdAt: Type.String(),
});

export const PendingApprovalSchema = Type.Object({
  requestId: Type.String(),
  taskId: Type.String(),
  toolName: Type.String(),
  input: Type.Record(Type.String(), Type.Unknown()),
  toolUseId: Type.String(),
  decisionReason: Type.Optional(Type.String()),
  askedAt: Type.String(),
});

export const NodeMetricsSchema = Type.Object({
  at: Type.String(),
  serviceRssKb: Type.Number(),
  eventLoopLagMs: Type.Number(),
  tasks: Type.Record(Type.String(), Type.Object({ childRssKb: Type.Number(), totalRssKb: Type.Number() })),
  cores: Type.Number(),
  memTotalKb: Type.Number(),
  memAvailableKb: Type.Number(),
  load1: Type.Number(),
  diskFreeKb: Type.Number(),
});

export const NotificationSchema = Type.Object({
  id: Type.String(),
  at: Type.String(),
  taskId: Type.String(),
  kind: Type.Union([Type.Literal("approval"), Type.Literal("question"), Type.Literal("finished"), Type.Literal("failed"), Type.Literal("move"), Type.Literal("token")]),
  text: Type.String(),
});
export type Notification = Type.Static<typeof NotificationSchema>;

export const ProjectSourceSchema = Type.Union([
  Type.Object({ kind: Type.Literal("folder"), path: Type.String() }),
  Type.Object({ kind: Type.Literal("upstream"), url: Type.String() }),
]);

export const ProjectSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  source: ProjectSourceSchema,
  replica: Type.String(),
  /** The node id of the project's home. */
  home: Type.String(),
});

/** A project as another node sees it. */
export const ProjectInfoSchema = Type.Object({ id: Type.String(), name: Type.String(), home: Type.String() });

export const EventSchema = Type.Object({ seq: Type.Number(), message: Type.Unknown() });

export const PermissionModeSchema = Type.Union([
  Type.Literal("default"),
  Type.Literal("acceptEdits"),
  Type.Literal("bypassPermissions"),
  Type.Literal("plan"),
  Type.Literal("dontAsk"),
  Type.Literal("auto"),
]);

const nodeState = {
  /** This node's id in the pool. */
  nodeId: Type.String(),
  hostname: Type.String(),
  version: Type.String(),
  claudeCodeVersion: Type.String(),
  taskRoot: Type.String(),
  hostsTasks: Type.Boolean(),
  /** Why this node hosts no tasks (its task root, or jj or git missing from its PATH); null while it does. */
  hostingProblem: Nullable(Type.String()),
  metrics: Nullable(NodeMetricsSchema),
  /** Whether this node holds a usable token now (`pickToken`), and when that one expires. */
  token: Type.Object({ present: Type.Boolean(), expiresAt: Nullable(Type.String()) }),
  /** The tasks that live on this node (archived, moved and received-but-not-yet-active ones left out). */
  taskIds: Type.Array(Type.String()),
  /** The tasks archived on this node: their rows and archive are here, their folder is not. */
  archivedIds: Type.Array(Type.String()),
  projectIds: Type.Array(Type.String()),
  models: Type.Array(Type.String()),
  /** Newest last; the newest 50 are kept. */
  notifications: Type.Array(NotificationSchema),
};

const nodeMethods = {
  /**
   * Creates a task on the node `node` names: absent or null, the one placement picks (`place`); `"here"`, this node;
   * else that node id, a member of the pool. `prompt`, when given, starts its first turn there. `title` absent or
   * blank: Haiku's title for the prompt, else its first line, or two adjectives and a noun (`taskTitle`). Answers the manifest and the node the
   * task is on.
   */
  createTask: method(
    Type.Object({
      title: Type.Optional(Type.String()),
      projectIds: Type.Array(Type.String()),
      prompt: Type.Optional(Nullable(Type.String())),
      node: Type.Optional(Nullable(Type.String())),
    }),
    Type.Object({ manifest: TaskManifestSchema, nodeId: Type.String() }),
  ),
  addProjectFromFolder: method(Type.Object({ path: Type.String(), name: Type.Optional(Type.String()) }), ProjectSchema),
  addProjectFromUpstream: method(Type.Object({ url: Type.String(), name: Type.Optional(Type.String()) }), ProjectSchema),
  dismiss: method(Type.Object({ id: Type.String() })),
};

export const NodeObject = remote("meddle.node", {
  version: 1,
  input: Type.Object({}),
  host: hostNamed("node"),
  variants: { default: { state: nodeState, methods: nodeMethods } },
});

/**
 * The node's one shared copy of its state, for the host's lifetime: every `NodeObject` (one per principal) exposes it,
 * so viewers agree and notifications accumulate while nobody watches. `efforts` backs `TaskObject.effort`.
 */
export const NodeStore = local("meddle.node-store", {
  version: 1,
  input: Type.Object({}),
  members: {
    ...nodeState,
    ...nodeMethods,
    efforts: Type.Record(Type.String(), Type.String()),
    setEffort: method(Type.Object({ taskId: Type.String(), effort: Type.String() })),
  },
});

/** A bookmark of a project's replica: local (`remote` null) or a remote's; a conflicted one has `changeId` "". */
export const HeadSchema = Type.Object({ name: Type.String(), remote: Nullable(Type.String()), changeId: Type.String(), conflicted: Type.Boolean() });

export const ProjectObject = remote("meddle.project", {
  version: 1,
  input: Type.Object({ id: Type.String() }),
  host: hostNamed("node"),
  variants: {
    default: {
      state: {
        ...ProjectSchema.properties,
        contextLoaded: Type.Boolean(),
        /**
         * This node's replica's bookmarks, local and remote: re-read when projects change, when a task of the project
         * changes state, and every 60 s.
         */
        heads: Type.Array(HeadSchema),
      },
    },
  },
});

/** A local bookmark under a task's namespace (`meddle/task/<id>/`) in one project's replica; "" when conflicted. */
export const TaskBookmarkSchema = Type.Object({ project: Type.String(), name: Type.String(), changeId: Type.String() });

export const TaskObject = remote("meddle.task", {
  version: 1,
  input: Type.Object({ id: Type.String() }),
  host: hostNamed("node"),
  variants: {
    default: {
      state: {
        manifest: TaskManifestSchema,
        state: TaskStateSchema,
        pending: Type.Array(PendingApprovalSchema),
        lastSeq: Type.Number(),
        permissionMode: Nullable(Type.String()),
        model: Nullable(Type.String()),
        effort: Nullable(Type.String()),
        /** `usage` and `modelUsage` of the latest `result`. */
        contextUsage: Type.Unknown(),
        /** The task's move in progress: to which node, the step it is at, and the error failing it (if any). */
        move: Nullable(Type.Object({ to: Type.String(), phase: Type.String(), error: Nullable(Type.String()) })),
        /** The node a `moved` task went to. */
        movedTo: Nullable(Type.String()),
        /** The node an `archived` task was archived on (its archive is there); null for any other. */
        archivedOn: Nullable(Type.String()),
        /**
         * Every local bookmark under the task's namespace, per project (its id) in the manifest's order: the project's
         * own and the side bookmarks. Re-read like `ProjectObject.heads`: when projects change, when the task changes
         * state, and every 60 s.
         */
        bookmarks: Type.Array(TaskBookmarkSchema),
        /** When the task's row last changed (ISO): its state, settings or title; what the dashboard sorts by. */
        activityAt: Type.String(),
      },
      methods: {
        prompt: method(Type.Object({ text: Type.String() })),
        /** Renames the task; refused for a blank title and while it is not live here (moving, moved, archived). */
        rename: method(Type.Object({ title: Type.String() })),
        interrupt: method(Type.Object({})),
        /** Runs the task's turn again after repeated crashes parked it; rejects when no turn is parked. */
        retry: method(Type.Object({})),
        approve: method(Type.Object({ requestId: Type.String(), updatedInput: Type.Optional(Type.Record(Type.String(), Type.Unknown())) })),
        deny: method(Type.Object({ requestId: Type.String(), message: Type.String(), interrupt: Type.Optional(Type.Boolean()) })),
        answerQuestion: method(Type.Object({ requestId: Type.String(), answers: Type.Record(Type.String(), Type.String()) })),
        setPermissionMode: method(Type.Object({ mode: PermissionModeSchema })),
        setModel: method(Type.Object({ model: Type.Optional(Type.String()) })),
        setEffort: method(Type.Object({ effort: Type.String() })),
        /**
         * Moves the task to node `nodeId`; with `now`, a running turn is interrupted rather than waited for. Rejects
         * with the reason when the move is refused; resolves once it has started (`move` follows it).
         */
        moveTo: method(Type.Object({ nodeId: Type.String(), now: Type.Boolean() })),
        /**
         * Cancels the task's move while it waits for the turn or hands the task over: the task stays here, its turn
         * untouched. Rejects once the target has the task (`too late to cancel: …`) or when it is not moving.
         */
        cancelMove: method(Type.Object({})),
        /** Makes the task's move, while it waits for the running turn, interrupt the turn ("move now") instead. */
        moveNow: method(Type.Object({})),
        /**
         * Archives the idle task on its node: its folder goes, its rows stay, and on a node that is not a project's
         * home the task's bookmarks are pushed to the home first. Rejects with the reason when refused.
         */
        archive: method(Type.Object({})),
        /**
         * Restores an archived task: `node` null places it over the roster like a new task of its projects (nodes a
         * move would refuse left out); `"here"` or this node's id restores it on the node holding the archive; another
         * member's id moves it there from the archive. Answers the node it is on, or is on its way to.
         */
        restore: method(Type.Object({ node: Nullable(Type.String()) }), Type.Object({ nodeId: Type.String() })),
        /** Deletes an archived or moved task's rows and archive from its node; refused for any other. */
        delete: method(Type.Object({})),
      },
    },
  },
});

/**
 * Progress frames, as `type` or `type:subtype`: a stream delta, a spinner's thinking estimate, a tool's elapsed time,
 * the session going busy and idle. A session's window and the thread leave them out.
 */
export const PROGRESS_KINDS: readonly string[] = [
  "stream_event",
  "tool_progress",
  "system:thinking_tokens",
  "system:hook_progress",
  "system:task_progress",
  "system:session_state_changed",
];

/** Whether a message is one of the `PROGRESS_KINDS`. */
export function isProgress(m: { type?: unknown; subtype?: unknown }): boolean {
  return PROGRESS_KINDS.includes(typeof m.subtype === "string" ? `${String(m.type)}:${m.subtype}` : String(m.type));
}

/** What streams in a running turn after the last event in its log; null when nothing is streaming. */
const LiveSchema = Nullable(Type.Object({
  text: Type.String(),
  thinking: Type.String(),
  block: Type.Optional(Type.String()),
  tool: Type.Optional(Type.String()),
}));
export type Live = Type.Static<typeof LiveSchema>;

export const SessionObject = remote("meddle.session", {
  version: 1,
  input: Type.Object({ taskId: Type.String() }),
  host: hostNamed("node"),
  variants: {
    default: {
      state: {
        /** The newest 200 events, progress frames (`PROGRESS_KINDS`) left out. */
        window: Type.Array(EventSchema),
        /** The seq of the window's oldest event; 0 when it is empty. */
        fromSeq: Type.Number(),
        /**
         * Text and thinking streamed since the last event in the window, and the kind of content block streaming
         * (`thinking`, `text`, `tool_use`, …), with a tool call's name; a thinking block streams no text when the
         * API leaves it out. Older nodes send no `block`.
         */
        live: LiveSchema,
      },
      methods: {
        /** The newest `limit` events (no progress frames) before `beforeSeq`, oldest first. */
        loadEarlier: method(Type.Object({ beforeSeq: Type.Number(), limit: Type.Number() }), Type.Array(EventSchema)),
      },
    },
  },
});

// ─── the node host's private cells ───

/** A `ProjectObject`'s one cell, which its state members derive from. */
export const ProjectViewSchema = Type.Object({ ...ProjectSchema.properties, contextLoaded: Type.Boolean() });

/** What a `TaskObject` keeps from its task's event log. */
export const TaskLogSchema = Type.Object({
  lastSeq: Type.Number(),
  permissionMode: Nullable(Type.String()),
  model: Nullable(Type.String()),
  contextUsage: Type.Unknown(),
});
export type TaskLog = Type.Static<typeof TaskLogSchema>;

/** What a `SessionObject` keeps from its task's event log; `lastSeq` counts `stream_event`s too. */
export const SessionViewSchema = Type.Object({
  lastSeq: Type.Number(),
  window: Type.Array(EventSchema),
  live: LiveSchema,
});
export type SessionView = Type.Static<typeof SessionViewSchema>;

// ─── the pool ───

/** An iroh endpoint address in JSON form (`WireAddr`): `id` is the node id. */
export const WireAddrSchema = Type.Object({ id: Type.String(), relay: Nullable(Type.String()), direct: Type.Array(Type.String()) });

/**
 * What a node reports about itself to the rest of the pool (`NodeSummary`). `running`, `limit` and `projects` are
 * optional: an older meddle sends none of them, and they read as 0, 0 and [] (`withSummaryDefaults`).
 */
export const NodeSummarySchema = Type.Object({
  hostname: Type.String(),
  version: Type.String(),
  claudeCodeVersion: Type.String(),
  hostsTasks: Type.Boolean(),
  taskCount: Type.Number(),
  /** Tasks in state `running` or `waiting`. */
  running: Type.Optional(Type.Number()),
  /** How many tasks may run at once; 0 is no limit. */
  limit: Type.Optional(Type.Number()),
  /** Every project the node holds, its own and its replicas of others'. */
  projects: Type.Optional(Type.Array(ProjectInfoSchema)),
});

/** One node of the pool's roster (`RosterRow`). */
export const RosterRowSchema = Type.Object({
  nodeId: Type.String(),
  hostname: Type.String(),
  status: Type.Union([Type.Literal("member"), Type.Literal("removed")]),
  updatedAt: Type.String(),
  addedBy: Type.String(),
  summary: Nullable(NodeSummarySchema),
  lastSeenAt: Nullable(Type.String()),
  lastAddr: Nullable(WireAddrSchema),
  /** The newest report by a member of a connection with the node, and the address it saw (absent from older nodes). */
  reachedAt: Type.Optional(Nullable(Type.String())),
  reachedAddr: Type.Optional(Nullable(WireAddrSchema)),
});

/** One pool setting as replicated (`SettingRow`); `value: null` is an unset. */
export const SettingRowSchema = Type.Object({
  key: Type.String(),
  value: Nullable(Type.String()),
  updatedAt: Type.String(),
  setBy: Type.String(),
});

/**
 * One login token's metadata as replicated and shown (`TokenMeta` in src/token.ts), never its value. Plain strings, so
 * that one malformed row from a peer is dropped by `mergeTokens` rather than failing the whole state.
 */
export const TokenMetaSchema = Type.Object({
  id: Type.String(),
  label: Type.String(),
  setAt: Type.String(),
  setBy: Nullable(Type.String()),
  /** `ok`, `exhausted` (until `until`) or `disabled`. */
  status: Type.String(),
  until: Nullable(Type.String()),
  detail: Nullable(Type.String()),
  updatedAt: Type.String(),
  removed: Type.Boolean(),
  /** Where the token sits in the order (ascending); absent from a node of a meddle before ranks. */
  rank: Type.Optional(Type.Number()),
  expiresAt: Type.String(),
});

export const PoolNodeSchema = Type.Object({
  nodeId: Type.String(),
  hostname: Type.String(),
  status: Type.Union([Type.Literal("member"), Type.Literal("removed")]),
  online: Type.Boolean(),
  version: Type.String(),
  claudeCodeVersion: Type.String(),
  hostsTasks: Type.Boolean(),
  taskCount: Type.Number(),
  /** Tasks in state `running` or `waiting` (0 for a node of an older meddle). */
  running: Type.Number(),
  /** How many tasks may run at once; 0 is no limit (and what a node of an older meddle shows). */
  limit: Type.Number(),
  /** Every project the node holds ([] for a node of an older meddle). */
  projects: Type.Array(ProjectInfoSchema),
  lastSeenAt: Nullable(Type.String()),
  /**
   * Not heard of (no connection, no member reporting one, no lighthouse listing) for longer than the pool's
   * `roster.forget`: not dialed, and placement counts its work as lost. It rejoins by proving the secret.
   */
  gone: Type.Boolean(),
  /**
   * The connection this node holds with it, null when none (and for this node): the node id that dialed it and the
   * node's session on it. Two nodes hold the same connection when they agree on the dialer and each names the other's
   * session.
   */
  link: Type.Optional(Nullable(Type.Object({ dialer: Type.String(), session: Type.String() }))),
});

/** What one node asks of another (principal `peer:<nodeId>` only); bulk goes over `git` and `blob` streams. */
export const PeerObject = remote("meddle.peer", {
  version: 1,
  input: Type.Object({}),
  host: hostNamed("node"),
  variants: {
    peer: {
      state: {
        /** The projects this node holds, its own and its replicas of others'. */
        projects: Type.Array(ProjectInfoSchema),
        claudeCodeVersion: Type.String(),
        hostsTasks: Type.Boolean(),
      },
      methods: {
        /** The project with this id, or null when this node does not hold it. */
        projectInfo: method(Type.Object({ id: Type.String() }), Nullable(ProjectInfoSchema)),
        /**
         * Prepares to receive a task from the caller: fetches its bookmarks from the caller and provisions it as
         * `receiving`. `ok: false` says why it was refused (versions, no task root, a task already here, …).
         */
        receiveTask: method(
          Type.Object({ manifest: TaskManifestSchema, claudeCodeVersion: Type.String() }),
          Type.Object({ ok: Type.Boolean(), reason: Type.Optional(Type.String()) }),
        ),
        /** Makes a task received from the caller live here, running `followUp` and its queued prompts one turn each. */
        activateTask: method(Type.Object({ taskId: Type.String(), followUp: Nullable(Type.String()) }), Type.Object({ ok: Type.Boolean() })),
        /** Removes a task still being received from the caller. */
        abandonTask: method(Type.Object({ taskId: Type.String() })),
        /**
         * Creates a task here for the caller (a member; anyone else is refused `forbidden`), then starts its first
         * turn with `prompt` when one is given. Refused like a local create: no task root, no usable token, ….
         */
        createTask: method(
          Type.Object({ title: Type.String(), projectIds: Type.Array(Type.String()), prompt: Nullable(Type.String()) }),
          Type.Object({ manifest: TaskManifestSchema }),
        ),
      },
    },
  },
});

export const PoolObject = remote("meddle.pool", {
  version: 1,
  input: Type.Object({}),
  host: hostNamed("node"),
  variants: {
    /** Dashboards and the CLI (principal `local`, `cli`, …). */
    default: {
      state: {
        /** The pool's id (the public key its name and secret derive), or "" while this node has no pool secret. */
        poolId: Type.String(),
        poolName: Type.String(),
        self: Type.String(),
        /** This node's session: its process, as its proofs to other nodes name it. */
        session: Type.Optional(Type.String()),
        nodes: Type.Array(PoolNodeSchema),
        /** The login tokens in the order turns try them, removed ones left out. */
        tokens: Type.Array(TokenMetaSchema),
        /** The token a turn starting now would use on this node, or null when none is usable. */
        activeTokenId: Nullable(Type.String()),
        /** Members report more than one meddle or Claude Code version. */
        mixedVersions: Type.Boolean(),
        /** The pool's settings with a value, by key, with the node that last set each and when. */
        settings: Type.Array(
          Type.Object({ key: Type.String(), value: Type.String(), setBy: Type.String(), updatedAt: Type.String() }),
        ),
      },
      methods: {
        /** The pool row or the roster changed on this node (the CLI wrote it): re-read it and act on it. */
        poolChanged: method(Type.Object({})),
        /** Removes a node from the pool: every member cuts it off and refuses it until it is allowed again. */
        remove: method(Type.Object({ nodeId: Type.String() })),
        /** Makes a removed node a member again, for the whole pool. */
        allow: method(Type.Object({ nodeId: Type.String() })),
        /** The tokens changed on this node (written by the CLI); re-read them and tell the pool. */
        tokenChanged: method(Type.Object({})),
        /**
         * Makes the token with this full id usable again (`ok`, its `until` and `detail` cleared) and tells the pool;
         * refuses `no such token: <id>` for an id this node does not list or lists as removed
         * (`no such token` when it is not an id at all).
         */
        enableToken: method(Type.Object({ id: Type.String() })),
        /**
         * Puts the token with full id `id` just before or just after the one with full id `before` or `after` (exactly
         * one of them) and tells the pool; refuses `give one of before and after`, `no such token: <id>` for an id this
         * node does not list or lists as removed (`no such token` when it is not an id at all), and
         * `cannot move a token before or after itself`.
         */
        moveToken: method(Type.Object({ id: Type.String(), before: Type.Optional(Type.String()), after: Type.Optional(Type.String()) })),
        /** Sets a pool setting; refuses an invalid key, a reserved env name or an invalid value. */
        setSetting: method(Type.Object({ key: Type.String(), value: Type.String() })),
        /** Unsets a pool setting. */
        unsetSetting: method(Type.Object({ key: Type.String() })),
      },
    },
    /** Other nodes (principal `peer:<nodeId>`). */
    peer: {
      state: {
        roster: Type.Array(RosterRowSchema),
        /** Every token row, removed ones included, so that a removal replicates. */
        tokens: Type.Array(TokenMetaSchema),
        settings: Type.Array(SettingRowSchema),
      },
      methods: {
        /** The value of a token this node lists (not removed); refuses non-members and any other id. */
        fetchToken: method(Type.Object({ id: Type.String() }), Type.Object({ value: Type.String() })),
      },
    },
  },
});
