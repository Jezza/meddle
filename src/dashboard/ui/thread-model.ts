// The thread a task's event log renders as: pure, so it is tested without a DOM or a link.

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
 * Builds the thread from events in seq order. `stream_event`s are left out (the session's `live` cell covers
 * them); an assistant message streamed as several events with one id becomes one item; a `tool_result` attaches
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
    switch (m.type) {
      case "stream_event":
        break;
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
        if (m.status !== null && m.status !== undefined) parts.push(String(m.status));
        if (typeof m.permissionMode === "string") parts.push(`permission mode ${m.permissionMode}`);
        if (typeof m.compact_result === "string") parts.push(`compaction ${m.compact_result}`);
        if (typeof m.compact_error === "string") parts.push(m.compact_error);
        top.push({ kind: "status", text: `Status: ${parts.join(", ") || "idle"}` });
        return;
      }
      case "compact_boundary": {
        const meta = (m.compact_metadata ?? {}) as { trigger?: unknown; pre_tokens?: unknown; post_tokens?: unknown };
        const tokens = typeof meta.post_tokens === "number" ? `${meta.pre_tokens} → ${meta.post_tokens}` : `${meta.pre_tokens}`;
        top.push({ kind: "status", text: `Conversation compacted (${String(meta.trigger)}, ${tokens} tokens)` });
        return;
      }
      case "init":
        top.push({ kind: "status", text: `Session started: model ${str(m.model)}, permission mode ${str(m.permissionMode)}` });
        return;
      default:
        top.push(unknown(m));
    }
  }

  function addMeddle(m: Message) {
    switch (m.subtype) {
      case "turn_started":
        top.push({ kind: "status", text: m.resume === true ? "Turn started (resumed)" : "Turn started" });
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

/** A thread item as the view shows it: a run of consecutive tool calls folds into one `tools` line. */
export type ShownItem = Exclude<ThreadItem, ToolItem> | { kind: "tools"; tools: ToolItem[] };

/** Folds each run of consecutive tool calls into one `tools` item; every other item stays as it is. */
export function foldTools(items: readonly ThreadItem[]): ShownItem[] {
  const shown: ShownItem[] = [];
  for (const item of items) {
    if (item.kind !== "tool") shown.push(item);
    else {
      const last = shown.at(-1);
      if (last?.kind === "tools") last.tools.push(item);
      else shown.push({ kind: "tools", tools: [item] });
    }
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

/** A run of calls in one line: the first two named with their summary, then how many more. */
export function toolsLine(tools: readonly ToolItem[]): { named: Array<{ name: string; summary: string }>; more: number } {
  const named = tools.slice(0, 2).map((t) => ({ name: t.name, summary: toolSummary(t.input, 60) }));
  return { named, more: tools.length - named.length };
}
