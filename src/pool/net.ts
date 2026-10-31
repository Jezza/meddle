import {
  Endpoint, EndpointAddr, LogLevel, presetMinimal, presetN0, setLogLevel,
  type BiStream, type Connection, type Incoming,
} from "@number0/iroh";
import type { NodeConfig } from "../config";
import { ALPN_JOIN, ALPN_POOL, StreamReader, parseHeader, writeLine, type StreamHeader } from "./frames";
import { endpointIdOf, hexOf, shortId, type Identity } from "./identity";
import type { WireAddr } from "./store";

let logLevelSet = false;

/** Binds this node's iroh endpoint, accepting the pool and join ALPNs. */
export async function openEndpoint(cfg: Pick<NodeConfig, "irohPreset" | "irohBind">, identity: Identity): Promise<Endpoint> {
  if (!logLevelSet) {
    setLogLevel(LogLevel.Warn);
    logLevelSet = true;
  }
  const builder = Endpoint.builder();
  if (cfg.irohPreset === "n0") presetN0(builder);
  else presetMinimal(builder);
  builder.secretKey(Array.from(identity.secret));
  builder.alpns([ALPN_POOL, ALPN_JOIN]);
  if (cfg.irohBind !== null) builder.bindAddr(cfg.irohBind);
  return builder.bind();
}

export function toEndpointAddr(addr: WireAddr): EndpointAddr {
  return new EndpointAddr(endpointIdOf(addr.id), addr.relay, addr.direct);
}

/** This endpoint's own address. */
export function fromEndpoint(endpoint: Endpoint): WireAddr {
  const addr = endpoint.addr();
  return { id: hexOf(endpoint.id()), relay: addr.relayUrl(), direct: addr.directAddresses() };
}

/** The address this endpoint last used for `id`, or null when it has never been in contact. */
export async function remoteAddrOf(endpoint: Endpoint, id: string): Promise<WireAddr | null> {
  const addr = await endpoint.remoteAddr(endpointIdOf(id));
  return addr === null ? null : { id, relay: addr.relayUrl(), direct: addr.directAddresses() };
}

export type PeerStream = {
  peerId: string; header: StreamHeader; stream: BiStream; reader: StreamReader;
  /** Settles when the connection the stream rides on is closed (with iroh's reason string). */
  closed: Promise<string>;
};

export type NetDeps = {
  endpoint: Endpoint;
  selfId: string;
  isMember(id: string): boolean;
  /** A connection on ALPN_JOIN. */
  onJoin(conn: Connection): Promise<void>;
  onError?(err: unknown): void;
  /** Redial delays, doubling from `initialMs` up to `maxMs`; default 1000 / 30000. */
  backoff?: { initialMs: number; maxMs: number };
  /** How long a dialer waits for the acceptor to admit or refuse a connection before giving up on it; default 5000. */
  admitTimeoutMs?: number;
  /** Why a dialer that is not a member is refused (consulted only then); default `not a member`. */
  refusalReason?(id: string): "removed" | "not a member";
};

/** The connection held with a peer; `closed` is its one `conn.closed()` promise, shared by its streams. */
type Link = { conn: Connection; closed: Promise<string> };

