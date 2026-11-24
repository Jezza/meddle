// src/engine/title.ts — a new task's title from its prompt: one short Claude Code query, on Haiku, with no tools.
import { mkdir } from "node:fs/promises";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { UserContent } from "../blobs/content";
import type { NodeConfig } from "../config";
import { inheritedEnv } from "./options";
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
  "stop, no preamble. Do not carry out the request. The request may come with files: each one's name, and the " +
  "images among them shown before it; a request of files alone is about what they show.";

/** A file on the prompt: its name, and when Haiku is shown it as an image, its type and bytes in base64. */
export type TitleFile = { name: string; image?: { type: string; data: string } };

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
 * Asks Haiku for a title for a task whose first prompt is `prompt` with `files` (their names, and their images shown
 * before the text, as a turn shows them): its reply as Claude Code gave it (unchecked: see `cleanTitle`), or null
 * when the query failed or took longer than `timeoutMs`. It runs in its own config dir
 * (`paths.titleConfig`), keeps no session and loads no settings, tools or MCP servers; it inherits what a turn does
 * (`inheritedEnv`), so it gets through the same proxy.
 */
export async function askTitle(prompt: string, deps: TitleDeps, files: readonly TitleFile[] = []): Promise<string | null> {
  const dir = paths(deps.cfg).titleConfig;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), deps.timeoutMs ?? TITLE_MS);
  const q = query({
    prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
      yield { type: "user", message: { role: "user", content: titleContent(prompt, files) }, parent_tool_use_id: null };
    })(),
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
        ...inheritedEnv(deps.cfg),
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

/** What Haiku is sent: the request's text, at most `PROMPT_CHARS` of it, and its files' names, after their images. */
function titleContent(prompt: string, files: readonly TitleFile[]): UserContent {
  let text = `<request>\n${Array.from(prompt).slice(0, PROMPT_CHARS).join("")}\n</request>`;
  if (files.length > 0) text += `\n<files>\n${files.map((f) => `- ${f.name}`).join("\n")}\n</files>`;
  const images: Exclude<UserContent, string> = [];
  for (const f of files) {
    // The type is one of the inline types, since only those are given as images.
    if (f.image === undefined) continue;
    images.push({ type: "image", source: { type: "base64", media_type: f.image.type as "image/png", data: f.image.data } });
  }
  return images.length === 0 ? text : [...images, { type: "text", text }];
}
