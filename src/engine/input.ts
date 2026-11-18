import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Prompt } from "../blobs/attachment";
import type { UserContent } from "../blobs/content";

/** A prompt sent into a turn's input that Claude Code has not taken yet, by the uuid it was sent with. */
export type Untaken = { uuid: string; prompt: Prompt };

/**
 * The streaming prompt of one turn: pushed prompts become user messages, each with a uuid of its own. `"next"` is taken
 * into the running turn at its next chance (or starts the next turn); `"now"` interrupts the running turn for it.
 * Ending the queue closes the child's stdin. Every prompt pushed is `untaken` until `take` says Claude Code took it.
 */
export class InputQueue implements AsyncIterable<SDKUserMessage> {
  #items: SDKUserMessage[] = [];
  #ended = false;
  #untaken = new Map<string, Prompt>();
  #wake: (() => void) | undefined;
  /** The reader has an item and has not come back for the next one yet. */
  #reading = false;
  #writtenWaiters: (() => void)[] = [];

  /**
   * Queues `prompt`; answers the uuid it is sent with. Claude Code is sent `content` (the prompt's text unless given
   * another, say with its images inline); the prompt itself, with its attachments' refs, is what `take` and `untaken`
   * hand back for the log.
   */
  push(prompt: Prompt, priority: "now" | "next" = "next", content: UserContent = prompt.text): string {
    if (this.#ended) throw new Error("input queue ended");
    const uuid = crypto.randomUUID();
    this.#untaken.set(uuid, prompt);
    this.#items.push({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: "", priority, uuid });
    this.#notify();
    return uuid;
  }

  /** Marks the prompt sent as `uuid` taken; answers it, or null when it was taken already or never sent here. */
  take(uuid: string): Prompt | null {
    const prompt = this.#untaken.get(uuid);
    if (prompt === undefined) return null;
    this.#untaken.delete(uuid);
    return prompt;
  }

  /**
   * Withdraws the prompt sent as `uuid`: `"dropped"` when the reader had not read it yet, so it is gone from the input;
   * `"written"` when it is untaken but already read (only Claude Code can give it back now); `"gone"` when it is not
   * untaken (taken, dropped, or never sent here).
   */
  drop(uuid: string): "dropped" | "written" | "gone" {
    if (!this.#untaken.has(uuid)) return "gone";
    const at = this.#items.findIndex((item) => item.uuid === uuid);
    if (at === -1) return "written";
    this.#items.splice(at, 1);
    this.#untaken.delete(uuid);
    this.#tellWritten();
    return "dropped";
  }

  /** The prompts pushed and not taken, oldest first. */
  untaken(): Untaken[] {
    return [...this.#untaken].map(([uuid, prompt]) => ({ uuid, prompt }));
  }

  /**
   * Resolves once every prompt pushed so far is written to Claude Code, or there is no more input. The SDK writes a
   * message before it reads the next, so a prompt is written once the reader has come back past it.
   */
  written(): Promise<void> {
    if (this.#isWritten()) return Promise.resolve();
    return new Promise((resolve) => this.#writtenWaiters.push(resolve));
  }

  /** Whether `end()` was called: a push now throws. */
  get ended(): boolean {
    return this.#ended;
  }

  /** No more input; the iterator finishes once the queued messages are drained. Idempotent. */
  end(): void {
    this.#ended = true;
    this.#notify();
    this.#tellWritten();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      const next = this.#items.shift();
      if (next !== undefined) {
        this.#reading = true;
        yield next;
        this.#reading = false;
        this.#tellWritten();
        continue;
      }
      if (this.#ended) return;
      await new Promise<void>((resolve) => { this.#wake = resolve; });
    }
  }

  #isWritten(): boolean {
    return this.#ended || (this.#items.length === 0 && !this.#reading);
  }

  #tellWritten(): void {
    if (!this.#isWritten()) return;
    for (const resolve of this.#writtenWaiters.splice(0)) resolve();
  }

  #notify(): void {
    const wake = this.#wake;
    this.#wake = undefined;
    wake?.();
  }
}
