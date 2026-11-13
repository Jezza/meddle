// One task: its head (title, state, actions), the thread from the session's event log with what waits on you inline,
// the composer, and the bar beneath (project, node, bookmark, the latest turn's tokens, model and effort).
import type { Host, Ref } from "@earendil-works/chord";
import DOMPurify from "dompurify";
import { createContext } from "preact";
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { type Live as LiveState, NodeObject, SessionObject, TaskObject } from "../../state/contracts";
import { shortId } from "../../pool/ids";
import { type Hosts, useAction, useObject, useValue } from "./hooks";
import { type Anchor, ModelPicker, MoveMenu, PaneHead, type PoolRef, RenameInput, RestoreMenu, StateDot, Unavailable } from "./common";
import { renderMarkdown } from "./markdown";
import { hashOf } from "./routes";
import { usageShort } from "./sidebar-model";
import {
  activity, activityLine, buildThread, cwdOf, type DiffLine, duration, EDITS, editDiff, exitCode, type Explored, exploredLine, foldSteps, isLook,
  keyOf, type ShownItem, toolSummary, toolTarget, type ToolItem,
} from "./thread-model";

type NodeRef = Ref<typeof NodeObject>;
type TaskRef = Ref<typeof TaskObject>;
type SessionRef = Ref<typeof SessionObject>;
type Pending = TaskRef["pending"]["value"][number];
type LogEvent = SessionRef["window"]["value"][number];

const EARLIER_PAGE = 200;
/** Lines added and removed, at most, for a change's row to open by itself and show its diff. */
const SMALL_DIFF = 12;
const MOVE_NOW_WARNING = "Interrupts the running turn. Background shells and subagents on this node stop and do not travel.";

// Links in the model's text open in a new tab, never in place of the dashboard.
DOMPurify.addHook("afterSanitizeAttributes", (el) => {
  if (el.tagName === "A") {
    el.setAttribute("target", "_blank");
    el.setAttribute("rel", "noopener noreferrer");
  }
});

/** A task on any member: through that node's host while it is online. */
export function TaskView({ hosts, pool, nodeId, taskId }: { hosts: Hosts; pool: PoolRef; nodeId: string; taskId: string }) {
  const row = useValue(pool.nodes).find((n) => n.nodeId === nodeId);
  const message = (text: string, cls = "muted") => <><PaneHead><span class="muted">Task</span></PaneHead><p class={`pane-note ${cls}`}>{text}</p></>;
  // This node's own tasks are always reachable over /ws.
  if (nodeId !== hosts.selfId) {
    if (row === undefined) return message(`Node ${shortId(nodeId)} is not in this pool.`, "error");
    if (row.status === "removed") return message(`${row.hostname} (${shortId(nodeId)}) was removed from the pool.`, "error");
    if (!row.online) return message(`${row.hostname} (${shortId(nodeId)}) is offline; the task shows again once it is back.`);
  }
  const host = hosts.for(nodeId);
  if (host === undefined) return <><PaneHead><span class="muted">Task</span></PaneHead><div class="pane-note"><Unavailable status={hosts.status(nodeId)} /></div></>;
  return <TaskOnline host={host} pool={pool} taskId={taskId} />;
}

function TaskOnline({ host, pool, taskId }: { host: Host; pool: PoolRef; taskId: string }) {
  const node = useObject(host, NodeObject, {});
  const task = useObject(host, TaskObject, { id: taskId });
  const session = useObject(host, SessionObject, { taskId });
  const error = node.error ?? task.error ?? session.error;
  if (error !== undefined) return <><PaneHead><span class="muted">Task</span></PaneHead><p class="pane-note error">{error}</p></>;
  if (node.ref === undefined || task.ref === undefined || session.ref === undefined) {
    return <><PaneHead><span class="muted">Loading task…</span></PaneHead></>;
  }
  return <TaskLoaded node={node.ref} pool={pool} task={task.ref} session={session.ref} />;
}

