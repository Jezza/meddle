// Settings: the pool (this node, its members, invites and joining), the pool's settings and its login tokens.
import { useState } from "preact/hooks";
import { shortId } from "../../pool/ids";
import { useAction, useValue } from "./hooks";
import { joinStateOf, type JoinState } from "./join-state";
import { tokenText, type PoolRef } from "./Pool";

export function Settings({ pool }: { pool: PoolRef }) {
  return (
    <section>
      <h2>Settings</h2>
      <PoolSection pool={pool} />
      <PoolSettings pool={pool} />
      <TokenSection pool={pool} />
    </section>
  );
}

function PoolSection({ pool }: { pool: PoolRef }) {
  const poolId = useValue(pool.poolId);
  const selfId = useValue(pool.self);
  const nodes = useValue(pool.nodes);
  const self = nodes.find((n) => n.nodeId === selfId);
  const joinState = joinStateOf(nodes, selfId);
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
      <Join pool={pool} state={joinState} />
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

function Join({ pool, state }: { pool: PoolRef; state: JoinState }) {
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
      {state.hint !== null && <p class="muted">{state.hint}</p>}
      <textarea rows={3} value={ticket} disabled={state.blocked} placeholder="meddle1…" onInput={(e) => setTicket(e.currentTarget.value)} />
      <button disabled={state.blocked || action.busy || ticket.trim() === ""} onClick={join}>Join</button>
      {action.error !== null && <p class="error">{action.error}</p>}
      {joined !== null && <p>{joined}</p>}
    </>
  );
}

/** The keys the set form offers by name; `ENV` stands for `env.<NAME>`, whose name is typed. */
const SETTING_KEYS = ["jj.user", "jj.email", "lighthouse.url", "limits.running"];
const ENV = "env.";

/** A node's hostname from the roster, else its short id. */
function nodeName(nodes: readonly { nodeId: string; hostname: string }[], id: string): string {
  return nodes.find((n) => n.nodeId === id)?.hostname ?? shortId(id);
}

/** The pool's settings: what is set (key, value, set by, Unset) and a form to set a key. */
function PoolSettings({ pool }: { pool: PoolRef }) {
  const settings = useValue(pool.settings);
  const nodes = useValue(pool.nodes);
  const unset = useAction();
  return (
    <>
      <h3>Pool settings</h3>
      <p class="muted">
        Every member holds these settings, and every member's dashboard shows their values: never put a secret in one
        (an <code>env.</code> value reaches every task's Claude Code and every jj run). Login tokens are kept apart, below.
      </p>
      {unset.error !== null && <p class="error">{unset.error}</p>}
      {settings.length === 0 ? <p class="muted">Nothing set: every node uses its own defaults.</p> : (
        <table>
          <thead><tr><th>Key</th><th>Value</th><th>Set by</th><th></th></tr></thead>
          <tbody>
            {settings.map((s) => (
              <tr key={s.key}>
                <td><code>{s.key}</code></td>
                <td><code>{s.value}</code></td>
                <td title={`${s.setBy} at ${s.updatedAt}`}>{nodeName(nodes, s.setBy)}</td>
                <td>
                  <button
                    disabled={unset.busy}
                    onClick={() => {
                      if (confirm(`Unset ${s.key} for the whole pool?`)) void unset.run(() => pool.unsetSetting({ key: s.key }));
                    }}
                  >Unset</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <SetSetting pool={pool} />
    </>
  );
}

/** Sets one key: picked from the known keys, or `env.` with a typed name. */
function SetSetting({ pool }: { pool: PoolRef }) {
  const [choice, setChoice] = useState(SETTING_KEYS[0]!);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const action = useAction();
  const key = choice === ENV ? `${ENV}${name.trim()}` : choice;
  const submit = async (e: Event) => {
    e.preventDefault();
    const ok = await action.run(() => pool.setSetting({ key, value }));
    if (ok) {
      setValue("");
      setName("");
    }
  };
  return (
    <form onSubmit={submit}>
      <label>Key{" "}
        <select value={choice} onChange={(e) => setChoice(e.currentTarget.value)}>
          {SETTING_KEYS.map((k) => <option key={k} value={k}>{k}</option>)}
          <option value={ENV}>env.&lt;NAME&gt;</option>
        </select>
      </label>
      {choice === ENV && (
        <label>Name <input value={name} placeholder="RUST_LOG" onInput={(e) => setName(e.currentTarget.value)} required /></label>
      )}
      <label>Value <input value={value} onInput={(e) => setValue(e.currentTarget.value)} /></label>
      <button type="submit" disabled={action.busy || (choice === ENV && name.trim() === "")}>Set</button>
      {action.error !== null && <p class="error">{action.error}</p>}
    </form>
  );
}

/** `ok`, `exhausted until <time>`, `disabled (<why>)`. */
function tokenState(t: { status: string; until: string | null; detail: string | null }): string {
  const until = t.until === null ? "" : ` until ${new Date(t.until).toLocaleString()}`;
  return `${t.status}${until}${t.detail === null ? "" : ` (${t.detail})`}`;
}

function TokenSection({ pool }: { pool: PoolRef }) {
  const tokens = useValue(pool.tokens);
  const active = useValue(pool.activeTokenId);
  const nodes = useValue(pool.nodes);
  const enable = useAction();
  const setByName = (id: string | null) => (id === null ? "?" : nodeName(nodes, id));
  return (
    <>
      <h3>Tokens</h3>
      {active === null && <p class="error">{tokens.length === 0 ? "No token: turns cannot run." : "No usable token on this node: turns cannot run."}</p>}
      {enable.error !== null && <p class="error">{enable.error}</p>}
      {tokens.length > 0 && (
        <table>
          <thead><tr><th>Label</th><th>Id</th><th>Status</th><th>Set by</th><th>Expires</th><th></th></tr></thead>
          <tbody>
            {tokens.map((t) => (
              <tr key={t.id} class={t.id === active ? "active" : ""}>
                <td>{t.label}{t.id === active ? " (active)" : ""}</td>
                <td title={t.id}><code>{t.id.slice(0, 8)}</code></td>
                <td>{tokenState(t)}</td>
                <td title={t.setBy ?? ""}>{setByName(t.setBy)}</td>
                <td>{tokenText({ present: true, expiresAt: t.expiresAt })}</td>
                <td>
                  {t.status !== "ok" && (
                    <button
                      disabled={enable.busy}
                      title="Mark it usable again, for the whole pool"
                      onClick={() => void enable.run(() => pool.enableToken({ id: t.id }))}
                    >Enable</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p class="muted">
        Claude Code OAuth tokens are added on a node with <code>meddle token add</code> and shared with the pool; turns use
        the first usable one in this order. Their values never pass through the dashboard: it shows only what is listed
        here. Enable marks an exhausted or disabled token usable again for the whole pool.
      </p>
    </>
  );
}
