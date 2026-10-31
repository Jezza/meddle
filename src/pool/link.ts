import type { Frame, Link } from "@earendil-works/chord";
import { MAX_FRAME, writeLine } from "./frames";
import type { PeerStream } from "./net";

/** Sees every frame line a link sends (`out`) or receives (`in`), without its terminator. */
export type LinkTap = (direction: "in" | "out", text: string) => void;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Parses a frame line; anything that is not a JSON object with a string `t` is a protocol error. */
function parseFrame(line: string): Frame {
  const frame = JSON.parse(line) as unknown;
  if (frame === null || typeof frame !== "object" || typeof (frame as { t?: unknown }).t !== "string") {
    throw new TypeError("not a frame");
  }
  return frame as Frame;
}

/**
 * A chord Link over a PeerStream: one JSON frame per line. Mirrors chord's BaseLink (dist/link.js): frames are queued
 * until `receive` sets the handler, `close` sends a `bye`, an incoming `bye` ends the link with its reason, and close
 * handlers run once. The link also ends when the stream ends, a read or write fails, or the connection closes.
 */
export class IrohLink implements Link {
  private handler: ((frame: Frame) => void) | undefined;
  private queue: Frame[] = [];
  private readonly closeHandlers = new Set<(reason: string) => void>();
  private done = false;
  /** Every write goes through this chain, so lines never interleave and leave in order. */
  private writes: Promise<void> = Promise.resolve();
  private readonly tap: LinkTap | undefined;

  constructor(private readonly peer: PeerStream, options: { tap?: LinkTap } = {}) {
    this.tap = options.tap;
    // Nothing in `run` is expected to reject; should a close handler throw, the link still ends and the process lives.
    void this.run().catch((err: unknown) => {
      try {
        this.end(`link failed: ${messageOf(err)}`);
      } catch {
        // A close handler threw again: the link is marked done either way.
      }
    });
  }

  get closed(): boolean {
    return this.done;
  }

  send(frame: Frame): number | undefined {
    if (this.done) return undefined;
    return this.transmit(frame);
  }

  receive(handler: (frame: Frame) => void): void {
    this.handler = handler;
    for (const frame of this.queue.splice(0)) handler(frame);
  }

  onClose(handler: (reason: string) => void): void {
    if (this.done) handler("closed");
    else this.closeHandlers.add(handler);
  }

  close(reason = "closed"): void {
    if (this.done) return;
    this.transmit({ t: "bye", reason });
    this.end(reason);
  }

  /** Queues one line; a failed write ends the link. Returns the line's length. */
  private transmit(frame: Frame): number {
    const text = JSON.stringify(frame);
    this.tap?.("out", text);
    const send = this.peer.stream.send;
    this.writes = this.writes
      .then(() => writeLine(send, text))
      .catch((err: unknown) => this.end(`write failed: ${messageOf(err)}`));
    return text.length + 1;
  }

  private deliver(frame: Frame): void {
    if (this.done) return;
    if (frame.t === "bye") {
      this.end(frame.reason ?? "peer closed");
      return;
    }
    if (this.handler === undefined) this.queue.push(frame);
    else this.handler(frame);
  }

  /** Reads until the stream or the connection ends; whichever comes first ends the link with its reason. */
  private async run(): Promise<void> {
    const connection = this.peer.closed.then(
      (reason) => `connection closed: ${reason}`,
      (err: unknown) => `connection closed: ${messageOf(err)}`,
    );
    this.end(await Promise.race([this.readLoop(), connection]));
  }

  private async readLoop(): Promise<string> {
    for (;;) {
      let line: string | null;
      try {
        line = await this.peer.reader.readLine(MAX_FRAME);
      } catch (err) {
        return `read failed: ${messageOf(err)}`;
      }
      if (line === null || this.done) return "closed";
      this.tap?.("in", line);
      let frame: Frame;
      try {
        frame = parseFrame(line);
      } catch {
        this.close("protocol error");
        return "protocol error";
      }
      this.deliver(frame);
    }
  }

  /** Marks the link closed, finishes the stream once queued writes are out, and notifies the close handlers once. */
  private end(reason: string): void {
    if (this.done) return;
    this.done = true;
    this.queue = [];
    const { send, recv } = this.peer.stream;
    this.writes = this.writes.then(() => send.finish()).catch(() => {});
    void recv.stop(0n).catch(() => {});
    for (const handler of this.closeHandlers) handler(reason);
    this.closeHandlers.clear();
  }
}
