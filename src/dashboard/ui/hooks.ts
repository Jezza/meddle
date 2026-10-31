// chord references and state members as Preact hooks.
import { useEffect, useRef, useState } from "preact/hooks";
import { createHost, webSocketLink, type AnyContract, type Host, type InputOf, type Readable, type Ref } from "@earendil-works/chord";

/** A socket to the node the page came from at `path` (`/ws`, `/ws/node/<nodeId>`). */
export function nodeSocket(path: string): WebSocket {
  return new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${path}`);
}

/** A chord client host whose upstream is `socket`. */
export function clientHost(socket: WebSocket): Host {
  return createHost({
    name: "browser",
    self: "browser",
    kind: "client",
    upstream: { link: webSocketLink(socket), principal: "node", onProtocolMismatch: () => location.reload() },
  });
}

/** One client host per node, created on first use over `/ws/node/<nodeId>` and dropped when its socket closes. */
export class Hosts {
  readonly #hosts = new Map<string, Host>();
  readonly #listeners = new Set<(nodeId: string) => void>();

  constructor(readonly selfId: string, readonly selfHost: Host) {}

  /** The host for `nodeId`: the `/ws` host for this node, else a new one when none is open. */
  for(nodeId: string): Host {
    if (nodeId === this.selfId) return this.selfHost;
    const open = this.#hosts.get(nodeId);
    if (open !== undefined) return open;
    const socket = nodeSocket(`/ws/node/${encodeURIComponent(nodeId)}`);
    const host = clientHost(socket);
    this.#hosts.set(nodeId, host);
    socket.addEventListener("close", () => {
      if (this.#hosts.get(nodeId) !== host) return;
      this.#hosts.delete(nodeId);
      host.close().catch(() => {});
      for (const cb of this.#listeners) cb(nodeId);
    });
    return host;
  }

  /** `cb` runs when a node's host is dropped, so views re-render and ask `for` again (once the node is back online). */
  onClose(cb: (nodeId: string) => void): () => void {
    this.#listeners.add(cb);
    return () => { this.#listeners.delete(cb); };
  }
}

/**
 * The current value of a state member, re-rendering on every new one. Once its reference has ended (its node's socket
 * closed) the last value read stands in until the view re-renders without it.
 */
export function useValue<T>(readable: Readable<T>): T {
  const [, tick] = useState(0);
  const last = useRef<{ value: T } | undefined>(undefined);
  useEffect(() => readable.subscribe(() => tick((n) => n + 1)), [readable]);
  try {
    last.current = { value: readable.value };
  } catch (err) {
    if (last.current === undefined) throw err;
  }
  return last.current.value;
}

/** A reference held while the component is mounted (and released after), or why it could not be had. */
export function useObject<C extends AnyContract>(host: Host, contract: C, input: InputOf<C>): { ref?: Ref<C>; error?: string } {
  const key = JSON.stringify(input);
  const [state, setState] = useState<{ host: Host; key: string; ref?: Ref<C>; error?: string } | null>(null);
  useEffect(() => {
    let live = true;
    let held: { release(): void } | undefined;
    setState(null);
    host.get(contract, input).then(
      (ref) => {
        const releasable = ref as unknown as { release(): void };
        if (!live) return releasable.release();
        held = releasable;
        setState({ host, key, ref });
      },
      (err: unknown) => { if (live) setState({ host, key, error: errorText(err) }); },
    );
    return () => {
      live = false;
      held?.release();
    };
  }, [host, contract, key]);
  // A reference from a host (or input) no longer asked for is never handed out, not even for the render before the effect.
  if (state === null || state.host !== host || state.key !== key) return {};
  return { ref: state.ref, error: state.error };
}

/** Runs a method call, remembering whether one is in flight and its error. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (err) {
      setError(errorText(err));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
