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
import { JANITOR_INTERVAL_MS, runJanitor } from "./tasks/archive";
import { acceptBlobStreams } from "./tasks/blob";
import { GitSocket } from "./git/socket";
import { findTaskPids, MetricsSampler } from "./metrics";
import { loadOrCreateIdentity, shortId } from "./pool/identity";
import { resolveNodeId } from "./pool/ids";
import { dedupe } from "./pool/report";
import { startPool, type PoolRuntime } from "./pool/runtime";
import { PoolStore } from "./pool/store";
import { ensurePlugins, seedProfile } from "./profile";
import { resultError, tokenFaultNotice, tokenFaultOf } from "./engine/session";
import { PoolObject } from "./state/contracts";
import { createNodeHost, NodeObject, ProjectObject, SessionObject, TaskObject } from "./state/host";
import { openDb } from "./store/db";
import { listProjects } from "./projects/project";
import { countRunningTasks, listLiveTasks } from "./store/records";
import { TaskRunner, type RunnerDeps } from "./tasks/durable";
import { openHarness } from "./tasks/harness";
import {
  addToken, enableToken, listTokens, migrateLegacyToken, pickToken, removeToken, sweepTokenValues, type TokenMeta,
} from "./token";
import { claudeCodeVersion, VERSION } from "./version";

