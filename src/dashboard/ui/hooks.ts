// chord references and state members as Preact hooks.
import { useEffect, useRef, useState } from "preact/hooks";
import { createHost, webSocketLink, type AnyContract, type Host, type InputOf, type Readable, type Ref } from "@earendil-works/chord";

/** A socket to the node the page came from at `path` (`/ws`, `/ws/node/<nodeId>`). */
export function nodeSocket(path: string): WebSocket {
  return new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${path}`);
}

/** A chord client host whose upstream is `socket`; `onMismatch` runs when the far side speaks another link protocol. */
export function clientHost(socket: WebSocket, onMismatch: () => void): Host {
  return createHost({
    name: "browser",
    self: "browser",
    kind: "client",
    upstream: { link: webSocketLink(socket), principal: "node", onProtocolMismatch: onMismatch },
  });
}

/** What a node's host is doing: none yet (`idle`), its socket opening or open, waiting to retry, or never again. */
export type HostStatus = "idle" | "connecting" | "open" | "backoff" | "incompatible";

/** What one connection attempt reports back to `Hosts`. */
export type HostEvents = { opened(): void; closed(): void; mismatch(): void };

export type HostsDeps = {
  /** Opens a host to `nodeId`, reporting its socket's open and close and a protocol mismatch through `events`. */
  connect(nodeId: string, events: HostEvents): Host;
  now(): number;
  schedule(fn: () => void, ms: number): void;
};

const BACKOFF_FIRST_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
/** A socket open at least this long counts as a success: the next failure backs off from the start again. */
const STABLE_MS = 10_000;

/** The browser's `HostsDeps`: a socket to `/ws/node/<nodeId>` and a client host over it. */
const browserDeps: HostsDeps = {
  connect(nodeId, events) {
    const socket = nodeSocket(`/ws/node/${encodeURIComponent(nodeId)}`);
    socket.addEventListener("open", () => events.opened());
    socket.addEventListener("close", () => events.closed());
    return clientHost(socket, () => events.mismatch());
  },
  now: () => Date.now(),
  schedule: (fn, ms) => { setTimeout(fn, ms); },
};

type Entry =
  | { status: "connecting" | "open"; host: Host; openedAt: number | null; failures: number }
  | { status: "backoff" | "idle"; failures: number }
  | { status: "incompatible" };

/**
 * One client host per node, created on first use over `/ws/node/<nodeId>` and dropped when its socket closes. A dropped
 * node waits out a backoff (1 s doubling to 30 s, from the start again after a socket stayed open 10 s) before `for`
 * opens another; a node whose link protocol differs is `incompatible` and never retried. `onChange` tells the views to
 * re-render whenever a node's status changes.
 */
export class Hosts {
  readonly #entries = new Map<string, Entry>();
  readonly #listeners = new Set<(nodeId: string) => void>();
  readonly #deps: HostsDeps;

  constructor(readonly selfId: string, readonly selfHost: Host, deps: Partial<HostsDeps> = {}) {
    this.#deps = { ...browserDeps, ...deps };
  }

  /** The host for `nodeId` (the `/ws` host for this node), opened now if need be; undefined while it may not be. */
  for(nodeId: string): Host | undefined {
    if (nodeId === this.selfId) return this.selfHost;
    const entry = this.#entries.get(nodeId);
    if (entry?.status === "connecting" || entry?.status === "open") return entry.host;
    if (entry?.status === "backoff" || entry?.status === "incompatible") return undefined;
    return this.#connect(nodeId, entry?.failures ?? 0);
  }

  status(nodeId: string): HostStatus {
    if (nodeId === this.selfId) return "open";
    return this.#entries.get(nodeId)?.status ?? "idle";
  }

  /** `cb` runs whenever a node's status changes, so views re-render and ask `for` again. Returns the unsubscribe. */
  onChange(cb: (nodeId: string) => void): () => void {
    this.#listeners.add(cb);
    return () => { this.#listeners.delete(cb); };
  }

  #connect(nodeId: string, failures: number): Host {
    let entry: Entry | undefined;
    const current = () => entry !== undefined && this.#entries.get(nodeId) === entry;
    const host = this.#deps.connect(nodeId, {
      opened: () => {
        if (!current() || entry!.status !== "connecting") return;
        this.#set(nodeId, (entry = { ...entry!, status: "open", openedAt: this.#deps.now() }));
      },
      closed: () => {
        if (!current()) return;
        const was = entry as Extract<Entry, { host: Host }>;
        const stable = was.openedAt !== null && this.#deps.now() - was.openedAt >= STABLE_MS;
        this.#backoff(nodeId, was.host, stable ? 0 : was.failures);
      },
      mismatch: () => {
        if (!current()) return;
        (entry as Extract<Entry, { host: Host }>).host.close().catch(() => {});
        this.#set(nodeId, { status: "incompatible" });
      },
    });
    entry = { status: "connecting", host, openedAt: null, failures };
    this.#entries.set(nodeId, entry);
    return host;
  }

  #backoff(nodeId: string, host: Host, failures: number): void {
    host.close().catch(() => {});
    const entry = { status: "backoff", failures: failures + 1 } as const;
    this.#set(nodeId, entry);
    const delay = Math.min(BACKOFF_FIRST_MS * 2 ** failures, BACKOFF_MAX_MS);
    this.#deps.schedule(() => {
      if (this.#entries.get(nodeId) === entry) this.#set(nodeId, { status: "idle", failures: entry.failures });
    }, delay);
  }

  #set(nodeId: string, entry: Entry): void {
    this.#entries.set(nodeId, entry);
    this.#notify(nodeId);
  }

  #notify(nodeId: string): void {
    for (const cb of this.#listeners) cb(nodeId);
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
