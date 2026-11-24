// Claude Code's own `SendMessage` and `ListAgents`, taken over for meddle's tasks: a task anywhere in the pool is an
// agent to list and to message by its id, and meddle carries the message (`Messenger`).
import type { HookCallback, HookCallbackMatcher } from "@anthropic-ai/claude-agent-sdk";
import type { SendOutcome, TaskEntry } from "../tasks/messenger";
import { taskTarget } from "./task-target";

export { taskTarget } from "./task-target";

/** What the hooks of one task's turn reach meddle's messaging through. */
export type Messaging = {
  /** The task the turn is of. */
  selfId: string;
  directory(): Promise<TaskEntry[]>;
  /** Hands `text` to task `to` from this task's agent. */
  send(to: string, text: string): Promise<SendOutcome>;
};

/** The name a `SendMessage` to a task is sent to instead, which no session answers: meddle delivers it, not Claude Code. */
export const ROUTED = "meddle-routed-message";

/** The paragraph Claude Code's `ListAgents` says it found no one with, left out once meddle lists tasks. */
const NO_AGENTS = "No reachable agents";

/**
 * The hooks that route a `SendMessage` to a task through meddle and add the pool's tasks to `ListAgents`.
 * `PreToolUse` points a send to a task id at `ROUTED`, so Claude Code's own send finds no one and delivers nothing;
 * `PostToolUse` then sends it through `m` and answers what happened in place of Claude Code's result.
 */
export function messagingHooks(m: Messaging): { PreToolUse: HookCallbackMatcher[]; PostToolUse: HookCallbackMatcher[] } {
  /** The sends to tasks taken over, by tool use. */
  const routed = new Map<string, { to: string; message: string; notify: boolean }>();
  const pre: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse") return { continue: true };
    const args = (input.tool_input ?? {}) as Record<string, unknown>;
    const to = taskTarget(args.to);
    if (to === null) return { continue: true };
    routed.set(input.tool_use_id, {
      to, message: typeof args.message === "string" ? args.message : "", notify: args.notify_when_idle === true,
    });
    // Allowed here: auto mode refuses a call whose input a hook changed after its review, and this one only points
    // Claude Code's own send at no one (meddle delivers the message, to a task it frames as another session's).
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "meddle delivers messages to tasks",
        updatedInput: { ...args, to: ROUTED },
      },
    };
  };
  const post: HookCallback = async (input) => {
    if (input.hook_event_name !== "PostToolUse") return { continue: true };
    if (input.tool_name === "ListAgents") {
      const response = input.tool_response as { listing?: unknown } | null;
      if (typeof response?.listing !== "string") return { continue: true };
      const listing = listingWith(response.listing, await m.directory(), m.selfId);
      if (listing === response.listing) return { continue: true };
      return { continue: true, hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: { ...response, listing } } };
    }
    const call = routed.get(input.tool_use_id);
    if (call === undefined) return { continue: true };
    routed.delete(input.tool_use_id);
    const text = call.notify
      ? "Not sent: notify_when_idle is not available for tasks."
      : resultText(call.to, await m.send(call.to, call.message));
    const success = text.startsWith("Sent") || text.startsWith("Queued");
    return {
      continue: true,
      hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: { success, message: text, display: text } },
    };
  };
  return {
    PreToolUse: [{ matcher: "SendMessage", hooks: [pre] }],
    PostToolUse: [{ matcher: "SendMessage|ListAgents", hooks: [post] }],
  };
}

/** What the agent is told a send to task `to` did. */
function resultText(to: string, outcome: SendOutcome): string {
  if (!outcome.ok) return `Not sent: ${outcome.reason}.`;
  const named = `${outcome.title} (${to})`;
  if (outcome.how === "waking") return `Sent to ${named}; it was idle and starts a turn for it.`;
  if (outcome.how === "queued") return `Queued for ${named}; it gets it on its next turn.`;
  return `Sent to ${named}.`;
}

/**
 * Claude Code's `ListAgents` listing with a row for each of `entries` that is not task `selfId` and not named in it
 * already: its id (the address), title, node, and whether it is busy. Its "No reachable agents" paragraph goes once a
 * row is added; with none to add, the listing is as it was.
 */
export function listingWith(listing: string, entries: TaskEntry[], selfId: string): string {
  const rows = entries
    .filter((e) => e.id !== selfId && !listing.includes(e.id))
    .map((e) => `- ${e.id} — ${e.title} · ${e.nodeName} · ${e.state === "running" || e.state === "waiting" ? "busy" : "idle"}`);
  if (rows.length === 0) return listing;
  const kept = listing.split("\n\n").filter((p) => !p.startsWith(NO_AGENTS)).join("\n\n");
  return `${kept}\n\nMeddle tasks (message one by its id; an idle one starts a turn for it):\n${rows.join("\n")}`;
}
