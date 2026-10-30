# meddle Plan 1: Single Node Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One meddle node that creates tasks as jj workspaces, runs each task's Claude Code session through the Agent SDK in auto mode, records every event durably, and shows and steers the session from a browser.

**Architecture:** A bun process hosts pi-durable (task lifecycle and turns, SQLite), a meddle SQLite database (event log, transcript mirror, projects, tasks), the Agent SDK (one `claude` child per live task), chord objects for Node, Project, Task and Session, and a bun HTTP server serving the dashboard over a chord WebSocket link. No networking between nodes in this plan; the pool, repo sync and moves are Plans 2 and 3.

**Tech Stack:** bun 1.4, TypeScript, `@anthropic-ai/claude-agent-sdk` 0.3.314 (bundles Claude Code 2.1.314), `@earendil-works/pi-durable` 1.4.0, `@earendil-works/chord` 1.4.0, `typebox`, `smol-toml`, `bun:sqlite`, Preact for the dashboard, jj (colocated git) for repos.

**Spec:** `docs/superpowers/specs/2026-10-30-meddle-design.md`

## Global Constraints

- Runtime is bun; all code TypeScript; `bun test` is the test runner.
- Pinned: `@anthropic-ai/claude-agent-sdk@0.3.314`, `@earendil-works/pi-durable@1.4.0`, `@earendil-works/chord@1.4.0`, `@earendil-works/pi-ai@1.4.0`. The SDK version is the Claude Code version.
- Version control is jj. Commit with `jj commit -m "<type>: <summary>"`. Commit messages never carry AI attribution.
- One pool-wide task root, default `/opt/meddle/tasks`. Tests override it with `MEDDLE_TASK_ROOT`. A node that cannot provide the root does not host tasks.
- One Claude config directory per task at `<task>/.meddle/claude/`. Inside it `CLAUDE.md`, `settings.json`, `skills/`, `agents/`, `commands/`, `hooks/` are symlinks into `<data>/profile/`; `plugins/` is a symlink to `<data>/plugins/`; `projects/<primary-project-id>/memory` is a symlink to `<data>/memory/<primary-project-id>/`.
- Every session: `permissionMode: 'auto'`; `includePartialMessages: true`; `forwardSubagentText: true`; `strictMcpConfig: true`; `env` built from scratch with `PATH`, `HOME`, `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_PROJECT_DIR_NAME` = primary project id, `CLAUDE_CODE_OAUTH_TOKEN`, `ENABLE_CLAUDEAI_MCP_SERVERS=false`, plus context env. `settingSources` is `['user','project','local']` for a single-project task and `['user']` otherwise. The `systemPrompt` is fixed for the task's life.
- `autoMode` rules passed inline always start with `'$defaults'`.
- The token is never on a command line and never logged. It lives in `<data>/secrets/claude-token`, mode 600.
- The `SessionStore` dedupes on entry `uuid`. `persistSession` stays `true` and file checkpointing stays off (they conflict with the store).
- Data directory default `~/.local/share/meddle`, overridable with `MEDDLE_DATA_DIR`. Two SQLite files: `meddle.sqlite` (meddle tables) and `durable.sqlite` (pi-durable).
- Memory and transcript slot of a multi-project task is the primary (first attached) project's.
- One `claude` child per turn. The task's first turn ever starts the child with `sessionId`; every later turn starts it with `resume: sessionId`; the child ends when meddle closes the input stream after the result. `prewarm` is not in this plan.
- The `SessionStore.load()` meddle hands the SDK always returns `null`. When `load()` returns entries, the SDK resumes from a temporary config directory of its own that carries neither the profile symlinks nor memory. meddle mirrors with `append()` only and moves transcripts itself (Plan 3).
- The child's `env` is built from scratch, plus a passthrough list from node config, default `TERM LANG LC_ALL SHELL TMPDIR XDG_RUNTIME_DIR SSL_CERT_FILE SSL_CERT_DIR NODE_EXTRA_CA_CERTS HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy`, each copied from the service's environment when set.
- The test stand-in for Claude Code is named `claudePath` (a file path; a `.ts` or `.js` path is run with `claudeRuntime`, default `bun`) in code and `MEDDLE_CLAUDE_PATH` / `MEDDLE_CLAUDE_RUNTIME` in the environment. No other names.
- jj workspaces are created with `--colocate`, so each has a Git worktree and Claude Code's git awareness works inside it.

## Review Focus

1. A token file with a trailing newline or CRLF: the value passed in `CLAUDE_CODE_OAUTH_TOKEN` must be trimmed, or every session fails with "Not logged in". Test in Task 4.
2. A project added from a folder that is a plain git repo with no `.jj`: meddle must run `jj git init --colocate` there, not fail. Test in Task 7.
3. A project with no `.meddle/context.toml`: defaults apply and the task starts; a context file with an unknown key is rejected with the key named. Tests in Task 7.
4. An SDK message of a `type` or `subtype` this code has never seen, from a newer Claude Code: it is stored and rendered as a generic row, never dropped and never a crash. Tests in Tasks 9 and 16.
5. Provisioning a task before the profile replica exists on this node: provisioning seeds the profile first, and the symlinks resolve. Test in Task 8.

---

## File structure

```
package.json  tsconfig.json  bunfig.toml  README.md
src/
  cli.ts                     meddle serve | project add | task new | task prompt | token set | status | --version
  config.ts                  NodeConfig from env: dataDir, taskRoot, port, home
  paths.ts                   every path meddle writes, derived from NodeConfig
  jj.ts                      thin jj CLI wrapper
  token.ts                   setup-token file: set, get, status
  profile.ts                 profile replica: seed from ~/.claude, link into a config dir
  memory.ts                  memory replicas: ensure, import from a Claude Code slot, link
  projects/context.ts        .meddle/context.toml schema, load, compose settings and env
  projects/project.ts        add from folder or upstream, list
  tasks/manifest.ts          task.json
  tasks/provision.ts         folder, workspaces, config dir, CLAUDE.md
  tasks/durable.ts           pi-durable task types meddle.task and meddle.turn
  tasks/harness.ts           open the pi-durable Harness
  store/db.ts                bun:sqlite open + migrations
  store/events.ts            event log
  store/session-store.ts     SDK SessionStore over SQLite
  store/records.ts           projects and tasks tables
  engine/options.ts          build SDK Options for a task
  engine/approvals.ts        pending canUseTool requests, answered by the dashboard
  engine/input.ts            InputQueue: AsyncIterable of user messages
  engine/session.ts          runTurn: query(), record, approvals, hooks
  metrics.ts                 /proc sampling
  state/contracts.ts         chord contracts: Node, Project, Task, Session
  state/host.ts              chord host, object providers, WebSocket acceptor
  dashboard/server.ts        bun HTTP: static UI + WebSocket link
  dashboard/ui/              Preact SPA (thread-model.ts is pure and tested)
test/
  fake-claude/record.ts      records a real session's frames via spawnClaudeCodeProcess
  fake-claude/replay.ts      a claude stand-in that replays a recording
  fixtures/*.jsonl           recordings
  *.test.ts
```

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `bunfig.toml`, `.gitignore`, `src/cli.ts`, `src/version.ts`, `test/cli.test.ts`

**Interfaces:**
- Produces: `VERSION` constant in `src/version.ts`; `bun run src/cli.ts --version` prints `meddle <version>`.

- [ ] **Step 1: Write the failing test**

```ts
// test/cli.test.ts
import { test, expect } from "bun:test";
test("--version prints the version", async () => {
  const p = Bun.spawn(["bun", "run", "src/cli.ts", "--version"], { stdout: "pipe" });
  const out = await new Response(p.stdout).text();
  expect(out.trim()).toMatch(/^meddle \d+\.\d+\.\d+$/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/cli.test.ts`
Expected: FAIL, `src/cli.ts` not found.

- [ ] **Step 3: Create the project**

