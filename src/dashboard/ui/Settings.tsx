// Settings: the pool (this node, its secret and its members), the pool's settings and its login tokens.
import { useState } from "preact/hooks";
import { shortId } from "../../pool/ids";
import { useAction, useValue } from "./hooks";
import { PaneHead, tokenText, type PoolRef } from "./common";

export function Settings({ pool }: { pool: PoolRef }) {
  return (
    <>
      <PaneHead><strong>Settings</strong></PaneHead>
      <div class="page">
        <PoolSection pool={pool} />
        <PoolSettings pool={pool} />
        <TokenSection pool={pool} />
      </div>
    </>
  );
}

function PoolSection({ pool }: { pool: PoolRef }) {
  const poolId = useValue(pool.poolId);
  const poolName = useValue(pool.poolName);
  const selfId = useValue(pool.self);
  const nodes = useValue(pool.nodes);
  const self = nodes.find((n) => n.nodeId === selfId);
  const action = useAction();
  return (
    <>
      <h3>Pool</h3>
      <dl>
        <dt>This node</dt><dd title={selfId}>{shortId(selfId)} ({self?.hostname ?? "?"})</dd>
        <dt>Pool</dt>
        <dd>{poolId === "" ? <span class="error">no secret set</span> : <>{poolName} <code>{poolId}</code></>}</dd>
      </dl>
      <p class="muted">
        {poolId === ""
          ? <>This node is alone until a pool secret is set on it: run <code>meddle pool secret</code> there, with the same secret as on the other nodes.</>
          : <>Every node given this pool's name and secret (<code>meddle pool secret</code>) finds the others through the lighthouse and is a member once it proves the secret to them. The secret itself never passes through the dashboard.</>}
      </p>
      <h3>Members</h3>
      {action.error !== null && <p class="error">{action.error}</p>}
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
                    disabled={action.busy}
                    onClick={() => {
                      if (confirm(`Remove ${n.hostname} (${shortId(n.nodeId)}) from the pool? It keeps the secret: rotate it to shut the node out for good.`)) {
                        void action.run(() => pool.remove({ nodeId: n.nodeId }));
                      }
                    }}
                  >Remove</button>
                )}
                {n.status === "removed" && n.nodeId !== selfId && (
                  <button
                    disabled={action.busy}
                    title="Make it a member again, for the whole pool"
                    onClick={() => void action.run(() => pool.allow({ nodeId: n.nodeId }))}
                  >Allow again</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/** The keys the set form offers by name; `ENV` stands for `env.<NAME>`, whose name is typed. */
const SETTING_KEYS = ["jj.user", "jj.email", "lighthouse.url", "limits.running", "roster.forget"];
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
  const action = useAction();
  const setByName = (id: string | null) => (id === null ? "?" : nodeName(nodes, id));
  return (
    <>
      <h3>Tokens</h3>
      {active === null && <p class="error">{tokens.length === 0 ? "No token: turns cannot run." : "No usable token on this node: turns cannot run."}</p>}
      {action.error !== null && <p class="error">{action.error}</p>}
      {tokens.length > 0 && (
        <table>
          <thead><tr><th>Label</th><th>Id</th><th>Status</th><th>Set by</th><th>Expires</th><th></th></tr></thead>
          <tbody>
            {tokens.map((t, i) => (
              <tr key={t.id} class={t.id === active ? "active" : ""}>
                <td>{t.label}{t.id === active ? " (active)" : ""}</td>
                <td title={t.id}><code>{t.id.slice(0, 8)}</code></td>
                <td>{tokenState(t)}</td>
                <td title={t.setBy ?? ""}>{setByName(t.setBy)}</td>
                <td>{tokenText({ present: true, expiresAt: t.expiresAt })}</td>
                <td>
                  {tokens.length > 1 && (
                    <>
                      <button
                        disabled={action.busy || i === 0}
                        title="Try it before the one above, for the whole pool"
                        onClick={() => void action.run(() => pool.moveToken({ id: t.id, before: tokens[i - 1]!.id }))}
                      >Up</button>
                      <button
                        disabled={action.busy || i === tokens.length - 1}
                        title="Try it after the one below, for the whole pool"
                        onClick={() => void action.run(() => pool.moveToken({ id: t.id, after: tokens[i + 1]!.id }))}
                      >Down</button>
                    </>
                  )}
                  {t.status !== "ok" && (
                    <button
                      disabled={action.busy}
                      title="Mark it usable again, for the whole pool"
                      onClick={() => void action.run(() => pool.enableToken({ id: t.id }))}
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
        here. Up and Down change the order (<code>meddle token move</code>), and Enable marks an exhausted or disabled
        token usable again, both for the whole pool.
      </p>
    </>
  );
}
