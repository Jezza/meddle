import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";
import { createHost, webSocketLink, type Host } from "@earendil-works/chord";
import { createRegistry } from "@earendil-works/pi-durable";
import { checkTaskRoot, ensureDataDirs, loadConfig, paths, type NodeConfig } from "./config";
import { startDashboard, type Dashboard } from "./dashboard/server";
import { findTaskPids, MetricsSampler } from "./metrics";
import { ensurePlugins, seedProfile } from "./profile";
import { createNodeHost, NodeObject, ProjectObject, SessionObject, TaskObject } from "./state/host";
import { openDb } from "./store/db";
import { listTasks } from "./store/records";
import { TaskRunner, type RunnerDeps } from "./tasks/durable";
import { openHarness } from "./tasks/harness";
import { setToken, tokenStatus } from "./token";
import { claudeCodeVersion, VERSION } from "./version";

const USAGE = `usage: meddle --version
       meddle serve
       meddle status
       meddle token set [--file <path>] | meddle token status
       meddle project add <path-or-url> [--name <n>] | meddle project list
       meddle task new --title <t> --project <id>... | meddle task prompt <id> <text>`;

/** A client subcommand found no node listening on the configured port. */
class NoNode extends Error {
  constructor() {
    super('start "meddle serve" first');
  }
}

/** What `serve` has opened so far, closed by `shutdown`. */
type OpenNode = { db?: Database; harness?: { close(): Promise<void> }; metrics?: MetricsSampler; host?: Host; dashboard?: Dashboard };

/** Closes whatever of the node is open: the dashboard, metrics, the harness, the host, then the database. */
async function shutdown(node: OpenNode): Promise<void> {
  await node.dashboard?.stop();
  node.metrics?.stop();
  await node.harness?.close();
  await node.host?.close();
  node.db?.close();
}

/** Runs the node: its data, its durable turns, its chord objects and the dashboard, until SIGINT or SIGTERM. */
async function serve(): Promise<number> {
  // Installed first, so a signal during startup shuts down once startup is done; a repeated signal changes nothing.
  const signalled = Promise.withResolvers<void>();
  process.on("SIGINT", () => signalled.resolve());
  process.on("SIGTERM", () => signalled.resolve());

  const cfg = loadConfig();
  await ensureDataDirs(cfg);
  await seedProfile(cfg);
  await ensurePlugins(cfg);
  const root = await checkTaskRoot(cfg);
  if (!root.ok) console.error(`meddle: ${root.reason}; this node will not host tasks`);

  const node: OpenNode = {};
  try {
    const db = (node.db = openDb(paths(cfg).db));
    const harness = (node.harness = await openHarness(cfg, createRegistry()));
    const runner = new TaskRunner(cfg, db, harness.harness, runnerDeps());
    const metrics = (node.metrics = new MetricsSampler({
      taskPids: () => findTaskPids(cfg.taskRoot),
      intervalMs: 5000,
      dataDir: cfg.dataDir,
    }));
    metrics.start();
    const host = (node.host = createNodeHost({ cfg, db, runner, metrics, claudeCodeVersion: claudeCodeVersion() }));
    node.dashboard = await startDashboard(cfg, host);
  } catch (err) {
    await shutdown(node);
    throw err;
  }
  console.log(`dashboard at ${node.dashboard.url}`);

  await signalled.promise;
  await shutdown(node);
  return 0;
}

/** How turns start Claude Code: the real binary, or (for tests) `MEDDLE_CLAUDE_PATH` with the fixture env passed on. */
function runnerDeps(env = process.env): RunnerDeps {
  const deps: RunnerDeps = {};
  if (env.MEDDLE_CLAUDE_PATH) {
    deps.claudePath = env.MEDDLE_CLAUDE_PATH;
    deps.claudeRuntime = env.MEDDLE_CLAUDE_RUNTIME === "node" ? "node" : "bun";
  }
  const extraEnv: Record<string, string> = {};
  for (const name of ["MEDDLE_FIXTURE", "MEDDLE_FIXTURE_STALL"]) {
    const value = env[name];
    if (value !== undefined) extraEnv[name] = value;
  }
  if (Object.keys(extraEnv).length > 0) deps.extraEnv = extraEnv;
  return deps;
}

