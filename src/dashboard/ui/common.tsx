// What several views share: the pool's reference type, menus, state dots, the move and restore menus.
import type { Ref } from "@earendil-works/chord";
import type { ComponentChildren } from "preact";
import { createContext } from "preact";
import { useContext, useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { NodeObject, PoolObject, TaskObject } from "../../state/contracts";
import { type HostStatus, useAction } from "./hooks";
import { EFFORT_LEVELS } from "../../pool/settings";
import { moveChoices } from "./sidebar-model";

/** `PoolObject` as a dashboard holds it: its `default` variant. */
export type PoolRef = Extract<Ref<typeof PoolObject>, { variant: "default" }>;
export type PoolNode = PoolRef["nodes"]["value"][number];
export type TaskRef = Ref<typeof TaskObject>;

/** Whether the sidebar shows, and a way to flip it (the pane heads show the toggle while it does not). */
export const Nav = createContext<{ open: boolean; toggle(): void }>({ open: true, toggle() {} });

/** A pane's head: the sidebar toggle while the sidebar is closed, then `children`. */
export function PaneHead({ children }: { children: ComponentChildren }) {
  const nav = useContext(Nav);
  return (
    <header class="pane-head">
      {!nav.open && <button class="icon" title="Show the sidebar" onClick={nav.toggle}>☰</button>}
      {children}
    </header>
  );
}

/** Why an online node's objects cannot be had right now (`Hosts.for` gave no host). */
export function Unavailable({ status }: { status: HostStatus }) {
  if (status === "incompatible") return <p class="flag">Incompatible version: this dashboard cannot talk to it. Upgrade the older node.</p>;
  if (status === "backoff") return <p class="muted">Unreachable; retrying shortly.</p>;
  return <p class="muted">Connecting…</p>;
}

/** A node's dot class: green online, green with a halo while it runs tasks, grey offline. */
export function nodeDot(node: { online: boolean; running: number }): string {
  return `dot ${!node.online ? "off" : node.running > 0 ? "busy" : "ok"}`;
}

/** A task's state as a dot: running, waiting on you, idle, moving, archived. */
export function StateDot({ state, waiting }: { state: string; waiting: boolean }) {
  const kind = waiting || state === "waiting" ? "wait" : state === "running" ? "run" : state === "moving" || state === "receiving" ? "move" : state === "archived" ? "off" : "idle";
  return <span class={`dot ${kind}`} title={waiting ? "waiting on you" : state} />;
}

/** Where a popover opens: the viewport point under it (a click), or the element it hangs from. */
export type Anchor = { x: number; y: number } | { el: HTMLElement; above?: boolean };

/** A floating panel at `anchor`, kept on screen; Escape or a click outside it closes it. */
export function Popover({ anchor, onClose, children, wide = false }: { anchor: Anchor; onClose(): void; children: ComponentChildren; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const box = ref.current;
    if (box === null) return;
    const { width, height } = box.getBoundingClientRect();
    let left: number;
    let top: number;
    if ("el" in anchor) {
      const r = anchor.el.getBoundingClientRect();
      left = r.left;
      top = anchor.above === true ? r.top - height - 4 : r.bottom + 4;
    } else {
      ({ x: left, y: top } = anchor);
    }
    const margin = 8;
    left = Math.max(margin, Math.min(left, innerWidth - width - margin));
    top = Math.max(margin, Math.min(top, innerHeight - height - margin));
    setAt({ left, top });
  }, [anchor]);
  useEffect(() => {
    const down = (e: MouseEvent) => { if (ref.current !== null && !ref.current.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    // Not the click that opened it: listen from the next tick.
    const timer = setTimeout(() => addEventListener("mousedown", down), 0);
    addEventListener("keydown", key);
    return () => {
      clearTimeout(timer);
      removeEventListener("mousedown", down);
      removeEventListener("keydown", key);
    };
  }, [onClose]);
  return (
    // Preact 11 sets numbers as they are: lengths need their unit.
    <div ref={ref} class={`popover${wide ? " wide" : ""}`}
      style={at === null ? { visibility: "hidden", left: "0px", top: "0px" } : { left: `${at.left}px`, top: `${at.top}px` }}>
      {children}
    </div>
  );
}

/** One line of a menu. */
export function MenuItem({ onClick, disabled = false, children, meta, title }: {
  onClick?: () => void; disabled?: boolean; children: ComponentChildren; meta?: ComponentChildren; title?: string;
}) {
  return (
    <button class="menu-item" disabled={disabled} title={title} onClick={onClick}>
      <span class="menu-label">{children}</span>
      {meta !== undefined && <span class="menu-meta">{meta}</span>}
    </button>
  );
}

/** What the move menu says about a node beyond its name: what runs there. */
export function nodeMeta(n: PoolNode): string {
  return n.running === 0 ? "idle" : `${n.running} running`;
}

/**
 * Where to move a task on `from`: every other member, those that cannot take it greyed with why, and whether the
 * move waits for the running turn (the default) or interrupts it.
 */
export function MoveMenu({ task, nodes, from, anchor, onClose }: {
  task: TaskRef; nodes: readonly PoolNode[]; from: string; anchor: Anchor; onClose(): void;
}) {
  const self = nodes.find((n) => n.nodeId === from);
  const choices = moveChoices(nodes, from, self?.claudeCodeVersion ?? "");
  const [now, setNow] = useState(false);
  const action = useAction();
  const move = async (nodeId: string) => {
    if (await action.run(() => task.moveTo({ nodeId, now }))) onClose();
  };
  return (
    <Popover anchor={anchor} onClose={onClose} wide>
      <div class="menu-head">Move to</div>
      {choices.length === 0 && <div class="menu-note">No other node in the pool.</div>}
      {choices.map(({ node, reason }) => (
        <MenuItem key={node.nodeId} disabled={reason !== null || action.busy} title={node.nodeId} onClick={() => void move(node.nodeId)}
          meta={reason ?? nodeMeta(node)}>
          <span class={nodeDot(node)} /> {node.hostname}
        </MenuItem>
      ))}
      <div class="menu-sep" />
      <div class="seg" role="radiogroup">
        <button class={now ? "" : "on"} onClick={() => setNow(false)}>After this turn</button>
        <button class={now ? "on" : ""} title="Interrupts the running turn. Background shells and subagents on this node stop and do not travel."
          onClick={() => setNow(true)}>Now (interrupts)</button>
      </div>
      {action.error !== null && <div class="menu-note error">{action.error}</div>}
    </Popover>
  );
}

/**
 * Where to restore an archived task held by `holder`: where placement says, on the holder, or on another node that
 * can take it. Answers through `onRestored` with the node it is on (or on its way to).
 */
export function RestoreMenu({ task, nodes, holder, anchor, onClose, onRestored }: {
  task: TaskRef; nodes: readonly PoolNode[]; holder: string; anchor: Anchor; onClose(): void; onRestored?(nodeId: string): void;
}) {
  const self = nodes.find((n) => n.nodeId === holder);
  const choices = moveChoices(nodes, holder, self?.claudeCodeVersion ?? "");
  const action = useAction();
  const restore = async (node: string | null) => {
    let to: string | undefined;
    const ok = await action.run(async () => { ({ nodeId: to } = await task.restore({ node })); });
    if (ok) {
      onClose();
      if (to !== undefined) onRestored?.(to);
    }
  };
  return (
    <Popover anchor={anchor} onClose={onClose} wide>
      <div class="menu-head">Restore on</div>
      <MenuItem disabled={action.busy} onClick={() => void restore(null)} meta="placement picks">Automatic</MenuItem>
      {self !== undefined && (
        <MenuItem disabled={action.busy} title={self.nodeId} onClick={() => void restore(self.nodeId)} meta="holds its archive">
          <span class={nodeDot(self)} /> {self.hostname}
        </MenuItem>
      )}
      {choices.map(({ node, reason }) => (
        <MenuItem key={node.nodeId} disabled={reason !== null || action.busy} title={node.nodeId} onClick={() => void restore(node.nodeId)}
          meta={reason ?? nodeMeta(node)}>
          <span class={nodeDot(node)} /> {node.hostname}
        </MenuItem>
      ))}
      {action.error !== null && <div class="menu-note error">{action.error}</div>}
    </Popover>
  );
}

/** A title edited in place: Enter saves, Escape or leaving it cancels. */
export function RenameInput({ value, onSave, onDone }: { value: string; onSave(title: string): Promise<boolean>; onDone(): void }) {
  const [text, setText] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  const save = async () => {
    if (text.trim() === "" || text.trim() === value) return onDone();
    if (await onSave(text)) onDone();
  };
  return (
    <input ref={ref} class="rename" value={text} onInput={(e) => setText(e.currentTarget.value)} onBlur={onDone}
      onClick={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); void save(); }
        if (e.key === "Escape") { e.preventDefault(); onDone(); }
      }} />
  );
}

