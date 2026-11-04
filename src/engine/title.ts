// src/engine/title.ts — a new task's title from its prompt: one short Claude Code query, on Haiku, with no tools.
import { mkdir } from "node:fs/promises";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { NodeConfig } from "../config";
import { jjEnv } from "../jj";
import { paths } from "../paths";

/** The model that names tasks: an alias, so it follows the newest Haiku. */
export const TITLE_MODEL = "haiku";

/** How long naming a task may take before the prompt's first line names it instead. */
const TITLE_MS = 20_000;

/** How much of a prompt Haiku is shown: a title needs its gist, not all of a long paste. */
const PROMPT_CHARS = 4_000;

const SYSTEM_PROMPT =
  "You name tasks. Given a request someone made of a coding agent, reply with a short title for it: at most six " +
  "words, in sentence case, saying what the task is about. Reply with the title alone: no quotes, no trailing full " +
  "stop, no preamble. Do not carry out the request.";

export type TitleDeps = {
  cfg: NodeConfig;
  /** The login token the query runs with. */
  token: string;
  claudePath?: string;
  claudeRuntime?: "bun" | "node";
  extraEnv?: Record<string, string>;
  /** Default `TITLE_MS`. */
  timeoutMs?: number;
};

/**
 * Asks Haiku for a title for a task whose first prompt is `prompt`: its reply as Claude Code gave it (unchecked: see
 * `cleanTitle`), or null when the query failed or took longer than `timeoutMs`. It runs in its own config dir
 * (`paths.titleConfig`), keeps no session and loads no settings, tools or MCP servers.
 */
export async function askTitle(prompt: string, deps: TitleDeps): Promise<string | null> {
  const dir = paths(deps.cfg).titleConfig;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const meddle = jjEnv(deps.cfg);
  const env: Record<string, string> = {};
  for (const name of ["PATH", "HOME"]) {
    const value = meddle[name];
    if (value !== undefined) env[name] = value;
  }
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), deps.timeoutMs ?? TITLE_MS);
  const q = query({
    prompt: `<request>\n${Array.from(prompt).slice(0, PROMPT_CHARS).join("")}\n</request>`,
    options: {
      cwd: dir,
      model: TITLE_MODEL,
      systemPrompt: SYSTEM_PROMPT,
      settingSources: [],
      tools: [],
      strictMcpConfig: true,
      maxTurns: 1,
      persistSession: false,
      abortController,
      env: {
        ...env,
        ...deps.cfg.poolEnv,
        CLAUDE_CONFIG_DIR: dir,
        CLAUDE_CODE_OAUTH_TOKEN: deps.token,
        ENABLE_CLAUDEAI_MCP_SERVERS: "false",
        ...deps.extraEnv,
      },
      ...(deps.claudePath === undefined
        ? {}
        : { pathToClaudeCodeExecutable: deps.claudePath, executable: deps.claudeRuntime ?? "bun" }),
    },
  });
  try {
    for await (const m of q) {
      if (m.type !== "result") continue;
      return m.subtype === "success" && !m.is_error ? m.result : null;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    q.close();
  }
}
