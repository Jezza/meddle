// Settings: the pool (this node, its members, invites and joining) and the shared login's token status.
import { useState } from "preact/hooks";
import { shortId } from "../../pool/ids";
import { useAction, useValue } from "./hooks";
import { tokenText, type PoolRef } from "./Pool";

export function Settings({ pool }: { pool: PoolRef }) {
  return (
    <section>
      <h2>Settings</h2>
      <PoolSection pool={pool} />
      <TokenSection pool={pool} />
    </section>
  );
}

function PoolSection({ pool }: { pool: PoolRef }) {
  const poolId = useValue(pool.poolId);
  const selfId = useValue(pool.self);
  const nodes = useValue(pool.nodes);
  const self = nodes.find((n) => n.nodeId === selfId);
  const othersPresent = nodes.some((n) => n.status === "member" && n.nodeId !== selfId);
  const remove = useAction();
  return (
    <>
      <h3>Pool</h3>
      <dl>
        <dt>This node</dt><dd title={selfId}>{shortId(selfId)} ({self?.hostname ?? "?"})</dd>
        <dt>Pool id</dt><dd><code>{poolId}</code></dd>
      </dl>
      <h3>Members</h3>
      {remove.error !== null && <p class="error">{remove.error}</p>}
      <table>
        <thead><tr><th>Node id</th><th>Hostname</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {nodes.map((n) => (
            <tr key={n.nodeId} class={n.status === "removed" ? "removed" : ""}>
              <td><code>{n.nodeId}</code></td>
              <td>{n.hostname}{n.nodeId === selfId ? " (this node)" : ""}</td>
              <td>{n.status === "removed" ? "removed" : n.online ? "online" : "offline"}</td>
              <td>
                {n.status === "member" && n.nodeId !== selfId && (
                  <button
                    disabled={remove.busy}
                    onClick={() => {
                      if (confirm(`Remove ${n.hostname} (${shortId(n.nodeId)}) from the pool?`)) void remove.run(() => pool.remove({ nodeId: n.nodeId }));
                    }}
                  >Remove</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Invite pool={pool} />
      <Join pool={pool} othersPresent={othersPresent} />
    </>
  );
}

function Invite({ pool }: { pool: PoolRef }) {
  const [ticket, setTicket] = useState<string | null>(null);
  const action = useAction();
  const invite = () => action.run(async () => { setTicket((await pool.invite({})).ticket); });
  return (
    <>
      <h3>Invite</h3>
      <p class="muted">A ticket lets one node join this pool, once, within 24 hours.</p>
      <button disabled={action.busy} onClick={invite}>Create a ticket</button>
      {action.error !== null && <p class="error">{action.error}</p>}
      {ticket !== null && <textarea readOnly rows={3} value={ticket} onFocus={(e) => e.currentTarget.select()} />}
    </>
  );
}

function Join({ pool, othersPresent }: { pool: PoolRef; othersPresent: boolean }) {
  const [ticket, setTicket] = useState("");
  const [joined, setJoined] = useState<string | null>(null);
  const action = useAction();
  const join = () => action.run(async () => {
    const result = await pool.join({ ticket: ticket.trim() });
    setJoined(`Joined pool ${result.poolId} (${result.members} members).`);
    setTicket("");
  });
  return (
    <>
      <h3>Join another pool</h3>
      {othersPresent && <p class="muted">This node already shares a pool with other members; remove them first to join another.</p>}
      <textarea rows={3} value={ticket} disabled={othersPresent} placeholder="meddle1…" onInput={(e) => setTicket(e.currentTarget.value)} />
      <button disabled={othersPresent || action.busy || ticket.trim() === ""} onClick={join}>Join</button>
      {action.error !== null && <p class="error">{action.error}</p>}
      {joined !== null && <p>{joined}</p>}
    </>
  );
}

function TokenSection({ pool }: { pool: PoolRef }) {
  const token = useValue(pool.token);
  const nodes = useValue(pool.nodes);
  const selfId = useValue(pool.self);
  const setBy = token.setBy === null ? null : nodes.find((n) => n.nodeId === token.setBy)?.hostname ?? shortId(token.setBy);
  return (
    <>
      <h3>Token</h3>
      <p class={token.present ? "" : "error"}>{tokenText(token)}</p>
      {token.present && (
        <dl>
          <dt>Set at</dt><dd>{token.setAt === null ? "unknown" : new Date(token.setAt).toLocaleString()}</dd>
          <dt>Set by</dt><dd title={token.setBy ?? selfId}>{setBy ?? "this node, by hand"}</dd>
          <dt>Expires</dt><dd>{token.expiresAt === null ? "unknown" : new Date(token.expiresAt).toLocaleString()}</dd>
        </dl>
      )}
      <p class="muted">The Claude Code OAuth token is set on a node with <code>meddle token set</code> and shared with the pool; it never passes through the dashboard.</p>
    </>
  );
}
