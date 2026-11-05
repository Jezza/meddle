// The thread a task's event log renders as: pure, so it is tested without a DOM or a link.
import { isProgress, type Live } from "../../state/contracts";

export type ThreadItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; thinking?: string }
  | {
    kind: "tool";
    name: string;
    input: unknown;
    toolUseId: string;
    result?: { text: string; isError: boolean };
    children: ThreadItem[];
    agentId?: string;
  }
  | { kind: "question"; toolUseId: string; questions: unknown }
  | { kind: "denied"; toolName: string; reason?: string; reasonType?: string }
  | { kind: "status"; text: string }
  | { kind: "unknown"; type: string; raw: unknown };

type ToolItem = Extract<ThreadItem, { kind: "tool" }>;
type AssistantItem = Extract<ThreadItem, { kind: "assistant" }>;
type DeniedItem = Extract<ThreadItem, { kind: "denied" }>;
type Block = { type?: unknown; [key: string]: unknown };
type Message = { type?: unknown; subtype?: unknown; [key: string]: unknown };

/**
 * Builds the thread from events in seq order. Progress frames (`PROGRESS_KINDS`) are left out (the session's
 * `live` cell covers `stream_event`s), and so is a status that only says a request went out or the session went idle; an assistant message streamed as several events with one id becomes one item; a `tool_result` attaches
 * to its `tool_use`; a message with a `parent_tool_use_id` nests under that call.
 */
