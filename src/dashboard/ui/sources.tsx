// Gathers what the sidebar lists from every online node: its `NodeObject` (metrics, notifications) and each of its
// tasks, live and archived. The sources render nothing; they report up while their objects are reachable.
import type { Host, Ref } from "@earendil-works/chord";
import { useCallback, useEffect, useState } from "preact/hooks";
import { NodeObject, TaskObject } from "../../state/contracts";
import { type Hosts, useObject, useValue } from "./hooks";
import type { PoolRef, TaskRef } from "./common";
import type { TaskEntry } from "./sidebar-model";

export type NodeRef = Ref<typeof NodeObject>;
/** A listed task with the reference to act on it. */
export type ListedTask = TaskEntry & { ref: TaskRef };

export type PoolIndex = {
  tasks: ListedTask[];
  /** Each reachable node's `NodeObject`. */
  nodes: ReadonlyMap<string, NodeRef>;
};

type Report<T> = (key: string, value: T | null) => void;

function useReports<T>(): [ReadonlyMap<string, T>, Report<T>] {
  const [map, setMap] = useState<ReadonlyMap<string, T>>(() => new Map());
  const report = useCallback<Report<T>>((key, value) => setMap((prev) => {
    if (value === null ? !prev.has(key) : prev.get(key) === value) return prev;
    const next = new Map(prev);
    if (value === null) next.delete(key);
    else next.set(key, value);
    return next;
  }), []);
  return [map, report];
}

/** Every online node's tasks and `NodeObject`, and the sources gathering them (to render somewhere). */
export function usePoolIndex(hosts: Hosts, pool: PoolRef): { index: PoolIndex; sources: preact.JSX.Element } {
  const nodes = useValue(pool.nodes);
  const online = nodes.filter((n) => n.nodeId === hosts.selfId || (n.status === "member" && n.online));
  const [tasks, reportTask] = useReports<ListedTask>();
  const [nodeRefs, reportNode] = useReports<NodeRef>();
  const live = new Set(online.map((n) => n.nodeId));
  const index: PoolIndex = {
    tasks: [...tasks.values()].filter((t) => live.has(t.nodeId)),
    nodes: new Map([...nodeRefs].filter(([id]) => live.has(id))),
  };
  const sources = (
    <>
      {online.map((row) => {
        const host = hosts.for(row.nodeId);
        return host === undefined ? null : <NodeSource key={row.nodeId} host={host} nodeId={row.nodeId} reportNode={reportNode} reportTask={reportTask} />;
      })}
    </>
  );
  return { index, sources };
}

function NodeSource({ host, nodeId, reportNode, reportTask }: { host: Host; nodeId: string; reportNode: Report<NodeRef>; reportTask: Report<ListedTask> }) {
  const node = useObject(host, NodeObject, {});
  return node.ref === undefined ? null : <NodeSourceLoaded host={host} node={node.ref} nodeId={nodeId} reportNode={reportNode} reportTask={reportTask} />;
}

function NodeSourceLoaded({ host, node, nodeId, reportNode, reportTask }: {
  host: Host; node: NodeRef; nodeId: string; reportNode: Report<NodeRef>; reportTask: Report<ListedTask>;
}) {
  const taskIds = useValue(node.taskIds);
  const archivedIds = useValue(node.archivedIds);
  useEffect(() => {
    reportNode(nodeId, node);
    return () => reportNode(nodeId, null);
  }, [node, nodeId, reportNode]);
  return (
    <>
      {taskIds.map((id) => <TaskSource key={id} host={host} nodeId={nodeId} id={id} archived={false} report={reportTask} />)}
      {archivedIds.map((id) => <TaskSource key={`archived/${id}`} host={host} nodeId={nodeId} id={id} archived report={reportTask} />)}
    </>
  );
}

function TaskSource({ host, nodeId, id, archived, report }: { host: Host; nodeId: string; id: string; archived: boolean; report: Report<ListedTask> }) {
  const task = useObject(host, TaskObject, { id });
  return task.ref === undefined ? null : <TaskSourceLoaded task={task.ref} nodeId={nodeId} id={id} archived={archived} report={report} />;
}

function TaskSourceLoaded({ task, nodeId, id, archived, report }: { task: TaskRef; nodeId: string; id: string; archived: boolean; report: Report<ListedTask> }) {
  const manifest = useValue(task.manifest);
  const state = useValue(task.state);
  const pending = useValue(task.pending);
  const move = useValue(task.move);
  // A node of an older meddle has no `activityAt`: its tasks sort by creation.
  const activityAt = useOptionalValue(task, "activityAt") ?? "";
  useEffect(() => {
    const key = `${nodeId}/${archived ? "archived/" : ""}${id}`;
    report(key, {
      ref: task, nodeId, id, archived,
      title: manifest.title,
      projects: manifest.projects.map((p) => ({ id: p.id, name: p.name })),
      state,
      pending: pending.length,
      activityAt,
      createdAt: manifest.createdAt,
      moveTo: move?.to ?? null,
    });
    return () => report(key, null);
  }, [task, nodeId, id, archived, manifest, state, pending, move, activityAt, report]);
  return null;
}

/** A state member a node of an older meddle may not have: its value, or undefined there. */
function useOptionalValue(task: TaskRef, member: "activityAt"): string | undefined {
  const readable = (task as unknown as Record<string, unknown>)[member] as TaskRef["activityAt"] | undefined;
  const [, tick] = useState(0);
  useEffect(() => readable?.subscribe(() => tick((n) => n + 1)), [readable]);
  try {
    return readable?.value;
  } catch {
    return undefined;
  }
}
