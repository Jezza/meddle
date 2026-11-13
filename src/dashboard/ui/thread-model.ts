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
    /** `patch`: the hunks a call that changed a file reported (`EDITS`). */
    result?: { text: string; isError: boolean; patch?: Hunk[] };
    children: ThreadItem[];
    agentId?: string;
  }
  | { kind: "question"; toolUseId: string; questions: unknown }
  | { kind: "denied"; toolName: string; reason?: string; reasonType?: string }
  | { kind: "status"; text: string }
  | { kind: "unknown"; type: string; raw: unknown };

/** One hunk of a file change, as Claude Code's `structuredPatch` reports it: lines prefixed `-`, `+` or a space. */
export type Hunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] };

export type ToolItem = Extract<ThreadItem, { kind: "tool" }>;
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
          const result = (m.tool_use_result ?? {}) as { agentId?: unknown; structuredPatch?: unknown };
          tool.result = { text: contentText(block.content), isError: block.is_error === true };
          const patch = hunks(result.structuredPatch);
          if (patch.length > 0) tool.result.patch = patch;
          if (typeof result.agentId === "string") tool.agentId = result.agentId;
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
        // The bar beneath the thread shows the model.
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

function hunks(value: unknown): Hunk[] {
  if (!Array.isArray(value)) return [];
  return value.filter((h): h is Hunk =>
    typeof h?.oldStart === "number" && typeof h.oldLines === "number" && typeof h.newStart === "number" &&
    typeof h.newLines === "number" && Array.isArray(h.lines) && h.lines.every((l: unknown) => typeof l === "string"));
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

/** A run of calls that only look (`LOOKS`), with the thinking between them: one "Explored" row. */
export type Explored = { kind: "explored"; steps: Array<ToolItem | AssistantItem> };

/**
 * A thread item as the view shows it: calls that only look fold with their neighbours into one `explored` row, and
 * every other call stays a row of its own.
 */
export type ShownItem = ThreadItem | Explored;

/** What each call that only looks counts as in an "Explored" row, and the input field that tells two of them apart. */
const LOOKS: Record<string, { one: string; many: string; key?: string }> = {
  Read: { one: "file", many: "files", key: "file_path" },
  NotebookRead: { one: "file", many: "files", key: "notebook_path" },
  LS: { one: "directory", many: "directories", key: "path" },
  Grep: { one: "search", many: "searches" },
  Glob: { one: "search", many: "searches" },
  ToolSearch: { one: "tool search", many: "tool searches" },
  WebFetch: { one: "page", many: "pages", key: "url" },
  WebSearch: { one: "web search", many: "web searches" },
};

export const isLook = (tool: ToolItem): boolean => Object.hasOwn(LOOKS, tool.name);

/** Messages that only keep the session's books: shown only with Raw. Any other message the thread does not know shows. */
const BOOKKEEPING: readonly string[] = ["command_lifecycle", "system:hook_started", "system:hook_response"];

/**
 * Folds each run of calls that only look into one `explored` item, with the thinking just before, between and just
 * after them (so a thought does not show as a row and then vanish into the run once the next look lands);
 * everything else stays as it is. Bookkeeping messages show only with `raw`.
 */
export function foldSteps(items: readonly ThreadItem[], raw = false): ShownItem[] {
  const shown: ShownItem[] = [];
  for (const item of items) {
    if (item.kind === "unknown" && !raw && BOOKKEEPING.includes(item.type)) continue;
    const thinking = item.kind === "assistant" && item.text === "";
    // Thinking whose text the API left out says nothing.
    if (thinking && (item.thinking ?? "") === "") continue;
    const last = shown.at(-1);
    if (item.kind === "tool" && isLook(item)) {
      if (last?.kind === "explored") last.steps.push(item);
      else if (last?.kind === "assistant" && last.text === "") shown[shown.length - 1] = { kind: "explored", steps: [last, item] };
      else shown.push({ kind: "explored", steps: [item] });
    } else if (thinking && last?.kind === "explored") {
      last.steps.push(item);
    } else {
      shown.push(item);
    }
  }
  return shown;
}

/** An "Explored" row's line: what its calls looked at, counted by kind ("3 files, 1 search"), a file read twice once. */
export function exploredLine(steps: Explored["steps"]): { text: string; running: boolean; failed: number } {
  const tools = steps.filter((s): s is ToolItem => s.kind === "tool");
  const groups = new Map<string, { one: string; many: string; seen: Set<string> }>();
  for (const t of tools) {
    const look = LOOKS[t.name]!;
    const value = look.key === undefined ? undefined : (t.input as Record<string, unknown> | null)?.[look.key];
    const group = groups.get(look.many) ?? { ...look, seen: new Set<string>() };
    group.seen.add(typeof value === "string" ? value : t.toolUseId);
    groups.set(look.many, group);
  }
  return {
    text: [...groups.values()].map((g) => `${g.seen.size} ${g.seen.size === 1 ? g.one : g.many}`).join(", "),
    running: tools.some((t) => t.result === undefined),
    failed: tools.filter((t) => t.result?.isError === true).length,
  };
}

/** The input field that says most about a call, for its one-line summary. */
export function toolSummary(input: unknown, max = 120): string {
  if (input === null || typeof input !== "object") return "";
  const fields = input as Record<string, unknown>;
  for (const key of ["command", "file_path", "notebook_path", "path", "pattern", "url", "query", "description", "prompt"]) {
    const value = fields[key];
    if (typeof value === "string") {
      const line = value.split("\n")[0]!;
      return line.length > max ? `${line.slice(0, max)}…` : line;
    }
  }
  return "";
}

/** What a row says a call acted on: a path relative to the session's directory, a pattern and where, a subagent's task. */
export function toolTarget(tool: ToolItem, cwd: string): string {
  const input = (tool.input ?? {}) as Record<string, unknown>;
  const field = (key: string) => typeof input[key] === "string" ? input[key] as string : undefined;
  const file = field("file_path") ?? field("notebook_path");
  if (file !== undefined) return relativePath(file, cwd);
  if (tool.name === "Agent" || tool.name === "Task") return field("description") ?? "";
  const pattern = field("pattern");
  const path = field("path");
  if (pattern !== undefined) return path === undefined ? pattern : `${pattern} in ${relativePath(path, cwd)}`;
  if (path !== undefined) return relativePath(path, cwd);
  return toolSummary(input);
}

/** Where a row's `<details>` keeps its open state across renders: a call's id; undefined for an item without one. */
export function keyOf(item: ShownItem): string | undefined {
  if (item.kind === "tool" || item.kind === "question") return item.toolUseId || undefined;
  if (item.kind === "explored") return item.steps.find((s): s is ToolItem => s.kind === "tool")?.toolUseId || undefined;
  return undefined;
}

/** A path under the session's working directory, relative to it; any other as it is. */
export function relativePath(path: string, cwd: string): string {
  return cwd !== "" && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
}

/** The working directory the session's latest `init` reported; "" when the events hold none. */
export function cwdOf(events: ReadonlyArray<{ message: unknown }>): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const m = events[i]!.message as Message | null;
    if (m?.type === "system" && m.subtype === "init" && typeof m.cwd === "string") return m.cwd;
  }
  return "";
}