export function buildThread(events: Array<{ seq: number; message: unknown }>): ThreadItem[] {
  const top: ThreadItem[] = [];
  const tools = new Map<string, ToolItem>();
  /** Question tool uses: their results are the answers the question item already stands for. */
  const questions = new Set<string>();
  const assistants = new Map<string, AssistantItem>();
  const denials = new Map<string, DeniedItem>();

  /** Where a message with this parent goes: under its call when the call is known, else at the top. */
  const listFor = (parent: unknown): ThreadItem[] =>
    (typeof parent === "string" ? tools.get(parent)?.children : undefined) ?? top;

  for (const { message } of events) {
    const m = (message ?? {}) as Message;
    if (isProgress(m)) continue;
    switch (m.type) {
      case "rate_limit_event": {
        // Every turn reports its rate limit; only one that is not plainly allowed says something.
        const info = (m.rate_limit_info ?? {}) as { status?: unknown; rateLimitType?: unknown };
        if (info.status !== "allowed") {
          const kind = typeof info.rateLimitType === "string" ? ` (${info.rateLimitType})` : "";
          top.push({ kind: "status", text: `Rate limit ${String(info.status)}${kind}` });
        }
        break;
      }
      case "assistant":
        addAssistant(m, listFor(m.parent_tool_use_id));
        break;
      case "user":
        addUser(m, listFor(m.parent_tool_use_id));
        break;
      case "system":
        addSystem(m);
        break;
      case "result":
        top.push({ kind: "status", text: resultText(m) });
        break;
      case "meddle":
        addMeddle(m);
        break;
      default:
        top.push(unknown(m));
    }
  }
  return top;

  function addAssistant(m: Message, list: ThreadItem[]) {
    const inner = (m.message ?? {}) as { id?: unknown; content?: unknown };
    const id = typeof inner.id === "string" ? inner.id : undefined;
    for (const block of blocks(inner.content)) {
      if (block.type === "text" || block.type === "thinking") {
        let item = id !== undefined ? assistants.get(id) : undefined;
        if (item === undefined) {
          item = { kind: "assistant", text: "" };
          list.push(item);
          if (id !== undefined) assistants.set(id, item);
        }
        if (block.type === "text") item.text += str(block.text);
        else item.thinking = (item.thinking ?? "") + str(block.thinking);
      } else if (block.type === "tool_use") {
        const toolUseId = str(block.id);
        if (block.name === "AskUserQuestion") {
          questions.add(toolUseId);
          list.push({ kind: "question", toolUseId, questions: (block.input as { questions?: unknown } | undefined)?.questions });
        } else {
          const tool: ToolItem = { kind: "tool", name: str(block.name), input: block.input, toolUseId, children: [] };
          tools.set(toolUseId, tool);
          list.push(tool);
        }
      } else if (block.type !== "redacted_thinking") {
        list.push({ kind: "unknown", type: `assistant:${String(block.type)}`, raw: block });
      }
    }
  }

  function addUser(m: Message, list: ThreadItem[]) {
    const content = (m.message as { content?: unknown } | undefined)?.content;
    if (typeof content === "string") {
      list.push({ kind: "user", text: content });
      return;
    }
    const texts: string[] = [];
    for (const block of blocks(content)) {
      if (block.type === "tool_result") {
        const id = str(block.tool_use_id);
        const tool = tools.get(id);
        if (tool !== undefined) {
          tool.result = { text: contentText(block.content), isError: block.is_error === true };
          const agentId = (m.tool_use_result as { agentId?: unknown } | undefined)?.agentId;
          if (typeof agentId === "string") tool.agentId = agentId;
        } else if (!questions.has(id)) {
          list.push({ kind: "unknown", type: "tool_result", raw: block });
        }
      } else if (block.type === "text") {
        texts.push(str(block.text));
      } else {
        texts.push(`[${String(block.type)}]`);
      }
    }
    if (texts.length > 0) list.push({ kind: "user", text: texts.join("\n") });
  }

  function addSystem(m: Message) {
    switch (m.subtype) {
      case "permission_denied":
        addDenied(m.tool_use_id, str(m.tool_name), m.decision_reason, m.decision_reason_type, true);
        return;
      case "status": {
        const parts = [];
        if (m.status !== null && m.status !== undefined && m.status !== "requesting") parts.push(String(m.status));
        if (typeof m.permissionMode === "string") parts.push(`permission mode ${m.permissionMode}`);
        if (typeof m.compact_result === "string") parts.push(`compaction ${m.compact_result}`);
        if (typeof m.compact_error === "string") parts.push(m.compact_error);
        // Every API request reports "requesting", and every turn's end idle: neither says anything.
        if (parts.length > 0) top.push({ kind: "status", text: `Status: ${parts.join(", ")}` });
        return;
      }
      case "compact_boundary": {
        const meta = (m.compact_metadata ?? {}) as { trigger?: unknown; pre_tokens?: unknown; post_tokens?: unknown };
        const tokens = typeof meta.post_tokens === "number" ? `${meta.pre_tokens} → ${meta.post_tokens}` : `${meta.pre_tokens}`;
        top.push({ kind: "status", text: `Conversation compacted (${String(meta.trigger)}, ${tokens} tokens)` });
        return;
      }
      case "init":
        // The bar beneath the thread shows the model and permission mode.
        return;
      default:
        top.push(unknown(m));
    }
  }

  function addMeddle(m: Message) {
    switch (m.subtype) {
      case "turn_started":
        // The prompt that follows says a turn started; only a resumed one is worth a line.
        if (m.resume === true) top.push({ kind: "status", text: "Turn resumed" });
        return;
      case "turn_aborted":
        top.push({ kind: "status", text: "Turn aborted" });
        return;
      case "turn_failed":
        top.push({ kind: "status", text: `Turn failed: ${str(m.error)}` });
        return;
      case "token_fault":
        top.push({ kind: "status", text: tokenFaultText(m) });
        return;
      case "permission_denied_hook": {
        const input = (m.input ?? {}) as { tool_use_id?: unknown; tool_name?: unknown; reason?: unknown };
        addDenied(input.tool_use_id, str(input.tool_name), input.reason, undefined, false);
        return;
      }
      default:
        top.push(unknown(m));
    }
  }

  /**
   * One item per denied call: the hook and the `permission_denied` message both report it, in either order; the
   * message's reason wins.
   */
  function addDenied(toolUseId: unknown, toolName: string, reason: unknown, reasonType: unknown, fromMessage: boolean) {
    const key = typeof toolUseId === "string" && toolUseId !== "" ? toolUseId : undefined;
    let item = key !== undefined ? denials.get(key) : undefined;
    if (item === undefined) {
      item = { kind: "denied", toolName };
      top.push(item);
      if (key !== undefined) denials.set(key, item);
    }
    if (typeof reason === "string" && (fromMessage || item.reason === undefined)) item.reason = reason;
    if (typeof reasonType === "string") item.reasonType = reasonType;
  }
}

function unknown(m: Message): ThreadItem {
  const type = typeof m.subtype === "string" ? `${String(m.type)}:${m.subtype}` : String(m.type);
  return { kind: "unknown", type, raw: m };
}

