// src/embedded.ts — what `bun run build` packs into the single binary: the dashboard, the service unit's template and
// the Claude Code it pins (and, built with --embed-claude, Claude Code itself). Run from a checkout, nothing is
// embedded and each is read from the checkout instead.
import type { ClaudePin } from "./claude-code";

export type Embedded = {
  /**
   * Claude Code's native binary inside the binary's own virtual filesystem (`/$bunfs/…`, where it cannot run), for a
   * build with --embed-claude; null when the node downloads it (`ensureClaude`).
   */
  claude: string | null;
  /** The Claude Code the build pinned, from the Agent SDK's manifest. */
  claudeCode: ClaudePin;
  /** The dashboard's `index.html` and its bundled script. */
  html: string;
  script: string;
  /** `install/meddle.service`. */
  unit: string;
};

let current: Embedded | null = null;

/** Called once by the compiled binary's entry, before the CLI runs (and by tests, null undoing it). */
export function embed(files: Embedded | null): void {
  current = files;
}

/** What this binary embeds, or null when it runs from a checkout. */
export function embedded(): Embedded | null {
  return current;
}
