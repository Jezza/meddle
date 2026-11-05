import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

/** A text sent into a turn's input that Claude Code has not taken yet, by the uuid it was sent with. */
export type Untaken = { uuid: string; text: string };

/**
 * The streaming prompt of one turn: pushed texts become user messages, each with a uuid of its own. `"next"` is taken
 * into the running turn at its next chance (or starts the next turn); `"now"` interrupts the running turn for it.
 * Ending the queue closes the child's stdin. Every text pushed is `untaken` until `take` says Claude Code took it.
 */
export class InputQueue implements AsyncIterable<SDKUserMessage> {
  #items: SDKUserMessage[] = [];
  #ended = false;
  #untaken = new Map<string, string>();
  #wake: (() => void) | undefined;

  /** Queues `text`; answers the uuid it is sent with. */
  push(text: string, priority: "now" | "next" = "next"): string {
    if (this.#ended) throw new Error("input queue ended");
    const uuid = crypto.randomUUID();
    this.#untaken.set(uuid, text);
    this.#items.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: "", priority, uuid });
    this.#notify();
    return uuid;
  }

  /** Marks the text sent as `uuid` taken; answers it, or null when it was taken already or never sent here. */
  take(uuid: string): string | null {
    const text = this.#untaken.get(uuid);
    if (text === undefined) return null;
    this.#untaken.delete(uuid);
    return text;
  }

  /** The texts pushed and not taken, oldest first. */
  untaken(): Untaken[] {
    return [...this.#untaken].map(([uuid, text]) => ({ uuid, text }));
  }

  /** Whether `end()` was called: a push now throws. */
  get ended(): boolean {
    return this.#ended;
  }

  /** No more input; the iterator finishes once the queued messages are drained. Idempotent. */
  end(): void {
    this.#ended = true;
    this.#notify();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      const next = this.#items.shift();
      if (next !== undefined) { yield next; continue; }
      if (this.#ended) return;
      await new Promise<void>((resolve) => { this.#wake = resolve; });
    }
  }

  #notify(): void {
    const wake = this.#wake;
    this.#wake = undefined;
    wake?.();
  }
}
