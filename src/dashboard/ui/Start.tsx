// Where a new task's project starts: the start on its pill in the New task, and the popover that changes it, offering
// the project's branches, tasks' lines and revisions as hints (`startHints`) read from a node holding it, and asking
// that node to resolve what was typed when nothing it read matches.
import type { Host, Ref } from "@earendil-works/chord";
import { useEffect, useRef, useState } from "preact/hooks";
import type { GraphCommit } from "../../projects/graph";
import { remoteReason } from "../../projects/memory-names";
import { ProjectObject } from "../../state/contracts";
import { type Hosts, useObject, useValue } from "./hooks";
import { type Anchor, Popover } from "./common";
import { hintOf, marked, startHints, startSource, type StartHint, type StartLister } from "./start-model";

/** A start other than the default branch: the `rev` a task is created with, and how its pill shows it. */
export type Picked = { rev: string; label: string; title: string };

/** How long typing pauses before the node is asked to resolve it. */
const RESOLVE_MS = 300;

/** The start after a project's name on its pill: muted while it is the default branch. */
export function StartLabel({ picked, defaultBranch, onOpen }: { picked: Picked | undefined; defaultBranch: string | null; onOpen(el: HTMLElement): void }) {
  const open = (e: { currentTarget: HTMLElement }) => onOpen(e.currentTarget);
  if (picked !== undefined) return <button class="start moved" title={picked.title} onClick={open}>· {picked.label}</button>;
  if (defaultBranch === null) return <button class="start warn" title="No default branch: pick a start" onClick={open}>· no default</button>;
  return <button class="start" title="Default branch" onClick={open}>· {defaultBranch}</button>;
}

type PopoverProps = {
  hosts: Hosts; nodes: readonly StartLister[]; projectId: string; defaultBranch: string | null;
  /** A live task's title, or null. */
  title(task: string): string | null;
  anchor: Anchor;
  /** Called with the start picked: null for the default branch. */
  onPick(picked: Picked | null): void;
  onClose(): void;
};

export function StartPopover(props: PopoverProps) {
  const { hosts, nodes, projectId, anchor, onClose } = props;
  // Kept here, so that what was typed outlives the project's object loading under it.
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const source = startSource(nodes, hosts.selfId, projectId);
  const host = source === null ? undefined : hosts.for(source);
  const field = { ...props, query, setQuery: (q: string) => { setQuery(q); setSel(0); }, sel, setSel };
  return (
    <Popover anchor={anchor} onClose={onClose}>
      <div class="start-pop">
        {host === undefined
          ? <StartField {...field} graph={[]} resolve={null} unheld />
          : <WithProject key={source} host={host} {...field} />}
      </div>
    </Popover>
  );
}

type FieldProps = PopoverProps & { query: string; setQuery(q: string): void; sel: number; setSel(i: number): void };

function WithProject(props: FieldProps & { host: Host }) {
  const project = useObject(props.host, ProjectObject, { id: props.projectId });
  return project.ref === undefined ? <StartField {...props} graph={[]} resolve={null} /> : <WithGraph {...props} project={project.ref} />;
}

function WithGraph(props: FieldProps & { project: Ref<typeof ProjectObject> }) {
  const { project } = props;
  return <StartField {...props} graph={useValue(project.graph)} resolve={(rev) => project.resolve({ rev })} />;
}

/** What the node answered for a query: the revision it names, or why none. */
type Resolved = { query: string; commit: GraphCommit } | { query: string; error: string };

function StartField({ query, setQuery, sel, setSel, graph, resolve, unheld = false, defaultBranch, title, onPick }: FieldProps & {
  graph: readonly GraphCommit[]; resolve: ((rev: string) => Promise<GraphCommit>) | null; unheld?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const q = query.trim();
  const hints = startHints(graph, q, defaultBranch, title);
  const [resolved, setResolved] = useState<Resolved | null>(null);
  const asked = useRef(0);
  const ask = hints.length === 0 && q !== "" && resolve !== null;
  useEffect(() => {
    if (!ask) return;
    // Only the newest question's answer is kept.
    const n = ++asked.current;
    const timer = setTimeout(() => {
      resolve(q).then(
        (commit) => { if (n === asked.current) setResolved({ query: q, commit }); },
        (err: unknown) => { if (n === asked.current) setResolved({ query: q, error: remoteReason(err) }); },
      );
    }, RESOLVE_MS);
    return () => clearTimeout(timer);
  }, [ask, q]);
  const answer = ask && resolved?.query === q ? resolved : null;
  const fromNode = answer !== null && "commit" in answer;
  const rows: StartHint[] = hints.length > 0 ? hints : fromNode ? [hintOf(answer.commit, defaultBranch)] : [];

  const pick = (h: StartHint) => {
    const change = h.commit.change.slice(0, 8);
    onPick(h.rev === null ? null : {
      rev: h.rev,
      label: h.rev === h.commit.commit ? change : h.rev,
      title: `${change} · ${h.commit.description}`,
    });
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (rows.length > 0) setSel(Math.max(0, Math.min(rows.length - 1, sel + (e.key === "ArrowDown" ? 1 : -1))));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const h = rows[Math.min(sel, rows.length - 1)];
      if (h !== undefined) pick(h);
    }
  };
  const mark = (text: string, prefix: boolean) => marked(text, q, prefix).map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : p.text));

  return (
    <>
      <div class="start-field">
        <input ref={input} value={query} placeholder="branch, task, or revision" spellcheck={false} disabled={unheld}
          title={unheld ? "No online node holds this project" : undefined}
          onInput={(e) => setQuery(e.currentTarget.value)} onKeyDown={key} />
      </div>
      {rows.map((h, i) => {
        const c = h.commit;
        return (
          <button key={c.commit} class={`menu-item hint${i === sel ? " on" : ""}`} title={c.commit}
            onMouseEnter={() => setSel(i)} onClick={() => pick(h)}>
            <span class="menu-label">
              {c.bookmarks.map((b) => (b.kind === "branch"
                ? <span key={`b ${b.name}`} class="bm branch">{mark(b.name, false)}</span>
                : <span key={`t ${b.task}`} class="bm line">{mark(title(b.task) ?? `task ${b.task.slice(0, 8)}`, false)}</span>))}
              <span class="cid">{mark(c.change.slice(0, 8), true)}</span>
              <span class="desc">{mark(c.description, false)}</span>
            </span>
            {h.isDefault ? <span class="menu-meta">default</span>
              : fromNode && <span class="menu-meta">{new Date(c.time).toLocaleDateString(undefined, { month: "short", year: "numeric" })}</span>}
          </button>
        );
      })}
      {answer !== null && "error" in answer && <div class="menu-note error">{answer.error}</div>}
    </>
  );
}
