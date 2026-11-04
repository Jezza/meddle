import { existsSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { homedir, hostname, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { createHost, webSocketLink, type Host } from "@earendil-works/chord";
import { createRegistry } from "@earendil-works/pi-durable";
import { checkTaskRoot, ensureDataDirs, loadConfig, paths, type NodeConfig } from "./config";
import { startDashboard, type Dashboard } from "./dashboard/server";
import { acceptDashboardStreams } from "./dashboard/tunnel";
import { gitRemote } from "./git/remote-main";
import { writeHelperWrapper, writeUpdateHook } from "./git/scripts";
import { acceptGitStreams } from "./git/serve";
import { JANITOR_INTERVAL_MS, runJanitor, sweepArchiveTemps } from "./tasks/archive";
import { acceptBlobStreams } from "./tasks/blob";
import { GitSocket } from "./git/socket";
import { findTaskPids, MetricsSampler } from "./metrics";
import { isNodeId, loadOrCreateIdentity, shortId } from "./pool/identity";
import { resolveId, resolveNodeId, uniquePrefixLengths } from "./pool/ids";
import { DEFAULT_POOL_NAME, generateSecret, poolNameProblem, poolSecretProblem } from "./pool/secret";
import { poolProjects, projectLine, resolveProject } from "./pool/projects";
import { dedupe } from "./pool/report";
import { startPool, type PoolRuntime } from "./pool/runtime";
import { PoolStore } from "./pool/store";
import { ensurePlugins, seedProfile } from "./profile";
import { resultError, tokenFaultNotice, tokenFaultOf } from "./engine/session";
import { PoolObject } from "./state/contracts";
import { createNodeHost, NodeObject, SessionObject, TaskObject } from "./state/host";
import { openDb } from "./store/db";
import { listProjects } from "./projects/project";
import { countRunningTasks, listLiveTasks } from "./store/records";
import { TaskRunner, type RunnerDeps } from "./tasks/durable";
import { openHarness } from "./tasks/harness";
import {
  addToken, enableToken, listTokens, migrateLegacyToken, pickToken, removeToken, sweepTokenValues, type TokenMeta,
} from "./token";
import { ensureClaude } from "./claude-code";
import { embedded } from "./embedded";
import { helpRequest } from "./help";
import { highlightId, palette, table, wantsColour } from "./ansi";
import { claudeCodeVersion, VERSION } from "./version";

const USAGE = `usage: meddle --version
       meddle serve
       meddle status
       meddle pool [-v]
       meddle pool secret [--file <path> | --generate <path>] [--name <name>]
       meddle pool peer <node id> | meddle pool remove <id|prefix> | meddle pool allow <id|prefix>
       meddle token add [--file <path>] [--label <l>] | meddle token set [--file <path>] [--label <l>]
       meddle token list | meddle token status | meddle token remove <id|label> | meddle token enable <id|label>
       meddle config set <key> <value> | meddle config unset <key> | meddle config list
       meddle project add <path-or-url> [--name <n>] | meddle project list
       meddle task new [<prompt>] [--title <t>] [--project <id|name>]... [--node <id|prefix> | --here]
       meddle task list
       meddle task prompt <id> <text> | meddle task retry <id>
       meddle task move <id> <node> [--now] | meddle task move <id> --now | meddle task move <id> --cancel
       meddle task archive <id> | meddle task delete <id>
       meddle task restore <id> [--node <id|prefix> | --here]
       meddle service install [--dry-run]
       meddle git-remote <name> <url>   (git's remote helper for meddle:// remotes)

meddle help [<command>] says what each command does.`;

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

  // Before the pool starts: a peer that connects meanwhile finds everything this node serves it ready, rather than a
  // node still downloading Claude Code (in the single binary, on its first start).
  const claude = await runnerDeps(cfg);

  const node: OpenNode = {};
  try {
    const db = (node.db = openDb(paths(cfg).db));
    // The single token of an older meddle becomes the first of the list, once.
    await migrateLegacyToken(cfg, db, (await loadOrCreateIdentity(cfg)).id);
    // What a crash left in the tokens directory: a half-written value, the value of a removed token.
    await sweepTokenValues(cfg, db);
    // And in the archives directory: a half-written archive.
    await sweepArchiveTemps(cfg);
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
    const runner = new TaskRunner(cfg, db, harness.harness, { ...claude, pool });
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

/**
 * How turns start Claude Code: (for tests) `MEDDLE_CLAUDE_PATH` with the fixture env passed on; in the single binary,
 * the Claude Code it pins, installed in the data directory (from the binary, or downloaded) when it is not there yet;
 * from a checkout, the Agent SDK's own.
 */
async function runnerDeps(cfg: NodeConfig, env = process.env): Promise<RunnerDeps> {
  const deps: RunnerDeps = {};
  const packed = embedded();
  if (env.MEDDLE_CLAUDE_PATH) {
    deps.claudePath = env.MEDDLE_CLAUDE_PATH;
    deps.claudeRuntime = env.MEDDLE_CLAUDE_RUNTIME === "node" ? "node" : "bun";
  } else if (packed !== null) {
    deps.claudePath = await ensureClaude(packed.claudeCode, cfg.dataDir, {
      registry: cfg.npmRegistry,
      embedded: packed.claude,
      log: (line) => console.error(line),
    });
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

/**
 * `pool <poolId> (<name>) members <n>`, `pool (no secret set)` before `meddle pool secret`, or null before this node
 * first served (no pool table, or no pool in it).
 */
function poolLine(db: Database): string | null {
  if (db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pool'").get() === null) return null;
  if (db.query("SELECT 1 FROM pool").get() === null) return null;
  const store = new PoolStore(db);
  const pool = store.pool();
  return pool.poolSecret === "" ? "pool (no secret set)" : `pool ${pool.poolId} (${pool.poolName}) members ${store.members().length}`;
}

/** Tells the running node, if any, that the pool row or the roster changed under it. */
async function poolChanged(): Promise<void> {
  try {
    await withPool(async (pool) => {
      await pool.poolChanged({});
      return 0;
    });
  } catch (err) {
    if (!(err instanceof NoNode)) throw err;
  }
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

/**
 * A client host linked to the running node at `ws://127.0.0.1:<port><path>`, and the socket under it: `/ws` for the
 * node's own objects, `/ws/node/<node id>` for another member's, tunnelled over the pool.
 */
async function connect(path = "/ws"): Promise<{ client: Host; socket: WebSocket }> {
  const socket = new WebSocket(`ws://127.0.0.1:${loadConfig().port}${path}`);
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

/**
 * Sets the pool's secret from `file` (stdin otherwise; never an argument), or a generated one written to `generate`
 * (a new file, mode 600, to copy to the other nodes), and its name (default `default`), written to the node's
 * database directly, then tells the running node (if any): it re-keys and starts its roster over with itself alone.
 * Every node given the same name and secret is in the same pool. The secret is never printed.
 */
async function poolSecret(file: string | undefined, generate: string | undefined, name: string | undefined): Promise<number> {
  let secret: string;
  if (generate !== undefined) {
    secret = generateSecret();
    await writeFile(generate, `${secret}\n`, { flag: "wx", mode: 0o600 });
  } else {
    secret = (file !== undefined ? await Bun.file(file).text() : await Bun.stdin.text()).trim();
  }
  const poolName = name ?? DEFAULT_POOL_NAME;
  const problem = poolNameProblem(poolName) ?? poolSecretProblem(secret);
  if (problem !== null) throw new Error(problem);
  const cfg = loadConfig();
  await ensureDataDirs(cfg);
  const identity = await loadOrCreateIdentity(cfg);
  const pool = await withDb(cfg, (db) => new PoolStore(db).setSecret({ nodeId: identity.id, hostname: hostname() }, poolName, secret));
  await poolChanged();
  console.log(`pool ${shortId(pool.poolId)} (${pool.poolName})`);
  if (generate !== undefined) console.log(`secret written to ${generate}; copy it to the other nodes (meddle pool secret --file <path>)`);
  return 0;
}

/**
 * Records a node (its full id) as a member here and tells the running node, which dials it (iroh resolves the id):
 * the way into a pool that uses no lighthouse. The node still has to prove the secret.
 */
async function poolPeer(nodeId: string): Promise<number> {
  if (!isNodeId(nodeId)) throw new Error(`not a node id: ${nodeId}`);
  const cfg = loadConfig();
  await ensureDataDirs(cfg);
  const identity = await loadOrCreateIdentity(cfg);
  if (nodeId === identity.id) throw new Error("that is this node");
  const status = await withDb(cfg, (db) => {
    const store = new PoolStore(db);
    store.ensurePool({ nodeId: identity.id, hostname: hostname() });
    return store.ensureMember(nodeId, identity.id);
  });
  if (status === "removed") throw new Error(`${shortId(nodeId)} was removed from the pool; use pool allow`);
  await poolChanged();
  console.log(`peer ${shortId(nodeId)}`);
  return 0;
}

/** Removes the node `text` names (its id or a unique prefix) from the pool. */
function poolRemove(text: string): Promise<number> {
  return withPool(async (pool) => {
    const nodeId = resolveNodeId(pool.nodes.value.map((n) => n.nodeId), text);
    await pool.remove({ nodeId });
    console.log(`removed ${shortId(nodeId)}`);
    return 0;
  });
}

/** Makes the removed node `text` names (its id or a unique prefix) a member again. */
function poolAllow(text: string): Promise<number> {
  return withPool(async (pool) => {
    const nodeId = resolveNodeId(pool.nodes.value.map((n) => n.nodeId), text);
    await pool.allow({ nodeId });
    console.log(`allowed ${shortId(nodeId)}`);
    return 0;
  });
}

/** A node of the roster as the CLI reads it from the PoolObject. */
type RosterNode = Awaited<ReturnType<typeof poolView>>["nodes"]["value"][number];

/** `<short id> (<hostname>)`, or the short id alone while its hostname is not known (it is the short id then). */
function nodeLabel(nodes: readonly { nodeId: string; hostname: string }[], id: string): string {
  const short = shortId(id);
  const hostname = nodes.find((n) => n.nodeId === id)?.hostname ?? "";
  return hostname === "" || hostname === short ? short : `${short} (${hostname})`;
}

/**
 * The roster as a table, this node first and marked `@`: each node's short id (its unique prefix highlighted), host,
 * state, meddle and Claude Code versions (another node's in yellow where they differ from this one's) and task count.
 * `verbose` adds the connection held with each: who dialed it, and the node's session on it (this node's own).
 */
function poolList(verbose: boolean): Promise<number> {
  return withPool(async (pool) => {
    const colour = wantsColour(process.stdout);
    const c = palette(colour);
    const self = pool.self.value;
    const nodes = [...pool.nodes.value].sort((x, y) => Number(y.nodeId === self) - Number(x.nodeId === self));
    const prefixes = uniquePrefixLengths(nodes.map((n) => n.nodeId));
    const id = (nodeId: string) => highlightId(shortId(nodeId), prefixes.get(nodeId) ?? 1, colour);
    const mine = nodes.find((n) => n.nodeId === self);
    const state = (n: RosterNode) =>
      n.status === "removed" ? c.red("removed") : n.online ? c.green("online") : n.gone ? c.red("gone") : c.yellow("offline");
    const version = (value: string, ours: string | undefined) =>
      value === "" ? "-" : ours !== undefined && ours !== "" && value !== ours ? c.yellow(value) : value;
    const header = ["", "NODE", "HOST", "STATE", "MEDDLE", "CLAUDE", "TASKS", ...(verbose ? ["DIALER", "SESSION"] : [])];
    const rows = nodes.map((n) => {
      const isSelf = n.nodeId === self;
      const host = n.hostname === shortId(n.nodeId) ? "-" : n.hostname;
      const row = [
        isSelf ? c.self("@") : "",
        id(n.nodeId),
        isSelf ? c.bold(host) : host,
        state(n),
        version(n.version, isSelf ? undefined : mine?.version),
        version(n.claudeCodeVersion, isSelf ? undefined : mine?.claudeCodeVersion),
        String(n.taskCount),
      ];
      if (verbose) {
        row.push(n.link ? id(n.link.dialer) : "-", (isSelf ? pool.session?.value : n.link?.session) ?? "-");
      }
      return row;
    });
    for (const line of table(header, rows, colour)) console.log(line);
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

/** One line per project of the pool, as the roster's summaries list them (`projectLine`). */
function projectList(): Promise<number> {
  return withPool(async (pool) => {
    const colour = wantsColour(process.stdout);
    const projects = poolProjects(pool.nodes.value);
    const projectPrefixes = uniquePrefixLengths(projects.map((p) => p.id));
    const nodePrefixes = uniquePrefixLengths(pool.nodes.value.map((n) => n.nodeId));
    const paint = {
      project: (id: string) => highlightId(id, projectPrefixes.get(id) ?? 1, colour),
      node: (id: string) => highlightId(shortId(id), nodePrefixes.get(id) ?? 1, colour),
    };
    for (const p of projects) console.log(projectLine(p, paint));
    return 0;
  });
}

/** Where a new task goes: `auto` (placement picks it), `here` (this node), or a node's id or unique prefix. */
type Where = { node: string } | "here" | "auto";

/**
 * Creates a task of the projects `projects` names (each an id or a name one project of the pool has, see
 * `resolveProject`; none for a task without a project) on the node `where` names, with `prompt` as its first turn when
 * given. Prints `task <id> on <node>`.
 */
function createTask(title: string | undefined, projects: string[], where: Where, prompt: string | null): Promise<number> {
  return withNode(async (client) => {
    let node: string | null = where === "here" ? "here" : null;
    let projectIds: string[] = [];
    if (typeof where === "object" || projects.length > 0) {
      const pool = await poolView(client);
      try {
        const known = poolProjects(pool.nodes.value);
        projectIds = projects.map((x) => resolveProject(known, x));
        if (typeof where === "object") node = resolveNodeId(pool.nodes.value.map((n) => n.nodeId), where.node);
      } finally {
        pool.release();
      }
    }
    const ref = await client.get(NodeObject, {});
    try {
      const { manifest, nodeId } = await ref.createTask({ ...(title === undefined ? {} : { title }), projectIds, node, prompt });
      const pool = await poolView(client);
      try {
        console.log(`task ${manifest.id} on ${nodeLabel(pool.nodes.value, nodeId)}`);
      } finally {
        pool.release();
      }
    } finally {
      ref.release();
    }
    return 0;
  });
}

/** How long `task list` waits for an online member to list its tasks before it reports the member and goes on. */
const REMOTE_TASKS_MS = 10_000;

/** One task as `task list` prints it. */
type TaskLine = { id: string; state: string; title: string; projects: string[]; createdAt: string };

/** The tasks on the node `host` serves: those that live there, then those archived there, each oldest first. */
async function tasksOf(host: Host): Promise<TaskLine[]> {
  const node = await host.get(NodeObject, {});
  let ids: string[];
  try {
    ids = [...node.taskIds.value, ...node.archivedIds.value];
  } finally {
    node.release();
  }
  const lines: TaskLine[] = [];
  for (const id of ids) {
    const task = await host.get(TaskObject, { id });
    try {
      const m = task.manifest.value;
      lines.push({ id, state: task.state.value, title: m.title, projects: m.projects.map((p) => p.name), createdAt: m.createdAt });
    } finally {
      task.release();
    }
  }
  const archived = (t: TaskLine) => (t.state === "archived" ? 1 : 0);
  return lines.sort((a, b) => archived(a) - archived(b) || a.createdAt.localeCompare(b.createdAt));
}

/** Every task of the pool as the CLI finds it, and where. */
type PoolTasks = {
  self: string;
  /** The whole roster (removed nodes too, as node ids resolve against it). */
  nodes: RosterNode[];
  /** The tasks that live or are archived on each member read, node by node, this node first. */
  tasks: (TaskLine & { nodeId: string })[];
  /** This node's task rows of every state, by id: a task that moved away keeps one here (`task delete` takes it). */
  localRows: Map<string, string>;
  /** Why some members' tasks are missing: one line each (offline, gone, not answering). */
  unread: string[];
};

/**
 * Reads every task of the pool: this node's over `client`, each online member's over the node's tunnel (as the
 * dashboard does), giving up on one that does not answer within `REMOTE_TASKS_MS`. `localOnly` reads this node's
 * alone (the roster still whole).
 */
async function collectTasks(client: Host, localOnly = false): Promise<PoolTasks> {
  const pool = await poolView(client);
  const self = pool.self.value;
  const nodes = [...pool.nodes.value];
  pool.release();
  const cfg = loadConfig();
  const rows = await readDb(cfg, (db) => db.query<{ id: string; state: string }, []>("SELECT id, state FROM tasks").all());
  const out: PoolTasks = { self, nodes, tasks: [], localRows: new Map((rows ?? []).map((r) => [r.id, r.state])), unread: [] };
  const members = nodes.filter((n) => n.status !== "removed").sort((x, y) => Number(y.nodeId === self) - Number(x.nodeId === self));
  for (const n of members) {
    const label = nodeLabel(nodes, n.nodeId);
    if (n.nodeId !== self && !n.online) {
      if (n.taskCount > 0) out.unread.push(`${label} is ${n.gone ? "gone" : "offline"}: its ${n.taskCount} task(s) are not listed`);
      continue;
    }
    let tasks: TaskLine[];
    if (n.nodeId === self) tasks = await tasksOf(client);
    else if (localOnly) continue;
    else {
      const remote = await connect(`/ws/node/${n.nodeId}`);
      try {
        const read = tasksOf(remote.client).catch(() => null);
        const answered = await Promise.race([read, Bun.sleep(REMOTE_TASKS_MS).then(() => "late" as const)]);
        if (answered === null || answered === "late") {
          out.unread.push(`${label} did not answer: its tasks are not listed`);
          continue;
        }
        tasks = answered;
      } finally {
        await remote.client.close();
      }
    }
    for (const t of tasks) out.tasks.push({ ...t, nodeId: n.nodeId });
  }
  return out;
}

/**
 * The task `text` names (its id, or a unique prefix of one among every task of the pool) and the node to act on it
 * at: the node it lives or is archived on; this node when no member has it (only a row this node kept of a task that
 * moved away, which `task delete` takes).
 */
function findTask(pt: PoolTasks, text: string): { id: string; holder: string } {
  let id: string;
  try {
    id = resolveId([...pt.tasks.map((t) => t.id), ...pt.localRows.keys()], text, "task");
  } catch (err) {
    const message = (err as Error).message;
    if (message.startsWith("no such task") && pt.unread.length > 0) throw new Error(`${message} (${pt.unread.join("; ")})`);
    throw err;
  }
  const live = pt.tasks.find((t) => t.id === id);
  return { id, holder: live?.nodeId ?? pt.self };
}

/** Runs `use` against the node holding the task `text` names: this node's host, or the holder's over the tunnel. */
function withTask(
  text: string,
  use: (host: Host, socket: WebSocket, id: string, holder: string, pt: PoolTasks) => Promise<number>,
): Promise<number> {
  return withNode(async (client, socket) => {
    // A task living here named by its whole id needs no other node asked; a prefix is resolved over the whole pool.
    const local = await collectTasks(client, true);
    const pt = local.tasks.some((t) => t.id === text) ? local : await collectTasks(client);
    const { id, holder } = findTask(pt, text);
    if (holder === pt.self) return use(client, socket, id, holder, pt);
    const remote = await connect(`/ws/node/${holder}`);
    try {
      return await use(remote.client, remote.socket, id, holder, pt);
    } finally {
      await remote.client.close();
    }
  });
}

/**
 * Every task of the pool as a table, node by node (this one first), archived ones after the others: id (its unique
 * prefix highlighted), state, node, host, projects (comma-separated, `-` for none) and title. An offline member's
 * tasks cannot be read: a line on stderr says how many it had when last heard of. One that is online but does not
 * answer within `REMOTE_TASKS_MS` is reported on stderr. No tasks, no output.
 */
function taskList(): Promise<number> {
  return withNode(async (client) => {
    const pt = await collectTasks(client);
    for (const line of pt.unread) console.error(line);
    if (pt.tasks.length === 0) return 0;
    const colour = wantsColour(process.stdout);
    const c = palette(colour);
    const taskPrefixes = uniquePrefixLengths([...pt.tasks.map((t) => t.id), ...pt.localRows.keys()]);
    const nodePrefixes = uniquePrefixLengths(pt.nodes.map((n) => n.nodeId));
    const state = (s: string) => (s === "running" ? c.green(s) : s === "waiting" ? c.yellow(s) : s === "moving" || s === "receiving" ? c.cyan(s) : s);
    const rows = pt.tasks.map((t) => {
      const node = pt.nodes.find((n) => n.nodeId === t.nodeId);
      const host = node === undefined || node.hostname === shortId(t.nodeId) ? "-" : node.hostname;
      return [
        highlightId(t.id, taskPrefixes.get(t.id) ?? 1, colour),
        state(t.state),
        highlightId(shortId(t.nodeId), nodePrefixes.get(t.nodeId) ?? 1, colour),
        host,
        t.projects.length === 0 ? "-" : t.projects.join(","),
        t.title,
      ];
    });
    for (const line of table(["ID", "STATE", "NODE", "HOST", "PROJECTS", "TITLE"], rows, colour)) console.log(line);
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
function taskPrompt(text: string, prompt: string): Promise<number> {
  return withTask(text, (host, socket, id) => promptOn(host, socket, id, prompt));
}

/** `taskPrompt` against the node holding the task, over `client` and the socket under it. */
async function promptOn(client: Host, socket: WebSocket, id: string, text: string): Promise<number> {
  {
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
  }
}

/** Runs the task's turn again after repeated crashes parked it; fails when none is parked. */
function taskRetry(text: string): Promise<number> {
  return withTask(text, async (client, _socket, id) => {
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
function taskMove(text: string, nodeText: string, now: boolean): Promise<number> {
  return withTask(text, async (client, _socket, id, _holder, pt) => {
    const nodeId = resolveNodeId(pt.nodes.map((n) => n.nodeId), nodeText);
    const task = await client.get(TaskObject, { id });
    const busy = task.state.value === "running" || task.state.value === "waiting";
    await task.moveTo({ nodeId, now });
    // Without --now, a turn in progress finishes first: say so, rather than leave the move looking stuck.
    const when = busy && !now ? ` once its turn ends (task move ${id} --now to interrupt it, --cancel to stay)` : "";
    console.log(`moving ${id} to ${nodeLabel(pt.nodes, nodeId)}${when}`);
    return 0;
  });
}

/** Cancels the task's move while it waits for the turn or hands the task over: the task stays where it is. */
function taskMoveCancel(text: string): Promise<number> {
  return withTask(text, async (client, _socket, id) => {
    const task = await client.get(TaskObject, { id });
    await task.cancelMove({});
    console.log(`cancelled the move of ${id}`);
    return 0;
  });
}

/** Makes the task's move, waiting for the running turn, interrupt it instead. */
function taskMoveNow(text: string): Promise<number> {
  return withTask(text, async (client, _socket, id) => {
    const task = await client.get(TaskObject, { id });
    await task.moveNow({});
    console.log(`interrupting the turn of ${id} to move it now`);
    return 0;
  });
}

/** Archives an idle task on its node: its folder goes, its log stays (`task restore` brings it back). */
function taskArchive(text: string): Promise<number> {
  return withTask(text, async (client, _socket, id) => {
    const task = await client.get(TaskObject, { id });
    await task.archive({});
    console.log(`archived ${id}`);
    return 0;
  });
}

/**
 * Restores a task archived on this node: here (`here`), on the node named (its id or a unique prefix), or where
 * placement picks (`auto`). Prints `task <id> on <node>` once it is restored here, or `restoring to <node>` once its move
 * to another node has started (the node runs it; the dashboard shows how it goes).
 */
function taskRestore(text: string, where: Where): Promise<number> {
  return withTask(text, async (client, _socket, id, holder, pt) => {
    // `--here` is the node this command talks to; the restore runs on the node holding the archive.
    const node =
      where === "here" ? (holder === pt.self ? "here" : pt.self)
      : where === "auto" ? null
      : resolveNodeId(pt.nodes.map((n) => n.nodeId), where.node);
    const task = await client.get(TaskObject, { id });
    try {
      const { nodeId } = await task.restore({ node });
      console.log(nodeId === holder ? `task ${id} on ${nodeLabel(pt.nodes, nodeId)}` : `restoring to ${nodeLabel(pt.nodes, nodeId)}`);
    } finally {
      task.release();
    }
    return 0;
  });
}

/** `--node <id|prefix>` or `--here`, or neither (`auto`); null for anything else. */
function whereArgs(args: string[]): Where | null {
  if (args.length === 0) return "auto";
  if (args.length === 1 && args[0] === "--here") return "here";
  if (args.length === 2 && args[0] === "--node") return { node: args[1]! };
  return null;
}

/** Deletes an archived or moved task's rows and archive from this node. */
function taskDelete(text: string): Promise<number> {
  return withTask(text, async (client, _socket, id) => {
    const task = await client.get(TaskObject, { id });
    await task.delete({});
    console.log(`deleted ${id}`);
    return 0;
  });
}

/** This checkout's root; inside a compiled binary it names a directory with no `src/cli.ts`. */
const CHECKOUT = resolve(import.meta.dir, "..");

/**
 * The user unit from `install/meddle.service`: in the single binary, that binary serving from the home directory;
 * from a checkout, the running bun serving from it; either way with this shell's PATH, where tasks find jj and git.
 */
async function renderUnit(): Promise<string> {
  const packed = embedded();
  const template = packed?.unit ?? (await Bun.file(join(CHECKOUT, "install/meddle.service")).text());
  const [exec, dir] = packed !== null
    ? [`${process.execPath} serve`, "%h"]
    : [`${process.execPath} run src/cli.ts serve`, CHECKOUT];
  // systemd reads `%` as a specifier and splits on spaces: escape the one, quote the assignment for the other.
  // Less what `bun run` (a checkout's CLI) adds in front: its temp directory and every node_modules/.bin up the tree.
  const dirs = (process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin").split(":").filter((d) => !/\/node_modules\/\.bin$|^\/tmp\/bun-node-/.test(d));
  const path = `PATH=${dirs.join(":").replaceAll("%", "%%")}`;
  const quoted = /[\s"\\]/.test(path) ? `"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"` : path;
  return template.replaceAll("{{exec}}", exec).replaceAll("{{dir}}", dir).replaceAll("{{path}}", quoted);
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
  if (embedded() === null && !existsSync(join(CHECKOUT, "src/cli.ts"))) {
    console.error("meddle: service install must run from the checkout (bun run src/cli.ts service install) or the binary `bun run build` makes");
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
  return pairArgs(args, ["file", "label"]);
}

/** `--<name> <value>` pairs for the given names, in any order, each at most once; null for anything else. */
function pairArgs(args: string[], names: string[]): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const value = args[i + 1];
    const name = names.find((n) => args[i] === `--${n}`);
    if (value === undefined || name === undefined || name in out) return null;
    out[name] = value;
  }
  return out;
}

/**
 * `[<prompt>]` (the words that are not options, joined by spaces; none for a task that waits for one), `--title <t>`,
 * `--project <id|name>` (repeatable, one each) and at most one of `--node <id|prefix>` and `--here` (neither: `auto`).
 */
function taskNewArgs(args: string[]): { prompt: string | null; title: string | undefined; projects: string[]; where: Where } | null {
  let title: string | undefined;
  const projects: string[] = [];
  const words: string[] = [];
  let where: Where = "auto";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--title" && i + 1 < args.length && title === undefined) title = args[++i];
    else if (arg === "--project" && i + 1 < args.length) projects.push(args[++i]!);
    else if (arg === "--node" && i + 1 < args.length && where === "auto") where = { node: args[++i]! };
    else if (arg === "--here" && where === "auto") where = "here";
    else if (arg.startsWith("--")) return null;
    else words.push(arg);
  }
  const prompt = words.join(" ").trim() === "" ? null : words.join(" ");
  if (title !== undefined && title.trim() === "") return null;
  // No title: the node names the task (`taskTitle`).
  return { prompt, title, projects, where };
}

/** The subcommand `args` names, or null for a usage error. */
function dispatch(args: string[]): (() => Promise<number>) | null {
  const [command, sub, ...rest] = args;
  if (args.length === 1 && command === "--version") return async () => (console.log(`meddle ${VERSION}`), 0);
  if (args.length === 1 && command === "serve") return serve;
  if (args.length === 1 && command === "status") return status;
  if (command === "pool" && (args.length === 1 || (args.length === 2 && (sub === "-v" || sub === "--verbose")))) {
    return () => poolList(args.length === 2);
  }
  if (command === "pool" && sub === "secret") {
    const parsed = pairArgs(rest, ["file", "generate", "name"]);
    if (parsed === null || (parsed.file !== undefined && parsed.generate !== undefined)) return null;
    return () => poolSecret(parsed.file, parsed.generate, parsed.name);
  }
  if (command === "pool" && sub === "peer" && rest.length === 1) return () => poolPeer(rest[0]!);
  if (command === "pool" && sub === "remove" && rest.length === 1) return () => poolRemove(rest[0]!);
  if (command === "pool" && sub === "allow" && rest.length === 1) return () => poolAllow(rest[0]!);
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
    return parsed === null ? null : () => createTask(parsed.title, parsed.projects, parsed.where, parsed.prompt);
  }
  if (command === "task" && sub === "list" && rest.length === 0) return taskList;
  if (command === "task" && sub === "prompt" && rest.length >= 2) return () => taskPrompt(rest[0]!, rest.slice(1).join(" "));
  if (command === "task" && sub === "retry" && rest.length === 1) return () => taskRetry(rest[0]!);
  if (command === "task" && sub === "move" && rest.length === 2 && rest[1] === "--cancel") return () => taskMoveCancel(rest[0]!);
  if (command === "task" && sub === "move" && rest.length === 2 && rest[1] === "--now") return () => taskMoveNow(rest[0]!);
  if (command === "task" && sub === "move" && (rest.length === 2 || (rest.length === 3 && rest[2] === "--now")) && !rest[1]!.startsWith("--")) {
    return () => taskMove(rest[0]!, rest[1]!, rest.length === 3);
  }
  if (command === "task" && sub === "archive" && rest.length === 1) return () => taskArchive(rest[0]!);
  if (command === "task" && sub === "restore" && rest.length >= 1 && !rest[0]!.startsWith("--")) {
    const where = whereArgs(rest.slice(1));
    return where === null ? null : () => taskRestore(rest[0]!, where);
  }
  if (command === "task" && sub === "delete" && rest.length === 1) return () => taskDelete(rest[0]!);
  // git runs a helper as `git-remote-<scheme> <remote> [<url>]`; without a url, the remote is the url.
  if (command === "git-remote" && sub !== undefined && rest.length <= 1) return () => gitRemote(rest[0] ?? sub);
  if (command === "service" && sub === "install" && rest.length === 0) return () => serviceInstall(false);
  if (command === "service" && sub === "install" && rest.length === 1 && rest[0] === "--dry-run") return () => serviceInstall(true);
  return null;
}

/**
 * An error as a person reads it: without what chord adds as it carries one over a link (its code, such as
 * `unavailable: `, and `activating <object address>: ` when the object could not be made).
 */
function plainError(message: string): string {
  const CODE = /^(?:aborted|contract_mismatch|forbidden|gone|invalid|not_in_variant|not_ready|released|superseded|unavailable|upgrade_conflict|upgrade_required)(?:\/[\w-]+)?: /;
  for (let m = message; ; ) {
    const next = m.replace(CODE, "").replace(/^activating \S+?: /, "");
    if (next === m) return m;
    m = next;
  }
}

const help = helpRequest(process.argv.slice(2), wantsColour(process.stdout));
if (help !== null) {
  (help.found ? console.log : console.error)(help.text);
  process.exit(help.found ? 0 : 2);
}
const run = dispatch(process.argv.slice(2));
if (run === null) {
  console.error(USAGE);
  process.exit(2);
}
try {
  process.exit(await run());
} catch (err) {
  console.error(`meddle: ${plainError((err as Error).message)}`);
  process.exit(1);
}
