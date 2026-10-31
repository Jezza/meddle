// One task: its thread from the session's event log, what waits on you, the controls and the composer.
import type { EffortLevel, PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type { Host, Ref } from "@earendil-works/chord";
import { useEffect, useMemo, useState } from "preact/hooks";
import { NodeObject, SessionObject, TaskObject } from "../../state/contracts";
import { useAction, useObject, useValue } from "./hooks";
import { buildThread, type ThreadItem } from "./thread-model";

type NodeRef = Ref<typeof NodeObject>;
type TaskRef = Ref<typeof TaskObject>;
type SessionRef = Ref<typeof SessionObject>;
type Pending = TaskRef["pending"]["value"][number];
type LogEvent = SessionRef["window"]["value"][number];

const PERMISSION_MODES: readonly PermissionMode[] = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"];
const EFFORT_LEVELS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
const EARLIER_PAGE = 200;

export function Task({ host, node, taskId }: { host: Host; node: NodeRef; taskId: string }) {
  const task = useObject(host, TaskObject, { id: taskId });
  const session = useObject(host, SessionObject, { taskId });
  const error = task.error ?? session.error;
  if (error !== undefined) return <p class="error">{error}</p>;
  if (task.ref === undefined || session.ref === undefined) return <p class="muted">Loading task…</p>;
  return <TaskLoaded node={node} task={task.ref} session={session.ref} />;
}

function TaskLoaded({ node, task, session }: { node: NodeRef; task: TaskRef; session: SessionRef }) {
  const manifest = useValue(task.manifest);
  const state = useValue(task.state);
  const pending = useValue(task.pending);
  return (
    <>
      <header class="task-head">
        <h2>{manifest.title} <span class={`state ${state}`}>{state}</span></h2>
        <p class="muted">
          {manifest.projects.map((p) => `${p.name} (${p.workspace})`).join(", ")} · session {manifest.sessionId}
        </p>
      </header>
      <Controls node={node} task={task} />
      <Thread session={session} />
      {pending.map((p) => <PendingPanel key={p.requestId} task={task} pending={p} />)}
      <Composer task={task} running={state === "running" || state === "waiting"} />
    </>
  );
}

// ─── the thread ───

function Thread({ session }: { session: SessionRef }) {
  const window = useValue(session.window);
  const live = useValue(session.live);
  /** Every event seen since the view opened: the window slides past events, and "load earlier" adds older ones. */
  const [seen, setSeen] = useState<Map<number, LogEvent>>(() => new Map());
  const [noneEarlier, setNoneEarlier] = useState(false);
  const action = useAction();
  useEffect(() => setSeen((prev) => merged(prev, window)), [window]);

  const events = useMemo(() => [...merged(seen, window).values()].sort((a, b) => a.seq - b.seq), [seen, window]);
  const items = useMemo(() => buildThread(events), [events]);
  const oldest = events[0]?.seq;

  const loadEarlier = () => action.run(async () => {
    if (oldest === undefined) return;
    const earlier = await session.loadEarlier({ beforeSeq: oldest, limit: EARLIER_PAGE });
    if (earlier.length < EARLIER_PAGE) setNoneEarlier(true);
    setSeen((prev) => merged(prev, earlier));
  });

  return (
    <section class="thread">
      {oldest !== undefined && oldest > 1 && !noneEarlier && (
        <button disabled={action.busy} onClick={loadEarlier}>Load earlier</button>
      )}
      {action.error !== null && <p class="error">{action.error}</p>}
      {items.length === 0 && live === null && <p class="muted">Nothing yet: send a prompt below.</p>}
      {items.map((item, i) => <Item key={i} item={item} />)}
      {live !== null && (
        <div class="item assistant live">
          {live.thinking !== "" && <details open><summary>thinking</summary><pre>{live.thinking}</pre></details>}
          <div class="text">{live.text}</div>
        </div>
      )}
    </section>
  );
}

function merged(into: Map<number, LogEvent>, events: readonly LogEvent[]): Map<number, LogEvent> {
  if (events.every((e) => into.has(e.seq))) return into;
  const next = new Map(into);
  for (const e of events) next.set(e.seq, e);
  return next;
}

function Item({ item }: { item: ThreadItem }) {
  switch (item.kind) {
    case "user":
      return <div class="item user"><div class="text">{item.text}</div></div>;
    case "assistant":
      return (
        <div class="item assistant">
          {item.thinking !== undefined && <details><summary>thinking</summary><pre>{item.thinking}</pre></details>}
          {item.text !== "" && <div class="text">{item.text}</div>}
        </div>
      );
    case "tool":
      return (
        <details class="item tool" open={item.result === undefined}>
          <summary>
            <strong>{item.name}</strong> <span class="muted">{toolSummary(item.input)}</span>
            {item.result === undefined ? <span class="muted"> · running</span> : item.result.isError && <span class="error"> · error</span>}
          </summary>
          <pre>{json(item.input)}</pre>
          {item.children.length > 0 && (
            <div class="children">
              {item.agentId !== undefined && <p class="muted">agent {item.agentId}</p>}
              {item.children.map((child, i) => <Item key={i} item={child} />)}
            </div>
          )}
          {item.result !== undefined && <pre class={item.result.isError ? "result error" : "result"}>{item.result.text}</pre>}
        </details>
      );
    case "question":
      return (
        <div class="item question">
          <strong>Question</strong>
          {questionsOf(item.questions).map((q) => <p key={q.question}>{q.question} <span class="muted">({q.options.map((o) => o.label).join(" / ")})</span></p>)}
        </div>
      );
    case "denied":
      return (
        <div class="item denied">
          Denied <strong>{item.toolName}</strong>
          {item.reason !== undefined && `: ${item.reason}`}
          {item.reasonType !== undefined && <span class="muted"> ({item.reasonType})</span>}
        </div>
      );
    case "status":
      return <div class="item status muted">{item.text}</div>;
    case "unknown":
      return <details class="item unknown muted"><summary>{item.type}</summary><pre>{json(item.raw)}</pre></details>;
  }
}

/** The input field that says most about a call, for its one-line summary. */
function toolSummary(input: unknown): string {
  if (input === null || typeof input !== "object") return "";
  const fields = input as Record<string, unknown>;
  for (const key of ["command", "file_path", "path", "pattern", "url", "query", "description", "prompt"]) {
    const value = fields[key];
    if (typeof value === "string") return value.length > 120 ? `${value.slice(0, 120)}…` : value;
  }
  return "";
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
  const [edited, setEdited] = useState(() => json(pending.input));
  const [message, setMessage] = useState("Denied from the dashboard");
  const { requestId } = pending;

  const allowEdited = () => action.run(async () => {
    const updatedInput: unknown = JSON.parse(edited);
    if (updatedInput === null || typeof updatedInput !== "object" || Array.isArray(updatedInput)) {
      throw new Error("the edited input must be a JSON object");
    }
    await task.approve({ requestId, updatedInput: updatedInput as Record<string, unknown> });
  });

  return (
    <section class="pending">
      <h3>{pending.toolName} needs approval</h3>
      {pending.decisionReason !== undefined && <p class="muted">{pending.decisionReason}</p>}
      {editing
        ? <textarea rows={8} value={edited} onInput={(e) => setEdited(e.currentTarget.value)} />
        : <pre>{json(pending.input)}</pre>}
      <div class="row">
        <button disabled={action.busy} onClick={() => action.run(() => task.approve({ requestId }))}>Allow</button>
        {editing
          ? <button disabled={action.busy} onClick={allowEdited}>Allow with this input</button>
          : <button disabled={action.busy} onClick={() => setEditing(true)}>Allow with edited input…</button>}
        <label>Deny message <input value={message} onInput={(e) => setMessage(e.currentTarget.value)} /></label>
        <button disabled={action.busy} onClick={() => action.run(() => task.deny({ requestId, message }))}>Deny</button>
        <button disabled={action.busy} onClick={() => action.run(() => task.deny({ requestId, message, interrupt: true }))}>Deny and interrupt</button>
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
    <section class="pending">
      <h3>Claude asks</h3>
      {questions.map((q) => (
        <fieldset key={q.question}>
          <legend>{q.header}</legend>
          <p>{q.question}</p>
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
        </fieldset>
      ))}
      <div class="row">
        <button disabled={action.busy || !complete} onClick={submit}>Answer</button>
        <button disabled={action.busy} onClick={() => action.run(() => task.deny({ requestId: pending.requestId, message: "The user declined to answer" }))}>Decline</button>
      </div>
      {action.error !== null && <p class="error">{action.error}</p>}
    </section>
  );
}

// ─── controls and composer ───

function Controls({ node, task }: { node: NodeRef; task: TaskRef }) {
  const state = useValue(task.state);
  const pending = useValue(task.pending);
  const models = useValue(node.models);
  const permissionMode = useValue(task.permissionMode);
  const model = useValue(task.model);
  const effort = useValue(task.effort);
  const contextUsage = useValue(task.contextUsage);
  const action = useAction();
  const modelOptions = model !== null && !models.includes(model) ? [model, ...models] : models;

  return (
    <section class="controls">
      <div class="row">
        <button disabled={action.busy} onClick={() => action.run(() => task.interrupt({}))}>Interrupt</button>
        {/* A turn that crashed the node too often is parked; retry says so when none is. */}
        {(state === "running" || state === "waiting") && pending.length === 0 && (
          <button disabled={action.busy} onClick={() => action.run(() => task.retry({}))}>Retry turn</button>
        )}
        <label>Permission mode{" "}
          <select value={permissionMode ?? ""} onChange={(e) => {
            const mode = e.currentTarget.value as PermissionMode;
            void action.run(() => task.setPermissionMode({ mode }));
          }}>
            {permissionMode === null && <option value="">(not known yet)</option>}
            {PERMISSION_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <label>Model{" "}
          <select value={model ?? ""} onChange={(e) => {
            const value = e.currentTarget.value;
            void action.run(() => task.setModel(value === "" ? {} : { model: value }));
          }}>
            <option value="">(default)</option>
            {modelOptions.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <label>Effort{" "}
          <select value={effort ?? ""} onChange={(e) => {
            const value = e.currentTarget.value;
            void action.run(() => task.setEffort({ effort: value }));
          }}>
            {effort === null && <option value="">(default)</option>}
            {EFFORT_LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </label>
      </div>
      <p class="muted">{contextText(contextUsage)}</p>
      {action.error !== null && <p class="error">{action.error}</p>}
    </section>
  );
}

type Usage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };

/** The latest `result`'s usage (summed over the turn's API calls) and its models' context windows. */
function contextText(value: unknown): string {
  const { usage, modelUsage } = (value ?? {}) as { usage?: Usage | null; modelUsage?: Record<string, { contextWindow?: number }> | null };
  if (usage === undefined || usage === null) return "Context usage: no turn finished yet";
  const input = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  const windows = Object.entries(modelUsage ?? {})
    .filter(([, m]) => typeof m.contextWindow === "number")
    .map(([name, m]) => `${name} ${m.contextWindow!.toLocaleString()}`);
  return `Latest turn: ${input.toLocaleString()} input tokens (${(usage.cache_read_input_tokens ?? 0).toLocaleString()} cached), `
    + `${(usage.output_tokens ?? 0).toLocaleString()} output tokens`
    + (windows.length > 0 ? ` · context window ${windows.join(", ")}` : "");
}

function Composer({ task, running }: { task: TaskRef; running: boolean }) {
  const [text, setText] = useState("");
  const action = useAction();
  const send = async () => {
    if (text.trim() === "") return;
    if (await action.run(() => task.prompt({ text }))) setText("");
  };
  return (
    <section class="composer">
      <textarea
        rows={3}
        value={text}
        placeholder={running ? "Steer the running turn… (Ctrl+Enter sends)" : "Prompt… (Ctrl+Enter sends)"}
        onInput={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); } }}
      />
      <button disabled={action.busy || text.trim() === ""} onClick={send}>{running ? "Steer" : "Send"}</button>
      {action.error !== null && <p class="error">{action.error}</p>}
    </section>
  );
}