function TaskLoaded({ node, pool, task, session }: { node: NodeRef; pool: PoolRef; task: TaskRef; session: SessionRef }) {
  const manifest = useValue(task.manifest);
  const state = useValue(task.state);
  const pending = useValue(task.pending);
  const queued = useValue(task.queued);
  const move = useValue(task.move);
  const movedTo = useValue(task.movedTo);
  const archivedOn = useValue(task.archivedOn);
  const acceptance = useValue(task.acceptance);
  const nodeId = useValue(node.nodeId);
  const nodes = useValue(pool.nodes);
  const nameOf = (id: string) => nodes.find((n) => n.nodeId === id)?.hostname ?? shortId(id);

  // A task that moved on is followed to where it went.
  useEffect(() => {
    if (state === "moved" && movedTo !== null) location.replace(hashOf({ name: "task", nodeId: movedTo, id: manifest.id }));
  }, [state, movedTo, manifest.id]);
  useEffect(() => { document.title = `${manifest.title} · meddle`; return () => { document.title = "meddle"; }; }, [manifest.title]);

  const archived = state === "archived";
  const moving = state === "moving" || move !== null;
  const live = state === "running" || state === "waiting";
  /** Shows every event in the thread, the ones it otherwise leaves out included. */
  const [raw, setRaw] = useState(false);
  return (
    <div class="task">
      <TaskHead task={task} nodes={nodes} nodeId={nodeId} title={manifest.title} state={state} pendingCount={pending.length} moving={moving}
        partly={acceptance === "partly" && !archived && state !== "moved"} raw={raw} onRaw={() => setRaw(!raw)} />
      {move !== null && <MoveBanner task={task} move={move} to={nameOf(move.to)} />}
      {state === "moved" ? (
        <p class="pane-note">Moved to {movedTo === null ? "another node" : <a href={hashOf({ name: "task", nodeId: movedTo, id: manifest.id })}>{nameOf(movedTo)}</a>}.</p>
      ) : (
        <Thread session={session} readOnly={archived} working={state === "running"} raw={raw} after={<>
          {pending.map((p) => <PendingPanel key={p.requestId} task={task} pending={p} />)}
          {queued.map((text, i) => <Queued key={i} text={text} />)}
        </>} />
      )}
      {!archived && state !== "moved" && <Composer task={task} running={live} disabled={moving} />}
      <BottomBar task={task} pool={pool} node={node} nodeId={nodeId} archived={archived} archivedOn={archivedOn === null ? null : nameOf(archivedOn)} moving={moving} />
    </div>
  );
}

// ─── the head ───

