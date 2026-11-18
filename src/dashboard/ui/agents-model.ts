// What the agent list above a task's message box shows, computed from the task's agents. Pure: no Preact, no DOM.
import type { AgentEntry } from "../../state/contracts";
import { ago, tokens } from "./sidebar-model";
import { duration } from "./thread-model";

/** How many finished agents the panel lists before folding the rest into a count. */
export const FINISHED_SHOWN = 3;

/** An agent as a row of the panel: its step (or how it ended) and its numbers (`31 tools · 80k · 3m 25s`). */
export type AgentRow = { agent: AgentEntry; doing: string; nums: string };

/** Whole seconds from an ISO time to `now`; never negative (this clock may run behind the node's). */
function secondsSince(iso: string, now: number): number {
  return Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
}

type StateWords = ReadonlyArray<readonly [AgentEntry["state"], string]>;

/** How many of the agents are in each state, as `1 done`, the words in the order given, leaving out the noughts. */
function tally(agents: readonly AgentEntry[], words: StateWords, separator: string): string {
  return words
    .map(([state, word]) => [agents.filter((a) => a.state === state).length, word] as const)
    .filter(([n]) => n !== 0)
    .map(([n, word]) => `${n} ${word}`)
    .join(separator);
}

/** How long an agent has worked, in whole seconds: since `startedAt` while it runs, else its final `ms`. */
export function agentSeconds(agent: AgentEntry, now: number): number {
  return agent.state === "running" ? secondsSince(agent.startedAt, now) : Math.round(agent.ms / 1000);
}

/**
 * The agent whose row holds this one's in the thread: an agent launched by an agent has its row inside its parent's,
 * so `parent` is followed up through `agents` to one with no listed parent (the agent itself when it has none).
 */
export function rootOf(agent: AgentEntry, agents: readonly AgentEntry[]): AgentEntry {
  const seen = new Set<string>();
  let at = agent;
  for (let up = at.parent; up !== null && !seen.has(at.id); up = at.parent) {
    seen.add(at.id);
    const parent = agents.find((a) => a.id === up);
    if (parent === undefined) break;
    at = parent;
  }
  return at;
}

/** The agents' states in words (`2 running · 1 done · 1 stopped`), leaving out the noughts; "" for none. */
export function agentCounts(agents: readonly AgentEntry[]): string {
  return tally(agents, [["running", "running"], ["completed", "done"], ["stopped", "stopped"], ["failed", "failed"]], " · ");
}

/** One panel row: a running agent's latest step and elapsed time, or how a finished one ended and its final time. */
function row(agent: AgentEntry, now: number): AgentRow {
  const running = agent.state === "running";
  const doing = running ? (agent.doing ?? "Working")
    : agent.state === "completed" ? (agent.endedAt === null ? "done" : `done ${ago(now - Date.parse(agent.endedAt))} ago`)
    : agent.state === "failed" ? "failed"
    : agent.orphaned ? "stopped with the session" : "stopped";
  return { agent, doing, nums: `${agent.tools} tools · ${tokens(agent.tokens)} · ${duration(agentSeconds(agent, now))}` };
}

/**
 * The panel's rows in the order served (running first): every running agent, then the first `FINISHED_SHOWN` finished
 * ones, or all of them with `showAll`. `earlier` counts the finished ones left out (`2 earlier: 1 stopped, 1 done`);
 * null when none are.
 */
export function panelRows(agents: readonly AgentEntry[], now: number, showAll: boolean): { rows: AgentRow[]; earlier: string | null } {
  const finished = agents.filter((a) => a.state !== "running");
  const hidden = showAll ? [] : finished.slice(FINISHED_SHOWN);
  const earlier = hidden.length === 0 ? null
    : `${hidden.length} earlier: ${tally(hidden, [["stopped", "stopped"], ["failed", "failed"], ["completed", "done"]], ", ")}`;
  return { rows: agents.filter((a) => !hidden.includes(a)).map((a) => row(a, now)), earlier };
}

const countOf = (n: number) => `${n} ${n === 1 ? "agent" : "agents"}`;

/** The panel folded into a line: the running agents with their times, then the others counted; or that all finished. */
export function foldedLine(agents: readonly AgentEntry[], now: number): string {
  const running = agents.filter((a) => a.state === "running");
  if (running.length === 0) return `${countOf(agents.length)}, all finished`;
  const names = running.map((a) => `${a.description} (${duration(secondsSince(a.startedAt, now))})`).join(", ");
  const rest = agentCounts(agents.filter((a) => a.state !== "running"));
  return `${countOf(running.length)} running: ${names}${rest === "" ? "" : ` · ${rest}`}`;
}
