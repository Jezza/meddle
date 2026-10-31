// `git-remote-meddle`: git's remote helper for `meddle://<nodeId>/<repo>` remotes. It offers only `connect`; once git
// asks to connect to `git-upload-pack` or `git-receive-pack` it pipes its stdio through this node's git socket to a
// `git` stream to the peer, where the service runs.
import type { Socket } from "bun";
import { shortId } from "../pool/identity";
import type { SocketHeader } from "./socket";
import { parseMeddleUrl, repoName } from "./wire";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
/** Bytes queued toward stdout past which the socket is not read until they are written. */
const HIGH_WATER = 1024 * 1024;

/** Lines off a byte stream, and the bytes after the last line read. */
class LineReader {
  private buf = new Uint8Array(0);
  private done = false;

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  /** The next line without its `\n`; null at end of input (an unterminated last line included). */
  async line(): Promise<string | null> {
    for (;;) {
      const at = this.buf.indexOf(10);
      if (at >= 0) {
        const line = decoder.decode(this.buf.subarray(0, at));
        this.buf = this.buf.slice(at + 1);
        return line;
      }
      const chunk = await this.read();
      if (chunk === null) {
        if (this.buf.length === 0) return null;
        const last = decoder.decode(this.buf);
        this.buf = new Uint8Array(0);
        return last;
      }
      const grown = new Uint8Array(this.buf.length + chunk.length);
      grown.set(this.buf);
      grown.set(chunk, this.buf.length);
      this.buf = grown;
    }
  }

  /** What is held past the last line, then each further read; null at end of input. */
  async chunk(): Promise<Uint8Array | null> {
    if (this.buf.length > 0) {
      const held = this.buf;
      this.buf = new Uint8Array(0);
      return held;
    }
    return this.read();
  }

  private async read(): Promise<Uint8Array | null> {
    if (this.done) return null;
    const { done, value } = await this.reader.read();
    if (done) {
      this.done = true;
      return null;
    }
    return value;
  }
}

type Conn = {
  /** Writes to stdout, in order. */
  writing: Promise<void>;
  queued: number;
  /** Bytes the peer sent. */
  received: number;
  drained: (() => void) | null;
  /** Settles once the peer's side ended (or the connection closed). */
  ended: PromiseWithResolvers<void>;
  closed: boolean;
};

/** Writes all of `bytes` to `socket`, waiting for `drain` after a partial write; false once the socket is gone. */
async function writeAll(socket: Socket<Conn>, bytes: Uint8Array): Promise<boolean> {
  let rest = bytes;
  while (rest.length > 0) {
    if (socket.data.closed) return false;
    const written = socket.write(rest);
    if (written < 0) return false;
    rest = rest.subarray(written);
    if (rest.length > 0) await new Promise<void>((wake) => { socket.data.drained = wake; });
  }
  return true;
}

/**
 * Runs the remote helper protocol for `url` on the given stdio: `capabilities` is answered `connect`; `connect
 * git-upload-pack` or `connect git-receive-pack` connects to `socketPath`, sends the header line, answers git's empty
 * line and pipes both ways until the peer's side ends; an empty line or the end of input quits. Anything else exits 1
 * with `unknown command`. Returns the exit code.
 */
export async function runRemoteHelper(args: {
  url: string; socketPath: string; stdin: ReadableStream<Uint8Array>; stdout: WritableStream<Uint8Array>; stderr: WritableStream<Uint8Array>;
}): Promise<number> {
  const input = args.stdin.getReader();
  const out = args.stdout.getWriter();
  const err = args.stderr.getWriter();
  const lines = new LineReader(input);
  const complain = (text: string) => err.write(encoder.encode(`${text}\n`));
  try {
    for (;;) {
      const line = await lines.line();
      if (line === null || line === "") return 0;
      if (line === "capabilities") {
        await out.write(encoder.encode("connect\n\n"));
        continue;
      }
      const service = /^connect git-(upload-pack|receive-pack)$/.exec(line)?.[1] as SocketHeader["service"] | undefined;
      if (service === undefined) {
        await complain(`meddle: unknown command: ${line}`);
        return 1;
      }
      return await connect(args, service, lines, out, complain);
    }
  } finally {
    await input.cancel().catch(() => {});
    await out.close().catch(() => {});
    await err.close().catch(() => {});
  }
}

async function connect(
  args: { url: string; socketPath: string },
  service: SocketHeader["service"],
  lines: LineReader,
  out: WritableStreamDefaultWriter<Uint8Array>,
  complain: (text: string) => Promise<void>,
): Promise<number> {
  let target: ReturnType<typeof parseMeddleUrl>;
  try {
    target = parseMeddleUrl(args.url);
  } catch {
    await complain(`meddle: bad meddle url ${args.url}`);
    return 1;
  }
  const conn: Conn = { writing: Promise.resolve(), queued: 0, received: 0, drained: null, ended: Promise.withResolvers(), closed: false };
  let socket: Socket<Conn>;
  try {
    socket = await Bun.connect<Conn>({
      unix: args.socketPath,
      allowHalfOpen: true,
      data: conn,
      socket: {
        data(s, chunk) {
          const bytes = Uint8Array.from(chunk);
          conn.received += bytes.length;
          conn.queued += bytes.length;
          if (conn.queued > HIGH_WATER) s.pause();
          conn.writing = conn.writing.then(async () => {
            await out.write(bytes).catch(() => {});
            conn.queued -= bytes.length;
            if (conn.queued <= HIGH_WATER && !conn.closed) s.resume();
          });
        },
        drain(s) {
          const wake = s.data.drained;
          s.data.drained = null;
          wake?.();
        },
        end() {
          conn.ended.resolve();
        },
        close() {
          conn.closed = true;
          conn.drained?.();
          conn.ended.resolve();
        },
        error() {
          conn.closed = true;
          conn.drained?.();
          conn.ended.resolve();
        },
      },
    } as Parameters<typeof Bun.connect<Conn>>[0]);
  } catch {
    await complain(`meddle: cannot reach this node's git socket at ${args.socketPath} (is "meddle serve" running?)`);
    return 1;
  }
  const header: SocketHeader = { node: target.nodeId, repo: repoName(target.repo), service };
  if (!(await writeAll(socket, encoder.encode(`${JSON.stringify(header)}\n`)))) {
    await complain(`meddle: this node's git socket at ${args.socketPath} closed the connection`);
    return 1;
  }
  await out.write(encoder.encode("\n"));
  // git's bytes to the peer; the end of git's side is passed on as a half-close.
  void (async () => {
    for (;;) {
      const chunk = await lines.chunk().catch(() => null);
      if (chunk === null) break;
      if (!(await writeAll(socket, chunk))) return;
    }
    if (!conn.closed) socket.shutdown();
  })();
  await conn.ended.promise;
  await conn.writing;
  socket.end();
  if (conn.received === 0) {
    await complain(`meddle: ${shortId(target.nodeId)} did not serve ${repoName(target.repo)} (offline, or it does not hold it)`);
    return 1;
  }
  return 0;
}
