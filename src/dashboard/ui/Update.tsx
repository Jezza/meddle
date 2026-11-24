// Pool updates on the dashboard: the bar over the pane while a rollout drains (what it waits on: nodes, tasks' turns)
// or after one failed (its reason, until the next rollout or until dismissed), and the blind that covers everything
// from the swap until the pool confirms or rolls back, since nothing is accepted then. This node's `UpdateObject` says
// all of it: the rollout channel tells every node of every other.
import type { Host } from "@earendil-works/chord";
import { useEffect, useRef, useState } from "preact/hooks";
import { UpdateObject } from "../../state/contracts";
import { useNow, useObject } from "./hooks";
import { hashOf } from "./routes";
import type { ListedTask } from "./sources";
import { blinded, draining, failureText, participantLines, timeLeft, waits, type UpdateView } from "./update-model";

/** This node's `UpdateObject` as the dashboard reads it, re-rendering on every change; null until it is had. */
export function useUpdate(host: Host): UpdateView | null {
  const obj = useObject(host, UpdateObject, {});
  const ref = obj.ref;
  const [, tick] = useState(0);
  const last = useRef<UpdateView | null>(null);
  useEffect(() => {
    if (ref === undefined) return;
    const cells = [ref.build, ref.poolBuild, ref.rollout, ref.lastFailure, ref.awaitingConfirmation, ref.nodes];
    const offs = cells.map((c) => c.subscribe(() => tick((n) => n + 1)));
    return () => { for (const off of offs) off(); };
  }, [ref]);
  if (ref === undefined) return last.current;
  try {
    last.current = {
      build: ref.build.value, poolBuild: ref.poolBuild.value, rollout: ref.rollout.value, lastFailure: ref.lastFailure.value,
      awaitingConfirmation: ref.awaitingConfirmation.value, nodes: ref.nodes.value,
    };
  } catch {
    // Its node's socket closed: the last values stand in.
  }
  return last.current;
}

const DISMISSED_KEY = "meddle.update.dismissed";

function dismissedRollout(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

/** A task's turn as the bar names it: its title, linking to it, else its id. */
function TurnLink({ nodeId, id, tasks }: { nodeId: string; id: string; tasks: readonly ListedTask[] }) {
  const t = tasks.find((x) => x.id === id && x.nodeId === nodeId);
  return <a href={hashOf({ name: "task", nodeId, id })} title={id}>{t?.title ?? id}</a>;
}

/** The bar over the pane: a rollout draining (what it waits on), or the last one's failure. Nothing otherwise. */
export function UpdateBar({ update, name, tasks }: { update: UpdateView; name(id: string): string; tasks: readonly ListedTask[] }) {
  const now = useNow(1000);
  const [dismissed, setDismissed] = useState(dismissedRollout);
  /** The failure shown whole (a reason may carry the service's last log lines), not cut to one line. */
  const [whole, setWhole] = useState(false);
  const r = draining(update);
  if (r !== null) {
    const waiting = waits(r);
    return (
      <div class="update-bar">
        <strong>Updating</strong>
        <code>{r.build}</code>
        <span class="muted">{r.mode} · {timeLeft(r.deadline, now)} left</span>
        {waiting.length > 0 && (
          <span class="update-waits">
            waits on{" "}
            {waiting.map((w, i) => (
              <span key={w.node}>
                {i > 0 && "; "}
                {name(w.node)}
                {w.turns.length > 0
                  ? <>: {w.turns.map((t, j) => <span key={t}>{j > 0 && ", "}<TurnLink nodeId={w.node} id={t} tasks={tasks} /></span>)}</>
                  : <span class="muted"> ({w.step})</span>}
              </span>
            ))}
          </span>
        )}
      </div>
    );
  }
  const failure = failureText(update, name);
  if (failure === null || failure.rollout === dismissed) return null;
  const dismiss = () => {
    try {
      localStorage.setItem(DISMISSED_KEY, failure.rollout);
    } catch {
      // a private window: dismissed for this page only
    }
    setDismissed(failure.rollout);
  };
  return (
    <div class="update-bar failed">
      <span class={`update-failure${whole ? " whole" : ""}`} title={whole ? undefined : failure.text} onClick={() => setWhole(!whole)}>{failure.text}</span>
      <button class="icon" title="Dismiss" onClick={dismiss}>×</button>
    </div>
  );
}

/** How often a blind whose node went down for its swap looks for it again. */
const BACK_POLL_MS = 2000;

/**
 * What covers the dashboard while the pool swaps and awaits confirmation: each participant's state and health deadline,
 * and the rollout's own. When this node's socket closed (it restarted onto the new build, or back), the page reloads
 * once the node answers again, or its socket opens again first.
 */
export function Blind({ update, name, connected }: { update: UpdateView; name(id: string): string; connected: boolean }) {
  const now = useNow(1000);
  const covering = blinded(update);
  const dropped = useRef(false);
  useEffect(() => {
    if (connected && dropped.current) location.reload();
    if (connected || !covering) return;
    dropped.current = true;
    const timer = setInterval(() => {
      fetch("/", { cache: "no-store" }).then((res) => { if (res.ok) location.reload(); }, () => {});
    }, BACK_POLL_MS);
    return () => clearInterval(timer);
  }, [connected, covering]);
  if (!covering) return null;
  const r = update.rollout;
  return (
    <div class="blind" role="alertdialog" aria-modal="true" aria-label="Updating">
      <div class="blind-box">
        <h2>Updating</h2>
        {/* A late node's update is its own: the pool's rollout is over, only its own build awaits confirmation. */}
        {r === null || r.outcome !== null ? <p class="muted"><code>{update.build.buildId}</code> · this node, catching up{!connected && " · restarting"}</p> : (
          <>
            <p class="muted">
              <code>{r.build}</code> · {r.mode} · {timeLeft(r.deadline, now)} left
              {!connected && " · restarting"}
            </p>
            <table>
              <thead><tr><th>Node</th><th>State</th><th>Health</th></tr></thead>
              <tbody>
                {participantLines(r).map((p) => (
                  <tr key={p.node}>
                    <td>{name(p.node)}</td>
                    <td class={p.failed ? "error" : ""}>{p.state}{p.detail !== null && <span class="muted"> · {p.detail}</span>}</td>
                    <td class="muted">{p.healthBy === null ? "" : `${timeLeft(p.healthBy, now)} left`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        <p class="muted">Nothing is taken until the pool confirms the new build or rolls back.</p>
      </div>
    </div>
  );
}
