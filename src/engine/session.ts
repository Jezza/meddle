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
import type { Attachment, Prompt } from "../blobs/attachment";
import type { UserContent } from "../blobs/content";
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
 * Code does not echo the user's text back, so the log would otherwise hold none. Its content is the prompt's text as
 * written, whatever Claude Code was sent in its place; the prompt's attachments go beside it as refs, when it has any,
 * and never as bytes.
 */
export function promptEvent(prompt: Prompt, uuid?: string): SDKUserMessage & { attachments?: Attachment[] } {
  return {
    type: "user",
    message: { role: "user", content: prompt.text },
    parent_tool_use_id: null,
    ...(uuid !== undefined ? { uuid: uuid as SDKUserMessage["uuid"] } : {}),
    ...(prompt.attachments.length > 0 ? { attachments: prompt.attachments } : {}),
  };
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
 * steers Claude Code has not taken, or after which the last background task ended, waits for Claude Code to go on
 * before the turn ends without it.
 */
const EXIT_GRACE_MS = 5_000;

export type RunTurnArgs = {
  input: Omit<EngineInput, "prompt" | "canUseTool" | "onPermissionDenied">;
  prompt: Prompt;
  /** What Claude Code is sent for `prompt`; its text when not given. */
  content?: UserContent;
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
 * resolves with the `result` once the child has gone (so a later `resume` never races it). The turn's own prompt is
 * logged as written, with its attachments' refs, and Claude Code is sent `content` for it.
 *
 * Prompts pushed into `queue` while the turn runs steer it: each is logged (`promptEvent`, with its uuid) when Claude
 * Code takes it, which it does into the running turn or, after that turn's `result`, as a turn of its own (an `init`,
 * then its own `result`). That is still this turn: it ends at a `result` once no steer is left untaken. A steer Claude
 * Code has not taken `EXIT_GRACE_MS` after a `result` stays untaken in `queue` when the turn ends, unlogged.
 *
 * Background work Claude Code says is live (`background_tasks_changed`) at a `result` keeps the turn going too, the
 * child and its input open, with no grace: when it ends Claude Code wakes for it in a turn of its own (an `init`, then
 * its own `result`), which this turn ends with. Closing the child at that `result` would kill the work unseen.
 *
 * A `result` while Claude Code holds the prompt queued (a `command_lifecycle` that queued it and has not started it) is
 * not the turn's: a resumed session gives one, empty, for the work its last process left before it starts the prompt.
 *
 * `sendNow` does what Claude Code's own "send now" key does: every steer it has not taken goes now, in order, into
 * the running turn when Claude Code can fit them in, or else it cuts the turn short and runs them next. A steer pushed
 * just before is among them. Answers what Claude Code says it did; rejects for a Claude Code that does not offer it.
 */
export function runTurn(args: RunTurnArgs): {
  query: Query;
  done: Promise<SDKResultMessage>;
  sendNow: () => Promise<SendNowOutcome | undefined>;
  takeBack: () => Promise<Prompt[]>;
} {
  const { input } = args;
  const taskId = input.manifest.id;
  const record = recorder(args);
  const queue = args.queue ?? new InputQueue();
  const uuid = queue.push(args.prompt, "next", args.content);
  queue.take(uuid);
  record({ type: "meddle", subtype: "turn_started", at: new Date().toISOString(), resume: input.resume });
  record(promptEvent(args.prompt, uuid));

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
  let capabilities: string[] | undefined; // what the turn's `init` says this Claude Code takes
  const watch = (m: SDKMessage) => {
    if (m.type === "system" && m.subtype === "init") capabilities = m.capabilities ?? [];
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
  const ending: Ending = { recheck: () => {} };
  const done = drive(q, queue, uuid, args.signal, record, watch, ending).then(
    (result) => { tell(); return result; },
    (err: unknown) => {
      if (!(err instanceof DOMException && err.name === "AbortError")) tell();
      throw err;
    },
  );
  const sendNow = async (): Promise<SendNowOutcome | undefined> => {
    if (capabilities !== undefined && !capabilities.includes(SEND_NOW)) throw new Error("this Claude Code cannot send now");
    // Claude Code sends only what it has read: the steers pushed so far go to it first.
    await queue.written();
    const reply = await (q as unknown as ControlRequests).request({ subtype: "interrupt", send_now: true });
    return reply.response?.send_now;
  };
  const takeBack = async (): Promise<Prompt[]> => {
    const back: Prompt[] = [];
    for (const { uuid, prompt } of queue.untaken()) {
      const dropped = queue.drop(uuid);
      if (dropped === "dropped") back.push(prompt);
      if (dropped !== "written") continue;
      // Claude Code can give back only what it has read: the steers pushed so far go to it first.
      await queue.written();
      const reply = await (q as unknown as ControlRequests).request({ subtype: "cancel_async_message", message_uuid: uuid }).catch(() => undefined);
      // Not cancelled: Claude Code took it meanwhile (it is logged as taken), or cannot give it back.
      if (reply?.response?.cancelled === true && queue.take(uuid) !== null) back.push(prompt);
    }
    ending.recheck();
    return back;
  };
  return { query: q, done, sendNow, takeBack };
}

/** What Claude Code says a send now did: put what waits into the running turn, cut the turn for it, or found nothing. */
export type SendNowOutcome = "delivering" | "stopped" | "nothing_waiting";

/** The capability an `init` lists when Claude Code takes an `interrupt` with `send_now`. */
const SEND_NOW = "interrupt_send_now_v1";

/**
 * How the SDK's Query sends a control request, which its types leave out: `interrupt()` cannot ask for `send_now`, and
 * there is no method for `cancel_async_message` (Claude Code answers `cancelled: true` only when it dropped the message
 * from its queue). meddle pins the SDK and the Claude Code it carries (package.json), so both work as read here.
 */
type ControlRequests = {
  request(request: { subtype: "interrupt"; send_now: true }): Promise<{ response?: { send_now?: SendNowOutcome } }>;
  request(request: { subtype: "cancel_async_message"; message_uuid: string }): Promise<{ response?: { cancelled?: boolean } }>;
};

/** Set by `drive`: ends the input when the turn has its `result` and nothing is left to keep it open (a take-back). */
type Ending = { recheck: () => void };

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
  prompt: string,
  signal: AbortSignal | undefined,
  record: (m: SDKMessage | MeddleEvent) => void,
  watch: (m: SDKMessage) => void,
  ending: Ending,
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
  let background = 0; // live background tasks, from the latest `background_tasks_changed`
  let promptQueued = false; // Claude Code says it queued the prompt and has not started it
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
  /** With the `result` in, every steer taken (or taken back) and no background work, the input closes: the child goes. */
  const endIfDone = (): boolean => {
    if (result === undefined || queue.untaken().length > 0 || background > 0) return false;
    queue.end();
    return true;
  };
  // A take-back can leave a finished turn with nothing to wait for. A steer Claude Code read after the `result` keeps
  // the SDK from closing its input (it waits for that steer's turn, which a cancelled one never gets), so the turn ends
  // now, as when the grace is over.
  let cutShort = () => {};
  const takenBackAll = new Promise<"grace">((resolve) => { cutShort = () => resolve("grace"); });
  ending.recheck = () => { if (endIfDone()) cutShort(); };
  /** After a `result`, the grace runs while no background work is live. */
  const settle = () => {
    if (result === undefined) return;
    if (background > 0) {
      clearTimeout(graceTimer);
      graceOver = undefined;
    } else {
      graceOver ??= new Promise((resolve) => { graceTimer = setTimeout(() => resolve("grace"), EXIT_GRACE_MS); });
    }
  };

  try {
    for (;;) {
      let step: IteratorResult<SDKMessage> | "aborted" | "grace";
      try {
        step = await Promise.race([it.next(), aborted, takenBackAll, ...(graceOver ? [graceOver] : [])]);
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
      if (queuedBy(m) === prompt) promptQueued = true;
      // A steer is logged as Claude Code takes it, ahead of the message that says so.
      for (const uuid of takenBy(m)) {
        if (uuid === prompt) promptQueued = false;
        const taken = queue.take(uuid);
        if (taken === null) continue;
        record(promptEvent(taken, uuid));
        goOn();
      }
      record(m);
      watch(m);
      // A turn Claude Code starts after a `result`: a steer's own, should Claude Code not say it took the steer, or its
      // wake for background work that ended.
      if (m.type === "system" && m.subtype === "init") goOn();
      else if (m.type === "system" && m.subtype === "background_tasks_changed") {
        background = m.tasks.filter((t) => t.ambient !== true).length;
        settle();
      } else if (m.type === "result" && result === undefined && !promptQueued) {
        result = m;
        // With every steer taken and no background work the input closes, so the child goes. An untaken steer keeps it
        // open for Claude Code, and so does background work, which Claude Code wakes for when it ends: then the input
        // stays open after it too, until the `result` of that wake.
        endIfDone();
        settle();
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

/** The uuid of the user message `m` says Claude Code queued (a `command_lifecycle` that queued it), if any. */
function queuedBy(m: SDKMessage): string | undefined {
  const frame = m as { type: string; state?: unknown; command_uuid?: unknown };
  return frame.type === "command_lifecycle" && frame.state === "queued" && typeof frame.command_uuid === "string" ? frame.command_uuid : undefined;
}

function turnFailed(error: string): MeddleEvent {
  return { type: "meddle", subtype: "turn_failed", at: new Date().toISOString(), error };
}

/** Runs `f`, ignoring a throw: used for the closing entry of a turn that is already failing. */
function bestEffort(f: () => void): void {
  try { f(); } catch { /* the turn's own error is the one reported */ }
}
