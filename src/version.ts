import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pkg from "../package.json";

export const VERSION: string = pkg.version;

/** The Claude Code version the Agent SDK bundles: its package's `manifest.json` `version`. */
export function claudeCodeVersion(): string {
  const dir = dirname(fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk")));
  return (JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { version: string }).version;
}