function TaskHead({ task, nodes, nodeId, title, state, pendingCount, moving, partly, raw, onRaw }: {
  task: TaskRef; nodes: PoolRef["nodes"]["value"]; nodeId: string; title: string; state: string; pendingCount: number; moving: boolean;
  /** A pushed branch contains the task's line for some of its projects, not all: nothing is archived yet. */
  partly: boolean;
  raw: boolean; onRaw: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [restoreAt, setRestoreAt] = useState<Anchor | null>(null);
  const action = useAction();
  const archived = state === "archived";
  const live = state === "running" || state === "waiting";
  const stateText = pendingCount > 0 ? "waiting on you" : state;
  const remove = () => action.run(async () => {
    if (!confirm(`Delete "${title}", its log and its archive? This cannot be undone.`)) return;
    await task.delete({});
    location.hash = hashOf({ name: "home" });
  });
  return (
    <PaneHead>
      <div class="task-title">
        {renaming
          ? <RenameInput value={title} onDone={() => setRenaming(false)} onSave={(t) => action.run(() => task.rename({ title: t }))} />
          : <>
            <strong title={title}>{title}</strong>
            {!archived && !moving && state !== "moved" && <button class="icon" title="Rename" onClick={() => setRenaming(true)}>✎</button>}
          </>}
        <StateDot state={state} waiting={pendingCount > 0} />
        <span class="muted state-text">{stateText}</span>
        {partly && (
          <span class="muted state-text" title="A pushed branch contains this task's work for some of its projects; it is archived once every project's is">
            · partly accepted
          </span>
        )}
      </div>
      <div class="head-actions">
        {action.error !== null && <span class="error" title={action.error}>{action.error}</span>}
        <button class={raw ? "on" : ""} aria-pressed={raw} title="Show every event, bookkeeping included" onClick={onRaw}>Raw</button>
        {live && <button disabled={moving || action.busy} onClick={() => action.run(() => task.interrupt({}))}>■ Interrupt</button>}
        {/* Retry runs a parked turn (one that crashed the node too often) again, or carries on an idle task's last turn (interrupted or failed). */}
        {(live ? pendingCount === 0 : state === "idle") && !moving && (
          <button disabled={action.busy} title={live ? "Runs a parked turn again" : "Carries on the last turn, e.g. one you interrupted"} onClick={() => action.run(() => task.retry({}))}>↻ Retry</button>
        )}
        {/* Only an idle task archives; the node says why it refuses one (queued prompts, a home offline, …). */}
        {state === "idle" && !moving && (
          <button disabled={action.busy} title="Removes the task's folder from this node and keeps its log; Restore brings it back"
            onClick={() => action.run(() => task.archive({}))}>▣ Archive</button>
        )}
        {archived && <>
          <button disabled={action.busy} onClick={(e) => setRestoreAt({ el: e.currentTarget })}>Restore ▾</button>
          <button disabled={action.busy} onClick={remove}>Delete</button>
        </>}
      </div>
      {restoreAt !== null && (
        <RestoreMenu task={task} nodes={nodes} holder={nodeId} anchor={restoreAt} onClose={() => setRestoreAt(null)}
          onRestored={(to) => { location.hash = hashOf({ name: "task", nodeId: to, id: task.manifest.value.id }); }} />
      )}
    </PaneHead>
  );
}

/** What a move is doing at each step, in words. */
function moveText(phase: string, to: string): string {
  switch (phase) {
    case "prepare": return `Moving to ${to} once the current turn ends`;
    case "handoff": return `Moving to ${to}: sending the task`;
    case "commit": return `Moving to ${to}: ${to} is taking over`;
    case "cleanup": return `Moved to ${to}: cleaning up here`;
    default: return `Moving to ${to}`;
  }
}

/**
 * A move in progress: what it is doing, and while it can still be called off, Cancel (the task stays here, its turn
 * untouched); while it waits for the turn, Move now (interrupts the turn).
 */
function MoveBanner({ task, move, to }: { task: TaskRef; move: { to: string; phase: string; error: string | null }; to: string }) {
  const action = useAction();
  const waiting = move.phase === "prepare";
  const cancellable = waiting || move.phase === "handoff";
  return (
    <div class="banner">
      <span>⇄ {moveText(move.phase, to)}</span>
      {move.error !== null && <span class="error">{move.error}</span>}
      {action.error !== null && <span class="error">{action.error}</span>}
      <span class="banner-actions">
        {waiting && <button disabled={action.busy} title={MOVE_NOW_WARNING} onClick={() => action.run(() => task.moveNow({}))}>Move now</button>}
        {cancellable && (
          <button disabled={action.busy} title="Calls the move off: the task stays on this node, its turn untouched"
            onClick={() => action.run(() => task.cancelMove({}))}>Cancel</button>
        )}
      </span>
    </div>
  );
}

// ─── the thread ───

type Block = { who: "user" | "claude" | "status"; items: ShownItem[] };

/** The shown items in blocks: each user message alone, Claude's run of items together, status lines apart. */
function blocksOf(items: readonly ShownItem[]): Block[] {
  const out: Block[] = [];
  for (const item of items) {
    const who = item.kind === "user" ? "user" : item.kind === "status" ? "status" : "claude";
    const last = out.at(-1);
    if (last !== undefined && last.who === who && who !== "user") last.items.push(item);
    else out.push({ who, items: [item] });
  }
  return out;
}

function Thread({ session, readOnly, working, raw, after }: {
  session: SessionRef; readOnly: boolean; working: boolean; raw: boolean; after: preact.ComponentChildren;
}) {
  const window = useValue(session.window);
  const live = useValue(session.live);
  /** Every event seen since the view opened: the window slides past events, and "load earlier" adds older ones. */
  const [seen, setSeen] = useState<Map<number, LogEvent>>(() => new Map());
  const [noneEarlier, setNoneEarlier] = useState(false);
  const action = useAction();
  useEffect(() => setSeen((prev) => merged(prev, window)), [window]);

  const events = useMemo(() => [...merged(seen, window).values()].sort((a, b) => a.seq - b.seq), [seen, window]);
  const items = useMemo(() => buildThread(events), [events]);
  const blocks = useMemo(() => blocksOf(foldSteps(items, raw)), [items, raw]);
  const view = useMemo(() => ({ cwd: cwdOf(events), raw }), [events, raw]);
  const oldest = events[0]?.seq;

  // Kept at the bottom while you are there; left alone while you read further up.
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el !== null && stick.current) el.scrollTop = el.scrollHeight;
  });

  const loadEarlier = () => action.run(async () => {
    if (oldest === undefined) return;
    const earlier = await session.loadEarlier({ beforeSeq: oldest, limit: EARLIER_PAGE });
    if (earlier.length < EARLIER_PAGE) setNoneEarlier(true);
    stick.current = false;
    setSeen((prev) => merged(prev, earlier));
  });

  const lastClaude = blocks.at(-1)?.who === "claude";
  // Kept for the whole running turn, not only while text streams, so it does not blink out between steps.
  const tail = live !== null || working;
  const doing = activity(live, items);
  /** Changes whenever anything streams or lands, so the activity line can tell a quiet turn from a busy one. */
  const pulse = `${events.at(-1)?.seq ?? 0}:${live?.text.length ?? -1}:${live?.thinking.length ?? -1}:${live?.block ?? ""}`;
  return (
    <ThreadView.Provider value={view}>
    <div class="thread-scroll" ref={scroller}
      onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
      <div class="thread">
        {oldest !== undefined && oldest > 1 && !noneEarlier && (
          <button class="earlier" disabled={action.busy} onClick={loadEarlier}>Load earlier</button>
        )}
        {action.error !== null && <p class="error">{action.error}</p>}
        {blocks.length === 0 && !tail && <p class="muted empty">{readOnly ? "Nothing in this task's log." : "Nothing yet: send a prompt below."}</p>}
        {blocks.map((b, i) => (
          <BlockView key={b.items.map(keyOf).find((k) => k !== undefined) ?? i} block={b}>
            {i === blocks.length - 1 && lastClaude && tail && <Live live={live} doing={doing} pulse={pulse} />}
          </BlockView>
        ))}
        {tail && !lastClaude && <BlockView block={{ who: "claude", items: [] }}><Live live={live} doing={doing} pulse={pulse} /></BlockView>}
        {after}
      </div>
    </div>
    </ThreadView.Provider>
  );
}

