// The dashboard in the browser: a client host linked to this node over /ws, one more per other node of the pool
// (over /ws/node/<nodeId>), the sidebar over every node's tasks, and the view the location hash names beside it.
import type { Host, Ref } from "@earendil-works/chord";
import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { NodeObject, PoolObject, type Notification } from "../../state/contracts";
import { clientHost, Hosts, nodeSocket, useAction, useObject, useValue } from "./hooks";
import { Nav, PaneHead, type PoolRef } from "./common";
import { NewTask } from "./NewTask";
import { NodePage } from "./NodePage";
import { AddProject, ProjectPage } from "./Projects";
import { hashOf, viewOf, type Open, type View } from "./routes";
import { Settings } from "./Settings";
import { Sidebar } from "./Sidebar";
import { homeTask } from "./sidebar-model";
import { type NodeRef, type PoolIndex, usePoolIndex } from "./sources";
import { TaskView } from "./Task";

const socket = nodeSocket("/ws");
// This node's own server changed its link protocol (it was upgraded): a reload picks up its new bundle.
const host = clientHost(socket, () => location.reload());

const NARROW = "(max-width: 760px)";
const SIDEBAR_KEY = "meddle.sidebar.hidden";

function sidebarHidden(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === "1";
  } catch {
    return false;
  }
}

function App({ host }: { host: Host }) {
  const [view, setView] = useState<View>(() => viewOf(location.hash));
  const [connected, setConnected] = useState(true);
  useEffect(() => socket.addEventListener("close", () => setConnected(false)), []);
  useEffect(() => {
    const follow = () => setView(viewOf(location.hash));
    addEventListener("hashchange", follow);
    return () => removeEventListener("hashchange", follow);
  }, []);
  const pool = useObject(host, PoolObject, {});
  const node = useObject(host, NodeObject, {});
  const error = pool.error ?? node.error ?? (pool.ref !== undefined && pool.ref.variant !== "default" ? "unexpected pool view" : undefined);
  const notice = !connected ? "Disconnected from the node. Reload the page once it is running again." : error;
  if (pool.ref === undefined || pool.ref.variant !== "default" || node.ref === undefined) {
    return <div class="boot">{notice === undefined ? <p class="muted">Connecting…</p> : <p class="error">{notice}</p>}</div>;
  }
  return <Shell host={host} pool={pool.ref} node={node.ref} view={view} notice={notice} />;
}

