// A stream a node opens to itself (a checkout on this machine fetching from its own node): two in-memory pipes shaped
// like the iroh streams the pool's listeners read and write, so a stream to this node is served as a peer's would be.
import type { BiStream, RecvStream, SendStream } from "@number0/iroh";

/** Bytes queued in one direction past which a write waits for the reader. */
const HIGH_WATER = 1024 * 1024;

/** One direction: what one end writes (`writeAll`, `finish`, `reset`), the other reads (`read`, `stop`). */
class Pipe {
  private chunks: number[][] = [];
  private queued = 0;
  private finished = false;
  private reset = false;
  private stopped = false;
  private wakeReader: (() => void) | null = null;
  private wakeWriters: Array<() => void> = [];

  private readerWake(): void {
    const wake = this.wakeReader;
    this.wakeReader = null;
    wake?.();
  }

  private writersWake(): void {
    for (const wake of this.wakeWriters.splice(0)) wake();
  }

  async writeAll(buf: number[]): Promise<void> {
    if (this.finished || this.reset) throw new Error("stream closed");
    if (this.stopped) throw new Error("stream stopped by peer");
    if (buf.length === 0) return;
    this.chunks.push(buf);
    this.queued += buf.length;
    this.readerWake();
    while (this.queued > HIGH_WATER && !this.stopped && !this.reset) await new Promise<void>((wake) => this.wakeWriters.push(wake));
  }

  async write(buf: number[]): Promise<number> {
    await this.writeAll(buf);
    return buf.length;
  }

  async finish(): Promise<void> {
    this.finished = true;
    this.readerWake();
  }

  async resetSend(): Promise<void> {
    this.reset = true;
    this.chunks = [];
    this.queued = 0;
    this.readerWake();
    this.writersWake();
  }

  /** Up to `limit` bytes; an empty array once the writer finished and everything was read. Rejects after a reset. */
  async read(limit: number): Promise<number[]> {
    for (;;) {
      if (this.reset || this.stopped) throw new Error("stream reset");
      const first = this.chunks[0];
      if (first !== undefined) {
        const out = first.length <= limit ? this.chunks.shift()! : first.splice(0, limit);
        this.queued -= out.length;
        if (this.queued <= HIGH_WATER) this.writersWake();
        return out;
      }
      if (this.finished) return [];
      await new Promise<void>((wake) => { this.wakeReader = wake; });
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.chunks = [];
    this.queued = 0;
    this.readerWake();
    this.writersWake();
  }
}

function sendOf(pipe: Pipe): SendStream {
  return {
    writeAll: (buf: number[]) => pipe.writeAll(buf),
    write: (buf: number[]) => pipe.write(buf),
    finish: () => pipe.finish(),
    reset: () => pipe.resetSend(),
  } as unknown as SendStream;
}

function recvOf(pipe: Pipe): RecvStream {
  return {
    read: (limit: number) => pipe.read(limit),
    stop: () => pipe.stop(),
  } as unknown as RecvStream;
}

/** Two ends of one in-memory bidirectional stream: what one sends, the other receives. */
export function loopbackPair(): [BiStream, BiStream] {
  const there = new Pipe();
  const back = new Pipe();
  return [
    { send: sendOf(there), recv: recvOf(back) } as unknown as BiStream,
    { send: sendOf(back), recv: recvOf(there) } as unknown as BiStream,
  ];
}