function merged(into: Map<number, LogEvent>, events: readonly LogEvent[]): Map<number, LogEvent> {
  if (events.every((e) => into.has(e.seq))) return into;
  const next = new Map(into);
  for (const e of events) next.set(e.seq, e);
  return next;
}

/** A block: your message in a card, Claude's items, status lines on their own. */
function BlockView({ block, children }: { block: Block; children?: preact.ComponentChildren }) {
  const items = <Items items={block.items} />;
  if (block.who === "status") return <div class="status-block">{items}{children}</div>;
  if (block.who === "user") return <div class="msg you">{items}</div>;
  return <div class="msg claude">{items}{children}</div>;
}

/** Items keyed by their call where they have one, so a row you opened stays open as earlier items load or Raw toggles. */
function Items({ items }: { items: readonly ShownItem[] }) {
  return <>{items.map((item, i) => <ShownView key={keyOf(item) ?? i} item={item} />)}</>;
}

/**
 * The running turn's tail: the text streaming, laid out as it will land, then one line saying what the turn is doing
 * and for how long. The line stays last and one line high, so landed items take the streamed text's place without
 * the thread shifting; streamed thinking is not shown, only that it is happening. A turn that should be streaming
 * but has gone quiet (`activityLine`) turns the line red and says for how long.
 */
function Live({ live, doing, pulse }: { live: LiveState; doing: string; pulse: string }) {
  useTick(1000);
  const now = Date.now();
  const phase = seconds(now - useSince(doing));
  const quiet = seconds(now - useSince(pulse));
  const line = activityLine(doing, phase, quiet);
  return (
    <div class="live">
      {live !== null && live.text !== "" && <Markdown text={live.text} />}
      <div class={line.stall > 0 ? "working stalled" : "working"} role="status" style={{ "--stall": String(line.stall) } as Record<string, string>}>
        <span class="dots" aria-hidden="true"><i /><i /><i /></span>
        {line.text}
        {phase >= 1 && <span class="elapsed" aria-hidden="true">· {duration(phase)}</span>}
        {line.stall > 0 && <span class="quiet">· no output for {duration(quiet)}</span>}
      </div>
    </div>
  );
}

const seconds = (ms: number) => Math.max(0, Math.floor(ms / 1000));

/** Renders again every `ms` while mounted. */
function useTick(ms: number) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), ms);
    return () => clearInterval(timer);
  }, [ms]);
}

/** When `key` last changed (or the component mounted). */
function useSince(key: string): number {
  const last = useRef<{ key: string; at: number } | null>(null);
  if (last.current === null || last.current.key !== key) last.current = { key, at: Date.now() };
  return last.current.at;
}

