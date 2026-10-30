import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";

export type PendingApproval = {
  requestId: string;
  taskId: string;
  toolName: string;
  input: Record<string, unknown>;
  toolUseId: string;
  decisionReason?: string;
  askedAt: string;
};

type Entry = { request: PendingApproval; resolve: (result: PermissionResult) => void };

/** Tool-permission requests waiting on an answer from the dashboard. */
export class Approvals {
  #entries = new Map<string, Entry>();
  #listeners = new Set<() => void>();

  /**
   * Parks a request until `answer` is called with its id. If `signal` aborts first (the SDK gave up
   * on the request), the entry is dropped and the promise resolves with a deny.
   */
  ask(req: Omit<PendingApproval, "askedAt">, signal?: AbortSignal): Promise<PermissionResult> {
    if (signal?.aborted) return Promise.resolve({ behavior: "deny", message: "interrupted" });
    return new Promise((resolve) => {
      const onAbort = () => {
        if (this.#entries.get(req.requestId) !== entry) return;
        this.#entries.delete(req.requestId);
        this.#changed();
        resolve({ behavior: "deny", message: "interrupted" });
      };
      const entry: Entry = {
        request: { ...req, askedAt: new Date().toISOString() },
        resolve: (result) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(result);
        },
      };
      this.#entries.set(req.requestId, entry);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#changed();
    });
  }

  /** Answers a pending request; `false` if no request has that id. */
  answer(requestId: string, result: PermissionResult): boolean {
    const entry = this.#entries.get(requestId);
    if (entry === undefined) return false;
    this.#entries.delete(requestId);
    entry.resolve(result);
    this.#changed();
    return true;
  }

  pending(taskId?: string): PendingApproval[] {
    return [...this.#entries.values()]
      .map((e) => e.request)
      .filter((r) => taskId === undefined || r.taskId === taskId);
  }

  /** Calls `cb` whenever a request is added or removed; returns an unsubscribe function. */
  onChange(cb: () => void): () => void {
    this.#listeners.add(cb);
    return () => { this.#listeners.delete(cb); };
  }

  #changed(): void {
    for (const cb of [...this.#listeners]) cb();
  }
}
