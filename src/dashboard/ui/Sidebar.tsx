// The sidebar: projects with their tasks, the tasks with no project or several, the archived tasks (collapsed), and
// the pool's nodes at the foot. Each task row carries its state, what waits on you, and the node it runs on.
import { useState } from "preact/hooks";
import { shortId } from "../../pool/ids";
import { useAction, useValue } from "./hooks";
import { type Anchor, MenuItem, MoveMenu, nodeDot, type PoolNode, type PoolRef, Popover, RenameInput, RestoreMenu, StateDot } from "./common";
import { projectChoices } from "./pool-model";
import { hashOf, type View } from "./routes";
import { groupTasks, nodeLineText, waitsOnYou } from "./sidebar-model";
import type { ListedTask, PoolIndex } from "./sources";

const ARCHIVED_OPEN_KEY = "meddle.sidebar.archived";

function stored(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function store(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {
    // a private window: remembered for this page only
  }
}

export function Sidebar({ pool, index, view, selfId, onHide, onNavigate }: {
  pool: PoolRef; index: PoolIndex; view: View; selfId: string; onHide(): void; onNavigate(): void;
}) {
  const nodes = useValue(pool.nodes);
  const mixedVersions = useValue(pool.mixedVersions);
  const groups = groupTasks(projectChoices(nodes), index.tasks);
  const [archivedOpen, setArchivedOpen] = useState(() => stored(ARCHIVED_OPEN_KEY));
  const nameOf = (nodeId: string) => nodes.find((n) => n.nodeId === nodeId)?.hostname ?? shortId(nodeId);
  const isNew = (projectId: string | null) => view.name === "new" && view.projectId === projectId;
  const row = (t: ListedTask, indent: boolean) => (
    <TaskRow key={`${t.nodeId}/${t.id}`} task={t} nodes={nodes} nameOf={nameOf} indent={indent}
      selected={view.name === "task" && view.id === t.id} onNavigate={onNavigate} />
  );
  const ordered = [...nodes.filter((n) => n.status === "member")].sort((a, b) => Number(b.nodeId === selfId) - Number(a.nodeId === selfId));
  return (
    <nav class="sidebar" onClick={(e) => { if ((e.target as HTMLElement).closest("a") !== null) onNavigate(); }}>
      <div class="side-top">
        <strong class="brand">meddle</strong>
        <button class="icon" title="Hide the sidebar" onClick={onHide}>◧</button>
        <a class={`icon${view.name === "settings" ? " on" : ""}`} title="Settings" href={hashOf({ name: "settings" })}>⚙</a>
      </div>
      <div class="side-scroll">
        <div class="side-head">
          <span>Projects</span>
          <a class="icon" title="Add a project" href={hashOf({ name: "add-project" })}>＋</a>
        </div>
        {groups.projects.length === 0 && <div class="side-note">No projects yet.</div>}
        {groups.projects.map((p) => (
          <div key={p.id} class="side-group">
            <a class={`side-project${view.name === "project" && view.id === p.id ? " sel" : ""}`} href={hashOf({ name: "project", id: p.id })} title={p.id}>
              <span class="folder">▸</span>{p.name}
            </a>
            {p.tasks.map((t) => row(t, true))}
            <a class={`side-row new indent${isNew(p.id) ? " sel" : ""}`} href={hashOf({ name: "new", projectId: p.id })}>New task</a>
          </div>
        ))}
        <div class="side-head">
          <span>Tasks</span>
          <a class="icon" title="New task" href={hashOf({ name: "new", projectId: null })}>＋</a>
        </div>
        {groups.shared.map((t) => row(t, false))}
        <a class={`side-row new${isNew(null) ? " sel" : ""}`} href={hashOf({ name: "new", projectId: null })}>New task</a>
        {groups.archived.length > 0 && (
          <>
            <button class="side-head toggle" onClick={() => { store(ARCHIVED_OPEN_KEY, !archivedOpen); setArchivedOpen(!archivedOpen); }}>
              <span>{archivedOpen ? "▾" : "▸"} Archived</span>
              <span class="count">{groups.archived.length}</span>
            </button>
            {archivedOpen && groups.archived.map((t) => row(t, false))}
          </>
        )}
      </div>
      <div class="side-foot">
        <div class="side-head">
          <span>Nodes</span>
          {mixedVersions && <span class="flag" title="The pool's members run different meddle or Claude Code versions">⚠ versions differ</span>}
        </div>
        {ordered.map((n) => <NodeRow key={n.nodeId} row={n} index={index} selected={view.name === "node" && view.nodeId === n.nodeId} self={n.nodeId === selfId} />)}
      </div>
    </nav>
  );
}

function NodeRow({ row, index, selected, self }: { row: PoolNode; index: PoolIndex; selected: boolean; self: boolean }) {
  const ref = index.nodes.get(row.nodeId);
  return (
    <a class={`node-row${selected ? " sel" : ""}`} href={hashOf({ name: "node", nodeId: row.nodeId })} title={`${row.nodeId}${self ? " (this node)" : ""}`}>
      <span class={nodeDot(row)} />
      <span class={row.online ? "" : "muted"}>{row.hostname}</span>
      {ref === undefined ? <span class="meta">{nodeLineText(row, null, Date.now())}</span> : <NodeLoad row={row} node={ref} />}
    </a>
  );
}

function NodeLoad({ row, node }: { row: PoolNode; node: NonNullable<ReturnType<PoolIndex["nodes"]["get"]>> }) {
  const metrics = useValue(node.metrics);
  return <span class="meta">{nodeLineText(row, metrics?.load1 ?? null, Date.now())}</span>;
}

type Menu = { kind: "actions" | "move" | "restore"; anchor: Anchor };

/** A task's row: its state, title, what waits on you and its node; ⋯ (or a right click) opens its actions. */
function TaskRow({ task, nodes, nameOf, indent, selected, onNavigate }: {
  task: ListedTask; nodes: readonly PoolNode[]; nameOf(nodeId: string): string; indent: boolean; selected: boolean; onNavigate(): void;
}) {
  const [menu, setMenu] = useState<Menu | null>(null);
  const [renaming, setRenaming] = useState(false);
  const action = useAction();
  const close = () => setMenu(null);
  const openMenu = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ kind: "actions", anchor: { x: e.clientX, y: e.clientY } });
  };
  const moving = task.moveTo !== null;
  const where = moving ? `${nameOf(task.nodeId)} → ${nameOf(task.moveTo!)}` : task.archived ? `on ${nameOf(task.nodeId)}` : nameOf(task.nodeId);
  const href = hashOf({ name: "task", nodeId: task.nodeId, id: task.id });
  const others = task.projects.length > 1 ? `${task.projects.length} projects` : null;
  return (
    <>
      <a class={`side-row trow${indent ? " indent" : ""}${selected ? " sel" : ""}${task.archived ? " archived" : ""}`} href={href}
        onContextMenu={openMenu} title={task.projects.map((p) => p.name).join(", ") || undefined}>
        <StateDot state={task.state} waiting={waitsOnYou(task)} />
        {renaming
          ? <RenameInput value={task.title} onDone={() => setRenaming(false)} onSave={(title) => action.run(() => task.ref.rename({ title }))} />
          : <span class="title">{task.title}</span>}
        {task.pending > 0 && <span class="badge">{task.pending}</span>}
        {others !== null && <span class="chip">{others}</span>}
        <span class={`where${moving ? " moving" : ""}`}>{where}</span>
        <button class="more" title="Actions" onClick={openMenu}>⋯</button>
      </a>
      {action.error !== null && <div class="side-note error">{action.error}</div>}
      {menu?.kind === "actions" && (
        <Popover anchor={menu.anchor} onClose={close}>
          {task.archived ? (
            <>
              <MenuItem onClick={() => setMenu({ kind: "restore", anchor: menu.anchor })}>Restore…</MenuItem>
              <MenuItem onClick={() => {
                close();
                if (confirm(`Delete "${task.title}", its log and its archive? This cannot be undone.`)) void action.run(() => task.ref.delete({}));
              }}>Delete</MenuItem>
            </>
          ) : (
            <>
              <MenuItem disabled={moving} onClick={() => { close(); setRenaming(true); }}>Rename</MenuItem>
              <MenuItem disabled={moving} onClick={() => setMenu({ kind: "move", anchor: menu.anchor })} meta={nameOf(task.nodeId)}>Move to…</MenuItem>
              <MenuItem disabled={task.state !== "idle" || moving} title="Removes the task's folder from its node and keeps its log; Restore brings it back"
                onClick={() => { close(); void action.run(() => task.ref.archive({})); }}>Archive</MenuItem>
            </>
          )}
        </Popover>
      )}
      {menu?.kind === "move" && <MoveMenu task={task.ref} nodes={nodes} from={task.nodeId} anchor={menu.anchor} onClose={close} />}
      {menu?.kind === "restore" && (
        <RestoreMenu task={task.ref} nodes={nodes} holder={task.nodeId} anchor={menu.anchor} onClose={close}
          onRestored={(nodeId) => { if (selected) location.hash = hashOf({ name: "task", nodeId, id: task.id }); onNavigate(); }} />
      )}
    </>
  );
}

