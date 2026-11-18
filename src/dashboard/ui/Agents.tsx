// The agent list above a task's message box: every agent the task started, the running ones first with their current
// step, then how the others ended (the oldest finished folded into a count); or, folded, one line. Picking an agent
// leads the thread to its row.
import { useState } from "preact/hooks";
import type { AgentEntry } from "../../state/contracts";
import { type AgentRow, agentCounts, FINISHED_SHOWN, foldedLine, panelRows } from "./agents-model";
import { store, stored, useTick } from "./hooks";
import { Glyph, Icon } from "./icons";

/** Whether the list is folded to one line, remembered per browser. */
const FOLDED_KEY = "meddle.agents.folded";

/** The task's agents (none: nothing shows); `selected` is the `toolUseId` of the agent last picked, highlighted. */
export function AgentsPanel({ agents, selected, onPick }: { agents: readonly AgentEntry[]; selected: string | null; onPick(agent: AgentEntry): void }) {
  const [folded, setFolded] = useState(() => stored(FOLDED_KEY));
  const [showAll, setShowAll] = useState(false);
  useTick(1000);
  if (agents.length === 0) return null;
  const now = Date.now();
  const fold = () => {
    store(FOLDED_KEY, !folded);
    setFolded(!folded);
  };
  const { rows, earlier } = panelRows(agents, now, showAll);
  const finished = agents.filter((a) => a.state !== "running").length;
  return (
    <div class={`agents${folded ? " folded" : ""}`}>
      <div class="agents-head">
        <Glyph name="agent" cls="lead" />
        {folded ? <span class="sum">{foldedLine(agents, now)}</span> : <><span>Agents</span><span class="sum">{agentCounts(agents)}</span></>}
        <button class="toggle" aria-expanded={!folded} title={folded ? "Show the agents" : "Fold to one line"} onClick={fold}>{folded ? "▴" : "▾"}</button>
      </div>
      {!folded && <>
        {rows.map((row) => <AgentLine key={row.agent.id} row={row} selected={row.agent.toolUseId === selected} onPick={onPick} />)}
        {earlier !== null && <button class="amore" onClick={() => setShowAll(true)}>{earlier} ▸</button>}
        {showAll && finished > FINISHED_SHOWN && (
          <button class="amore" onClick={() => setShowAll(false)}>Hide {finished - FINISHED_SHOWN} earlier ▾</button>
        )}
      </>}
    </div>
  );
}

/** One agent: a spinner, a check or a red cross, its description, its step (or how it ended) and its numbers. */
function AgentLine({ row, selected, onPick }: { row: AgentRow; selected: boolean; onPick(agent: AgentEntry): void }) {
  const { agent } = row;
  const icon = agent.state === "running" ? "running" : agent.state === "completed" ? "done" : "failed";
  const cls = `arow${agent.state === "running" ? "" : " fin"}${icon === "failed" ? " stopped" : ""}${selected ? " sel" : ""}`;
  return (
    <button class={cls} title={agent.description} aria-pressed={selected} onClick={() => onPick(agent)}>
      <Icon name={icon} />
      <span class="name">{agent.description}</span>
      <span class="doing">{row.doing}</span>
      <span class="nums">{row.nums}</span>
    </button>
  );
}
