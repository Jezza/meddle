import {
  Endpoint, EndpointAddr, LogLevel, presetMinimal, presetN0, setLogLevel,
  type BiStream, type Connection, type Incoming,
} from "@number0/iroh";
import type { NodeConfig } from "../config";
import { ALPN_POOL, StreamReader, parseHeader, writeLine, type StreamHeader } from "./frames";
import { endpointIdOf, hexOf, shortId, type Identity } from "./identity";
import type { WireAddr } from "./store";

let logLevelSet = false;

/** Binds this node's iroh endpoint, accepting the pool ALPN. */
export async function openEndpoint(cfg: Pick<NodeConfig, "irohPreset" | "irohBind">, identity: Identity): Promise<Endpoint> {
  if (!logLevelSet) {
    setLogLevel(LogLevel.Warn);
    logLevelSet = true;
  }
  const builder = Endpoint.builder();
  if (cfg.irohPreset === "n0") presetN0(builder);
  else presetMinimal(builder);
  builder.secretKey(Array.from(identity.secret));
  builder.alpns([ALPN_POOL]);
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
  /** This node's proof of the pool secret to `peerId`, or null when it has no secret: it then neither dials nor admits. */
  prove(peerId: string): string | null;
  /** Whether `proof` is `peerId`'s proof of this node's pool secret. */
  verify(peerId: string, proof: string): boolean;
  /**
   * Whether a dialer that proved the secret is let in (a removed node is not); a node not heard of before is recorded
   * as a member here. Consulted only after a valid proof.
   */
  admit(id: string): boolean;
  onError?(err: unknown): void;
  /** Redial delays, doubling from `initialMs` up to `maxMs`; default 1000 / 30000. */
  backoff?: { initialMs: number; maxMs: number };
  /** How long each side waits for the other's proof before giving the connection up; default 5000. */
  admitTimeoutMs?: number;
  /** The close reason a dialer that proved the secret but is not admitted is refused with; default `not a member`. */
  refusalReason?(id: string): RefusalReason;
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
/** What `closed()` resolves to when the peer closed with code 1: it refused or removed this node. */
const REFUSED = /^closed by peer: .* \(code 1\)$/;
/** The longest proof or verdict line either side reads, in bytes (a proof is 86 characters). */
const MAX_PROOF_LINE = 256;
/** The acceptor's verdict line after its proof when the dialer is let in; anything else is the refusal reason. */
const ADMITTED = "admitted";
/** How long a refusing acceptor waits for the dialer to close, so that its proof and verdict are read before the close. */
const LINGER_MS = 5000;
/** Text a peer chose (a close reason, a verdict), as it may appear in a log line: no control characters, bounded. */
function clean(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, "?").slice(0, 200);
}

/**
 * Why a peer is refused or cut off (code 1): `no pool secret` (this node has none), `bad proof` (the peer did not prove
 * this node's secret), `not a member`, or `removed`, which may carry when, as `removed <updatedAt>`.
 */
export type RefusalReason = "not a member" | "no pool secret" | "bad proof" | "removed" | `removed ${string}`;

/**
 * Reported when a peer that proved the pool secret closed a connection, or refused a dial: `reason` is what `closed()`
 * resolved to, or the refusal in that form (`closed by peer: <verdict> (code 1)`). Only a proved peer's word counts:
 * a connection closed before the peer proved itself is a `DialFailed`.
 */
export class PeerClosed extends Error {
  constructor(readonly peerId: string, readonly reason: string, message: string) {
    super(message);
  }
}

