import type { PeerPrompt } from "../blobs/attachment";
import { envelope, writePeerLine, type PeerSocket } from "./peer-socket";

/** How long a written message may go untaken before the inbox counts it failed (`PeerInbox.failed`). */
const START_MS = 30_000;

/**
 * The messages from other tasks' agents written into one turn's Claude Code through its own socket (`peer-socket.ts`),
 * by the uuid each is sent with. Each is written in push order once `locate` found the session's socket, and stays
 * `untaken` until `take` says Claude Code took it (its `command_lifecycle`): a turn that ends without taking one hands
 * it back. `failed` settles on the first thing that keeps one from being taken: the socket not found, a write that
 * failed, a receipt that says it was dropped (`fail`), or a written message untaken after `startMs`. `replyTo` names
 * the socket Claude Code sends its receipts to, given the session's.
 */
export class PeerInbox {
  readonly #locate: (signal: AbortSignal) => Promise<PeerSocket>;
  readonly #replyTo: (socket: PeerSocket) => string;
  readonly #startMs: number;
  readonly #untaken = new Map<string, PeerPrompt>();
  readonly #queued = new Set<string>();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #stop = new AbortController();
  #socket: Promise<PeerSocket> | undefined;
  #writes: Promise<void> = Promise.resolve();
  #ended = false;
  #settle!: (err: Error) => void;
  #settled = false;
  /** Settles (never rejects) with why a message could not be taken; at most once. */
  readonly failed: Promise<Error>;

  constructor(locate: (signal: AbortSignal) => Promise<PeerSocket>, replyTo: (socket: PeerSocket) => string, opts: { startMs?: number } = {}) {
    this.#locate = locate;
    this.#replyTo = replyTo;
    this.#startMs = opts.startMs ?? START_MS;
    this.failed = new Promise((resolve) => { this.#settle = resolve; });
  }

  /** Writes message `p` into the turn after those pushed before it; answers the uuid it is sent with. */
  push(p: PeerPrompt): string {
    const uuid = crypto.randomUUID();
    this.#untaken.set(uuid, p);
    this.#writes = this.#writes.then(() => this.#write(uuid, p));
    return uuid;
  }

  async #write(uuid: string, p: PeerPrompt): Promise<void> {
    // (Written even after an earlier message failed: in a turn with a prompt, a failure ends nothing.)
    if (this.#ended) return;
    try {
      this.#socket ??= this.#locate(this.#stop.signal);
      const socket = await this.#socket;
      if (this.#ended) return;
      await writePeerLine(socket, { uuid, from: `uds:${this.#replyTo(socket)}`, content: envelope(p.peer.taskId, p.text) });
    } catch (err) {
      this.#fail(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    if (this.#ended || !this.#untaken.has(uuid)) return;
    this.#timers.set(uuid, setTimeout(() => {
      if (this.#untaken.has(uuid)) this.#fail(new Error("the message was not taken"));
    }, this.#startMs));
  }

  /** Claude Code said it queued the message sent as `uuid`. */
  noteQueued(uuid: string): void {
    if (this.#untaken.has(uuid)) this.#queued.add(uuid);
  }

  /** Whether Claude Code said it queued the message sent as `uuid` and has not taken it. */
  queued(uuid: string): boolean {
    return this.#queued.has(uuid);
  }

  /** Marks the message sent as `uuid` taken; answers it, or null when it was taken already or never sent here. */
  take(uuid: string): PeerPrompt | null {
    const p = this.#untaken.get(uuid);
    if (p === undefined) return null;
    this.#untaken.delete(uuid);
    this.#queued.delete(uuid);
    clearTimeout(this.#timers.get(uuid));
    this.#timers.delete(uuid);
    return p;
  }

  /** A receipt said the message sent as `uuid` will not be taken (`reason`): `failed` settles with it. */
  fail(uuid: string, reason: string): void {
    if (this.#untaken.has(uuid)) this.#fail(new Error(reason));
  }

  /** The messages pushed and not taken, oldest first. */
  untaken(): Array<{ uuid: string; prompt: PeerPrompt }> {
    return [...this.#untaken].map(([uuid, prompt]) => ({ uuid, prompt }));
  }

  /** No more writes: a locate still looking is stopped, and nothing pushed is written after this. Idempotent. */
  end(): void {
    this.#ended = true;
    this.#stop.abort();
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
  }

  #fail(err: Error): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#settle(err);
  }
}
