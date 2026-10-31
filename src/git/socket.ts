// The unix socket the `git-remote-meddle` helper reaches this node through: each connection names a peer, a repo and
// a git service in a header line, and from then on carries the raw pack protocol, piped both ways over a `git` stream
// to that peer.
import { existsSync } from "node:fs";
import { chmod, unlink } from "node:fs/promises";
import type { Socket, UnixSocketListener } from "bun";
import type { NodeConfig } from "../config";
import { paths } from "../paths";
import type { PeerStream, PoolNet } from "../pool/net";
import { isGitService, parseRepo, type GitHeader } from "./wire";

/** The longest header line a connection may open with, in bytes, without its newline. */
export const MAX_SOCKET_HEADER = 4096;
/** Bytes queued toward the peer past which the connection stops reading from the helper until they are sent. */
const HIGH_WATER = 1024 * 1024;
const NODE_ID = /^[0-9a-f]{64}$/;
const NEWLINE = 10;

/** What a connection says first: `{ node, repo, service }` as one JSON line. */
export type SocketHeader = { node: string; repo: string; service: GitHeader["service"] };

/** One helper's connection. */
type Conn = {
  /** The header bytes so far; null once the header was read. */
  head: Uint8Array | null;
  /** Bytes after the header that arrived before the stream was open. */
  early: Uint8Array[];
  stream: PeerStream | null;
  /** Writes toward the peer, in order. */
  sending: Promise<void>;
  /** Bytes queued on `sending`. */
  queued: number;
  /** The helper shut down its side: the peer is told once the queued bytes are sent. */
  ended: boolean;
  /** This side shut down its writing half: the peer finished its side of the stream. */
  shut: boolean;
  closed: boolean;
  /** Wakes the pump waiting for the socket to drain. */
  drained: (() => void) | null;
};

