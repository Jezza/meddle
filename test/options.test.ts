// test/options.test.ts
import { test, expect } from "bun:test";
import { buildEnv, buildOptions } from "../src/engine/options";
import { DEFAULT_CONTEXT } from "../src/projects/context";
import { loadConfig } from "../src/config";
test("options match the spec", () => {
  const cfg = loadConfig({ HOME: "/h", MEDDLE_DATA_DIR: "/d", MEDDLE_TASK_ROOT: "/t" });
  const manifest = { id: "abc", title: "t", sessionId: "11111111-1111-4111-8111-111111111111", primaryProjectId: "p1", createdAt: "", projects: [{ id: "p1", name: "a", replica: "/r/a", workspace: "a", parent: "root()", base: ["0000000000000000000000000000000000000000"], context: null }] };
  const common = { cfg, manifest, projectSettings: [], token: "tok", prompt: (async function*(){})(), canUseTool: async () => ({ behavior: "deny" as const, message: "x" }), onPermissionDenied: () => {}, sessionStore: {} as any };
  const o: any = buildOptions({ ...common, contexts: [{ ...DEFAULT_CONTEXT, env: { RUST_LOG: "debug" }, instructions: "Use nextest." }], resume: false, extraEnv: { MEDDLE_FIXTURE: "/f" }, claudePath: "/x/replay.ts" });
  expect(o.permissionMode).toBe("auto");
  expect(o.sessionId).toBe(manifest.sessionId); expect(o.resume).toBeUndefined();
  expect(o.cwd).toBe("/t/abc/a"); expect(o.projectConfigRoot).toBe("/t/abc/a");
  expect(o.settingSources).toEqual(["user", "project", "local"]);
  expect(o.env).toMatchObject({ PATH: process.env.PATH, HOME: process.env.HOME, CLAUDE_CONFIG_DIR: "/t/abc/.meddle/claude", CLAUDE_CODE_PROJECT_DIR_NAME: "p1", CLAUDE_CODE_OAUTH_TOKEN: "tok", ENABLE_CLAUDEAI_MCP_SERVERS: "false", RUST_LOG: "debug", MEDDLE_FIXTURE: "/f" });
  expect(o.env.XDG_CONFIG_HOME).toBe(process.env.XDG_CONFIG_HOME!);
  for (const k of Object.keys(o.env)) expect(["PATH","HOME","XDG_CONFIG_HOME","CLAUDE_CONFIG_DIR","CLAUDE_CODE_PROJECT_DIR_NAME","CLAUDE_CODE_OAUTH_TOKEN","ENABLE_CLAUDEAI_MCP_SERVERS","RUST_LOG","MEDDLE_FIXTURE", ...cfg.envPassthrough]).toContain(k);
  expect(o.settings.autoMode.allow[0]).toBe("$defaults");
  expect(o.systemPrompt).toEqual({ type: "preset", preset: "claude_code", append: "Use nextest." });
  expect(o.includePartialMessages).toBe(true); expect(o.forwardSubagentText).toBe(true); expect(o.strictMcpConfig).toBe(true);
  expect(o.hooks.PermissionDenied).toHaveLength(1);
  expect(o.pathToClaudeCodeExecutable).toBe("/x/replay.ts"); expect(o.executable).toBe("bun");
  const r: any = buildOptions({ ...common, contexts: [], resume: true });
  expect(r.resume).toBe(manifest.sessionId); expect(r.sessionId).toBeUndefined(); expect(r.pathToClaudeCodeExecutable).toBeUndefined();
  expect(r.permissionMode).toBe("auto");
  const planned: any = buildOptions({ ...common, contexts: [], resume: false, permissionMode: "plan" });
  expect(planned.permissionMode).toBe("plan");
  const three: any = buildOptions({ ...common, contexts: [{ ...DEFAULT_CONTEXT, instructions: "A." }, { ...DEFAULT_CONTEXT, instructions: "" }, { ...DEFAULT_CONTEXT, instructions: "B." }], resume: false });
  expect(three.systemPrompt.append).toBe("A.\n\nB.");
  const none: any = buildOptions({ ...common, contexts: [DEFAULT_CONTEXT], resume: false });
  expect(none.systemPrompt).toEqual({ type: "preset", preset: "claude_code" });
  expect(none.systemPrompt).not.toHaveProperty("append");
});

test("with onFilesChanged, a PostToolUse hook for Edit, Write and Bash calls it and lets the agent go on; without, there is none", async () => {
  const cfg = loadConfig({ HOME: "/h", MEDDLE_DATA_DIR: "/d", MEDDLE_TASK_ROOT: "/t" });
  const manifest = { id: "abc", title: "t", sessionId: "11111111-1111-4111-8111-111111111111", primaryProjectId: null, createdAt: "", projects: [] };
  const common = { cfg, manifest, contexts: [], projectSettings: [], token: "tok", prompt: (async function*(){})(), canUseTool: async () => ({ behavior: "deny" as const, message: "x" }), onPermissionDenied: () => {}, sessionStore: {} as any, resume: false };
  expect((buildOptions(common) as any).hooks.PostToolUse).toBeUndefined();
  let changed = 0;
  const o: any = buildOptions({ ...common, onFilesChanged: () => { changed++; } });
  expect(o.hooks.PostToolUse).toHaveLength(1);
  expect(o.hooks.PostToolUse[0].matcher).toBe("Edit|Write|Bash");
  const signal = new AbortController().signal;
  expect(await o.hooks.PostToolUse[0].hooks[0]({ hook_event_name: "PostToolUse", tool_name: "Edit" }, "toolu_1", { signal })).toEqual({ continue: true });
  expect(changed).toBe(1);
});

test("an agent can't reach meddle:// remotes: its env has neither <data>/bin on PATH nor MEDDLE_GIT_SOCKET", () => {
  const cfg = loadConfig({ HOME: "/h", MEDDLE_DATA_DIR: "/d", MEDDLE_TASK_ROOT: "/t", MEDDLE_ENV_PASSTHROUGH: "MEDDLE_GIT_SOCKET" });
  const manifest = { id: "abc", title: "t", sessionId: "11111111-1111-4111-8111-111111111111", primaryProjectId: null, createdAt: "", projects: [] };
  const saved = { PATH: process.env.PATH, MEDDLE_GIT_SOCKET: process.env.MEDDLE_GIT_SOCKET };
  // Even when the service's own PATH has the helper's directory (a user who put it on theirs).
  process.env.PATH = `/d/bin:/usr/bin:/d/bin/:/bin`;
  process.env.MEDDLE_GIT_SOCKET = "/d/git.sock";
  try {
    const env = buildEnv({ cfg, manifest, contexts: [], projectSettings: [], token: "tok", prompt: (async function*(){})(), canUseTool: async () => ({ behavior: "deny" as const, message: "x" }), onPermissionDenied: () => {}, sessionStore: {} as any, resume: false });
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env).not.toHaveProperty("MEDDLE_GIT_SOCKET");
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});
