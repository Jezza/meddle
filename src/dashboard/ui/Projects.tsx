// A project across the pool (its home, its graph as its online nodes read it, a conflicted or fetching branch, its
// tasks), and adding a project on this node from a folder or an upstream URL.
import type { Host, Ref } from "@earendil-works/chord";
import { useCallback, useEffect, useState } from "preact/hooks";
import { NodeObject, ProjectObject } from "../../state/contracts";
import { shortId } from "../../pool/ids";
import type { GraphCommit } from "../../projects/graph";
import { type Hosts, useAction, useObject, useValue } from "./hooks";
import { Memory } from "./Memory";
import { memorySource } from "./memory-model";
import { PaneHead, type PoolRef, StateDot } from "./common";
import { Graph } from "./Graph";
import { graphRows } from "./graph-model";
import { branchLines, mergeProjects, type HeldProject } from "./pool-model";
import { hashOf } from "./routes";
import { waitsOnYou } from "./sidebar-model";
import type { PoolIndex } from "./sources";

/** A node's copy, and its object to read more of its graph from. */
type Held = HeldProject & { ref: Ref<typeof ProjectObject> };
type Report = (key: string, held: Held | null) => void;

/** How many more commits `Older` reads than are shown: a read's most (`GRAPH_MAX`, a server module's). */
const OLDER_MORE = 200;
/** The most commits `olderGraph` lists (`OLDER_GRAPH_MAX`, a server module's). */
const OLDER_CAP = 2000;

