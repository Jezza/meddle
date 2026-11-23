// The thread a task's event log renders as: pure, so it is tested without a DOM or a link.
import { type Attachment, attachmentProblem } from "../../blobs/attachment";
import { type AgentEntry, isProgress, type Live } from "../../state/contracts";
import type { DiffRow, Hunk } from "./diff-model";

export type ThreadItem =
  /**
   * `attachments`: the files the prompt carried (the refs meddle logged beside its text). `by: "meddle"`: the merge
   * train's prompt (a `train_turn`), not one of yours.
   */
  | { kind: "user"; text: string; attachments: Attachment[]; by?: "meddle" }
  | { kind: "assistant"; text: string; thinking?: string }
  | {
    kind: "tool";
    name: string;
    input: unknown;
    toolUseId: string;
    /** `patch`: the hunks a call that changed a file reported (`EDITS`); `original`: the file's lines before it. */
    result?: { text: string; isError: boolean; patch?: Hunk[]; original?: string[] };
    children: ThreadItem[];
    agentId?: string;
    /** A Skill call's skill: the text the session sends after the call's result, as a message of its own. */
    skill?: string;
    /** The call started a background task, so its result is a receipt, and it runs until `ended`. */
    background?: boolean;
    /** How its task ended, from its latest notice; a later `task_started` of the task clears it. */
    ended?: { status: string; text: string };
    /** An Agent call's reports, oldest first: the `message` of each `SubagentHandback` call in its run. */
    reports?: string[];
    /** On a `SendMessage` call that resumed an agent: the `toolUseId` of that agent's own row. */
    resumes?: string;
  }
  | { kind: "question"; toolUseId: string; questions: unknown }
  | { kind: "denied"; toolName: string; reason?: string; reasonType?: string }
  /** `at`: when the event was logged, for a turn's end (`result`). */
  | { kind: "status"; text: string; at?: string }
  | { kind: "unknown"; type: string; raw: unknown };

export type ToolItem = Extract<ThreadItem, { kind: "tool" }>;
type AssistantItem = Extract<ThreadItem, { kind: "assistant" }>;
type DeniedItem = Extract<ThreadItem, { kind: "denied" }>;
type Block = { type?: unknown; [key: string]: unknown };
type Message = { type?: unknown; subtype?: unknown; [key: string]: unknown };

/**
 * Builds the thread from events in seq order. Progress frames (`PROGRESS_KINDS`) are left out (the session's
 * `live` cell covers `stream_event`s), and so is a status that only says a request went out or the session went idle; an assistant message streamed as several events with one id becomes one item; a `tool_result` attaches
 * to its `tool_use`, and a skill's text to its Skill call; a message with a `parent_tool_use_id` nests under that call.
 * A `task_started` or `task_notification` marks the call it belongs to (`background`, `ended`) instead of being an
 * item, and a status line only when that call is at the top; an agent's `SubagentHandback` calls are its `reports`.
 */