function Markdown({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(renderMarkdown(text)), [text]);
  return <div class="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

/** What every row in the thread reads: the session's working directory (paths show relative to it) and the Raw toggle. */
const ThreadView = createContext({ cwd: "", raw: false });

function ShownView({ item }: { item: ShownItem }) {
  switch (item.kind) {
    case "user":
      return <div class="user-text">{item.text}</div>;
    case "assistant":
      // Thinking alongside text is not shown; thinking on its own is, closed.
      return item.text !== "" ? <Markdown text={item.text} /> : <Thinking text={item.thinking ?? ""} />;
    case "explored":
      return <ExploredRow steps={item.steps} />;
    case "tool":
      return <ToolRow tool={item} />;
    case "unknown":
      return (
        <details class="step">
          <summary><Chevron /><Icon name="raw" /><span class="verb">Event</span><span class="target">{item.type}</span></summary>
          <div class="step-body"><pre class="out">{json(item.raw)}</pre></div>
        </details>
      );
    case "question":
      return (
        <div class="asked">
          <strong>Asked</strong>
          {questionsOf(item.questions).map((q) => <p key={q.question}>{q.question} <span class="muted">({q.options.map((o) => o.label).join(" / ")})</span></p>)}
        </div>
      );
    case "denied":
      return (
        <div class="denied">
          Denied <strong>{item.toolName}</strong>
          {item.reason !== undefined && `: ${item.reason}`}
          {item.reasonType !== undefined && <span class="muted"> ({item.reasonType})</span>}
        </div>
      );
    case "status":
      if (/^Turn (finished|ended)/.test(item.text)) return <div class={`turn-end${item.text.startsWith("Turn ended") ? " bad" : ""}`}><i />{item.text}<i /></div>;
      return <div class={`status${/^(Turn failed|Turn aborted|Token |No usable token|Rate limit rejected)/.test(item.text) ? " bad" : ""}`}>{item.text}</div>;
  }
}

/** Thinking as a row: its first line, closed; open, the whole of it. */
function Thinking({ text }: { text: string }) {
  return (
    <details class="step">
      <summary><Chevron /><Icon name="thought" /><span class="verb">Thinking</span><span class="target plain muted">{text.split("\n")[0]}</span></summary>
      <div class="step-body"><div class="thinking-text">{text}</div></div>
    </details>
  );
}

const ICONS = {
  search: <><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14" /></>,
  edit: <path d="M10.5 2.5l3 3L6 13H3v-3z" />,
  write: <><path d="M4 1.5h5l3 3v10H4z" /><path d="M8 7.5v4.5M5.75 9.75h4.5" /></>,
  bash: <><path d="M2.5 4l4 4-4 4" /><path d="M8 12.5h5.5" /></>,
  agent: <><circle cx="4" cy="3.5" r="1.5" /><circle cx="4" cy="12.5" r="1.5" /><circle cx="12" cy="6" r="1.5" /><path d="M4 5v6M12 7.5c0 2.5-3 3-6.5 4" /></>,
  tool: <><rect x="2.5" y="2.5" width="11" height="11" rx="2" /><path d="M5.5 8h5" /></>,
  raw: <path d="M5 3.5 1.5 8 5 12.5M11 3.5 14.5 8 11 12.5" />,
  thought: <path d="M3 3.5h10v7H7l-3 2.5v-2.5H3z" />,
  failed: <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />,
  running: <path d="M8 2a6 6 0 1 1-6 6" />,
} as const;

/** A call's icon in its small square, tinted by `name` (index.html's `.chip`). */
function Icon({ name }: { name: keyof typeof ICONS }) {
  return (
    <span class={`chip ${name}`}>
      <svg class={name === "running" ? "ic spin" : "ic"} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"
        stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{ICONS[name]}</svg>
    </span>
  );
}

function Chevron() {
  return <svg class="chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 4l4 4-4 4" /></svg>;
}

/** A row's state, for screen readers: its icon says it only by shape. */
function StateText({ running, failed }: { running: boolean; failed: boolean }) {
  return running ? <span class="sr">running</span> : failed ? <span class="sr">failed</span> : null;
}

/** Calls that only look, folded: what they looked at in one row, each call inside; open by itself once one fails. */
function ExploredRow({ steps }: { steps: Explored["steps"] }) {
  const line = exploredLine(steps);
  return (
    <details class={`step${line.failed > 0 ? " bad" : line.running ? " live" : ""}`} open={line.failed > 0}>
      <summary>
        <Chevron /><Icon name={line.running ? "running" : "search"} />
        <span class="verb">{line.running ? "Exploring" : "Explored"}</span>
        <span class="target plain">{line.text}</span>
        {line.failed > 0 && <span class="meta">{line.failed} failed</span>}
      </summary>
      <div class="sub">
        {steps.map((s, i) => s.kind === "tool" ? <ToolRow key={s.toolUseId || i} tool={s} /> : <Thinking key={i} text={s.thinking ?? ""} />)}
      </div>
    </details>
  );
}

/**
 * One call as a row: its icon (a spinner while it runs, a cross once it fails), its name, what it acted on, and what
 * came of it; open, its diff, output or subagent. A failed call opens by itself, and so does a landed change of at
 * most `SMALL_DIFF` lines.
 */
function ToolRow({ tool }: { tool: ToolItem }) {
  const { cwd, raw } = useContext(ThreadView);
  const running = tool.result === undefined;
  const failed = tool.result?.isError === true;
  const input = (tool.input ?? {}) as Record<string, unknown>;
  const edit = EDITS.includes(tool.name);
  const agent = tool.name === "Agent" || tool.name === "Task";
  const diff = useMemo(() => edit ? editDiff(tool) : null, [edit, tool.input, tool.result]);
  const children = useMemo(() => foldSteps(tool.children, raw), [tool.children, raw]);

  const kind = edit ? (tool.name === "Write" ? "write" : "edit") : tool.name === "Bash" ? "bash" : agent ? "agent" : isLook(tool) ? "search" : "tool";
  const target = toolTarget(tool, cwd);
  const code = exitCode(tool);
  const command = typeof input.command === "string" ? input.command : undefined;
  const result = tool.result;
  // Counts only for a change that landed: a running edit's input overstates it, a failed one's never applied.
  const landed = diff !== null && result !== undefined && !failed;
  const model = agent && typeof input.model === "string" ? input.model : undefined;
  return (
    <details class={`step${failed ? " bad" : running ? " live" : ""}`} open={failed || (landed && diff.added + diff.removed <= SMALL_DIFF)}>
      <summary title={typeof input.file_path === "string" ? input.file_path : command}>
        <Chevron /><Icon name={running ? "running" : failed ? "failed" : kind} /><StateText running={running} failed={failed} />
        <span class="verb">{tool.name}</span>
        <span class={agent ? "target plain" : "target"}>{target}</span>
        {landed && (diff.added > 0 || diff.removed > 0) && (
          <span class="meta"><span class="add">+{diff.added}</span> <span class="del">−{diff.removed}</span></span>
        )}
        {code !== undefined && <span class="meta">exit {code}</span>}
        {model !== undefined && <span class="meta">{model}</span>}
      </summary>
      <div class="step-body">
        {typeof input.description === "string" && !agent && <p class="tool-note muted">{input.description}</p>}
        {diff !== null && diff.lines.length > 0 && <DiffView lines={diff.lines} />}
        {command !== undefined && (command.includes("\n") || command !== target) && <pre class="out">{command}</pre>}
        {diff === null && command === undefined && !agent && <pre class="out">{json(tool.input)}</pre>}
        {(children.length > 0 || tool.agentId !== undefined) && (
          <div class="sub">
            {tool.agentId !== undefined && <p class="muted tool-note">agent {tool.agentId}</p>}
            <Items items={children} />
          </div>
        )}
        {result !== undefined && result.text !== "" && !(edit && !failed) && <pre class={failed ? "out error" : "out"}>{result.text}</pre>}
      </div>
    </details>
  );
}

function DiffView({ lines }: { lines: DiffLine[] }) {
  return (
    <div class="diff">
      {lines.map((l, i) => l.kind === "hunk"
        ? <div key={i} class="dl hunk">{l.text}</div>
        : (
          <div key={i} class={`dl ${l.kind}`}>
            <span class="n">{l.line ?? ""}</span>
            <span class="s">{l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}</span>
            {l.text}
          </div>
        ))}
    </div>
  );
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? String(value);
}

// ─── what waits on you ───

function PendingPanel({ task, pending }: { task: TaskRef; pending: Pending }) {
  return pending.toolName === "AskUserQuestion"
    ? <QuestionPanel task={task} pending={pending} />
    : <ApprovalPanel task={task} pending={pending} />;
}

function ApprovalPanel({ task, pending }: { task: TaskRef; pending: Pending }) {
  const action = useAction();
  const [editing, setEditing] = useState(false);
  const [denying, setDenying] = useState(false);
  const [edited, setEdited] = useState(() => json(pending.input));
  const [message, setMessage] = useState("Denied from the dashboard");
  const { requestId } = pending;
  const summary = toolSummary(pending.input, 400);

  const allowEdited = () => action.run(async () => {
    const updatedInput: unknown = JSON.parse(edited);
    if (updatedInput === null || typeof updatedInput !== "object" || Array.isArray(updatedInput)) {
      throw new Error("the edited input must be a JSON object");
    }
    await task.approve({ requestId, updatedInput: updatedInput as Record<string, unknown> });
  });

  return (
    <section class="ask">
      <h4>{pending.toolName} needs approval</h4>
      {pending.decisionReason !== undefined && <p class="muted">{pending.decisionReason}</p>}
      {editing
        ? <textarea rows={8} value={edited} onInput={(e) => setEdited(e.currentTarget.value)} />
        : summary !== "" && !summary.endsWith("…") ? <><pre>{summary}</pre><details><summary class="muted">full input</summary><pre>{json(pending.input)}</pre></details></>
        : <pre>{json(pending.input)}</pre>}
      {denying && (
        <label class="deny-message">Message to Claude <input value={message} onInput={(e) => setMessage(e.currentTarget.value)} /></label>
      )}
      <div class="ask-actions">
        {denying ? <>
          <button disabled={action.busy} onClick={() => action.run(() => task.deny({ requestId, message }))}>Deny</button>
          <button disabled={action.busy} onClick={() => action.run(() => task.deny({ requestId, message, interrupt: true }))}>Deny &amp; interrupt</button>
          <button disabled={action.busy} onClick={() => setDenying(false)}>Back</button>
        </> : <>
          <button class="primary" disabled={action.busy} onClick={() => action.run(() => editing ? allowEdited() : task.approve({ requestId }))}>
            {editing ? "Allow with this input" : "Allow"}
          </button>
          {!editing && <button disabled={action.busy} onClick={() => setEditing(true)}>Edit &amp; allow…</button>}
          <button disabled={action.busy} onClick={() => setDenying(true)}>Deny…</button>
          <button disabled={action.busy} onClick={() => action.run(() => task.deny({ requestId, message, interrupt: true }))}>Deny &amp; interrupt</button>
        </>}
      </div>
      {action.error !== null && <p class="error">{action.error}</p>}
    </section>
  );
}

type Question = { question: string; header: string; options: Array<{ label: string; description?: string }>; multiSelect: boolean };

function questionsOf(value: unknown): Question[] {
  if (!Array.isArray(value)) return [];
  return value.filter((q): q is Question => typeof q?.question === "string" && Array.isArray(q.options));
}

function QuestionPanel({ task, pending }: { task: TaskRef; pending: Pending }) {
  const questions = questionsOf(pending.input.questions);
  const action = useAction();
  /** Chosen labels per question text, and a typed answer that replaces them. */
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});

  const choose = (q: Question, label: string) => {
    const current = chosen[q.question] ?? [];
    const next = q.multiSelect
      ? (current.includes(label) ? current.filter((l) => l !== label) : [...current, label])
      : [label];
    setChosen({ ...chosen, [q.question]: next });
  };
  const answerOf = (q: Question) => (other[q.question] ?? "").trim() || (chosen[q.question] ?? []).join(", ");
  const complete = questions.every((q) => answerOf(q) !== "");
  const submit = () => action.run(() =>
    task.answerQuestion({ requestId: pending.requestId, answers: Object.fromEntries(questions.map((q) => [q.question, answerOf(q)])) }));

  return (
    <section class="ask">
      <h4>Claude asks</h4>
      {questions.map((q) => (
        <div class="question" key={q.question}>
          <div class="question-head"><span class="chip">{q.header}</span> {q.question}</div>
          {q.options.map((o) => (
            <label key={o.label} class="option">
              <input
                type={q.multiSelect ? "checkbox" : "radio"}
                name={`${pending.requestId}:${q.question}`}
                checked={(chosen[q.question] ?? []).includes(o.label)}
                onChange={() => choose(q, o.label)}
              />{" "}
              {o.label}{o.description !== undefined && <span class="muted"> · {o.description}</span>}
            </label>
          ))}
          <label class="option">Other: <input value={other[q.question] ?? ""} onInput={(e) => setOther({ ...other, [q.question]: e.currentTarget.value })} /></label>
        </div>
      ))}
      <div class="ask-actions">
        <button class="primary" disabled={action.busy || !complete} onClick={submit}>Answer</button>
        <button disabled={action.busy} onClick={() => action.run(() => task.deny({ requestId: pending.requestId, message: "The user declined to answer" }))}>Decline</button>
      </div>
      {action.error !== null && <p class="error">{action.error}</p>}
    </section>
  );
}

