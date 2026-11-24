// Claude Code's own peer messaging, as the pinned Claude Code (2.1.328) speaks it: each session registers itself in its
// config dir's `sessions` (`<pid>.json`, with the Unix socket it listens on, and `<pid>.<sha256 of that path>.key`
// holding the token a peer authenticates with), and takes a message written to that socket as one from another
// session: it runs it in its turn, or starts a turn for it when idle. Started with `--messaging-socket-path`, it listens
// where told and keeps each message's `uuid`, which it reports the message's progress by.
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";

/** Where a session listens for messages, and the token it takes them with (null: it published none). */
export type PeerSocket = { path: string; token: string | null };

/**
 * A message's text as Claude Code's own senders wrap it: the receiving model reads `from` as the address to reply to,
 * here the sending task's id.
 */
export function envelope(fromTaskId: string, text: string): string {
  return `<cross-session-message from="${fromTaskId}">\n${text}\n</cross-session-message>`;
}

/** Whether process `pid` is alive (one of another user's counts). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The session listening at `path`, registered in `dir`, or null while there is none: the key it published for that
 * path (`<pid>.<sha256 of path>.key`), from a process that is alive and has written its entry (`<pid>.json`).
 */
async function lookUp(dir: string, path: string): Promise<PeerSocket | null> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return null;
  }
  const suffix = `.${createHash("sha256").update(path).digest("hex")}.key`;
  for (const file of files) {
    if (!file.endsWith(suffix)) continue;
    const pid = Number(file.slice(0, -suffix.length));
    if (!Number.isInteger(pid) || pid <= 0 || !alive(pid) || !files.includes(`${pid}.json`)) continue;
    try {
      const { peerToken } = JSON.parse(await readFile(join(dir, file), "utf8")) as { peerToken?: unknown };
      return { path, token: typeof peerToken === "string" ? peerToken : null };
    } catch {
      continue; // being written, or gone
    }
  }
  return null;
}

/**
 * The session listening at socket `path` (meddle starts each task's Claude Code with `--messaging-socket-path`), once
 * it has registered in `sessionsDir`: looked for every `pollMs` (100) until `timeoutMs` (30 s), then rejected with
 * `messaging socket never registered`. A key whose process is gone is never answered. Rejects on `signal`.
 */
export async function findSocket(
  sessionsDir: string,
  path: string,
  opts: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal } = {},
): Promise<PeerSocket> {
  const { timeoutMs = 30_000, pollMs = 100, signal } = opts;
  const until = Date.now() + timeoutMs;
  for (;;) {
    signal?.throwIfAborted();
    const found = await lookUp(sessionsDir, path);
    if (found !== null) return found;
    if (Date.now() >= until) throw new Error("messaging socket never registered");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, pollMs);
      function done() {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      }
      signal?.addEventListener("abort", done, { once: true });
    });
  }
}

/** How long a write may take, connecting to closing, before it is given up. */
const WRITE_MS = 10_000;

/**
 * Writes one message to session socket `sock`: the auth line when it has a token, then the message, sent as `uuid`
 * (Claude Code reports it by that uuid as it queues, starts and completes it) from `from` (`uds:<path>`: where Claude
 * Code sends its receipts). Resolves once the socket closed after the write; rejects when it cannot be written, or
 * takes longer than `timeoutMs` (10 s) from connecting to closing.
 */
export function writePeerLine(
  sock: PeerSocket, line: { uuid: string; from: string; content: string }, opts: { timeoutMs?: number } = {},
): Promise<void> {
  const auth = sock.token === null ? "" : `${JSON.stringify({ type: "auth", token: sock.token })}\n`;
  const message = JSON.stringify({
    msgV: 1, msg_id: line.uuid, uuid: line.uuid, type: "user", priority: "next", from: line.from,
    message: { role: "user", content: line.content },
  });
  return new Promise((resolve, reject) => {
    const c = connect(sock.path);
    let settled = false;
    const settle = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err === undefined) resolve();
      else {
        c.destroy();
        reject(err);
      }
    };
    const timer = setTimeout(() => settle(new Error(`timed out writing to ${sock.path}`)), opts.timeoutMs ?? WRITE_MS);
    c.on("error", (err) => settle(err));
    c.on("connect", () => { c.end(`${auth}${message}\n`); });
    c.on("close", () => settle());
  });
}