`package.json` with `"name": "meddle"`, `"version": "0.1.0"`, `"type": "module"`, scripts `test: bun test`, `serve: bun run src/cli.ts serve`, and dependencies at the pinned versions: `@anthropic-ai/claude-agent-sdk@0.3.314`, `@earendil-works/pi-durable@1.4.0`, `@earendil-works/chord@1.4.0`, `@earendil-works/pi-ai@1.4.0`, `typebox`, `smol-toml`, `preact`; devDependency `@types/bun`. Run `bun install`. `tsconfig.json`: `strict`, `module: esnext`, `moduleResolution: bundler`, `jsx: react-jsx`, `jsxImportSource: preact`, `types: ["bun-types"]`. `.gitignore`: `node_modules`, `dist`, `*.sqlite`. `src/version.ts` exports `VERSION` read from `package.json`. `src/cli.ts` handles `--version` only for now and exits 2 with a usage line otherwise.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/cli.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
jj commit -m "chore: bun project scaffold with pinned dependencies"
```

---

### Task 2: Node config and paths

**Files:**
- Create: `src/config.ts`, `src/paths.ts`, `test/config.test.ts`

**Interfaces:**
- Produces:
  - `type NodeConfig = { dataDir: string; taskRoot: string; port: number; home: string; claudeHome: string }`
  - `loadConfig(env: Record<string, string | undefined> = process.env): NodeConfig` — `MEDDLE_DATA_DIR` default `<home>/.local/share/meddle`; `MEDDLE_TASK_ROOT` default `/opt/meddle/tasks`; `MEDDLE_PORT` default `7777`; `claudeHome` is `CLAUDE_CONFIG_DIR` if set, else `<home>/.claude`.
  - `paths(cfg: NodeConfig)` returning `{ profile, plugins, secrets, tokenFile, db, durableDb, memory(projectId), replica(projectId), task(taskId), taskConfig(taskId), taskManifest(taskId) }`, all absolute, with `memory` under `<data>/memory/`, `replica` under `<data>/replicas/`, `task` under `cfg.taskRoot`, `taskConfig` = `<task>/.meddle/claude`, `taskManifest` = `<task>/.meddle/task.json`.
  - `ensureDataDirs(cfg): Promise<void>` creating `dataDir`, `profile`, `plugins`, `secrets` (mode 700), `memory`, `replicas`.
  - `checkTaskRoot(cfg): Promise<{ ok: true } | { ok: false; reason: string }>` — ok when `taskRoot` exists and is writable by this process.

- [ ] **Step 1: Write the failing tests**

```ts
// test/config.test.ts
import { test, expect } from "bun:test";
import { loadConfig, paths, checkTaskRoot, ensureDataDirs } from "../src/config";
test("defaults", () => {
  const cfg = loadConfig({ HOME: "/home/x" });
  expect(cfg.dataDir).toBe("/home/x/.local/share/meddle");
  expect(cfg.taskRoot).toBe("/opt/meddle/tasks");
  expect(cfg.port).toBe(7777);
  expect(cfg.claudeHome).toBe("/home/x/.claude");
});
test("env overrides and derived paths", () => {
  const cfg = loadConfig({ HOME: "/home/x", MEDDLE_DATA_DIR: "/d", MEDDLE_TASK_ROOT: "/t", MEDDLE_PORT: "8000", CLAUDE_CONFIG_DIR: "/c" });
  const p = paths(cfg);
  expect(p.taskConfig("abc")).toBe("/t/abc/.meddle/claude");
  expect(p.memory("proj")).toBe("/d/memory/proj");
  expect(p.tokenFile).toBe("/d/secrets/claude-token");
  expect(cfg.claudeHome).toBe("/c");
});
test("checkTaskRoot reports a missing root", async () => {
  const cfg = loadConfig({ HOME: "/home/x", MEDDLE_TASK_ROOT: "/nonexistent/meddle" });
  expect((await checkTaskRoot(cfg)).ok).toBe(false);
});
test("ensureDataDirs creates secrets with mode 700", async () => {
  const dir = await import("node:fs/promises").then(fs => fs.mkdtemp("/tmp/meddle-cfg-"));
  const cfg = loadConfig({ HOME: "/home/x", MEDDLE_DATA_DIR: dir, MEDDLE_TASK_ROOT: dir });
  await ensureDataDirs(cfg);
  const st = await import("node:fs/promises").then(fs => fs.stat(paths(cfg).secrets));
  expect(st.mode & 0o777).toBe(0o700);
});
```

- [ ] **Step 2: Run to verify failure** — `bun test test/config.test.ts` → FAIL, module not found.
- [ ] **Step 3: Implement `src/config.ts` and `src/paths.ts`** with the signatures above. Export `paths`, `checkTaskRoot`, `ensureDataDirs` from `config.ts` as well so the test import works.
- [ ] **Step 4: Run to verify pass** — `bun test test/config.test.ts` → PASS
- [ ] **Step 5: Commit** — `jj commit -m "feat: node config and data layout"`

---

### Task 3: jj wrapper

**Files:**
- Create: `src/jj.ts`, `test/jj.test.ts`

**Interfaces:**
- Produces:
  - `jj(args: string[], cwd: string): Promise<string>` — runs the `jj` binary, returns stdout, throws `JjError { args, code, stderr }` on non-zero exit. Always passes `--no-pager` and `--color never`.
  - `isJjRepo(dir: string): Promise<boolean>` (a `.jj` directory exists at `dir`).
  - `initColocated(dir: string): Promise<void>` — `jj git init --colocate`.
  - `cloneColocated(url: string, dir: string): Promise<void>` — `jj git clone --colocate <url> <dir>`.
  - `workspaceAdd(repo: string, name: string, path: string, revision: string): Promise<void>` — `jj workspace add --colocate --name <name> -r <revision> <path>`.
  - `workspaceForget(repo: string, name: string): Promise<void>`.
  - `bookmarkSet(repo: string, name: string, revision: string): Promise<void>` — `jj bookmark set <name> -r <revision> --allow-backwards`.
  - `changeId(workspace: string): Promise<string>` — the working-copy change id, from `jj log -r @ --no-graph -T change_id`.
  - `trunkRevset(repo: string): Promise<string>` — `trunk()` if it resolves, else `root()`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/jj.test.ts
import { test, expect } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { initColocated, isJjRepo, workspaceAdd, workspaceForget, changeId, bookmarkSet, trunkRevset } from "../src/jj";
test("init, workspace add, change id, bookmark, forget", async () => {
  const repo = await mkdtemp("/tmp/meddle-jj-");
  await initColocated(repo);
  expect(await isJjRepo(repo)).toBe(true);
  const ws = `${repo}-ws`;
  await workspaceAdd(repo, "task1", ws, await trunkRevset(repo));
  const id = await changeId(ws);
  expect(id).toMatch(/^[k-z]{32}$/);
  expect(await Bun.file(`${ws}/.git`).exists()).toBe(true); // colocated: a Git worktree file
  await bookmarkSet(repo, "meddle/task/1/p", id);
  await workspaceForget(repo, "task1");
});
test("jj errors carry stderr", async () => {
  const { jj } = await import("../src/jj");
  await expect(jj(["log"], "/tmp")).rejects.toMatchObject({ code: expect.any(Number) });
});
```

- [ ] **Step 2: Run to verify failure** — `bun test test/jj.test.ts` → FAIL
- [ ] **Step 3: Implement `src/jj.ts`** using `Bun.spawn` with `cwd`, collecting stdout and stderr.
- [ ] **Step 4: Run to verify pass** — PASS
- [ ] **Step 5: Commit** — `jj commit -m "feat: jj wrapper"`

---

### Task 4: Token store

**Files:**
- Create: `src/token.ts`, `test/token.test.ts`
- Modify: `src/cli.ts` (add `token set` and `token status`)

**Interfaces:**
- Produces:
  - `setToken(cfg: NodeConfig, token: string): Promise<void>` — trims whitespace including CR and LF, refuses an empty result with `Error("empty token")`, writes `paths(cfg).tokenFile` with mode 600 and a sidecar `claude-token.meta.json` `{ setAt: ISO string }`.
  - `getToken(cfg): Promise<string | null>` — trimmed file contents.
  - `tokenStatus(cfg): Promise<{ present: boolean; setAt?: string; expiresAt?: string }>` — `expiresAt` = `setAt` + 365 days (the spec: a one-year token).
  - CLI: `meddle token set` reads the token from stdin (or `--file <path>`), never from an argument; `meddle token status` prints `present`, `setAt`, `expiresAt`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/token.test.ts
