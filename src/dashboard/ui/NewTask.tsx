// A new task: the composer is the form. Its projects (the one it was opened under, more added), the node (Automatic,
// where placement picks, or one that hosts tasks), and its first prompt; Start creates it through this node and opens it.
import type { Ref } from "@earendil-works/chord";
import { useEffect, useRef, useState } from "preact/hooks";
import { NodeObject } from "../../state/contracts";
import { type Hosts, useAction, useObject, useValue } from "./hooks";
import { type Anchor, MenuItem, nodeMeta, PaneHead, type PoolRef, Popover, Unavailable } from "./common";
import { projectChoices } from "./pool-model";
import type { Open } from "./routes";

type NodeRef = Ref<typeof NodeObject>;

export function NewTask({ hosts, pool, projectId, open }: { hosts: Hosts; pool: PoolRef; projectId: string | null; open: Open }) {
  const host = hosts.selfHost;
  const node = useObject(host, NodeObject, {});
  const nodes = useValue(pool.nodes);
  const canHost = nodes.filter((n) => n.status === "member" && n.online && n.hostsTasks);
  const head = <PaneHead><strong>New task</strong></PaneHead>;
  if (canHost.length === 0) return <>{head}<p class="pane-note muted">No online node hosts tasks.</p></>;
  if (node.error !== undefined) return <>{head}<p class="pane-note error">{node.error}</p></>;
  if (node.ref === undefined) return <>{head}<div class="pane-note"><Unavailable status={hosts.status(hosts.selfId)} /></div></>;
  return <NewTaskForm key={projectId ?? ""} node={node.ref} pool={pool} projectId={projectId} open={open} />;
}

function NewTaskForm({ node, pool, projectId, open }: { node: NodeRef; pool: PoolRef; projectId: string | null; open: Open }) {
  const nodes = useValue(pool.nodes);
  const projects = projectChoices(nodes);
  const canHost = nodes.filter((n) => n.status === "member" && n.online && n.hostsTasks);
  const [chosen, setChosen] = useState<string[]>(() => (projectId === null ? [] : [projectId]));
  const [prompt, setPrompt] = useState("");
  /** The node picked; null for Automatic. */
  const [picked, setPicked] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ kind: "project" | "node"; anchor: Anchor } | null>(null);
  const action = useAction();
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => input.current?.focus(), []);
  // A node that went offline (or stopped hosting tasks) since it was picked falls back to Automatic.
  const where = canHost.find((n) => n.nodeId === picked) ?? null;
  const nameOf = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
  const lead = chosen.length === 0 ? null : nameOf(chosen[0]!);

  const start = async () => {
    if (prompt.trim() === "" || action.busy) return;
    let created: { taskId: string; nodeId: string } | undefined;
    const ok = await action.run(async () => {
      const { manifest, nodeId } = await node.createTask({ projects: chosen.map((id) => ({ id })), node: where?.nodeId ?? null, prompt });
      created = { taskId: manifest.id, nodeId };
    });
    if (ok && created !== undefined) open(created.nodeId, created.taskId);
  };

  return (
    <div class="task">
      <PaneHead><strong>New task</strong></PaneHead>
      <div class="new-empty">
        {lead === null ? <span>New task</span> : <span>New task in <b>{lead}</b>{chosen.length > 1 && ` and ${chosen.length - 1} more`}</span>}
      </div>
      <div class="composer">
        <textarea ref={input} rows={4} value={prompt} placeholder="What should Claude do?"
          onInput={(e) => setPrompt(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void start(); } }} />
        <div class="composer-row">
          {chosen.map((id) => (
            <span key={id} class="pill">◉ {nameOf(id)}
              <button class="x" title="Remove" onClick={() => setChosen(chosen.filter((c) => c !== id))}>×</button>
            </span>
          ))}
          <button class="pill add" disabled={projects.length === chosen.length} onClick={(e) => setMenu({ kind: "project", anchor: { el: e.currentTarget, above: true } })}>＋ project</button>
          <button class="pill" title="Where the task runs" onClick={(e) => setMenu({ kind: "node", anchor: { el: e.currentTarget, above: true } })}>
            ⌂ {where === null ? "Automatic" : where.hostname} ▾
          </button>
          <span class="bar-gap" />
          {action.error !== null && <span class="error">{action.error}</span>}
          <button class="primary" disabled={action.busy || prompt.trim() === ""} onClick={() => void start()} title="Ctrl+Enter">
            {action.busy ? "Starting…" : "Start"}
          </button>
        </div>
      </div>
      {menu?.kind === "project" && (
        <Popover anchor={menu.anchor} onClose={() => setMenu(null)}>
          <div class="menu-head">Add a project</div>
          {projects.filter((p) => !chosen.includes(p.id)).map((p) => (
            <MenuItem key={p.id} title={p.id} onClick={() => { setChosen([...chosen, p.id]); setMenu(null); }}>{p.name}</MenuItem>
          ))}
        </Popover>
      )}
      {menu?.kind === "node" && (
        <Popover anchor={menu.anchor} onClose={() => setMenu(null)} wide>
          <div class="menu-head">Run on</div>
          <MenuItem onClick={() => { setPicked(null); setMenu(null); }} meta="placement picks">Automatic</MenuItem>
          {canHost.map((n) => (
            <MenuItem key={n.nodeId} title={n.nodeId} onClick={() => { setPicked(n.nodeId); setMenu(null); }} meta={nodeMeta(n)}>
              <span class={`dot ${n.running > 0 ? "run" : "idle"}`} /> {n.hostname}
            </MenuItem>
          ))}
        </Popover>
      )}
    </div>
  );
}