// ─── the composer and the bar ───

/** A text the task was sent and has not started on: it joins the thread where Claude takes it. */
function Queued({ text }: { text: string }) {
  return (
    <div class="msg you queued" title="Claude takes it at its next step, or once it is done with the current one">
      <div class="user-text">{text}</div>
      <span class="chip">queued</span>
    </div>
  );
}

function Composer({ task, running, disabled }: { task: TaskRef; running: boolean; disabled: boolean }) {
  const [text, setText] = useState("");
  const action = useAction();
  // Grows with what is typed, up to the stylesheet's max-height, instead of a drag handle.
  const box = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (el === null) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [text]);
  const send = async () => {
    if (disabled || text.trim() === "") return;
    if (await action.run(() => task.prompt({ text }))) setText("");
  };
  return (
    <div class="composer">
      <textarea
        ref={box}
        rows={1}
        disabled={disabled}
        value={text}
        placeholder={disabled ? "Moving: prompts wait until it lands" : running ? "Message Claude: it takes it at its next step…" : "Reply…"}
        onInput={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); } }}
      />
      <div class="composer-row">
        {action.error !== null ? <span class="error">{action.error}</span> : <span class="muted">Ctrl+Enter sends</span>}
        <button class="primary" disabled={disabled || action.busy || text.trim() === ""} onClick={send}>{running ? "Queue" : "Send"}</button>
      </div>
    </div>
  );
}

