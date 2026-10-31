import type {
  CanUseTool,
  McpServerConfig,
  Options,
  PermissionDeniedHookInput,
  PermissionMode,
  SDKUserMessage,
  SessionStore,
} from "@anthropic-ai/claude-agent-sdk";
import type { NodeConfig } from "../config";
import { paths } from "../paths";
import { composeEnv, composeSettings, type Context } from "../projects/context";
import type { TaskManifest } from "../tasks/manifest";
import { cwdFor } from "../tasks/provision";

export type EngineInput = {
  cfg: NodeConfig;
  manifest: TaskManifest;
  contexts: Context[];
  projectSettings: Record<string, unknown>[];
  token: string;
  prompt: AsyncIterable<SDKUserMessage>;
  canUseTool: CanUseTool;
  onPermissionDenied: (input: PermissionDeniedHookInput) => void;
  sessionStore: SessionStore;
  /** This task has started a session before (the `tasks.started` flag), not crash recovery. */
  resume: boolean;
  model?: string;
  /** The task's chosen mode; `auto` without one. */
  permissionMode?: PermissionMode;
  tools?: string[];
  effort?: string;
  claudePath?: string;
  claudeRuntime?: "bun" | "node";
  extraEnv?: Record<string, string>;
};

function buildEnv(i: EngineInput): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ["PATH", "HOME", ...i.cfg.envPassthrough]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return {
    ...env,
    CLAUDE_CONFIG_DIR: paths(i.cfg).taskConfig(i.manifest.id),
    CLAUDE_CODE_PROJECT_DIR_NAME: i.manifest.primaryProjectId,
    CLAUDE_CODE_OAUTH_TOKEN: i.token,
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    ...composeEnv(i.contexts),
    ...i.extraEnv,
  };
}

/** Turns a task's manifest, contexts and token into the `Options` handed to `query()`. Pure. */
export function buildOptions(i: EngineInput): Options {
  const { cwd, projectConfigRoot, settingSources } = cwdFor(i.manifest, i.cfg);
  const append = i.contexts.map((c) => c.instructions).filter((s) => s !== "").join("\n\n");
  const mcpServers: Record<string, unknown> = Object.assign({}, ...i.contexts.map((c) => c.claude.mcpServers));
  const skills = i.contexts.findLast((c) => c.claude.skills !== null)?.claude.skills;

  const options: Options = {
    cwd,
    settingSources,
    permissionMode: i.permissionMode ?? "auto",
    settings: composeSettings(i.contexts, i.projectSettings),
    systemPrompt: append === ""
      ? { type: "preset", preset: "claude_code" }
      : { type: "preset", preset: "claude_code", append },
    strictMcpConfig: true,
    env: buildEnv(i),
    includePartialMessages: true,
    forwardSubagentText: true,
    canUseTool: i.canUseTool,
    hooks: {
      PermissionDenied: [{
        hooks: [async (input) => {
          i.onPermissionDenied(input as PermissionDeniedHookInput);
          return { continue: true };
        }],
      }],
    },
    sessionStore: i.sessionStore,
    persistSession: true,
  };
  if (projectConfigRoot !== undefined) options.projectConfigRoot = projectConfigRoot;
  if (i.resume) options.resume = i.manifest.sessionId;
  else options.sessionId = i.manifest.sessionId;
  if (Object.keys(mcpServers).length > 0) options.mcpServers = mcpServers as Record<string, McpServerConfig>;
  if (skills != null) options.skills = skills;
  if (i.model !== undefined) options.model = i.model;
  if (i.tools !== undefined) options.tools = i.tools;
  if (i.effort !== undefined) options.effort = i.effort as Options["effort"];
  if (i.claudePath !== undefined) {
    options.pathToClaudeCodeExecutable = i.claudePath;
    options.executable = i.claudeRuntime ?? "bun";
  }
  return options;
}
