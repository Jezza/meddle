// One task: its head (title, state, actions), the thread from the session's event log with what waits on you inline,
// the composer, and the bar beneath (project, node, bookmark, the latest turn's tokens, mode, effort, model).
import type { EffortLevel, PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type { Host, Ref } from "@earendil-works/chord";
import DOMPurify from "dompurify";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { type Live as LiveState, NodeObject, SessionObject, TaskObject } from "../../state/contracts";
import { shortId } from "../../pool/ids";
import { type Hosts, useAction, useObject, useValue } from "./hooks";
import { type Anchor, MoveMenu, PaneHead, type PoolRef, RenameInput, RestoreMenu, StateDot, Unavailable } from "./common";
import { renderMarkdown } from "./markdown";
import { hashOf } from "./routes";
import { usageShort } from "./sidebar-model";
import { activity, activityLine, buildThread, duration, foldSteps, stepsLine, toolSummary, type ShownItem, type Step, type ThreadItem } from "./thread-model";

type NodeRef = Ref<typeof NodeObject>;
type TaskRef = Ref<typeof TaskObject>;
type SessionRef = Ref<typeof SessionObject>;
type Pending = TaskRef["pending"]["value"][number];
type LogEvent = SessionRef["window"]["value"][number];
type ToolItem = Extract<ThreadItem, { kind: "tool" }>;

const PERMISSION_MODES: readonly PermissionMode[] = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"];
const EFFORT_LEVELS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
const EARLIER_PAGE = 200;
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
  const move = useValue(task.move);
  const movedTo = useValue(task.movedTo);
  const archivedOn = useValue(task.archivedOn);
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
  return (
    <div class="task">
      <TaskHead task={task} nodes={nodes} nodeId={nodeId} title={manifest.title} state={state} pendingCount={pending.length} moving={moving} />
      {move !== null && <MoveBanner task={task} move={move} to={nameOf(move.to)} />}
      {state === "moved" ? (
        <p class="pane-note">Moved to {movedTo === null ? "another node" : <a href={hashOf({ name: "task", nodeId: movedTo, id: manifest.id })}>{nameOf(movedTo)}</a>}.</p>
      ) : (
        <Thread session={session} readOnly={archived} working={state === "running"} after={pending.map((p) => <PendingPanel key={p.requestId} task={task} pending={p} />)} />
      )}
      {!archived && state !== "moved" && <Composer task={task} running={live} disabled={moving} />}
      <BottomBar task={task} pool={pool} node={node} nodeId={nodeId} archived={archived} archivedOn={archivedOn === null ? null : nameOf(archivedOn)} moving={moving} />
    </div>
  );
}

// ─── the head ───

