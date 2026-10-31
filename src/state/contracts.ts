// The node's chord objects: what the dashboard and the CLI watch and steer over a link.
import Type from "typebox";
import { hostNamed, local, method, remote } from "@earendil-works/chord";

const Nullable = <S extends Type.TSchema>(schema: S) => Type.Union([schema, Type.Null()]);

export const TaskStateSchema = Type.Union([
  Type.Literal("idle"),
  Type.Literal("running"),
  Type.Literal("waiting"),
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
  primaryProjectId: Type.String(),
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
  kind: Type.Union([Type.Literal("approval"), Type.Literal("question"), Type.Literal("finished"), Type.Literal("failed")]),
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
});

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
  metrics: Nullable(NodeMetricsSchema),
  token: Type.Object({ present: Type.Boolean(), expiresAt: Nullable(Type.String()) }),
  taskIds: Type.Array(Type.String()),
  projectIds: Type.Array(Type.String()),
  models: Type.Array(Type.String()),
  /** Newest last; the newest 50 are kept. */
  notifications: Type.Array(NotificationSchema),
};

const nodeMethods = {
  createTask: method(Type.Object({ title: Type.String(), projectIds: Type.Array(Type.String()) }), TaskManifestSchema),
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

export const ProjectObject = remote("meddle.project", {
  version: 1,
  input: Type.Object({ id: Type.String() }),
  host: hostNamed("node"),
  variants: {
    default: {
      state: { ...ProjectSchema.properties, contextLoaded: Type.Boolean() },
    },
  },
});

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
      },
      methods: {
        prompt: method(Type.Object({ text: Type.String() })),
        interrupt: method(Type.Object({})),
        /** Runs the task's turn again after repeated crashes parked it; rejects when no turn is parked. */
        retry: method(Type.Object({})),
        approve: method(Type.Object({ requestId: Type.String(), updatedInput: Type.Optional(Type.Record(Type.String(), Type.Unknown())) })),
        deny: method(Type.Object({ requestId: Type.String(), message: Type.String(), interrupt: Type.Optional(Type.Boolean()) })),
        answerQuestion: method(Type.Object({ requestId: Type.String(), answers: Type.Record(Type.String(), Type.String()) })),
        setPermissionMode: method(Type.Object({ mode: PermissionModeSchema })),
        setModel: method(Type.Object({ model: Type.Optional(Type.String()) })),
        setEffort: method(Type.Object({ effort: Type.String() })),
      },
    },
  },
});

export const SessionObject = remote("meddle.session", {
  version: 1,
  input: Type.Object({ taskId: Type.String() }),
  host: hostNamed("node"),
  variants: {
    default: {
      state: {
        /** The newest 200 events, `stream_event`s left out. */
        window: Type.Array(EventSchema),
        /** The seq of the window's oldest event; 0 when it is empty. */
        fromSeq: Type.Number(),
        /** Text and thinking streamed since the last event in the window. */
        live: Nullable(Type.Object({ text: Type.String(), thinking: Type.String() })),
      },
      methods: {
        /** The newest `limit` events (no `stream_event`s) before `beforeSeq`, oldest first. */
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
  live: Nullable(Type.Object({ text: Type.String(), thinking: Type.String() })),
});
export type SessionView = Type.Static<typeof SessionViewSchema>;

// ─── the pool ───

/** An iroh endpoint address in JSON form (`WireAddr`): `id` is the node id. */
export const WireAddrSchema = Type.Object({ id: Type.String(), relay: Nullable(Type.String()), direct: Type.Array(Type.String()) });

/** What a node reports about itself to the rest of the pool (`NodeSummary`). */
export const NodeSummarySchema = Type.Object({
  hostname: Type.String(),
  version: Type.String(),
  claudeCodeVersion: Type.String(),
  hostsTasks: Type.Boolean(),
  taskCount: Type.Number(),
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
});

/** When the token was set and the node it came from (null: set on that node by hand). Never the value. */
export const TokenMetaSchema = Type.Object({ setAt: Type.String(), setBy: Nullable(Type.String()) });
export type TokenMeta = Type.Static<typeof TokenMetaSchema>;

export const PoolNodeSchema = Type.Object({
  nodeId: Type.String(),
  hostname: Type.String(),
  status: Type.Union([Type.Literal("member"), Type.Literal("removed")]),
  online: Type.Boolean(),
  version: Type.String(),
  claudeCodeVersion: Type.String(),
  hostsTasks: Type.Boolean(),
  taskCount: Type.Number(),
  lastSeenAt: Nullable(Type.String()),
});

export const PoolObject = remote("meddle.pool", {
  version: 1,
  input: Type.Object({}),
  host: hostNamed("node"),
  variants: {
    /** Dashboards and the CLI (principal `local`, `cli`, …). */
    default: {
      state: {
        poolId: Type.String(),
        self: Type.String(),
        nodes: Type.Array(PoolNodeSchema),
        token: Type.Object({
          present: Type.Boolean(),
          setAt: Nullable(Type.String()),
          setBy: Nullable(Type.String()),
          expiresAt: Nullable(Type.String()),
        }),
        /** Members report more than one meddle or Claude Code version. */
        mixedVersions: Type.Boolean(),
      },
      methods: {
        invite: method(Type.Object({}), Type.Object({ ticket: Type.String() })),
        join: method(Type.Object({ ticket: Type.String() }), Type.Object({ poolId: Type.String(), members: Type.Number() })),
        remove: method(Type.Object({ nodeId: Type.String() })),
        /** The token file changed on this node (written by the CLI); re-read it and tell the pool. */
        tokenChanged: method(Type.Object({})),
      },
    },
    /** Other nodes (principal `peer:<nodeId>`). */
    peer: {
      state: { roster: Type.Array(RosterRowSchema), token: Nullable(TokenMetaSchema) },
      methods: {
        fetchToken: method(Type.Object({}), Type.Object({ value: Type.String(), setAt: Type.String(), setBy: Nullable(Type.String()) })),
      },
    },
  },
});
