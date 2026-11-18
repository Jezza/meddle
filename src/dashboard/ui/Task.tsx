// One task: its head (title, state, actions), the thread from the session's event log with what waits on you inline,
// its agents, the composer, and the bar beneath (each project with its line, the context and plan usage; the node,
// permission mode, model and effort).
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type { Host, Ref } from "@earendil-works/chord";
import DOMPurify from "dompurify";
import { createContext, type RefObject } from "preact";
import { type Dispatch, type StateUpdater, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Attachment, Prompt } from "../../blobs/attachment";
import { type AgentEntry, type Live as LiveState, NodeObject, SessionObject, TaskObject } from "../../state/contracts";
import { shortId } from "../../pool/ids";
import { errorText, type Hosts, useAction, useDraft, useObject, useTick, useValue } from "./hooks";
import { AgentsPanel } from "./Agents";
import { agentSeconds, rootOf, toolCount } from "./agents-model";
import { draftAttachments, readyToSend } from "./attach-model";
import { AttachButton, AttachmentList, DraftChips, type Drafts, useDrafts, useFileTarget } from "./Attachments";
import { Changes } from "./Changes";
import { changeCount } from "./changes-model";
import { composerKey, withTakenBack } from "./composer-model";
import { type Anchor, copyText, ModelPicker, MoveMenu, PaneHead, Popover, type PoolRef, RenameInput, RestoreMenu, StateDot, Unavailable } from "./common";
import { DiffRows, DiffView } from "./diff";
import { Chevron, Icon, Iconoir } from "./icons";
import { renderMarkdown } from "./markdown";
import { hashOf } from "./routes";
import { ago, type ProjectLine, projectLines } from "./sidebar-model";
import { useOptionalValue } from "./sources";
import { trainOffer } from "./train-model";
import { UsageMeter, useNow } from "./Usage";
import { contextMeter, readAgo, windowMeter } from "./usage-model";
import {
  activity, activityLine, agentEndNote, backgroundMeta, buildThread, callRuns, cwdOf, duration, EDITS, editDiff, exitCode, type Explored,
  exploredLine, foldSteps, holdsCall, isAgentCall, isLook, isRunning, keyOf, missingCalls, type ShownItem, textLines, toolSummary, toolTarget,
  type ToolItem, workspaceSource,
} from "./thread-model";

type NodeRef = Ref<typeof NodeObject>;
type TaskRef = Ref<typeof TaskObject>;
type SessionRef = Ref<typeof SessionObject>;
type Pending = TaskRef["pending"]["value"][number];
type LogEvent = SessionRef["window"]["value"][number];

const EARLIER_PAGE = 200;
/** How far below the top of the thread a row the thread was led to comes, in pixels. */
const ARRIVAL_MARGIN = 8;
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

/** Which of a task's views shows: its thread, or its changes. */
type Tab = "changes" | undefined;

/** A task on any member: through that node's host while it is online. */
export function TaskView({ hosts, pool, nodeId, taskId, tab }: { hosts: Hosts; pool: PoolRef; nodeId: string; taskId: string; tab: Tab }) {
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
  return <TaskOnline host={host} pool={pool} taskId={taskId} tab={tab} />;
}

function TaskOnline({ host, pool, taskId, tab }: { host: Host; pool: PoolRef; taskId: string; tab: Tab }) {
  const node = useObject(host, NodeObject, {});
  const task = useObject(host, TaskObject, { id: taskId });
  const session = useObject(host, SessionObject, { taskId });
  const error = node.error ?? task.error ?? session.error;
  if (error !== undefined) return <><PaneHead><span class="muted">Task</span></PaneHead><p class="pane-note error">{error}</p></>;
  if (node.ref === undefined || task.ref === undefined || session.ref === undefined) {
    return <><PaneHead><span class="muted">Loading task…</span></PaneHead></>;
  }
  return <TaskLoaded node={node.ref} pool={pool} task={task.ref} session={session.ref} tab={tab} />;
}