export function ProjectPage({ hosts, pool, index, id }: { hosts: Hosts; pool: PoolRef; index: PoolIndex; id: string }) {
  const nodes = useValue(pool.nodes);
  const online = nodes.filter((n) => n.nodeId === hosts.selfId || (n.status === "member" && n.online));
  const [held, setHeld] = useState<ReadonlyMap<string, Held>>(() => new Map());
  // The home's read with no lower bound once `Older` is clicked, and how many commits it asked for.
  const [older, setOlder] = useState<{ graph: readonly GraphCommit[]; limit: number } | null>(null);
  const report = useCallback<Report>((key, copy) => setHeld((prev) => {
    const next = new Map(prev);
    if (copy === null) next.delete(key);
    else next.set(key, copy);
    return next;
  }), []);
  const onlineIds = online.map((n) => n.nodeId);
  const project = mergeProjects([...held.values()].filter((c) => onlineIds.includes(c.nodeId) && c.id === id), nodes.map((n) => n.nodeId))[0];
  const nameOf = (nodeId: string) => nodes.find((n) => n.nodeId === nodeId)?.hostname ?? shortId(nodeId);
  const tasks = index.tasks.filter((t) => !t.archived && t.projects.some((p) => p.id === id));
  const listed = nodes.flatMap((n) => n.projects).find((p) => p.id === id);
  const memory = project === undefined ? null : memorySource(project.home, project.holders.map((h) => h.nodeId), onlineIds);
  const nodeName = (short: string) => nodes.find((n) => shortId(n.nodeId) === short)?.hostname ?? short;
  // Every online holder's graph; the home's carries on with what Older read.
  const holders = project?.holders ?? [];
  const rows = graphRows(holders, project?.home ?? "", older?.graph ?? []);
  const home = project === undefined ? undefined : held.get(`${project.home}/${id}`);
  // The last read had all there is, or as much as one read lists.
  const ended = older !== null && (older.graph.length < older.limit || older.limit >= OLDER_CAP);
  const readOlder = home === undefined || !onlineIds.includes(home.nodeId) || ended ? null : async () => {
    const limit = Math.min(rows.length + OLDER_MORE, OLDER_CAP);
    setOlder({ graph: await home.ref.olderGraph({ limit }), limit });
  };
  const labelled = new Set(rows.flatMap((r) => r.labels.flatMap((l) => l.nodes)));
  const failed = holders.filter((h) => !h.contextLoaded);
  const branches = project === undefined ? []
    : branchLines(project.branches.filter((b) => b.state === "conflicted" || b.state === "fetching"), project.defaultBranch);
  const taskOf = (taskId: string) => {
    const t = index.tasks.find((t) => t.id === taskId && !t.archived);
    return t === undefined ? null : { title: t.title, href: hashOf({ name: "task", nodeId: t.nodeId, id: t.id }) };
  };
  return (
    <>
      {online.map((row) => {
        const host = hosts.for(row.nodeId);
        return host === undefined ? null : <ProjectSource key={row.nodeId} host={host} nodeId={row.nodeId} id={id} report={report} />;
      })}
      <PaneHead>
        <span class="folder">▸</span>
        <strong>{project?.name ?? listed?.name ?? id}</strong>
        <span class="muted id">{id}</span>
        <span class="bar-gap" />
        <a class="button" href={hashOf({ name: "new", projectId: id })}>New task</a>
      </PaneHead>
      <div class="page">
        {project === undefined ? <p class="muted">{listed === undefined ? "No online node holds this project." : "Loading…"}</p> : (
          <>
            <dl>
              <dt>Home</dt><dd title={project.home}>{nameOf(project.home)}</dd>
            </dl>
            {rows.length > 0 && <>
              <h3>Graph</h3>
              <Graph rows={rows} defaultBranch={project.defaultBranch} nodeName={nameOf} taskOf={taskOf} older={readOlder}
                contextFailed={new Set(failed.map((h) => h.nodeId))} />
            </>}
            {failed.filter((h) => !labelled.has(h.nodeId)).map((h) => (
              <p key={h.nodeId} class="error">{nameOf(h.nodeId)} context failed to load</p>
            ))}
            {branches.length > 0 && <>
              <h3>Branches</h3>
              <ul class="plain">
                {branches.map((b) => (
                  <li key={b.name} class={b.conflicted ? "flag" : ""}>
                    <code>{b.name}</code> {b.isDefault && <span class="muted">(default) </span>}<code>{b.text}</code>
                    {b.conflicted && (
                      <div class="muted">
                        Its siblings, in a checkout: {b.siblings.map((s, i) => <span key={s}>{i > 0 && ", "}<code>{s}</code></span>)}.
                        Push a merge of them, or drop one with <code>git push meddle :refs/heads/meddle/conflict/{b.name}/&lt;id&gt;</code>;
                        to keep your own work: <code>jj bookmark set {b.name} -r &lt;your commit&gt;</code>.
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </>}
            {memory !== null && (
              <Memory key={memory.nodeId} hosts={hosts} nodeId={memory.nodeId} editable={memory.editable} id={id} tasks={index.tasks} nodeName={nodeName} />
            )}
          </>
        )}
        <h3>Tasks</h3>
        {tasks.length === 0 ? <p class="muted">No tasks in this project.</p> : (
          <ul class="plain">
            {tasks.map((t) => (
              <li key={`${t.nodeId}/${t.id}`}>
                <StateDot state={t.state} waiting={waitsOnYou(t)} />{" "}
                <a href={hashOf({ name: "task", nodeId: t.nodeId, id: t.id })}>{t.title}</a>{" "}
                <span class="muted">{nameOf(t.nodeId)}{t.projects.length > 1 && ` · with ${t.projects.filter((p) => p.id !== id).map((p) => p.name).join(", ")}`}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

/** Reports one node's copy of project `id` up while it is reachable. */
function ProjectSource({ host, nodeId, id, report }: { host: Host; nodeId: string; id: string; report: Report }) {
  const node = useObject(host, NodeObject, {});
  return node.ref === undefined ? null : <ProjectSourceLoaded host={host} node={node.ref} nodeId={nodeId} id={id} report={report} />;
}

function ProjectSourceLoaded({ host, node, nodeId, id, report }: { host: Host; node: Ref<typeof NodeObject>; nodeId: string; id: string; report: Report }) {
  const projectIds = useValue(node.projectIds);
  return projectIds.includes(id) ? <HeldSource host={host} nodeId={nodeId} id={id} report={report} /> : null;
}

function HeldSource({ host, nodeId, id, report }: { host: Host; nodeId: string; id: string; report: Report }) {
  const project = useObject(host, ProjectObject, { id });
  return project.ref === undefined ? null : <HeldSourceLoaded project={project.ref} nodeId={nodeId} report={report} />;
}

function HeldSourceLoaded({ project, nodeId, report }: { project: Ref<typeof ProjectObject>; nodeId: string; report: Report }) {
  const id = useValue(project.id);
  const name = useValue(project.name);
  const home = useValue(project.home);
  const defaultBranch = useValue(project.defaultBranch);
  const branches = useValue(project.branches);
  const contextLoaded = useValue(project.contextLoaded);
  const graph = useValue(project.graph);
  useEffect(() => {
    const key = `${nodeId}/${id}`;
    report(key, { nodeId, id, name, home, defaultBranch: defaultBranch ?? null, branches, contextLoaded, graph, ref: project });
    return () => report(key, null);
  }, [nodeId, id, name, home, defaultBranch, branches, contextLoaded, graph, project, report]);
  return null;
}

/** Adds a project on this node, from a folder on it or an upstream URL, and opens it. */
export function AddProject({ node }: { node: Ref<typeof NodeObject> }) {
  const [kind, setKind] = useState<"folder" | "upstream">("folder");
  const [where, setWhere] = useState("");
  const [name, setName] = useState("");
  const action = useAction();
  const submit = async (e: Event) => {
    e.preventDefault();
    const named = name.trim() === "" ? {} : { name: name.trim() };
    let added: string | undefined;
    const ok = await action.run(async () => {
      const project = kind === "folder"
        ? await node.addProjectFromFolder({ path: where.trim(), ...named })
        : await node.addProjectFromUpstream({ url: where.trim(), ...named });
      added = project.id;
    });
    if (ok && added !== undefined) location.hash = hashOf({ name: "project", id: added });
  };
  return (
    <>
      <PaneHead><strong>Add a project</strong></PaneHead>
      <div class="page">
        <form onSubmit={submit} class="form">
          <div class="seg">
            <button type="button" class={kind === "folder" ? "on" : ""} onClick={() => setKind("folder")}>From a folder</button>
            <button type="button" class={kind === "upstream" ? "on" : ""} onClick={() => setKind("upstream")}>From a URL</button>
          </div>
          <label><span>{kind === "folder" ? "Folder on this node" : "Upstream URL"}</span>
            <input value={where} placeholder={kind === "folder" ? "/path/to/repo" : "https://… or git@…"} onInput={(e) => setWhere(e.currentTarget.value)} required />
          </label>
          {kind === "folder" && (
            <p class="muted">
              This builds the project's service repo from the folder and leaves the folder alone: it does not become a
              checkout. To work in the folder with meddle (push to it, fetch tasks' work), add it on the command line
              instead, with <code>meddle project add &lt;folder&gt;</code>, run on this node.
            </p>
          )}
          <label><span>Name <span class="muted">(optional)</span></span>
            <input value={name} onInput={(e) => setName(e.currentTarget.value)} />
          </label>
          <div><button type="submit" class="primary" disabled={action.busy || where.trim() === ""}>{action.busy ? "Adding…" : "Add"}</button></div>
          {action.error !== null && <p class="error">{action.error}</p>}
        </form>
      </div>
    </>
  );
}
