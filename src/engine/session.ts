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
  | { type: "meddle"; subtype: "permission_denied_hook"; input: PermissionDeniedHookInput }
  /**
   * The turn's login failed it (`fault`), or no token was usable (`kind: "none"`, no token named): appended once the
   * turn has settled with an error. `rerun` says whether the turn runs again with the next token; `retried` that it did
   * not because it already had once, though another token is usable now.
   */
  | {
    type: "meddle";
    subtype: "token_fault";
    at: string;
    tokenId: string | null;
    label: string | null;
    fault: TokenFault | { kind: "none" };
    rerun: boolean;
    retried?: true;
  };

/**
 * What a `token_fault` that ended a turn says, for a notification or the CLI: `no usable token`, or the token, what
 * happened to it, and whether another login is left (`retried`: one is, send the message again to use it).
 */
export function tokenFaultNotice(e: { readonly [key: string]: unknown }): string {
  const fault = (e.fault ?? {}) as { kind?: unknown; until?: unknown; reason?: unknown };
  if (fault.kind === "none") return "no usable token";
  const name = typeof e.label === "string" ? e.label : "?";
  const what = fault.kind === "disabled"
    ? `disabled: ${String(fault.reason)}`
    : `exhausted${typeof fault.until === "string" ? ` until ${fault.until}` : ""}`;
  const rest = e.retried === true ? "already switched login once, send the message again to use the next token" : "no other token";
  return `token ${name} ${what}; ${rest}`;
}

/**
 * What a turn's messages say about the login it ran with: it hit a usage limit (`exhausted`, usable again `until`, an
 * ISO time when the SDK said, and the limit's `type`), or the login itself is refused (`disabled`, with the SDK's error).
 */
export type TokenFault =
  | { kind: "exhausted"; until: string | null; type: string | null }
  | { kind: "disabled"; reason: string };

/** Assistant errors that say the login cannot be used at all, rather than that it is out of quota for now. */
const DISABLING_ERRORS: readonly string[] = [
  "billing_error", "account_on_hold", "authentication_failed", "oauth_org_not_allowed", "verification_required",
];

/**
 * The token fault one SDK message reports, or null: a `rate_limit_event` whose `status` is `rejected` (its
 * `overageStatus` says nothing about the login and is ignored), an assistant message whose `error` is `rate_limit`, or
 * one whose `error` is a login-class error. `resetsAt` is unix seconds as recorded, milliseconds when it is that large.
 */
export function tokenFaultOf(m: SDKMessage): TokenFault | null {
  if (m.type === "rate_limit_event") {
    const info = m.rate_limit_info as { status?: unknown; resetsAt?: unknown; rateLimitType?: unknown } | undefined;
    if (info?.status !== "rejected") return null;
    const resets = typeof info.resetsAt === "number" && Number.isFinite(info.resetsAt) && info.resetsAt > 0
      ? (info.resetsAt < 1e12 ? info.resetsAt * 1000 : info.resetsAt)
      : null;
    const until = resets === null || Number.isNaN(new Date(resets).getTime()) ? null : new Date(resets).toISOString();
    return { kind: "exhausted", until, type: typeof info.rateLimitType === "string" ? info.rateLimitType : null };
  }
  if (m.type === "assistant") {
    const error = (m as { error?: unknown }).error;
    if (error === "rate_limit") return { kind: "exhausted", until: null, type: null };
    if (typeof error === "string" && DISABLING_ERRORS.includes(error)) return { kind: "disabled", reason: error };
  }
  return null;
}

/**
 * Of two faults in one turn, the one that says more: `disabled` over `exhausted`, an `exhausted` with a time over one
 * without; else the first.
 */
function moreTelling(a: TokenFault | null, b: TokenFault): TokenFault {
  if (a === null) return b;
  if (a.kind === "disabled") return a;
  if (b.kind === "disabled") return b;
  return a.until === null && b.until !== null ? b : a;
}

/**
 * The event meddle records for a prompt or steer it sends, with the `uuid` it was sent with when it has one: Claude
 * Code does not echo the user's text back, so the log would otherwise hold none.
 */
export function promptEvent(text: string, uuid?: string): SDKUserMessage {
  return { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, ...(uuid !== undefined ? { uuid: uuid as SDKUserMessage["uuid"] } : {}) };
}

/**
 * What went wrong in a turn's `result`, or null when it succeeded: its subtype (`error_max_turns`, …), or `error`
 * for a `success` that Claude Code flagged `is_error`.
 */
