// Projects: add one from a folder on this node or from an upstream URL, and list them.
import type { Host, Ref } from "@earendil-works/chord";
import { useState } from "preact/hooks";
import { NodeObject, ProjectObject } from "../../state/contracts";
import { useAction, useObject, useValue } from "./hooks";

export function Projects({ host, node }: { host: Host; node: Ref<typeof NodeObject> }) {
  const projectIds = useValue(node.projectIds);
  return (
    <>
      <AddProject node={node} />
      <section>
        <h2>Projects</h2>
        {projectIds.length === 0 ? <p class="muted">No projects yet.</p> : (
          <table>
            <thead><tr><th>Name</th><th>Source</th><th>Replica</th><th>Context</th><th>Id</th></tr></thead>
            <tbody>{projectIds.map((id) => <ProjectRow key={id} host={host} id={id} />)}</tbody>
          </table>
        )}
      </section>
    </>
  );
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

function ProjectRow({ host, id }: { host: Host; id: string }) {
  const project = useObject(host, ProjectObject, { id });
  if (project.ref === undefined) return <tr><td colSpan={5} class={project.error ? "error" : "muted"}>{project.error ?? id}</td></tr>;
  return <ProjectRowLoaded project={project.ref} />;
}

function ProjectRowLoaded({ project }: { project: Ref<typeof ProjectObject> }) {
  const id = useValue(project.id);
  const name = useValue(project.name);
  const source = useValue(project.source);
  const replica = useValue(project.replica);
  const contextLoaded = useValue(project.contextLoaded);
  return (
    <tr>
      <td>{name}</td>
      <td>{source.kind === "folder" ? source.path : source.url}</td>
      <td>{replica}</td>
      <td>{contextLoaded ? "loaded" : <span class="error">failed to load</span>}</td>
      <td class="muted">{id}</td>
    </tr>
  );
}