/** A `token_fault`: which token failed the turn and how, and whether the turn goes on with another login. */
function tokenFaultText(m: Message): string {
  const fault = (m.fault ?? {}) as { kind?: unknown; until?: unknown; reason?: unknown };
  if (fault.kind === "none") return "No usable token";
  const what = fault.kind === "disabled"
    ? `disabled: ${str(fault.reason)}`
    : `exhausted${typeof fault.until === "string" ? ` until ${fault.until}` : ""}`;
  const rest = m.rerun === true ? "switching login" : m.retried === true ? "already switched login once" : "no other token";
  return `Token ${str(m.label) || str(m.tokenId)} ${what}; ${rest}`;
}

function resultText(m: Message): string {
  const parts = [m.subtype === "success" ? "Turn finished" : `Turn ended: ${String(m.subtype)}`];
  if (typeof m.num_turns === "number") parts.push(`${m.num_turns} turns`);
  if (typeof m.duration_ms === "number") parts.push(`${(m.duration_ms / 1000).toFixed(1)} s`);
  if (typeof m.total_cost_usd === "number") parts.push(`$${m.total_cost_usd.toFixed(4)}`);
  return parts.join(" · ");
}

function blocks(content: unknown): Block[] {
  return Array.isArray(content) ? (content.filter((b) => b !== null && typeof b === "object") as Block[]) : [];
}

/** A `tool_result`'s content: a string, or blocks whose text is joined (other blocks named by type). */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  return blocks(content).map((b) => (b.type === "text" ? str(b.text) : `[${String(b.type)}]`)).join("\n");
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

type UnknownItem = Extract<ThreadItem, { kind: "unknown" }>;

/** What happens between Claude's prose: a tool call, thinking with no text, or a message the thread does not know. */
export type Step = ToolItem | AssistantItem | UnknownItem;

/**
 * A thread item as the view shows it: a run of steps (tool calls, thinking with no text, unknown messages) folds
 * into one `steps` line, which names its tool calls.
 */
export type ShownItem =
  | Exclude<ThreadItem, ToolItem | UnknownItem>
  | { kind: "steps"; steps: Step[]; tools: ToolItem[] };

function isStep(item: ThreadItem): item is Step {
  return item.kind === "tool" || item.kind === "unknown" || (item.kind === "assistant" && item.text === "");
}

/** Folds each run of consecutive steps into one item; the rest stay as they are. */
export function foldSteps(items: readonly ThreadItem[]): ShownItem[] {
  const shown: ShownItem[] = [];
  for (const item of items) {
    if (!isStep(item)) {
      shown.push(item as ShownItem);
      continue;
    }
    // Thinking whose text the API left out says nothing.
    if (item.kind === "assistant" && (item.thinking ?? "") === "") continue;
    let last = shown.at(-1);
    if (last?.kind !== "steps") {
      last = { kind: "steps", steps: [], tools: [] };
      shown.push(last);
    }
    last.steps.push(item);
    if (item.kind === "tool") last.tools.push(item);
  }
  return shown;
}

/** The input field that says most about a call, for its one-line summary. */
export function toolSummary(input: unknown, max = 120): string {
  if (input === null || typeof input !== "object") return "";
  const fields = input as Record<string, unknown>;
  for (const key of ["command", "file_path", "path", "pattern", "url", "query", "description", "prompt"]) {
    const value = fields[key];
    if (typeof value === "string") {
      const line = value.split("\n")[0]!;
      return line.length > max ? `${line.slice(0, max)}…` : line;
    }
  }
  return "";
}

/** How a run names each kind of call: by what it does, present while one runs, and what it counts. */
const KINDS: Array<{ tools: string[]; doing: string; did: string; one: string; many: string; label?: string }> = [
  { tools: ["Bash", "BashOutput"], doing: "Running", did: "Ran", one: "command", many: "commands" },
  { tools: ["Read", "NotebookRead"], doing: "Reading", did: "Read", one: "file", many: "files" },
  { tools: ["Grep", "Glob"], doing: "Searching for", did: "Searched for", one: "pattern", many: "patterns" },
  { tools: ["Edit", "MultiEdit", "NotebookEdit"], doing: "Editing", did: "Edited", one: "file", many: "files" },
  { tools: ["Write"], doing: "Writing", did: "Wrote", one: "file", many: "files" },
  { tools: ["WebFetch"], doing: "Fetching", did: "Fetched", one: "page", many: "pages" },
  { tools: ["WebSearch"], doing: "Searching the web for", did: "Searched the web for", one: "query", many: "queries" },
  { tools: ["Agent", "Task"], doing: "Running", did: "Ran", one: "agent", many: "agents", label: "agent: " },
];

