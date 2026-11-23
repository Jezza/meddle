// What the sidebar and the task view compute from the pool's tasks and nodes. Pure: no Preact, no DOM.
import { type ListedProject, type MoveCandidate, unknownVersion } from "./pool-model";

/** One task as the sidebar lists it: a `TaskObject`'s values on the node holding it. */
export type TaskEntry = {
  nodeId: string;
  id: string;
  title: string;
  projects: ReadonlyArray<{ id: string; name: string }>;
  state: string;
  /** Approvals and questions waiting on you. */
  pending: number;
  /** Sub-agents of the task running; 0 from a node that does not say. */
  agents: number;
  /** When the task's row last changed (ISO); "" from a node that does not say. */
  activityAt: string;
  createdAt: string;
  /** The node a move in progress takes it to. */
  moveTo: string | null;
  /** Listed among the node's archived tasks. */
  archived: boolean;
  /** Accepted and waiting on its project's train; false from a node that does not say. */
  queued: boolean;
  /** A merge task of the train (`TaskManifest.merge`): it checks a batch, and is not accepted itself. */
  merge: boolean;
};

export type SidebarProject<T extends TaskEntry = TaskEntry> = {
  id: string;
  name: string;
  tasks: T[];
  /** How many of its tasks are queued on its train. */
  queued: number;
};

export type SidebarGroups<T extends TaskEntry = TaskEntry> = {
  /** Every project, by name, each with its tasks that work in it alone. */
  projects: SidebarProject<T>[];
  /** Tasks with no project or several. */
  shared: T[];
  archived: T[];
};

/** Newest activity first (creation when a node does not say), then by id. */
function byActivity(a: TaskEntry, b: TaskEntry): number {
  const at = (t: TaskEntry) => t.activityAt || t.createdAt;
  return at(b).localeCompare(at(a)) || a.id.localeCompare(b.id);
}

/** Why a task cannot be restored: one of its projects was removed from the pool (`RemovedProjectsObject`); null when none was. */
export function restoreBlocked(projectIds: readonly string[], removed: ReadonlySet<string>): string | null {
  return projectIds.some((id) => removed.has(id)) ? "Project removed" : null;
}

/** The pool's tasks, each once: a task listed by two nodes (mid-move, or restored from an archive elsewhere) by its live entry over its archived one. */
export function uniqueTasks<T extends Pick<TaskEntry, "id" | "archived">>(tasks: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const t of tasks) {
    const known = byId.get(t.id);
    if (known === undefined || (known.archived && !t.archived)) byId.set(t.id, t);
  }
  return [...byId.values()];
}

/**
 * Sorts the pool's tasks into the sidebar's groups, each task once (`uniqueTasks`). A project a task names that no
 * online node lists still gets its group, under the task's name for it.
 */
export function groupTasks<T extends TaskEntry>(projects: readonly ListedProject[], tasks: readonly T[]): SidebarGroups<T> {
  const groups = new Map<string, SidebarProject<T>>(projects.map((p) => [p.id, { id: p.id, name: p.name, tasks: [], queued: 0 }]));
  const shared: T[] = [];
  const archived: T[] = [];
  for (const t of uniqueTasks(tasks)) {
    if (t.archived) archived.push(t);
    else if (t.projects.length === 1) {
      const p = t.projects[0]!;
      let group = groups.get(p.id);
      if (group === undefined) groups.set(p.id, (group = { id: p.id, name: p.name, tasks: [], queued: 0 }));
      group.tasks.push(t);
      if (t.queued) group.queued++;
    } else shared.push(t);
  }
  const sorted = [...groups.values()].sort((x, y) => x.name.localeCompare(y.name) || x.id.localeCompare(y.id));
  for (const g of sorted) g.tasks.sort(byActivity);
  return { projects: sorted, shared: shared.sort(byActivity), archived: archived.sort(byActivity) };
}

/** Whether something of the task waits on you: an approval, a question. */
export function waitsOnYou(t: TaskEntry): boolean {
  return !t.archived && (t.pending > 0 || t.state === "waiting");
}

/** What opening the dashboard shows: the most recently active task waiting on you, else nothing (a new task). */
export function homeTask<T extends TaskEntry>(tasks: readonly T[]): T | null {
  return [...tasks].filter(waitsOnYou).sort(byActivity)[0] ?? null;
}

/** A node a task could be moved to, and if it cannot be, why. */
export type MoveChoice<N> = { node: N; reason: string | null };

/**
 * Every other member of the pool as a move target for a task on `from` (running Claude Code `version`), each with
 * why it cannot take the task (offline, hosting no tasks, another Claude Code version), the takers first.
 */
export function moveChoices<N extends MoveCandidate & { hostname: string }>(nodes: readonly N[], from: string, version: string): MoveChoice<N>[] {
  const choices = nodes
    .filter((n) => n.nodeId !== from && n.status === "member")
    .map((node): MoveChoice<N> => {
      const reason = !node.online ? "offline"
        : !node.hostsTasks ? "hosts no tasks"
        : unknownVersion(version) || unknownVersion(node.claudeCodeVersion) ? "Claude Code version unknown"
        : node.claudeCodeVersion !== version ? `Claude Code ${node.claudeCodeVersion} ≠ ${version}`
        : null;
      return { node, reason };
    });
  return [...choices.filter((c) => c.reason === null), ...choices.filter((c) => c.reason !== null)];
}

/** A pool member as the sidebar's Nodes footer sums it up. */
export type NodeLine = {
  nodeId: string;
  online: boolean;
  running: number;
  lastSeenAt: string | null;
  gone: boolean;
};

/** The footer's line for a node: what runs there and its load, or since when it has been offline. */
export function nodeLineText(n: NodeLine, load: number | null, now: number): string {
  if (!n.online) {
    if (n.gone) return "gone";
    if (n.lastSeenAt === null) return "offline";
    return `offline ${ago(now - Date.parse(n.lastSeenAt))}`;
  }
  const work = n.running === 0 ? "idle" : `${n.running} running`;
  return load === null ? work : `${work} · load ${load.toFixed(1)}`;
}

/** A duration as its largest whole unit: `40s`, `12m`, `3h`, `2d`. */
export function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

/** A project of a task as the bar shows it: its own line's change id (null: none yet, or conflicted). */
export type ProjectLine = { name: string; workspace: string; changeId: string | null; conflicted: boolean };

/**
 * Each project of task `taskId`, in the manifest's order, with its own line: the bookmark `meddle/task/<id>/<name>`,
 * side lines (`<name>.before-<n>`) left out. A conflicted bookmark has `changeId` "".
 */
export function projectLines(
  taskId: string,
  projects: readonly { name: string; workspace: string }[],
  bookmarks: readonly { name: string; changeId: string }[],
): ProjectLine[] {
  return projects.map(({ name, workspace }) => {
    const own = bookmarks.find((b) => b.name === `meddle/task/${taskId}/${name}`);
    return { name, workspace, changeId: own === undefined || own.changeId === "" ? null : own.changeId, conflicted: own?.changeId === "" };
  });
}

type Usage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };

/**
 * The latest turn's tokens in short (`41k in · 2.1k out`), summed over its API calls as the `result` reports them;
 * null before a turn ended.
 */
export function usageShort(value: unknown): string | null {
  const { usage } = (value ?? {}) as { usage?: Usage | null };
  if (usage === undefined || usage === null) return null;
  const input = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  return `${tokens(input)} in · ${tokens(usage.output_tokens ?? 0)} out`;
}

/** A count in short: `412`, `2.1k`, `80k`, `1.4M`. */
export function tokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
