import type {
  CanUseTool,
  McpServerConfig,
  Options,
  PermissionDeniedHookInput,
  PermissionMode,
  SDKUserMessage,
  SessionStore,
} from "@anthropic-ai/claude-agent-sdk";
import { delimiter, resolve } from "node:path";
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
  /**
   * Called after each of the agent's tool calls that may change its files (Edit, Write, Bash: Claude Code's
   * `PostToolUse` hook): the task's lines are written from its workspaces soon after. Without it, no such hook.
   */
  onFilesChanged?: () => void;
};

/** The tools whose calls may change the task's files: `onFilesChanged` follows each (a `PostToolUse` matcher). */
export const FILE_TOOLS_MATCHER = "Edit|Write|Bash";

/**
 * The environment of a task's Claude Code: `PATH`, `HOME`, `XDG_CONFIG_HOME` (when meddle has one: the agent's jj reads
 * its workspace's config, `scopeWorkspace`, from where meddle's jj wrote it) and the passthrough names, from this
 * process's environment, then the pool's settings (`cfg.poolEnv`), the names meddle sets itself (which a pool setting
 * can never replace), the projects' context env and `extraEnv`.
 *
 * An agent can't reach `meddle://` remotes: its `PATH` has no `<data>/bin` (the remote helper), even when this
 * process's has, and it gets no `MEDDLE_GIT_SOCKET`. Its lines and branches reach other nodes as rows, and a push
 * through this node's own git socket would count as one of your checkouts'.
 */
export function buildEnv(i: EngineInput): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "XDG_CONFIG_HOME", ...i.cfg.envPassthrough]) {
    const value = process.env[name];
    if (value !== undefined && name !== "MEDDLE_GIT_SOCKET") env[name] = value;
  }
  if (env.PATH !== undefined) {
    const bin = resolve(paths(i.cfg).bin);
    env.PATH = env.PATH.split(delimiter).filter((dir) => dir === "" || resolve(dir) !== bin).join(delimiter);
  }
  return {
    ...env,
    ...i.cfg.poolEnv,
    CLAUDE_CONFIG_DIR: paths(i.cfg).taskConfig(i.manifest.id),
    // Without a project, Claude Code names the project dir after the folder it runs in, as it does on its own.
    ...(typeof i.manifest.primaryProjectId === "string" ? { CLAUDE_CODE_PROJECT_DIR_NAME: i.manifest.primaryProjectId } : {}),
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
      ...(i.onFilesChanged === undefined ? {} : {
        PostToolUse: [{
          matcher: FILE_TOOLS_MATCHER,
          hooks: [async () => {
            i.onFilesChanged?.();
            return { continue: true };
          }],
        }],
      }),
    },
    sessionStore: i.sessionStore,
    persistSession: true,
  };
  if (projectConfigRoot != null) options.projectConfigRoot = projectConfigRoot;
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
