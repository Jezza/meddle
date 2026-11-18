// The merge train's turns on a task: what kinds there are, the tools meddle gives them, and how one went.
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { resultError, tokenFaultNotice, type MeddleEvent } from "../engine/session";

/**
 * A train turn: a task's `describe` (fix its revisions' descriptions and conflicts before landing), `rebase` (onto a
 * branch that moved on), `fix` (a rebase turn opening with what the merge agent blamed it for); or the merge task's
 * `merge` (check a batch).
 */
export type TrainTurnKind = "describe" | "rebase" | "fix" | "merge";

/**
 * How a train turn went: it ended as asked (`done`), the task's agent called `decline`, the merge agent called `blame`,
 * or the turn did not end well (`failed`: an error result, a failure, an abort).
 */
export type TrainTurnOutcome =
  | { kind: "done" }
  | { kind: "declined"; reason: string }
  | { kind: "blamed"; task: string; reason: string }
  | { kind: "failed"; reason: string };

/** The names Claude Code knows meddle's train tools by: allowed without asking (`allowedTools`). */
export const TRAIN_TOOLS = ["mcp__meddle__decline", "mcp__meddle__blame"] as const;

/**
 * The tools of a train turn of `kind`: `blame(task, reason)` for the merge task's turns, `decline(reason)` for a task's.
 * A call is told to `record` as a `train_decline` or `train_blame` event; the turn's outcome is read from those
 * (`trainOutcome`), so it survives a restart.
 */
export function trainToolList(kind: TrainTurnKind, record: (e: MeddleEvent) => void): SdkMcpToolDefinition<any>[] {
  if (kind === "merge") {
    return [tool(
      "blame",
      "Call this when a test fails on the merge: name the task responsible, as the prompt names it, and say what failed. " +
        "That task leaves the batch and is asked to fix it; the others are checked again without it.",
      {
        task: z.string().describe("The task responsible, as the prompt names it"),
        reason: z.string().describe("What failed: the test, and its error"),
      },
      async ({ task, reason }) => {
        record({ type: "meddle", subtype: "train_blame", task, reason });
        return { content: [{ type: "text", text: `Blamed ${task}. meddle takes it out of this batch; end your turn.` }] };
      },
    )];
  }
  return [tool(
    "decline",
    "Call this when meddle's request no longer makes sense for your change, for example because something it relies on " +
      "is gone from main or has changed meaning. Your task leaves the merge train's queue, with your reason shown to the user.",
    { reason: z.string().describe("Why your change no longer makes sense on main") },
    async ({ reason }) => {
      record({ type: "meddle", subtype: "train_decline", reason });
      return { content: [{ type: "text", text: "Declined. meddle takes the task off the merge train's queue; end your turn." }] };
    },
  )];
}

/** An in-process MCP server named `meddle` with the tools of a train turn of `kind` (`trainToolList`). */
export function trainTools(kind: TrainTurnKind, record: (e: MeddleEvent) => void): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({ name: "meddle", version: "1", tools: trainToolList(kind, record) });
}

/**
 * How a train turn went, from the events it logged, oldest first (from its first `turn_started` to its end; a rerun after
 * a restart or a token fault is the same turn): the first `train_decline` or `train_blame` in them, whatever came after;
 * else how its last attempt ended: a `result` (`done`, or `failed` with its error), a `turn_failed`, a `turn_aborted`,
 * or a `token_fault` that did not rerun it. A turn that logged none of these failed without a result.
 */
export function trainOutcome(events: readonly unknown[]): TrainTurnOutcome {
  let end: TrainTurnOutcome | null = null;
  for (const e of events) {
    const m = (e ?? {}) as { type?: unknown; subtype?: unknown; [key: string]: unknown };
    if (m.type === "result") {
      const error = resultError(m);
      end = error === null ? { kind: "done" } : { kind: "failed", reason: `the turn ended with ${error}` };
      continue;
    }
    if (m.type !== "meddle") continue;
    switch (m.subtype) {
      case "train_decline":
        return { kind: "declined", reason: str(m.reason) };
      case "train_blame":
        return { kind: "blamed", task: str(m.task), reason: str(m.reason) };
      case "turn_started":
        end = null; // another attempt: how the one before ended is not how the turn did
        break;
      case "turn_failed":
        end = { kind: "failed", reason: str(m.error).replace(/^Error: /, "") };
        break;
      case "turn_aborted":
        end = { kind: "failed", reason: "the turn was aborted" };
        break;
      case "token_fault":
        end = m.rerun === true ? null : { kind: "failed", reason: tokenFaultNotice(m) };
        break;
    }
  }
  return end ?? { kind: "failed", reason: "the turn ended without a result" };
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