/** A running dial loop for one peer. */
type Dial = {
  /** Ends the current backoff pause at once. */
  wake(): void;
  /** An address arrived: the next attempt goes without waiting. */
  kicked: boolean;
  /** Set when the loop must end; a connection it completes afterwards is closed with this. */
  cancel: { code: bigint; reason: string } | null;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bytes = (text: string) => Array.from(encoder.encode(text));
const POOL = decoder.decode(Uint8Array.from(ALPN_POOL));
const JOIN = decoder.decode(Uint8Array.from(ALPN_JOIN));
/** What `closed()` resolves to when the peer closed with code 1: it refused or removed this node. */
const REFUSED = /^closed by peer: .* \(code 1\)$/;

/** Reported when a peer closed a connection, or refused a dial: `reason` is what `closed()` resolved to. */
export class PeerClosed extends Error {
  constructor(readonly peerId: string, readonly reason: string, message: string) {
    super(message);
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Keeps one connection per member over ALPN_POOL and hands out streams on it. Of two members the one with the smaller
 * id dials (with backoff); the other only accepts. The acceptor admits a dialer by opening a uni stream and finishing
 * it, so a dialer counts as online only once admitted, never for a connection about to be refused. Every bidirectional
 * stream starts with a header line. Never logs: errors go to `deps.onError`.
 */
export class PoolNet {
  readonly endpoint: Endpoint;
  private readonly backoff: { initialMs: number; maxMs: number };
  private readonly admitTimeoutMs: number;
  private readonly watched = new Set<string>();
  private readonly addrs = new Map<string, WireAddr>();
  private readonly links = new Map<string, Link>();
  private readonly dials = new Map<string, Dial>();
  private readonly tasks = new Set<Promise<void>>();
  private readonly peerListeners = new Set<(peerId: string, online: boolean) => void>();
  private readonly streamListeners = new Set<(s: PeerStream) => void>();
  private started = false;
  private stopped = false;

  constructor(private readonly deps: NetDeps) {
    this.endpoint = deps.endpoint;
    this.backoff = deps.backoff ?? { initialMs: 1000, maxMs: 30_000 };
    this.admitTimeoutMs = deps.admitTimeoutMs ?? 5000;
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.track(this.acceptLoop());
    for (const id of this.watched) this.dial(id, 0);
  }

  /** Closes every connection (code 0, `bye`), ends the loops and closes the endpoint. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const d of this.dials.values()) {
      d.cancel = { code: 0n, reason: "bye" };
      d.wake();
    }
    this.dials.clear();
    for (const [id, link] of [...this.links]) {
      this.links.delete(id);
      link.conn.close(0n, bytes("bye"));
      this.emitPeer(id, false);
    }
    if (!this.endpoint.isClosed()) await this.endpoint.close();
    await Promise.all([...this.tasks]);
  }

  /** Keeps a connection to a member: dials (when selfId < peerId) with backoff, accepts otherwise. */
  watch(peerId: string): void {
    this.watched.add(peerId);
    this.dial(peerId, 0);
  }

  /**
   * Closes any connection with the peer (inbound or outbound) with `reason`, and stops dialing it: code 1 for
   * `removed` and `not a member`, code 0 for `bye` (this node is leaving, not refusing the peer).
   */
  unwatch(peerId: string, reason: "removed" | "not a member" | "bye"): void {
    const code = reason === "bye" ? 0n : 1n;
    this.watched.delete(peerId);
    const d = this.dials.get(peerId);
    if (d) {
      this.dials.delete(peerId);
      d.cancel = { code, reason };
      d.wake();
    }
    const link = this.links.get(peerId);
    if (link) {
      this.links.delete(peerId);
      link.conn.close(code, bytes(reason));
      this.emitPeer(peerId, false);
    }
  }

  /** Remembers an address and, when watching and offline, dials at once. */
  offerAddress(addr: WireAddr): void {
    this.addrs.set(addr.id, addr);
    const d = this.dials.get(addr.id);
    if (d) {
      d.kicked = true;
      d.wake();
    } else {
      this.dial(addr.id, 0);
    }
  }

  isOnline(peerId: string): boolean {
    return this.links.has(peerId);
  }

  online(): string[] {
    return [...this.links.keys()];
  }

  onPeer(cb: (peerId: string, online: boolean) => void): () => void {
    this.peerListeners.add(cb);
    return () => this.peerListeners.delete(cb);
  }

  onStream(cb: (s: PeerStream) => void): () => void {
    this.streamListeners.add(cb);
    return () => this.streamListeners.delete(cb);
  }

  async openStream(peerId: string, header: StreamHeader): Promise<PeerStream> {
    const link = this.links.get(peerId);
    if (!link) throw new Error(`not connected to ${shortId(peerId)}`);
    const stream = await link.conn.openBi();
    await writeLine(stream.send, JSON.stringify(header));
    return { peerId, header, stream, reader: new StreamReader(stream.recv), closed: link.closed };
  }

  /** Keeps a running task (its failure reported) so that `stop()` can wait for the ones still running. */
  private track(task: Promise<void>): void {
    const settled = task.catch((err: unknown) => this.report(err));
    this.tasks.add(settled);
    void settled.then(() => this.tasks.delete(settled));
  }

  private report(err: unknown): void {
    if (!this.stopped) this.deps.onError?.(err);
  }

  private emitPeer(peerId: string, online: boolean): void {
    for (const cb of [...this.peerListeners]) {
      try {
        cb(peerId, online);
      } catch (err) {
        this.report(err);
      }
    }
  }

  private emitStream(s: PeerStream): void {
    for (const cb of [...this.streamListeners]) {
      try {
        cb(s);
      } catch (err) {
        this.report(err);
      }
    }
  }

  private async acceptLoop(): Promise<void> {
    for (;;) {
      let incoming: Incoming | null;
      try {
        incoming = await this.endpoint.acceptNext();
      } catch (err) {
        this.report(err);
        return;
      }
      if (!incoming) return;
      this.track(this.admit(incoming));
    }
  }

  /** Completes one inbound handshake and routes it by ALPN; pool connections from non-members are closed at once. */
  private async admit(incoming: Incoming): Promise<void> {
    let conn: Connection;
    try {
      conn = await (await incoming.accept()).connect();
    } catch (err) {
      this.report(err);
      return;
    }
    if (this.stopped) {
      conn.close(0n, bytes("bye"));
      return;
    }
    const alpn = decoder.decode(Uint8Array.from(conn.alpn()));
    if (alpn === JOIN) {
      Promise.resolve().then(() => this.deps.onJoin(conn)).catch((err) => this.report(err));
      return;
    }
    const id = hexOf(conn.remoteId());
    let member = false;
    let refusal: "removed" | "not a member" = "not a member";
    try {
      member = alpn === POOL && this.deps.isMember(id);
      if (!member && alpn === POOL) refusal = this.deps.refusalReason?.(id) ?? "not a member";
    } catch (err) {
      // Membership could not be checked: refuse rather than leave the dialer waiting for an admission.
      this.report(err);
    }
    if (!member) {
      conn.close(1n, bytes(refusal));
      return;
    }
    this.register(id, conn);
    try {
      const admitted = await conn.openUni();
      await admitted.finish();
    } catch {
      // The connection closed first; its close is reported where it is tracked.
    }
  }

  /** Makes `conn` the peer's connection, replacing (code 0, `duplicate`) any it had. */
  private register(id: string, conn: Connection): void {
    const old = this.links.get(id);
    if (old) {
      this.links.delete(id);
      old.conn.close(0n, bytes("duplicate"));
      this.emitPeer(id, false);
    }
    const link: Link = { conn, closed: conn.closed() };
    this.links.set(id, link);
    this.emitPeer(id, true);
    this.track(this.acceptStreams(id, link));
    this.track(this.untilClosed(id, link));
  }

  private async untilClosed(id: string, link: Link): Promise<void> {
    const reason = await link.closed.catch(messageOf);
    if (REFUSED.test(reason)) this.report(new PeerClosed(id, reason, `${shortId(id)} closed the connection: ${reason}`));
    if (this.links.get(id) !== link) return;
    this.links.delete(id);
    this.emitPeer(id, false);
    this.dial(id, this.backoff.initialMs);
  }

  private async acceptStreams(id: string, link: Link): Promise<void> {
    for (;;) {
      let stream: BiStream;
      try {
        stream = await link.conn.acceptBi();
      } catch {
        return;
      }
      this.track(this.receive(id, link, stream));
    }
  }

  /** Reads an inbound stream's header and hands it on; a bad header resets the stream. */
  private async receive(id: string, link: Link, stream: BiStream): Promise<void> {
    const reader = new StreamReader(stream.recv);
    let header: StreamHeader;
    try {
      const line = await reader.readLine();
      if (line === null) return;
      header = parseHeader(line);
    } catch (err) {
      this.report(new Error(`stream from ${shortId(id)}: ${messageOf(err)}`));
      await stream.send.reset(0n).catch(() => {});
      await stream.recv.stop(0n).catch(() => {});
      return;
    }
    if (this.links.get(id) !== link) return;
    this.emitStream({ peerId: id, header, stream, reader, closed: link.closed });
  }

  private dialsTo(id: string): boolean {
    return this.started && !this.stopped && this.watched.has(id) && this.deps.selfId < id;
  }

  /** Starts a dial loop for `id` unless one runs, it is online, or this node does not dial it. */
  private dial(id: string, firstDelayMs: number): void {
    if (!this.dialsTo(id) || this.links.has(id) || this.dials.has(id)) return;
    const d: Dial = { wake: () => {}, kicked: false, cancel: null };
    this.dials.set(id, d);
    this.track(this.dialLoop(id, d, firstDelayMs));
  }

  private async dialLoop(id: string, d: Dial, firstDelayMs: number): Promise<void> {
    let wait = firstDelayMs;
    let delay = this.backoff.initialMs;
    try {
      for (;;) {
        if (d.kicked) wait = 0;
        d.kicked = false;
        if (wait > 0) await this.pause(d, wait);
        if (d.cancel || this.links.has(id)) return;
        const conn = await this.connect(id);
        // Set by unwatch() or stop() while the attempt was in flight.
        const cancel = d.cancel as Dial["cancel"];
        if (cancel) {
          conn?.close(cancel.code, bytes(cancel.reason));
          return;
        }
        if (conn) {
          this.register(id, conn);
          return;
        }
        wait = delay;
        delay = Math.min(delay * 2, this.backoff.maxMs);
      }
    } finally {
      if (this.dials.get(id) === d) this.dials.delete(id);
    }
  }

  private pause(d: Dial, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        d.wake = () => {};
        resolve();
      };
      const timer = setTimeout(done, ms);
      d.wake = done;
    });
  }

  /**
   * One dial attempt: the connection once the peer admitted it, or null (reported) when it failed, was refused, or
   * was neither admitted nor refused within `admitTimeoutMs` (then it is closed `0 bye`).
   */
  private async connect(id: string): Promise<Connection | null> {
    let conn: Connection;
    try {
      conn = await this.endpoint.connect(toEndpointAddr(this.addrs.get(id) ?? { id, relay: null, direct: [] }), ALPN_POOL);
    } catch (err) {
      this.report(new Error(`dialing ${shortId(id)}: ${messageOf(err)}`));
      return null;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      conn.acceptUni().then(() => "admitted" as const, () => "closed" as const),
      conn.closed().then(() => "closed" as const, () => "closed" as const),
      new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), this.admitTimeoutMs); }),
    ]);
    clearTimeout(timer);
    if (outcome === "admitted") return conn;
    if (outcome === "timeout") {
      conn.close(0n, bytes("bye"));
      this.report(new Error(`${shortId(id)} did not admit the connection within ${this.admitTimeoutMs} ms`));
      return null;
    }
    const reason = await conn.closed().catch(messageOf);
    this.report(new PeerClosed(id, reason, `${shortId(id)} refused the connection: ${reason}`));
    return null;
  }
}
