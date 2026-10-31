// The dashboard in the browser: a client host linked to this node over /ws, one more per other node of the pool
// (over /ws/node/<nodeId>), and the views over their objects.
import type { Host, Ref } from "@earendil-works/chord";
import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { NodeObject, PoolObject } from "../../state/contracts";
import { shortId } from "../../pool/ids";
import { clientHost, Hosts, nodeSocket, useObject, useValue } from "./hooks";
import { Notifications, Pool, type PoolRef } from "./Pool";
import { Projects } from "./Projects";
import { hashOf, viewOf, type Open, type View } from "./routes";
import { Settings } from "./Settings";
import { Task } from "./Task";

type NodeRef = Ref<typeof NodeObject>;

const socket = nodeSocket("/ws");
const host = clientHost(socket);

function App({ host }: { host: Host }) {
  const [view, setViewState] = useState<View>(() => viewOf(location.hash));
  const setView = (next: View) => { location.hash = hashOf(next); };
  const [connected, setConnected] = useState(true);
  useEffect(() => socket.addEventListener("close", () => setConnected(false)), []);
  useEffect(() => {
    const follow = () => setViewState(viewOf(location.hash));
    addEventListener("hashchange", follow);
    return () => removeEventListener("hashchange", follow);
  }, []);
  const pool = useObject(host, PoolObject, {});
  const node = useObject(host, NodeObject, {});
  const open: Open = (nodeId, id) => setView({ name: "task", nodeId, id });
  const error = pool.error ?? node.error ?? (pool.ref !== undefined && pool.ref.variant !== "default" ? "unexpected pool view" : undefined);

  return (
    <>
      <nav>
        <strong>meddle</strong>
        <button class={view.name === "pool" ? "on" : ""} onClick={() => setView({ name: "pool" })}>Pool</button>
        <button class={view.name === "projects" ? "on" : ""} onClick={() => setView({ name: "projects" })}>Projects</button>
        <button class={view.name === "settings" ? "on" : ""} onClick={() => setView({ name: "settings" })}>Settings</button>
      </nav>
      {!connected && <p class="error">Disconnected from the node. Reload the page once it is running again.</p>}
      {error !== undefined && <p class="error">{error}</p>}
      {pool.ref === undefined || pool.ref.variant !== "default" || node.ref === undefined ? (error === undefined && <p class="muted">Connecting…</p>) : (
        <Body host={host} pool={pool.ref} node={node.ref} view={view} open={open} />
      )}
    </>
  );
}

function Body({ host, pool, node, view, open }: { host: Host; pool: PoolRef; node: NodeRef; view: View; open: Open }) {
  const selfId = useValue(pool.self);
  const hosts = useMemo(() => new Hosts(selfId, host), [selfId, host]);
  // A node's host was dropped: render again, so the views ask for a new one once that node is back online.
  const [, tick] = useState(0);
  useEffect(() => hosts.onClose(() => tick((n) => n + 1)), [hosts]);
  return (
    <main>
      <Notifications hosts={hosts} pool={pool} open={open} />
      {view.name === "pool" && <Pool hosts={hosts} pool={pool} open={open} />}
      {view.name === "task" && <TaskOn key={`${view.nodeId}/${view.id}`} hosts={hosts} pool={pool} nodeId={view.nodeId} taskId={view.id} />}
      {view.name === "projects" && <Projects host={host} node={node} />}
      {view.name === "settings" && <Settings pool={pool} />}
    </main>
  );
}

/** A task on any member: through that node's host while it is online. */
function TaskOn({ hosts, pool, nodeId, taskId }: { hosts: Hosts; pool: PoolRef; nodeId: string; taskId: string }) {
  const row = useValue(pool.nodes).find((n) => n.nodeId === nodeId);
  // This node's own tasks are always reachable over /ws.
  if (nodeId === hosts.selfId) return <TaskOnline host={hosts.for(nodeId)} taskId={taskId} />;
  if (row === undefined) return <p class="error">Node {shortId(nodeId)} is not in this pool.</p>;
  if (row.status === "removed") return <p class="error">{row.hostname} ({shortId(nodeId)}) was removed from the pool.</p>;
  if (!row.online) return <p class="muted">{row.hostname} ({shortId(nodeId)}) is offline; the task shows again once it is back.</p>;
  return <TaskOnline host={hosts.for(nodeId)} taskId={taskId} />;
}

function TaskOnline({ host, taskId }: { host: Host; taskId: string }) {
  const node = useObject(host, NodeObject, {});
  if (node.error !== undefined) return <p class="error">{node.error}</p>;
  if (node.ref === undefined) return <p class="muted">Loading task…</p>;
  return <Task host={host} node={node.ref} taskId={taskId} />;
}

render(<App host={host} />, document.getElementById("app")!);
