// Projects: add one on this node from a folder or an upstream URL, and every project of the pool, one row per project
// id merged across the online nodes holding a copy, with each holder's bookmarks.
import type { Host, Ref } from "@earendil-works/chord";
import { useCallback, useEffect, useState } from "preact/hooks";
import { NodeObject, ProjectObject } from "../../state/contracts";
import { shortId } from "../../pool/ids";
import { type Hosts, useAction, useObject, useValue } from "./hooks";
import type { PoolRef } from "./Pool";
import { headText, mergeProjects, type HeldProject } from "./pool-model";

type Report = (key: string, held: HeldProject | null) => void;

export function Projects({ hosts, pool, node }: { hosts: Hosts; pool: PoolRef; node: Ref<typeof NodeObject> }) {
  const nodes = useValue(pool.nodes);
  const online = nodes.filter((n) => n.nodeId === hosts.selfId || (n.status === "member" && n.online));
  const [held, setHeld] = useState<ReadonlyMap<string, HeldProject>>(() => new Map());
  const report = useCallback<Report>((key, copy) => setHeld((prev) => {
    const next = new Map(prev);
    if (copy === null) next.delete(key);
    else next.set(key, copy);
    return next;
  }), []);
  const onlineIds = online.map((n) => n.nodeId);
  const rows = mergeProjects([...held.values()].filter((c) => onlineIds.includes(c.nodeId)), nodes.map((n) => n.nodeId));
  const nameOf = (nodeId: string) => nodes.find((n) => n.nodeId === nodeId)?.hostname ?? shortId(nodeId);
  return (
    <>
      {online.map((row) => {
        const host = hosts.for(row.nodeId);
        return host === undefined ? null : <ProjectSource key={row.nodeId} host={host} nodeId={row.nodeId} report={report} />;
      })}
      <AddProject node={node} />
      <section>
        <h2>Projects</h2>
        {rows.length === 0 ? <p class="muted">No projects yet.</p> : (
          <table>
            <thead><tr><th>Name</th><th>Home</th><th>Nodes</th><th>Heads</th><th>Id</th></tr></thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td title={p.home}>{nameOf(p.home)}</td>
                  <td>{p.holders.map((h) => (
                    <div key={h.nodeId} title={h.nodeId}>
                      {nameOf(h.nodeId)}{!h.contextLoaded && <span class="error"> (context failed to load)</span>}
                    </div>
                  ))}</td>
                  <td>{p.holders.map((h) => (
                    <div key={h.nodeId}>
                      <strong>{nameOf(h.nodeId)}</strong>:{" "}
                      {h.heads.length === 0 ? <span class="muted">no bookmarks</span> : h.heads.map((b, i) => (
                        <span key={i} class={b.conflicted ? "flag" : ""}>{i > 0 && ", "}{headText(b)}</span>
                      ))}
                    </div>
                  ))}</td>
                  <td class="muted">{p.id}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

/** Reports one node's copies of its projects up while it is reachable. */
function ProjectSource({ host, nodeId, report }: { host: Host; nodeId: string; report: Report }) {
  const node = useObject(host, NodeObject, {});
  return node.ref === undefined ? null : <ProjectSourceLoaded host={host} node={node.ref} nodeId={nodeId} report={report} />;
}

function ProjectSourceLoaded({ host, node, nodeId, report }: { host: Host; node: Ref<typeof NodeObject>; nodeId: string; report: Report }) {
  const projectIds = useValue(node.projectIds);
  return <>{projectIds.map((id) => <HeldSource key={id} host={host} nodeId={nodeId} id={id} report={report} />)}</>;
}

function HeldSource({ host, nodeId, id, report }: { host: Host; nodeId: string; id: string; report: Report }) {
  const project = useObject(host, ProjectObject, { id });
  return project.ref === undefined ? null : <HeldSourceLoaded project={project.ref} nodeId={nodeId} report={report} />;
}

function HeldSourceLoaded({ project, nodeId, report }: { project: Ref<typeof ProjectObject>; nodeId: string; report: Report }) {
  const id = useValue(project.id);
  const name = useValue(project.name);
  const home = useValue(project.home);
  const heads = useValue(project.heads);
  const contextLoaded = useValue(project.contextLoaded);
  useEffect(() => {
    const key = `${nodeId}/${id}`;
    report(key, { nodeId, id, name, home, heads, contextLoaded });
    return () => report(key, null);
  }, [nodeId, id, name, home, heads, contextLoaded, report]);
  return null;
}

function AddProject({ node }: { node: Ref<typeof NodeObject> }) {
  const [kind, setKind] = useState<"folder" | "upstream">("folder");
  const [where, setWhere] = useState("");
  const [name, setName] = useState("");
  const action = useAction();
  const submit = async (e: Event) => {
    e.preventDefault();
    const named = name.trim() === "" ? {} : { name: name.trim() };
    const ok = await action.run(() => kind === "folder"
      ? node.addProjectFromFolder({ path: where.trim(), ...named })
      : node.addProjectFromUpstream({ url: where.trim(), ...named }));
    if (ok) {
      setWhere("");
      setName("");
    }
  };
  return (
    <section>
      <h2>Add a project</h2>
      <form onSubmit={submit} class="row">
        <select value={kind} onChange={(e) => setKind(e.currentTarget.value as "folder" | "upstream")}>
          <option value="folder">From a folder</option>
          <option value="upstream">From a URL</option>
        </select>
        <input
          value={where}
          placeholder={kind === "folder" ? "/path/to/repo on this node" : "https://… or git@…"}
          onInput={(e) => setWhere(e.currentTarget.value)}
          required
        />
        <input value={name} placeholder="name (optional)" onInput={(e) => setName(e.currentTarget.value)} />
        <button type="submit" disabled={action.busy || where.trim() === ""}>{action.busy ? "Adding…" : "Add"}</button>
      </form>
      {action.error !== null && <p class="error">{action.error}</p>}
    </section>
  );
}