import { test, expect } from "bun:test";
import { mkdtemp, stat } from "node:fs/promises";
import { loadConfig, ensureDataDirs, paths } from "../src/config";
import { setToken, getToken, tokenStatus } from "../src/token";
async function cfg() { const d = await mkdtemp("/tmp/meddle-tok-"); const c = loadConfig({ HOME: d, MEDDLE_DATA_DIR: d, MEDDLE_TASK_ROOT: d }); await ensureDataDirs(c); return c; }
test("trims CRLF and sets mode 600", async () => {
  const c = await cfg();
  await setToken(c, "sk-ant-oat01-abc\r\n");
  expect(await getToken(c)).toBe("sk-ant-oat01-abc");
  expect(((await stat(paths(c).tokenFile)).mode & 0o777)).toBe(0o600);
});
test("empty token is refused", async () => {
  await expect(setToken(await cfg(), "  \n")).rejects.toThrow("empty token");
});
test("status reports a one-year expiry", async () => {
  const c = await cfg();
  await setToken(c, "x");
  const s = await tokenStatus(c);
  expect(s.present).toBe(true);
  expect(new Date(s.expiresAt!).getTime() - new Date(s.setAt!).getTime()).toBe(365 * 86400_000);
});
```

- [ ] **Step 2: Run to verify failure** — `bun test test/token.test.ts` → FAIL
- [ ] **Step 3: Implement `src/token.ts`** and wire the two CLI subcommands.
- [ ] **Step 4: Run to verify pass** — PASS
- [ ] **Step 5: Commit** — `jj commit -m "feat: setup-token store and token CLI"`

---

### Task 5: Profile replica

**Files:**
- Create: `src/profile.ts`, `test/profile.test.ts`

**Interfaces:**
- Produces:
  - `PROFILE_ENTRIES = ["CLAUDE.md", "settings.json", "skills", "agents", "commands", "hooks"] as const`
  - `seedProfile(cfg: NodeConfig): Promise<void>` — if `<data>/profile` is not a jj repo: create it, `initColocated`, copy each `PROFILE_ENTRIES` entry that exists in `cfg.claudeHome` into it (files copied, directories copied recursively, symlinks followed), create any missing entry so links always resolve: `settings.json` as `{}`, `CLAUDE.md` empty, the rest as empty directories, then `jj commit -m "seed profile from <claudeHome>"` inside it. Idempotent: a second call changes nothing.
  - `ensurePlugins(cfg): Promise<void>` — `<data>/plugins` exists; if it does not and `<claudeHome>/plugins` exists, make `<data>/plugins` a symlink to it.
  - `linkProfile(configDir: string, cfg): Promise<void>` — for each `PROFILE_ENTRIES` entry, `configDir/<entry>` is a symlink to `<data>/profile/<entry>` (replacing anything there); `configDir/plugins` is a symlink to `<data>/plugins`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/profile.test.ts
import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, readlink, readFile } from "node:fs/promises";
import { loadConfig, ensureDataDirs, paths } from "../src/config";
import { seedProfile, linkProfile, ensurePlugins, PROFILE_ENTRIES } from "../src/profile";
import { isJjRepo } from "../src/jj";
test("seed copies ~/.claude entries into a jj repo and links them", async () => {
  const home = await mkdtemp("/tmp/meddle-prof-");
  await mkdir(`${home}/.claude/skills/pine`, { recursive: true });
  await writeFile(`${home}/.claude/skills/pine/SKILL.md`, "---\nname: pine\ndescription: d\n---\n");
  await writeFile(`${home}/.claude/CLAUDE.md`, "# rules\n");
  const cfg = loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/data`, MEDDLE_TASK_ROOT: home });
  await ensureDataDirs(cfg);
  await seedProfile(cfg); await seedProfile(cfg);
  expect(await isJjRepo(paths(cfg).profile)).toBe(true);
  expect(await readFile(`${paths(cfg).profile}/CLAUDE.md`, "utf8")).toBe("# rules\n");
  const configDir = `${home}/task/.meddle/claude`;
  await mkdir(configDir, { recursive: true });
  await ensurePlugins(cfg);
  await linkProfile(configDir, cfg);
  for (const e of PROFILE_ENTRIES) expect(await readlink(`${configDir}/${e}`)).toBe(`${paths(cfg).profile}/${e}`);
  expect(await readFile(`${configDir}/skills/pine/SKILL.md`, "utf8")).toContain("name: pine");
  expect(await readlink(`${configDir}/plugins`)).toBe(paths(cfg).plugins);
});
```

- [ ] **Step 2: Run to verify failure** — FAIL
- [ ] **Step 3: Implement `src/profile.ts`**.
- [ ] **Step 4: Run to verify pass** — PASS
- [ ] **Step 5: Commit** — `jj commit -m "feat: profile replica seeded from ~/.claude and linked into task config dirs"`

---

### Task 6: Memory replicas

**Files:**
- Create: `src/memory.ts`, `test/memory.test.ts`

**Interfaces:**
- Produces:
  - `claudeSlot(absPath: string): string` — Claude Code's project slot name: every character that is not `[A-Za-z0-9]` becomes `-` (so `/home/jezza/x` → `-home-jezza-x`).
  - `ensureMemoryReplica(cfg, projectId: string): Promise<string>` — `<data>/memory/<projectId>` exists as a jj repo (init if needed); returns the path.
  - `importMemory(cfg, projectId: string, projectPath: string): Promise<boolean>` — if `<claudeHome>/projects/<claudeSlot(projectPath)>/memory` exists and the replica has no `MEMORY.md`, copy its contents into the replica and `jj commit -m "import memory from <slot>"`; returns whether anything was imported.
  - `linkMemory(configDir: string, cfg, projectId: string): Promise<void>` — `configDir/projects/<projectId>/memory` is a symlink to the replica (parents created).

- [ ] **Step 1: Write the failing tests**

```ts
// test/memory.test.ts
import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, readlink, readFile } from "node:fs/promises";
import { loadConfig, ensureDataDirs, paths } from "../src/config";
import { claudeSlot, ensureMemoryReplica, importMemory, linkMemory } from "../src/memory";
test("slot naming matches Claude Code", () => {
  expect(claudeSlot("/home/jezza/projects/ssk")).toBe("-home-jezza-projects-ssk");
});
test("import from an existing slot, then link", async () => {
  const home = await mkdtemp("/tmp/meddle-mem-");
  const proj = `${home}/proj`;
  await mkdir(`${home}/.claude/projects/${claudeSlot(proj)}/memory`, { recursive: true });
  await writeFile(`${home}/.claude/projects/${claudeSlot(proj)}/memory/MEMORY.md`, "- note\n");
  const cfg = loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/data`, MEDDLE_TASK_ROOT: home });
  await ensureDataDirs(cfg);
  const replica = await ensureMemoryReplica(cfg, "p1");
  expect(await importMemory(cfg, "p1", proj)).toBe(true);
  expect(await readFile(`${replica}/MEMORY.md`, "utf8")).toBe("- note\n");
  const configDir = `${home}/t/.meddle/claude`;
  await linkMemory(configDir, cfg, "p1");
  expect(await readlink(`${configDir}/projects/p1/memory`)).toBe(replica);
});
```

- [ ] **Step 2: Run to verify failure** — FAIL
- [ ] **Step 3: Implement `src/memory.ts`**.
- [ ] **Step 4: Run to verify pass** — PASS
- [ ] **Step 5: Commit** — `jj commit -m "feat: per-project memory replicas with import and symlink"`

---

### Task 7: Projects and context

**Files:**
- Create: `src/projects/context.ts`, `src/projects/project.ts`, `src/store/db.ts`, `src/store/records.ts`, `test/context.test.ts`, `test/project.test.ts`

**Interfaces:**
- Produces:
  - `openDb(path: string): Database` (`bun:sqlite`), running migrations idempotently. Tables in this task: `projects(id TEXT PK, name TEXT, source_kind TEXT, source TEXT, replica TEXT, created_at TEXT)` and `tasks(id TEXT PK, title TEXT, state TEXT, session_id TEXT, manifest TEXT, started INTEGER NOT NULL DEFAULT 0, turns INTEGER NOT NULL DEFAULT 0, created_at TEXT, updated_at TEXT)`. `started` flips to 1 before the task's first `query()` ever; it decides `sessionId` versus `resume` (Task 13).
  - `loadProjectSettings(replica: string): Promise<Record<string, unknown>>` — the parsed `<replica>/.claude/settings.json`, or `{}` when absent.
  - `type Context = { env: Record<string,string>; claude: { ask: string[]; autoMode: { allow: string[]; soft_deny: string[]; hard_deny: string[] }; mcpServers: Record<string, unknown>; skills: string[] | "all" | null }; instructions: string; resources: { memoryMb?: number; runs: string[] } }` with `DEFAULT_CONTEXT` having empty lists, `skills: null`, `instructions: ""`.
  - `ContextSchema` as a TypeBox schema matching the TOML shape: top-level tables `[env]`, `[claude]`, `[claude.autoMode]`, `[claude.mcpServers.<name>]`, `[resources]`, and a top-level `instructions` string.
  - `loadContext(replicaPath: string): Promise<Context>` — reads `<replica>/.meddle/context.toml` if present; missing file gives `DEFAULT_CONTEXT`; an unknown key throws `Error("context.toml: unknown key <path>")`.
  - `composeSettings(contexts: Context[], projectSettings: Record<string, unknown>[] = []): Record<string, unknown>` — a deep merge of `projectSettings` in order (later wins), then `autoMode.allow` = `["$defaults", ...all context allow]`, likewise `soft_deny` and `hard_deny`, and `permissions.ask` = all context ask rules, each list deduplicated with order preserved and appended to whatever the project settings already had. `projectSettings` is used for multi-project tasks, whose non-`cwd` projects Claude Code would otherwise never read (spec section 8).
  - `composeEnv(contexts: Context[]): Record<string,string>` — later contexts win.
  - `type Project = { id: string; name: string; source: { kind: "folder"; path: string } | { kind: "upstream"; url: string }; replica: string }`
  - `addProjectFromFolder(cfg, db, folder: string, name?: string): Promise<Project>` — id is a 12-hex random string; the folder is the replica; if it is not a jj repo, `initColocated` it; `ensureMemoryReplica` + `importMemory`.
  - `addProjectFromUpstream(cfg, db, url: string, name?: string): Promise<Project>` — `cloneColocated(url, paths(cfg).replica(id))`.
  - `listProjects(db): Project[]`, `getProject(db, id): Project | null`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/context.test.ts
import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { loadContext, composeSettings, composeEnv, DEFAULT_CONTEXT } from "../src/projects/context";
test("missing file gives defaults", async () => {
  expect(await loadContext(await mkdtemp("/tmp/ctx-"))).toEqual(DEFAULT_CONTEXT);
});
test("parses and composes", async () => {
  const r = await mkdtemp("/tmp/ctx-"); await mkdir(`${r}/.meddle`);
  await writeFile(`${r}/.meddle/context.toml`, `instructions = "Use cargo nextest."\n[env]\nRUST_LOG = "debug"\n[claude]\nask = ["Bash(git push *)"]\n[claude.autoMode]\nallow = ["Cargo builds"]\n[resources]\nruns = ["cargo"]\n`);
  const c = await loadContext(r);
  expect(c.env.RUST_LOG).toBe("debug");
  const s = composeSettings([c]) as any;
  expect(s.autoMode.allow).toEqual(["$defaults", "Cargo builds"]);
  expect(s.permissions.ask).toEqual(["Bash(git push *)"]);
  expect(composeEnv([DEFAULT_CONTEXT, c])).toEqual({ RUST_LOG: "debug" });
});
test("unknown key is named", async () => {
  const r = await mkdtemp("/tmp/ctx-"); await mkdir(`${r}/.meddle`);
  await writeFile(`${r}/.meddle/context.toml`, `[claude]\nallwo = []\n`);
  await expect(loadContext(r)).rejects.toThrow("unknown key claude.allwo");
});
```

```ts
// test/project.test.ts
import { test, expect } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { loadConfig, ensureDataDirs } from "../src/config";
import { openDb } from "../src/store/db";
import { addProjectFromFolder, listProjects } from "../src/projects/project";
import { isJjRepo } from "../src/jj";
test("a plain git folder becomes a colocated jj replica", async () => {
  const home = await mkdtemp("/tmp/meddle-proj-");
  const folder = `${home}/repo`;
  Bun.spawnSync(["git", "init", "-q", folder]);
  const cfg = loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/data`, MEDDLE_TASK_ROOT: home });
  await ensureDataDirs(cfg);
  const db = openDb(`${home}/data/meddle.sqlite`);
  const p = await addProjectFromFolder(cfg, db, folder);
  expect(p.id).toMatch(/^[0-9a-f]{12}$/);
  expect(p.replica).toBe(folder);
  expect(await isJjRepo(folder)).toBe(true);
  expect(listProjects(db).map(x => x.id)).toEqual([p.id]);
});
```

- [ ] **Step 2: Run to verify failure** — FAIL
- [ ] **Step 3: Implement** `store/db.ts`, `store/records.ts`, `projects/context.ts` (parse with `smol-toml`, validate with TypeBox `Value.Check` and report the first unknown path), `projects/project.ts`.
- [ ] **Step 4: Run to verify pass** — `bun test test/context.test.ts test/project.test.ts` → PASS
- [ ] **Step 5: Commit** — `jj commit -m "feat: projects, context.toml and the meddle database"`

---

### Task 8: Task manifest and provisioning

**Files:**
- Create: `src/tasks/manifest.ts`, `src/tasks/provision.ts`, `test/provision.test.ts`

**Interfaces:**
- Produces:
  - `type TaskManifest = { id: string; title: string; sessionId: string; projects: Array<{ id: string; name: string; replica: string; workspace: string; parent: string }>; primaryProjectId: string; createdAt: string }` — `id` 12 hex, `sessionId` a UUID v4, `workspace` the workspace folder name (the project name), `replica` the project's repo path on this node.
  - `readManifest(cfg, taskId): Promise<TaskManifest>`, `writeManifest(cfg, m): Promise<void>` at `paths(cfg).taskManifest(id)`.
  - `provisionTask(cfg, db, input: { title: string; projectIds: string[]; parents?: Record<string,string> }): Promise<TaskManifest>` — in order: `checkTaskRoot` (throw its reason if not ok; the reason text starts with `task root`); `seedProfile`, `ensurePlugins`; create `<task>/.meddle/claude/`; for each project `workspaceAdd(replica, "meddle-<taskId>", <task>/<name>, parent ?? trunkRevset(replica))` then `bookmarkSet(replica, "meddle/task/<taskId>/<name>", changeId(<task>/<name>))`; `linkProfile`; `ensureMemoryReplica` + `linkMemory` for the primary project; write the generated `<task>/CLAUDE.md`; write the manifest; insert the `tasks` row with `state: "idle"`.
  - `generatedClaudeMd(m: TaskManifest, projects: Project[]): string` — exact copy: a heading `# Task: <title>`, then one line per project `- <name>/: jj workspace of project <name>`, then the line `This folder is a meddle task. Each project is a jj workspace; commit with jj.`
  - `cwdFor(m, cfg): { cwd: string; projectConfigRoot?: string; settingSources: ("user"|"project"|"local")[] }` — single project: `cwd` = the workspace, `projectConfigRoot` = that project's `replica` from the manifest, sources `['user','project','local']`; several: `cwd` = the task folder, no `projectConfigRoot`, sources `['user']`.

- [ ] **Step 1: Write the failing test**

```ts
// test/provision.test.ts
import { test, expect } from "bun:test";
import { mkdtemp, readlink, readFile, lstat } from "node:fs/promises";
import { loadConfig, ensureDataDirs, paths } from "../src/config";
import { openDb } from "../src/store/db";
import { addProjectFromFolder } from "../src/projects/project";
import { provisionTask, cwdFor } from "../src/tasks/provision";
import { initColocated, isJjRepo } from "../src/jj";
test("provision creates workspaces, config dir links and CLAUDE.md, seeding the profile first", async () => {
  const home = await mkdtemp("/tmp/meddle-prov-");
  const cfg = loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/data`, MEDDLE_TASK_ROOT: `${home}/tasks` });
  await ensureDataDirs(cfg);
  await (await import("node:fs/promises")).mkdir(cfg.taskRoot, { recursive: true });
  const db = openDb(`${home}/data/meddle.sqlite`);
  const a = `${home}/a`; await initColocated(a);
  const pa = await addProjectFromFolder(cfg, db, a, "a");
  const m = await provisionTask(cfg, db, { title: "t", projectIds: [pa.id] });
  const task = paths(cfg).task(m.id);
  expect((await lstat(`${task}/a/.jj`)).isDirectory()).toBe(true);
  expect(await readlink(`${task}/.meddle/claude/skills`)).toBe(`${paths(cfg).profile}/skills`);
  expect(await readlink(`${task}/.meddle/claude/projects/${pa.id}/memory`)).toBe(paths(cfg).memory(pa.id));
  expect(await readFile(`${task}/CLAUDE.md`, "utf8")).toContain("# Task: t");
  expect(await isJjRepo(paths(cfg).profile)).toBe(true);
  expect(m.projects[0]).toMatchObject({ id: pa.id, name: "a", replica: a, workspace: "a" });
  expect(await Bun.file(`${task}/a/.git`).exists()).toBe(true);
  expect(await (await import("../src/jj")).jj(["bookmark", "list", `meddle/task/${m.id}/a`], a)).toContain(`meddle/task/${m.id}/a`);
  expect(cwdFor(m, cfg)).toEqual({ cwd: `${task}/a`, projectConfigRoot: a, settingSources: ["user", "project", "local"] });
});
test("provision refuses without a task root", async () => {
  const home = await mkdtemp("/tmp/meddle-prov-");
  const cfg = loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/data`, MEDDLE_TASK_ROOT: `${home}/missing` });
  await ensureDataDirs(cfg);
  const db = openDb(`${home}/data/meddle.sqlite`);
  await expect(provisionTask(cfg, db, { title: "t", projectIds: [] })).rejects.toThrow(/task root/);
});
```

- [ ] **Step 2: Run to verify failure** — FAIL
- [ ] **Step 3: Implement `src/tasks/manifest.ts` and `src/tasks/provision.ts`**.
- [ ] **Step 4: Run to verify pass** — PASS
- [ ] **Step 5: Commit** — `jj commit -m "feat: task provisioning with jj workspaces and a linked config dir"`

---

### Task 9: Event log and SessionStore

**Files:**
- Create: `src/store/events.ts`, `src/store/session-store.ts`, `test/events.test.ts`, `test/session-store.test.ts`
- Modify: `src/store/db.ts` (migrations)

**Interfaces:**
- Produces:
  - Tables: `events(task_id TEXT, seq INTEGER, type TEXT, subtype TEXT, uuid TEXT, at TEXT, json TEXT, PRIMARY KEY(task_id, seq))`; `transcript(project_key TEXT, session_id TEXT, subpath TEXT NOT NULL DEFAULT '', seq INTEGER, uuid TEXT, ts INTEGER, json TEXT, PRIMARY KEY(project_key, session_id, subpath, seq))` with a unique index on `(project_key, session_id, subpath, uuid)` where `uuid` is not null. `subpath` is never null, so the unique index actually dedupes the main transcript (SQLite treats nulls as distinct). `ts` is the entry's `timestamp` parsed to epoch milliseconds, else the insertion time.
  - `appendEvent(db, taskId: string, message: unknown): number` — stores any object; `type`/`subtype`/`uuid` columns are read if present, else null; returns the new `seq` (1-based per task).
  - `listEvents(db, taskId, opts?: { fromSeq?: number; limit?: number }): Array<{ seq: number; message: unknown }>`.
  - `class SqliteSessionStore implements SessionStore` (type from the SDK): `append(key, entries)` ignores an entry whose `uuid` already exists for that key; `load(key)` **always returns `null`** (Global Constraints: the SDK's resume-from-store path would replace the task's config directory); `loadStored(key): Promise<SessionStoreEntry[] | null>` returns the entries in `seq` order for meddle's own use; `listSessions(projectKey)` returns `{ sessionId, mtime }` with `mtime` the max `ts` as an integer; `listSubkeys({projectKey, sessionId})` returns distinct non-empty subpaths; `delete(key)` removes the key and, when `subpath` is absent, all its subkeys.

- [ ] **Step 1: Write the failing tests**

```ts
// test/events.test.ts
import { test, expect } from "bun:test";
import { openDb } from "../src/store/db";
import { appendEvent, listEvents } from "../src/store/events";
test("unknown message shapes are stored verbatim with sequence numbers", () => {
  const db = openDb(":memory:");
  expect(appendEvent(db, "t", { type: "assistant", uuid: "u1" })).toBe(1);
  expect(appendEvent(db, "t", { type: "something_new", payload: { x: 1 } })).toBe(2);
  expect(listEvents(db, "t").map(e => e.message)).toEqual([{ type: "assistant", uuid: "u1" }, { type: "something_new", payload: { x: 1 } }]);
  expect(listEvents(db, "t", { fromSeq: 2 }).length).toBe(1);
});
```

```ts
// test/session-store.test.ts
import { test, expect } from "bun:test";
import { openDb } from "../src/store/db";
import { SqliteSessionStore } from "../src/store/session-store";
test("append dedupes on uuid; load, subkeys, delete", async () => {
  const s = new SqliteSessionStore(openDb(":memory:"));
  const key = { projectKey: "p", sessionId: "s" };
  await s.append(key, [{ type: "user", uuid: "a" }, { type: "assistant", uuid: "b" }]);
  await s.append(key, [{ type: "assistant", uuid: "b" }, { type: "result", uuid: "c", timestamp: "2026-10-30T10:00:00.000Z" }]);
  expect((await s.loadStored(key))!.map(e => e.uuid)).toEqual(["a", "b", "c"]);
  expect(await s.load(key)).toBeNull(); // always: the SDK must resume from the task's own config dir
  await s.append({ ...key, subpath: "subagents/agent-1" }, [{ type: "user", uuid: "d" }]);
  expect(await s.listSubkeys!(key)).toEqual(["subagents/agent-1"]);
  const [listed] = await s.listSessions!("p");
  expect(listed.sessionId).toBe("s"); expect(Number.isInteger(listed.mtime)).toBe(true);
  await s.delete!(key);
  expect(await s.loadStored(key)).toBeNull();
  expect(await s.listSubkeys!(key)).toEqual([]);
});
```

- [ ] **Step 2: Run to verify failure** — FAIL
- [ ] **Step 3: Implement** the migrations and both modules. Import the `SessionStore`, `SessionKey` and `SessionStoreEntry` types from `@anthropic-ai/claude-agent-sdk`.
- [ ] **Step 4: Run to verify pass** — PASS
- [ ] **Step 5: Commit** — `jj commit -m "feat: event log and SQLite SessionStore"`

---

### Task 10: Recorder and replayer for offline engine tests

**Files:**
- Create: `test/fake-claude/record.ts`, `test/fake-claude/replay.ts`, `test/fake-claude/replay.test.ts`, `test/fixtures/hello.jsonl`, `test/fixtures/approval.jsonl`

**Interfaces:**
- Produces:
  - `record.ts`: run as `MEDDLE_LIVE=1 bun run test/fake-claude/record.ts <name> <prompt>`. Calls the real SDK `query()` with a `spawnClaudeCodeProcess` that does `child_process.spawn(options.command, options.args, { cwd: options.cwd, env: options.env, stdio: "pipe", signal: options.signal })` (there is no exported default spawn to wrap) and tees: every line written to the child's stdin and every line read from its stdout is appended to `test/fixtures/<name>.jsonl` as `{ "dir": "in" | "out", "t": <ms since start>, "line": <string> }`. Recording runs isolated so the user's own settings cannot change the frames: `env` with a fresh temporary `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_OAUTH_TOKEN`, `PATH`, `HOME`; `settingSources: []`. Uses `claude-haiku-5-5`, `permissionMode: 'auto'`, `tools: []` for `hello`; for `approval` uses `tools: ['Bash']`, `permissionMode: 'default'`, a prompt that runs `echo hi`, and a `canUseTool` that allows, so the recording contains one `can_use_tool` control request and its response.
  - `replay.ts`: a bun script used as `claudePath` with `claudeRuntime: "bun"`; the SDK runs a `.ts` path as `[executable, path, ...args]`, so no shebang is needed. Reads `MEDDLE_FIXTURE` (path) and `MEDDLE_FIXTURE_STALL` (when `1`, pause forever before emitting the `result` line; used by Task 13's crash test). Protocol: emit recorded `out` lines in order; before emitting an `out` line that follows an `in` line in the recording, wait until a matching `in` line has arrived on stdin. Matching: a `control_response` matches when its `request_id` equals the id of the most recent `control_request` emitted (ids are taken from the live run, not the recording); a `user` message matches any `user` message; a `control_request` from the host (`initialize` and any other subtype) is answered with the recorded response for that subtype, with its `request_id` substituted. Exit 0 after the last `out` line and stdin EOF. Any argv is accepted and ignored.
  - `fixtures/hello.jsonl`: init → one assistant message `ok` → result. `fixtures/approval.jsonl`: init → assistant with a `Bash` tool_use → `control_request can_use_tool` → tool_result → assistant → result.

- [ ] **Step 1: Write the failing test**

```ts
// test/fake-claude/replay.test.ts
import { test, expect } from "bun:test";
import { query } from "@anthropic-ai/claude-agent-sdk";
test("the SDK drives the replayer through a recorded hello session", async () => {
  const seen: string[] = [];
  const q = query({ prompt: "Reply with the single word ok.", options: {
    pathToClaudeCodeExecutable: `${import.meta.dir}/replay.ts`, executable: "bun",
    env: { ...process.env, MEDDLE_FIXTURE: `${import.meta.dir}/../fixtures/hello.jsonl` },
    settingSources: [], permissionMode: "auto", tools: [],
  }});
  for await (const m of q) seen.push(m.type);
  expect(seen[0]).toBe("system");
  expect(seen.at(-1)).toBe("result");
});
```

- [ ] **Step 2: Run to verify failure** — FAIL (no replayer, no fixture).
- [ ] **Step 3: Write `record.ts`**, then run it once against the real Claude Code with the shared token in the environment to produce both fixtures: `MEDDLE_LIVE=1 CLAUDE_CODE_OAUTH_TOKEN=$(cat ~/.config/claude-shared-token) bun run test/fake-claude/record.ts hello "Reply with the single word ok."` and the same with `approval` and the prompt `Run: echo hi`. Scrub any line containing the token before saving (there should be none).
- [ ] **Step 4: Write `replay.ts`** to the protocol above.
- [ ] **Step 5: Run to verify pass** — `bun test test/fake-claude/replay.test.ts` → PASS
- [ ] **Step 6: Commit** — `jj commit -m "test: record and replay Claude Code stream-json sessions"`

---

### Task 11: Engine options

**Files:**
- Create: `src/engine/options.ts`, `test/options.test.ts`

**Interfaces:**
- Consumes: `TaskManifest`, `cwdFor` (Task 8), `Context`, `composeSettings`, `composeEnv` (Task 7), `getToken` (Task 4), `SqliteSessionStore` (Task 9).
- Produces:
  - `type EngineInput = { cfg: NodeConfig; manifest: TaskManifest; contexts: Context[]; projectSettings: Record<string, unknown>[]; token: string; prompt: AsyncIterable<SDKUserMessage>; canUseTool: CanUseTool; onPermissionDenied: (input: PermissionDeniedHookInput) => void; sessionStore: SessionStore; resume: boolean; model?: string; tools?: string[]; effort?: string; claudePath?: string; claudeRuntime?: "bun" | "node"; extraEnv?: Record<string, string> }` — `resume` means "this task has started a session before" (the `tasks.started` flag), not "recovering from a crash".
  - `buildOptions(i: EngineInput): Options` — sets exactly: `cwd`, `projectConfigRoot`, `settingSources` from `cwdFor(manifest, cfg)`; `sessionId: manifest.sessionId` when `!resume`, else `resume: manifest.sessionId`; `permissionMode: 'auto'`; `settings: composeSettings(contexts, projectSettings)` (an object); `systemPrompt: { type: 'preset', preset: 'claude_code', append: <joined non-empty instructions> }` or without `append` when none; `strictMcpConfig: true`; `env` = `{ PATH, HOME }` from `process.env`, then each name in `cfg.envPassthrough` that is set in `process.env`, then `{ CLAUDE_CONFIG_DIR: paths(cfg).taskConfig(id), CLAUDE_CODE_PROJECT_DIR_NAME: manifest.primaryProjectId, CLAUDE_CODE_OAUTH_TOKEN: token, ENABLE_CLAUDEAI_MCP_SERVERS: 'false' }`, then `composeEnv(contexts)`, then `extraEnv` last; `includePartialMessages: true`; `forwardSubagentText: true`; `canUseTool`; `hooks: { PermissionDenied: [{ hooks: [async input => { onPermissionDenied(input); return { continue: true } }] }] }`; `sessionStore`; `mcpServers` merged from contexts; `skills` from the last context that sets it; `persistSession: true`; `model`, `tools`, `effort` when given; when `claudePath` is given, `pathToClaudeCodeExecutable: claudePath` and `executable: claudeRuntime ?? 'bun'`. Add `envPassthrough: string[]` to `NodeConfig` (Task 2) with the Global Constraints default, overridable by `MEDDLE_ENV_PASSTHROUGH` (space-separated).

- [ ] **Step 1: Write the failing test**

```ts
// test/options.test.ts
import { test, expect } from "bun:test";
import { buildOptions } from "../src/engine/options";
import { DEFAULT_CONTEXT } from "../src/projects/context";
import { loadConfig } from "../src/config";
test("options match the spec", () => {
  const cfg = loadConfig({ HOME: "/h", MEDDLE_DATA_DIR: "/d", MEDDLE_TASK_ROOT: "/t" });
  const manifest = { id: "abc", title: "t", sessionId: "11111111-1111-4111-8111-111111111111", primaryProjectId: "p1", createdAt: "", projects: [{ id: "p1", name: "a", replica: "/r/a", workspace: "a", parent: "root()" }] };
  const common = { cfg, manifest, projectSettings: [], token: "tok", prompt: (async function*(){})(), canUseTool: async () => ({ behavior: "deny" as const, message: "x" }), onPermissionDenied: () => {}, sessionStore: {} as any };
  const o: any = buildOptions({ ...common, contexts: [{ ...DEFAULT_CONTEXT, env: { RUST_LOG: "debug" }, instructions: "Use nextest." }], resume: false, extraEnv: { MEDDLE_FIXTURE: "/f" }, claudePath: "/x/replay.ts" });
  expect(o.permissionMode).toBe("auto");
  expect(o.sessionId).toBe(manifest.sessionId); expect(o.resume).toBeUndefined();
  expect(o.cwd).toBe("/t/abc/a"); expect(o.projectConfigRoot).toBe("/r/a");
  expect(o.settingSources).toEqual(["user", "project", "local"]);
  expect(o.env).toMatchObject({ PATH: process.env.PATH, HOME: process.env.HOME, CLAUDE_CONFIG_DIR: "/t/abc/.meddle/claude", CLAUDE_CODE_PROJECT_DIR_NAME: "p1", CLAUDE_CODE_OAUTH_TOKEN: "tok", ENABLE_CLAUDEAI_MCP_SERVERS: "false", RUST_LOG: "debug", MEDDLE_FIXTURE: "/f" });
  for (const k of Object.keys(o.env)) expect(["PATH","HOME","CLAUDE_CONFIG_DIR","CLAUDE_CODE_PROJECT_DIR_NAME","CLAUDE_CODE_OAUTH_TOKEN","ENABLE_CLAUDEAI_MCP_SERVERS","RUST_LOG","MEDDLE_FIXTURE", ...cfg.envPassthrough]).toContain(k);
  expect(o.settings.autoMode.allow[0]).toBe("$defaults");
  expect(o.systemPrompt).toEqual({ type: "preset", preset: "claude_code", append: "Use nextest." });
  expect(o.includePartialMessages).toBe(true); expect(o.forwardSubagentText).toBe(true); expect(o.strictMcpConfig).toBe(true);
  expect(o.hooks.PermissionDenied).toHaveLength(1);
  expect(o.pathToClaudeCodeExecutable).toBe("/x/replay.ts"); expect(o.executable).toBe("bun");
  const r: any = buildOptions({ ...common, contexts: [], resume: true });
  expect(r.resume).toBe(manifest.sessionId); expect(r.sessionId).toBeUndefined(); expect(r.pathToClaudeCodeExecutable).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify failure** — FAIL
- [ ] **Step 3: Implement `src/engine/options.ts`**.
- [ ] **Step 4: Run to verify pass** — PASS
- [ ] **Step 5: Commit** — `jj commit -m "feat: build Agent SDK options for a task"`

---

### Task 12: Approvals, input queue and runTurn

**Files:**
- Create: `src/engine/approvals.ts`, `src/engine/input.ts`, `src/engine/session.ts`, `test/engine.test.ts`

**Interfaces:**
- Consumes: `buildOptions` (Task 11), `appendEvent` (Task 9), fixtures and `replay.ts` (Task 10).
- Produces:
  - `type PendingApproval = { requestId: string; taskId: string; toolName: string; input: Record<string, unknown>; toolUseId: string; decisionReason?: string; askedAt: string }`
  - `class Approvals { ask(req: Omit<PendingApproval,"askedAt">): Promise<PermissionResult>; answer(requestId: string, result: PermissionResult): boolean; pending(taskId?: string): PendingApproval[]; onChange(cb: () => void): () => void }` — `ask` resolves when `answer` is called with that id; `answer` returns `false` for an unknown id.
  - `class InputQueue implements AsyncIterable<SDKUserMessage> { push(text: string, priority: "now" | "next" = "next"): void; end(): void }` — yields `{ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: "", priority }` for each pushed text, waits while empty, finishes after `end()`. `"now"` is a steer into the running turn; `"next"` is a follow-up.
  - `runTurn(args: { input: Omit<EngineInput,"prompt"|"canUseTool"|"onPermissionDenied">; prompt: string; db: Database; approvals: Approvals; queue?: InputQueue; signal?: AbortSignal; onMessage?: (m: SDKMessage, seq: number) => void }): { query: Query; done: Promise<SDKResultMessage> }` — synchronous: creates the queue if none, pushes `prompt`, appends the synthetic first event `{ type: "meddle", subtype: "turn_started", at, resume: input.resume }`, builds options with `canUseTool` delegating to `approvals.ask` (`taskId` = `manifest.id`, mapping the SDK's `options.toolUseID`, `requestId`, `decisionReason`) and `onPermissionDenied` appending `{ type: "meddle", subtype: "permission_denied_hook", input }`, calls `query()` and returns the handle at once. `done` iterates the query, `appendEvent`s every message, resolves on the `result` message, then calls `queue.end()` so stdin EOF ends the child. `signal` aborting calls `query.close()` and rejects `done` with `AbortError`. Any error from the query rejects `done` after appending `{ type: "meddle", subtype: "turn_failed", error }`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/engine.test.ts
import { test, expect } from "bun:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import { openDb } from "../src/store/db";
import { listEvents } from "../src/store/events";
import { SqliteSessionStore } from "../src/store/session-store";
import { Approvals, } from "../src/engine/approvals";
import { runTurn } from "../src/engine/session";
import { loadConfig, ensureDataDirs } from "../src/config";
import { DEFAULT_CONTEXT } from "../src/projects/context";
const replay = `${import.meta.dir}/fake-claude/replay.ts`;
async function setup() {
  const home = await mkdtemp("/tmp/meddle-eng-");
  const cfg = loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/d`, MEDDLE_TASK_ROOT: `${home}/t` });
  await ensureDataDirs(cfg); await mkdir(`${home}/t/abc/a/.jj`, { recursive: true }); await mkdir(`${home}/t/abc/.meddle/claude`, { recursive: true });
  const db = openDb(":memory:");
  const manifest = { id: "abc", title: "t", sessionId: crypto.randomUUID(), primaryProjectId: "p1", createdAt: "", projects: [{ id: "p1", name: "a", replica: `${home}/t/abc/a`, workspace: "a", parent: "root()" }] };
  const fixture = (name: string) => ({ MEDDLE_FIXTURE: `${import.meta.dir}/fixtures/${name}.jsonl` });
  return { cfg, db, manifest, fixture, input: { cfg, manifest, projectSettings: [], contexts: [DEFAULT_CONTEXT], token: "tok", sessionStore: new SqliteSessionStore(db), resume: false, claudePath: replay, claudeRuntime: "bun" as const } };
}
test("hello: every message is recorded, the result returns, the child exits", async () => {
  const { db, input, fixture } = await setup();
  const { done } = runTurn({ input: { ...input, extraEnv: fixture("hello") }, prompt: "Reply with the single word ok.", db, approvals: new Approvals() });
  const result = await done;
  expect(result.type).toBe("result");
  const types = listEvents(db, "abc").map(e => (e.message as any).type);
  expect(types[0]).toBe("meddle"); expect(types).toContain("system"); expect(types.at(-1)).toBe("result");
});
test("approval: the dashboard's answer unblocks the tool", async () => {
  const { db, input, fixture } = await setup();
  const approvals = new Approvals();
  approvals.onChange(() => { for (const p of approvals.pending("abc")) approvals.answer(p.requestId, { behavior: "allow", updatedInput: p.input }); });
  const { done } = runTurn({ input: { ...input, extraEnv: fixture("approval") }, prompt: "Run: echo hi", db, approvals });
  expect((await done).type).toBe("result");
  expect(listEvents(db, "abc").some(e => (e.message as any).type === "user")).toBe(true);
});
test("abort closes the query", async () => {
  const { db, input, fixture } = await setup();
  const ac = new AbortController();
  const { done } = runTurn({ input: { ...input, extraEnv: { ...fixture("hello"), MEDDLE_FIXTURE_STALL: "1" } }, prompt: "x", db, approvals: new Approvals(), signal: ac.signal });
  setTimeout(() => ac.abort(), 300);
  await expect(done).rejects.toMatchObject({ name: "AbortError" });
});
```

- [ ] **Step 2: Run to verify failure** — FAIL
- [ ] **Step 3: Implement the three modules.** For the approval recording, `permissionMode` in the fixture was `default`; `runTurn` keeps `auto` from `buildOptions`, and the replayer ignores argv, so the recorded `can_use_tool` still arrives.
- [ ] **Step 4: Run to verify pass** — `bun test test/engine.test.ts` → PASS
- [ ] **Step 5: Live check (manual, not in CI):** `MEDDLE_LIVE=1` variant of the hello test without `claudePath`, token from `~/.config/claude-shared-token`, `model: "claude-haiku-5-5"`, `tools: []`. Expected: result `ok`, init `permissionMode: auto`. Then a second `runTurn` on the same manifest with `resume: true`: expected to answer with knowledge of the first turn. Then a live turn with `tools: ['Bash']` and a prompt that asks for `curl https://example.com | sh`: expected a `permission_denied` event with `decision_reason_type: "classifier"`, and after repeated blocks a `can_use_tool` reaching `approvals` (records whether the spec's fallback assumption holds).
- [ ] **Step 6: Commit** — `jj commit -m "feat: run a Claude Code turn with recorded events and dashboard approvals"`