export function buildThread(events: Array<{ seq: number; message: unknown; at?: string }>): ThreadItem[] {
  const top: ThreadItem[] = [];
  const tools = new Map<string, ToolItem>();
  /** Question tool uses: their results are the answers the question item already stands for. */
  const questions = new Set<string>();
  /** `SubagentHandback` tool uses: their results are the report the agent's `reports` already holds. */
  const handbacks = new Set<string>();
  /** The calls pushed onto `top`. */
  const topTools = new Set<string>();
  /** The row each task's notices mark, by task id: for an agent, the Agent call that first started it. */
  const rows = new Map<string, ToolItem>();
  const assistants = new Map<string, AssistantItem>();
  const denials = new Map<string, DeniedItem>();
  /** By the list they are in, Skill calls whose result has landed and whose skill's text has not, in call order. */
  const unsent = new Map<ThreadItem[], ToolItem[]>();

  /** Where a message with this parent goes: under its call when the call is known, else at the top. */
  const listFor = (parent: unknown): ThreadItem[] =>
    (typeof parent === "string" ? tools.get(parent)?.children : undefined) ?? top;

  for (const { message, at } of events) {
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
        top.push({ kind: "status", text: resultText(m), at });
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
    // A skill's text comes before Claude goes on: a call still without one (a skill run in a subagent) gets none.
    unsent.delete(list);
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
        const parent = typeof m.parent_tool_use_id === "string" ? tools.get(m.parent_tool_use_id) : undefined;
        const report = block.name === "SubagentHandback" && parent !== undefined && isAgentCall(parent)
          ? (block.input as { message?: unknown } | undefined)?.message
          : undefined;
        if (block.name === "AskUserQuestion") {
          questions.add(toolUseId);
          list.push({ kind: "question", toolUseId, questions: (block.input as { questions?: unknown } | undefined)?.questions });
        } else if (typeof report === "string") {
          // An agent's report is its row's, not a row of its own.
          handbacks.add(toolUseId);
          parent!.reports = [...(parent!.reports ?? []), report];
        } else {
          const tool: ToolItem = { kind: "tool", name: str(block.name), input: block.input, toolUseId, children: [] };
          tools.set(toolUseId, tool);
          list.push(tool);
          if (list === top) topTools.add(toolUseId);
        }
      } else if (block.type !== "redacted_thinking") {
        list.push({ kind: "unknown", type: `assistant:${String(block.type)}`, raw: block });
      }
    }
  }

  function addUser(m: Message, list: ThreadItem[]) {
    const content = (m.message as { content?: unknown } | undefined)?.content;
    const attachments = attachmentsOf(m.attachments);
    const texts: string[] = typeof content === "string" ? [content] : [];
    for (const block of blocks(content)) {
      if (block.type === "tool_result") {
        const id = str(block.tool_use_id);
        const tool = tools.get(id);
        if (tool !== undefined) {
          const result = (m.tool_use_result ?? {}) as { agentId?: unknown; structuredPatch?: unknown; originalFile?: unknown };
          tool.result = { text: contentText(block.content), isError: block.is_error === true };
          const patch = hunks(result.structuredPatch);
          if (patch.length > 0) tool.result.patch = patch;
          if (typeof result.originalFile === "string") tool.result.original = textLines(result.originalFile);
          if (typeof result.agentId === "string") tool.agentId = result.agentId;
          if (tool.name === "Skill" && !tool.result.isError) unsent.set(list, [...(unsent.get(list) ?? []), tool]);
        } else if (!questions.has(id) && !handbacks.has(id)) {
          list.push({ kind: "unknown", type: "tool_result", raw: block });
        }
      } else if (block.type === "text") {
        texts.push(str(block.text));
      } else {
        texts.push(`[${String(block.type)}]`);
      }
    }
    if (texts.length === 0) return;
    // The session sends a skill's text as though you had, marked synthetic.
    const skill = m.isSynthetic === true ? unsent.get(list)?.shift() : undefined;
    if (skill !== undefined) skill.skill = texts.join("\n");
    else list.push({ kind: "user", text: texts.join("\n"), attachments });
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
      case "task_started":
        addTaskStarted(m);
        return;
      case "task_notification":
        addTaskNotification(m);
        return;
      case "init":
        // The bar beneath the thread shows the model.
        return;
      default:
        top.push(unknown(m));
    }
  }

  /**
   * A task's start marks the call it belongs to: an agent's, the Agent call that first started it (a follow-up's
   * carries the `SendMessage` call's id, and that call is marked to lead to the agent's row); any other task's, the
   * call that started it. A start with no such call is left as an unknown message. A resumed agent (a follow-up or a
   * wake) is always registered in the background, whatever its start says.
   */
  function addTaskStarted(m: Message) {
    const taskId = str(m.task_id);
    const named = tools.get(str(m.tool_use_id));
    const resumed = m.task_type === "local_agent" && rows.has(taskId);
    const row = m.task_type === "local_agent" ? rows.get(taskId) ?? named : named;
    if (row === undefined) {
      top.push(unknown(m));
      return;
    }
    if (taskId !== "") rows.set(taskId, row);
    startTask(row, resumed || m.is_backgrounded === true);
    if (named !== undefined && named !== row) {
      named.resumes = row.toolUseId;
      startTask(named, true);
    }
  }

  /**
   * A task's notice ends the call it belongs to, and the call it names when that is another (a follow-up's
   * `SendMessage`). The thread keeps a status line for a call at the top, since the notice may be why Claude picks up
   * again; a notice with no call to mark is a status line as it comes.
   */
  function addTaskNotification(m: Message) {
    // A summary may already say how the task ended ("… completed (exit code 0)"), or only what it was.
    const summary = str(m.summary);
    const status = str(m.status);
    const text = summary === "" ? `Task ${status}` : status === "" || summary.includes(status) ? summary : `${summary} (${status})`;
    const named = tools.get(str(m.tool_use_id));
    const row = rows.get(str(m.task_id)) ?? named;
    if (row === undefined) {
      top.push({ kind: "status", text });
      return;
    }
    row.ended = { status, text: summary };
    if (named !== undefined) named.ended = row.ended;
    if (!topTools.has(row.toolUseId)) return;
    if (!isAgentCall(row)) {
      top.push({ kind: "status", text });
    } else {
      const label = `Agent "${str((row.input as { description?: unknown } | null)?.description)}"`;
      top.push({
        kind: "status",
        text: summary.startsWith(NOT_REPORTED) ? `${label} is waiting on its own commands` : `${label} ${AGENT_ENDS[status] ?? (status || "ended")}`,
      });
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
      case "train_turn":
        // The train's prompt starts the turn as yours would, marked as meddle's.
        top.push({ kind: "user", text: str(m.text), attachments: [], by: "meddle" });
        return;
      case "train_decline":
        top.push({ kind: "status", text: `Declined: ${str(m.reason)}` });
        return;
      case "train_blame":
        top.push({ kind: "status", text: `Blamed ${str(m.task)}: ${str(m.reason)}` });
        return;
      case "train_left":
        top.push({ kind: "status", text: `Left meddle's train: ${str(m.reason)}` });
        return;
      case "landed":
        top.push({ kind: "status", text: `Landed on ${str(m.branch)} at ${str(m.commit).slice(0, 12)}` });
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

/** A call's task has (re)started: it runs until its notice if the task is in the background. */
function startTask(tool: ToolItem, background: boolean) {
  if (background) tool.background = true;
  else delete tool.background;
  delete tool.ended;
}

/** Whether a call starts a subagent: `Agent`, or `Task` as older Claude Code names it. */
export const isAgentCall = (tool: ToolItem): boolean => tool.name === "Agent" || tool.name === "Task";
const isBackgroundAgent = (item: ThreadItem): item is ToolItem => item.kind === "tool" && isAgentCall(item) && item.background === true;

/** How an agent's status line says its notice's `status`. */
const AGENT_ENDS: Record<string, string> = { completed: "finished", stopped: "stopped", failed: "failed" };

/** What the summary of an agent's notice starts with when it has ended its turn to wait on its own background commands. */
const NOT_REPORTED = "This agent has not reported yet";

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

/** A logged prompt's attachments: each valid one as its four fields; none when the event has none. */
function attachmentsOf(value: unknown): Attachment[] {
  if (!Array.isArray(value)) return [];
  return value.filter((a) => attachmentProblem(a) === null).map(({ hash, name, type, size }: Attachment) => ({ hash, name, type, size }));
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

/**
 * Folds each run of calls that only look into one `explored` item, with the thinking just before, between and just
 * after them (so a thought does not show as a row and then vanish into the run once the next look lands);
 * everything else stays as it is. Messages the thread does not know show only with `raw`.
 */
export function foldSteps(items: readonly ThreadItem[], raw = false): ShownItem[] {
  const shown: ShownItem[] = [];
  for (const item of items) {
    if (item.kind === "unknown" && !raw) continue;
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

/**
 * What a row says a call acted on: a path relative to the session's directory, a pattern and where, a subagent's task,
 * a skill.
 */
export function toolTarget(tool: ToolItem, cwd: string): string {
  const input = (tool.input ?? {}) as Record<string, unknown>;
  const field = (key: string) => typeof input[key] === "string" ? input[key] as string : undefined;
  const file = field("file_path") ?? field("notebook_path");
  if (file !== undefined) return relativePath(file, cwd);
  if (isAgentCall(tool)) return field("description") ?? "";
  if (tool.name === "Skill") return field("skill") ?? "";
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

/** Whether the events hold the call `toolUseId` (the `tool_use` its row is built from). */
export function holdsCall(events: ReadonlyArray<{ message: unknown }>, toolUseId: string): boolean {
  return events.some(({ message }) => callsOf(message).includes(toolUseId));
}

/**
 * The calls the events refer to that none of them holds (`holdsCall`), in the order first referred to: the call an
 * agent's message belongs under (`parent_tool_use_id`), and the call a task's start or notice marks. Until it is in,
 * what refers to it lands at the top of the thread.
 */
export function missingCalls(events: ReadonlyArray<{ message: unknown }>): string[] {
  const held = new Set(events.flatMap(({ message }) => callsOf(message)));
  const missing = new Set<string>();
  for (const { message } of events) {
    const m = message as Message | null;
    const call = m?.type === "assistant" || m?.type === "user" ? m.parent_tool_use_id
      : m?.type === "system" && (m.subtype === "task_started" || m.subtype === "task_notification") ? m.tool_use_id
      : undefined;
    if (typeof call === "string" && call !== "" && !held.has(call)) missing.add(call);
  }
  return [...missing];
}

/** The calls a message holds: an assistant message's `tool_use` blocks, an agent's own among them. */
function callsOf(message: unknown): string[] {
  const m = message as Message | null;
  if (m?.type !== "assistant") return [];
  return blocks((m.message as { content?: unknown } | undefined)?.content).flatMap((b) => b.type === "tool_use" && typeof b.id === "string" ? [b.id] : []);
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

/**
 * What a call that changes a file changed: the hunks its result reported, else (still running, or a result without
 * them, such as a new file) a `fallback` of its input's old lines removed and new lines added, a Write's numbered
 * from 1 as the whole new file. `added`/`removed` count the hunks' lines, else the fallback's.
 */
export function editDiff(tool: ToolItem): { hunks: Hunk[]; fallback: DiffRow[]; added: number; removed: number } {
  const hunks = tool.result?.patch ?? [];
  if (hunks.length > 0) {
    const lines = hunks.flatMap((h) => h.lines);
    return {
      hunks,
      fallback: [],
      added: lines.filter((l) => l.startsWith("+")).length,
      removed: lines.filter((l) => l.startsWith("-")).length,
    };
  }
  const fallback: DiffRow[] = [];
  const input = (tool.input ?? {}) as Record<string, unknown>;
  if (tool.name === "Write") {
    textLines(input.content).forEach((text, i) => fallback.push({ kind: "add", text, new: i + 1 }));
  } else {
    const edits = tool.name === "MultiEdit" && Array.isArray(input.edits) ? (input.edits as Array<Record<string, unknown>>) : [input];
    for (const edit of edits) {
      const old = edit.old_string;
      const next = edit.new_string ?? edit.content ?? edit.new_source;
      for (const text of textLines(old)) fallback.push({ kind: "del", text });
      for (const text of textLines(next)) fallback.push({ kind: "add", text });
    }
  }
  return {
    hunks,
    fallback,
    added: fallback.filter((l) => l.kind === "add").length,
    removed: fallback.filter((l) => l.kind === "del").length,
  };
}

/**
 * Where a landed change's file can be read from when its result left the original out (a file too large for the
 * log): the call's absolute `file_path`, read now from the task's workspace as the new side. Null when the result
 * carries the original, has no hunks, or the call names no absolute path.
 */
export function workspaceSource(tool: ToolItem): { path: string } | null {
  const result = tool.result;
  if (result === undefined || result.original !== undefined || (result.patch ?? []).length === 0) return null;
  const path = ((tool.input ?? {}) as Record<string, unknown>).file_path;
  return typeof path === "string" && path.startsWith("/") ? { path } : null;
}

/** A text's lines, a final newline not counted as one more empty line. */
export function textLines(text: unknown): string[] {
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

/** Whether a call is still going: a background one until its notice, any other until its result. */
export function isRunning(tool: ToolItem): boolean {
  return tool.background === true ? tool.ended === undefined : tool.result === undefined;
}

/**
 * Whether a call's row runs. An agent's call runs as the agent list says (`entry`, the agent's state there), whatever
 * holds its row: a wake or a follow-up runs it again after its notice. Any other call, or an agent's with no entry (an
 * older node), runs as it does itself (`own`, `isRunning`) while what holds its row runs (`agentRuns`): the agent whose
 * row holds it, or at the top the task's turn. Nothing runs on once its process is gone, whether or not its notice came.
 */
export function callRuns(entry: AgentEntry["state"] | undefined, own: boolean, agentRuns: boolean): boolean {
  return entry !== undefined ? entry === "running" : own && agentRuns;
}

/**
 * What a stopped or failed agent's row says first: that it failed, with its notice's text when there is one, or that it
 * stopped before it reported, and that the session ended when it went with its process (`orphaned`).
 */
export function agentEndNote(failed: boolean, orphaned: boolean, notice: string | undefined): string {
  if (failed) return notice === undefined || notice === "" ? "Failed" : `Failed: ${notice}`;
  return orphaned ? "Stopped before it reported: the session ended" : "Stopped before it reported";
}

/**
 * What a background call's row says in its meta: null for any other call; "background" while it runs, or "stopped"
 * when what holds its row has finished (`agentRuns` false: the agent it ran in, or at the top the task's turn) and its
 * notice never came; once it has ended, "ended" for a `Monitor` watcher, else the exit code its notice gave
 * ("exit 0"), else the notice's status.
 */
export function backgroundMeta(tool: ToolItem, agentRuns = true): string | null {
  if (tool.background !== true) return null;
  if (tool.ended === undefined) return agentRuns ? "background" : "stopped";
  if (tool.name === "Monitor") return "ended";
  const code = /exit code (\d+)/.exec(tool.ended.text);
  return code === null ? tool.ended.status : `exit ${code[1]}`;
}

/**
 * What a running turn is doing, for the line under it: the content block streaming (a thinking block says so even
 * when the API leaves its text out), else the call still running (into a subagent's own calls). With no call of the
 * session's own running, it is waiting on its background agents: `agentsRunning` of them, or (an older node serves no
 * count) the thread's own running background Agent calls.
 */
export function activity(live: Live, items: readonly ThreadItem[], agentsRunning = 0): string {
  if (live !== null) {
    if (live.block === "tool_use" || live.block === "server_tool_use") {
      return live.tool !== undefined ? `Writing a ${live.tool} call` : "Writing a tool call";
    }
    if (live.block === "thinking" || live.block === "redacted_thinking") return "Thinking";
    if (live.block === "text" || live.text !== "") return "Writing";
    return "Thinking";
  }
  const names: string[] = [];
  // At the top, a background agent working is not a call of the session's own running.
  for (let list = items, depth = 0; ; depth++) {
    const tool = list.findLast((i): i is ToolItem => i.kind === "tool" && isRunning(i) && (depth > 0 || !isBackgroundAgent(i)));
    if (tool === undefined) break;
    names.push(tool.name);
    list = tool.children;
  }
  if (names.length > 0) return `Running ${names.join(" › ")}`;
  const agents = agentsRunning > 0 ? agentsRunning : items.filter((i) => isBackgroundAgent(i) && isRunning(i)).length;
  return agents > 0 ? `Waiting on ${agents} ${agents === 1 ? "agent" : "agents"}` : "Working";
}

/** Seconds as the activity line says them: `12s`, `3m 4s`. */
export function duration(seconds: number): string {
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/**
 * The activity line for what a turn is doing (`activity`), `phase` seconds into it and `quiet` seconds since
 * anything last streamed or landed. Thinking says so longer as it runs on, and is never stalled (its text may not
 * stream at all), nor is a running call or a wait on agents; anything else stalls from 10 s of quiet, fully at 20 s
 * (`stall` 0 to 1).
 */
export function activityLine(doing: string, phase: number, quiet: number): { text: string; stall: number } {
  if (doing === "Thinking") {
    const text = phase < 10 ? "Thinking" : phase < 20 ? "Still thinking" : phase < 30 ? "Thinking more" : phase < 45 ? "Thinking some more" : "Deep in thought";
    return { text, stall: 0 };
  }
  if (doing.startsWith("Running ") || doing.startsWith("Waiting on ")) return { text: doing, stall: 0 };
  return { text: doing, stall: Math.min(1, Math.max(0, (quiet - 10) / 10)) };
}
