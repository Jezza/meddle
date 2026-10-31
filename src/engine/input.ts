import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

/**
 * The streaming prompt of one turn: pushed texts become user messages. `"now"` steers the running
 * turn; `"next"` is a follow-up. Ending the queue closes the child's stdin.
 */
export class InputQueue implements AsyncIterable<SDKUserMessage> {
  #items: SDKUserMessage[] = [];
  #ended = false;
  #wake: (() => void) | undefined;

  push(text: string, priority: "now" | "next" = "next"): void {
    if (this.#ended) throw new Error("input queue ended");
    this.#items.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: "", priority });
    this.#notify();
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