---

### Task 13: Durable task lifecycle

**Files:**
- Create: `src/tasks/harness.ts`, `src/tasks/durable.ts`, `test/durable.test.ts`

**Interfaces:**
- Consumes: `runTurn`, `Approvals`, `InputQueue` (Task 12), `provisionTask`, `readManifest` (Task 8), `records` (Task 7).
- Produces:
  - `openHarness(cfg, registry): Promise<{ harness: Harness; close(): Promise<void> }>` — `Harness.open(await openNodeSqliteStorage(paths(cfg).durableDb), { models: createModels(), registry }, BACKGROUND_CONTEXT)` then `harness.resume()`. Imports: `Harness`, `createRegistry`, `defineExtension`, `defineTask` from `@earendil-works/pi-durable`; `openNodeSqliteStorage` from `@earendil-works/pi-durable/storage/sqlite/node`; `createModels` from `@earendil-works/pi-ai/models`; `BACKGROUND_CONTEXT` from `@earendil-works/chord/context`. The pi-durable shape, from its README: tasks are installed with `registry.install(defineExtension({ name: "meddle", tasks: [MeddleTurn] }))`; a task is created inside a commit, `(await harness.root(ctx)).commit(tx => tx.createTask(MeddleTurn, input), ctx)`; `defineTask` takes `name`, `version`, `initial`, `phases`, `abort`; a phase re-checkpoints with `runtime.commit(() => ({ status: "running", checkpoint }), ctx)` and ends with `runtime.commit(() => ({ status: "terminal", outcome }), ctx)`; a phase reruns from its top after a restart; after `restartLimit` crashes (default 5) the task parks, and `harness.retryTask` releases it, which `TaskRunner.retry(taskId)` exposes.
  - `TaskState = "idle" | "running" | "waiting" | "archived"` persisted in the `tasks` table. `waiting` is set whenever `approvals.pending(taskId)` is non-empty and cleared back to `running` when it is empty again.
  - A durable task type `meddle.turn`, `name: "meddle.turn"`, `version: 1`, input `{ taskId: string; prompt: string }`, checkpoint `{ phase: "run" }`. Its `run` phase: read the `tasks` row; `resume = row.started === 1`; set `started = 1` and state `running` in one SQLite transaction before anything else; `const { query, done } = runTurn({ ..., resume, signal: ctx.abortSignal })`; register `query` as the task's live query; await `done`; `turns += 1`; `bookmarkSet(replica, "meddle/task/<id>/<name>", changeId(workspace))` for each project; state `idle`; terminal `completed`. On a crash the phase reruns from its top with `started` already 1, so the rerun resumes the session. `abort` closes the live query and ends `aborted`.
  - `class TaskRunner { constructor(cfg, db, harness, deps: { claudePath?: string; claudeRuntime?: "bun"|"node"; extraEnv?: Record<string,string> }); create(input: { title; projectIds }): Promise<TaskManifest>; prompt(taskId, text): Promise<void>; interrupt(taskId): Promise<void>; setPermissionMode(taskId, mode): Promise<void>; setModel(taskId, model?: string): Promise<void>; retry(taskId): Promise<void>; approvals: Approvals; onEvent(cb: (taskId, seq, message) => void): () => void; onState(cb: (taskId, state: TaskState) => void): () => void; state(taskId): TaskState; liveQuery(taskId): Query | null }` — `prompt` pushes `text` with priority `"now"` onto the live turn's queue when the task is `running` or `waiting`, else creates a `meddle.turn`; `create` throws `Error("no token set")` when `getToken` is null, before provisioning.