export function resultError(m: { subtype?: unknown; is_error?: unknown }): string | null {
  if (m.subtype !== "success") return String(m.subtype);
  return m.is_error === true ? "error" : null;
}

/**
 * How long the child may outlive its `result` (stdin closed) before it is closed for it; and how long a `result` with
 * steers Claude Code has not taken waits for it to take one before the turn ends without them.
 */
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
  /**
   * Called at most once per turn, before `done` settles, when the turn's messages reported a token fault (the most
   * telling one, see `tokenFaultOf`); not for an aborted turn.
   */
  onTokenFault?: (fault: TokenFault) => void;
};

/**
 * Starts one Claude Code turn and returns its handle at once. `done` records every message, and
 * resolves with the `result` once the child has gone (so a later `resume` never races it).
 *
 * Texts pushed into `queue` while the turn runs steer it: each is logged (`promptEvent`, with its uuid) when Claude
 * Code takes it, which it does into the running turn or, after that turn's `result`, as a turn of its own (an `init`,
 * then its own `result`). That is still this turn: it ends at a `result` once no steer is left untaken. A steer Claude
 * Code has not taken `EXIT_GRACE_MS` after a `result` stays untaken in `queue` when the turn ends, unlogged.
 */
export function runTurn(args: RunTurnArgs): { query: Query; done: Promise<SDKResultMessage> } {
  const { input } = args;
  const taskId = input.manifest.id;
  const record = recorder(args);
  const queue = args.queue ?? new InputQueue();
  const prompt = queue.push(args.prompt);
  queue.take(prompt);
  record({ type: "meddle", subtype: "turn_started", at: new Date().toISOString(), resume: input.resume });
  record(promptEvent(args.prompt, prompt));

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
  let fault: TokenFault | null = null;
  const watch = (m: SDKMessage) => {
    const found = tokenFaultOf(m);
    if (found !== null) fault = moreTelling(fault, found);
  };
  /** Tells `onTokenFault` of the turn's fault, once, as `done` settles; a throw there never fails the turn. */
  const tell = () => {
    if (fault === null || args.onTokenFault === undefined) return;
    try {
      args.onTokenFault(fault);
    } catch (err) {
      console.error(`meddle: the token fault of task ${taskId}'s turn could not be handled:`, err);
    }
  };
  const done = drive(q, queue, args.signal, record, watch).then(
    (result) => { tell(); return result; },
    (err: unknown) => {
      if (!(err instanceof DOMException && err.name === "AbortError")) tell();
      throw err;
    },
  );
  return { query: q, done };
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
  watch: (m: SDKMessage) => void,
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
  /** Claude Code went on after the `result`: the turn ends with a later one. */
  const goOn = () => {
    if (result === undefined) return;
    result = undefined;
    clearTimeout(graceTimer);
    graceOver = undefined;
  };

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
      // A steer is logged as Claude Code takes it, ahead of the message that says so.
      for (const uuid of takenBy(m)) {
        const text = queue.take(uuid);
        if (text === null) continue;
        record(promptEvent(text, uuid));
        goOn();
      }
      record(m);
      watch(m);
      // A turn Claude Code starts after a `result` (a steer's own, should Claude Code not say it took the steer).
      if (m.type === "system" && m.subtype === "init") goOn();
      else if (m.type === "result" && result === undefined) {
        result = m;
        // With every steer taken the input closes, so the child goes; an untaken one keeps it open for Claude Code.
        if (queue.untaken().length === 0) queue.end();
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

/**
 * The uuids of the user messages `m` says Claude Code took: a `command_lifecycle` that started or completed one, and
 * the `user_message_uuids` its turn's messages list.
 */
function takenBy(m: SDKMessage): string[] {
  const frame = m as { type: string; state?: unknown; command_uuid?: unknown; user_message_uuids?: unknown };
  const taken: string[] = [];
  if (frame.type === "command_lifecycle" && (frame.state === "started" || frame.state === "completed") && typeof frame.command_uuid === "string") {
    taken.push(frame.command_uuid);
  }
  if (Array.isArray(frame.user_message_uuids)) taken.push(...frame.user_message_uuids.filter((u): u is string => typeof u === "string"));
  return taken;
}

function turnFailed(error: string): MeddleEvent {
  return { type: "meddle", subtype: "turn_failed", at: new Date().toISOString(), error };
}

/** Runs `f`, ignoring a throw: used for the closing entry of a turn that is already failing. */
function bestEffort(f: () => void): void {
  try { f(); } catch { /* the turn's own error is the one reported */ }
}