function TaskLoaded({ node, pool, task, session, tab }: { node: NodeRef; pool: PoolRef; task: TaskRef; session: SessionRef; tab: Tab }) {
  const manifest = useValue(task.manifest);
  const state = useValue(task.state);
  const pending = useValue(task.pending);
  const queued = useValue(task.queuedPrompts);
  const move = useValue(task.move);
  const movedTo = useValue(task.movedTo);
  const archivedOn = useValue(task.archivedOn);
  const acceptance = useValue(task.acceptance);
  const changes = useValue(task.changes);
  const nodeId = useValue(node.nodeId);
  const nodes = useValue(pool.nodes);
  const nameOf = (id: string) => nodes.find((n) => n.nodeId === id)?.hostname ?? shortId(id);
  // A node of an older meddle serves no `agents`: its tasks have none to list.
  const agents = useOptionalValue(task, "agents") ?? NO_AGENTS;
  // Nor a `queue`: such a node cannot queue a task, which `undefined` here says (null is a task not queued).
  const queue = useOptionalValue(task, "queue");
  /** The agent row the agent list (or a `Message` row) last led the thread to. */
  const [focus, setFocus] = useState<Focus | null>(null);

  // A task that moved on is followed to where it went.
  useEffect(() => {
    if (state === "moved" && movedTo !== null) location.replace(hashOf({ name: "task", nodeId: movedTo, id: manifest.id }));
  }, [state, movedTo, manifest.id]);
  useEffect(() => { document.title = `${manifest.title} · meddle`; return () => { document.title = "meddle"; }; }, [manifest.title]);

  const archived = state === "archived";
  const moving = state === "moving" || move !== null;
  const live = state === "running" || state === "waiting";
  // The changes show only for a task with a project, live here: `changes` is [] otherwise.
  const switchable = manifest.projects.length > 0 && changes.length > 0;
  const showChanges = switchable && tab === "changes";
  /** Shows every event in the thread, the ones it otherwise leaves out included. */
  const [raw, setRaw] = useState(false);
  // What the composer holds, its text and its files, here so that a failed prompt's Edit can put them back. Its text is
  // kept by task id, so that it is still there after another task (or a reload), and follows the task when it moves to
  // another node.
  const [draft, setDraft] = useDraft(`task.${manifest.id}`);
  const drafts = useDrafts();
  const box = useRef<HTMLTextAreaElement>(null);
  /** Prompts the task could not be sent: this page's own, so they go with it. */
  const [failed, setFailed] = useState<Failed[]>([]);
  const failedId = useRef(0);
  const dropFailed = (id: number) => setFailed((all) => all.filter((f) => f.id !== id));
  const editFailed = (f: Failed) => {
    dropFailed(f.id);
    if (f.text !== "") setDraft((d) => (d.trim() === "" ? f.text : `${d}\n\n${f.text}`));
    drafts.restore(f.attachments);
    box.current?.focus();
  };
  return (
    <div class="task">
      <TaskHead task={task} nodes={nodes} nodeId={nodeId} title={manifest.title} state={state} pendingCount={pending.length} moving={moving}
        partly={acceptance === "partly" && !archived && state !== "moved"} queue={queue} merge={manifest.merge !== undefined}
        raw={raw} onRaw={() => setRaw(!raw)}
        changes={switchable ? { count: changeCount(changes), on: showChanges } : null} />
      {move !== null && <MoveBanner task={task} move={move} to={nameOf(move.to)} />}
      {showChanges ? <Changes task={task} /> : state === "moved" ? (
        <p class="pane-note">Moved to {movedTo === null ? "another node" : <a href={hashOf({ name: "task", nodeId: movedTo, id: manifest.id })}>{nameOf(movedTo)}</a>}.</p>
      ) : (
        <Thread task={task} session={session} readOnly={archived} working={state === "running"} turnLive={live || state === "moving"} raw={raw}
          agents={agents} focus={focus} setFocus={setFocus} after={<>
          {pending.map((p) => <PendingPanel key={p.requestId} task={task} pending={p} />)}
          {queued.map((prompt, i) => <Queued key={i} prompt={prompt} />)}
          {!archived && failed.map((f) => (
            <FailedMessage key={f.id} task={task} failed={f} disabled={moving} onSent={() => dropFailed(f.id)} onEdit={() => editFailed(f)} />
          ))}
        </>} />
      )}
      {/* The thread holds what waits on you; beside the changes, it waits beneath them. */}
      {showChanges && pending.length > 0 && (
        <div class="pending-strip">{pending.map((p) => <PendingPanel key={p.requestId} task={task} pending={p} />)}</div>
      )}
      {/* Above the composer, or where it would be on an archived task. */}
      {state !== "moved" && !showChanges && (
        <AgentsPanel agents={agents} selected={focus?.toolUseId || null} onPick={(agent) => setFocus(aim(agent.toolUseId, agents))} />
      )}
      {!archived && state !== "moved" && !showChanges && (
        <Composer task={task} running={live} anyQueued={queued.length > 0} disabled={moving} text={draft} setText={setDraft} drafts={drafts} box={box}
          onFailed={(prompt, error) => setFailed((all) => [...all, { id: ++failedId.current, ...prompt, error }])} />
      )}
      <BottomBar task={task} pool={pool} node={node} nodeId={nodeId} archived={archived} archivedOn={archivedOn === null ? null : nameOf(archivedOn)} moving={moving} />
    </div>
  );
}

// ─── the head ───

