// The pool: a card per node with its tasks, the notifications strip merged from every online node, and a form for a
// new task, placed automatically or on a chosen online node that hosts tasks.
import type { Host, Ref } from "@earendil-works/chord";
import { useCallback, useEffect, useState } from "preact/hooks";
import { NodeObject, PoolObject, TaskObject, type Notification } from "../../state/contracts";
import { shortId } from "../../pool/ids";
import { type Hosts, type HostStatus, useAction, useObject, useValue } from "./hooks";
import { projectChoices } from "./pool-model";
import type { Open } from "./routes";

type NodeRef = Ref<typeof NodeObject>;
/** `PoolObject` as a dashboard holds it: its `default` variant. */
export type PoolRef = Extract<Ref<typeof PoolObject>, { variant: "default" }>;
type PoolNode = PoolRef["nodes"]["value"][number];

export function Pool({ hosts, pool, open }: { hosts: Hosts; pool: PoolRef; open: Open }) {
  const nodes = useValue(pool.nodes);
  const selfId = useValue(pool.self);
  const mixedVersions = useValue(pool.mixedVersions);
  const selfRow = nodes.find((n) => n.nodeId === selfId);
  // This node first, then the rest in roster order.
  const ordered = [...nodes].sort((a, b) => Number(b.nodeId === selfId) - Number(a.nodeId === selfId));
  const canHost = nodes.filter((n) => n.status === "member" && n.online && n.hostsTasks);
  return (
    <>
      {mixedVersions && <p class="flag">The pool's members run different meddle or Claude Code versions.</p>}
      <section class="cards">
        {ordered.map((row) => <NodeCard key={row.nodeId} hosts={hosts} row={row} selfRow={selfRow} open={open} />)}
      </section>
      <NewTask hosts={hosts} nodes={nodes} canHost={canHost} selfId={selfId} open={open} />
    </>
  );
}

function NodeCard({ hosts, row, selfRow, open }: { hosts: Hosts; row: PoolNode; selfRow: PoolNode | undefined; open: Open }) {
  if (row.status === "removed") {
    return (
      <section class="card removed" title={row.nodeId}>
        <CardHead row={row} hostname={row.hostname} />
        <p class="muted">Removed from the pool.</p>
      </section>
    );
  }
  const host = row.online ? hosts.for(row.nodeId) : undefined;
  if (host === undefined) {
    return (
      <section class="card" title={row.nodeId}>
        <CardHead row={row} hostname={row.hostname} />
        {row.online && <Unavailable status={hosts.status(row.nodeId)} />}
        <SummaryBody row={row} selfRow={selfRow} />
      </section>
    );
  }
  return <OnlineCard host={host} row={row} selfRow={selfRow} open={open} />;
}

/** Why an online node's objects cannot be had right now (`Hosts.for` gave no host). */
export function Unavailable({ status }: { status: HostStatus }) {
  if (status === "incompatible") return <p class="flag">Incompatible version: this dashboard cannot talk to it. Upgrade the older node.</p>;
  if (status === "backoff") return <p class="muted">Unreachable; retrying shortly.</p>;
  return <p class="muted">Connecting…</p>;
}

function CardHead({ row, hostname }: { row: PoolNode; hostname: string }) {
  const [label, badge] = row.status === "removed" ? ["removed", "removed"] : row.online ? ["online", "online"] : ["offline", "offline"];
  return (
    <h2>
      {hostname} <span class="muted id">{shortId(row.nodeId)}</span> <span class={`badge ${badge}`}>{label}</span>
    </h2>
  );
}

/** What the roster knows about a node that is offline (or whose objects are still loading). */
function SummaryBody({ row, selfRow }: { row: PoolNode; selfRow: PoolNode | undefined }) {
  return (
    <dl>
      <dt>meddle</dt><dd><Version value={row.version} self={selfRow?.version} /></dd>
      <dt>Claude Code</dt><dd><Version value={row.claudeCodeVersion} self={selfRow?.claudeCodeVersion} /></dd>
      <dt>Hosts tasks</dt><dd>{row.hostsTasks ? "yes" : "no"}</dd>
      <dt>Tasks</dt><dd>{row.taskCount}</dd>
      {!row.online && <><dt>Last seen</dt><dd>{row.lastSeenAt === null ? "never" : new Date(row.lastSeenAt).toLocaleString()}</dd></>}
    </dl>
  );
}

/** A version, flagged when it is not this node's. */
function Version({ value, self }: { value: string; self: string | undefined }) {
  if (value === "") return <span class="muted">unknown</span>;
  const differs = self !== undefined && self !== "" && value !== self;
  return differs ? <span class="flag" title={`this node runs ${self}`}>{value} (differs)</span> : <span>{value}</span>;
}

function OnlineCard({ host, row, selfRow, open }: { host: Host; row: PoolNode; selfRow: PoolNode | undefined; open: Open }) {
  const node = useObject(host, NodeObject, {});
  if (node.ref === undefined) {
    return (
      <section class="card" title={row.nodeId}>
        <CardHead row={row} hostname={row.hostname} />
        {node.error === undefined ? <p class="muted">Connecting…</p> : <p class="error">{node.error}</p>}
        <SummaryBody row={row} selfRow={selfRow} />
      </section>
    );
  }
  return <LiveCard host={host} node={node.ref} row={row} selfRow={selfRow} open={open} />;
}

function LiveCard({ host, node, row, selfRow, open }: { host: Host; node: NodeRef; row: PoolNode; selfRow: PoolNode | undefined; open: Open }) {
  const hostname = useValue(node.hostname);
  const version = useValue(node.version);
  const claudeCodeVersion = useValue(node.claudeCodeVersion);
  const token = useValue(node.token);
  const metrics = useValue(node.metrics);
  const hostsTasks = useValue(node.hostsTasks);
  const taskRoot = useValue(node.taskRoot);
  const taskIds = useValue(node.taskIds);
  const archivedIds = useValue(node.archivedIds);
  const openHere = (taskId: string) => open(row.nodeId, taskId);
  return (
    <section class="card" title={row.nodeId}>
      <CardHead row={row} hostname={hostname} />
      <dl>
        <dt>meddle</dt><dd><Version value={version} self={selfRow?.version} /></dd>
        <dt>Claude Code</dt><dd><Version value={claudeCodeVersion} self={selfRow?.claudeCodeVersion} /></dd>
        <dt>Token</dt><dd>{tokenText(token)}</dd>
        <dt>Task root</dt><dd>{taskRoot} {hostsTasks ? "" : <span class="error">(not usable: this node hosts no tasks)</span>}</dd>
        {metrics === null ? <><dt>Resources</dt><dd class="muted">no sample yet</dd></> : (
          <>
            <dt>Cores</dt><dd>{metrics.cores}, load {metrics.load1.toFixed(2)}</dd>
            <dt>Memory</dt><dd>{mb(metrics.memAvailableKb)} free of {mb(metrics.memTotalKb)}</dd>
            <dt>Disk free</dt><dd>{mb(metrics.diskFreeKb)}</dd>
            <dt>Service</dt><dd>{mb(metrics.serviceRssKb)} RSS, event loop lag {metrics.eventLoopLagMs.toFixed(1)} ms</dd>
            <dt>Sampled</dt><dd>{new Date(metrics.at).toLocaleTimeString()}</dd>
          </>
        )}
      </dl>
      <h3>Tasks</h3>
      {taskIds.length === 0 ? <p class="muted">No tasks yet.</p> : (
        <table>
          <thead><tr><th>Title</th><th>State</th><th>Waiting on you</th><th>Projects</th></tr></thead>
          <tbody>{taskIds.map((id) => <TaskRow key={id} host={host} id={id} open={openHere} />)}</tbody>
        </table>
      )}
      {archivedIds.length > 0 && (
        <>
          <h3>Archived</h3>
          <table>
            <thead><tr><th>Title</th><th>Archived</th><th>Projects</th><th></th></tr></thead>
            <tbody>{archivedIds.map((id) => <ArchivedRow key={id} host={host} id={id} open={openHere} />)}</tbody>
          </table>
        </>
      )}
    </section>
  );
}

function ArchivedRow({ host, id, open }: { host: Host; id: string; open: (taskId: string) => void }) {
  const task = useObject(host, TaskObject, { id });
  if (task.ref === undefined) return <tr><td colSpan={4} class={task.error ? "error" : "muted"}>{task.error ?? id}</td></tr>;
  return <ArchivedRowLoaded task={task.ref} open={open} />;
}

/** An archived task: its title (opens its read-only view), and Restore (here) and Delete links. */
function ArchivedRowLoaded({ task, open }: { task: Ref<typeof TaskObject>; open: (taskId: string) => void }) {
  const manifest = useValue(task.manifest);
  const archivedOn = useValue(task.archivedOn);
  const action = useAction();
  const link = (label: string, run: () => Promise<unknown>) => (
    <a href="#" class={action.busy ? "muted" : ""} onClick={(e) => { e.preventDefault(); if (!action.busy) void action.run(run); }}>{label}</a>
  );
  return (
    <tr>
      <td><a href="#" onClick={(e) => { e.preventDefault(); open(manifest.id); }}>{manifest.title}</a></td>
      <td>{archivedOn === null ? "" : <span class="muted" title={archivedOn}>{shortId(archivedOn)}</span>}</td>
      <td>{manifest.projects.length === 0 ? <span class="muted">no project</span> : manifest.projects.map((p) => p.name).join(", ")}</td>
      <td>
        {link("Restore", () => task.restore({ node: null }))}{" · "}
        {link("Delete", async () => { if (confirm(`Delete "${manifest.title}", its log and its archive?`)) await task.delete({}); })}
        {action.error !== null && <span class="error"> {action.error}</span>}
      </td>
    </tr>
  );
}

function TaskRow({ host, id, open }: { host: Host; id: string; open: (taskId: string) => void }) {
  const task = useObject(host, TaskObject, { id });
  if (task.ref === undefined) return <tr><td colSpan={4} class={task.error ? "error" : "muted"}>{task.error ?? id}</td></tr>;
  return <TaskRowLoaded task={task.ref} open={open} />;
}

function TaskRowLoaded({ task, open }: { task: Ref<typeof TaskObject>; open: (taskId: string) => void }) {
  const manifest = useValue(task.manifest);
  const state = useValue(task.state);
  const pending = useValue(task.pending);
  return (
    <tr>
      <td><a href="#" onClick={(e) => { e.preventDefault(); open(manifest.id); }}>{manifest.title}</a></td>
      <td><span class={`state ${state}`}>{state}</span></td>
      <td>{pending.length > 0 ? pending.length : ""}</td>
      <td>{manifest.projects.length === 0 ? <span class="muted">no project</span> : manifest.projects.map((p) => p.name).join(", ")}</td>
    </tr>
  );
}

// ─── notifications ───

type Notes = { node: NodeRef; notes: readonly Notification[] };
type Report = (nodeId: string, notes: Notes | null) => void;

/** Every online node's notifications, newest first. */
export function Notifications({ hosts, pool, open }: { hosts: Hosts; pool: PoolRef; open: Open }) {
  const online = useValue(pool.nodes).filter((n) => n.nodeId === hosts.selfId || (n.status === "member" && n.online));
  const [byNode, setByNode] = useState<ReadonlyMap<string, Notes>>(() => new Map());
  const report = useCallback<Report>((nodeId, notes) => setByNode((prev) => {
    const next = new Map(prev);
    if (notes === null) next.delete(nodeId);
    else next.set(nodeId, notes);
    return next;
  }), []);
  const action = useAction();
  const merged = online
    .flatMap((row) => {
      const source = byNode.get(row.nodeId);
      return source === undefined ? [] : source.notes.map((note) => ({ row, node: source.node, note }));
    })
    .sort((a, b) => Date.parse(b.note.at) - Date.parse(a.note.at));
  return (
    <>
      {online.map((row) => {
        const host = hosts.for(row.nodeId);
        return host === undefined ? null : <NoteSource key={row.nodeId} host={host} nodeId={row.nodeId} report={report} />;
      })}
      {merged.length > 0 && (
        <section class="notifications">
          {action.error !== null && <p class="error">{action.error}</p>}
          {merged.map(({ row, node, note }) => (
            <div key={`${row.nodeId}/${note.id}`} class={`note ${note.kind}`}>
              <span class="muted" title={row.nodeId}>{new Date(note.at).toLocaleTimeString()} · {row.hostname}</span>{" "}
              <a href="#" onClick={(e) => { e.preventDefault(); open(row.nodeId, note.taskId); }}>{note.text}</a>{" "}
              <button disabled={action.busy} onClick={() => action.run(() => node.dismiss({ id: note.id }))}>Dismiss</button>
            </div>
          ))}
        </section>
      )}
    </>
  );
}

/** Reports one node's notifications up while it is reachable. */
function NoteSource({ host, nodeId, report }: { host: Host; nodeId: string; report: Report }) {
  const node = useObject(host, NodeObject, {});
  return node.ref === undefined ? null : <NoteSourceLoaded node={node.ref} nodeId={nodeId} report={report} />;
}

function NoteSourceLoaded({ node, nodeId, report }: { node: NodeRef; nodeId: string; report: Report }) {
  const notes = useValue(node.notifications);
  useEffect(() => {
    report(nodeId, { node, notes });
    return () => report(nodeId, null);
  }, [node, nodeId, notes, report]);
  return null;
}

// ─── a new task ───

/**
 * A new task, created through this node: on the node chosen, or (`Automatic`) the one placement picks. The projects
 * offered are those the online members list; the task opens on the node it was created on.
 */
function NewTask({ hosts, nodes, canHost, selfId, open }: {
  hosts: Hosts; nodes: readonly PoolNode[]; canHost: readonly PoolNode[]; selfId: string; open: Open;
}) {
  const host = hosts.for(selfId);
  return (
    <section>
      <h2>New task</h2>
      {canHost.length === 0 ? <p class="muted">No online node hosts tasks.</p>
        : host === undefined ? <Unavailable status={hosts.status(selfId)} />
        : <NewTaskOnHost host={host} nodes={nodes} canHost={canHost} open={open} />}
    </section>
  );
}

function NewTaskOnHost({ host, nodes, canHost, open }: { host: Host; nodes: readonly PoolNode[]; canHost: readonly PoolNode[]; open: Open }) {
  const node = useObject(host, NodeObject, {});
  if (node.error !== undefined) return <p class="error">{node.error}</p>;
  if (node.ref === undefined) return <p class="muted">Connecting…</p>;
  return <NewTaskForm node={node.ref} nodes={nodes} canHost={canHost} open={open} />;
}

/** The node select's value for `Automatic`. */
const AUTOMATIC = "";

function NewTaskForm({ node, nodes, canHost, open }: { node: NodeRef; nodes: readonly PoolNode[]; canHost: readonly PoolNode[]; open: Open }) {
  const projects = projectChoices(nodes);
  const [title, setTitle] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [prompt, setPrompt] = useState("");
  const [picked, setPicked] = useState(AUTOMATIC);
  // A node that went offline (or stopped hosting tasks) since it was picked falls back to Automatic.
  const where = canHost.some((n) => n.nodeId === picked) ? picked : AUTOMATIC;
  const action = useAction();
  const toggle = (id: string) => setChosen(chosen.includes(id) ? chosen.filter((c) => c !== id) : [...chosen, id]);
  const submit = async (e: Event) => {
    e.preventDefault();
    let created: { taskId: string; nodeId: string } | undefined;
    const ok = await action.run(async () => {
      const first = prompt.trim() === "" ? null : prompt;
      const { manifest, nodeId } = await node.createTask({ title, projectIds: chosen, node: where === AUTOMATIC ? null : where, prompt: first });
      created = { taskId: manifest.id, nodeId };
    });
    if (ok && created !== undefined) open(created.nodeId, created.taskId);
  };
  return (
    <form onSubmit={submit}>
      <label>Title <input value={title} onInput={(e) => setTitle(e.currentTarget.value)} required /></label>
      <label>Node{" "}
        <select value={where} onChange={(e) => setPicked(e.currentTarget.value)}>
          <option value={AUTOMATIC}>Automatic</option>
          {canHost.map((n) => <option key={n.nodeId} value={n.nodeId} title={n.nodeId}>{n.hostname} ({shortId(n.nodeId)})</option>)}
        </select>
      </label>
      <fieldset>
        <legend>Projects (the first chosen is the primary; none for a task without a project)</legend>
        {projects.length === 0 && <p class="muted">No project yet: the task gets a scratch folder.</p>}
        {projects.map((p) => (
          <label key={p.id} class="option" title={p.id}>
            <input type="checkbox" checked={chosen.includes(p.id)} onChange={() => toggle(p.id)} />{" "}
            <span>{p.name}</span>
          </label>
        ))}
      </fieldset>
      <label>First prompt (optional){" "}
        <textarea value={prompt} rows={3} onInput={(e) => setPrompt(e.currentTarget.value)} />
      </label>
      <button type="submit" disabled={action.busy || title.trim() === ""}>Create</button>
      {action.error !== null && <p class="error">{action.error}</p>}
    </form>
  );
}

export function tokenText(token: { present: boolean; expiresAt: string | null }): string {
  if (!token.present) return "missing";
  if (token.expiresAt === null) return "present, expiry unknown";
  const days = Math.floor((Date.parse(token.expiresAt) - Date.now()) / 86_400_000);
  return `${days < 0 ? "expired" : `expires in ${days} days`} (${new Date(token.expiresAt).toLocaleDateString()})`;
}

function mb(kb: number): string {
  return kb >= 1024 * 1024 ? `${(kb / 1024 / 1024).toFixed(1)} GiB` : `${(kb / 1024).toFixed(0)} MiB`;
}
