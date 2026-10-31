import type { RecvStream, SendStream } from "@number0/iroh";

/*
 * Framing over the iroh bindings' QUIC streams. Verified behaviour of @number0/iroh@1.2.0:
 * - `RecvStream.read(n)` resolves an empty array at the end of a finished stream; `readExact` past the end rejects
 *   with `FinishedEarly(0)`.
 * - A stream the peer reset delivers its buffered bytes first; a later read rejects.
 * - After the peer closed the connection, reads still return buffered data and `writeAll` succeeds silently: only
 *   `Connection.closed()` reports the close, as `closed by peer: <reason> (code N)`.
 * Stream payloads are `Array<number>`.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The ALPN of member-to-member connections: bytes of "meddle/0". */
export const ALPN_POOL: number[] = Array.from(encoder.encode("meddle/0"));
/** The ALPN of join requests: bytes of "meddle/join/0". */
export const ALPN_JOIN: number[] = Array.from(encoder.encode("meddle/join/0"));
/** The longest line (header or otherwise) a reader accepts, in bytes, without its terminator. */
export const MAX_LINE = 65_536;
/** The largest frame payload, in bytes. */
export const MAX_FRAME = 16 * 1024 * 1024;

/** The JSON line every bidirectional stream begins with. */
export type StreamHeader = { stream: string } & Record<string, unknown>;

const READ_CHUNK = 65_536;
const NEWLINE = 10;
/** A frame is 1 byte kind, 4 bytes big-endian payload length, then the payload. */
const FRAME_HEAD = 5;

/** Reads lines and frames from one receive stream. A read error ends the stream: nothing partial is delivered. */
export class StreamReader {
  private buf = new Uint8Array(READ_CHUNK);
  private start = 0;
  private end = 0;
  private ended = false;

  constructor(private readonly recv: RecvStream) {}

  /** The next `\n`-terminated line without its terminator; null at end of stream. Rejects "line exceeds <max> bytes". */
  async readLine(max: number = MAX_LINE): Promise<string | null> {
    for (;;) {
      const at = this.buf.subarray(this.start, this.end).indexOf(NEWLINE);
      if (at > max || (at < 0 && this.end - this.start > max)) throw new Error(`line exceeds ${max} bytes`);
      if (at >= 0) {
        const line = decoder.decode(this.take(at));
        this.start += 1;
        return line;
      }
      if (!(await this.fill())) return null;
    }
  }

  /** Exactly `n` bytes, or null when the stream ends first. */
  async readExact(n: number): Promise<Uint8Array | null> {
    while (this.end - this.start < n) {
      if (!(await this.fill())) return null;
    }
    return this.take(n);
  }

  /** The next frame, or null at end of stream. Rejects "frame exceeds 16777216 bytes". */
  async readFrame(): Promise<{ kind: number; data: Uint8Array } | null> {
    const head = await this.readExact(FRAME_HEAD);
    if (head === null) return null;
    const length = new DataView(head.buffer, head.byteOffset, FRAME_HEAD).getUint32(1);
    if (length > MAX_FRAME) throw new Error(`frame exceeds ${MAX_FRAME} bytes`);
    const data = await this.readExact(length);
    return data === null ? null : { kind: head[0]!, data };
  }

  /**
   * The bytes held after a line or frame read, if any; otherwise the stream's next read. Null at end of stream. Raw
   * byte streams (git's pack protocol) read with this after their header line.
   */
  async readChunk(): Promise<Uint8Array | null> {
    if (this.end === this.start && !(await this.fill())) return null;
    return this.take(this.end - this.start);
  }

  private take(n: number): Uint8Array {
    const out = this.buf.slice(this.start, this.start + n);
    this.start += n;
    return out;
  }

  /** Appends the next chunk to the buffer; false once the stream has ended (finished, reset or failed). */
  private async fill(): Promise<boolean> {
    if (this.ended) return false;
    let chunk: number[];
    try {
      chunk = await this.recv.read(READ_CHUNK);
    } catch {
      chunk = [];
    }
    if (chunk.length === 0) {
      this.ended = true;
      return false;
    }
    if (this.start === this.end) {
      // Empty: start over at the front, and drop a buffer a big frame left behind.
      this.start = this.end = 0;
      if (this.buf.length > 4 * READ_CHUNK) this.buf = new Uint8Array(READ_CHUNK);
    }
    const held = this.end - this.start;
    if (this.end + chunk.length > this.buf.length) {
      const room = held + chunk.length;
      if (room > this.buf.length) {
        const grown = new Uint8Array(Math.max(room, this.buf.length * 2));
        grown.set(this.buf.subarray(this.start, this.end));
        this.buf = grown;
      } else {
        this.buf.copyWithin(0, this.start, this.end);
      }
      this.start = 0;
      this.end = held;
    }
    this.buf.set(chunk, this.end);
    this.end += chunk.length;
    return true;
  }
}

export function writeLine(send: SendStream, text: string): Promise<void> {
  return send.writeAll(Array.from(encoder.encode(`${text}\n`)));
}

export function writeFrame(send: SendStream, kind: number, data: Uint8Array): Promise<void> {
  if (data.length > MAX_FRAME) return Promise.reject(new Error(`frame exceeds ${MAX_FRAME} bytes`));
  const out = new Uint8Array(FRAME_HEAD + data.length);
  const view = new DataView(out.buffer);
  view.setUint8(0, kind);
  view.setUint32(1, data.length);
  out.set(data, FRAME_HEAD);
  return send.writeAll(Array.from(out));
}

/** Parses a stream's header line; throws "bad stream header" unless it is a JSON object with a string `stream`. */
export function parseHeader(line: string): StreamHeader {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("bad stream header");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("bad stream header");
  if (typeof (value as { stream?: unknown }).stream !== "string") throw new Error("bad stream header");
  return value as StreamHeader;
}
