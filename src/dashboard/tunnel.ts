// The dashboard tunnel: a browser's socket on one node piped over an iroh `dashboard` stream to another node, which
// accepts it as one more dashboard link. Tunnel frames are `frames.ts` frames: kind 0 a text message, kind 1 binary.
import { webSocketLink, type Host, type WebSocketLike } from "@earendil-works/chord";
import { writeFrame } from "../pool/frames";
import type { PeerStream, PoolNet } from "../pool/net";
import type { BunSocketShim } from "./ws-shim";

/** Every dashboard link (local or tunnelled) acts as this principal. */
export const DASHBOARD_PRINCIPAL = "local";

const TEXT = 0;
const BINARY = 1;
const OPEN = 1;
const CLOSED = 3;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type Listener = (event: { readonly data: unknown }) => void;
type EventType = "open" | "message" | "close" | "error";

/** A message as a tunnel frame: a string is text, bytes are binary; anything else is not a message. */
function frameOf(data: unknown): { kind: number; bytes: Uint8Array } | null {
  if (typeof data === "string") return { kind: TEXT, bytes: encoder.encode(data) };
  if (ArrayBuffer.isView(data)) return { kind: BINARY, bytes: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
  return null;
}

/** A tunnel frame as a message: a string for text, a Uint8Array for binary; null for an unknown kind. */
function messageOf(frame: { kind: number; data: Uint8Array }): string | Uint8Array | null {
  if (frame.kind === TEXT) return decoder.decode(frame.data);
  if (frame.kind === BINARY) return frame.data;
  return null;
}

/** Finishes the stream's send side once `writes` are out, and stops reading it. */
function finish(peer: PeerStream, writes: Promise<unknown>): void {
  const { send, recv } = peer.stream;
  void writes.then(() => send.finish()).catch(() => {});
  void recv.stop(0n).catch(() => {});
}

/** A `WebSocketLike` over a PeerStream: frames in are messages, `send` writes frames (serialised), `close` finishes the stream. */
export class IrohSocketShim implements WebSocketLike {
  #listeners: Record<EventType, Set<Listener>> = { open: new Set(), message: new Set(), close: new Set(), error: new Set() };
  #state = OPEN;
  #started = false;
  /** Every write goes through this chain, so frames never interleave and leave in order. */
  #writes: Promise<void> = Promise.resolve();

  constructor(private readonly peer: PeerStream) {}

  get readyState(): number {
    return this.#state;
  }

  send(data: string | Uint8Array): void {
    if (this.#state !== OPEN) return;
    const frame = frameOf(data);
    if (frame === null) return;
    const send = this.peer.stream.send;
    this.#writes = this.#writes.then(() => writeFrame(send, frame.kind, frame.bytes)).catch(() => this.#end());
  }

  close(_code?: number, _reason?: string): void {
    this.#end();
  }

  addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
  addEventListener(type: "open" | "close" | "error", listener: () => void): void;
  addEventListener(type: EventType, listener: Listener): void {
    this.#listeners[type].add(listener);
  }

  /** The read loop; dispatches "message" per frame and "close" once at EOF, error or `stream.closed`. */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    const connection = this.peer.closed.then(() => {}, () => {});
    void Promise.race([this.#readLoop(), connection]).then(() => this.#end());
  }

  async #readLoop(): Promise<void> {
    for (;;) {
      let frame: { kind: number; data: Uint8Array } | null;
      try {
        frame = await this.peer.reader.readFrame();
      } catch {
        return;
      }
      if (frame === null || this.#state !== OPEN) return;
      const data = messageOf(frame);
      if (data === null) return;
      for (const listener of this.#listeners.message) listener({ data });
    }
  }

  /** Marks the socket closed, finishes the stream once queued frames are out, and dispatches "close" once. */
  #end(): void {
    if (this.#state === CLOSED) return;
    this.#state = CLOSED;
    finish(this.peer, this.#writes);
    for (const listener of this.#listeners.close) listener({ data: undefined });
  }
}

/** Accepts every `dashboard` stream a member opens as a browser-grade link on `host`. Returns the unsubscribe. */
export function acceptDashboardStreams(net: PoolNet, host: Host, isMember: (id: string) => boolean): () => void {
  return net.onStream((s) => {
    if (s.header.stream !== "dashboard") return;
    if (!isMember(s.peerId)) {
      void s.stream.send.reset(0n).catch(() => {});
      void s.stream.recv.stop(0n).catch(() => {});
      return;
    }
    const shim = new IrohSocketShim(s);
    // As `acceptWebSockets` does for a browser: large payloads go out deflated, and packed frames are not accepted.
    host.accept(webSocketLink(shim, { compress: true, acceptPacked: false }), { principal: DASHBOARD_PRINCIPAL, kind: "client" });
    shim.start();
  });
}

/** Pipes a browser's socket to a `dashboard` stream on `peerId` until either side closes. Never rejects. */
export async function bridgeSocket(socket: BunSocketShim, net: PoolNet, peerId: string): Promise<void> {
  let done = false;
  const ended = Promise.withResolvers<void>();
  let browserOpen = true;
  socket.addEventListener("close", () => {
    browserOpen = false;
    ended.resolve();
  });

  const opening = net.openStream(peerId, { stream: "dashboard" });
  // Messages the browser sends while the stream opens wait for it, in order.
  let writes: Promise<unknown> = opening.catch(() => {});
  socket.addEventListener("message", (event) => {
    if (done) return;
    const frame = frameOf(event.data);
    if (frame === null) return;
    writes = writes
      .then(async () => writeFrame((await opening).stream.send, frame.kind, frame.bytes))
      .catch(() => ended.resolve());
  });

  let peer: PeerStream | undefined;
  try {
    peer = await opening;
  } catch {
    // Gone offline since the route checked: the tunnel ends before it began.
  }
  if (peer !== undefined && browserOpen) {
    const stream = peer;
    const pump = async () => {
      for (;;) {
        let frame: { kind: number; data: Uint8Array } | null;
        try {
          frame = await stream.reader.readFrame();
        } catch {
          return;
        }
        if (frame === null || done) return;
        const data = messageOf(frame);
        if (data === null) return;
        socket.send(data);
      }
    };
    await Promise.race([pump(), stream.closed.then(() => {}, () => {}), ended.promise]);
  }
  done = true;
  if (peer !== undefined) finish(peer, writes);
  if (browserOpen) socket.close(1011, "tunnel closed");
}
