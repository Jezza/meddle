// src/update/gate.ts — the input gate of a node whose new build awaits confirmation: from its database copy until the
// pool confirms or rolls back, anything it accepted would be wiped by a rollback's restore, so it accepts nothing.
import { readPending, type UpdateFiles } from "./files";

/** What input is refused with while a swap is in progress on this node. */
export function inputRefusal(build: string): string {
  return `update in progress (build ${build}), try again shortly`;
}

/**
 * Why this node accepts no input now, read from its files: a swap is in progress (`pending.json`, from just before the
 * database copy until the rollout is confirmed or rolled back), or null. What the CLI checks before it writes, also
 * while the node is down for the swap.
 */
export async function inputHeld(files: UpdateFiles): Promise<string | null> {
  const p = await readPending(files);
  return p === null ? null : inputRefusal(p.build);
}

/**
 * Why a running node accepts no input now: once its updater has started, whatever the updater says (null once the
 * rollout is confirmed or rolled back); before that, held if it started on a build awaiting confirmation (`awaiting`).
 */
export function nodeInputHold(
  updater: { inputHold(): string | null } | undefined,
  awaiting: { build: string } | null,
): string | null {
  if (updater !== undefined) return updater.inputHold();
  return awaiting === null ? null : inputRefusal(awaiting.build);
}

/**
 * The methods of a served object's implementation, each refused while `hold` gives a reason (the reason is the
 * error); everything else in `impl` (its cells) as it is. Every method is gated, so one added later is too.
 */
export function gated<T extends object>(impl: T, hold: (() => string | null) | undefined): T {
  if (hold === undefined) return impl;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(impl)) {
    if (typeof value !== "function") {
      out[key] = value;
      continue;
    }
    const method = value as (...args: unknown[]) => unknown;
    out[key] = (...args: unknown[]) => {
      const why = hold();
      if (why !== null) return Promise.reject(new Error(why));
      return method.apply(impl, args);
    };
  }
  return out as T;
}
