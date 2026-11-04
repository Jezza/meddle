import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pkg from "../package.json";
import { embedded } from "./embedded";

export const VERSION: string = pkg.version;

/**
 * The Claude Code version this node runs: in the single binary, the one embedded in it; from a checkout, the Agent
 * SDK's `manifest.json` `version`, or `"unknown"` when that cannot be read.
 */
export function claudeCodeVersion(): string {
  const packed = embedded();
  if (packed !== null) return packed.claudeCode.version;
  try {
    const dir = dirname(fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk")));
    return (JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { version: string }).version;
  } catch {
    return "unknown";
  }
}