function Shell({ host, pool, node, view, notice }: { host: Host; pool: PoolRef; node: NodeRef; view: View; notice: string | undefined }) {
  const selfId = useValue(pool.self);
  const hosts = useMemo(() => new Hosts(selfId, host), [selfId, host]);
  // A node's host was dropped, its backoff ended or it is incompatible: render again, so the views ask anew.
  const [, tick] = useState(0);
  useEffect(() => hosts.onChange(() => tick((n) => n + 1)), [hosts]);
  const { index, sources } = usePoolIndex(hosts, pool);

  const [narrow, setNarrow] = useState(() => matchMedia(NARROW).matches);
  useEffect(() => {
    const media = matchMedia(NARROW);
    const change = () => setNarrow(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  const [hidden, setHidden] = useState(sidebarHidden);
  const [drawer, setDrawer] = useState(false);
  const open = narrow ? drawer : !hidden;
  const toggle = () => {
    if (narrow) return setDrawer(!drawer);
    try {
      localStorage.setItem(SIDEBAR_KEY, hidden ? "0" : "1");
    } catch {
      // a private window: remembered for this page only
    }
    setHidden(!hidden);
  };
  const openTask: Open = (nodeId, id) => { location.hash = hashOf({ name: "task", nodeId, id }); };

  return (
    <Nav.Provider value={{ open, toggle }}>
      {sources}
      <div class={`app${open ? "" : " nav-closed"}${narrow ? " narrow" : ""}`}>
        {open && <Sidebar pool={pool} index={index} view={view} selfId={selfId} onHide={toggle} onNavigate={() => setDrawer(false)} />}
        {narrow && drawer && <div class="scrim" onClick={() => setDrawer(false)} />}
        <main class="pane">
          {notice !== undefined && <p class="error notice">{notice}</p>}
          <Body hosts={hosts} pool={pool} node={node} index={index} view={view} open={openTask} />
        </main>
      </div>
      <Toasts index={index} pool={pool} open={openTask} />
    </Nav.Provider>
  );
}

function Body({ hosts, pool, node, index, view, open }: { hosts: Hosts; pool: PoolRef; node: NodeRef; index: PoolIndex; view: View; open: Open }) {
  switch (view.name) {
    case "home": return <Home hosts={hosts} pool={pool} index={index} open={open} />;
    case "task": return <TaskView key={`${view.nodeId}/${view.id}`} hosts={hosts} pool={pool} nodeId={view.nodeId} taskId={view.id} />;
    case "new": return <NewTask hosts={hosts} pool={pool} projectId={view.projectId} open={open} />;
    case "project": return <ProjectPage key={view.id} hosts={hosts} pool={pool} index={index} id={view.id} />;
    case "add-project": return <AddProject node={node} />;
    case "node": return <NodePage key={view.nodeId} hosts={hosts} pool={pool} index={index} nodeId={view.nodeId} />;
    case "settings": return <Settings pool={pool} />;
  }
}

/** How long after opening home a task found waiting on you still opens instead: past it, you may be typing a new task. */
const HOME_SETTLE_MS = 3000;

/** Nothing chosen: the most recently active task waiting on you, found as the tasks come in; a new task otherwise. */
function Home({ hosts, pool, index, open }: { hosts: Hosts; pool: PoolRef; index: PoolIndex; open: Open }) {
  const [since] = useState(() => Date.now());
  const waiting = homeTask(index.tasks);
  const go = waiting !== null && Date.now() - since < HOME_SETTLE_MS;
  useEffect(() => {
    if (go) location.replace(hashOf({ name: "task", nodeId: waiting.nodeId, id: waiting.id }));
  }, [go, waiting?.nodeId, waiting?.id]);
  if (go) return <PaneHead><span class="muted">Opening…</span></PaneHead>;
  return <NewTask hosts={hosts} pool={pool} projectId={null} open={open} />;
}

// ─── notifications ───

/** The kinds that toast: what the sidebar's dots do not already say. */
const TOASTED: ReadonlySet<Notification["kind"]> = new Set(["failed", "move", "token"]);

/** Failed turns, moves and token trouble from every reachable node, newest first, each dismissable. */
function Toasts({ index, pool, open }: { index: PoolIndex; pool: PoolRef; open: Open }) {
  const nodes = useValue(pool.nodes);
  return (
    <div class="toasts">
      {[...index.nodes].map(([nodeId, ref]) => (
        <NodeToasts key={nodeId} nodeId={nodeId} node={ref} hostname={nodes.find((n) => n.nodeId === nodeId)?.hostname ?? ""} open={open} />
      ))}
    </div>
  );
}

function NodeToasts({ nodeId, node, hostname, open }: { nodeId: string; node: Ref<typeof NodeObject>; hostname: string; open: Open }) {
  const notes = useValue(node.notifications);
  const action = useAction();
  return (
    <>
      {notes.filter((n) => TOASTED.has(n.kind)).slice(-3).reverse().map((note) => (
        <div key={note.id} class={`toast ${note.kind}`}>
          <span class="toast-icon">{note.kind === "failed" ? "✕" : note.kind === "token" ? "⚠" : "⇄"}</span>
          <div class="toast-body">
            <a href={hashOf({ name: "task", nodeId, id: note.taskId })} onClick={(e) => { e.preventDefault(); open(nodeId, note.taskId); }}>{note.text}</a>
            <div class="muted">{hostname} · {new Date(note.at).toLocaleTimeString()}</div>
          </div>
          <button class="icon" title="Dismiss" disabled={action.busy} onClick={() => action.run(() => node.dismiss({ id: note.id }))}>×</button>
        </div>
      ))}
    </>
  );
}

render(<App host={host} />, document.getElementById("app")!);