export function tokenText(token: { present: boolean; expiresAt: string | null }): string {
  if (!token.present) return "missing";
  if (token.expiresAt === null) return "present, expiry unknown";
  const days = Math.floor((Date.parse(token.expiresAt) - Date.now()) / 86_400_000);
  return `${days < 0 ? "expired" : `expires in ${days} days`} (${new Date(token.expiresAt).toLocaleDateString()})`;
}

export function mb(kb: number): string {
  return kb >= 1024 * 1024 ? `${(kb / 1024 / 1024).toFixed(1)} GiB` : `${(kb / 1024).toFixed(0)} MiB`;
}

export type Model = Ref<typeof NodeObject>["models"]["value"][number];

/** What a model of unknown efforts is offered. */
const unknown = (value: string, displayName: string): Model => ({ value, resolvedModel: null, displayName, description: "", efforts: [...EFFORT_LEVELS] });

/** Offered while the node has listed none: no turn has run there yet. */
const FALLBACK_MODELS: readonly Model[] = [unknown("fable", "Fable"), unknown("opus", "Opus"), unknown("sonnet", "Sonnet"), unknown("haiku", "Haiku")];

/** Whether `m` is model `id`: its alias or the id the alias resolves to. */
function isModel(m: Model, id: string): boolean {
  return m.value === id || m.resolvedModel === id;
}

