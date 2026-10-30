import type { Database } from "bun:sqlite";
import {
  query,
  type CanUseTool,
  type PermissionDeniedHookInput,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { appendEvent } from "../store/events";
import type { Approvals } from "./approvals";
import { InputQueue } from "./input";
import { buildOptions, type EngineInput } from "./options";

/** meddle's own entries in a task's event log, interleaved with the SDK's messages. */
export type MeddleEvent =
  | { type: "meddle"; subtype: "turn_started"; at: string; resume: boolean }
  | { type: "meddle"; subtype: "turn_aborted"; at: string }
  | { type: "meddle"; subtype: "turn_failed"; error: string }
  | { type: "meddle"; subtype: "permission_denied_hook"; input: PermissionDeniedHookInput };

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

  const q = query({ prompt: queue, options: buildOptions({ ...input, prompt: queue, canUseTool, onPermissionDenied }) });
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

  const abort = (): never => {
    q.close();
    record({ type: "meddle", subtype: "turn_aborted", at: new Date().toISOString() });
    throw new DOMException("aborted", "AbortError");
  };

  try {
    for (;;) {
      let step: IteratorResult<SDKMessage> | "aborted" | "grace";
      try {
        step = await Promise.race([it.next(), aborted, ...(graceOver ? [graceOver] : [])]);
      } catch (err) {
        if (signal?.aborted) return abort();
        record({ type: "meddle", subtype: "turn_failed", error: String(err) });
        throw err;
      }
      if (step === "aborted") return abort();
      if (step === "grace") { q.close(); return result!; }
      if (step.done) break;
      const m = step.value;
      record(m);
      if (m.type === "result" && result === undefined) {
        result = m;
        queue.end();
        graceOver = new Promise((resolve) => { graceTimer = setTimeout(() => resolve("grace"), EXIT_GRACE_MS); });
      }
    }
    if (result !== undefined) return result;
    const error = "turn ended without a result";
    record({ type: "meddle", subtype: "turn_failed", error });
    throw new Error(error);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    clearTimeout(graceTimer);
    queue.end();
  }
}