/** Calls that change a file, shown with their diff. */
export const EDITS: readonly string[] = ["Edit", "MultiEdit", "Write", "NotebookEdit"];

export type DiffLine = { kind: "add" | "del" | "same"; text: string; line?: number } | { kind: "hunk"; text: string };

/**
 * What a call that changes a file changed: the hunks its result reported, numbered, else (still running, or a
 * result without them, such as a new file) its input's old lines removed and new lines added.
 */
export function editDiff(tool: ToolItem): { lines: DiffLine[]; added: number; removed: number } {
  const lines: DiffLine[] = [];
  const patch = tool.result?.patch ?? [];
  if (patch.length > 0) {
    for (const hunk of patch) {
      lines.push({ kind: "hunk", text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@` });
      let oldLine = hunk.oldStart;
      let newLine = hunk.newStart;
      for (const l of hunk.lines) {
        const text = l.slice(1);
        if (l.startsWith("-")) lines.push({ kind: "del", text, line: oldLine++ });
        else if (l.startsWith("+")) lines.push({ kind: "add", text, line: newLine++ });
        else if (l.startsWith(" ")) {
          lines.push({ kind: "same", text, line: newLine++ });
          oldLine++;
        }
      }
    }
  } else {
    const input = (tool.input ?? {}) as Record<string, unknown>;
    const edits = tool.name === "MultiEdit" && Array.isArray(input.edits) ? (input.edits as Array<Record<string, unknown>>) : [input];
    for (const edit of edits) {
      const old = edit.old_string;
      const next = edit.new_string ?? edit.content ?? edit.new_source;
      for (const text of textLines(old)) lines.push({ kind: "del", text });
      for (const text of textLines(next)) lines.push({ kind: "add", text });
    }
  }
  return {
    lines,
    added: lines.filter((l) => l.kind === "add").length,
    removed: lines.filter((l) => l.kind === "del").length,
  };
}

/** A text's lines, a final newline not counted as one more empty line. */
function textLines(text: unknown): string[] {
  if (typeof text !== "string" || text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** The exit code a failed command reported, from the start of its result. */
export function exitCode(tool: ToolItem): number | undefined {
  if (tool.result?.isError !== true) return undefined;
  const match = /^(?:Error: )?Exit code (\d+)/.exec(tool.result.text);
  return match === null ? undefined : Number(match[1]);
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
