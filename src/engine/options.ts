import type {
  CanUseTool,
  HookCallbackMatcher,
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
import { messagingHooks, type Messaging } from "./messaging-hooks";
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
  /** The task's chosen mode (a train turn's is always `auto`); `auto` without one. */
  permissionMode?: PermissionMode;
  /**
   * meddle's own MCP servers for this turn (a train turn's in-process `meddle`), beside the contexts' servers; one of
   * these wins over a context's server of the same name.
   */
  extraMcpServers?: Record<string, McpServerConfig>;
  /** Tools Claude Code runs without asking (`allowedTools`): a train turn's meddle tools. */
  allowedTools?: string[];
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
  /** Meddle's messaging between tasks (`messagingHooks`): `SendMessage` to a task and `ListAgents` go through it. */
  messaging?: Messaging;
  /**
   * Where the task's Claude Code listens for messages from other tasks (`--messaging-socket-path`, in a private dir):
   * started so, it keeps each message's uuid, which it reports the message's progress by.
   */
  messagingSocket?: string;
};

/** The tools whose calls may change the task's files: `onFilesChanged` follows each (a `PostToolUse` matcher). */
export const FILE_TOOLS_MATCHER = "Edit|Write|Bash";

/**
 * What a Claude Code meddle runs (a task's turn, a title query) takes of this process's environment: `PATH`, `HOME`,
 * `XDG_CONFIG_HOME` (when meddle has one: the agent's jj reads its workspace's config, `scopeWorkspace`, from where
 * meddle's jj wrote it) and the passthrough names (a proxy, a CA file), with no `<data>/bin` on `PATH` and no
 * `MEDDLE_GIT_SOCKET` (see `buildEnv`).
 */
export function inheritedEnv(cfg: NodeConfig): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "XDG_CONFIG_HOME", ...cfg.envPassthrough]) {
    const value = process.env[name];
    if (value !== undefined && name !== "MEDDLE_GIT_SOCKET") env[name] = value;
  }
  if (env.PATH !== undefined) {
    const bin = resolve(paths(cfg).bin);
    env.PATH = env.PATH.split(delimiter).filter((dir) => dir === "" || resolve(dir) !== bin).join(delimiter);
  }
  return env;
}

/**
 * The environment of a task's Claude Code: what it inherits (`inheritedEnv`), then the pool's settings (`cfg.poolEnv`), the names meddle sets itself (which a pool setting
 * can never replace), the projects' context env and `extraEnv`.
 *
 * An agent can't reach `meddle://` remotes: its `PATH` has no `<data>/bin` (the remote helper), even when this
 * process's has, and it gets no `MEDDLE_GIT_SOCKET`. Its lines and branches reach other nodes as rows, and a push
 * through this node's own git socket would count as one of your checkouts'.
 */
export function buildEnv(i: EngineInput): Record<string, string> {
  return {
    ...inheritedEnv(i.cfg),
    ...i.cfg.poolEnv,
    CLAUDE_CONFIG_DIR: paths(i.cfg).taskConfig(i.manifest.id),
    // The name other tasks' agents send messages to (their `sessions` registry is shared).
    CLAUDE_CODE_SESSION_NAME: i.manifest.id,
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
  const mcpServers: Record<string, unknown> = Object.assign({}, ...i.contexts.map((c) => c.claude.mcpServers), i.extraMcpServers);
  const skills = i.contexts.findLast((c) => c.claude.skills !== null)?.claude.skills;

  const messaging = i.messaging === undefined ? undefined : messagingHooks(i.messaging);
  const postToolUse: HookCallbackMatcher[] = [
    ...(i.onFilesChanged === undefined ? [] : [{
      matcher: FILE_TOOLS_MATCHER,
      hooks: [async () => {
        i.onFilesChanged?.();
        return { continue: true };
      }],
    }]),
    ...(messaging?.PostToolUse ?? []),
  ];
  const options: Options = {
    cwd,
    // Where a prompt's attached files are written (`materialize`): Claude Code reads them without asking.
    additionalDirectories: [paths(i.cfg).taskAttachments(i.manifest.id)],
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
      ...(i.messaging === undefined ? {} : { PreToolUse: messaging!.PreToolUse }),
      ...(postToolUse.length === 0 ? {} : { PostToolUse: postToolUse }),
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
  if (i.allowedTools !== undefined) options.allowedTools = i.allowedTools;
  if (i.effort !== undefined) options.effort = i.effort as Options["effort"];
  if (i.messagingSocket !== undefined) options.extraArgs = { "messaging-socket-path": i.messagingSocket };
  if (i.claudePath !== undefined) {
    options.pathToClaudeCodeExecutable = i.claudePath;
    options.executable = i.claudeRuntime ?? "bun";
  }
  return options;
}