/** Version, Claude Code version, data dir, task root, token and task count; reads the database read-only. */
async function status(): Promise<number> {
  const cfg = loadConfig();
  const root = await checkTaskRoot(cfg);
  const token = await tokenStatus(cfg);
  console.log(`meddle ${VERSION}`);
  console.log(`claude code ${claudeCodeVersion()}`);
  console.log(`data dir ${cfg.dataDir}`);
  console.log(root.ok ? `task root ${cfg.taskRoot} ok` : root.reason);
  console.log(`token ${token.present ? `present expires ${token.expiresAt}` : "absent"}`);
  console.log(`tasks ${taskCount(cfg)}`);
  return 0;
}

function taskCount(cfg: NodeConfig): number {
  const file = paths(cfg).db;
  if (!existsSync(file)) return 0;
  const db = new Database(file, { readonly: true });
  try {
    return listTasks(db).length;
  } finally {
    db.close();
  }
}

async function tokenSet(file: string | undefined): Promise<number> {
  const input = file !== undefined ? await Bun.file(file).text() : await Bun.stdin.text();
  const cfg = loadConfig();
  await ensureDataDirs(cfg);
  await setToken(cfg, input);
  console.log("token set");
  return 0;
}

async function tokenShow(): Promise<number> {
  const s = await tokenStatus(loadConfig());
  console.log(`present: ${s.present}`);
  if (s.present) {
    console.log(`setAt: ${s.setAt}`);
    console.log(`expiresAt: ${s.expiresAt}`);
  }
  return 0;
}

/** A client host linked to the running node at `ws://127.0.0.1:<port>/ws`, and the socket under it. */
async function connect(): Promise<{ client: Host; socket: WebSocket }> {
  const socket = new WebSocket(`ws://127.0.0.1:${loadConfig().port}/ws`);
  const opened = await new Promise<boolean>((done) => {
    socket.addEventListener("open", () => done(true));
    socket.addEventListener("error", () => done(false));
    socket.addEventListener("close", () => done(false));
  });
  if (!opened) throw new NoNode();
  const client = createHost({ name: "cli", self: "cli", kind: "client", upstream: { link: webSocketLink(socket), principal: "node" } });
  return { client, socket };
}

/** Runs `use` against the running node, closing the link afterwards. */
async function withNode(use: (client: Host, socket: WebSocket) => Promise<number>): Promise<number> {
  const { client, socket } = await connect();
  try {
    return await use(client, socket);
  } finally {
    await client.close();
  }
}

/** Adds an existing directory as a folder project, anything else as an upstream URL; prints the project id. */
function projectAdd(source: string, name: string | undefined): Promise<number> {
  return withNode(async (client) => {
    const node = await client.get(NodeObject, {});
    const named = name === undefined ? {} : { name };
    const isFolder = await stat(source).then((s) => s.isDirectory(), () => false);
    const project = isFolder
      ? await node.addProjectFromFolder({ path: resolve(source), ...named })
      : await node.addProjectFromUpstream({ url: source, ...named });
    console.log(project.id);
    return 0;
  });
}

function projectList(): Promise<number> {
  return withNode(async (client) => {
    const node = await client.get(NodeObject, {});
    for (const id of node.projectIds.value) {
      const project = await client.get(ProjectObject, { id });
      console.log(`${project.id.value}  ${project.name.value}  ${project.replica.value}`);
      project.release();
    }
    return 0;
  });
}

function taskNew(title: string, projectIds: string[]): Promise<number> {
  return withNode(async (client) => {
    const node = await client.get(NodeObject, {});
    console.log((await node.createTask({ title, projectIds })).id);
    return 0;
  });
}

type WindowEvent = { seq: number; message: unknown };

