import { existsSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { homedir, hostname, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { createHost, webSocketLink, type Host } from "@earendil-works/chord";
import { createRegistry } from "@earendil-works/pi-durable";
import { checkTaskRoot, ensureDataDirs, loadConfig, paths, type NodeConfig } from "./config";
import { BlobStore } from "./blobs/store";
import { startDashboard, type Dashboard } from "./dashboard/server";
import { acceptDashboardStreams } from "./dashboard/tunnel";
import { gitRemote } from "./git/remote-main";
import { gitPreReceive } from "./git/pre-receive";
import { writeHelperWrapper, writePreReceiveHook } from "./git/scripts";
import { acceptGitStreams } from "./git/serve";
import { startApplier } from "./projects/applier";
import { branchText, conflictFix } from "./projects/branches";
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
import { isTrainEvent, resultError, tokenFaultNotice, tokenFaultOf } from "./engine/session";
import { PoolObject, ProjectObject } from "./state/contracts";
import { createNodeHost, NodeObject, SessionObject, TaskObject } from "./state/host";
import { openDb } from "./store/db";
import { attachCheckout, checkHelperOnPath, checkoutAt, colocate, fetchCheckout, makeCheckout, pushStart } from "./projects/checkouts";
import { listProjects } from "./projects/project";
import { countRunningTasks, listLiveTasks } from "./store/records";
import { TaskRunner, type RunnerDeps } from "./tasks/durable";
import { openHarness } from "./tasks/harness";
import { olderHolder, trainArgs, trainProjectChoice, trainText, type TrainArgs, type TrainView } from "./train/surface";
import {
  addToken, enableToken, listTokens, migrateLegacyToken, moveToken, pickToken, removeToken, sweepTokenValues, findToken,
  type TokenMeta,
} from "./token";
import { ensureClaude } from "./claude-code";
import { embedded } from "./embedded";
import { helpRequest, usageFor } from "./help";
import { highlightId, palette, table, wantsColour } from "./ansi";
import { claudeCodeVersion, VERSION } from "./version";
import { buildInfo, readBinary, CHECKOUT_BUILD, type BuildInfo } from "./update/build";
import { acceptRolloutStreams } from "./update/channel";
import {
  performSwap, readPending, readState, runGuard, settleSwap, updateFiles, watchHealth, type SwapPlan, type UpdateFiles,
} from "./update/files";
import { parseDuration, formatDuration } from "./update/model";
import { guardLine, preflightCommand, RESTART_STATUS, runPreflight, updateBlocked } from "./update/node";
import { serveUpdate } from "./update/object";
import { statusLines } from "./update/report";
import { inputHeld, nodeInputHold } from "./update/gate";
import { bootUpdate, holdsAtBoot, Updater, type UpdateSnapshot } from "./update/updater";
import { UpdateObject } from "./state/contracts";

const USAGE = `usage: meddle --version
       meddle serve
       meddle status
       meddle pool [-v]
       meddle pool secret [--file <path> | --generate <path>] [--name <name>]
       meddle pool peer <node id> | meddle pool remove <id|prefix> | meddle pool allow <id|prefix>
       meddle token add [--file <path>] [--label <l>] | meddle token set [--file <path>] [--label <l>]
       meddle token list | meddle token status | meddle token remove <id|label> | meddle token enable <id|label>
       meddle token move <id|label> --before <id|label> | meddle token move <id|label> --after <id|label>
       meddle config set <key> <value> | meddle config unset <key> | meddle config list
       meddle project add <path-or-url> [--name <n>] [--no-fetch]
       meddle project list
       meddle project set-default <id|name> <branch>
       meddle project status <id|name>
       meddle checkout <id|name> [<dir>]
       meddle task new [<prompt>] [--title <t>] [--project <id|name> [--rev <rev>] [--edit]]... [--node <id|prefix> | --here]
       meddle task list
       meddle task prompt <id> <text> | meddle task retry <id>
       meddle task move <id> <node> [--now] | meddle task move <id> --now | meddle task move <id> --cancel
       meddle task archive <id> | meddle task delete <id>
       meddle task restore <id> [--node <id|prefix> | --here]
       meddle task accept <task-id>... | meddle task unqueue <task-id>...
       meddle train [<project>] [--follow] | meddle train pause|resume [<project>]
       meddle service install [--dry-run]
       meddle update [--force] [--within <duration>] [<binary>...]
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
  /** Stops applying rows to the service repos and their views. */
  stopApplier?: () => void;
  /** Stops checking whether tasks' work is accepted (`TaskRunner.close`). */
  stopAccepting?: () => void;
  /** This node's part in pool updates, and the rollout channel's streams. */
  updater?: Updater;
  stopRollouts?: () => void;
};

/**
 * Closes whatever of the node is open: the dashboard, the applier, the acceptance checks, the tunnels, git (the
 * acceptor, then the socket and its file), the pool, metrics, the harness, the host, then the database.
 */
async function shutdown(node: OpenNode): Promise<void> {
  await node.dashboard?.stop();
  node.stopRollouts?.();
  await node.updater?.stop();
  clearInterval(node.janitor);
  node.stopApplier?.();
  node.stopAccepting?.();
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
  const build = buildInfo();
  const files = updateFiles(cfg.dataDir, process.execPath);
  // A pool update's swap the unit's guard did not settle (it did not run, or another build is running than the one
  // swapped in): before anything opens. The binary in place changed: systemd starts it.
  const settled = await settleSwap(files, { running: build.buildId, log: (line) => console.error(line) });
  if (settled.action === "rollback") console.error(`meddle: update: ${settled.text}`);
  if (settled.restart) return RESTART_STATUS;
  const boot = await bootUpdate(files, build);
  // A new build has until its health deadline, however far it gets: past it unhealthy, it exits for the guard.
  if (boot.awaiting !== null) {
    watchHealth(files, boot.awaiting, () => {
      console.error(`meddle: update: build ${build.buildId} is not healthy by its deadline; exiting for the guard to roll it back`);
      process.exit(RESTART_STATUS);
    });
  }
  /** What the update holds on this node; until the updater says, everything when it starts on a held build. */
  const heldAtBoot = holdsAtBoot(boot, build);
  let hosting: () => string | null = () => (heldAtBoot ? "update in progress" : null);
  /** What the updater asked for once the node stopped: a swap, or a restart for the guard to roll back. */
  let after: { swap: SwapPlan } | "restart" | null = null;
  // Before anything runs jj: git finds the helper for meddle:// remotes, and a push meets its hook.
  await writeHelperWrapper(cfg);
  await writePreReceiveHook(cfg);
  await seedProfile(cfg);
  await ensurePlugins(cfg);
  const root = await checkTaskRoot(cfg);
  if (!root.ok) console.error(`meddle: ${root.reason}; this node will not host tasks`);

  // Before the pool starts: a peer that connects meanwhile finds everything this node serves it ready, rather than a
  // node still downloading Claude Code (in the single binary, on its first start).
  const claude = await runnerDeps(cfg);

  const node: OpenNode = {};
  // Nothing is accepted from the database copy until the pool confirms the new build or rolls it back: on a build
  // awaiting confirmation, from the start, until the updater says otherwise.
  const inputHold = () => nodeInputHold(node.updater, boot.awaiting);
  try {
    const db = (node.db = openDb(paths(cfg).db));
    // The single token of an older meddle joins the list (last, behind any already there), once.
    await migrateLegacyToken(cfg, db, (await loadOrCreateIdentity(cfg)).id);
    // What a crash left in the tokens directory: a half-written value, the value of a removed token.
    await sweepTokenValues(cfg, db);
    // And in the archives directory: a half-written archive.
    await sweepArchiveTemps(cfg);
    // And in the blobs directory: a half-written upload.
    await new BlobStore(paths(cfg).blobs).sweepTemps();
    // The pool and git first: the Harness reruns unfinished turns as it opens, and their turn ends push to homes.
    const pool = (node.pool = await startPool(cfg, db, {
      version: VERSION,
      claudeCodeVersion: claudeCodeVersion(),
      // A node a pool update holds (unconfirmed, or behind the pool's build) takes no tasks.
      hostsTasks: async () => (await checkTaskRoot(cfg)).ok && hosting() === null,
      taskCount: () => listLiveTasks(db).length,
      running: () => countRunningTasks(db),
      projects: () => listProjects(db).map((p) => ({ id: p.id, name: p.name, home: p.home, defaultBranch: p.defaultBranch })),
    }));
    const gitSocket = (node.gitSocket = new GitSocket(cfg, pool.net));
    await gitSocket.start();
    const logGit = dedupe((line) => console.error(line));
    node.stopGit = acceptGitStreams(pool.net, {
      db, cfg, pool, selfId: pool.identity.id, isMember: (id) => pool.store.isMember(id), log: logGit, inputHold,
    });
    // On a held build nothing the Harness holds reruns until the updater lets it.
    const harness = (node.harness = await openHarness(cfg, createRegistry(), { hold: heldAtBoot }));
    const runner = new TaskRunner(cfg, db, harness.harness, { ...claude, pool });
    if (heldAtBoot) runner.setHolds({ turns: "update in progress", work: "update in progress", hosting: "update in progress" });
    const updater = (node.updater = startUpdater(files, build, boot, pool, runner, {
      swap: (plan) => { after = { swap: plan }; signalled.resolve(); },
      restart: () => { after = "restart"; signalled.resolve(); },
    }));
    hosting = () => runner.holds().hosting;
    node.stopRollouts = acceptRolloutStreams(pool.net, {
      isMember: (id) => pool.store.isMember(id),
      received: (from, msg) => updater.received(from, msg),
      binaryFor: (b, platform, sha) => updater.binaryFor(b, platform, sha),
    });
    node.stopAccepting = () => runner.close();
    node.stopBlobs = acceptBlobStreams(pool.net, runner, runner.blobs.store);
    // Archives of tasks that moved away are kept for seven days (decision 18).
    const janitor = () => {
      runJanitor(cfg).catch((err: unknown) => console.error("meddle: archive janitor:", err));
    };
    janitor();
    node.janitor = setInterval(janitor, JANITOR_INTERVAL_MS);
    node.janitor.unref();
    const metrics = (node.metrics = new MetricsSampler({
      taskPids: () => findTaskPids(cfg.taskRoot),
      intervalMs: 5000,
      dataDir: cfg.dataDir,
    }));
    metrics.start();
    const host = (node.host = createNodeHost({ cfg, db, runner, metrics, claudeCodeVersion: claudeCodeVersion(), pool, inputHold }));
    serveUpdate(host, {
      snapshot: () => updater.snapshot(),
      startRollout: (req) => updater.startRollout(req),
      changes: { subscribe: (cb) => updater.onChange(() => cb(null)) },
      inputHold,
    });
    // Its host objects activated first, so a dashboard that fails to start never abandons one half-activated.
    await host.ready();
    // Every project of the pool kept here, its rows applied to its service repo and view as they change.
    node.stopApplier = startApplier({ cfg, db, pool });
    node.stopTunnels = acceptDashboardStreams(pool.net, host, (id) => pool.store.isMember(id));
    node.dashboard = await startDashboard(cfg, host, pool, runner.blobs);
  } catch (err) {
    await shutdown(node);
    throw err;
  }
  console.log(`node ${node.pool!.identity.id}`);
  console.log(`dashboard at ${node.dashboard.url}`);
  node.updater!.run();
  node.updater!.serving();

  await signalled.promise;
  await shutdown(node);
  const asked = after as { swap: SwapPlan } | "restart" | null;
  if (asked === "restart") return RESTART_STATUS;
  if (asked !== null) {
    // The node is down, its databases closed: copied as a pair, then the new binary goes into place. A swap that fails
    // is undone, and recorded as this node's failure, before the restart.
    const log = (line: string) => console.error(line);
    await performSwap(files, asked.swap, Date.now, log).catch((err: unknown) => log(`meddle: update: the swap failed: ${(err as Error).message}`));
    return RESTART_STATUS;
  }
  return 0;
}

/** A node as update messages name it: its hostname, else its short id. */
function nodeName(pool: PoolRuntime, id: string): string {
  const short = shortId(id);
  const host = pool.store.row(id)?.hostname ?? "";
  return host === "" || host === short ? short : host;
}

/**
 * This node's `Updater`: the pool's net and roster, the pool's `update.*` settings, the runner's holds and drains, and
 * the swap and restart, which `serve` performs once the node is down.
 */
function startUpdater(
  files: UpdateFiles, build: BuildInfo, boot: Awaited<ReturnType<typeof bootUpdate>>, pool: PoolRuntime,
  runner: TaskRunner, end: { swap(plan: SwapPlan): void; restart(): void },
): Updater {
  const updater = new Updater({
    selfId: pool.identity.id,
    build,
    files,
    net: pool.net,
    isMember: (id) => pool.store.isMember(id),
    members: () => pool.store.members().map((r) => r.nodeId),
    name: (id) => nodeName(pool, id),
    withinMs: () => pool.settings.updateWithinMs(),
    healthMs: () => pool.settings.updateHealthMs(),
    blocked: () => updateBlocked(build, files),
    preflight: (path, b) => runPreflight(path, b),
    busy: () => runner.busyTasks(),
    hold: (holds) => {
      const before = runner.holds();
      runner.setHolds(holds);
      // Turns held since the start (an unconfirmed or behind build) resume with the Harness once the hold lifts.
      if (holds.turns === null && holds.work === null) runner.resumeHarness();
      if (before.hosting !== holds.hosting) void pool.refresh();
    },
    swap: async (plan) => end.swap(plan),
    restart: async () => end.restart(),
    log: (line) => console.error(line),
  }, boot);
  // Tasks move only between nodes on one build (a checkout's is its own matter, as before updates).
  runner.setMoveCheck((to) => {
    const theirs = updater.view().nodes[to]?.build;
    if (theirs === undefined || theirs === CHECKOUT_BUILD || build.buildId === CHECKOUT_BUILD || theirs === build.buildId) return null;
    return `${nodeName(pool, to)} runs build ${theirs}, this node ${build.buildId}`;
  });
  return updater;
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
  for (const name of ["MEDDLE_FIXTURE", "MEDDLE_FIXTURE_STALL", "MEDDLE_FIXTURE_MEMORY", "MEDDLE_FIXTURE_BY_TOKEN", "MEDDLE_FIXTURE_RESULTS_MS", "MEDDLE_FIXTURE_LATER_RESULTS_MS"]) {
    const value = env[name];
    if (value !== undefined) extraEnv[name] = value;
  }
  if (Object.keys(extraEnv).length > 0) deps.extraEnv = extraEnv;
  return deps;
}

/**
 * Version, Claude Code version, data dir, task root, token, task count, node id and pool, then pool updates: this
 * node's build, the pool's, every node's build and update state, and the current rollout or its failure
 * (`statusLines`). Reads the database read-only and creates neither it nor the node's key.
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
  // Pool updates, from the update's files: also while the node is down for its swap.
  const files = updateFiles(cfg.dataDir, process.execPath);
  const { self, view } = await readState(files);
  const roster = (await readDb(cfg, (db) => (hasPool(db) ? new PoolStore(db).roster() : []))) ?? [];
  for (const line of statusLines(buildInfo(), view, await readPending(files), self, (id) => nodeLabel(roster, id))) console.log(line);
  return 0;
}

/** The database has a pool table with the pool in it: a node of this meddle has served. */
function hasPool(db: Database): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pool'").get() !== null && db.query("SELECT 1 FROM pool").get() !== null;
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
  if (!hasPool(db)) return null;
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

/** Puts a token (its full id or its label) just before or just after another here, and tells the running node. */
async function tokenMove(idOrLabel: string, to: { before: string } | { after: string }): Promise<number> {
  const cfg = loadConfig();
  if (!existsSync(paths(cfg).db)) throw new Error(`no such token: ${idOrLabel}`);
  const [moved, anchor] = await withDb(cfg, (db) =>
    [moveToken(db, idOrLabel, to), findToken(db, "before" in to ? to.before : to.after)] as const);
  await tokensChanged();
  console.log(`moved ${moved.id} (${moved.label}) ${"before" in to ? "before" : "after"} ${anchor.id} (${anchor.label})`);
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

/**
 * Adds an existing directory as a folder project, anything else as an upstream URL; prints the project id. A folder is
 * first made a colocated jj repo when it is not a jj repo, and, once the node has built the project's service repo from
 * it, attached to it as a checkout (`attachCheckout`; with `fetch` false, without fetching). Both happen here, in the
 * folder the user named; the node only reads it. Run again on a folder that is already a project (the one its `meddle`
 * remote names, or the one added from it), it repairs that project's checkout instead, and `attachCheckout` pushes the
 * folder's default branch when this node holds that branch in no state (not even still fetching or conflicted).
 * Refuses a folder whose remote names a project of the pool this node does not hold yet, rather than minting another.
 */
function projectAdd(source: string, name: string | undefined, fetch: boolean): Promise<number> {
  return withNode(async (client) => {
    const cfg = loadConfig();
    const named = name === undefined ? {} : { name };
    const isFolder = await stat(source).then((s) => s.isDirectory(), () => false);
    const node = await client.get(NodeObject, {});
    try {
      if (!isFolder) {
        console.log((await node.addProjectFromUpstream({ url: source, ...named })).id);
        return 0;
      }
      const folder = resolve(source);
      // Refused before anything is added: a project whose folder could not be attached would be left behind.
      checkHelperOnPath(cfg);
      await colocate(cfg, folder);
      const self = node.nodeId.value;
      const known = (await checkoutAt(cfg, folder))?.projectId;
      if (known !== undefined) await refuseUnheld(client, self, folder, known);
      const project = await node.addProjectFromFolder({ path: folder, ...named, ...(known === undefined ? {} : { projectId: known }) });
      const defaultBranch = project.defaultBranch ?? null;
      const push = fetch && defaultBranch !== null && !(await holdsBranch(client, project.id, defaultBranch));
      // This node, not the project's home: a folder already a project may be a checkout of a replica of another's.
      await attachCheckout(cfg, self, folder, { id: project.id, defaultBranch }, process.env, { fetch, push });
      console.log(project.id);
      return 0;
    } finally {
      node.release();
    }
  });
}

/**
 * Rejects `<folder> is a checkout of project <id>, which this node does not hold yet` when the pool lists project
 * `projectId` but not on this node (`self`): adding the folder then would mint a second project of it.
 */
async function refuseUnheld(client: Host, self: string, folder: string, projectId: string): Promise<void> {
  const pool = await poolView(client);
  try {
    const listed = poolProjects(pool.nodes.value).find((p) => p.id === projectId);
    if (listed !== undefined && !listed.holders.includes(self)) {
      throw new Error(`${folder} is a checkout of project ${projectId}, which this node does not hold yet`);
    }
  } finally {
    pool.release();
  }
}

/** Whether this node has branch `branch` of project `projectId` in any state: single, conflicted or still fetching. */
async function holdsBranch(client: Host, projectId: string, branch: string): Promise<boolean> {
  const ref = await client.get(ProjectObject, { id: projectId });
  try {
    return ref.branches.value.some((b) => b.name === branch);
  } finally {
    ref.release();
  }
}

/** The id of project `project` (an id or name of the pool, see `resolveProject`) and this node's id. */
async function poolProjectOf(client: Host, project: string): Promise<{ projectId: string; name: string; self: string }> {
  const pool = await poolView(client);
  try {
    const rows = poolProjects(pool.nodes.value);
    const projectId = resolveProject(rows, project);
    return { projectId, name: rows.find((p) => p.id === projectId)?.name ?? projectId, self: pool.self.value };
  } finally {
    pool.release();
  }
}

/** Sets the default branch of project `project` (an id or name of the pool) on this node to `branch`. */
function projectSetDefault(project: string, branch: string): Promise<number> {
  return withNode(async (client) => {
    const { projectId } = await poolProjectOf(client, project);
    const node = await client.get(NodeObject, {});
    try {
      await node.setDefaultBranch({ projectId, branch });
    } finally {
      node.release();
    }
    return 0;
  });
}

/**
 * Each branch of project `project` (an id or name of the pool) as this node computes it, one line each, the default
 * branch first and marked: `<b>  <commit>`; a conflicted one followed by its siblings and how to resolve it, as a
 * refused push says it (`conflictFix`).
 */
function projectStatus(project: string): Promise<number> {
  return withNode(async (client) => {
    const { projectId, name } = await poolProjectOf(client, project);
    const ref = await client.get(ProjectObject, { id: projectId });
    try {
      const defaultBranch = ref.defaultBranch.value;
      const branches = [...ref.branches.value].sort((x, y) => Number(y.name === defaultBranch) - Number(x.name === defaultBranch));
      if (branches.length === 0) console.log(`${name} has no branches`);
      for (const b of branches) {
        console.log(`${b.name}  ${branchText(b)}${b.name === defaultBranch ? " (default)" : ""}`);
        if (b.state === "conflicted") console.log(conflictFix(b.name, b.siblings));
      }
    } finally {
      ref.release();
    }
    return 0;
  });
}

/** Clones project `project` (an id or name of the pool) from this node into `dir` as a checkout; prints its path. */
function checkout(project: string, dir: string | undefined): Promise<number> {
  return withNode(async (client) => {
    const { projectId, name, self } = await poolProjectOf(client, project);
    console.log(await makeCheckout(loadConfig(), self, { id: projectId, name }, dir));
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

/** A project of `task new` as given: an id or name, and the revision it starts at and how (`--rev`, `--edit`). */
type ProjectArg = { project: string; rev?: string; mode?: "edit" };

/**
 * Creates a task of the projects `projects` names (each an id or a name one project of the pool has, see
 * `resolveProject`, with the revision it starts at; none for a task without a project) on the node `where` names,
 * with `prompt` as its first turn when given. Prints `task <id> on <node>`. Run in a checkout of a project on this
 * node, `projects` empty means that project, started as `loose` says (the `--rev`/`--edit` given before any
 * `--project`), and its start is the checkout's (`pushStart`: its revision, else the fork
 * point of its `@`, checked there and pushed to this node); the checkout fetches the task's line once the task exists.
 */
function createTask(
  title: string | undefined, projects: ProjectArg[], where: Where, prompt: string | null, loose: Omit<ProjectArg, "project"> | null = null,
): Promise<number> {
  return withNode(async (client) => {
    const cfg = loadConfig();
    let node: string | null = where === "here" ? "here" : null;
    let chosen: Array<{ id: string; rev?: string; mode?: "edit"; checkout?: string }> = [];
    let checkout: string | null = null;
    const found = await checkoutAt(cfg, process.cwd());
    if (typeof where === "object" || projects.length > 0 || found !== null) {
      const pool = await poolView(client);
      try {
        const known = poolProjects(pool.nodes.value);
        const here = found !== null && found.nodeId === pool.self.value ? found : null;
        // In a checkout of this node, no --project is the checkout's project, with the `--rev`/`--edit` given before any.
        if (loose !== null && here === null) throw new Error("--rev and --edit without --project need a checkout of this node");
        chosen = projects.length === 0 && here !== null
          ? [{ id: here.projectId, ...(loose ?? {}) }]
          : projects.map(({ project, ...start }) => ({ id: resolveProject(known, project), ...start }));
        if (typeof where === "object") node = resolveNodeId(pool.nodes.value.map((n) => n.nodeId), where.node);
        if (here !== null) {
          for (const [i, p] of chosen.entries()) {
            if (p.id !== here.projectId) continue;
            const name = known.find((k) => k.id === p.id)?.name ?? p.id;
            const { commit, moved } = await pushStart(cfg, here.dir, name, p.rev ?? null, p.mode ?? "child").catch((err: unknown) => {
              // Refused as the node refuses a start.
              throw new Error(`project ${name}: ${err instanceof Error ? err.message : String(err)}`);
            });
            if (moved !== null) console.log(moved);
            chosen[i] = { ...p, rev: commit, checkout: here.dir };
            checkout = here.dir;
          }
        }
      } finally {
        pool.release();
      }
    }
    const ref = await client.get(NodeObject, {});
    try {
      const { manifest, nodeId } = await ref.createTask({ ...(title === undefined ? {} : { title }), projects: chosen, node, prompt });
      // The task's line, held by this node now: the revision is read-only in the checkout before this returns.
      if (checkout !== null) await fetchCheckout(cfg, checkout);
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
        // A node of an older meddle cannot be asked for its tasks at all (chord refuses the binding), not even by id.
        let older = false;
        const read = tasksOf(remote.client).catch((err: unknown) => {
          older = olderHolder(err);
          return null;
        });
        const answered = await Promise.race([read, Bun.sleep(REMOTE_TASKS_MS).then(() => "late" as const)]);
        if (answered === null || answered === "late") {
          out.unread.push(older ? `${label} runs an older meddle: its tasks are not listed` : `${label} did not answer: its tasks are not listed`);
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
 * that is printed (`QUEUED_FOR_MOVE`) and the command succeeds. A text sent to a busy task waits to be taken (a steer,
 * or a prompt for a later turn): until the log shows it taken (a `user` event of that text), what other turns log is
 * printed but decides nothing, and the task going idle is not the end.
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
    /** Whether what is logged now is the text's turn: not until the node answers, nor while the text waits to be taken. */
    let ours = false;
    /** Events logged before the node answered, decided on once it has. */
    let held: WindowEvent[] | null = [];
    const follow = (events: readonly WindowEvent[]) => {
      if (held !== null) { held.push(...events); return; }
      for (const { seq, message } of events) {
        if (seq <= printed) continue;
        printed = seq;
        const { type, subtype } = message as { type?: string; subtype?: string };
        console.error(subtype === undefined ? `${type}` : `${type}/${subtype}`);
        if (!ours) {
          ours = type === "user" && (message as { message?: { content?: unknown } }).message?.content === text;
          continue;
        }
        if (type === "meddle" && subtype === "token_fault" && provisional !== null) {
          const fault = message as { rerun?: unknown };
          if (fault.rerun !== true) return finished.reject(new Error(`the turn ended: ${tokenFaultNotice(message as Record<string, unknown>)}`));
          provisional = null;
          faulted = false;
          continue;
        }
        // The SDK's own messages after the result (the child's last words) do not decide; meddle's next one does, unless
        // it is the train's (a prompt or a tool call: neither ends a turn).
        if (provisional !== null && type === "meddle" && !isTrainEvent(message as { type?: unknown; subtype?: unknown })) {
          return finished.reject(provisional);
        }
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
        else if (busy && ours) settle().catch((err: Error) => finished.reject(err));
      }),
    ];
    try {
      const { queued } = await task.prompt({ text });
      // A text that started a turn: everything from here on is its turn's.
      ours = !queued;
      const backlog = held;
      held = null;
      follow(backlog);
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
 * `use` against each of the tasks `texts` name (each an id or a unique prefix, see `withTask`), one after the other. With
 * one, its failure is the command's. With several, one that fails is reported on stderr with its text before the
 * message, and the others still run; the exit status is 1 once any failed.
 */
async function eachTask(texts: string[], use: (text: string) => Promise<number>): Promise<number> {
  if (texts.length === 1) return use(texts[0]!);
  let status = 0;
  for (const text of texts) {
    try {
      status = Math.max(status, await use(text));
    } catch (err) {
      if (err instanceof NoNode) throw err;
      console.error(`meddle: ${text}: ${plainError((err as Error).message)}`);
      status = 1;
    }
  }
  return status;
}

/** `<hostname> runs an older meddle`: node `id`'s hostname, or its short id while that is not known (as a creation refuses). */
function runsOlder(nodes: readonly { nodeId: string; hostname: string }[], id: string): Error {
  return new Error(`${nodes.find((n) => n.nodeId === id)?.hostname || shortId(id)} runs an older meddle`);
}

/**
 * Queues each task on its project's train, on the node holding it; prints `queued <id> on <project>'s train`. A task on a
 * node older than the train is not found at all (`collectTasks`: chord refuses to bind that node's tasks), so the refusal
 * is `no such task: <id> (<node> runs an older meddle: its tasks are not listed)`.
 */
function taskAccept(texts: string[]): Promise<number> {
  return eachTask(texts, (text) => withTask(text, async (client, _socket, id) => {
    const task = await client.get(TaskObject, { id });
    try {
      await task.accept({});
      // Accepted, so it has the one project that accept handles.
      console.log(`queued ${id} on ${task.manifest.value.projects[0]?.name ?? "its project"}'s train`);
    } finally {
      task.release();
    }
    return 0;
  }));
}

/** Takes each task off its project's train, on the node holding it; prints `unqueued <id>`, or `<id> is not queued`. */
function taskUnqueue(texts: string[]): Promise<number> {
  return eachTask(texts, (text) => withTask(text, async (client, _socket, id) => {
    const task = await client.get(TaskObject, { id });
    try {
      const queued = task.queue.value !== null;
      await task.unqueue({});
      console.log(queued ? `unqueued ${id}` : `${id} is not queued`);
    } finally {
      task.release();
    }
    return 0;
  }));
}

/**
 * Shows, pauses or resumes the train of the project `args` names (see `trainProjectChoice`) at the project's home, which
 * runs it: this node, or the home's over the tunnel (as `collectTasks` reads a member's tasks); refused when the home is
 * offline or gone (the train waits for it) or runs an older meddle. Showing prints it once (`trainText`, each task by
 * its title), or with `--follow` each time it changes, until its queue is empty.
 */
function train(args: TrainArgs): Promise<number> {
  return withNode(async (client, socket) => {
    const pool = await poolView(client);
    const nodes = [...pool.nodes.value];
    const self = pool.self.value;
    pool.release();
    const here = args.project === undefined ? await checkoutAt(loadConfig(), process.cwd()) : null;
    const project = trainProjectChoice(poolProjects(nodes), args.project, here?.projectId ?? null);
    const home = nodes.find((n) => n.nodeId === project.home);
    if (project.home !== self && home?.online !== true) {
      throw new Error(`${project.name}'s train waits: its home ${nodeLabel(nodes, project.home)} is ${home?.gone === true ? "gone" : "offline"}`);
    }
    const remote = project.home === self ? null : await connect(`/ws/node/${project.home}`);
    try {
      const ref = await (remote?.client ?? client).get(ProjectObject, { id: project.id });
      try {
        if (args.action === "pause") {
          await ref.pause({});
          console.log(`paused ${project.name}'s train`);
        } else if (args.action === "resume") {
          await ref.resume({});
          console.log(`resumed ${project.name}'s train`);
        } else {
          await showTrain(client, remote?.socket ?? socket, ref.train, args.follow);
        }
      } finally {
        ref.release();
      }
      return 0;
    } catch (err) {
      if (olderHolder(err)) throw runsOlder(nodes, project.home);
      throw err;
    } finally {
      await remote?.client.close();
    }
  });
}

/**
 * Prints the train `cell` holds with each task's title (`trainText`); with `follow`, again each time it changes, a blank
 * line between, until its queue is empty (at once when it is). The titles are the pool's tasks', read through `client`
 * again only for a task not looked up yet. `socket` is the link the cell is read over: its closing ends the following.
 */
async function showTrain(
  client: Host, socket: WebSocket, cell: { value: TrainView; subscribe(fn: (value: TrainView) => void): () => void }, follow: boolean,
): Promise<void> {
  const titles = new Map<string, string>();
  const looked = new Set<string>();
  const print = async (state: TrainView) => {
    const ids = [...state.queued.map((t) => t.taskId), ...(state.round?.batch ?? []), ...(state.round?.mergeTask == null ? [] : [state.round.mergeTask])];
    const fresh = ids.filter((id) => !looked.has(id));
    if (fresh.length > 0) {
      for (const t of (await collectTasks(client)).tasks) titles.set(t.id, t.title);
      for (const id of fresh) looked.add(id);
    }
    console.log(trainText(state, titles));
  };
  if (!follow) return print(cell.value);
  const finished = Promise.withResolvers<void>();
  finished.promise.catch(() => {}); // a closed link leaves it unawaited when the train then ends
  socket.addEventListener("close", () => finished.reject(new Error("the node closed the connection")));
  // Each change is printed in its turn, a title lookup in between not letting one overtake another.
  let chain: Promise<void> = Promise.resolve();
  let printed = false;
  const stop = cell.subscribe((state) => {
    chain = chain.then(async () => {
      if (printed) console.log("");
      printed = true;
      await print(state);
      if (state.queued.length === 0) finished.resolve();
    }).catch((err: Error) => finished.reject(err));
  });
  try {
    await finished.promise;
  } finally {
    stop();
  }
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
  // The guard a pool update relies on to roll back a binary that cannot start (a checkout is never updated).
  const guard = guardLine(packed !== null ? process.execPath : null);
  return template.replaceAll("{{guard}}", guard).replaceAll("{{exec}}", exec).replaceAll("{{dir}}", dir).replaceAll("{{path}}", quoted);
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

/** `[--force] [--within <duration>] [<binary>...]`, in any order; null for anything else. */
function updateArgs(args: string[]): { force: boolean; withinMs: number | undefined; binaries: string[] } | { problem: string } | null {
  let force = false;
  let within: string | undefined;
  const binaries: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--force" && !force) force = true;
    else if (arg === "--within" && i + 1 < args.length && within === undefined) within = args[++i]!;
    else if (arg.startsWith("--")) return null;
    else binaries.push(arg);
  }
  if (within === undefined) return { force, withinMs: undefined, binaries };
  const ms = parseDuration(within);
  if (ms === null) return { problem: `--within takes a duration such as 90s, 30m or 1h, not ${within}` };
  return { force, withinMs: ms, binaries };
}

/** A participant's state in words: `draining (waiting on 0012, 0013)`, `idle (fetching)`, `failed: <reason>`. */
function participantText(p: NonNullable<UpdateSnapshot["rollout"]>["participants"][number]): string {
  const extra = p.state === "draining"
    ? (p.drained ? " (drained)" : p.waitingOn.length > 0 ? ` (waiting on ${p.waitingOn.join(", ")})` : "")
    : p.step !== null ? ` (${p.step})` : "";
  const why = p.state === "failed" && p.reason !== null ? `: ${p.reason}` : "";
  return `${p.state}${extra}${why}${p.online ? "" : ", offline"}`;
}

/** Prints the current rollout: its build, mode and outcome, each participant's state, and what it waits on. */
function printRollout(snap: UpdateSnapshot, names: (id: string) => string): void {
  const r = snap.rollout;
  console.log(`build ${snap.build.buildId} (${snap.build.platform}) here; the pool runs ${snap.poolBuild ?? "no build rolled out yet"}`);
  if (r === null) {
    console.log("no rollout yet");
    return;
  }
  const status = r.outcome === null ? `in progress, until ${r.deadline}` : r.outcome.status === "confirmed" ? `confirmed at ${r.outcome.at}` : `failed at ${r.outcome.at}`;
  console.log(`rollout of build ${r.build} (${r.mode}, ${r.platforms.join(" and ")}) started by ${names(r.startedBy)} at ${r.startedAt}: ${status}`);
  for (const p of r.participants) console.log(`  ${names(p.node)}  ${participantText(p)}`);
  if (r.outcome === null && r.waiting.length > 0) {
    const turns = r.waiting.flatMap((w) => w.turns.map((t) => `${names(w.node)}'s turn in task ${t}`));
    console.log(turns.length > 0 ? `waiting on ${turns.join(", ")} (meddle update --force to cut them off)` : `waiting on ${r.waiting.map((w) => names(w.node)).join(", ")}`);
  }
  if (r.outcome?.status === "failed") {
    console.log(`failed${r.outcome.node === null ? "" : ` on ${names(r.outcome.node)}`}: ${r.outcome.reason}`);
  }
  for (const n of snap.nodes) {
    if (n.mismatched) console.log(`${names(n.node)} runs build ${n.build}${n.state === "failed" && n.reason !== null ? `; its update failed: ${n.reason}` : `; it is catching up (${n.state})`}`);
    if (n.binary !== null) console.log(`${names(n.node)}: ${n.binary}`);
  }
}

/**
 * `meddle update`: with binaries, reads each one's build and platform (and hashes it) without running it, and has the
 * node roll them out to the pool; with `--force` and no binaries (or the open rollout's), forces the rollout in
 * progress; with neither, reports the current rollout.
 */
async function update(force: boolean, withinMs: number | undefined, paths_: string[]): Promise<number> {
  const binaries: { path: string; buildId: string; platform: string; sha256: string; size: number }[] = [];
  for (const path of paths_) binaries.push({ path: resolve(path), ...(await readBinary(path)) });
  return withNode(async (client) => {
    const ref = await client.get(UpdateObject, {});
    const pool = await poolView(client);
    const names = (id: string) => nodeLabel(pool.nodes.value, id);
    try {
      if (binaries.length === 0 && !force) {
        const snap: UpdateSnapshot = {
          self: ref.self.value, build: ref.build.value, poolBuild: ref.poolBuild.value, rollout: ref.rollout.value as UpdateSnapshot["rollout"],
          lastFailure: ref.lastFailure.value, awaitingConfirmation: ref.awaitingConfirmation.value, held: ref.held.value,
          nodes: [...ref.nodes.value],
        };
        printRollout(snap, names);
        return 0;
      }
      const started = await ref.start({ binaries, force, ...(withinMs === undefined ? {} : { withinMs }) });
      if (started.escalated) console.log(`forced the rollout of build ${started.build}: running turns are cut off`);
      else {
        console.log(`rolling out build ${started.build} to ${started.participants.map(names).join(", ")}${force ? " (forced)" : ""}` +
          (withinMs === undefined ? "" : `, within ${formatDuration(withinMs)}`));
        console.log("meddle update shows how it goes");
      }
      return 0;
    } finally {
      pool.release();
      ref.release();
    }
  });
}

/**
 * `meddle update-guard`: the unit's `ExecStartPre`, run as the previous binary (when there is one: a swap is not
 * settled); see `settleSwap`. Never fails the start.
 */
async function updateGuard(): Promise<number> {
  // Run as `<binary>.previous`: the files are named after the binary the unit starts.
  const exec = process.execPath.endsWith(".previous") ? process.execPath.slice(0, -".previous".length) : process.execPath;
  const files = updateFiles(loadConfig().dataDir, exec);
  try {
    console.error(`meddle: update guard: ${await runGuard(files)}`);
  } catch (err) {
    console.error(`meddle: update guard: ${(err as Error).message}`);
  }
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

/** `<path-or-url> [--name <n>] [--no-fetch]`; null for anything else. */
function projectAddArgs(args: string[]): { source: string; name: string | undefined; fetch: boolean } | null {
  const [source, ...flags] = args;
  if (source === undefined || source.startsWith("--")) return null;
  let name: string | undefined;
  let fetch = true;
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === "--no-fetch" && fetch) {
      fetch = false;
      continue;
    }
    const value = flags[++i];
    if (value === undefined) return null;
    if (flags[i - 1] === "--name" && name === undefined) name = value;
    else return null;
  }
  return { source, name, fetch };
}

/**
 * `[<prompt>]` (the words that are not options, joined by spaces; none for a task that waits for one), `--title <t>`,
 * `--project <id|name>` (repeatable, one each), each optionally followed by its `--rev <rev>` and `--edit` (once each),
 * and at most one of `--node <id|prefix>` and `--here` (neither: `auto`). With no `--project` at all, `--rev` and
 * `--edit` are `loose`: the start of the checkout's project, when `task new` runs in a checkout (else a usage error,
 * which `createTask` cannot tell yet). Null for a usage error; `problem` for `--edit` without `--rev` after a
 * `--project`.
 */
function taskNewArgs(
  args: string[],
): { prompt: string | null; title: string | undefined; projects: ProjectArg[]; loose: Omit<ProjectArg, "project"> | null; where: Where } | { problem: string } | null {
  let title: string | undefined;
  const projects: ProjectArg[] = [];
  const loose: Omit<ProjectArg, "project"> = {};
  const words: string[] = [];
  let where: Where = "auto";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const last = projects.at(-1);
    if (arg === "--title" && i + 1 < args.length && title === undefined) title = args[++i];
    else if (arg === "--project" && i + 1 < args.length) projects.push({ project: args[++i]! });
    else if (arg === "--rev" && i + 1 < args.length && last !== undefined && last.rev === undefined) last.rev = args[++i]!;
    else if (arg === "--edit" && last !== undefined && last.mode === undefined) last.mode = "edit";
    else if (arg === "--rev" && i + 1 < args.length && last === undefined && loose.rev === undefined) loose.rev = args[++i]!;
    else if (arg === "--edit" && last === undefined && loose.mode === undefined) loose.mode = "edit";
    else if (arg === "--node" && i + 1 < args.length && where === "auto") where = { node: args[++i]! };
    else if (arg === "--here" && where === "auto") where = "here";
    else if (arg.startsWith("--")) return null;
    else words.push(arg);
  }
  const prompt = words.join(" ").trim() === "" ? null : words.join(" ");
  if (title !== undefined && title.trim() === "") return null;
  const hasLoose = loose.rev !== undefined || loose.mode !== undefined;
  // Before a --project, they belong to no project.
  if (hasLoose && projects.length > 0) return null;
  if (projects.some((p) => p.mode === "edit" && p.rev === undefined)) return { problem: "--edit needs --rev" };
  // No title: the node names the task (`taskTitle`).
  return { prompt, title, projects, loose: hasLoose ? loose : null, where };
}

/**
 * Whether `args` is a command that changes nothing a rollback's restore would wipe (it reads, or it is not about the
 * node's data): `status`, the lists, `update` with nothing to roll out, and what systemd and git run. Every other
 * command, one added later included, is refused while an update awaits confirmation.
 */
function readOnly(args: string[]): boolean {
  const [command, sub] = args;
  switch (command) {
    case "pool": return args.length === 1 || sub === "-v" || sub === "--verbose";
    case "token": return sub === "list" || sub === "status";
    case "config": return sub === "list";
    case "project": return sub === "list" || sub === "status";
    case "task": return sub === "list";
    // Watching a train changes nothing; pausing or resuming one does.
    case "train": return sub !== "pause" && sub !== "resume";
    case "update": return args.length === 1;
    default: return ["--version", "serve", "status", "checkout", "git-remote", "git-pre-receive", "update-guard", "update-preflight", "service"].includes(command ?? "");
  }
}

/**
 * The subcommand `args` names, or null for a usage error. One that is not read-only is refused first, before it does
 * anything, while the node's update awaits confirmation (or its swap is under way, the node down): a rollback would
 * wipe what it wrote. The node refuses the same through its objects; this also covers what the CLI writes directly.
 */
function dispatch(args: string[]): (() => Promise<number>) | null {
  const run = route(args);
  if (run === null || readOnly(args)) return run;
  return async () => {
    const held = await inputHeld(updateFiles(loadConfig().dataDir, process.execPath));
    if (held !== null) throw new Error(held);
    return run();
  };
}

/** The subcommand `args` names, or null for a usage error. */
function route(args: string[]): (() => Promise<number>) | null {
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
  if (command === "token" && sub === "move" && rest.length === 3 && !rest[0]!.startsWith("--")) {
    const [idOrLabel, flag, anchor] = rest as [string, string, string];
    if (flag === "--before") return () => tokenMove(idOrLabel, { before: anchor });
    if (flag === "--after") return () => tokenMove(idOrLabel, { after: anchor });
  }
  if (command === "config" && sub === "set" && rest.length === 2) return () => configSet(rest[0]!, rest[1]!);
  if (command === "config" && sub === "unset" && rest.length === 1) return () => configUnset(rest[0]!);
  if (command === "config" && sub === "list" && rest.length === 0) return configList;
  if (command === "project" && sub === "add") {
    const parsed = projectAddArgs(rest);
    return parsed === null ? null : () => projectAdd(parsed.source, parsed.name, parsed.fetch);
  }
  if (command === "project" && sub === "set-default" && rest.length === 2) return () => projectSetDefault(rest[0]!, rest[1]!);
  if (command === "checkout" && sub !== undefined && rest.length <= 1 && !sub.startsWith("--")) return () => checkout(sub, rest[0]);
  if (command === "project" && sub === "list" && rest.length === 0) return projectList;
  if (command === "project" && sub === "status" && rest.length === 1) return () => projectStatus(rest[0]!);
  if (command === "task" && sub === "new") {
    const parsed = taskNewArgs(rest);
    if (parsed !== null && "problem" in parsed) return async () => (console.error(`meddle: ${parsed.problem}`), 2);
    if (parsed === null) return null;
    const { loose } = parsed;
    if (loose === null) return () => createTask(parsed.title, parsed.projects, parsed.where, parsed.prompt);
    return async () => {
      // `--rev`/`--edit` with no `--project` name the checkout's project: outside a checkout, a usage error as ever.
      if ((await checkoutAt(loadConfig(), process.cwd())) === null) {
        console.error(usageFor(args) ?? USAGE);
        return 2;
      }
      if (loose.mode === "edit" && loose.rev === undefined) {
        console.error("meddle: --edit needs --rev");
        return 2;
      }
      return createTask(parsed.title, parsed.projects, parsed.where, parsed.prompt, loose);
    };
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
  if (command === "task" && (sub === "accept" || sub === "unqueue") && rest.length >= 1 && rest.every((t) => !t.startsWith("--"))) {
    return () => (sub === "accept" ? taskAccept(rest) : taskUnqueue(rest));
  }
  if (command === "task" && sub === "restore" && rest.length >= 1 && !rest[0]!.startsWith("--")) {
    const where = whereArgs(rest.slice(1));
    return where === null ? null : () => taskRestore(rest[0]!, where);
  }
  if (command === "task" && sub === "delete" && rest.length === 1) return () => taskDelete(rest[0]!);
  if (command === "train") {
    const parsed = trainArgs(args.slice(1));
    return parsed === null ? null : () => train(parsed);
  }
  // git runs a helper as `git-remote-<scheme> <remote> [<url>]`; without a url, the remote is the url.
  if (command === "git-remote" && sub !== undefined && rest.length <= 1) return () => gitRemote(rest[0] ?? sub);
  // git's pre-receive hook, as `writePreReceiveHook` writes it for the compiled binary.
  if (args.length === 1 && command === "git-pre-receive") return () => gitPreReceive();
  if (command === "update") {
    const parsed = updateArgs(args.slice(1));
    if (parsed !== null && "problem" in parsed) return async () => (console.error(`meddle: ${parsed.problem}`), 2);
    return parsed === null ? null : () => update(parsed.force, parsed.withinMs, parsed.binaries);
  }
  // Run by the unit before every start, and by a node on a staged binary; not for people.
  if (args.length === 1 && command === "update-guard") return updateGuard;
  if (args.length === 1 && command === "update-preflight") return () => preflightCommand(loadConfig());
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
  console.error(usageFor(process.argv.slice(2)) ?? USAGE);
  process.exit(2);
}
try {
  process.exit(await run());
} catch (err) {
  console.error(`meddle: ${plainError((err as Error).message)}`);
  process.exit(1);
}