function TaskHead({ task, nodes, nodeId, title, state, pendingCount, moving }: {
  task: TaskRef; nodes: PoolRef["nodes"]["value"]; nodeId: string; title: string; state: string; pendingCount: number; moving: boolean;
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
      </div>
      <div class="head-actions">
        {action.error !== null && <span class="error" title={action.error}>{action.error}</span>}
        {live && <button disabled={moving || action.busy} onClick={() => action.run(() => task.interrupt({}))}>■ Interrupt</button>}
        {/* A turn that crashed the node too often is parked; retry says so when none is. */}
        {live && pendingCount === 0 && <button disabled={moving || action.busy} title="Runs a parked turn again" onClick={() => action.run(() => task.retry({}))}>↻ Retry</button>}
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

/** The shown items in blocks: each user message alone, Claude's run of items under one avatar, status lines apart. */
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

function Thread({ session, readOnly, working, after }: { session: SessionRef; readOnly: boolean; working: boolean; after: preact.ComponentChildren }) {
  const window = useValue(session.window);
  const live = useValue(session.live);
  /** Every event seen since the view opened: the window slides past events, and "load earlier" adds older ones. */
  const [seen, setSeen] = useState<Map<number, LogEvent>>(() => new Map());
  const [noneEarlier, setNoneEarlier] = useState(false);
  const action = useAction();
  useEffect(() => setSeen((prev) => merged(prev, window)), [window]);

  const events = useMemo(() => [...merged(seen, window).values()].sort((a, b) => a.seq - b.seq), [seen, window]);
  const items = useMemo(() => buildThread(events), [events]);
  const blocks = useMemo(() => blocksOf(foldSteps(items)), [items]);
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
    <div class="thread-scroll" ref={scroller}
      onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
      <div class="thread">
        {oldest !== undefined && oldest > 1 && !noneEarlier && (
          <button class="earlier" disabled={action.busy} onClick={loadEarlier}>Load earlier</button>
        )}
        {action.error !== null && <p class="error">{action.error}</p>}
        {blocks.length === 0 && !tail && <p class="muted empty">{readOnly ? "Nothing in this task's log." : "Nothing yet: send a prompt below."}</p>}
        {blocks.map((b, i) => (
          <BlockView key={i} block={b}>
            {i === blocks.length - 1 && lastClaude && tail && <Live live={live} doing={doing} pulse={pulse} />}
          </BlockView>
        ))}
        {tail && !lastClaude && <BlockView block={{ who: "claude", items: [] }}><Live live={live} doing={doing} pulse={pulse} /></BlockView>}
        {after}
      </div>
    </div>
  );
}

function merged(into: Map<number, LogEvent>, events: readonly LogEvent[]): Map<number, LogEvent> {
  if (events.every((e) => into.has(e.seq))) return into;
  const next = new Map(into);
  for (const e of events) next.set(e.seq, e);
  return next;
}

function BlockView({ block, children }: { block: Block; children?: preact.ComponentChildren }) {
  if (block.who === "status") {
    return <div class="status-block">{block.items.map((item, i) => <ShownView key={i} item={item} />)}{children}</div>;
  }
  return (
    <div class={`msg ${block.who}`}>
      <div class={`avatar ${block.who}`} title={block.who === "user" ? "you" : "Claude"}>{block.who === "user" ? "" : "✻"}</div>
      <div class="msg-body">
        {block.items.map((item, i) => <ShownView key={i} item={item} />)}
        {children}
      </div>
    </div>
  );
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

function ShownView({ item }: { item: ShownItem }) {
  switch (item.kind) {
    case "user":
      return <div class="user-text">{item.text}</div>;
    case "assistant":
      return (
        // Finished thinking is not shown in the thread; a run of steps keeps what thinking stood alone.
        item.text !== "" && <Markdown text={item.text} />
      );
    case "steps":
      return <Steps steps={item.steps} />;
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
      return <div class={`status${/^(Turn failed|Turn aborted|Turn ended|Token |No usable token|Rate limit rejected)/.test(item.text) ? " bad" : ""}`}>{item.text}</div>;
  }
}

function Thinking({ text }: { text: string }) {
  return <details class="thinking"><summary>thinking</summary><div class="thinking-text">{text}</div></details>;
}

function StepView({ step }: { step: Step }) {
  switch (step.kind) {
    case "tool":
      return <Tool tool={step} />;
    case "assistant":
      return <Thinking text={step.thinking ?? ""} />;
    case "unknown":
      return <details class="unknown muted"><summary>{step.type}</summary><pre>{json(step.raw)}</pre></details>;
  }
}

/**
 * What Claude did between its prose, as one row from its first call on: a state dot and a line saying what the calls
 * did (`stepsLine`), closed until you open it. Calls coming in and finishing only change that line, so the thread
 * does not shift; a run of only thinking shows nothing.
 */
function Steps({ steps }: { steps: Step[] }) {
  const line = stepsLine(steps);
  if (line.text === "") return null;
  return (
    <details class="tools">
      <summary>
        <Dot state={line.running ? "running" : line.failed > 0 ? "error" : "ok"} />
        {line.text}
        {line.failed > 0 && <span class="error"> · {line.failed} failed</span>}
      </summary>
      <div class="tool-list">{steps.map((s, i) => <StepView key={s.kind === "tool" ? s.toolUseId : i} step={s} />)}</div>
    </details>
  );
}

/** A call's state: blinking while it runs, then green, or red when it failed. */
function Dot({ state }: { state: "running" | "ok" | "error" }) {
  const label = state === "running" ? "running" : state === "ok" ? "done" : "failed";
  return <span class={`dot ${state}`} role="img" aria-label={label} title={label} />;
}

function Tool({ tool }: { tool: ToolItem }) {
  const shown = useMemo(() => foldSteps(tool.children), [tool.children]);
  const input = tool.input as { command?: unknown; description?: unknown } | null;
  return (
    <details class="tool">
      <summary>
        <Dot state={tool.result === undefined ? "running" : tool.result.isError ? "error" : "ok"} />
        <b>{tool.name}</b> <span class="muted">{toolSummary(tool.input)}</span>
      </summary>
      {typeof input?.command === "string"
        ? <>{typeof input.description === "string" && <p class="tool-note muted">{input.description}</p>}<pre>{input.command}</pre></>
        : <pre>{json(tool.input)}</pre>}
      {shown.length > 0 && (
        <div class="children">
          {tool.agentId !== undefined && <p class="muted">agent {tool.agentId}</p>}
          {shown.map((child, i) => <ShownView key={i} item={child} />)}
        </div>
      )}
      {tool.result !== undefined && <pre class={tool.result.isError ? "result error" : "result"}>{tool.result.text}</pre>}
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
        placeholder={disabled ? "Moving: prompts wait until it lands" : running ? "Steer the running turn…" : "Reply…"}
        onInput={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); } }}
      />
      <div class="composer-row">
        {action.error !== null ? <span class="error">{action.error}</span> : <span class="muted">Ctrl+Enter sends</span>}
        <button class="primary" disabled={disabled || action.busy || text.trim() === ""} onClick={send}>{running ? "Steer" : "Send"}</button>
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
      {!archived && <Settings task={task} node={node} disabled={moving} />}
      {moveAt !== null && <MoveMenu task={task} nodes={nodes} from={nodeId} anchor={moveAt} onClose={() => setMoveAt(null)} />}
    </footer>
  );
}