/** Reported when a dial attempt failed, or the peer neither admitted nor refused it within the bound. */
export class DialFailed extends Error {
  constructor(readonly peerId: string, message: string) {
    super(message);
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Resets a stream both ways: its opener's reads and writes fail. */
async function resetStream(stream: BiStream): Promise<void> {
  await stream.send.reset(0n).catch(() => {});
  await stream.recv.stop(0n).catch(() => {});
}

/**
 * Keeps one connection per member over ALPN_POOL and hands out streams on it. Of two members the one with the smaller
 * id dials (with backoff); the other only accepts. Each connection opens with proofs of the pool secret on a uni
 * stream each way: the dialer sends its proof first; the acceptor checks it (a dialer that proves nothing is closed
 * at once and told nothing), then answers with its own proof and a verdict, `admitted` (`deps.admit`) or the refusal
 * reason, and the dialer checks the proof before it believes the verdict: it counts the peer as online on `admitted`,
 * and reports a refusal as the peer's word (`PeerClosed`) only because the peer proved the secret first. A connection
 * about to be refused is never online on either side. Every bidirectional stream starts with a header line, and goes
 * to the `onStream` listener that takes its kind (reset when none does). Never logs: errors go to `deps.onError`.
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
  private readonly streamListeners = new Set<(s: PeerStream) => boolean>();
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
   * Closes any connection with the peer (inbound or outbound) with `reason`, and stops dialing it: code 1 for a
   * refusal (`removed…`, `not a member`), code 0 for `bye` (this node is leaving, not refusing the peer).
   */
  unwatch(peerId: string, reason: RefusalReason | "bye"): void {
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

  /**
   * `cb` sees every inbound stream (header read) and returns true when it took it, as its kind is the listener's; a
   * stream no listener takes is reset, so its opener fails instead of waiting for an answer.
   */
  onStream(cb: (s: PeerStream) => boolean): () => void {
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

  /** Hands `s` to the listeners until one takes it; resets it when none does. */
  private emitStream(s: PeerStream): void {
    for (const cb of [...this.streamListeners]) {
      try {
        if (cb(s)) return;
      } catch (err) {
        this.report(err);
      }
    }
    void resetStream(s.stream);
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

  /**
   * Completes one inbound handshake: reads the dialer's proof (a dialer that proves nothing, or when this node has no
   * secret, is closed at once with `bad proof` or `no pool secret`), then answers with this node's proof and its
   * verdict: `admitted`, with the dialer online here from that moment, or the refusal reason, after which this node
   * waits for the dialer to close (at most 5 s, so that the verdict is read) and closes with that reason.
   */
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
    const id = hexOf(conn.remoteId());
    const proof = alpn === POOL ? this.deps.prove(id) : null;
    const proved = proof !== null && (await this.dialerProved(conn, id));
    if (this.stopped) {
      conn.close(0n, bytes("bye"));
      return;
    }
    if (!proved) {
      conn.close(1n, bytes(proof === null ? "no pool secret" : "bad proof"));
      return;
    }
    const refusal = this.verdict(id);
    if (refusal === null) this.register(id, conn);
    try {
      const answer = await conn.openUni();
      await writeLine(answer, proof);
      await writeLine(answer, refusal ?? ADMITTED);
      await answer.finish();
    } catch {
      // The connection closed first; an admitted one's close is reported where it is tracked.
    }
    if (refusal === null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      conn.closed().then(() => {}, () => {}),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, LINGER_MS); }),
    ]);
    clearTimeout(timer);
    conn.close(1n, bytes(refusal));
  }

  /** Whether the dialer's proof (one line on its first uni stream, within the bound) is good. */
  private async dialerProved(conn: Connection, id: string): Promise<boolean> {
    const line = await this.readProof(conn);
    if (line === null) return false;
    try {
      return this.deps.verify(id, line);
    } catch (err) {
      this.report(err);
      return false;
    }
  }

  /** The refusal a dialer that proved the secret gets, or null when it is admitted. */
  private verdict(id: string): RefusalReason | null {
    try {
      if (this.deps.admit(id)) return null;
    } catch (err) {
      // Membership could not be checked: refuse rather than leave the dialer waiting for an admission.
      this.report(err);
      return "not a member";
    }
    return this.deps.refusalReason?.(id) ?? "not a member";
  }

  /** The first line of the connection's first uni stream, or null when none came within the bound or it closed. */
  private async readProof(conn: Connection): Promise<string | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const line = await Promise.race([
      conn.acceptUni().then((recv) => new StreamReader(recv).readLine(MAX_PROOF_LINE)).catch(() => null),
      conn.closed().then(() => null, () => null),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), this.admitTimeoutMs); }),
    ]);
    clearTimeout(timer);
    return line;
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
    const reason = clean(await link.closed.catch(messageOf));
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
      await resetStream(stream);
      return;
    }
    // The link was replaced (or dropped) while the header was read: nobody is to answer this stream.
    if (this.links.get(id) !== link) {
      await resetStream(stream);
      return;
    }
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
   * One dial attempt: the connection once this node's proof was sent and the peer's proof and verdict read, the proof
   * checked and the verdict `admitted`; or null (reported) when the dial failed, the peer's proof was bad (closed
   * `1 bad proof`, a `DialFailed`), no answer came within `admitTimeoutMs` (closed `0 bye`), the peer closed before
   * proving itself (a `DialFailed`: its reason is not its word), or the proved peer's verdict was a refusal (closed
   * `0 bye`, reported as a `PeerClosed` with the verdict).
   */
  private async connect(id: string): Promise<Connection | null> {
    const proof = this.deps.prove(id);
    if (proof === null) {
      this.report(new DialFailed(id, `dialing ${shortId(id)}: no pool secret`));
      return null;
    }
    let conn: Connection;
    try {
      conn = await this.endpoint.connect(toEndpointAddr(this.addrs.get(id) ?? { id, relay: null, direct: [] }), ALPN_POOL);
    } catch (err) {
      this.report(new DialFailed(id, `dialing ${shortId(id)}: ${messageOf(err)}`));
      return null;
    }
    try {
      const mine = await conn.openUni();
      await writeLine(mine, proof);
      await mine.finish();
    } catch (err) {
      conn.close(0n, bytes("bye"));
      this.report(new DialFailed(id, `sending the proof to ${shortId(id)}: ${messageOf(err)}`));
      return null;
    }
    /** The peer's proof and verdict lines, checked: the verdict only once the proof is good. */
    const answered = async (): Promise<"admitted" | "unproved" | { refusal: string }> => {
      const reader = new StreamReader(await conn.acceptUni());
      const proofLine = await reader.readLine(MAX_PROOF_LINE);
      let proved = false;
      try {
        proved = proofLine !== null && this.deps.verify(id, proofLine);
      } catch (err) {
        this.report(err);
      }
      if (!proved) return "unproved";
      const verdict = await reader.readLine(MAX_PROOF_LINE);
      return verdict === ADMITTED ? "admitted" : { refusal: verdict ?? "no verdict" };
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      answered().catch(() => "closed" as const),
      conn.closed().then(() => "closed" as const, () => "closed" as const),
      new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), this.admitTimeoutMs); }),
    ]);
    clearTimeout(timer);
    if (outcome === "admitted") return conn;
    if (outcome === "timeout") {
      conn.close(0n, bytes("bye"));
      this.report(new DialFailed(id, `${shortId(id)} did not admit the connection within ${this.admitTimeoutMs} ms`));
      return null;
    }
    if (outcome === "unproved") {
      conn.close(1n, bytes("bad proof"));
      this.report(new DialFailed(id, `${shortId(id)} did not prove the pool secret`));
      return null;
    }
    if (outcome === "closed") {
      const reason = await conn.closed().catch(messageOf);
      this.report(new DialFailed(id, `${shortId(id)} closed the connection before proving the pool secret: ${clean(reason)}`));
      return null;
    }
    conn.close(0n, bytes("bye"));
    const reason = `closed by peer: ${clean(outcome.refusal)} (code 1)`;
    this.report(new PeerClosed(id, reason, `${shortId(id)} refused the connection: ${reason}`));
    return null;
  }
}
