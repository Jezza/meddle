// A new task: the composer is the form. Its projects (the one it was opened under, more added), each with where it
// starts (its default branch unless another is picked), the node (Automatic, where placement picks, or one that hosts
// tasks), and its first prompt with its files; Start creates it through this node and opens it.
import type { Host, Ref } from "@earendil-works/chord";
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { NodeObject } from "../../state/contracts";
import { type Hosts, useAction, useDraft, useObject, useValue } from "./hooks";
import { draftAttachments, readyToSend } from "./attach-model";
import { AttachButton, DraftChips, useDrafts, useFileTarget } from "./Attachments";
import { composerKey } from "./composer-model";
import { type Anchor, MenuItem, ModelPicker, NodeDot, nodeMeta, PaneHead, type PoolRef, Popover, Unavailable } from "./common";
import { projectChoices } from "./pool-model";
import type { Open } from "./routes";
import type { PoolIndex } from "./sources";
import { type Picked, StartLabel, StartPopover } from "./Start";
import { defaultBranchOf } from "./start-model";

type NodeRef = Ref<typeof NodeObject>;

export function NewTask({ hosts, pool, index, projectId, open }: { hosts: Hosts; pool: PoolRef; index: PoolIndex; projectId: string | null; open: Open }) {
  const host = hosts.selfHost;
  const node = useObject(host, NodeObject, {});
  const nodes = useValue(pool.nodes);
  const canHost = nodes.filter((n) => n.status === "member" && n.online && n.hostsTasks);
  const head = <PaneHead><strong>New task</strong></PaneHead>;
  if (canHost.length === 0) return <>{head}<p class="pane-note muted">No online node hosts tasks.</p></>;
  if (node.error !== undefined) return <>{head}<p class="pane-note error">{node.error}</p></>;
  if (node.ref === undefined) return <>{head}<div class="pane-note"><Unavailable status={hosts.status(hosts.selfId)} /></div></>;
  return <NewTaskForm key={projectId ?? ""} hosts={hosts} node={node.ref} pool={pool} index={index} projectId={projectId} open={open} />;
}

