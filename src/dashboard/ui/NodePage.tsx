// One node of the pool: its versions, token, task root and resources while it is reachable, what the roster knows of
// it otherwise, and the tasks it holds.
import type { Host, Ref } from "@earendil-works/chord";
import { NodeObject } from "../../state/contracts";
import { shortId } from "../../pool/ids";
import { type Hosts, useObject, useValue } from "./hooks";
import { mb, PaneHead, type PoolNode, type PoolRef, StateDot, tokenText, Unavailable } from "./common";
import { hashOf } from "./routes";
import { nodeLineText, waitsOnYou } from "./sidebar-model";
import type { PoolIndex } from "./sources";

type NodeRef = Ref<typeof NodeObject>;

export function NodePage({ hosts, pool, index, nodeId }: { hosts: Hosts; pool: PoolRef; index: PoolIndex; nodeId: string }) {
  const nodes = useValue(pool.nodes);
  const selfId = useValue(pool.self);
  const row = nodes.find((n) => n.nodeId === nodeId);
  const selfRow = nodes.find((n) => n.nodeId === selfId);
  if (row === undefined) return <><PaneHead><strong>Node</strong></PaneHead><p class="pane-note error">Node {shortId(nodeId)} is not in this pool.</p></>;
  const host = row.status === "member" && (row.online || nodeId === selfId) ? hosts.for(nodeId) : undefined;
  const tasks = index.tasks.filter((t) => t.nodeId === nodeId && !t.archived);
  return (
    <>
      <PaneHead>
        <span class={`dot ${row.online ? (row.running > 0 ? "run" : "idle") : "off"}`} />
        <strong>{row.hostname}</strong>
        <span class="muted id" title={row.nodeId}>{shortId(row.nodeId)}</span>
        <span class="muted">{row.status === "removed" ? "removed from the pool" : nodeLineText(row, null, Date.now())}{nodeId === selfId && " · this node"}</span>
      </PaneHead>
      <div class="page">
        {row.status === "removed" && <p class="muted">Removed from the pool.</p>}
        {row.status === "member" && row.online && host === undefined && <Unavailable status={hosts.status(nodeId)} />}
        {host === undefined ? <Summary row={row} selfRow={selfRow} /> : <Live host={host} row={row} selfRow={selfRow} />}
        <h3>Tasks</h3>
        {tasks.length === 0 ? <p class="muted">{row.online ? "No tasks." : `${row.taskCount} tasks, not reachable while it is offline.`}</p> : (
          <ul class="plain">
            {tasks.map((t) => (
              <li key={t.id}>
                <StateDot state={t.state} waiting={waitsOnYou(t)} />{" "}
                <a href={hashOf({ name: "task", nodeId, id: t.id })}>{t.title}</a>{" "}
                <span class="muted">{t.projects.map((p) => p.name).join(", ") || "no project"}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

/** What the roster knows about a node that is offline (or whose objects are still loading). */
function Summary({ row, selfRow }: { row: PoolNode; selfRow: PoolNode | undefined }) {
  return (
    <dl>
      <dt>meddle</dt><dd><Version value={row.version} self={selfRow?.version} /></dd>
      <dt>Claude Code</dt><dd><Version value={row.claudeCodeVersion} self={selfRow?.claudeCodeVersion} /></dd>
      <dt>Hosts tasks</dt><dd>{row.hostsTasks ? "yes" : "no"}</dd>
      <dt>Tasks</dt><dd>{row.taskCount}</dd>
      {!row.online && <><dt>Last seen</dt><dd>{row.lastSeenAt === null ? "never" : new Date(row.lastSeenAt).toLocaleString()}</dd></>}
    </dl>
  );
}

/** A version, flagged when it is not this node's. */
function Version({ value, self }: { value: string; self: string | undefined }) {
  if (value === "") return <span class="muted">unknown</span>;
  const differs = self !== undefined && self !== "" && value !== self;
  return differs ? <span class="flag" title={`this node runs ${self}`}>{value} (differs)</span> : <span>{value}</span>;
}

function Live({ host, row, selfRow }: { host: Host; row: PoolNode; selfRow: PoolNode | undefined }) {
  const node = useObject(host, NodeObject, {});
  if (node.ref === undefined) {
    return <>{node.error === undefined ? <p class="muted">Connecting…</p> : <p class="error">{node.error}</p>}<Summary row={row} selfRow={selfRow} /></>;
  }
  return <LiveLoaded node={node.ref} selfRow={selfRow} row={row} />;
}

function LiveLoaded({ node, row, selfRow }: { node: NodeRef; row: PoolNode; selfRow: PoolNode | undefined }) {
  const version = useValue(node.version);
  const claudeCodeVersion = useValue(node.claudeCodeVersion);
  const token = useValue(node.token);
  const metrics = useValue(node.metrics);
  const hostsTasks = useValue(node.hostsTasks);
  const hostingProblem = useValue(node.hostingProblem);
  const taskRoot = useValue(node.taskRoot);
  return (
    <dl>
      <dt>meddle</dt><dd><Version value={version} self={selfRow?.version} /></dd>
      <dt>Claude Code</dt><dd><Version value={claudeCodeVersion} self={selfRow?.claudeCodeVersion} /></dd>
      <dt>Token</dt><dd>{tokenText(token)}</dd>
      <dt>Task root</dt><dd>{taskRoot}</dd>
      <dt>Running</dt><dd>{row.running}{row.limit > 0 && ` of at most ${row.limit}`}</dd>
      {!hostsTasks && <><dt>Tasks</dt><dd class="error">hosts none: {hostingProblem ?? "its task root is not usable"}</dd></>}
      {metrics === null ? <><dt>Resources</dt><dd class="muted">no sample yet</dd></> : (
        <>
          <dt>Cores</dt><dd>{metrics.cores}, load {metrics.load1.toFixed(2)}</dd>
          <dt>Memory</dt><dd>{mb(metrics.memAvailableKb)} free of {mb(metrics.memTotalKb)}</dd>
          <dt>Disk free</dt><dd>{mb(metrics.diskFreeKb)}</dd>
          <dt>Service</dt><dd>{mb(metrics.serviceRssKb)} RSS, event loop lag {metrics.eventLoopLagMs.toFixed(1)} ms</dd>
          <dt>Sampled</dt><dd>{new Date(metrics.at).toLocaleTimeString()}</dd>
        </>
      )}
    </dl>
  );
}
