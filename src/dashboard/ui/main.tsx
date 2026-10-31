// The dashboard in the browser: a client host linked to the node over /ws, and the views over its objects.
import { createHost, webSocketLink, type Host, type Ref } from "@earendil-works/chord";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { NodeObject } from "../../state/contracts";
import { useObject } from "./hooks";
import { Notifications, Pool } from "./Pool";
import { Projects } from "./Projects";
import { Settings } from "./Settings";
import { Task } from "./Task";

type View = { name: "pool" } | { name: "task"; id: string } | { name: "projects" } | { name: "settings" };

const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
const host = createHost({
  name: "browser",
  self: "browser",
  kind: "client",
  upstream: { link: webSocketLink(socket), principal: "node", onProtocolMismatch: () => location.reload() },
});

/** The view a location hash names (`#/task/<id>`, `#/projects`, `#/settings`), the pool otherwise. */
function viewOf(hash: string): View {
  const [, name, id] = hash.split("/");
  if (name === "task" && id !== undefined && id !== "") return { name: "task", id: decodeURIComponent(id) };
  if (name === "projects" || name === "settings") return { name };
  return { name: "pool" };
}

function hashOf(view: View): string {
  return view.name === "task" ? `#/task/${encodeURIComponent(view.id)}` : `#/${view.name}`;
}

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
  const node = useObject(host, NodeObject, {});
  const open = (id: string) => setView({ name: "task", id });

  return (
    <>
      <nav>
        <strong>meddle</strong>
        <button class={view.name === "pool" ? "on" : ""} onClick={() => setView({ name: "pool" })}>Pool</button>
        <button class={view.name === "projects" ? "on" : ""} onClick={() => setView({ name: "projects" })}>Projects</button>
        <button class={view.name === "settings" ? "on" : ""} onClick={() => setView({ name: "settings" })}>Settings</button>
      </nav>
      {!connected && <p class="error">Disconnected from the node. Reload the page once it is running again.</p>}
      {node.error !== undefined && <p class="error">{node.error}</p>}
      {node.ref === undefined ? (node.error === undefined && <p class="muted">Connecting…</p>) : (
        <Body host={host} node={node.ref} view={view} open={open} />
      )}
    </>
  );
}

function Body({ host, node, view, open }: { host: Host; node: Ref<typeof NodeObject>; view: View; open: (id: string) => void }) {
  return (
    <main>
      <Notifications node={node} open={open} />
      {view.name === "pool" && <Pool host={host} node={node} open={open} />}
      {view.name === "task" && <Task key={view.id} host={host} node={node} taskId={view.id} />}
      {view.name === "projects" && <Projects host={host} node={node} />}
      {view.name === "settings" && <Settings node={node} />}
    </main>
  );
}

render(<App host={host} />, document.getElementById("app")!);