function NewTaskForm({ hosts, node, pool, index, projectId, open }: {
  hosts: Hosts; node: NodeRef; pool: PoolRef; index: PoolIndex; projectId: string | null; open: Open;
}) {
  const nodes = useValue(pool.nodes);
  const projects = projectChoices(nodes);
  const canHost = nodes.filter((n) => n.status === "member" && n.online && n.hostsTasks);
  const [chosen, setChosen] = useState<string[]>(() => (projectId === null ? [] : [projectId]));
  /** Where each project starts that does not start on its default branch. */
  const [starts, setStarts] = useState<Readonly<Record<string, Picked>>>({});
  // A prompt left unstarted, its files too, is there again on coming back to a new task under the same project (or none).
  const [prompt, setPrompt] = useDraft(`new.${projectId ?? ""}`);
  const drafts = useDrafts(`new.${projectId ?? ""}`);
  const defaults = useValue(pool.defaults);
  /** The model and effort picked; null while they are the pool's defaults. */
  const [chosenModel, setChosenModel] = useState<string | null>(null);
  const [chosenEffort, setChosenEffort] = useState<string | null>(null);
  const model = chosenModel ?? defaults.model;
  const effort = chosenEffort ?? defaults.effort;
  /** The node picked; null for Automatic. */
  const [picked, setPicked] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ kind: "project" | "node"; anchor: Anchor } | { kind: "start"; id: string; anchor: Anchor } | null>(null);
  const action = useAction();
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => input.current?.focus(), []);
  // Keys as in a task's composer: Enter starts, Shift+Enter makes a new line (Enter does on a touch screen).
  const touch = matchMedia("(pointer: coarse)").matches;
  // A node that went offline (or stopped hosting tasks) since it was picked falls back to Automatic.
  const where = canHost.find((n) => n.nodeId === picked) ?? null;
  // Placement picks a node that takes files when there are some; a node of an older meddle takes none.
  const attaching = where === null || where.attachments;
  const files = useFileTarget(drafts.add, attaching);
  const ready = readyToSend(prompt, drafts.drafts);
  const nameOf = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
  const lead = chosen.length === 0 ? null : nameOf(chosen[0]!);
  const titleOf = (task: string) => index.tasks.find((t) => t.id === task && !t.archived)?.title ?? null;
  const setStart = (id: string, picked: Picked | null) => {
    const { [id]: _, ...rest } = starts;
    setStarts(picked === null ? rest : { ...rest, [id]: picked });
  };

  const start = async () => {
    if (!ready || action.busy) return;
    let created: { taskId: string; nodeId: string } | undefined;
    const ok = await action.run(async () => {
      const { manifest, nodeId } = await node.createTask({
        projects: chosen.map((id) => (starts[id] === undefined ? { id } : { id, rev: starts[id].rev })), node: where?.nodeId ?? null, prompt, attachments: draftAttachments(drafts.drafts), model, effort,
      });
      created = { taskId: manifest.id, nodeId };
    });
    if (ok && created !== undefined) {
      setPrompt("");
      drafts.clear();
      open(created.nodeId, created.taskId);
    }
  };

  return (
    <div class="task">
      <PaneHead><strong>New task</strong></PaneHead>
      <div class="new-empty">
        {lead === null ? <span>New task</span> : <span>New task in <b>{lead}</b>{chosen.length > 1 && ` and ${chosen.length - 1} more`}</span>}
      </div>
      <div class={files.dragging ? "composer drop" : "composer"} {...files.handlers}>
        <DraftChips drafts={drafts.drafts} onRemove={drafts.remove} />
        <textarea ref={input} rows={4} value={prompt} placeholder="What should Claude do?"
          onInput={(e) => setPrompt(e.currentTarget.value)}
          onKeyDown={(e) => {
            const field = e.currentTarget;
            if (composerKey(e, { running: false, touch, anyQueued: false, value: field.value, caret: field.selectionStart }) === null) return;
            e.preventDefault();
            void start();
          }} />
        <div class="composer-row">
          {chosen.map((id) => (
            <span key={id} class="pill">◉ {nameOf(id)}
              <StartLabel picked={starts[id]} defaultBranch={defaultBranchOf(nodes, id)}
                onOpen={(el) => setMenu({ kind: "start", id, anchor: { el, above: true } })} />
              <button class="x" title="Remove" onClick={() => { setChosen(chosen.filter((c) => c !== id)); setStart(id, null); }}>×</button>
            </span>
          ))}
          <button class="pill add" disabled={projects.length === chosen.length} onClick={(e) => setMenu({ kind: "project", anchor: { el: e.currentTarget, above: true } })}>＋ project</button>
          <button class="pill" title="Where the task runs" onClick={(e) => setMenu({ kind: "node", anchor: { el: e.currentTarget, above: true } })}>
            ⌂ {where === null ? "Automatic" : where.hostname} ▾
          </button>
          {/* The models of the node picked, which runs the task; this node's for Automatic, or while the picked one's load. */}
          <NodeModels key={where?.nodeId ?? ""} host={where === null || where.nodeId === hosts.selfId ? undefined : hosts.for(where.nodeId)} fallback={node}
            render={(models) => <ModelPicker models={models} model={model} effort={effort} onModel={setChosenModel} onEffort={setChosenEffort} />} />
          <span class="bar-gap" />
          {action.error !== null && <span class="error">{action.error}</span>}
          {attaching && <AttachButton onFiles={drafts.add} />}
          <button class="primary" disabled={action.busy || !ready} onClick={() => void start()} title={touch ? undefined : "Enter"}>
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
      {menu?.kind === "start" && (
        <StartPopover key={menu.id} hosts={hosts} nodes={nodes} projectId={menu.id} defaultBranch={defaultBranchOf(nodes, menu.id)}
          title={titleOf} anchor={menu.anchor} onClose={() => setMenu(null)}
          onPick={(picked) => { setStart(menu.id, picked); setMenu(null); }} />
      )}
      {menu?.kind === "node" && (
        <Popover anchor={menu.anchor} onClose={() => setMenu(null)} wide>
          <div class="menu-head">Run on</div>
          <MenuItem onClick={() => { setPicked(null); setMenu(null); }} meta="placement picks">Automatic</MenuItem>
          {canHost.map((n) => (
            <MenuItem key={n.nodeId} title={n.nodeId} onClick={() => { setPicked(n.nodeId); setMenu(null); }} meta={nodeMeta(n)}>
              <NodeDot node={n} /> {n.hostname}
            </MenuItem>
          ))}
        </Popover>
      )}
    </div>
  );
}

/** What a node lists of its models. */
type Models = NodeRef["models"]["value"];

/** `render` given the models of the node on `host`, or of `fallback` while there is none or its node has not loaded. */
function NodeModels({ host, fallback, render }: { host: Host | undefined; fallback: NodeRef; render(models: Models): ComponentChildren }) {
  return host === undefined ? <ModelsOf node={fallback} render={render} /> : <ModelsOn host={host} fallback={fallback} render={render} />;
}

function ModelsOn({ host, fallback, render }: { host: Host; fallback: NodeRef; render(models: Models): ComponentChildren }) {
  const picked = useObject(host, NodeObject, {});
  return <ModelsOf key={picked.ref === undefined ? "fallback" : "picked"} node={picked.ref ?? fallback} render={render} />;
}

function ModelsOf({ node, render }: { node: NodeRef; render(models: Models): ComponentChildren }) {
  return <>{render(useValue(node.models))}</>;
}