/** A task bookmark as the bar shows it: its name after `meddle/task/<id>/`, then its change (or "conflicted"). */
function bookmarkText(taskId: string, b: { name: string; changeId: string }): string {
  const prefix = `meddle/task/${taskId}/`;
  const name = b.name.startsWith(prefix) ? b.name.slice(prefix.length) : b.name;
  return b.changeId === "" ? `${name} (conflicted)` : `${name} ${b.changeId.slice(0, 8)}`;
}

function BottomBar({ task, pool, node, nodeId, archived, archivedOn, moving }: {
  task: TaskRef; pool: PoolRef; node: NodeRef; nodeId: string; archived: boolean; archivedOn: string | null; moving: boolean;
}) {
  const manifest = useValue(task.manifest);
  const bookmarks = useValue(task.bookmarks);
  const contextUsage = useValue(task.contextUsage);
  const nodes = useValue(pool.nodes);
  const hostname = useValue(node.hostname);
  const [moveAt, setMoveAt] = useState<Anchor | null>(null);
  const usage = usageShort(contextUsage);
  const projects = manifest.projects;
  const own = bookmarks.find((b) => b.name === `meddle/task/${manifest.id}/${projects[0]?.name ?? ""}`) ?? bookmarks[0];
  return (
    <footer class="bar">
      <span class="bar-item bar-project" title={projects.map((p) => `${p.name} (${p.workspace})`).join("\n") || "no project"}>
        ◉ {projects.length === 0 ? "no project" : projects.length === 1 ? projects[0]!.name : `${projects[0]!.name} +${projects.length - 1}`}
      </span>
      {archived ? (
        <span class="bar-item" title={nodeId}>⌂ archived on {archivedOn ?? hostname}</span>
      ) : (
        <button class="pill" disabled={moving} title={`${nodeId}\nMove to another node`} onClick={(e) => setMoveAt({ el: e.currentTarget, above: true })}>⌂ {hostname} ▾</button>
      )}
      {own !== undefined && (
        <span class={`bar-item${own.changeId === "" ? " flag" : ""}`} title={bookmarks.map((b) => bookmarkText(manifest.id, b)).join("\n")}>
          {bookmarkText(manifest.id, own)}{bookmarks.length > 1 && ` +${bookmarks.length - 1}`}
        </span>
      )}
      {usage !== null && <span class="bar-item" title="The latest turn's tokens, summed over its API calls">{usage}</span>}
      <span class="bar-gap" />
      {!archived && <Settings task={task} node={node} pool={pool} disabled={moving} />}
      {moveAt !== null && <MoveMenu task={task} nodes={nodes} from={nodeId} anchor={moveAt} onClose={() => setMoveAt(null)} />}
    </footer>
  );
}

/** The task's model and effort (the pool's defaults where it chose none). */
function Settings({ task, node, pool, disabled }: { task: TaskRef; node: NodeRef; pool: PoolRef; disabled: boolean }) {
  const models = useValue(node.models);
  const defaults = useValue(pool.defaults);
  const model = useValue(task.model);
  const effort = useValue(task.effort);
  const action = useAction();
  /** The model and the effort just picked, each shown until its change lands (or fails), so the pill does not snap back. */
  const [pickedModel, setPickedModel] = useState<string | null>(null);
  const [pickedEffort, setPickedEffort] = useState<string | null>(null);
  return (
    <>
      {action.error !== null && <span class="error" title={action.error}>!</span>}
      <ModelPicker models={models} model={pickedModel ?? model ?? defaults.model} effort={pickedEffort ?? effort ?? defaults.effort}
        disabled={disabled}
        onModel={(next) => {
          setPickedModel(next);
          void action.run(() => task.setModel({ model: next })).finally(() => setPickedModel(null));
        }}
        onEffort={(next) => {
          setPickedEffort(next);
          void action.run(() => task.setEffort({ effort: next })).finally(() => setPickedEffort(null));
        }} />
    </>
  );
}
