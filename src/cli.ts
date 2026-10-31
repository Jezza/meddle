import { existsSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { createHost, webSocketLink, type Host } from "@earendil-works/chord";
import { createRegistry } from "@earendil-works/pi-durable";
import { checkTaskRoot, ensureDataDirs, loadConfig, paths, type NodeConfig } from "./config";
import { startDashboard, type Dashboard } from "./dashboard/server";
import { acceptDashboardStreams } from "./dashboard/tunnel";
import { runRemoteHelper } from "./git/helper";
import { writeHelperWrapper, writeUpdateHook } from "./git/scripts";
import { acceptGitStreams } from "./git/serve";
import { GitSocket } from "./git/socket";
import { findTaskPids, MetricsSampler } from "./metrics";
import { loadOrCreateIdentity, shortId } from "./pool/identity";
import { dedupe } from "./pool/report";
import { startPool, type PoolRuntime } from "./pool/runtime";
import { PoolStore } from "./pool/store";
import { ensurePlugins, seedProfile } from "./profile";
import { resultError } from "./engine/session";
import { PoolObject } from "./state/contracts";
import { createNodeHost, NodeObject, ProjectObject, SessionObject, TaskObject } from "./state/host";
import { openDb } from "./store/db";
import { listLiveTasks } from "./store/records";
import { TaskRunner, type RunnerDeps } from "./tasks/durable";
import { openHarness } from "./tasks/harness";
import { setToken, tokenStatus } from "./token";
import { claudeCodeVersion, VERSION } from "./version";

const USAGE = `usage: meddle --version
       meddle serve
       meddle status
       meddle invite
       meddle join <ticket>
       meddle pool
       meddle token set [--file <path>] | meddle token status
       meddle project add <path-or-url> [--name <n>] | meddle project list
       meddle task new --title <t> --project <id>... | meddle task prompt <id> <text> | meddle task retry <id>
       meddle service install [--dry-run]
       meddle git-remote <name> <url>   (git's remote helper for meddle:// remotes)`;

/** A client subcommand found no node listening on the configured port. */
class NoNode extends Error {
  constructor() {
    super('start "meddle serve" first');
  }
}

/** What `serve` has opened so far, closed by `shutdown`. */
type OpenNode = {
  db?: Database; harness?: { close(): Promise<void> }; metrics?: MetricsSampler; pool?: PoolRuntime; host?: Host; dashboard?: Dashboard;
  /** Stops accepting dashboard streams other nodes tunnel here. */
  stopTunnels?: () => void;
  /** Stops serving git streams other nodes open here. */
  stopGit?: () => void;
  /** The unix socket this node's git remote helper connects to. */
  gitSocket?: GitSocket;
};

/**
 * Closes whatever of the node is open: the dashboard, the tunnels, git (the acceptor, then the socket and its file),
 * the pool, metrics, the harness, the host, then the database.
 */
async function shutdown(node: OpenNode): Promise<void> {
  await node.dashboard?.stop();
  node.stopTunnels?.();
  node.stopGit?.();
  await node.gitSocket?.stop();
  await node.pool?.stop();
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
  // Before anything runs jj: git finds the helper for meddle:// remotes, and a push from a peer meets the hook.
  await writeHelperWrapper(cfg);
  await writeUpdateHook(cfg);
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
    const pool = (node.pool = await startPool(cfg, db, {
      version: VERSION,
      claudeCodeVersion: claudeCodeVersion(),
      hostsTasks: async () => (await checkTaskRoot(cfg)).ok,
      taskCount: () => listLiveTasks(db).length,
    }));
    const gitSocket = (node.gitSocket = new GitSocket(cfg, pool.net));
    await gitSocket.start();
    const logGit = dedupe((line) => console.error(line));
    node.stopGit = acceptGitStreams(pool.net, { db, cfg, isMember: (id) => pool.store.isMember(id), log: logGit });
    const host = (node.host = createNodeHost({ cfg, db, runner, metrics, claudeCodeVersion: claudeCodeVersion(), pool }));
    // Its host objects activated first, so a dashboard that fails to start never abandons one half-activated.
    await host.ready();
    node.stopTunnels = acceptDashboardStreams(pool.net, host, (id) => pool.store.isMember(id));
    node.dashboard = await startDashboard(cfg, host, pool);
  } catch (err) {
    await shutdown(node);
    throw err;
  }
  console.log(`node ${node.pool!.identity.id}`);
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

/**
 * Version, Claude Code version, data dir, task root, token, task count, node id and pool; reads the database
 * read-only and creates neither it nor the node's key.
 */
async function status(): Promise<number> {
  const cfg = loadConfig();
  const root = await checkTaskRoot(cfg);
  const token = await tokenStatus(cfg);
  console.log(`meddle ${VERSION}`);
  console.log(`claude code ${claudeCodeVersion()}`);
  console.log(`data dir ${cfg.dataDir}`);
  console.log(root.ok ? `task root ${cfg.taskRoot} ok` : root.reason);
  console.log(`token ${token.present ? `present expires ${token.expiresAt}` : "absent"}`);
  console.log(`tasks ${readDb(cfg, (db) => listLiveTasks(db).length) ?? 0}`);
  console.log(`node ${existsSync(paths(cfg).irohKey) ? (await loadOrCreateIdentity(cfg)).id : "(none yet)"}`);
  console.log(readDb(cfg, poolLine) ?? "pool (none yet)");
  return 0;
}

/** `read` over the database opened read-only, or null when there is none yet. */
function readDb<T>(cfg: NodeConfig, read: (db: Database) => T): T | null {
  const file = paths(cfg).db;
  if (!existsSync(file)) return null;
  const db = new Database(file, { readonly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

/** `pool <poolId> members <n>`, or null before this node first served (no pool table, or no pool in it). */
function poolLine(db: Database): string | null {
  if (db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pool'").get() === null) return null;
  if (db.query("SELECT 1 FROM pool").get() === null) return null;
  const store = new PoolStore(db);
  return `pool ${store.pool().poolId} members ${store.members().length}`;
}

/**
 * Writes the token file here, set by this node, then tells the running node (if any) so it tells the pool. The value
 * never goes over the socket: other nodes pull it from this one.
 */
async function tokenSet(file: string | undefined): Promise<number> {
  const input = file !== undefined ? await Bun.file(file).text() : await Bun.stdin.text();
  const cfg = loadConfig();
  await ensureDataDirs(cfg);
  const identity = await loadOrCreateIdentity(cfg);
  await setToken(cfg, input, { setBy: identity.id });
  try {
    await withPool(async (pool) => {
      await pool.tokenChanged({});
      return 0;
    });
  } catch (err) {
    if (!(err instanceof NoNode)) throw err;
  }
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

/** The node's PoolObject as dashboards and the CLI see it (the `default` variant). */
async function poolView(client: Host) {
  const pool = await client.get(PoolObject, {});
  if (pool.variant !== "default") throw new Error("expected the default pool view");
  return pool;
}

/** Runs `use` against the running node's PoolObject. */
function withPool(use: (pool: Awaited<ReturnType<typeof poolView>>) => Promise<number>): Promise<number> {
  return withNode(async (client) => {
    const pool = await poolView(client);
    try {
      return await use(pool);
    } finally {
      pool.release();
    }
  });
}

/** Prints a ticket another node joins this pool with. */
function poolInvite(): Promise<number> {
  return withPool(async (pool) => {
    console.log((await pool.invite({})).ticket);
    return 0;
  });
}

/** Joins the pool a ticket from one of its members names. */
function poolJoin(ticket: string): Promise<number> {
  return withPool(async (pool) => {
    const joined = await pool.join({ ticket });
    console.log(`joined pool ${shortId(joined.poolId)} with ${joined.members} nodes`);
    return 0;
  });
}

/** One line per node of the roster. */
function poolList(): Promise<number> {
  return withPool(async (pool) => {
    const self = pool.self.value;
    for (const n of pool.nodes.value) {
      const state = n.status === "removed" ? "removed" : n.online ? "online" : "offline";
      const line = `${shortId(n.nodeId)} ${n.hostname} ${state} meddle ${n.version} claude ${n.claudeCodeVersion} tasks ${n.taskCount}`;
      console.log(n.nodeId === self ? `${line} (this node)` : line);
    }
    return 0;
  });
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

/** How many of the newest events `task prompt` reads once the task is idle again; the turn's end is among them. */
const SETTLE_EVENTS = 20;

/**
 * Submits a turn and prints each new event's `type[/subtype]` to stderr until a `result` arrives. A `result` other
 * than a success, a `turn_failed` event, or the task going idle again with no `result` (a turn that failed before it
 * logged anything) fails it.
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
        if (type === "result") {
          const error = resultError(message as { subtype?: unknown; is_error?: unknown });
          return error === null ? finished.resolve() : finished.reject(new Error(`the turn ended with ${error}`));
        }
        if (type === "meddle" && subtype === "turn_failed") {
          return finished.reject(new Error(`the turn failed: ${String((message as { error?: unknown }).error)}`));
        }
      }
    };
    /** Idle again: the database has every event the turn logged, so a `result` missing from its newest means failure. */
    const settle = async () => {
      follow(await session.loadEarlier({ beforeSeq: Number.MAX_SAFE_INTEGER, limit: SETTLE_EVENTS }));
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

/** Runs the task's turn again after repeated crashes parked it; fails when none is parked. */
function taskRetry(id: string): Promise<number> {
  return withNode(async (client) => {
    const task = await client.get(TaskObject, { id });
    await task.retry({});
    console.log("retrying");
    return 0;
  });
}

/** This checkout's root; inside a compiled binary it names a directory with no `src/cli.ts`. */
const CHECKOUT = resolve(import.meta.dir, "..");

/** The user unit from `install/meddle.service`: the running bun serving from this checkout. */
async function renderUnit(): Promise<string> {
  const template = await Bun.file(join(CHECKOUT, "install/meddle.service")).text();
  return template.replaceAll("{{bun}}", process.execPath).replaceAll("{{checkout}}", CHECKOUT);
}

/** The command that creates the task root, owned by the current user and their primary group. */
function taskRootCommand(): string {
  const { username, gid } = userInfo();
  const id = Bun.spawnSync(["id", "-gn"], { stdout: "pipe", stderr: "ignore" });
  const group = id.success ? id.stdout.toString().trim() || String(gid) : String(gid);
  return `sudo install -d -o ${username} -g ${group} -m 755 /opt/meddle/tasks`;
}

/** Runs a command, failing with its name when it exits non-zero. */
function runOrFail(cmd: string[]): void {
  const proc = Bun.spawnSync(cmd, { stdout: "inherit", stderr: "inherit" });
  if (!proc.success) throw new Error(`${cmd.join(" ")} failed`);
}

/**
 * Writes `~/.config/systemd/user/meddle.service`, reloads systemd and enables the unit now, then prints the one
 * privileged command to run by hand. `dryRun` prints the unit and that command instead, writing and running nothing.
 */
async function serviceInstall(dryRun: boolean): Promise<number> {
  if (!existsSync(join(CHECKOUT, "src/cli.ts"))) {
    console.error("meddle: service install must run from the checkout (bun run src/cli.ts service install)");
    return 1;
  }
  const unit = await renderUnit();
  if (dryRun) {
    process.stdout.write(unit);
    console.log("# then run once:");
    console.log(taskRootCommand());
    return 0;
  }
  const dir = join(homedir(), ".config/systemd/user");
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, "meddle.service"), unit);
  runOrFail(["systemctl", "--user", "daemon-reload"]);
  runOrFail(["systemctl", "--user", "enable", "--now", "meddle.service"]);
  console.log(`installed ${join(dir, "meddle.service")}; run once:`);
  console.log(taskRootCommand());
  return 0;
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

/**
 * git's remote helper for a `meddle://` remote, run by the `git-remote-meddle` wrapper: the protocol on stdio, piped
 * through the git socket `MEDDLE_GIT_SOCKET` (or this node's) names.
 */
async function gitRemote(url: string): Promise<number> {
  const writable = (sink: ReturnType<typeof Bun.stdout.writer>) => new WritableStream<Uint8Array>({
    async write(chunk) {
      sink.write(chunk);
      await sink.flush();
    },
    async close() {
      await sink.flush();
    },
  });
  return runRemoteHelper({
    url,
    socketPath: paths(loadConfig()).gitSocket,
    stdin: Bun.stdin.stream(),
    stdout: writable(Bun.stdout.writer()),
    stderr: writable(Bun.stderr.writer()),
  });
}

/** The subcommand `args` names, or null for a usage error. */
function dispatch(args: string[]): (() => Promise<number>) | null {
  const [command, sub, ...rest] = args;
  if (args.length === 1 && command === "--version") return async () => (console.log(`meddle ${VERSION}`), 0);
  if (args.length === 1 && command === "serve") return serve;
  if (args.length === 1 && command === "status") return status;
  if (args.length === 1 && command === "invite") return poolInvite;
  if (args.length === 2 && command === "join") return () => poolJoin(sub!);
  if (args.length === 1 && command === "pool") return poolList;
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
  if (command === "task" && sub === "retry" && rest.length === 1) return () => taskRetry(rest[0]!);
  // git runs a helper as `git-remote-<scheme> <remote> [<url>]`; without a url, the remote is the url.
  if (command === "git-remote" && sub !== undefined && rest.length <= 1) return () => gitRemote(rest[0] ?? sub);
  if (command === "service" && sub === "install" && rest.length === 0) return () => serviceInstall(false);
  if (command === "service" && sub === "install" && rest.length === 1 && rest[0] === "--dry-run") return () => serviceInstall(true);
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
