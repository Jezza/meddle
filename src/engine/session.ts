import type { Database } from "bun:sqlite";
import {
  query,
  type CanUseTool,
  type PermissionDeniedHookInput,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { appendEvent } from "../store/events";
import type { Approvals } from "./approvals";
import { InputQueue } from "./input";
import { buildOptions, type EngineInput } from "./options";

/** meddle's own entries in a task's event log, interleaved with the SDK's messages. */
export type MeddleEvent =
  | { type: "meddle"; subtype: "turn_started"; at: string; resume: boolean }
  | { type: "meddle"; subtype: "turn_aborted"; at: string }
  | { type: "meddle"; subtype: "turn_failed"; at: string; error: string }
  | { type: "meddle"; subtype: "permission_denied_hook"; input: PermissionDeniedHookInput };

/**
 * The event meddle records for a prompt or steer it sends: Claude Code does not echo the user's text back, so the
 * log would otherwise hold none. It has no `uuid`, unlike the SDK's own messages.
 */
export function promptEvent(text: string): SDKUserMessage {
  return { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
}

/** How long the child may outlive its `result` (stdin closed) before it is closed for it. */
const EXIT_GRACE_MS = 5_000;

export type RunTurnArgs = {
  input: Omit<EngineInput, "prompt" | "canUseTool" | "onPermissionDenied">;
  prompt: string;
  db: Database;
  approvals: Approvals;
  queue?: InputQueue;
  signal?: AbortSignal;
  /** Called after each appended event, meddle's own included, in seq order. */
  onMessage?: (m: SDKMessage | MeddleEvent, seq: number) => void;
};

/**
 * Starts one Claude Code turn and returns its handle at once. `done` records every message, and
 * resolves with the `result` once the child has gone (so a later `resume` never races it).
 */
export function runTurn(args: RunTurnArgs): { query: Query; done: Promise<SDKResultMessage> } {
  const { input } = args;
  const taskId = input.manifest.id;
  const record = recorder(args);
  const queue = args.queue ?? new InputQueue();
  queue.push(args.prompt);
  record({ type: "meddle", subtype: "turn_started", at: new Date().toISOString(), resume: input.resume });
  record(promptEvent(args.prompt));

  const canUseTool: CanUseTool = (toolName, toolInput, options) => args.approvals.ask({
    requestId: options.requestId,
    taskId,
    toolName,
    input: toolInput,
    toolUseId: options.toolUseID,
    ...(options.decisionReason !== undefined ? { decisionReason: options.decisionReason } : {}),
  }, options.signal);
  const onPermissionDenied = (hookInput: PermissionDeniedHookInput) => {
    record({ type: "meddle", subtype: "permission_denied_hook", input: hookInput });
  };

  let q: Query;
  try {
    q = query({ prompt: queue, options: buildOptions({ ...input, prompt: queue, canUseTool, onPermissionDenied }) });
  } catch (err) {
    queue.end();
    bestEffort(() => record(turnFailed(String(err))));
    throw err;
  }
  return { query: q, done: drive(q, queue, args.signal, record) };
}

/** Appends an event to the task's log, then tells `onMessage`. */
function recorder(args: RunTurnArgs): (m: SDKMessage | MeddleEvent) => void {
  return (m) => {
    const seq = appendEvent(args.db, args.input.manifest.id, m);
    args.onMessage?.(m, seq);
  };
}

async function drive(
  q: Query,
  queue: InputQueue,
  signal: AbortSignal | undefined,
  record: (m: SDKMessage | MeddleEvent) => void,
): Promise<SDKResultMessage> {
  const it = q[Symbol.asyncIterator]();

  let onAbort = () => {};
  const aborted = new Promise<"aborted">((resolve) => {
    onAbort = () => resolve("aborted");
    if (signal?.aborted) resolve("aborted");
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let graceOver: Promise<"grace"> | undefined;
  let result: SDKResultMessage | undefined;
  let ended = false; // the iterator finished on its own: the child has gone
  let closed = false;
  let logged = false; // a turn_aborted or turn_failed is in the log
  const close = () => { if (!closed) { closed = true; q.close(); } };

  try {
    for (;;) {
      let step: IteratorResult<SDKMessage> | "aborted" | "grace";
      try {
        step = await Promise.race([it.next(), aborted, ...(graceOver ? [graceOver] : [])]);
      } catch (err) {
        if (result !== undefined) return result; // shutdown noise after the result
        if (!signal?.aborted) throw err;
        step = "aborted";
      }
      if (step === "aborted") {
        close();
        if (result !== undefined) return result;
        logged = true;
        bestEffort(() => record({ type: "meddle", subtype: "turn_aborted", at: new Date().toISOString() }));
        throw new DOMException("aborted", "AbortError");
      }
      if (step === "grace") return result!;
      if (step.done) { ended = true; break; }
      const m = step.value;
      record(m);
      if (m.type === "result" && result === undefined) {
        result = m;
        queue.end();
        graceOver = new Promise((resolve) => { graceTimer = setTimeout(() => resolve("grace"), EXIT_GRACE_MS); });
      }
    }
    if (result !== undefined) return result;
    logged = true;
    const error = "turn ended without a result";
    bestEffort(() => record(turnFailed(error)));
    throw new Error(error);
  } catch (err) {
    if (!ended) close();
    if (!logged) bestEffort(() => record(turnFailed(String(err))));
    throw err;
  } finally {
    if (!ended) close();
    signal?.removeEventListener("abort", onAbort);
    clearTimeout(graceTimer);
    queue.end();
  }
}

function turnFailed(error: string): MeddleEvent {
  return { type: "meddle", subtype: "turn_failed", at: new Date().toISOString(), error };
}

/** Runs `f`, ignoring a throw: used for the closing entry of a turn that is already failing. */
function bestEffort(f: () => void): void {
  try { f(); } catch { /* the turn's own error is the one reported */ }
}
