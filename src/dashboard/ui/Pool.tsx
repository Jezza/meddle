// The pool: this node's card with its tasks, the notifications strip, and a form for a new task.
import type { Host, Ref } from "@earendil-works/chord";
import { useState } from "preact/hooks";
import { NodeObject, ProjectObject, TaskObject } from "../../state/contracts";
import { useAction, useObject, useValue } from "./hooks";

type NodeRef = Ref<typeof NodeObject>;

export function Pool({ host, node, open }: { host: Host; node: NodeRef; open: (taskId: string) => void }) {
  const taskIds = useValue(node.taskIds);
  return (
    <>
      <NodeCard node={node} />
      <section>
        <h2>Tasks</h2>
        {taskIds.length === 0 ? <p class="muted">No tasks yet.</p> : (
          <table>
            <thead><tr><th>Title</th><th>State</th><th>Waiting on you</th><th>Projects</th></tr></thead>
            <tbody>{taskIds.map((id) => <TaskRow key={id} host={host} id={id} open={open} />)}</tbody>
          </table>
        )}
      </section>
      <NewTask host={host} node={node} open={open} />
    </>
  );
}

function NodeCard({ node }: { node: NodeRef }) {
  const hostname = useValue(node.hostname);
  const version = useValue(node.version);
  const claudeCodeVersion = useValue(node.claudeCodeVersion);
  const token = useValue(node.token);
  const metrics = useValue(node.metrics);
  const hostsTasks = useValue(node.hostsTasks);
  const taskRoot = useValue(node.taskRoot);
  return (
    <section class="card">
      <h2>{hostname}</h2>
      <dl>
        <dt>meddle</dt><dd>{version}</dd>
        <dt>Claude Code</dt><dd>{claudeCodeVersion}</dd>
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
    </section>
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
      <td>{manifest.projects.map((p) => p.name).join(", ")}</td>
    </tr>
  );
}

export function Notifications({ node, open }: { node: NodeRef; open: (taskId: string) => void }) {
  const notifications = useValue(node.notifications);
  const action = useAction();
  if (notifications.length === 0) return null;
  return (
    <section class="notifications">
      {action.error !== null && <p class="error">{action.error}</p>}
      {[...notifications].reverse().map((n) => (
        <div key={n.id} class={`note ${n.kind}`}>
          <span class="muted">{new Date(n.at).toLocaleTimeString()}</span>{" "}
          <a href="#" onClick={(e) => { e.preventDefault(); open(n.taskId); }}>{n.text}</a>{" "}
          <button disabled={action.busy} onClick={() => action.run(() => node.dismiss({ id: n.id }))}>Dismiss</button>
        </div>
      ))}
    </section>
  );
}

function NewTask({ host, node, open }: { host: Host; node: NodeRef; open: (taskId: string) => void }) {
  const projectIds = useValue(node.projectIds);
  const [title, setTitle] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const action = useAction();
  const toggle = (id: string) => setChosen(chosen.includes(id) ? chosen.filter((c) => c !== id) : [...chosen, id]);
  const submit = async (e: Event) => {
    e.preventDefault();
    let created: string | undefined;
    const ok = await action.run(async () => { created = (await node.createTask({ title, projectIds: chosen })).id; });
    if (ok && created !== undefined) open(created);
  };
  return (
    <section>
      <h2>New task</h2>
      <form onSubmit={submit}>
        <label>Title <input value={title} onInput={(e) => setTitle(e.currentTarget.value)} required /></label>
        <fieldset>
          <legend>Projects (the first chosen is the primary)</legend>
          {projectIds.length === 0 && <p class="muted">Add a project first.</p>}
          {projectIds.map((id) => (
            <label key={id} class="option">
              <input type="checkbox" checked={chosen.includes(id)} onChange={() => toggle(id)} />{" "}
              <ProjectName host={host} id={id} />
            </label>
          ))}
        </fieldset>
        <button type="submit" disabled={action.busy || title.trim() === "" || chosen.length === 0}>Create</button>
        {action.error !== null && <p class="error">{action.error}</p>}
      </form>
    </section>
  );
}

function ProjectName({ host, id }: { host: Host; id: string }) {
  const project = useObject(host, ProjectObject, { id });
  return project.ref === undefined ? <span class="muted">{id}</span> : <ProjectNameLoaded project={project.ref} />;
}

function ProjectNameLoaded({ project }: { project: Ref<typeof ProjectObject> }) {
  return <span>{useValue(project.name)}</span>;
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