/** The header line's fields, or null when it is not a valid `{ node, repo, service }`. */
function parseSocketHeader(line: string): SocketHeader | null {
  try {
    const value = JSON.parse(line) as Partial<SocketHeader> | null;
    if (typeof value !== "object" || value === null) return null;
    const { node, repo, service } = value;
    if (typeof node !== "string" || !NODE_ID.test(node) || typeof repo !== "string" || !isGitService(service)) return null;
    parseRepo(repo);
    return { node, repo, service };
  } catch {
    return null;
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/**
 * Listens on `paths(cfg).gitSocket` (mode 600; a stale socket file is replaced, a live one is an error) and pipes
 * each connection to a `git` stream to the peer its header names. Writes to the helper honour partial writes and
 * `drain`; each direction is half-closed on its own when its source ends. Never logs: a connection that cannot be
 * served is closed, and git reports the hang-up.
 */
export class GitSocket {
  readonly path: string;
  private listener: UnixSocketListener<Conn> | null = null;
  private readonly conns = new Set<Socket<Conn>>();

  constructor(cfg: NodeConfig, private readonly net: PoolNet) {
    this.path = paths(cfg).gitSocket;
  }

  async start(): Promise<void> {
    if (this.listener) return;
    if (existsSync(this.path)) {
      const live = await Bun.connect({ unix: this.path, socket: { data() {} } }).then((s) => (s.end(), true), () => false);
      if (live) throw new Error(`another meddle already serves git at ${this.path}`);
      await unlink(this.path).catch(() => {});
    }
    const self = this;
    this.listener = Bun.listen<Conn>({
      unix: this.path,
      allowHalfOpen: true,
      socket: {
        open(socket) {
          socket.data = { head: new Uint8Array(0), early: [], stream: null, sending: Promise.resolve(), queued: 0, ended: false, shut: false, closed: false, drained: null };
          self.conns.add(socket);
        },
        data(socket, chunk) {
          self.received(socket, Uint8Array.from(chunk));
        },
        end(socket) {
          self.helperEnded(socket);
        },
        drain(socket) {
          const wake = socket.data.drained;
          socket.data.drained = null;
          wake?.();
        },
        close(socket, error) {
          self.closed(socket, error === undefined);
        },
        error(socket) {
          self.closed(socket, false);
        },
      },
    } as Parameters<typeof Bun.listen<Conn>>[0]);
    await chmod(this.path, 0o600);
  }

  /** Stops listening, cuts every connection (resetting its stream) and removes the socket file. */
  async stop(): Promise<void> {
    const listener = this.listener;
    if (!listener) return;
    this.listener = null;
    listener.stop(true);
    for (const socket of [...this.conns]) {
      this.closed(socket, false);
      socket.terminate();
    }
    await unlink(this.path).catch(() => {});
  }

  private received(socket: Socket<Conn>, chunk: Uint8Array): void {
    const conn = socket.data;
    if (conn.closed) return;
    if (conn.head !== null) {
      const head = concat(conn.head, chunk);
      const at = head.indexOf(NEWLINE);
      if (at < 0) {
        if (head.length > MAX_SOCKET_HEADER) socket.end();
        else conn.head = head;
        return;
      }
      conn.head = null;
      const header = at <= MAX_SOCKET_HEADER ? parseSocketHeader(new TextDecoder().decode(head.subarray(0, at))) : null;
      if (header === null) {
        socket.end();
        return;
      }
      if (at + 1 < head.length) conn.early.push(head.slice(at + 1));
      void this.open(socket, header);
      return;
    }
    if (conn.stream === null) conn.early.push(chunk);
    else this.forward(socket, chunk);
  }

  /** Opens the stream the header asks for, sends what arrived meanwhile, and pumps the peer's bytes to the helper. */
  private async open(socket: Socket<Conn>, header: SocketHeader): Promise<void> {
    const conn = socket.data;
    let stream: PeerStream;
    try {
      stream = await this.net.openStream(header.node, { stream: "git", repo: header.repo, service: header.service });
    } catch {
      socket.end();
      return;
    }
    if (conn.closed) {
      await stream.stream.send.reset(0n).catch(() => {});
      await stream.stream.recv.stop(0n).catch(() => {});
      return;
    }
    conn.stream = stream;
    for (const chunk of conn.early.splice(0)) this.forward(socket, chunk);
    if (conn.ended) this.finishSending(conn);
    await this.pump(socket, stream);
  }

  /** Queues `chunk` toward the peer, pausing the helper's side while too much is queued. */
  private forward(socket: Socket<Conn>, chunk: Uint8Array): void {
    const conn = socket.data;
    const stream = conn.stream!;
    conn.queued += chunk.length;
    if (conn.queued > HIGH_WATER) socket.pause();
    conn.sending = conn.sending.then(async () => {
      try {
        await stream.stream.send.writeAll(Array.from(chunk));
      } catch {
        // The peer stopped reading (its git process is done): what is left has nowhere to go.
      }
      conn.queued -= chunk.length;
      if (conn.queued <= HIGH_WATER && !conn.closed) socket.resume();
    });
  }

  private helperEnded(socket: Socket<Conn>): void {
    const conn = socket.data;
    conn.ended = true;
    if (conn.stream !== null) this.finishSending(conn);
    else if (conn.head !== null) socket.end();
    this.closeWhenDone(socket);
  }

  private finishSending(conn: Conn): void {
    const stream = conn.stream!;
    conn.sending = conn.sending.then(() => stream.stream.send.finish().catch(() => {}));
  }

  /** The peer's bytes to the helper, honouring partial writes; then this side's writing half is shut down. */
  private async pump(socket: Socket<Conn>, stream: PeerStream): Promise<void> {
    const conn = socket.data;
    for (;;) {
      const chunk = await stream.reader.readChunk();
      if (chunk === null || conn.closed) break;
      let rest = chunk;
      while (rest.length > 0 && !conn.closed) {
        const written = socket.write(rest);
        if (written < 0) break;
        rest = rest.subarray(written);
        if (rest.length > 0) await new Promise<void>((wake) => { conn.drained = wake; });
      }
    }
    if (conn.closed) return;
    socket.shutdown();
    conn.shut = true;
    this.closeWhenDone(socket);
  }

  /** Both halves are done: the connection is closed. */
  private closeWhenDone(socket: Socket<Conn>): void {
    const conn = socket.data;
    if (conn.ended && conn.shut && !conn.closed) void conn.sending.then(() => socket.end());
  }

  /**
   * The connection is gone. Closed cleanly before the helper's end was seen, what it sent is complete and the peer is
   * told so; after an error the stream's sending half is reset. The peer's bytes have nowhere to go any more.
   */
  private closed(socket: Socket<Conn>, clean: boolean): void {
    const conn = socket.data;
    this.conns.delete(socket);
    if (conn.closed) return;
    conn.closed = true;
    conn.drained?.();
    conn.drained = null;
    const stream = conn.stream;
    if (stream === null) return;
    if (!conn.ended) {
      conn.ended = true;
      if (clean) this.finishSending(conn);
      else conn.sending = conn.sending.then(() => stream.stream.send.reset(0n).catch(() => {}));
    }
    if (!conn.shut) void stream.stream.recv.stop(0n).catch(() => {});
  }
}