/**
 * A run of steps in one line that keeps its shape as calls come in: a lone call says what it did ("Ran cargo
 * check"), more count by kind ("Read 2 files, searched for 1 pattern"), each kind in the present while one of its
 * calls runs. Thinking is not counted; a run of only thinking says nothing.
 */
export function stepsLine(steps: readonly Step[]): { text: string; running: boolean; failed: number } {
  const tools = steps.filter((s): s is ToolItem => s.kind === "tool");
  const events = steps.filter((s) => s.kind === "unknown").length;
  const running = tools.some((t) => t.result === undefined);
  const failed = tools.filter((t) => t.result?.isError === true).length;
  const groups = new Map<string, ToolItem[]>();
  for (const t of tools) {
    const key = KINDS.findIndex((k) => k.tools.includes(t.name));
    const id = key >= 0 ? String(key) : `tool:${t.name}`;
    groups.set(id, [...(groups.get(id) ?? []), t]);
  }
  const parts: string[] = [];
  for (const [id, calls] of groups) {
    const busy = calls.some((t) => t.result === undefined);
    const kind = id.startsWith("tool:") ? undefined : KINDS[Number(id)]!;
    if (kind === undefined) {
      const verb = busy ? "calling" : "called";
      parts.push(calls.length === 1 ? `${verb} ${calls[0]!.name}` : `${verb} ${calls[0]!.name} ${calls.length} times`);
      continue;
    }
    const verb = (busy ? kind.doing : kind.did).toLowerCase();
    const summary = tools.length === 1 ? toolSummary(calls[0]!.input, 100) : "";
    parts.push(summary !== "" ? `${verb} ${kind.label ?? ""}${summary}` : `${verb} ${calls.length} ${calls.length === 1 ? kind.one : kind.many}`);
  }
  if (events > 0) parts.push(`${events} event${events === 1 ? "" : "s"}`);
  const text = parts.join(", ");
  return { text: (text.charAt(0).toUpperCase() + text.slice(1)) + (running ? "…" : ""), running, failed };
}

/**
 * What a running turn is doing, for the line under it: the content block streaming (a thinking block says so even
 * when the API leaves its text out), else the call still waiting on its result (into a subagent's own calls).
 */
export function activity(live: Live, items: readonly ThreadItem[]): string {
  if (live !== null) {
    if (live.block === "tool_use" || live.block === "server_tool_use") {
      return live.tool !== undefined ? `Writing a ${live.tool} call` : "Writing a tool call";
    }
    if (live.block === "thinking" || live.block === "redacted_thinking") return "Thinking";
    if (live.block === "text" || live.text !== "") return "Writing";
    return "Thinking";
  }
  const names: string[] = [];
  for (let list = items; ;) {
    const tool = list.findLast((i): i is ToolItem => i.kind === "tool" && i.result === undefined);
    if (tool === undefined) break;
    names.push(tool.name);
    list = tool.children;
  }
  return names.length > 0 ? `Running ${names.join(" › ")}` : "Working";
}

/** Seconds as the activity line says them: `12s`, `3m 4s`. */
export function duration(seconds: number): string {
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/**
 * The activity line for what a turn is doing (`activity`), `phase` seconds into it and `quiet` seconds since
 * anything last streamed or landed. Thinking says so longer as it runs on, and is never stalled (its text may not
 * stream at all), nor is a running call; anything else stalls from 10 s of quiet, fully at 20 s (`stall` 0 to 1).
 */
export function activityLine(doing: string, phase: number, quiet: number): { text: string; stall: number } {
  if (doing === "Thinking") {
    const text = phase < 10 ? "Thinking" : phase < 20 ? "Still thinking" : phase < 30 ? "Thinking more" : phase < 45 ? "Thinking some more" : "Deep in thought";
    return { text, stall: 0 };
  }
  if (doing.startsWith("Running ")) return { text: doing, stall: 0 };
  return { text: doing, stall: Math.min(1, Math.max(0, (quiet - 10) / 10)) };
}