/** The task's permission mode, effort and model, as small selects. */
function Settings({ task, node, disabled }: { task: TaskRef; node: NodeRef; disabled: boolean }) {
  const models = useValue(node.models);
  const permissionMode = useValue(task.permissionMode);
  const model = useValue(task.model);
  const effort = useValue(task.effort);
  const action = useAction();
  const modelOptions = model !== null && !models.includes(model) ? [model, ...models] : models;
  return (
    <>
      {action.error !== null && <span class="error" title={action.error}>!</span>}
      <select class="pill" title="Permission mode" disabled={disabled} value={permissionMode ?? ""} onChange={(e) => {
        const mode = e.currentTarget.value as PermissionMode;
        void action.run(() => task.setPermissionMode({ mode }));
      }}>
        {permissionMode === null && <option value="">mode</option>}
        {PERMISSION_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
      </select>
      <select class="pill" title="Effort" disabled={disabled} value={effort ?? ""} onChange={(e) => {
        const value = e.currentTarget.value;
        void action.run(() => task.setEffort({ effort: value }));
      }}>
        {effort === null && <option value="">effort</option>}
        {EFFORT_LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
      </select>
      <select class="pill" title="Model" disabled={disabled} value={model ?? ""} onChange={(e) => {
        const value = e.currentTarget.value;
        void action.run(() => task.setModel(value === "" ? {} : { model: value }));
      }}>
        <option value="">default model</option>
        {modelOptions.map((m) => <option key={m} value={m}>{m}</option>)}
      </select>
    </>
  );
}
