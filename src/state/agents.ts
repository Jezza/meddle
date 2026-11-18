// A task's sub-agents, folded from the `task_*` notices in its event log (the spec's "The agent list on the node").
import type { EventRecord } from "../store/events";
import type { AgentEntry, AgentLog, AgentRecord } from "./contracts";

export const EMPTY_AGENT_LOG: AgentLog = { turnSeq: 0, agents: [], commands: {} };

/** The `type:subtype` kinds of event `foldAgentLog` reads (`listEventsOfKinds`), so a long log need not be loaded. */
export const AGENT_EVENT_KINDS: readonly string[] = [
  "system:task_started",
  "system:task_progress",
  "system:task_updated",
  "system:task_notification",
  "system:background_tasks_changed",
  "meddle:turn_started",
];

type Message = { type?: unknown; subtype?: unknown; [key: string]: unknown };

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" ? value : null);
const obj = (value: unknown): Message | null => (typeof value === "object" && value !== null ? (value as Message) : null);

/** The numbers a `usage` gives; the ones it lacks are left out. */
function usageOf(value: unknown): Partial<Pick<AgentRecord, "tools" | "tokens" | "ms">> {
  const usage = obj(value);
  if (usage === null) return {};
  const out: Partial<Pick<AgentRecord, "tools" | "tokens" | "ms">> = {};
  const tools = num(usage.tool_uses);
  const tokens = num(usage.total_tokens);
  const ms = num(usage.duration_ms);
  if (tools !== null) out.tools = tools;
  if (tokens !== null) out.tokens = tokens;
  if (ms !== null) out.ms = ms;
  return out;
}

const sameCounts = (a: Record<string, number>, b: Record<string, number>): boolean => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
};

/**
 * Applies `events` (oldest first, only those of `AGENT_EVENT_KINDS` matter) to the log. Returns `log` itself when
 * none changed anything, so progress for an unknown agent, or a command's own start, costs no update.
 */
export function foldAgentLog(log: AgentLog, events: readonly EventRecord[]): AgentLog {
  let { turnSeq, agents, commands } = log;
  const update = (id: string, patch: Partial<AgentRecord>) => {
    const i = agents.findIndex((agent) => agent.id === id);
    if (i < 0) return;
    const was = agents[i]!;
    if ((Object.keys(patch) as Array<keyof AgentRecord>).every((key) => was[key] === patch[key])) return;
    agents = agents.map((agent, j) => (j === i ? { ...was, ...patch } : agent));
  };

  for (const { seq, at, message } of events) {
    const m = obj(message);
    if (m === null) continue;
    if (m.type === "meddle" && m.subtype === "turn_started") {
      turnSeq = seq;
      continue;
    }
    if (m.type !== "system") continue;
    const id = str(m.task_id);
    switch (m.subtype) {
      case "task_started": {
        // A background command or watcher starts a task too; only agents are entries.
        if (id === null || m.task_type !== "local_agent") break;
        const background = typeof m.is_backgrounded === "boolean" ? m.is_backgrounded : null;
        if (!agents.some((agent) => agent.id === id)) {
          agents = [...agents, {
            id, toolUseId: str(m.tool_use_id) ?? "", seq, description: str(m.description) ?? "",
            agentType: str(m.subagent_type), background: background ?? false,
            parent: str(m.parent_task_id), state: "running", doing: null, tools: 0, tokens: 0, ms: 0,
            startedAt: at, endedAt: null, runSeq: seq,
          }];
          break;
        }
        // A later start of a known agent runs it again. A wake (its prompt is a notice that its commands ended) is
        // part of the run it continues; anything else is a follow-up, timed from itself.
        const wake = str(m.prompt)?.startsWith("<task-notification>") === true;
        update(id, {
          state: "running", endedAt: null, doing: null, runSeq: seq,
          ...(wake ? {} : { startedAt: at }),
          ...(background === null ? {} : { background }),
        });
        break;
      }
      case "task_progress": {
        if (id === null) break;
        const doing = str(m.description);
        update(id, { ...(doing === null ? {} : { doing }), ...usageOf(m.usage) });
        break;
      }
      case "task_updated": {
        const background = obj(m.patch)?.is_backgrounded;
        if (id !== null && typeof background === "boolean") update(id, { background });
        break;
      }
      case "task_notification": {
        const status = m.status;
        if (id === null || (status !== "completed" && status !== "failed" && status !== "stopped")) break;
        update(id, { state: status, endedAt: at, doing: null, ...usageOf(m.usage) });
        break;
      }
      case "background_tasks_changed": {
        // Every live background task, replacing the last list: count the ones an agent launched that are activity.
        const next: Record<string, number> = {};
        for (const task of Array.isArray(m.tasks) ? m.tasks : []) {
          const t = obj(task);
          const parent = str(t?.parent_task_id);
          if (t === null || parent === null || t.task_type === "local_agent" || t.ambient === true) continue;
          next[parent] = (next[parent] ?? 0) + 1;
        }
        if (!sameCounts(commands, next)) commands = next;
        break;
      }
    }
  }
  return turnSeq === log.turnSeq && agents === log.agents && commands === log.commands ? log : { turnSeq, agents, commands };
}

/**
 * The log's agents as the task serves them, running ones first (newest first), then the rest (last ended first).
 * An agent the log has `completed` while its own commands live is still running, waiting on them. One running with
 * no live turn, or since a later turn started, has no process left to run it: it is `stopped` and `orphaned`.
 */
export function servedAgents(log: AgentLog, liveTurn: boolean): AgentEntry[] {
  const served = log.agents.map(({ runSeq, ...agent }): AgentEntry => {
    const commands = log.commands[agent.id] ?? 0;
    let { state, endedAt, doing } = agent;
    if (state === "completed" && commands > 0) {
      state = "running";
      endedAt = null;
      doing = `Waiting on ${commands} command${commands === 1 ? "" : "s"}`;
    }
    const orphaned = state === "running" && (!liveTurn || runSeq < log.turnSeq);
    if (orphaned) state = "stopped";
    return { ...agent, state, orphaned, doing: state === "running" ? doing : null, commands, endedAt };
  });
  // Newest first: by when it began (running) or ended (the rest), then by seq for equal times.
  const newest = (agent: AgentEntry) => (agent.state === "running" ? agent.startedAt : agent.endedAt ?? agent.startedAt);
  return served.sort((a, b) => {
    const running = Number(b.state === "running") - Number(a.state === "running");
    if (running !== 0) return running;
    const [x, y] = [newest(a), newest(b)];
    return x === y ? b.seq - a.seq : x < y ? 1 : -1;
  });
}

/** How many of `agents` are running. */
export function runningCount(agents: readonly AgentEntry[]): number {
  return agents.filter((agent) => agent.state === "running").length;
}