/** The models to pick from: the node's list (else `FALLBACK_MODELS`), with `current` kept in when it lists no such. */
function modelChoices(listed: readonly Model[], current: string): readonly Model[] {
  const all = listed.length > 0 ? listed : FALLBACK_MODELS;
  return all.some((m) => isModel(m, current)) ? all : [unknown(current, current), ...all];
}

/**
 * A model and effort as one pill (`✦ Opus · medium`); it opens the models, each with its description, and the efforts
 * the picked one takes. Picking the model already picked changes nothing; an effort the new model lacks is kept.
 */
export function ModelPicker({ models, model, effort, disabled = false, onModel, onEffort }: {
  models: readonly Model[]; model: string; effort: string; disabled?: boolean; onModel(model: string): void; onEffort(effort: string): void;
}) {
  const [at, setAt] = useState<Anchor | null>(null);
  const choices = modelChoices(models, model);
  const current = choices.find((m) => isModel(m, model))!;
  return (
    <>
      <button class="pill" title="Model and effort" disabled={disabled} onClick={(e) => setAt({ el: e.currentTarget, above: true })}>
        ✦ {current.displayName}{current.efforts.length > 0 && ` · ${effort}`} ▾
      </button>
      {at !== null && (
        <Popover anchor={at} onClose={() => setAt(null)} wide>
          <div class="menu-head">Model</div>
          {choices.map((m) => (
            <button key={m.value} class={`menu-item${m === current ? " on" : ""}`} title={m.resolvedModel ?? m.value}
              onClick={() => { if (m !== current) onModel(m.value); }}>
              <span class="menu-check">{m === current && "✓"}</span>
              <span class="menu-two"><span>{m.displayName}</span>{m.description !== "" && <span class="menu-desc">{m.description}</span>}</span>
            </button>
          ))}
          {current.efforts.length > 0 && (
            <>
              <div class="menu-sep" />
              <div class="menu-head">Effort</div>
              <div class="menu-seg">
                {EFFORT_LEVELS.map((l) => (
                  <button key={l} class={l === effort ? "on" : ""} disabled={!current.efforts.includes(l)} onClick={() => { if (l !== effort) onEffort(l); }}>{l}</button>
                ))}
              </div>
            </>
          )}
        </Popover>
      )}
    </>
  );
}