const USAGE = `usage: meddle --version
       meddle serve
       meddle status
       meddle invite
       meddle join <ticket>
       meddle pool
       meddle token add [--file <path>] [--label <l>] | meddle token set [--file <path>] [--label <l>]
       meddle token list | meddle token status | meddle token remove <id|label> | meddle token enable <id|label>
       meddle config set <key> <value> | meddle config unset <key> | meddle config list
       meddle project add <path-or-url> [--name <n>] | meddle project list
       meddle task new --title <t> --project <id>... [--node <id|prefix> | --here]
       meddle task prompt <id> <text> | meddle task retry <id>
       meddle task move <id> <node> [--now]
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
  /** Stops accepting the blob streams of tasks moved here. */
  stopBlobs?: () => void;
  /** The unix socket this node's git remote helper connects to. */
  gitSocket?: GitSocket;
  /** The daily run of the archive janitor. */
  janitor?: ReturnType<typeof setInterval>;
};

/**
 * Closes whatever of the node is open: the dashboard, the tunnels, git (the acceptor, then the socket and its file),
 * the pool, metrics, the harness, the host, then the database.
 */
async function shutdown(node: OpenNode): Promise<void> {
  await node.dashboard?.stop();
  clearInterval(node.janitor);
  node.stopTunnels?.();
  node.stopBlobs?.();
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
    // The single token of an older meddle becomes the first of the list, once.
    await migrateLegacyToken(cfg, db, (await loadOrCreateIdentity(cfg)).id);
    // What a crash left in the tokens directory: a half-written value, the value of a removed token.
    await sweepTokenValues(cfg, db);
    // The pool and git first: the Harness reruns unfinished turns as it opens, and their turn ends push to homes.
    const pool = (node.pool = await startPool(cfg, db, {
      version: VERSION,
      claudeCodeVersion: claudeCodeVersion(),
      hostsTasks: async () => (await checkTaskRoot(cfg)).ok,
      taskCount: () => listLiveTasks(db).length,
      running: () => countRunningTasks(db),
      projects: () => listProjects(db).map((p) => ({ id: p.id, name: p.name, home: p.home })),
    }));
    const gitSocket = (node.gitSocket = new GitSocket(cfg, pool.net));
    await gitSocket.start();
    const logGit = dedupe((line) => console.error(line));
    node.stopGit = acceptGitStreams(pool.net, { db, cfg, selfId: pool.identity.id, isMember: (id) => pool.store.isMember(id), log: logGit });
    const harness = (node.harness = await openHarness(cfg, createRegistry()));
    const runner = new TaskRunner(cfg, db, harness.harness, { ...runnerDeps(), pool });
    node.stopBlobs = acceptBlobStreams(pool.net, runner);
    // Archives of tasks that moved away are kept for seven days (decision 18).
    const janitor = () => runJanitor(cfg).catch((err: unknown) => console.error("meddle: archive janitor:", err));
    void janitor();
    node.janitor = setInterval(janitor, JANITOR_INTERVAL_MS);
    node.janitor.unref();
    const metrics = (node.metrics = new MetricsSampler({
      taskPids: () => findTaskPids(cfg.taskRoot),
      intervalMs: 5000,
      dataDir: cfg.dataDir,
    }));
    metrics.start();
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
  for (const name of ["MEDDLE_FIXTURE", "MEDDLE_FIXTURE_STALL", "MEDDLE_FIXTURE_MEMORY", "MEDDLE_FIXTURE_BY_TOKEN"]) {
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
  const token = await readDb(cfg, async (db) => {
    const active = await activeToken(cfg, db);
    return active === null ? null : listTokens(db).find((t) => t.id === active)?.expiresAt ?? null;
  });
  console.log(`meddle ${VERSION}`);
  console.log(`claude code ${claudeCodeVersion()}`);
  console.log(`data dir ${cfg.dataDir}`);
  console.log(root.ok ? `task root ${cfg.taskRoot} ok` : root.reason);
  console.log(`token ${token === null ? "absent" : `present expires ${token}`}`);
  console.log(`tasks ${(await readDb(cfg, (db) => listLiveTasks(db).length)) ?? 0}`);
  console.log(`node ${existsSync(paths(cfg).irohKey) ? (await loadOrCreateIdentity(cfg)).id : "(none yet)"}`);
  console.log((await readDb(cfg, poolLine)) ?? "pool (none yet)");
  return 0;
}

/** `read` over the database opened read-only, or null when there is none yet. */
async function readDb<T>(cfg: NodeConfig, read: (db: Database) => T | Promise<T>): Promise<T | null> {
  const file = paths(cfg).db;
  if (!existsSync(file)) return null;
  const db = new Database(file, { readonly: true });
  try {
    return await read(db);
  } finally {
    db.close();
  }
}

/** The database has a `tokens` table: a node of this meddle has opened it. */
function hasTokens(db: Database): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tokens'").get() !== null;
}

/** The id of the token a turn starting now would use, or null. */
async function activeToken(cfg: NodeConfig, db: Database): Promise<string | null> {
  return hasTokens(db) ? (await pickToken(cfg, db))?.id ?? null : null;
}

/** `pool <poolId> members <n>`, or null before this node first served (no pool table, or no pool in it). */
function poolLine(db: Database): string | null {
  if (db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pool'").get() === null) return null;
  if (db.query("SELECT 1 FROM pool").get() === null) return null;
  const store = new PoolStore(db);
  return `pool ${store.pool().poolId} members ${store.members().length}`;
}

/** Tells the running node, if any, that the tokens changed, so that it tells the pool. */
async function tokensChanged(): Promise<void> {
  try {
    await withPool(async (pool) => {
      await pool.tokenChanged({});
      return 0;
    });
  } catch (err) {
    if (!(err instanceof NoNode)) throw err;
  }
}

/** Runs `use` over this node's database, opened (and created) for writing, then closes it. */
async function withDb<T>(cfg: NodeConfig, use: (db: Database) => Promise<T> | T): Promise<T> {
  const db = openDb(paths(cfg).db);
  try {
    return await use(db);
  } finally {
    db.close();
  }
}

/**
 * Adds a token from `file` (stdin otherwise) here, set by this node: its value file, then its row, written directly,
 * then tells the running node (if any) so it tells the pool. The value never goes over the socket: other nodes pull it
 * from this one.
 */
async function tokenAdd(file: string | undefined, label: string | undefined): Promise<number> {
  const input = file !== undefined ? await Bun.file(file).text() : await Bun.stdin.text();
  const cfg = loadConfig();
  await ensureDataDirs(cfg);
  const identity = await loadOrCreateIdentity(cfg);
  const added = await withDb(cfg, (db) => addToken(cfg, db, input, { setBy: identity.id, ...(label === undefined ? {} : { label }) }));
  await tokensChanged();
  console.log(`token ${added.id} (${added.label})`);
  return 0;
}

/** Removes a token (its full id or its label) here, its value file last, and tells the running node. */
async function tokenRemove(idOrLabel: string): Promise<number> {
  const cfg = loadConfig();
  if (!existsSync(paths(cfg).db)) throw new Error(`no such token: ${idOrLabel}`);
  const removed = await withDb(cfg, (db) => removeToken(cfg, db, idOrLabel));
  await tokensChanged();
  console.log(`removed ${removed.id} (${removed.label})`);
  return 0;
}

/** Makes a token (its full id or its label) usable again here, and tells the running node. */
async function tokenEnable(idOrLabel: string): Promise<number> {
  const cfg = loadConfig();
  if (!existsSync(paths(cfg).db)) throw new Error(`no such token: ${idOrLabel}`);
  const enabled = await withDb(cfg, (db) => enableToken(db, idOrLabel));
  await tokensChanged();
  console.log(`enabled ${enabled.id} (${enabled.label})`);
  return 0;
}

/** `ok`, `exhausted until <time> (<detail>)`, `disabled (<detail>)`. */
function statusText(t: TokenMeta): string {
  return `${t.status}${t.until === null ? "" : ` until ${t.until}`}${t.detail === null ? "" : ` (${t.detail})`}`;
}

/**
 * One line per token in order (id, label, status, expiry), then `active: <id|none>`: the database read read-only, so
 * it works without a node and creates nothing.
 */
async function tokenList(): Promise<number> {
  const cfg = loadConfig();
  const lines = await readDb(cfg, async (db) => {
    if (!hasTokens(db)) return ["active: none"];
    const rows = listTokens(db).map((t) => `${t.id}  ${t.label}  ${statusText(t)}  expires ${t.expiresAt}`);
    return [...rows, `active: ${(await activeToken(cfg, db)) ?? "none"}`];
  });
  for (const line of lines ?? ["active: none"]) console.log(line);
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

/** Sets a pool setting on the running node, which tells the pool. */
function configSet(key: string, value: string): Promise<number> {
  return withPool(async (pool) => {
    await pool.setSetting({ key, value });
    return 0;
  });
}

/** Unsets a pool setting on the running node, which tells the pool. */
function configUnset(key: string): Promise<number> {
  return withPool(async (pool) => {
    await pool.unsetSetting({ key });
    return 0;
  });
}

/** One `key = value` line per pool setting, by key. */
function configList(): Promise<number> {
  return withPool(async (pool) => {
    const settings = [...pool.settings.value].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    for (const { key, value } of settings) console.log(`${key} = ${value}`);
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
      console.log(`${project.id.value}  ${project.name.value}  ${project.replica.value}  home ${shortId(project.home.value)}`);
      project.release();
    }
    return 0;
  });
}

/**
 * Creates a task on the node `where` names: `auto` (placement picks it), `here` (this node), or a node's id or a
 * unique prefix of one in the pool's roster. Prints `task <id> on <node>`.
 */
function taskNew(title: string, projectIds: string[], where: { node: string } | "here" | "auto"): Promise<number> {
  return withNode(async (client) => {
    let node: string | null = where === "here" ? "here" : null;
    if (typeof where === "object") {
      const pool = await poolView(client);
      try {
        node = resolveNodeId(pool.nodes.value.map((n) => n.nodeId), where.node);
      } finally {
        pool.release();
      }
    }
    const ref = await client.get(NodeObject, {});
    try {
      const { manifest, nodeId } = await ref.createTask({ title, projectIds, node });
      console.log(`task ${manifest.id} on ${shortId(nodeId)}`);
    } finally {
      ref.release();
    }
    return 0;
  });
}

type WindowEvent = { seq: number; message: unknown };

/** How many of the newest events `task prompt` reads once the task is idle again; the turn's end is among them. */
const SETTLE_EVENTS = 20;

/** What `task prompt` prints for a text queued for a task on its way to another node. */
const QUEUED_FOR_MOVE = "queued; it runs once the task has arrived";

/**
 * Submits a turn and prints each new event's `type[/subtype]` to stderr until a `result` arrives. A `result` other
 * than a success, a `turn_failed` event, or the task going idle again with no `result` (a turn that failed before it
 * logged anything) fails it. An error `result` of an attempt whose messages reported a token fault is provisional: a
 * `token_fault` that reruns the turn drops it and the rerun is followed; one that does not fails it with the token's
 * notice; the task going idle, or a meddle event other than a `token_fault`, fails it with the result's error. A text
 * the node queued for a task it is moving away (or one that has moved before a `result` came) runs on the other node:
 * that is printed (`QUEUED_FOR_MOVE`) and the command succeeds.
 */
function taskPrompt(id: string, text: string): Promise<number> {
  return withNode(async (client, socket) => {
    const task = await client.get(TaskObject, { id });
    const session = await client.get(SessionObject, { taskId: id });
    let printed = session.window.value.at(-1)?.seq ?? 0;
    const finished = Promise.withResolvers<"done" | "queued">();
    finished.promise.catch(() => {}); // a failed prompt leaves it unawaited when the socket then closes
    socket.addEventListener("close", () => finished.reject(new Error("the node closed the connection")));
    /** This attempt's messages reported a token fault: its error `result` waits for the node's `token_fault`. */
    let faulted = false;
    /** The failure an error `result` stands for until a token rerun replaces it. */
    let provisional: Error | null = null;
    const follow = (events: readonly WindowEvent[]) => {
      for (const { seq, message } of events) {
        if (seq <= printed) continue;
        printed = seq;
        const { type, subtype } = message as { type?: string; subtype?: string };
        console.error(subtype === undefined ? `${type}` : `${type}/${subtype}`);
        if (type === "meddle" && subtype === "token_fault" && provisional !== null) {
          const fault = message as { rerun?: unknown };
          if (fault.rerun !== true) return finished.reject(new Error(`the turn ended: ${tokenFaultNotice(message as Record<string, unknown>)}`));
          provisional = null;
          faulted = false;
          continue;
        }
        // The SDK's own messages after the result (the child's last words) do not decide; meddle's next one does.
        if (provisional !== null && type === "meddle") return finished.reject(provisional);
        if (tokenFaultOf(message as Parameters<typeof tokenFaultOf>[0]) !== null) faulted = true;
        if (type === "result") {
          const error = resultError(message as { subtype?: unknown; is_error?: unknown });
          if (error === null) return finished.resolve("done");
          const failure = new Error(`the turn ended with ${error}`);
          if (!faulted) return finished.reject(failure);
          provisional = failure;
          continue;
        }
        if (type === "meddle" && subtype === "turn_failed") {
          return finished.reject(new Error(`the turn failed: ${String((message as { error?: unknown }).error)}`));
        }
      }
    };
    /** Idle again: the database has every event the turn logged, so a `result` missing from its newest means failure. */
    const settle = async () => {
      follow(await session.loadEarlier({ beforeSeq: Number.MAX_SAFE_INTEGER, limit: SETTLE_EVENTS }));
      finished.reject(provisional ?? new Error("the turn failed"));
    };
    let busy = false;
    const unsubscribe = [
      session.window.subscribe(follow),
      task.state.subscribe((state) => {
        // Gone before a `result`: the text went with the task.
        if (state === "moved") finished.resolve("queued");
        else if (state !== "idle") busy = true;
        else if (busy) settle().catch((err: Error) => finished.reject(err));
      }),
    ];
    try {
      await task.prompt({ text });
      const state = task.state.value;
      if (state === "moving" || state === "receiving" || task.move.value !== null) finished.resolve("queued");
      if ((await finished.promise) === "queued") console.log(QUEUED_FOR_MOVE);
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

/**
 * Moves a task to the node `nodeText` names (its id, or a unique prefix of one in the pool's roster); `now` interrupts
 * a running turn. Returns once the move has started: the node runs it.
 */
function taskMove(id: string, nodeText: string, now: boolean): Promise<number> {
  return withNode(async (client) => {
    const pool = await poolView(client);
    let nodeId: string;
    try {
      nodeId = resolveNodeId(pool.nodes.value.map((n) => n.nodeId), nodeText);
    } finally {
      pool.release();
    }
    const task = await client.get(TaskObject, { id });
    await task.moveTo({ nodeId, now });
    console.log(`moving ${id} to ${shortId(nodeId)}`);
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

/** `[--file <path>] [--label <l>]`, in either order, each at most once. */
function tokenAddArgs(args: string[]): { file?: string; label?: string } | null {
  const out: { file?: string; label?: string } = {};
  for (let i = 0; i < args.length; i += 2) {
    const value = args[i + 1];
    if (value === undefined) return null;
    if (args[i] === "--file" && out.file === undefined) out.file = value;
    else if (args[i] === "--label" && out.label === undefined) out.label = value;
    else return null;
  }
  return out;
}

/**
 * `--title <t>`, `--project <id>...` (one or more ids, the flag repeatable) and at most one of `--node <id|prefix>` and
 * `--here` (neither: `auto`).
 */
function taskNewArgs(args: string[]): { title: string; projectIds: string[]; where: { node: string } | "here" | "auto" } | null {
  let title: string | undefined;
  const projectIds: string[] = [];
  let where: { node: string } | "here" | "auto" = "auto";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--title" && i + 1 < args.length) title = args[++i];
    else if (args[i] === "--project") while (i + 1 < args.length && !args[i + 1]!.startsWith("--")) projectIds.push(args[++i]!);
    else if (args[i] === "--node" && i + 1 < args.length && where === "auto") where = { node: args[++i]! };
    else if (args[i] === "--here" && where === "auto") where = "here";
    else return null;
  }
  return title === undefined || projectIds.length === 0 ? null : { title, projectIds, where };
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
  if (command === "token" && (sub === "add" || sub === "set")) {
    const parsed = tokenAddArgs(rest);
    return parsed === null ? null : () => tokenAdd(parsed.file, parsed.label);
  }
  if (command === "token" && (sub === "list" || sub === "status") && rest.length === 0) return tokenList;
  if (command === "token" && sub === "remove" && rest.length === 1) return () => tokenRemove(rest[0]!);
  if (command === "token" && sub === "enable" && rest.length === 1) return () => tokenEnable(rest[0]!);
  if (command === "config" && sub === "set" && rest.length === 2) return () => configSet(rest[0]!, rest[1]!);
  if (command === "config" && sub === "unset" && rest.length === 1) return () => configUnset(rest[0]!);
  if (command === "config" && sub === "list" && rest.length === 0) return configList;
  if (command === "project" && sub === "add" && rest.length === 1) return () => projectAdd(rest[0]!, undefined);
  if (command === "project" && sub === "add" && rest.length === 3 && rest[1] === "--name") return () => projectAdd(rest[0]!, rest[2]);
  if (command === "project" && sub === "list" && rest.length === 0) return projectList;
  if (command === "task" && sub === "new") {
    const parsed = taskNewArgs(rest);
    return parsed === null ? null : () => taskNew(parsed.title, parsed.projectIds, parsed.where);
  }
  if (command === "task" && sub === "prompt" && rest.length >= 2) return () => taskPrompt(rest[0]!, rest.slice(1).join(" "));
  if (command === "task" && sub === "retry" && rest.length === 1) return () => taskRetry(rest[0]!);
  if (command === "task" && sub === "move" && (rest.length === 2 || (rest.length === 3 && rest[2] === "--now"))) {
    return () => taskMove(rest[0]!, rest[1]!, rest.length === 3);
  }
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