- [ ] **Step 1: Write the failing tests**

```ts
// test/durable.test.ts
import { test, expect } from "bun:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import { loadConfig, ensureDataDirs, paths } from "../src/config";
import { openDb } from "../src/store/db";
import { addProjectFromFolder } from "../src/projects/project";
import { initColocated } from "../src/jj";
import { openHarness } from "../src/tasks/harness";
import { TaskRunner } from "../src/tasks/durable";
import { listEvents } from "../src/store/events";
const replay = `${import.meta.dir}/fake-claude/replay.ts`;
test("a prompt runs a durable turn and leaves the task idle", async () => {
  const home = await mkdtemp("/tmp/meddle-dur-");
  const cfg = loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/d`, MEDDLE_TASK_ROOT: `${home}/t` });
  await ensureDataDirs(cfg); await mkdir(cfg.taskRoot, { recursive: true });
  const db = openDb(paths(cfg).db);
  const a = `${home}/a`; await initColocated(a);
  const p = await addProjectFromFolder(cfg, db, a, "a");
  await (await import("../src/token")).setToken(cfg, "tok");
  const fixture = `${import.meta.dir}/fixtures/hello.jsonl`;
  const open = async (extra: Record<string,string> = {}) => { const { createRegistry } = await import("@earendil-works/pi-durable"); const h = await openHarness(cfg, createRegistry()); return { h, runner: new TaskRunner(cfg, db, h.harness, { claudePath: replay, claudeRuntime: "bun", extraEnv: { MEDDLE_FIXTURE: fixture, ...extra } }) }; };
  const { h, runner } = await open();
  const m = await runner.create({ title: "t", projectIds: [p.id] });
  const result = (r: TaskRunner, id: string) => new Promise<void>(res => r.onEvent((tid, _s, msg: any) => { if (tid === id && msg.type === "result") res(); }));
  const first = result(runner, m.id);
  await runner.prompt(m.id, "Reply with the single word ok.");
  await first; await Bun.sleep(50);
  expect(runner.state(m.id)).toBe("idle");
  const started = listEvents(db, m.id).filter(e => (e.message as any).subtype === "turn_started").map(e => (e.message as any).resume);
  expect(started).toEqual([false]);
  const second = result(runner, m.id);
  await runner.prompt(m.id, "Again.");
  await second;
  expect(listEvents(db, m.id).filter(e => (e.message as any).subtype === "turn_started").map(e => (e.message as any).resume)).toEqual([false, true]);
  await h.close();
});
test("a turn interrupted by a process death resumes after reopen", async () => {
  // same fixtures as above, but the first runner gets extraEnv MEDDLE_FIXTURE_STALL=1
  // 1. runner.prompt(...); wait for the turn_started event; h.close() — closing aborts the phase context, runTurn closes the query, the child dies
  // 2. open() again without the stall; await a result event for the same task id
  // 3. expect the turn_started events to be [false, true] and runner.state(id) === "idle"
});
```

Write the second test in full as the comments describe.

- [ ] **Step 2: Run to verify failure** — FAIL
- [ ] **Step 3: Implement `harness.ts` and `durable.ts`.**
- [ ] **Step 4: Run to verify pass** — `bun test test/durable.test.ts` → PASS
- [ ] **Step 5: Commit** — `jj commit -m "feat: durable task lifecycle with resumable turns"`

---

### Task 14: Metrics

**Files:**
- Create: `src/metrics.ts`, `test/metrics.test.ts`

**Interfaces:**
- Produces:
  - `processTree(pid: number): Array<{ pid: number; comm: string; rssKb: number }>` — the process and all descendants, from `/proc`.
  - `sampleTask(pid: number): { childRssKb: number; totalRssKb: number }` — `childRssKb` sums processes whose `comm` starts with `claude`; `totalRssKb` sums the tree.
  - `serviceRssKb(): number` — this process's `VmRSS`.
  - `type NodeMetrics = { at: string; serviceRssKb: number; eventLoopLagMs: number; tasks: Record<string, { childRssKb: number; totalRssKb: number }>; cores: number; memTotalKb: number; memAvailableKb: number; load1: number; diskFreeKb: number }`
  - `class MetricsSampler { constructor(opts: { taskPids: () => Record<string, number>; intervalMs: number; dataDir: string }); start(): void; stop(): void; latest(): NodeMetrics | null; onSample(cb: (m: NodeMetrics) => void): () => void }` — `eventLoopLagMs` measured with a timer; disk free from `statfs` of `dataDir`.
  - Startup latency is recorded by `runTurn` as events: `turn_started` already carries `at`; the first `system`/`init` event and the first `assistant` event carry their own `at`, so the dashboard computes latencies from the log. No separate metric.

- [ ] **Step 1: Write the failing test**

```ts
// test/metrics.test.ts
import { test, expect } from "bun:test";
import { processTree, sampleTask, serviceRssKb } from "../src/metrics";
test("process tree and rss", async () => {
  const p = Bun.spawn(["sh", "-c", "sleep 5 & sleep 5"], {});
  await Bun.sleep(100);
  const tree = processTree(p.pid);
  expect(tree.length).toBeGreaterThanOrEqual(2);
  expect(sampleTask(p.pid).totalRssKb).toBeGreaterThan(0);
  expect(serviceRssKb()).toBeGreaterThan(1000);
  p.kill();
});
```

- [ ] **Step 2: Run to verify failure** — FAIL
- [ ] **Step 3: Implement `src/metrics.ts`** reading `/proc/<pid>/status`, `/proc/<pid>/task/<tid>/children` or scanning `/proc/*/stat` for parents, `/proc/meminfo`, `/proc/loadavg`, `fs.statfs`.
- [ ] **Step 4: Run to verify pass** — PASS
- [ ] **Step 5: Commit** — `jj commit -m "feat: node and per-task metrics from /proc"`

---

### Task 15: chord state

**Files:**
- Create: `src/state/contracts.ts`, `src/state/host.ts`, `test/state.test.ts`

**Interfaces:**
- Consumes: `TaskRunner` (Task 13), `MetricsSampler` (Task 14), `listProjects` (Task 7), `listEvents` (Task 9), `tokenStatus` (Task 4), `VERSION` (Task 1).
- Produces, as chord `remote(...)` contracts hosted by `hostNamed("node")` (read `node_modules/@earendil-works/chord/docs/guide.md` and `docs/tutorial.md` first):
  - `NodeObject` id `meddle.node`, input `{}`; state `{ hostname: string; version: string; claudeCodeVersion: string; taskRoot: string; hostsTasks: boolean; metrics: NodeMetrics | null; token: { present: boolean; expiresAt: string | null }; taskIds: string[]; models: string[]; notifications: Array<{ id: string; at: string; taskId: string; kind: "approval" | "question" | "finished" | "failed"; text: string }> }` (newest 50 notifications kept); methods `createTask({ title, projectIds })`, `addProjectFromFolder({ path, name? })`, `addProjectFromUpstream({ url, name? })`, `dismiss({ id })`. `models` is refreshed from `query.supportedModels()` at each turn start.
  - `ProjectObject` id `meddle.project`, input `{ id }`; state `Project & { contextLoaded: boolean }`.
  - `TaskObject` id `meddle.task`, input `{ id }`; state `{ manifest: TaskManifest; state: TaskState; pending: PendingApproval[]; lastSeq: number; permissionMode: string | null; model: string | null; effort: string | null; contextUsage: unknown | null }`; methods `prompt({ text })`, `interrupt({})`, `approve({ requestId, updatedInput? })`, `deny({ requestId, message, interrupt? })`, `answerQuestion({ requestId, answers })` (for `AskUserQuestion`: allow with `updatedInput` = the original input plus `answers`), `setPermissionMode({ mode })`, `setModel({ model })`, `setEffort({ effort })` (applied as `EngineInput.effort` at the next turn start). `pending` is `approvals.pending(id)`. `permissionMode` and `model` come from the latest `system` `init` or `status` message; `contextUsage` from `query.getContextUsage()` after each turn.
  - `SessionObject` id `meddle.session`, input `{ taskId }`; state `{ window: Array<{ seq: number; message: unknown }>; fromSeq: number; live: { text: string; thinking: string } | null }` — the window holds the newest 200 events **excluding `stream_event`**; `stream_event` deltas update `live` instead, which is reset to `null` when the next non-stream event arrives; method `loadEarlier({ beforeSeq, limit })` returning events, not changing the window.
  - `createNodeHost(deps: { cfg; db; runner: TaskRunner; metrics: MetricsSampler; claudeCodeVersion: string }): Host` wiring providers for the four contracts. chord state changes need a `Context`; the node host opens one long-lived root (`host.root(async ctx => { ...; await never })`) and every callback from `runner.onEvent`, `runner.onState`, `approvals.onChange` and `metrics.onSample` applies its change through that context, following the guide's resource-backed event pattern if the guide requires it.
  - `claudeCodeVersion(): string` read from the SDK package's `manifest.json` `version` field.

- [ ] **Step 1: Write the failing test**

```ts
// test/state.test.ts
import { test, expect } from "bun:test";
import { memoryLinkPair, createHost } from "@earendil-works/chord";
import { createNodeHost, NodeObject, TaskObject, SessionObject } from "../src/state/host";
// Build the same fixtures as test/durable.test.ts (helper in test/helpers.ts), create a node host, connect a client host over memoryLinkPair,
// get NodeObject, call createTask, subscribe TaskObject state, call prompt with the hello fixture, and expect:
//   - the client sees task state go idle -> running -> idle
//   - SessionObject.window ends with a message of type "result"
//   - NodeObject.taskIds contains the new id
```

Write the test in full following chord's tutorial for `memoryLinkPair` and `host.root(ctx => ctx.get(Contract, input))`.

- [ ] **Step 2: Run to verify failure** — FAIL
- [ ] **Step 3: Implement contracts and host.** State updates come from `runner.onEvent`, `approvals.onChange`, `metrics.onSample`.
- [ ] **Step 4: Run to verify pass** — PASS
- [ ] **Step 5: Commit** — `jj commit -m "feat: chord objects for node, projects, tasks and sessions"`

---

### Task 16: Dashboard

**Files:**
- Create: `src/dashboard/server.ts`, `src/dashboard/ui/index.html`, `src/dashboard/ui/main.tsx`, `src/dashboard/ui/thread-model.ts`, `src/dashboard/ui/Pool.tsx`, `src/dashboard/ui/Task.tsx`, `src/dashboard/ui/Projects.tsx`, `src/dashboard/ui/Settings.tsx`, `test/thread-model.test.ts`

**Interfaces:**
- Consumes: the four contracts (Task 15); chord's `acceptWebSockets` and the browser entry `@earendil-works/chord` with `webSocketLink`.
- Produces:
  - `startDashboard(cfg, host: Host): Promise<{ url: string; stop(): Promise<void> }>` — `Bun.serve` on `127.0.0.1:<cfg.port>`: serves the UI built by `Bun.build` from `main.tsx` at startup (or `bun build` output in `dist/ui` when present), and upgrades `/ws` to a chord link. chord's `acceptWebSockets` expects a Node-style server emitting `connection` with sockets that have `readyState`, `send`, `close` and `addEventListener`; Bun's `ServerWebSocket` has no `addEventListener`. Write `src/dashboard/ws-shim.ts`: `class BunSocketShim` wrapping a `ServerWebSocket` as an `EventTarget` fed from `Bun.serve`'s `websocket.message` and `websocket.close` handlers, and on each `open` call `host.accept(webSocketLink(shim), { principal, kind: "client" })` (or feed a tiny `connection`-emitting server object to `acceptWebSockets`, whichever the guide makes simpler). Test the shim with a bun WebSocket client round trip.
  - `thread-model.ts`, pure: `type ThreadItem = { kind: "user"; text } | { kind: "assistant"; text; thinking?: string } | { kind: "tool"; name; input; toolUseId; result?: { text: string; isError: boolean }; children: ThreadItem[]; agentId?: string } | { kind: "question"; toolUseId; questions: unknown } | { kind: "denied"; toolName; reason?: string; reasonType?: string } | { kind: "status"; text } | { kind: "unknown"; type: string; raw: unknown }`; `buildThread(events: Array<{ seq: number; message: unknown }>): ThreadItem[]` — ignores `stream_event` entirely (the live cell covers them), groups streamed `assistant` blocks by message id, attaches `tool_result` user blocks to their `tool_use` by id, nests messages with `parent_tool_use_id` under that call, renders a `tool_use` named `AskUserQuestion` as `question`, maps `permission_denied` to `denied`, maps `system` `status` and `compact_boundary` to `status`, and anything unrecognised to `unknown`.
  - UI views per the spec section 12, single node: Pool (one card: hostname, versions, token expiry, metrics, tasks; a notifications strip fed from `NodeObject.notifications` with dismiss), Task (thread from `SessionObject.window` plus the `live` text, "load earlier", composer that calls `prompt`, approval panel listing `pending` with Allow / Allow with edited input / Deny / Deny and interrupt, and for an `AskUserQuestion` the questions and options answered through `answerQuestion`; Interrupt; permission mode select; model select from `NodeObject.models`; effort select; context usage), Projects (add from folder or URL, list), Settings (token status).

- [ ] **Step 1: Write the failing test**

```ts
// test/thread-model.test.ts
import { test, expect } from "bun:test";
import { buildThread } from "../src/dashboard/ui/thread-model";
test("tool calls get their results and subagent messages nest", () => {
  const items = buildThread([
    { seq: 1, message: { type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } }] }, parent_tool_use_id: null } },
    { seq: 2, message: { type: "assistant", message: { id: "m2", content: [{ type: "text", text: "inside" }] }, parent_tool_use_id: "tu1" } },
    { seq: 3, message: { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "a\nb", is_error: false }] }, parent_tool_use_id: null } },
    { seq: 4, message: { type: "system", subtype: "permission_denied", tool_name: "Bash", decision_reason_type: "classifier", decision_reason: "[Data Exfiltration]", message: "denied" } },
    { seq: 5, message: { type: "brand_new_thing", x: 1 } },
  ]);
  expect(items[0]).toMatchObject({ kind: "tool", name: "Bash", result: { text: "a\nb", isError: false } });
  expect((items[0] as any).children[0]).toMatchObject({ kind: "assistant", text: "inside" });
  expect(items[1]).toMatchObject({ kind: "denied", reasonType: "classifier", reason: "[Data Exfiltration]" });
  expect(items[2]).toMatchObject({ kind: "unknown", type: "brand_new_thing" });
});
```

- [ ] **Step 2: Run to verify failure** — FAIL
- [ ] **Step 3: Implement `thread-model.ts`**, then `ws-shim.ts`, the server and the Preact views. Use the `approval.jsonl` fixture's events as a second thread-model test input: `buildThread` over the recorded `out` lines parsed as messages must produce one `tool` item with a result, and add a `stream_event` entry to the first test's input to assert it produces no item.
- [ ] **Step 4: Run to verify pass** — `bun test test/thread-model.test.ts test/ws-shim.test.ts` → PASS
- [ ] **Step 5: Manual check:** `MEDDLE_FIXTURE=test/fixtures/approval.jsonl MEDDLE_CLAUDE_PATH=test/fake-claude/replay.ts bun run src/cli.ts serve` (Task 17), open the dashboard, create a task on a temp project, send a prompt, approve the Bash call in the panel, see the result render.
- [ ] **Step 6: Commit** — `jj commit -m "feat: dashboard with thread view, approvals and controls"`

---

### Task 17: CLI and end-to-end

**Files:**
- Modify: `src/cli.ts`
- Create: `test/e2e.test.ts`, `test/helpers.ts`

**Interfaces:**
- Produces, as subcommands:
  - `meddle serve` — `ensureDataDirs`, `seedProfile`, `ensurePlugins`, `checkTaskRoot` (a failure prints the reason, sets `hostsTasks: false`, and continues), `openDb`, `openHarness`, `TaskRunner`, `MetricsSampler` (interval 5000 ms), `createNodeHost`, `startDashboard`; prints `dashboard at http://127.0.0.1:<port>/`; honours `MEDDLE_CLAUDE_PATH`, `MEDDLE_CLAUDE_RUNTIME` and passes `MEDDLE_FIXTURE` and `MEDDLE_FIXTURE_STALL` through as `extraEnv` when set, for tests. SIGINT closes the harness and server.
  - `meddle project add <path-or-url> [--name <n>]`, `meddle project list`, `meddle task new --title <t> --project <id>...` (prints the task id), `meddle task prompt <id> <text>` (submits a turn and streams event types to stderr until the result): all of these connect to the running node over a WebSocket link to `127.0.0.1:<port>` and call the chord objects' methods. There is exactly one SQLite writer, the node. Without a running node they exit 1 with `meddle: start "meddle serve" first`.
  - `meddle status` prints version, Claude Code version, data dir, task root check, token status, task count; it reads the database read-only and works with or without a running node. `token set` and `service install` (Task 18) also run without the node.

- [ ] **Step 1: Write the failing test**

```ts
// test/e2e.test.ts
import { test, expect } from "bun:test";
// Start `bun run src/cli.ts serve` as a child with MEDDLE_DATA_DIR, MEDDLE_TASK_ROOT (temp, created), MEDDLE_PORT (free port),
// MEDDLE_CLAUDE_PATH=test/fake-claude/replay.ts, MEDDLE_CLAUDE_RUNTIME=bun, MEDDLE_FIXTURE=hello.jsonl,
// and a token set beforehand via `meddle token set --file`.
// Then: `project add <temp jj repo>`, `task new --title t --project <id>`, `task prompt <id> "Reply with the single word ok."`.
// Expect: task prompt exits 0 and its stderr contains "result"; `meddle status` reports 1 task and a present token; GET http://127.0.0.1:<port>/ returns 200.
```

Write it in full with a helper `startServe(env)` in `test/helpers.ts` that waits for the "dashboard at" line.

- [ ] **Step 2: Run to verify failure** — FAIL
- [ ] **Step 3: Implement the CLI.**
- [ ] **Step 4: Run to verify pass** — `bun test test/e2e.test.ts` → PASS; then `bun test` → all PASS.
- [ ] **Step 5: Commit** — `jj commit -m "feat: meddle CLI with serve, project, task, token and status"`

---

### Task 18: Build, install and README

**Files:**
- Create: `scripts/build.ts`, `install/meddle.service`, `README.md`
- Modify: `package.json` (scripts `build`, `install:service`), `src/cli.ts` (`service install`)

**Interfaces:**
- Produces:
  - `bun run build` → `dist/meddle` by shelling out to `bun build --compile src/cli.ts --outfile dist/meddle` with the UI bundled. The SDK locates its bundled `claude` through `node_modules`, which a compiled binary does not carry, so in Plan 1 the service runs from the checkout: the unit's `ExecStart` is `<bun> run src/cli.ts serve` with `WorkingDirectory=<checkout>`. The compiled binary is for `status` and `token set` on the command line; running `serve` from it requires `MEDDLE_CLAUDE_PATH`.
  - `meddle service install` — writes `~/.config/systemd/user/meddle.service` from the template (`ExecStart` as above, `WorkingDirectory`, `Restart=on-failure`), runs `systemctl --user daemon-reload` and `enable --now`, and prints the one privileged command the user must run once: `sudo install -d -o <user> -g <group> -m 755 /opt/meddle/tasks`.
  - README: what meddle is in three sentences, install, the task-root command, `token set`, `project add`, open the dashboard. Link the design doc and this plan.

- [ ] **Step 1: Build** — `bun run build`; run `dist/meddle --version`. Expected: `meddle 0.1.0`.
- [ ] **Step 2: Service file** — `bun run src/cli.ts service install --dry-run` prints the unit and the sudo command without writing. Add `--dry-run` for the test: `test/service.test.ts` asserts the printed unit contains `ExecStart=`, `serve` and `WorkingDirectory=`, and the printed sudo line contains `/opt/meddle/tasks`.
- [ ] **Step 3: Run the test** — PASS
- [ ] **Step 4: README**.
- [ ] **Step 5: Commit** — `jj commit -m "feat: compiled binary, user service install, README"`

---

## Self-review notes

- Spec coverage for a single node: sections 7 (projects, context, memory, profile), 8 (tasks, provisioning, durable types `meddle.task` as `TaskRunner` state and `meddle.turn`), 9 (engine options, approvals, verdicts via the hook and `permission_denied`, control), 10 store only (moves are Plan 3), 11 (token), 12 (dashboard views), 14 (metrics), 15 (token file mode, localhost bind). Sections 6, 10 moves and 13 replication are Plans 2 and 3; `meddle.move`, `meddle.sync`, `meddle.memory` durable types are deferred with them.
- Names used across tasks: `loadConfig`, `paths`, `ensureDataDirs`, `checkTaskRoot`, `NodeConfig.envPassthrough` (2); `initColocated`, `workspaceAdd`, `bookmarkSet`, `trunkRevset`, `changeId` (3); `getToken`, `tokenStatus` (4); `seedProfile`, `ensurePlugins`, `linkProfile` (5); `ensureMemoryReplica`, `importMemory`, `linkMemory` (6); `openDb`, `loadContext`, `loadProjectSettings`, `composeSettings`, `composeEnv`, `addProjectFromFolder`, `listProjects` (7); `provisionTask`, `cwdFor`, `readManifest`, `TaskManifest.projects[].replica` (8); `appendEvent`, `listEvents`, `SqliteSessionStore` with `load` null and `loadStored` (9); `claudePath`, `claudeRuntime`, `MEDDLE_FIXTURE`, `MEDDLE_FIXTURE_STALL` (10); `buildOptions`, `EngineInput` with `resume`, `extraEnv`, `model`, `tools`, `effort` (11); `Approvals.pending(taskId)`, `InputQueue.push(text, priority)`, `runTurn` returning `{ query, done }`, events `turn_started` and `turn_failed` (12); `openHarness(cfg, registry)`, `TaskRunner` with `onState`, `liveQuery`, `retry` (13); `MetricsSampler` (14); `createNodeHost` and the four contracts incl. `notifications`, `models`, `live`, `answerQuestion`, `setEffort` (15); `buildThread`, `startDashboard`, `ws-shim` (16); `MEDDLE_CLAUDE_PATH`, `MEDDLE_CLAUDE_RUNTIME` (17).
- Review Focus items are pinned: 1 in Task 4, 2 and 3 in Task 7, 4 in Tasks 9 and 16, 5 in Task 8.
- Reviewed by a Fable subagent on 2026-10-30; its 26 findings were applied except: `$defaults` stays on all three `autoMode` lists pending the live check in Task 12 step 5; `agents` from context is dropped since `agents/` is symlinked from the profile.