function TaskHead({ task, nodes, nodeId, title, state, pendingCount, moving, partly, queue, merge, raw, onRaw, changes }: {
  task: TaskRef; nodes: PoolRef["nodes"]["value"]; nodeId: string; title: string; state: string; pendingCount: number; moving: boolean;
  /** A pushed branch contains the task's line for some of its projects, not all: nothing is archived yet. */
  partly: boolean;
  /** Where the task is queued on its project's train; null when it is not, undefined from a node that has no queue. */
  queue: { queuedAt: string; project: string } | null | undefined;
  /** A merge task of the train: it lands with its batch, and is never accepted. */
  merge: boolean;
  raw: boolean; onRaw: () => void;
  /** The `Thread` / `Changes n` switch: the non-empty changes (no number for none), and whether they show; null hides it. */
  changes: { count: number; on: boolean } | null;
}) {
  const [renaming, setRenaming] = useState(false);
  const [restoreAt, setRestoreAt] = useState<Anchor | null>(null);
  const action = useAction();
  const archived = state === "archived";
  const live = state === "running" || state === "waiting";
  const stateText = pendingCount > 0 ? "waiting on you" : state;
  const offer = trainOffer({ state, queued: queue === undefined ? null : queue !== null, merge, moving });
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
        {queue != null && (
          <a class="muted state-text" href={hashOf({ name: "train", projectId: queue.project, task: task.manifest.value.id })}
            title="Accepted, and waiting on its project's train: open the train">
            · 🚂 queued
          </a>
        )}
      </div>
      <div class="head-actions">
        {action.error !== null && <span class="error" title={action.error}>{action.error}</span>}
        {changes !== null && (
          <nav class="task-tabs" aria-label="Task view">
            <a class={changes.on ? "" : "on"} aria-current={changes.on ? undefined : "page"}
              href={hashOf({ name: "task", nodeId, id: task.manifest.value.id })}>Thread</a>
            <a class={changes.on ? "on" : ""} aria-current={changes.on ? "page" : undefined}
              href={hashOf({ name: "task", nodeId, id: task.manifest.value.id, tab: "changes" })}>Changes{changes.count > 0 && ` ${changes.count}`}</a>
          </nav>
        )}
        {!changes?.on && <button class={raw ? "on" : ""} aria-pressed={raw} title="Show every event, those the thread does not know included" onClick={onRaw}>Raw</button>}
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
        {/* Unlike Archive, Accept also shows while a turn runs: a running task waits in the queue until its turn ends. */}
        {offer === "accept" && (
          <button class="accept" disabled={action.busy} title="Queues the task's work to land on its project's default branch (the merge train)"
            onClick={() => action.run(() => task.accept({}))}>🚂 Accept</button>
        )}
        {offer === "unqueue" && (
          <button disabled={action.busy} title="Takes the task off the train" onClick={() => action.run(() => task.unqueue({}))}>Unqueue</button>
        )}
        {archived && <>
          <button disabled={action.busy} onClick={(e) => setRestoreAt({ el: e.currentTarget })}>Restore ▾</button>
          <button disabled={action.busy} onClick={remove}>Delete</button>
        </>}
      </div>
      {restoreAt !== null && (
        <RestoreMenu task={task} nodes={nodes} holder={nodeId} anchor={restoreAt} onClose={() => setRestoreAt(null)} />
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

/**
 * An agent row the thread is led to: the call that first started the agent (`toolUseId`); and the start (`seq`) and
 * call (`holder`) of the outermost agent whose row holds it (`rootOf`), which the thread loads back to, then on until
 * that call is in. `n` counts the picks, so picking the same agent again leads there again.
 */
type Focus = { toolUseId: string; seq: number; holder: string; n: number };

/**
 * Leads the thread to `toolUseId`'s row. An agent the list has no entry for (an older node) has no start to aim at:
 * the thread loads only until its call is in.
 */
const aim = (toolUseId: string, agents: readonly AgentEntry[]) => (prev: Focus | null): Focus => {
  const agent = agents.find((a) => a.toolUseId === toolUseId);
  const root = agent === undefined ? undefined : rootOf(agent, agents);
  return { toolUseId, seq: root?.seq ?? Infinity, holder: root?.toolUseId || toolUseId, n: (prev?.n ?? 0) + 1 };
};

const NO_AGENTS: readonly AgentEntry[] = [];

function Thread({ task, session, readOnly, working, turnLive, raw, agents, focus, setFocus, after }: {
  task: TaskRef; session: SessionRef; readOnly: boolean; working: boolean;
  /**
   * Whether the task's turn is live (`running`, `waiting`, or `moving` while its move waits for the turn): without it,
   * no Claude Code process is left to run the session's own calls, so none of them runs on.
   */
  turnLive: boolean;
  raw: boolean;
  agents: readonly AgentEntry[]; focus: Focus | null; setFocus: Dispatch<StateUpdater<Focus | null>>;
  after: preact.ComponentChildren;
}) {
  const window = useValue(session.window);
  const live = useValue(session.live);
  const agentsRunning = useOptionalValue(task, "agentsRunning") ?? 0;
  /** Every event seen since the view opened: the window slides past events, and "load earlier" adds older ones. */
  const [seen, setSeen] = useState<Map<number, LogEvent>>(() => new Map());
  const [noneEarlier, setNoneEarlier] = useState(false);
  const action = useAction();
  useEffect(() => setSeen((prev) => merged(prev, window)), [window]);

  const events = useMemo(() => [...merged(seen, window).values()].sort((a, b) => a.seq - b.seq), [seen, window]);
  const items = useMemo(() => buildThread(events), [events]);
  const blocks = useMemo(() => blocksOf(foldSteps(items, raw)), [items, raw]);
  const byCall = useMemo(() => new Map(agents.map((a) => [a.toolUseId, a])), [agents]);
  // A read-only thread has no task to open a large file's diff from: its workspace is gone, and the read refused.
  const view = useMemo((): ThreadContext => ({
    cwd: cwdOf(events), raw, task: readOnly ? null : task, agents: byCall, focused: focus?.toolUseId || null,
    focus: (toolUseId) => setFocus(toolUseId === null ? null : aim(toolUseId, agents)),
  }), [events, raw, task, readOnly, byCall, agents, focus, setFocus]);
  const oldest = events[0]?.seq;

  // Kept at the bottom while you are there; left alone while you read further up.
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el !== null && stick.current) el.scrollTop = el.scrollHeight;
  });

  // Earlier events load in one loop at a time, page by page, for as long as any of three reasons stands and earlier
  // events remain:
  // - "Load earlier" asks for one page;
  // - the loaded events refer to a call that is not in (`missingCalls`), so what an agent ran would land in the main
  //   thread;
  // - a pick (`focus`) leads to an agent's row: back to the outermost holding agent's start, then on until its call
  //   (which comes before the start) is in. The row opens as soon as they are, while the loop may go on for the rest.
  // A pick or new events while it loads lead the same loop on (it reads both afresh at each page). Each page goes
  // further back, so the loop ends. The pick standing when the view opened is not followed again. Loading above keeps
  // the view at the bottom while you are there (`stick`).
  const latest = useRef(events);
  latest.current = events;
  const target = useRef(focus);
  target.current = focus;
  const followed = useRef(focus);
  const loading = useRef(false);
  const [arrived, setArrived] = useState<Focus | null>(null);
  const missing = useMemo(() => missingCalls(events).length > 0, [events]);
  /** The pick the thread has yet to lead to; null for none. */
  const picked = () => {
    const pick = target.current;
    return pick !== followed.current && pick !== null && pick.toolUseId !== "" ? pick : null;
  };
  const arrive = (pick: Focus) => {
    followed.current = pick;
    setArrived(pick);
  };
  const load = (onePage: boolean) => {
    const start = noneEarlier || oldest === undefined || oldest <= 1 ? undefined : oldest;
    if (loading.current || (!onePage && picked() === null && (start === undefined || !missing))) return;
    loading.current = true;
    void action.run(async () => {
      try {
        let pages: readonly LogEvent[] = [];
        const loaded = () => [...pages, ...latest.current];
        for (let from = start, asked = onePage; ; asked = false) {
          const pick = picked();
          const short = pick !== null && from !== undefined && (from > pick.seq || !holdsCall(loaded(), pick.holder));
          if (pick !== null && !short) arrive(pick);
          if (from === undefined || !(asked || short || missingCalls(loaded()).length > 0)) break;
          const earlier = await session.loadEarlier({ beforeSeq: from, limit: EARLIER_PAGE });
          const next = earlier[0]?.seq;
          // A page that does not reach further back (never one from a node that keeps to `loadEarlier`) ends it too.
          const last = earlier.length < EARLIER_PAGE || next === undefined || next >= from;
          if (last) setNoneEarlier(true);
          // The page you asked for shows where it lands, rather than the view staying at the bottom.
          if (asked) stick.current = false;
          setSeen((prev) => merged(prev, earlier));
          pages = [...earlier, ...pages];
          from = last || next <= 1 ? undefined : next;
        }
      } finally {
        loading.current = false;
        // A load that failed leaves its pick where it got to.
        const pick = picked();
        if (pick !== null) arrive(pick);
      }
    });
  };
  useEffect(() => load(false), [focus, events]);
  // Once the events are in: the row opens, and every row holding it (a parent agent's), and comes to the top of the
  // thread. Only the thread scrolls, never the page around it.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el === null || arrived === null || arrived.toolUseId === "") return;
    const row = el.querySelector<HTMLDetailsElement>(`details[data-call="${CSS.escape(arrived.toolUseId)}"]`);
    if (row === null) return;
    for (let d: HTMLDetailsElement | null = row; d !== null; d = d.parentElement?.closest("details") ?? null) d.open = true;
    stick.current = false;
    el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top - ARRIVAL_MARGIN;
  }, [arrived]);

  const lastClaude = blocks.at(-1)?.who === "claude";
  // Kept for the whole running turn, not only while text streams, so it does not blink out between steps.
  const tail = live !== null || working;
  const doing = activity(live, items, agentsRunning);
  /** Changes whenever anything streams or lands, so the activity line can tell a quiet turn from a busy one. */
  const pulse = `${events.at(-1)?.seq ?? 0}:${live?.text.length ?? -1}:${live?.thinking.length ?? -1}:${live?.block ?? ""}`;
  return (
    <ThreadView.Provider value={view}>
    <div class="thread-scroll" ref={scroller}
      onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
      <div class="thread">
        {oldest !== undefined && oldest > 1 && !noneEarlier && (
          <button class="earlier" disabled={action.busy} onClick={() => load(true)}>Load earlier</button>
        )}
        {action.error !== null && <p class="error">{action.error}</p>}
        {blocks.length === 0 && !tail && <p class="muted empty">{readOnly ? "Nothing in this task's log." : "Nothing yet: send a prompt below."}</p>}
        <AgentRuns.Provider value={turnLive}>
          {blocks.map((b, i) => (
            <BlockView key={b.items.map(keyOf).find((k) => k !== undefined) ?? i} block={b}>
              {i === blocks.length - 1 && lastClaude && tail && <Live live={live} doing={doing} pulse={pulse} />}
            </BlockView>
          ))}
        </AgentRuns.Provider>
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

/** A block: your message in a card (meddle's, the train's, marked so), Claude's items, status lines on their own. */
function BlockView({ block, children }: { block: Block; children?: preact.ComponentChildren }) {
  const items = <Items items={block.items} />;
  if (block.who === "status") return <div class="status-block">{items}{children}</div>;
  if (block.who === "user") {
    const meddle = block.items[0]?.kind === "user" && block.items[0].by === "meddle";
    return <div class={meddle ? "msg you meddle" : "msg you"}>{items}</div>;
  }
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

/** When `key` last changed (or the component mounted). */
function useSince(key: string): number {
  const last = useRef<{ key: string; at: number } | null>(null);
  if (last.current === null || last.current.key !== key) last.current = { key, at: Date.now() };
  return last.current.at;
}

export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(renderMarkdown(text)), [text]);
  return <div class="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

/**
 * What every row in the thread reads: the session's working directory (paths show relative to it), the Raw toggle,
 * the task, whose workspace a large file's diff opens from, and its agents, which an Agent row's state and numbers
 * come from.
 */
type ThreadContext = {
  cwd: string; raw: boolean; task: TaskRef | null;
  /** The task's agents by the call that first started each (`AgentEntry.toolUseId`). */
  agents: ReadonlyMap<string, AgentEntry>;
  /** The call whose row the thread was last led to, highlighted; null for none. */
  focused: string | null;
  /** Leads the thread to the row of an agent's call (as picking it in the agent list does); null lets go of it. */
  focus(toolUseId: string | null): void;
};
const ThreadView = createContext<ThreadContext>({ cwd: "", raw: false, task: null, agents: new Map(), focused: null, focus: () => {} });

/**
 * Whether what holds a row still runs: the agent whose row holds it, or at the top the task's turn (`Thread`'s
 * `turnLive`). Nothing in an agent that has finished, or in a turn whose process is gone, runs on, whether or not its
 * notice came.
 */
const AgentRuns = createContext(true);

function ShownView({ item }: { item: ShownItem }) {
  switch (item.kind) {
    case "user":
      if (item.by !== "meddle") return <PromptBody text={item.text} attachments={item.attachments} />;
      // The merge train's prompt: meddle sent it, not you.
      return <><div class="by" title="The merge train asked this">meddle</div><PromptBody text={item.text} attachments={item.attachments} /></>;
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
      if (/^Turn (finished|ended)/.test(item.text)) return <TurnEnd text={item.text} at={item.at} />;
      return <div class={`status${/^(Turn failed|Turn aborted|Token |No usable token|Rate limit rejected)/.test(item.text) ? " bad" : ""}`}>{item.text}</div>;
  }
}

/** The line a turn ends with: how it ended, and how long ago (the time itself on hover). */
function TurnEnd({ text, at }: { text: string; at: string | undefined }) {
  useTick(10_000);
  const when = at === undefined ? NaN : Date.parse(at);
  return (
    <div class={`turn-end${text.startsWith("Turn ended") ? " bad" : ""}`} title={Number.isNaN(when) ? undefined : new Date(when).toLocaleString()}>
      <i /><span>{text}{!Number.isNaN(when) && ` · ${ago(Date.now() - when)} ago`}</span><i />
    </div>
  );
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

/** A row's state, for screen readers: its icon says it only by shape. */
function StateText({ running, failed }: { running: boolean; failed: boolean }) {
  return running ? <span class="sr">running</span> : failed ? <span class="sr">failed</span> : null;
}

/** Calls that only look, folded: what they looked at in one row, each call inside; open by itself once one fails. */
function ExploredRow({ steps }: { steps: Explored["steps"] }) {
  const agentRuns = useContext(AgentRuns);
  const line = exploredLine(steps);
  const running = line.running && agentRuns;
  return (
    <details class={`step${line.failed > 0 ? " bad" : running ? " live" : ""}`} open={line.failed > 0}>
      <summary>
        <Chevron /><Icon name={running ? "running" : "search"} />
        <span class="verb">{running ? "Exploring" : "Explored"}</span>
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
 * most `SMALL_DIFF` lines. A `SendMessage` that resumed an agent is a `Message` row leading to the agent's own.
 */
function ToolRow({ tool }: { tool: ToolItem }) {
  return tool.resumes !== undefined ? <MessageRow tool={tool} resumes={tool.resumes} /> : <CallRow tool={tool} />;
}

/**
 * A call's row. A background call runs until its notice; an agent's, while the agent list says it does (by its
 * notices where the list has no entry for it, as on an older node), and it ends with the agent's report, its steps
 * folded beneath; a stopped or failed agent's row is red and open. A call in an agent that has finished, or at the top
 * once the task's turn is not live, runs no longer (a background one's meta says "stopped"), unless the list says it
 * is an agent still running (`callRuns`).
 */
function CallRow({ tool }: { tool: ToolItem }) {
  const { cwd, raw, task, agents, focused, focus } = useContext(ThreadView);
  const agentRuns = useContext(AgentRuns);
  const input = (tool.input ?? {}) as Record<string, unknown>;
  const edit = EDITS.includes(tool.name);
  const agent = isAgentCall(tool);
  const entry = agent ? agents.get(tool.toolUseId) : undefined;
  // How an agent stands: as the agent list says, else as its latest notice did.
  const agentState = entry?.state ?? (agent ? tool.ended?.status : undefined);
  const stopped = agentState === "stopped" || agentState === "failed";
  const running = callRuns(entry?.state, isRunning(tool), agentRuns);
  const failed = stopped || (entry === undefined && tool.result?.isError === true);
  const diff = useMemo(() => edit ? editDiff(tool) : null, [edit, tool.input, tool.result]);
  const children = useMemo(() => foldSteps(tool.children, raw), [tool.children, raw]);

  const kind = edit ? (tool.name === "Write" ? "write" : "edit") : tool.name === "Bash" ? "bash" : agent ? "agent" : isLook(tool) ? "search" : "tool";
  const target = toolTarget(tool, cwd);
  const code = exitCode(tool);
  const background = agent ? null : backgroundMeta(tool, agentRuns);
  const command = typeof input.command === "string" ? input.command : undefined;
  const result = tool.result;
  const reports = tool.reports ?? [];
  // An agent's result is its report only from an older Claude Code, in the foreground: a background one's is its launch receipt.
  const showResult = result !== undefined && result.text !== "" && !(edit && !failed) && !(agent && (reports.length > 0 || tool.background === true));
  // Counts only for a change that landed: a running edit's input overstates it, a failed one's never applied.
  const landed = diff !== null && result !== undefined && !failed;
  const model = agent && typeof input.model === "string" ? input.model : undefined;
  // A file too large for the log to carry opens from the task's workspace as it is now, the diff's new side.
  const source = workspaceSource(tool);
  const fromWorkspace = source === null || task === null ? {} : {
    side: "new" as const,
    load: () => task.workspaceFile({ path: source.path }).then((text) => text === null ? null : textLines(text)),
  };
  const isFocused = focused === tool.toolUseId;
  // Closing the row the agent list led to lets go of it there too.
  const onToggle = isFocused ? (e: { currentTarget: HTMLDetailsElement }) => { if (!e.currentTarget.open) focus(null); } : undefined;
  const body = (
    <div class="step-body">
      {stopped && <p class="tool-note error">{agentEndNote(agentState === "failed", entry?.orphaned === true, tool.ended?.text)}</p>}
      {typeof input.description === "string" && !agent && <p class="tool-note muted">{input.description}</p>}
      {diff !== null && (diff.hunks.length > 0
        ? <DiffView hunks={diff.hunks} file={result?.original ?? null} {...fromWorkspace} />
        : diff.fallback.length > 0 && <div class="diff"><div class="diff-body"><DiffRows rows={diff.fallback} /></div></div>)}
      {command !== undefined && (command.includes("\n") || command !== target) && <pre class="out">{command}</pre>}
      {diff === null && command === undefined && !agent && <pre class="out">{json(tool.input)}</pre>}
      {/* A done agent's newest report is its result, its steps folded beneath; a running one's steps show as they come. */}
      {reports.length > 0 && <Reports reports={reports} done={!running} />}
      {reports.length > 0 && !running ? (
        children.length > 0 && <Steps tools={entry?.tools ?? tool.children.filter((c) => c.kind === "tool").length} items={children} />
      ) : (children.length > 0 || tool.agentId !== undefined) && (
        <div class="sub">
          {tool.agentId !== undefined && <p class="muted tool-note">agent {tool.agentId}</p>}
          <Items items={children} />
        </div>
      )}
      {showResult && <pre class={failed ? "out error" : "out"}>{result.text}</pre>}
      {tool.skill !== undefined && <pre class="out">{tool.skill}</pre>}
    </div>
  );
  return (
    <details class={`step${agent ? " agent" : ""}${failed ? " bad" : running ? " live" : ""}${isFocused ? " focus" : ""}`} data-call={tool.toolUseId}
      open={failed || (landed && diff.added + diff.removed <= SMALL_DIFF)} onToggle={onToggle}>
      <summary title={typeof input.file_path === "string" ? input.file_path : command}>
        <Chevron /><Icon name={running ? "running" : failed ? "failed" : kind} /><StateText running={running} failed={failed} />
        <span class="verb">{tool.name}</span>
        <span class={agent ? "target plain" : "target"}>{target}</span>
        {landed && (diff.added > 0 || diff.removed > 0) && (
          <span class="meta"><span class="add">+{diff.added}</span> <span class="del">−{diff.removed}</span></span>
        )}
        {code !== undefined && <span class="meta">exit {code}</span>}
        {background !== null && <span class="meta">{background}</span>}
        {entry !== undefined ? <AgentMeta entry={entry} model={model} /> : model !== undefined && <span class="meta">{model}</span>}
        {entry?.state === "running" && (
          <span class="now"><span class="dots" aria-hidden="true"><i /><i /><i /></span><span class="what">{entry.doing ?? "Working"}</span></span>
        )}
      </summary>
      {agent ? <AgentRuns.Provider value={running}>{body}</AgentRuns.Provider> : body}
    </details>
  );
}

/** An agent row's meta from the agent list: its model, how many tools it used and for how long, ticking while it runs. */
function AgentMeta({ entry, model }: { entry: AgentEntry; model: string | undefined }) {
  useTick(entry.state === "running" ? 1000 : null);
  const parts = [model, toolCount(entry.tools), duration(agentSeconds(entry, Date.now()))];
  return <span class="meta">{parts.filter((p) => p !== undefined).join(" · ")}</span>;
}

/**
 * An agent's reports. Once it is `done`, the newest leads in a card as its result, the earlier ones (before a
 * follow-up) behind a toggle; while it runs on a follow-up, every report so far is an earlier one.
 */
function Reports({ reports, done }: { reports: readonly string[]; done: boolean }) {
  const [earlier, setEarlier] = useState(false);
  const n = reports.length;
  const behind = done ? n - 1 : n;
  const shown = earlier ? [...reports.keys()].reverse() : done ? [n - 1] : [];
  const toggle = behind > 0 && (
    <button onClick={() => setEarlier(!earlier)}>{earlier ? "hide earlier" : behind > 1 ? "earlier reports" : "earlier report"}</button>
  );
  // The toggle heads the first card shown, or stands alone while none is.
  if (shown.length === 0) return <div class="report-head">{toggle}</div>;
  return (
    <>
      {shown.map((i, at) => (
        <div key={i} class="report">
          <div class="report-head">
            <span>Report</span>
            {n > 1 && <span>{i + 1} of {n}</span>}
            {at === 0 && toggle}
          </div>
          <Markdown text={reports[i]!} />
        </div>
      ))}
    </>
  );
}

/** An agent's steps beneath its report, folded into one closed row saying how many tools it used. */
function Steps({ tools, items }: { tools: number; items: readonly ShownItem[] }) {
  return (
    <details class="step">
      <summary><Chevron /><Icon name="search" /><span class="verb">Steps</span><span class="target plain muted">{toolCount(tools)}</span></summary>
      <div class="sub"><Items items={items} /></div>
    </details>
  );
}

/**
 * A `SendMessage` that resumed an agent: one line, "Message to <the agent>" and the message's summary, spinning while
 * the run it started is running. It does not open: it leads to the agent's row, where that run shows.
 */
function MessageRow({ tool, resumes }: { tool: ToolItem; resumes: string }) {
  const { agents, focus } = useContext(ThreadView);
  const agentRuns = useContext(AgentRuns);
  const entry = agents.get(resumes);
  const input = (tool.input ?? {}) as Record<string, unknown>;
  // Its run is over once the agent is, notice or not; with no entry for it, once what holds this row is (`callRuns`).
  const own = isRunning(tool);
  const running = own && callRuns(entry?.state, own, agentRuns);
  const to = entry?.description ?? (typeof input.to === "string" ? input.to : "");
  const summary = typeof input.summary === "string" ? input.summary : "";
  return (
    <details class={`step${running ? " live" : ""}`} data-call={tool.toolUseId}>
      <summary title={typeof input.message === "string" ? input.message : undefined} onClick={(e) => { e.preventDefault(); focus(resumes); }}>
        <Chevron /><Icon name={running ? "running" : "agent"} /><StateText running={running} failed={false} />
        <span class="verb">Message</span>
        <span class="target plain">to {to}{summary !== "" && <span class="muted"> · {summary}</span>}</span>
      </summary>
    </details>
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

/** Your message's files, then its text (none when it is blank). */
function PromptBody({ text, attachments }: { text: string; attachments: Attachment[] }) {
  return (
    <>
      <AttachmentList attachments={attachments} />
      {(text.trim() !== "" || attachments.length === 0) && <div class="user-text">{text}</div>}
    </>
  );
}

/** A prompt the task was sent and has not started on: it joins the thread where Claude takes it. */
function Queued({ prompt }: { prompt: Prompt }) {
  return (
    <div class="msg you queued" title="Claude takes it at its next step, or once it is done with the current one; Ctrl+Enter in an empty box sends it now; ↑ or Esc in the box takes it back to edit">
      <PromptBody text={prompt.text} attachments={prompt.attachments} />
      <span class="chip">queued</span>
    </div>
  );
}

type Failed = { id: number; text: string; attachments: Attachment[]; error: string };

/** A prompt the task could not be sent: it stays in the thread, marked, to send again or take back into the composer. */
function FailedMessage({ task, failed, disabled, onSent, onEdit }: {
  task: TaskRef; failed: Failed; disabled: boolean; onSent(): void; onEdit(): void;
}) {
  const action = useAction();
  const retry = async () => {
    if (await action.run(() => task.prompt({ text: failed.text, attachments: failed.attachments }))) onSent();
  };
  return (
    <div class="msg you failed">
      <PromptBody text={failed.text} attachments={failed.attachments} />
      <div class="failed-line error">
        <Iconoir name="warning" /><span>Not sent: {action.error ?? failed.error}</span>
        <span class="failed-acts">
          <button disabled={disabled || action.busy} onClick={retry}>{action.busy ? "Retrying…" : "Retry"}</button>
          <button disabled={action.busy} onClick={onEdit} title="Put it back in the box">Edit</button>
        </span>
      </div>
    </div>
  );
}

function Composer({ task, running, anyQueued, disabled, text, setText, drafts, box, onFailed }: {
  task: TaskRef; running: boolean;
  /** The task has prompts it has not started on: Ctrl+Enter in an empty box sends them now, ↑ or Esc takes them back. */
  anyQueued: boolean;
  disabled: boolean;
  text: string; setText: Dispatch<StateUpdater<string>>; drafts: Drafts; box: RefObject<HTMLTextAreaElement | null>;
  onFailed(prompt: Prompt, error: string): void;
}) {
  const [busy, setBusy] = useState(false);
  const [nowError, setNowError] = useState<string | null>(null);
  const [takingBack, setTakingBack] = useState(false);
  const [takeBackError, setTakeBackError] = useState<string | null>(null);
  /** Where the caret goes once the box shows what was taken back. */
  const caretAfter = useRef<number | null>(null);
  // A phone's keyboard has no Shift for a new line: there Enter makes one, and the button sends.
  const touch = matchMedia("(pointer: coarse)").matches;
  const files = useFileTarget(drafts.add, !disabled);
  // Grows with what is typed, up to the stylesheet's max-height, instead of a drag handle. Measuring drops the box to
  // its natural height for a moment, so the field holds its height meanwhile: otherwise the thread above grows for that
  // moment and, scrolled to the bottom, Firefox clamps its scroll and the thread lands a couple of pixels lower.
  useLayoutEffect(() => {
    const el = box.current;
    const field = el?.parentElement;
    if (el == null || field == null) return;
    field.style.minHeight = `${field.offsetHeight}px`;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
    field.style.minHeight = "";
  }, [text]);
  // Sent or not, the prompt leaves the box: a failed one goes into the thread (FailedMessage). What was typed or
  // attached meanwhile stays. `now` then sends what the running turn has not taken now, the prompt last, as Claude Code
  // does; with an empty box (no text, no files), just what is queued.
  const send = async (now: boolean) => {
    const sent = text;
    const sentFiles = drafts.drafts;
    const empty = sent.trim() === "" && sentFiles.length === 0;
    if (disabled || busy || (empty ? !(now && anyQueued) : !readyToSend(sent, sentFiles))) return;
    const prompt = { text: sent, attachments: draftAttachments(sentFiles) };
    setBusy(true);
    setNowError(null);
    try {
      if (!empty) {
        const prompted = await task.prompt(prompt).then(() => true, (err: unknown) => { onFailed(prompt, errorText(err)); return false; });
        setText((t) => (t === sent ? "" : t));
        for (const d of sentFiles) drafts.remove(d.id);
        if (!prompted) return;
      }
      if (now) await task.sendNow({}).catch((err: unknown) => setNowError(errorText(err)));
    } finally {
      setBusy(false);
    }
  };
  // Takes back what the task has not started on into the box, as Claude Code does: the texts above what is there, the
  // files beside its own. Only what the node says it withdrew comes back (a prompt Claude took meanwhile stays sent).
  const takeBack = async () => {
    if (disabled || takingBack) return;
    setTakingBack(true);
    setTakeBackError(null);
    try {
      const { prompts } = await task.takeBackQueued({});
      const texts = prompts.map((p) => p.text).filter((t) => t !== "");
      if (texts.length > 0) {
        const caret = box.current?.selectionStart ?? 0;
        setText((t) => {
          const merged = withTakenBack(texts, t, Math.min(caret, t.length));
          caretAfter.current = merged.caret;
          return merged.text;
        });
      }
      drafts.restore(prompts.flatMap((p) => p.attachments));
    } catch (err) {
      setTakeBackError(errorText(err));
    } finally {
      setTakingBack(false);
    }
  };
  useLayoutEffect(() => {
    const el = box.current;
    if (el == null || caretAfter.current === null) return;
    el.focus();
    el.setSelectionRange(caretAfter.current, caretAfter.current);
    caretAfter.current = null;
  }, [text]);
  // The button takes the accent only once there is something to send, every file uploaded.
  const ready = !disabled && readyToSend(text, drafts.drafts);
  const verb = running ? "Queue" : "Send";
  const keys = touch ? "" : running ? " (Enter; Ctrl+Enter sends now)" : " (Enter)";
  return (
    <div class={files.dragging ? "composer drop" : "composer"} {...files.handlers}>
      <DraftChips drafts={drafts.drafts} onRemove={drafts.remove} />
      <div class="composer-field">
        <textarea
          ref={box}
          rows={1}
          disabled={disabled}
          value={text}
          placeholder={disabled ? "Moving: prompts wait until it lands" : anyQueued && !touch ? "↑ to edit queued messages" : running ? `Message Claude: it takes it at its next step${touch ? "" : " · Ctrl+Enter sends now"}…` : "Reply…"}
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            const field = e.currentTarget;
            const action = composerKey(e, { running, touch, anyQueued, value: field.value, caret: field.selectionStart });
            if (action === null) return;
            e.preventDefault();
            if (action === "take-back") void takeBack();
            else void send(action === "send-now");
          }}
        />
        <AttachButton onFiles={drafts.add} disabled={disabled} />
        <button class={ready ? "send ready" : "send"} disabled={!ready || busy} onClick={() => send(false)} title={`${verb}${keys}`} aria-label={verb}>
          <Iconoir name="send" />
        </button>
      </div>
      {takingBack && <div class="composer-row">Taking your messages back…</div>}
      {takeBackError !== null && <div class="composer-row error">Not taken back: {takeBackError}</div>}
      {nowError !== null && <div class="composer-row error">Not sent now: {nowError}</div>}
    </div>
  );
}

/** A task bookmark as the bar shows it: its name after `meddle/task/<id>/`, then its change (or "conflicted"). */
/**
 * The bar beneath the composer: each project with its line, the task's context and the plan usage of the login its
 * node's next turn uses; the node, model and effort.
 */
function BottomBar({ task, pool, node, nodeId, archived, archivedOn, moving }: {
  task: TaskRef; pool: PoolRef; node: NodeRef; nodeId: string; archived: boolean; archivedOn: string | null; moving: boolean;
}) {
  const manifest = useValue(task.manifest);
  const bookmarks = useValue(task.bookmarks);
  const contextUsage = useValue(task.contextUsage);
  const context = useValue(task.context);
  const active = useValue(node.activeUsage);
  const now = useNow();
  const nodes = useValue(pool.nodes);
  const hostname = useValue(node.hostname);
  const [moveAt, setMoveAt] = useState<Anchor | null>(null);
  const [projectsAt, setProjectsAt] = useState<Anchor | null>(null);
  const ctx = contextMeter(context, contextUsage);
  const reading = active?.reading ?? null;
  const limits = reading === null ? [] : [windowMeter("5h", reading.fiveHour, reading.readAt, now), windowMeter("7d", reading.sevenDay, reading.readAt, now)]
    .filter((m) => m !== null)
    .map((m) => ({ ...m, title: `${m.title}\ntoken "${active!.label}" · ${readAgo(reading.readAt, now)}` }));
  const lines = projectLines(manifest.id, manifest.projects, bookmarks);
  return (
    <footer class="bar">
      {lines.length === 0 ? <span class="bar-item">◉ no project</span> : <>
        {/* Inline up to two projects; more, or a phone, collapse to the pill and its list. */}
        {lines.length <= 2 && (
          <span class="bar-projects">
            {lines.map((l) => (
              <span key={l.name} class="bar-entry" title={`${l.name} (${l.workspace})`}>
                <span class="bar-name">◉ {l.name}</span>
                <Revision line={l} />
              </span>
            ))}
          </span>
        )}
        <button class="pill bar-collapsed" title={lines.map((l) => `${l.name} (${l.workspace})`).join("\n")}
          onClick={(e) => setProjectsAt({ el: e.currentTarget, above: true })}>
          ◉ <span class="bar-name">{lines[0]!.name}</span>{lines.length > 1 && <span class="muted"> +{lines.length - 1}</span>} ▾
        </button>
      </>}
      <span class="bar-sep" />
      {ctx !== null && <UsageMeter meter={ctx} />}
      {limits.length > 0
        ? limits.map((m) => <UsageMeter key={m.label} meter={m} class="bar-item" />)
        : <span class="bar-item" title="No turn on this node has read the plan usage of the login it uses next">5h / 7d: no data</span>}
      <span class="bar-gap" />
      {archived ? (
        <span class="bar-item" title={nodeId}>⌂ archived on {archivedOn ?? hostname}</span>
      ) : (
        <button class="pill" disabled={moving} title={`${nodeId}\nMove to another node`} onClick={(e) => setMoveAt({ el: e.currentTarget, above: true })}>⌂ {hostname} ▾</button>
      )}
      {!archived && <Settings task={task} node={node} pool={pool} disabled={moving} />}
      {moveAt !== null && <MoveMenu task={task} nodes={nodes} from={nodeId} anchor={moveAt} onClose={() => setMoveAt(null)} />}
      {projectsAt !== null && (
        <Popover anchor={projectsAt} onClose={() => setProjectsAt(null)} wide>
          <div class="menu-head">Projects</div>
          {lines.map((l) => (
            <div key={l.name} class="menu-row" title={l.workspace}>
              <span class="menu-label">{l.name}</span>
              <Revision line={l} />
            </div>
          ))}
        </Popover>
      )}
    </footer>
  );
}

/** A project's line: its change id, which copies the whole id when clicked; `conflicted`; or nothing before it has one. */
function Revision({ line }: { line: ProjectLine }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  if (line.conflicted) return <span class="rev flag" title="Its bookmark points at several changes">conflicted</span>;
  if (line.changeId === null) return null;
  const id = line.changeId;
  return (
    <button class="rev" title={`Copy ${id}`} onClick={() => void copyText(id).then(setCopied)}>
      {id.slice(0, 8)}<Iconoir name={copied ? "check" : "copy"} />
    </button>
  );
}

const PERMISSION_MODES: readonly PermissionMode[] = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"];

/** The task's permission mode, then its model and effort (the pool's defaults where it chose none). */
function Settings({ task, node, pool, disabled }: { task: TaskRef; node: NodeRef; pool: PoolRef; disabled: boolean }) {
  const models = useValue(node.models);
  const defaults = useValue(pool.defaults);
  const permissionMode = useValue(task.permissionMode);
  const model = useValue(task.model);
  const effort = useValue(task.effort);
  const action = useAction();
  /** The model and the effort just picked, each shown until its change lands (or fails), so the pill does not snap back. */
  const [pickedModel, setPickedModel] = useState<string | null>(null);
  const [pickedEffort, setPickedEffort] = useState<string | null>(null);
  /** The mode just picked, shown until the session reports a mode (an idle task only takes it at its next turn). */
  const [pickedMode, setPickedMode] = useState<PermissionMode | null>(null);
  useEffect(() => setPickedMode(null), [permissionMode]);
  const mode = pickedMode ?? permissionMode;
  return (
    <>
      {action.error !== null && <span class="error" title={action.error}>!</span>}
      <select class="pill" title="Permission mode" disabled={disabled} value={mode ?? ""} onChange={(e) => {
        const next = e.currentTarget.value as PermissionMode;
        setPickedMode(next);
        void action.run(() => task.setPermissionMode({ mode: next })).then((ok) => { if (!ok) setPickedMode(null); });
      }}>
        {mode === null && <option value="">mode</option>}
        {PERMISSION_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
      </select>
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