/**
 * Submits a turn and prints each new event's `type[/subtype]` to stderr until a `result` arrives. A `turn_failed`
 * event, or the task going idle again with no `result` (a turn that failed before it logged anything), fails it.
 */
function taskPrompt(id: string, text: string): Promise<number> {
  return withNode(async (client, socket) => {
    const task = await client.get(TaskObject, { id });
    const session = await client.get(SessionObject, { taskId: id });
    let printed = session.window.value.at(-1)?.seq ?? 0;
    const finished = Promise.withResolvers<void>();
    finished.promise.catch(() => {}); // a failed prompt leaves it unawaited when the socket then closes
    socket.addEventListener("close", () => finished.reject(new Error("the node closed the connection")));
    const follow = (events: readonly WindowEvent[]) => {
      for (const { seq, message } of events) {
        if (seq <= printed) continue;
        printed = seq;
        const { type, subtype } = message as { type?: string; subtype?: string };
        console.error(subtype === undefined ? `${type}` : `${type}/${subtype}`);
        if (type === "result") return finished.resolve();
        if (type === "meddle" && subtype === "turn_failed") return finished.reject(new Error("the turn failed"));
      }
    };
    /** Idle again: the database has every event the turn logged, so a `result` missing from it means failure. */
    const settle = async () => {
      follow(await session.loadEarlier({ beforeSeq: Number.MAX_SAFE_INTEGER, limit: 200 }));
      finished.reject(new Error("the turn failed"));
    };
    let busy = false;
    const unsubscribe = [
      session.window.subscribe(follow),
      task.state.subscribe((state) => {
        if (state !== "idle") busy = true;
        else if (busy) settle().catch((err: Error) => finished.reject(err));
      }),
    ];
    try {
      await task.prompt({ text });
      await finished.promise;
    } finally {
      for (const stop of unsubscribe) stop();
    }
    return 0;
  });
}

/** `--title <t>` and `--project <id>...` (one or more ids, the flag repeatable). */
function taskNewArgs(args: string[]): { title: string; projectIds: string[] } | null {
  let title: string | undefined;
  const projectIds: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--title" && i + 1 < args.length) title = args[++i];
    else if (args[i] === "--project") while (i + 1 < args.length && !args[i + 1]!.startsWith("--")) projectIds.push(args[++i]!);
    else return null;
  }
  return title === undefined || projectIds.length === 0 ? null : { title, projectIds };
}

/** The subcommand `args` names, or null for a usage error. */
function dispatch(args: string[]): (() => Promise<number>) | null {
  const [command, sub, ...rest] = args;
  if (args.length === 1 && command === "--version") return async () => (console.log(`meddle ${VERSION}`), 0);
  if (args.length === 1 && command === "serve") return serve;
  if (args.length === 1 && command === "status") return status;
  if (command === "token" && sub === "set" && rest.length === 0) return () => tokenSet(undefined);
  if (command === "token" && sub === "set" && rest.length === 2 && rest[0] === "--file") return () => tokenSet(rest[1]);
  if (command === "token" && sub === "status" && rest.length === 0) return tokenShow;
  if (command === "project" && sub === "add" && rest.length === 1) return () => projectAdd(rest[0]!, undefined);
  if (command === "project" && sub === "add" && rest.length === 3 && rest[1] === "--name") return () => projectAdd(rest[0]!, rest[2]);
  if (command === "project" && sub === "list" && rest.length === 0) return projectList;
  if (command === "task" && sub === "new") {
    const parsed = taskNewArgs(rest);
    return parsed === null ? null : () => taskNew(parsed.title, parsed.projectIds);
  }
  if (command === "task" && sub === "prompt" && rest.length >= 2) return () => taskPrompt(rest[0]!, rest.slice(1).join(" "));
  return null;
}

const run = dispatch(process.argv.slice(2));
if (run === null) {
  console.error(USAGE);
  process.exit(2);
}
try {
  process.exit(await run());
} catch (err) {
  console.error(`meddle: ${(err as Error).message}`);
  process.exit(1);
}
