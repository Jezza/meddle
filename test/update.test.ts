// test/update.test.ts — pool updates: the rollout channel's records and merge rules, and the state machine each node
// runs (`Updater`), driven over a fake pool of nodes with a fake clock, real files and the real swap and guard.
import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StreamReader, writeLine } from "../src/pool/frames";
import { loopbackPair } from "../src/pool/loopback";
import type { PeerStream } from "../src/pool/net";
import { buildMark, CHECKOUT_BUILD, readBinary, type BuildInfo } from "../src/update/build";
import { acceptRolloutStreams, BadBinary, exchange, fetchBinary, Unavailable, type ChannelNet } from "../src/update/channel";
import { guardLine, updateBlocked } from "../src/update/node";
import {
  performSwap, readPending, readState, runGuard, settleSwap, updateFiles, watchHealth, writePending, writeState, type UpdateFiles,
} from "../src/update/files";
import { behindPool, binaryProblem, judge, parseDuration, poolBuild } from "../src/update/model";
import { statusLines } from "../src/update/report";
import {
  BINARY_CHECK_MS, bootUpdate, holdsAtBoot, PEER_HEALTH_GRACE_MS, Updater, type Holds, type SwapPlan,
} from "../src/update/updater";
import { closedPort, meddle, startServe } from "./helpers";
import { POOL_ENV } from "./pool-helpers";
import {
  emptyView, mergeView, messageOf, OTA_DRIVES, OTA_V, parseMessage, type NodeUpdate, type Rollout, type RolloutView,
} from "../src/update/wire";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const OLD = "0ld0ld0ld0ld";
const NEW = "1ee71ee71ee7";
const MIN = 60_000;
const NAMES: Record<string, string> = { [A]: "a", [B]: "b", [C]: "c" };

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** Settles every node's steps, the debounced exchanges between them, and the swaps of nodes gone down. */
async function settle(pool: FakePool, rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Bun.sleep(15);
    await Promise.all([...pool.nodes.values()].map((n) => (n.updater === null ? n.going : n.updater.poke())));
  }
}

type FakeNode = {
  id: string;
  platform: string;
  build: string;
  files: UpdateFiles;
  updater: Updater | null;
  holds: Holds | null;
  busy: string[];
  preflightError: string | null;
  blocked: string | null;
  swaps: SwapPlan[];
  restarts: number;
  /** What the node's data dir held when the swap copied it, and what a test wrote after. */
  dbText: () => Promise<string>;
  /** Runs as the swap begins, the node down (a test breaks the swap with it); `die`: the process ends before the swap. */
  beforeSwap: (() => Promise<void | "die">) | null;
  /** Fails this node's fetches with this error, when set. */
  fetchError: Error | null;
  /** How each fetch from this node's peers went, in order: the peer, and the error or null. */
  fetches: Array<{ peer: string; error: string | null }>;
  /** The node going down: its updater stopping, then the swap (as `serve` does them, in that order, once it is down). */
  going: Promise<void>;
};

/** A pool of nodes on one fake clock, each with its own data dir and "binary", connected unless a test cuts one off. */
class FakePool {
  readonly nodes = new Map<string, FakeNode>();
  readonly offline = new Set<string>();
  now = Date.parse("2026-11-13T10:00:00.000Z");
  readonly binaries = new Map<string, { path: string; sha256: string; size: number }>();
  readonly logs: string[] = [];
  readonly peerListeners = new Set<(id: string, online: boolean) => void>();

  /** Brings a node back online, and tells every node so, as the net does. */
  reconnect(id: string): void {
    this.offline.delete(id);
    for (const cb of [...this.peerListeners]) cb(id, true);
  }

  async addNode(id: string, platform = "linux-x64", build = OLD, view: RolloutView = emptyView()): Promise<FakeNode> {
    const dir = await mkdtemp(join(tmpdir(), "meddle-update-"));
    dirs.push(dir);
    await mkdir(join(dir, "bin"));
    const exec = join(dir, "bin", "meddle");
    await writeFile(exec, `binary ${build} ${platform}`);
    await writeFile(join(dir, "meddle.sqlite"), "db before");
    await writeFile(join(dir, "durable.sqlite"), "durable before");
    const files = updateFiles(dir, exec);
    await writeState(files, { self: id, view, boots: 0 });
    const node: FakeNode = {
      id, platform, build, files, updater: null, holds: null, busy: [], preflightError: null, blocked: null, swaps: [], restarts: 0,
      dbText: () => readFile(join(dir, "meddle.sqlite"), "utf8"), beforeSwap: null, fetchError: null, fetches: [],
      going: Promise.resolve(),
    };
    this.nodes.set(id, node);
    await this.boot(node);
    return node;
  }

  /**
   * (Re)starts a node as systemd and `serve` would: the unit's guard (when `.previous` is there), `serve`'s own settling
   * of the swap (exiting to start again when it changed the binary), then the updater from the stored state.
   */
  async boot(node: FakeNode, opts: { guard?: boolean; serve?: boolean } = {}): Promise<void> {
    await node.going;
    if (opts.guard !== false && existsSync(node.files.previous)) await runGuard(node.files, this.now, () => "");
    // The binary in place now is the node's build (the guard may have put the old one back).
    node.build = (await readFile(node.files.exec, "utf8")).split(" ")[1]!;
    const settled = await settleSwap(node.files, { running: node.build, now: this.now, logLines: () => "" });
    if (settled.restart) return this.boot(node, opts);
    const info: BuildInfo = { buildId: node.build, platform: node.platform };
    const boot = await bootUpdate(node.files, info);
    node.holds = null;
    node.updater = new Updater({
      selfId: node.id,
      build: info,
      files: node.files,
      net: {
        online: () => [...this.nodes.keys()].filter((id) => id !== node.id && this.isOnline(id) && this.isOnline(node.id)),
        isOnline: (id) => this.isOnline(id) && this.isOnline(node.id),
        onPeer: (cb) => {
          this.peerListeners.add(cb);
          return () => this.peerListeners.delete(cb);
        },
        openStream: () => Promise.reject(new Error("no streams in this test")),
        onStream: () => () => {},
      },
      isMember: (id) => this.nodes.has(id),
      members: () => [...this.nodes.keys()],
      name: (id) => NAMES[id] ?? id.slice(0, 8),
      withinMs: () => 30 * MIN,
      healthMs: () => 2 * MIN,
      blocked: async () => node.blocked,
      preflight: async (path, build) => {
        if (node.preflightError !== null) throw new Error(node.preflightError);
        const text = await readFile(path, "utf8");
        if (!text.includes(build)) throw new Error(`the staged binary is ${text}`);
      },
      busy: async () => node.busy,
      hold: (h) => { node.holds = h; },
      swap: async (plan) => {
        node.swaps.push(plan);
        await this.down(node);
        const stopped = node.going;
        node.going = (async () => {
          await stopped;
          if ((await node.beforeSwap?.()) === "die") return;
          // As `serve` does once down: a swap that fails is undone and recorded, and the node restarts all the same.
          await performSwap(node.files, plan, () => this.now).catch(() => {});
        })();
      },
      restart: async () => {
        node.restarts++;
        await this.down(node);
      },
      log: (line) => this.logs.push(line),
      now: () => this.now,
      exchange: async (_net, peer, view) => {
        const target = this.nodes.get(peer);
        if (target?.updater == null || !this.isOnline(peer) || !this.isOnline(node.id)) throw new Error("offline");
        // Through JSON both ways, as the channel carries it.
        const sent = parseMessage(JSON.stringify(messageOf(view)))!;
        return parseMessage(JSON.stringify(messageOf(target.updater.received(node.id, sent))));
      },
      fetch: async (_net, peer, want, dest) => {
        try {
          if (node.fetchError !== null) throw node.fetchError;
          const source = (await this.nodes.get(peer)?.updater?.binaryFor(want.build, want.platform, want.sha256)) ?? null;
          if (source === null) throw new Unavailable(`${NAMES[peer]} does not have it`);
          try {
            await writeFile(dest, await source.readFile());
          } finally {
            await source.close();
          }
          node.fetches.push({ peer, error: null });
        } catch (err) {
          node.fetches.push({ peer, error: (err as Error).message });
          throw err;
        }
      },
    }, boot);
    if (opts.serve !== false) node.updater.serving();
    node.updater.run();
    for (const cb of [...this.peerListeners]) cb(node.id, true);
    await node.updater.poke();
  }

  isOnline(id: string): boolean {
    return this.nodes.get(id)?.updater != null && !this.offline.has(id);
  }

  /** Takes the node down: its updater stops (in `going`: the updater may be the one asking, mid-step). */
  async down(node: FakeNode): Promise<void> {
    const u = node.updater;
    node.updater = null;
    const before = node.going;
    node.going = Promise.all([before, u?.stop()]).then(() => {});
    for (const cb of [...this.peerListeners]) cb(node.id, false);
  }

  /** Writes the new build's binary for `platform`, as `bun run build` would. */
  async binary(platform: string, build = NEW, extra = ""): Promise<{ path: string; buildId: string; platform: string; sha256: string; size: number }> {
    const dir = await mkdtemp(join(tmpdir(), "meddle-bin-"));
    dirs.push(dir);
    const path = join(dir, `meddle-${platform}`);
    const text = `binary ${build} ${platform}${extra}`;
    await writeFile(path, text);
    const sha256 = new Bun.CryptoHasher("sha256").update(text).digest("hex");
    return { path, buildId: build, platform, sha256, size: text.length };
  }
}

/** A pool of `ids` on linux-x64, settled. */
async function poolOf(...ids: string[]): Promise<FakePool> {
  const pool = new FakePool();
  for (const id of ids) await pool.addNode(id);
  await settle(pool);
  return pool;
}

/** The node's own record as the node itself has it. */
function own(pool: FakePool, id: string): NodeUpdate | undefined {
  return pool.nodes.get(id)!.updater?.view().nodes[id];
}

function rolloutOf(pool: FakePool, id: string): Rollout {
  return pool.nodes.get(id)!.updater!.view().rollouts.at(-1)!;
}

/** Restarts every node that swapped (or asked to roll back), as systemd would, after its guard. */
async function restartDown(pool: FakePool, serve = true): Promise<void> {
  for (const node of pool.nodes.values()) if (node.updater === null) await pool.boot(node, { serve });
  await settle(pool);
}

test("a queued rollout waits for every participant's turns, then they swap together and confirm once all are healthy", async () => {
  const pool = await poolOf(A, B);
  const b = pool.nodes.get(B)!;
  b.busy = ["t1"];
  const started = await pool.nodes.get(A)!.updater!.startRollout({ binaries: [await pool.binary("linux-x64")], force: false });
  expect(started.participants).toEqual([A, B]);
  await settle(pool);
  // Both staged and draining; A has drained, B waits for its turn, so nobody swaps.
  expect(own(pool, A)?.state).toBe("draining");
  expect(own(pool, A)?.drained).toBe(true);
  expect(own(pool, B)?.waitingOn).toEqual(["t1"]);
  expect(pool.nodes.get(A)!.swaps).toEqual([]);
  // New turns are held on both from the start; moves are held once a node has drained.
  expect(pool.nodes.get(A)!.holds?.turns).toContain(`build ${NEW}`);
  expect(pool.nodes.get(A)!.holds?.work).not.toBeNull();
  expect(b.holds?.work).toBeNull();
  expect(pool.nodes.get(A)!.updater!.waitingText()).toBe("b's turn in task t1");

  b.busy = [];
  await settle(pool);
  expect(pool.nodes.get(A)!.swaps.length).toBe(1);
  expect(b.swaps.length).toBe(1);
  expect(await readFile(b.files.exec, "utf8")).toBe(`binary ${NEW} linux-x64`);
  expect((await readPending(b.files))?.phase).toBe("swapped");

  // Both come back on the new build: held until confirmed, then everything lifts and the copies go.
  await restartDown(pool, false);
  expect(pool.nodes.get(A)!.build).toBe(NEW);
  expect(pool.nodes.get(A)!.holds?.turns).toContain("awaits confirmation");
  expect(pool.nodes.get(A)!.updater!.snapshot().awaitingConfirmation).toBe(true);
  // From its database copy until the pool confirms, a node accepts no input.
  expect(pool.nodes.get(A)!.updater!.inputHold()).toBe(`update in progress (build ${NEW}), try again shortly`);
  pool.nodes.get(A)!.updater!.serving();
  await settle(pool);
  expect(own(pool, A)?.state).toBe("healthy");
  expect(rolloutOf(pool, A).outcome).toBeNull();
  pool.nodes.get(B)!.updater!.serving();
  await settle(pool);
  expect(rolloutOf(pool, A).outcome?.status).toBe("confirmed");
  for (const id of [A, B]) {
    const n = pool.nodes.get(id)!;
    expect(n.holds).toEqual({ turns: null, work: null, hosting: null });
    expect(existsSync(n.files.pending)).toBe(false);
    expect(existsSync(n.files.previous)).toBe(false);
    expect(existsSync(n.files.backup)).toBe(false);
    expect(n.updater!.snapshot().awaitingConfirmation).toBe(false);
    expect(n.updater!.inputHold()).toBeNull();
  }
  expect(poolBuild(pool.nodes.get(B)!.updater!.view())).toBe(NEW);
});

test("a preflight failure fails the rollout everywhere with its reason, and nobody swaps", async () => {
  const pool = await poolOf(A, B);
  pool.nodes.get(B)!.preflightError = "Claude Code 9.9.9 could not be downloaded";
  await pool.nodes.get(A)!.updater!.startRollout({ binaries: [await pool.binary("linux-x64")], force: false });
  await settle(pool);
  const r = rolloutOf(pool, A);
  expect(r.outcome).toMatchObject({ status: "failed", node: B });
  expect((r.outcome as { reason: string }).reason).toContain("preflight failed: Claude Code 9.9.9 could not be downloaded");
  expect(own(pool, A)?.state).toBe("idle");
  expect(own(pool, B)?.state).toBe("failed");
  for (const n of pool.nodes.values()) {
    expect(n.swaps).toEqual([]);
    expect(n.holds).toEqual({ turns: null, work: null, hosting: null });
    expect(existsSync(n.files.staged)).toBe(false);
  }
  expect(pool.nodes.get(B)!.updater!.snapshot().lastFailure?.reason).toContain("preflight failed");
});

test("meddle status's update lines: each node's build and state, and the rollout with what it waits on, or its failure", async () => {
  const pool = await poolOf(A, B);
  const name = (id: string) => NAMES[id]!;
  const lines = (id: string) => statusLines({ buildId: pool.nodes.get(id)!.build, platform: "linux-x64" }, pool.nodes.get(id)!.updater!.view(), null, id, name);
  expect(lines(B)).toEqual([`build ${OLD} (linux-x64)`, `node b build ${OLD} idle`, `node a build ${OLD} idle`]);

  pool.nodes.get(B)!.busy = ["0012"];
  await pool.nodes.get(A)!.updater!.startRollout({ binaries: [await pool.binary("linux-x64")], force: false, withinMs: 10 * MIN });
  await settle(pool);
  const deadline = rolloutOf(pool, A).deadline;
  expect(lines(A)).toEqual([
    `build ${OLD} (linux-x64)`,
    `node a build ${OLD} draining (drained)`,
    `node b build ${OLD} draining (waiting on 0012)`,
    `rollout ${NEW} (queued) in progress until ${deadline}, waiting on b's turn in task 0012`,
  ]);

  pool.now += 10 * MIN + 1;
  await settle(pool);
  const at = (rolloutOf(pool, A).outcome as { at: string }).at;
  expect(lines(A).at(-1)).toBe(`rollout ${NEW} (queued) failed at ${at}: not confirmed within 10m: waiting on b's turn in task 0012`);

  // A swap in progress here says so, and a failed node says why.
  const pending = { v: 1, phase: "swapped" as const, rollout: "r", build: NEW, previousBuild: OLD, platform: "linux-x64", swappedAt: 0, healthMs: 0, starts: 0, healthy: false, late: false };
  const view = pool.nodes.get(A)!.updater!.view();
  const failed = { ...view, nodes: { ...view.nodes, [B]: { ...view.nodes[B]!, state: "failed" as const, reason: "serve failed: no database" } } };
  expect(statusLines({ buildId: NEW, platform: "linux-x64" }, failed, pending, A, name).slice(0, 3)).toEqual([
    `build ${NEW} (linux-x64), awaiting confirmation of build ${NEW}`,
    `node a build ${OLD} idle`,
    `node b build ${OLD} failed: serve failed: no database`,
  ]);
  // Once the pool runs a build, a node on another one is behind it (the dashboard's red dot).
  const confirmed = {
    rollouts: failed.rollouts.map((r) => ({ ...r, outcome: { status: "confirmed" as const, at } })),
    nodes: { ...failed.nodes, [A]: { ...failed.nodes[A]!, build: NEW, sha256: failed.rollouts[0]!.binaries[0]!.sha256 } },
  };
  expect(statusLines({ buildId: NEW, platform: "linux-x64" }, confirmed, null, A, name)).toEqual([
    `build ${NEW} (linux-x64)`,
    `pool build ${NEW}`,
    `node a build ${NEW} idle`,
    `node b build ${OLD} failed, behind the pool's build ${NEW}: serve failed: no database`,
    `rollout ${NEW} (queued) confirmed at ${at}`,
  ]);
});

test("--force on a draining rollout forces it: nobody waits for turns any more", async () => {
  const pool = await poolOf(A, B);
  pool.nodes.get(B)!.busy = ["t1"];
  await pool.nodes.get(A)!.updater!.startRollout({ binaries: [await pool.binary("linux-x64")], force: false });
  await settle(pool);
  expect(pool.nodes.get(B)!.swaps).toEqual([]);
  const forced = await pool.nodes.get(B)!.updater!.startRollout({ binaries: [], force: true });
  expect(forced.escalated).toBe(true);
  await settle(pool);
  expect((await readState(pool.nodes.get(A)!.files)).view.rollouts.at(-1)?.mode).toBe("forced");
  expect(pool.nodes.get(A)!.swaps.length).toBe(1);
  expect(pool.nodes.get(B)!.swaps.length).toBe(1);
});

test("a rollout not confirmed within its deadline fails, naming what it waited on, and drops the staged binaries", async () => {
  const pool = await poolOf(A, B);
  pool.nodes.get(B)!.busy = ["0012"];
  await pool.nodes.get(A)!.updater!.startRollout({ binaries: [await pool.binary("linux-x64")], force: false, withinMs: 10 * MIN });
  await settle(pool);
  pool.now += 10 * MIN + 1;
  await settle(pool);
  const r = rolloutOf(pool, B);
  expect(r.outcome).toMatchObject({ status: "failed", node: null, reason: "not confirmed within 10m: waiting on b's turn in task 0012" });
  for (const n of pool.nodes.values()) {
    expect(existsSync(n.files.staged)).toBe(false);
    expect(n.holds?.turns).toBeNull();
  }
});

test("a participant not healthy within its health deadline fails the rollout, and every participant rolls back binary and database", async () => {
  const pool = await poolOf(A, B);
  await pool.nodes.get(A)!.updater!.startRollout({ binaries: [await pool.binary("linux-x64")], force: false });
  await settle(pool);
  expect(pool.nodes.get(A)!.swaps.length).toBe(1);
  await restartDown(pool, false);
  // On the new build, A serves and is healthy, and writes to its database; B never finishes starting.
  pool.nodes.get(A)!.updater!.serving();
  await writeFile(join(pool.nodes.get(A)!.files.dir, "..", "meddle.sqlite"), "db after");
  await settle(pool);
  expect(own(pool, A)?.state).toBe("healthy");
  // Peers give B its health deadline from its `swapped` (sent before its database copy), and a grace for the copy.
  pool.now += 2 * MIN + 1;
  await settle(pool);
  expect(rolloutOf(pool, A).outcome).toBeNull();
  pool.now += PEER_HEALTH_GRACE_MS;
  await settle(pool);
  // Each restarts; its guard puts the old binary and database back.
  expect(pool.nodes.get(A)!.restarts).toBe(1);
  expect(pool.nodes.get(B)!.restarts).toBe(1);
  await restartDown(pool);
  const r = rolloutOf(pool, A);
  expect(r.outcome).toMatchObject({ status: "failed", node: B });
  expect((r.outcome as { reason: string }).reason).toContain("not healthy within 2m");
  for (const n of pool.nodes.values()) {
    expect(n.build).toBe(OLD);
    expect(await n.dbText()).toBe("db before");
    expect(existsSync(n.files.pending)).toBe(false);
    expect(existsSync(n.files.previous)).toBe(false);
  }
  expect(own(pool, B)?.state).toBe("failed");
  expect(own(pool, A)?.state).toBe("idle");
  expect(poolBuild(pool.nodes.get(A)!.updater!.view())).toBeNull();
});

test("a new binary that keeps crashing is rolled back by the guard, which records why", async () => {
  const pool = await poolOf(A);
  await pool.nodes.get(A)!.updater!.startRollout({ binaries: [await pool.binary("linux-x64")], force: false });
  await settle(pool);
  const a = pool.nodes.get(A)!;
  expect(a.swaps.length).toBe(1);
  // Three starts that crash before the updater runs: the guard counts each; the fourth rolls back.
  for (let i = 1; i <= 3; i++) {
    expect(await runGuard(a.files, pool.now, () => "")).toBe(`build ${NEW} start ${i} of 3`);
  }
  expect(await runGuard(a.files, pool.now, () => "TypeError: boom")).toStartWith(`rolled back to build ${OLD}`);
  expect(await readFile(a.files.exec, "utf8")).toBe(`binary ${OLD} linux-x64`);
  const state = await readState(a.files);
  expect(state.view.nodes[A]?.state).toBe("failed");
  expect(state.view.nodes[A]?.reason).toContain("TypeError: boom");
  // The old build starts and tells the pool.
  await pool.boot(a, { guard: false });
  await settle(pool);
  expect(rolloutOf(pool, A).outcome).toMatchObject({ status: "failed", node: A });
});

test("a swap interrupted part way is rolled back on the next start, the database back as the swap copied it", async () => {
  const pool = await poolOf(A);
  const a = pool.nodes.get(A)!;
  await writeFile(a.files.staged, `binary ${NEW} linux-x64`);
  await performSwap(a.files, { rollout: "r1", build: NEW, previousBuild: OLD, platform: "linux-x64", healthMs: 2 * MIN, late: false });
  // As if it crashed before it recorded the swap done.
  const p = (await readPending(a.files))!;
  await writeFile(a.files.pending, JSON.stringify({ ...p, phase: "swapping" }));
  await writeFile(join(a.files.dir, "..", "meddle.sqlite"), "written after the copy");
  expect(await runGuard(a.files, pool.now, () => "")).toBe(`rolled back to build ${OLD}: the swap did not finish`);
  expect(await readFile(a.files.exec, "utf8")).toBe(`binary ${OLD} linux-x64`);
  expect(await a.dbText()).toBe("db before");
  expect((await readState(a.files)).view.nodes[A]).toMatchObject({ state: "failed", reason: "the swap did not finish", rollout: "r1" });
});

test("a participant offline for a minute before it swapped, still draining, fails the rollout, naming it", async () => {
  const pool = await poolOf(A, B);
  pool.nodes.get(B)!.busy = ["t1"];
  await pool.nodes.get(A)!.updater!.startRollout({ binaries: [await pool.binary("linux-x64")], force: false });
  await settle(pool);
  cut(pool, B);
  await settle(pool);
  expect(pool.nodes.get(A)!.updater!.waitingText()).toBe("b (offline)");
  pool.now += MIN - 1000;
  await settle(pool);
  expect(rolloutOf(pool, A).outcome).toBeNull();
  pool.now += 2000;
  await settle(pool);
  expect(rolloutOf(pool, A).outcome).toMatchObject({ status: "failed", node: B, reason: "b went offline" });
  // Nobody swapped, and A has let go of it.
  const a = pool.nodes.get(A)!;
  expect(a.swaps).toEqual([]);
  expect(a.holds).toEqual({ turns: null, work: null, hosting: null });
  expect(existsSync(a.files.staged)).toBe(false);
  // B, back (cut off, it failed the rollout too, naming A): one failure stands on both, and B lets go of its part.
  pool.nodes.get(B)!.busy = [];
  pool.reconnect(B);
  await settle(pool);
  expect(rolloutOf(pool, B).outcome).toEqual(rolloutOf(pool, A).outcome);
  expect(pool.nodes.get(B)!.swaps).toEqual([]);
  expect(pool.nodes.get(B)!.holds?.turns).toBeNull();
});

test("a late node whose update fails rolls back only itself, stays out of the pool's work, and retries at a later restart", async () => {
  const pool = await poolOf(A);
  await pool.nodes.get(A)!.updater!.startRollout({ binaries: [await pool.binary("linux-x64")], force: false });
  await settle(pool);
  await restartDown(pool);
  expect(rolloutOf(pool, A).outcome?.status).toBe("confirmed");
  // B joins on the old build: it is mismatched, so held, and its update fails its preflight.
  const b = await pool.addNode(B);
  b.preflightError = "exec format error";
  await settle(pool);
  expect(own(pool, B)).toMatchObject({ state: "failed", late: true });
  expect(b.holds?.hosting).toContain("its update failed: preflight failed: exec format error");
  expect(rolloutOf(pool, A).outcome?.status).toBe("confirmed");
  expect(pool.nodes.get(A)!.updater!.snapshot().nodes.find((n) => n.node === B)).toMatchObject({ mismatched: true, state: "failed" });
  // Not again in this process; at the next restart, it tries again and succeeds.
  await settle(pool);
  expect(b.swaps).toEqual([]);
  b.preflightError = null;
  await pool.down(b);
  await restartDown(pool);
  expect(b.swaps.length).toBe(1);
  await restartDown(pool);
  expect(b.build).toBe(NEW);
});

test("a late node that keeps crashing on the new build rolls back, and does not retry at the start that rollback causes", async () => {
  const pool = await poolOf(A);
  await pool.nodes.get(A)!.updater!.startRollout({ binaries: [await pool.binary("linux-x64")], force: false });
  await settle(pool);
  await restartDown(pool);
  const b = await pool.addNode(B);
  await settle(pool);
  expect(b.swaps.length).toBe(1);
  for (let i = 0; i < 3; i++) await runGuard(b.files, pool.now, () => "");
  await restartDown(pool);
  expect(b.build).toBe(OLD);
  expect(own(pool, B)).toMatchObject({ state: "failed", late: true });
  expect(b.swaps.length).toBe(1);
  expect(b.holds?.turns).toContain("its update failed");
  expect(rolloutOf(pool, A).outcome?.status).toBe("confirmed");
});

test("meddle update refuses before anything changes", async () => {
  const pool = await poolOf(A, B);
  const a = pool.nodes.get(A)!.updater!;
  const x64 = await pool.binary("linux-x64");
  await expect(a.startRollout({ binaries: [x64, await pool.binary("linux-arm64", "0ther0ther00")], force: false }))
    .rejects.toThrow("different builds");
  await expect(a.startRollout({ binaries: [x64, x64], force: false })).rejects.toThrow("two binaries for linux-x64");
  pool.nodes.get(B)!.blocked = "cannot replace /usr/local/bin/meddle: /usr/local/bin is not writable by this user";
  await settle(pool);
  await expect(a.startRollout({ binaries: [x64], force: false })).rejects.toThrow("b cannot be updated: cannot replace /usr/local/bin/meddle");
  pool.nodes.get(B)!.blocked = null;
  const arm = await pool.addNode(C, "linux-arm64");
  void arm;
  await settle(pool);
  await expect(a.startRollout({ binaries: [x64], force: false })).rejects.toThrow("no binary for c's platform, linux-arm64");
  await expect(a.startRollout({ binaries: [], force: true })).rejects.toThrow("no rollout is in progress to force");
  expect(a.view().rollouts).toEqual([]);
  await a.startRollout({ binaries: [x64, await pool.binary("linux-arm64")], force: false });
  await expect(a.startRollout({ binaries: [x64], force: false })).rejects.toThrow("a rollout is already in progress");
});

test("a checkout node takes no part: not a participant, never held", async () => {
  const pool = new FakePool();
  await pool.addNode(A);
  const c = await pool.addNode(C, "linux-x64", CHECKOUT_BUILD);
  await settle(pool);
  const started = await pool.nodes.get(A)!.updater!.startRollout({ binaries: [await pool.binary("linux-x64")], force: false });
  expect(started.participants).toEqual([A]);
  await settle(pool);
  await restartDown(pool);
  expect(rolloutOf(pool, C).outcome?.status).toBe("confirmed");
  expect(c.holds).toEqual({ turns: null, work: null, hosting: null });
  expect(c.swaps).toEqual([]);
  expect(holdsAtBoot({ view: c.updater!.view(), awaiting: null, boot: 1, sha256: null, stat: null }, { buildId: CHECKOUT_BUILD, platform: "linux-x64" })).toBe(false);
  expect(holdsAtBoot({ view: c.updater!.view(), awaiting: null, boot: 1, sha256: null, stat: null }, { buildId: OLD, platform: "linux-x64" })).toBe(true);
});

test("records merge forward-compatibly: unknown fields kept, forced grows, confirmed beats a failure", () => {
  const base: Rollout = {
    v: 1, id: "r1", build: NEW, binaries: [], startedBy: A, startedAt: "2026-11-13T10:00:00.000Z", mode: "queued",
    participants: [A, B], deadline: "2026-11-13T10:30:00.000Z", healthMs: 120_000, outcome: null,
  };
  const failed = { ...base, outcome: { status: "failed" as const, at: "2026-11-13T10:31:00.000Z", node: null, reason: "late" } };
  const confirmed = { ...base, mode: "forced" as const, outcome: { status: "confirmed" as const, at: "2026-11-13T10:29:00.000Z" } };
  const one = mergeView({ rollouts: [failed], nodes: {} }, { rollouts: [confirmed], nodes: [] }).view.rollouts[0]!;
  expect(one.outcome?.status).toBe("confirmed");
  expect(one.mode).toBe("forced");

  // A newer node's message: a v2 with a field this build does not know, which survives a relay.
  const line = JSON.stringify({
    v: 2,
    rollouts: [{ ...base, v: 2, canary: true }],
    nodes: [{ v: 2, node: B, rev: 5, build: NEW, platform: "linux-x64", state: "healthy", reason: null, at: base.startedAt, rollout: "r1", cpu: "a76" }],
  });
  const msg = parseMessage(line)!;
  const view = mergeView(emptyView(), msg).view;
  expect(view.nodes[B]?.cpu).toBe("a76");
  expect(view.rollouts[0]?.canary).toBe(true);
  expect(JSON.parse(JSON.stringify(messageOf(view))).nodes[0].cpu).toBe("a76");
  // An older rev never replaces a newer one, and a peer never overrides a node's own record.
  const older = parseMessage(JSON.stringify({ v: 1, rollouts: [], nodes: [{ ...msg.nodes[0], rev: 4, state: "failed" }] }))!;
  expect(mergeView(view, older).changed).toBe(false);
  expect(mergeView(view, { rollouts: [], nodes: [{ ...msg.nodes[0]!, rev: 9 }] }, B).changed).toBe(false);
  // Garbage is dropped, not thrown.
  expect(parseMessage("not json")).toBeNull();
  expect(parseMessage(JSON.stringify({ v: 1, rollouts: [{ id: 1 }], nodes: [{ node: "x" }] }))).toEqual({ v: 1, rollouts: [], nodes: [] });
  expect(judge(view, { ...base, participants: [B] }, Date.parse(base.startedAt), (id) => id)).toEqual({ status: "confirmed" });
});

const NEW2 = "2ee72ee72ee7";

/** Takes `id` off the net, and tells every node so, as the net does. */
function cut(pool: FakePool, id: string): void {
  pool.offline.add(id);
  for (const cb of [...pool.peerListeners]) cb(id, false);
}

test("a drained participant offline before it swapped fails the rollout after a minute while others drain, and after as long as a swap gets once all have", async () => {
  // Others still draining: a minute.
  const pool = await poolOf(A, B, C);
  pool.nodes.get(C)!.busy = ["t1"];
  await pool.nodes.get(A)!.updater!.startRollout({ binaries: [await pool.binary("linux-x64")], force: false });
  await settle(pool);
  expect(own(pool, B)).toMatchObject({ state: "draining", drained: true });
  cut(pool, B);
  await settle(pool);
  pool.now += MIN + 1000;
  await settle(pool);
  expect(rolloutOf(pool, A).outcome).toMatchObject({ status: "failed", node: B, reason: "b went offline" });

  // All drained: B may be down for its own swap (its `swapped` not heard), so it gets the health deadline and the grace.
  const pool2 = await poolOf(A, B, C);
  pool2.nodes.get(C)!.busy = ["t1"];
  await pool2.nodes.get(A)!.updater!.startRollout({ binaries: [await pool2.binary("linux-x64")], force: false });
  await settle(pool2);
  cut(pool2, B);
  pool2.nodes.get(C)!.busy = [];
  await settle(pool2);
  // Nobody swaps without B, and the rollout says it waits on it.
  expect(pool2.nodes.get(A)!.updater!.waitingText()).toBe("b (offline)");
  pool2.now += 2 * MIN + PEER_HEALTH_GRACE_MS - 1000;
  await settle(pool2);
  expect(rolloutOf(pool2, A).outcome).toBeNull();
  expect(pool2.nodes.get(A)!.swaps).toEqual([]);
  pool2.now += 2000;
  await settle(pool2);
  expect(rolloutOf(pool2, A).outcome).toMatchObject({ status: "failed", node: B, reason: "b went offline" });
  for (const id of [A, C]) expect(pool2.nodes.get(id)!.swaps).toEqual([]);
});

test("split in two before the swap: the side that cannot see the other drain fails the rollout; joined, one failure stands", async () => {
  const pool = await poolOf(A, B);
  pool.nodes.get(B)!.busy = ["t1"];
  await pool.nodes.get(A)!.updater!.startRollout({ binaries: [await pool.binary("linux-x64")], force: false });
  await settle(pool);
  cut(pool, B);
  pool.nodes.get(B)!.busy = [];
  await settle(pool);
  // A never heard B drain: a minute. B saw A drained, and has drained itself: A may be swapping, so B waits longer.
  pool.now += MIN + 1;
  await settle(pool);
  expect(rolloutOf(pool, A).outcome).toMatchObject({ status: "failed", node: B, reason: "b went offline" });
  expect(rolloutOf(pool, B).outcome).toBeNull();
  pool.reconnect(B);
  await settle(pool);
  expect(rolloutOf(pool, B).outcome).toEqual(rolloutOf(pool, A).outcome);
  for (const n of pool.nodes.values()) {
    expect(n.swaps).toEqual([]);
    expect(n.build).toBe(OLD);
  }
});

test("a starter whose clock is behind the last rollout still starts the newest one, and a deadline counts on each node's own clock", async () => {
  const pool = await poolOf(A);
  const a = pool.nodes.get(A)!;
  await a.updater!.startRollout({ binaries: [await pool.binary("linux-x64")], force: false });
  await settle(pool);
  await restartDown(pool);
  expect(rolloutOf(pool, A).outcome?.status).toBe("confirmed");
  // The clock goes an hour back: the next rollout starts just after the last, not before it (it is not superseded).
  pool.now -= 60 * MIN;
  const started = await a.updater!.startRollout({ binaries: [await pool.binary("linux-x64", NEW2)], force: false });
  await settle(pool);
  await restartDown(pool);
  const r = a.updater!.view().rollouts.find((x) => x.id === started.rollout)!;
  expect(r.outcome?.status).toBe("confirmed");
  expect(Date.parse(r.startedAt)).toBeGreaterThan(Date.parse(a.updater!.view().rollouts[0]!.startedAt));
  expect(a.swaps.map((s) => s.build)).toEqual([NEW, NEW2]);

  // A rollout from a node whose clock is an hour behind: its deadline passed by the starter's clock, but each node
  // counts its 30 minutes from when it first saw it.
  const pool2 = await poolOf(B, C);
  pool2.nodes.get(C)!.busy = ["t1"];
  const behind = pool2.now - 60 * MIN;
  const bins = await pool2.binary("linux-x64");
  const rollout: Rollout = {
    v: 1, id: "r-skewed", build: NEW, binaries: [{ platform: "linux-x64", sha256: bins.sha256, size: bins.size }], startedBy: A,
    startedAt: new Date(behind).toISOString(), mode: "queued", participants: [B, C], deadline: new Date(behind + 30 * MIN).toISOString(),
    healthMs: 2 * MIN, outcome: null,
  };
  pool2.nodes.get(B)!.updater!.received(A, { v: 1, rollouts: [rollout], nodes: [] });
  await settle(pool2);
  expect(rolloutOf(pool2, B).outcome).toBeNull();
  expect(pool2.nodes.get(B)!.updater!.snapshot().rollout?.deadline).toBe(new Date(pool2.now + 30 * MIN).toISOString());
  pool2.now += 30 * MIN + 1;
  await settle(pool2);
  expect((rolloutOf(pool2, B).outcome as { reason: string }).reason).toStartWith("not confirmed within 30m");
});

test("a swap that fails is undone and fails the rollout with its reason; one that never happened fails it too, and neither goes round again", async () => {
  const pool = await poolOf(A, B);
  const a = pool.nodes.get(A)!;
  // The staged binary is gone when the swap comes to rename it.
  a.beforeSwap = () => rm(a.files.staged, { force: true });
  await a.updater!.startRollout({ binaries: [await pool.binary("linux-x64")], force: false });
  await settle(pool);
  expect(a.swaps.length).toBe(1);
  expect(await readFile(a.files.exec, "utf8")).toBe(`binary ${OLD} linux-x64`);
  expect(existsSync(a.files.previous)).toBe(false);
  expect(existsSync(a.files.pending)).toBe(false);
  expect((await readState(a.files)).view.nodes[A]).toMatchObject({ state: "failed" });
  expect((await readState(a.files)).view.nodes[A]?.reason).toStartWith("the swap failed: ENOENT");
  // B swapped; it hears of the failure on the new build, and rolls back too.
  await restartDown(pool);
  await restartDown(pool);
  expect(rolloutOf(pool, B).outcome).toMatchObject({ status: "failed", node: A });
  expect((rolloutOf(pool, B).outcome as { reason: string }).reason).toStartWith("the swap failed: ENOENT");
  expect(a.swaps.length).toBe(1);
  for (const n of pool.nodes.values()) {
    expect(n.build).toBe(OLD);
    expect(await n.dbText()).toBe("db before");
  }

  // A swap the process went down before (nothing on disk says it began, the record says `swapped`): a failure too.
  const pool2 = await poolOf(A, B);
  const a2 = pool2.nodes.get(A)!;
  a2.beforeSwap = async () => "die";
  await a2.updater!.startRollout({ binaries: [await pool2.binary("linux-x64")], force: false });
  await settle(pool2);
  expect((await readState(a2.files)).view.nodes[A]?.state).toBe("swapped");
  await restartDown(pool2);
  await restartDown(pool2);
  expect(own(pool2, A)).toMatchObject({ state: "failed", reason: "the swap did not happen" });
  expect(rolloutOf(pool2, B).outcome).toMatchObject({ status: "failed", node: A, reason: "the swap did not happen" });
  expect(a2.swaps.length).toBe(1);
  expect(pool2.nodes.get(B)!.build).toBe(OLD);
});

test("two rollouts started at once: the older is failed as superseded, and only the newer goes on", async () => {
  // A and B cannot reach each other, and each starts a rollout: each with itself as its only participant.
  const pool = await poolOf(A, B);
  pool.nodes.get(A)!.busy = ["t1"];
  pool.nodes.get(B)!.busy = ["t2"];
  cut(pool, B);
  await settle(pool);
  await pool.nodes.get(A)!.updater!.startRollout({ binaries: [await pool.binary("linux-x64")], force: false });
  pool.now += 1000;
  await pool.nodes.get(B)!.updater!.startRollout({ binaries: [await pool.binary("linux-x64", NEW2)], force: false });
  await settle(pool);
  expect(own(pool, A)?.state).toBe("draining");
  pool.reconnect(B);
  await settle(pool);
  for (const id of [A, B]) {
    const rollouts = pool.nodes.get(id)!.updater!.view().rollouts;
    expect(rollouts.map((r) => [r.build, r.outcome?.status ?? null])).toEqual([[NEW, "failed"], [NEW2, null]]);
    expect((rollouts[0]!.outcome as { reason: string }).reason).toBe("superseded by a rollout started at the same time");
  }
  // A drops its part in the superseded one (and its staged binary); B's goes on.
  expect(own(pool, A)).toMatchObject({ state: "idle", reason: "the rollout failed: superseded by a rollout started at the same time" });
  expect(existsSync(pool.nodes.get(A)!.files.staged)).toBe(false);
  expect(pool.nodes.get(A)!.holds?.turns).toBeNull();
  expect(own(pool, B)).toMatchObject({ state: "draining", rollout: rolloutOf(pool, B).id });
  expect(pool.nodes.get(A)!.updater!.snapshot().rollout?.build).toBe(NEW2);
});

test("no node keeps a binary it does not run once its rollout is over; a late node no online member can serve fails its update with why", async () => {
  const pool = new FakePool();
  const a = await pool.addNode(A);
  const b = await pool.addNode(B);
  const c = await pool.addNode(C, "linux-arm64");
  await settle(pool);
  cut(pool, C);
  await a.updater!.startRollout({ binaries: [await pool.binary("linux-x64"), await pool.binary("linux-arm64")], force: false });
  // The starter keeps what it was given while the rollout is open, to serve it.
  expect(existsSync(join(a.files.binaries, NEW, "linux-arm64"))).toBe(true);
  await settle(pool);
  await restartDown(pool);
  expect(rolloutOf(pool, A).outcome?.status).toBe("confirmed");
  // Then nobody keeps another platform's binary: each serves the one it runs.
  await settle(pool);
  for (const n of [a, b]) expect(existsSync(join(n.files.binaries, NEW))).toBe(false);

  // A newer rollout fails: its binaries go too.
  a.preflightError = "boom";
  await a.updater!.startRollout({ binaries: [await pool.binary("linux-x64", NEW2), await pool.binary("linux-arm64", NEW2)], force: false });
  await settle(pool);
  expect(rolloutOf(pool, A).outcome).toMatchObject({ status: "failed", node: A });
  expect(existsSync(join(a.files.binaries, NEW2))).toBe(false);
  a.preflightError = null;

  // C comes back: no member online runs the arm64 binary, so its update fails, with why, and it gets the red dot.
  pool.reconnect(C);
  await settle(pool, 16);
  expect(c.swaps).toEqual([]);
  expect(own(pool, C)).toMatchObject({
    state: "failed", late: true, reason: `no member online has the linux-arm64 binary of build ${NEW} (a does not have it; b does not have it)`,
  });
  const seen = b.updater!.snapshot().nodes.find((n) => n.node === C)!;
  expect(seen).toMatchObject({ mismatched: true, state: "failed" });
  expect(c.holds?.hosting).toContain("its update failed");

  // The next rollout takes C along like any other node.
  await a.updater!.startRollout({ binaries: [await pool.binary("linux-x64", NEW2), await pool.binary("linux-arm64", NEW2)], force: false });
  await settle(pool);
  await restartDown(pool);
  await settle(pool);
  expect(rolloutOf(pool, B).outcome?.status).toBe("confirmed");
  expect(c.build).toBe(NEW2);
  expect(existsSync(join(a.files.binaries, NEW2))).toBe(false);
});

test("a node whose late update failed is a participant of the next rollout: held out of the pool's work, updated with the rest, and its failure fails it", async () => {
  const pool = await poolOf(A);
  const a = pool.nodes.get(A)!;
  await a.updater!.startRollout({ binaries: [await pool.binary("linux-x64")], force: false });
  await settle(pool);
  await restartDown(pool);
  // B joins on the old build, and its late update fails.
  const b = await pool.addNode(B);
  b.preflightError = "exec format error";
  await settle(pool);
  expect(own(pool, B)).toMatchObject({ state: "failed", late: true });

  // The next rollout takes it along; its failure fails the whole rollout.
  const started = await a.updater!.startRollout({ binaries: [await pool.binary("linux-x64", NEW2)], force: false });
  expect(started.participants).toEqual([A, B]);
  b.preflightError = "still broken";
  await settle(pool);
  expect(rolloutOf(pool, A).outcome).toMatchObject({ status: "failed", node: B, reason: "preflight failed: still broken" });
  expect(a.swaps.length).toBe(1);

  // Fixed, and rolled out again: it drains, swaps and confirms with the rest; until then it stays out of the pool's work.
  b.preflightError = null;
  b.busy = ["t1"];
  await a.updater!.startRollout({ binaries: [await pool.binary("linux-x64", NEW2)], force: false });
  await settle(pool);
  expect(own(pool, B)).toMatchObject({ state: "draining", late: false });
  expect(b.holds?.hosting).toContain(`the pool runs ${NEW}`);
  b.busy = [];
  await settle(pool);
  await restartDown(pool);
  expect(rolloutOf(pool, A).outcome?.status).toBe("confirmed");
  for (const n of pool.nodes.values()) {
    expect(n.build).toBe(NEW2);
    expect(n.holds).toEqual({ turns: null, work: null, hosting: null });
  }
});

test("a late node fetches the pool's binary from any member running it, not only the starter, which keeps no copy", async () => {
  const pool = await poolOf(A, B);
  const c = await pool.addNode(C);
  cut(pool, C);
  await pool.nodes.get(A)!.updater!.startRollout({ binaries: [await pool.binary("linux-x64")], force: false });
  await settle(pool);
  await restartDown(pool);
  expect(rolloutOf(pool, A).outcome?.status).toBe("confirmed");
  const b = pool.nodes.get(B)!;
  expect(existsSync(join(b.files.binaries, NEW))).toBe(false);
  // Every node reports its binary's hash: the rollout's, once it runs it.
  const sha = rolloutOf(pool, A).binaries[0]!.sha256;
  expect(own(pool, B)?.sha256).toBe(sha);
  // C back with the starter away: B gives it the binary it runs.
  cut(pool, A);
  pool.reconnect(C);
  await settle(pool, 16);
  expect(c.fetches.filter((f) => f.error === null)).toEqual([{ peer: B, error: null }]);
  await restartDown(pool);
  expect(c.build).toBe(NEW);
  expect(own(pool, C)).toMatchObject({ state: "healthy", sha256: sha });
});

test("a binary replaced on disk under its running node is flagged, and served no more", async () => {
  const pool = await poolOf(A, B, C);
  await pool.nodes.get(A)!.updater!.startRollout({ binaries: [await pool.binary("linux-x64")], force: false });
  await settle(pool);
  await restartDown(pool);
  const sha = rolloutOf(pool, A).binaries[0]!.sha256;
  const b = pool.nodes.get(B)!;
  const c = pool.nodes.get(C)!;
  // What B serves is the very file it hashed, from its start.
  const served = (await b.updater!.binaryFor(NEW, "linux-x64", sha))!;
  expect(await served.readFile("utf8")).toBe(`binary ${NEW} linux-x64`);
  await served.close();
  // Someone copies another binary over B's: the next request finds it, and B says so.
  await writeFile(b.files.exec, `binary ${NEW} linux-x64, but not the one`);
  expect(await b.updater!.binaryFor(NEW, "linux-x64", sha)).toBeNull();
  await settle(pool);
  expect(own(pool, B)?.binaryChanged).toBe(true);
  const seen = pool.nodes.get(A)!.updater!.snapshot().nodes.find((n) => n.node === B)!;
  expect(seen.binary).toBe("binary on disk changed since start");
  // Without a request, a node finds it at its next look; a file it cannot read (gone, for now), or one rewritten with
  // the same bytes, is no change.
  await rm(c.files.exec);
  pool.now += BINARY_CHECK_MS;
  await settle(pool);
  expect(own(pool, C)?.binaryChanged).toBeUndefined();
  await writeFile(c.files.exec, `binary ${NEW} linux-x64`);
  pool.now += BINARY_CHECK_MS;
  await settle(pool);
  expect(own(pool, C)?.binaryChanged).toBeUndefined();
  await writeFile(c.files.exec, "something else");
  await settle(pool);
  expect(own(pool, C)?.binaryChanged).toBeUndefined();
  pool.now += BINARY_CHECK_MS;
  await settle(pool);
  expect(own(pool, C)?.binaryChanged).toBe(true);
  // A swap's own rename is not a change: the nodes that swapped report no such thing.
  expect(own(pool, A)?.binaryChanged).toBeUndefined();
});

test("a node whose binary differs from its build's is behind the pool and catches up; with no rollout to say, both nodes are flagged", async () => {
  const pool = await poolOf(A, B);
  await pool.nodes.get(A)!.updater!.startRollout({ binaries: [await pool.binary("linux-x64")], force: false });
  await settle(pool);
  await restartDown(pool);
  // B starts again on another binary that says it is the pool's build: it is behind, and updates to the pool's binary.
  const b = pool.nodes.get(B)!;
  await pool.down(b);
  await b.going;
  await writeFile(b.files.exec, `binary ${NEW} linux-x64 (built again)`);
  await restartDown(pool);
  expect(b.swaps.at(-1)).toMatchObject({ build: NEW, late: true });
  await restartDown(pool);
  expect(await readFile(b.files.exec, "utf8")).toBe(`binary ${NEW} linux-x64`);
  expect(pool.nodes.get(A)!.updater!.snapshot().nodes.find((n) => n.node === B)).toMatchObject({ mismatched: false, binary: null });

  // No rollout yet: two nodes on one build and platform with different binaries are both flagged, and not held.
  const pool2 = await poolOf(A, B);
  const b2 = pool2.nodes.get(B)!;
  await pool2.down(b2);
  await b2.going;
  await writeFile(b2.files.exec, `binary ${OLD} linux-x64 (patched)`);
  await restartDown(pool2);
  const snap = pool2.nodes.get(A)!.updater!.snapshot();
  for (const id of [A, B]) expect(snap.nodes.find((n) => n.node === id)?.binary).toBe(`binary differs from another node's of build ${OLD}`);
  expect(b2.holds).toEqual({ turns: null, work: null, hosting: null });
  // A rollout of that very build takes along only the node whose binary is not the rollout's.
  const started = await pool2.nodes.get(A)!.updater!.startRollout({ binaries: [await pool2.binary("linux-x64", OLD)], force: false });
  expect(started.participants).toEqual([B]);
  await settle(pool2);
  await restartDown(pool2);
  expect(rolloutOf(pool2, A).outcome?.status).toBe("confirmed");
  expect(pool2.nodes.get(A)!.updater!.snapshot().nodes.map((n) => n.binary)).toEqual([null, null]);
});

test("meddle update with the pool's own build updates just the nodes behind it; with none, it is refused", async () => {
  const pool = await poolOf(A);
  const a = pool.nodes.get(A)!;
  await a.updater!.startRollout({ binaries: [await pool.binary("linux-x64")], force: false });
  await settle(pool);
  await restartDown(pool);
  // B joins on the old build, and its late update fails for its machine's reasons.
  const b = await pool.addNode(B);
  b.preflightError = "no space left on device";
  await settle(pool);
  expect(own(pool, B)).toMatchObject({ state: "failed", late: true });

  // Rolled out again, the pool's build takes along only B; still failing, it fails the rollout, and only B was in it.
  const x64 = await pool.binary("linux-x64");
  b.preflightError = "still no space";
  const again = await a.updater!.startRollout({ binaries: [x64], force: false });
  expect(again.participants).toEqual([B]);
  await settle(pool);
  expect(rolloutOf(pool, A).outcome).toMatchObject({ status: "failed", node: B, reason: "preflight failed: still no space" });
  expect(a.swaps.length).toBe(1);
  expect(a.holds).toEqual({ turns: null, work: null, hosting: null });
  expect(poolBuild(a.updater!.view())).toBe(NEW);
  // Space freed: B does not try again on its own in this start; `meddle update` once more, and it is updated. A,
  // already on the build, only judges.
  b.preflightError = null;
  await settle(pool);
  expect(b.swaps).toEqual([]);
  expect(b.holds?.hosting).toContain("its update failed: preflight failed: still no space");
  await a.updater!.startRollout({ binaries: [x64], force: false });
  await settle(pool);
  await restartDown(pool);
  expect(rolloutOf(pool, A).outcome?.status).toBe("confirmed");
  expect(b.build).toBe(NEW);
  expect(a.swaps.length).toBe(1);
  expect(a.restarts).toBe(0);
  expect(b.holds).toEqual({ turns: null, work: null, hosting: null });
  // Nobody behind: refused.
  await expect(a.updater!.startRollout({ binaries: [x64], force: false })).rejects.toThrow(`the pool already runs build ${NEW}, and no node needs it`);
});

test("a failed rollout of the pool's own build, built again, leaves the pool's binary the one to have: no red dots, no swapping round", async () => {
  const pool = await poolOf(A, B);
  const a = pool.nodes.get(A)!;
  const b = pool.nodes.get(B)!;
  await a.updater!.startRollout({ binaries: [await pool.binary("linux-x64")], force: false });
  await settle(pool);
  await restartDown(pool);
  expect(rolloutOf(pool, A).outcome?.status).toBe("confirmed");
  // The same build, built again with other bytes: every node runs another binary, so every node takes part.
  b.busy = ["t1"];
  b.preflightError = "exec format error";
  const again = await a.updater!.startRollout({ binaries: [await pool.binary("linux-x64", NEW, " (built again)")], force: false });
  expect(again.participants).toEqual([A, B]);
  // While it is open, nobody is behind the pool or flagged: the pool's binary is still the confirmed one.
  for (const n of a.updater!.snapshot().nodes) expect(n).toMatchObject({ mismatched: false, binary: null });
  await settle(pool);
  expect(rolloutOf(pool, A).outcome).toMatchObject({ status: "failed", node: B });
  // Failed: each runs the pool's binary, and nobody updates to it again.
  pool.now += MIN;
  await settle(pool, 16);
  expect(a.swaps.length).toBe(1);
  expect(b.swaps.length).toBe(1);
  for (const n of a.updater!.snapshot().nodes) expect(n).toMatchObject({ mismatched: false, binary: null });

  // The same, from the view alone: the newest rollout of a build, failed, does not say what its binary is.
  const view = a.updater!.view();
  const rec = view.nodes[A]!;
  expect(behindPool(view, rec.build, rec.platform, rec.sha256)).toBe(false);
  expect(binaryProblem(view, rec)).toBeNull();
});

test("a node behind the pool whose new binary keeps crashing in a rollout is rolled back, and does not try again at that start", async () => {
  const pool = await poolOf(A);
  const a = pool.nodes.get(A)!;
  await a.updater!.startRollout({ binaries: [await pool.binary("linux-x64")], force: false });
  await settle(pool);
  await restartDown(pool);
  const b = await pool.addNode(B);
  b.preflightError = "no space";
  await settle(pool);
  expect(own(pool, B)).toMatchObject({ state: "failed", late: true });
  // Taken along by `meddle update` with the pool's build: it swaps, and its new binary keeps crashing.
  b.preflightError = null;
  await a.updater!.startRollout({ binaries: [await pool.binary("linux-x64")], force: false });
  await settle(pool);
  expect(b.swaps.length).toBe(1);
  for (let i = 0; i < 3; i++) await runGuard(b.files, pool.now, () => "");
  await restartDown(pool);
  expect(b.build).toBe(OLD);
  expect(own(pool, B)).toMatchObject({ state: "failed", late: false });
  expect(rolloutOf(pool, A).outcome).toMatchObject({ status: "failed", node: B });
  // Its failure belongs to the start its rollback caused: no late update now.
  await settle(pool, 16);
  expect(b.swaps.length).toBe(1);
  expect(b.holds?.hosting).toContain("its update failed");
  expect(a.swaps.length).toBe(1);
});

test("meddle update refuses an online node whose OTA version this build cannot drive, naming it", async () => {
  const pool = await poolOf(A, B);
  const a = pool.nodes.get(A)!.updater!;
  // Every record says which OTA version its node speaks.
  expect(own(pool, A)?.ota).toBe(OTA_V);
  expect(a.view().nodes[B]?.ota).toBe(OTA_V);
  const x64 = await pool.binary("linux-x64");
  const told = (rec: Partial<NodeUpdate>) => {
    const theirs = { ...a.view().nodes[B]!, rev: pool.now * 2, ...rec };
    if (rec.ota === undefined) delete theirs.ota;
    a.received(B, { v: 1, rollouts: [], nodes: [theirs] });
  };
  told({ ota: 99 });
  await expect(a.startRollout({ binaries: [x64], force: false })).rejects.toThrow(`b speaks OTA version 99, which this build cannot drive (it drives ${OTA_DRIVES.join(", ")})`);
  told({ rev: pool.now * 3, ota: undefined });
  await expect(a.startRollout({ binaries: [x64], force: false })).rejects.toThrow("b speaks OTA version unknown, which this build cannot drive");
  expect(a.view().rollouts).toEqual([]);
  // A node already on the build's binary is not driven: its OTA version does not matter.
  told({ rev: pool.now * 4, ota: 99, build: NEW, sha256: x64.sha256 });
  expect((await a.startRollout({ binaries: [x64], force: false })).participants).toEqual([A]);
});

test("a fetch fails the node when its source sent a wrong binary or its own disk failed, and waits when no member has it", async () => {
  // A wrong binary from every member that answered: the failure, with why.
  const pool = await poolOf(A, B);
  pool.nodes.get(B)!.fetchError = new BadBinary("a sent more than 23 bytes");
  await pool.nodes.get(A)!.updater!.startRollout({ binaries: [await pool.binary("linux-x64")], force: false });
  await settle(pool);
  expect(rolloutOf(pool, A).outcome).toMatchObject({
    status: "failed", node: B, reason: `no member sent the linux-x64 binary of build ${NEW}: a sent more than 23 bytes`,
  });

  // This node's own disk: the failure at once.
  const pool2 = await poolOf(A, B);
  pool2.nodes.get(B)!.fetchError = Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
  await pool2.nodes.get(A)!.updater!.startRollout({ binaries: [await pool2.binary("linux-x64")], force: false });
  await settle(pool2);
  expect(rolloutOf(pool2, A).outcome).toMatchObject({
    status: "failed", node: B, reason: "could not keep the binary here: ENOSPC: no space left on device, write",
  });

  // Nobody has it (yet): not a failure; the node looks again later.
  const pool3 = await poolOf(A, B);
  pool3.nodes.get(B)!.fetchError = new Unavailable("a: the stream was reset");
  await pool3.nodes.get(A)!.updater!.startRollout({ binaries: [await pool3.binary("linux-x64")], force: false });
  await settle(pool3);
  expect(rolloutOf(pool3, A).outcome).toBeNull();
  expect(own(pool3, B)).toMatchObject({ state: "idle", step: "waiting for a member with the binary" });
  pool3.nodes.get(B)!.fetchError = null;
  pool3.now += 31_000;
  await settle(pool3);
  expect(pool3.nodes.get(B)!.swaps.length).toBe(1);
});

test("a node without the disk space for the binary and the database copy fails its update before it fetches anything", async () => {
  const pool = await poolOf(A, B);
  const rollout: Rollout = {
    v: 1, id: "r-huge", build: NEW, binaries: [{ platform: "linux-x64", sha256: "e".repeat(64), size: 2 ** 52 }], startedBy: B,
    startedAt: new Date(pool.now).toISOString(), mode: "queued", participants: [A], deadline: new Date(pool.now + 30 * MIN).toISOString(),
    healthMs: 2 * MIN, outcome: null,
  };
  pool.nodes.get(A)!.updater!.received(B, { v: 1, rollouts: [rollout], nodes: [] });
  await settle(pool);
  expect(own(pool, A)?.state).toBe("failed");
  expect(own(pool, A)?.reason).toMatch(/^not enough disk space in .*: the update needs \d+ MB, \d+ MB is free$/);
  expect(pool.nodes.get(A)!.fetches).toEqual([]);
});

test("settling a swap: what a start does about every state a swap can leave", async () => {
  const pool = await poolOf(A);
  const a = pool.nodes.get(A)!;
  await pool.down(a);
  const plan = { rollout: "r1", build: NEW, previousBuild: OLD, platform: "linux-x64", healthMs: 2 * MIN, late: false };
  const swap = async () => {
    await writeFile(a.files.staged, `binary ${NEW} linux-x64`);
    await performSwap(a.files, plan, () => pool.now);
  };
  const settleAs = (running: string | null) => settleSwap(a.files, { running, now: pool.now, logLines: () => "" });
  const left = () => [a.files.pending, a.files.previous, a.files.backup, a.files.staged].filter((f) => existsSync(f));

  // Nothing pending.
  expect(await settleAs(OLD)).toEqual({ action: "none", text: "no update pending", restart: false });

  // The new build, swapped in and not yet healthy: it runs; `serve` does not count its start, the guard does.
  await swap();
  expect(await settleAs(NEW)).toMatchObject({ action: "run", restart: false });
  expect((await readPending(a.files))?.starts).toBe(0);
  expect(await settleAs(null)).toMatchObject({ action: "run", text: `build ${NEW} start 1 of 3` });

  // Another build running than the one swapped in: rolled back, and that binary must start again.
  expect(await settleAs("0ther0ther00")).toEqual({ action: "rollback", text: `rolled back to build ${OLD}: build 0ther0ther00 was running after the swap to ${NEW}`, restart: true });
  expect(await readFile(a.files.exec, "utf8")).toBe(`binary ${OLD} linux-x64`);
  expect(left()).toEqual([]);

  // A stray `.previous` with no `pending.json` (a swap writes that first, and removes it last): no swap; nothing touched.
  await writeFile(a.files.previous, "a stray binary");
  await writeFile(join(a.files.dir, "..", "meddle.sqlite"), "live");
  expect(await settleAs(OLD)).toEqual({ action: "none", text: `no update pending (${a.files.previous} left alone)`, restart: false });
  expect(await settleAs(null)).toMatchObject({ action: "none" });
  expect(await a.dbText()).toBe("live");
  expect(existsSync(join(a.files.dir, "..", "durable.sqlite"))).toBe(true);
  expect(await readFile(a.files.exec, "utf8")).toBe(`binary ${OLD} linux-x64`);
  expect(await readFile(a.files.previous, "utf8")).toBe("a stray binary");
  await rm(a.files.previous);

  // A rollback whose backup is gone puts the binary back, and never touches a database it has no copy of.
  await swap();
  await rm(a.files.backup, { recursive: true });
  await writeFile(join(a.files.dir, "..", "meddle.sqlite"), "written by the new build");
  const asked = (await readPending(a.files))!;
  await writePending(a.files, { ...asked, phase: "rollback", failed: true, reason: "crashed" });
  expect(await settleAs(null)).toMatchObject({ action: "rollback", restart: true });
  expect(await readFile(a.files.exec, "utf8")).toBe(`binary ${OLD} linux-x64`);
  expect(await a.dbText()).toBe("written by the new build");
  expect(left()).toEqual([]);

  // Settled from the binary the swap replaced, whichever binary starts next (a unit installed from elsewhere meanwhile).
  await writeFile(join(a.files.dir, "..", "meddle.sqlite"), "db before");
  await swap();
  await writeFile(join(a.files.dir, "..", "meddle.sqlite"), "written by the new build");
  const elsewhere = updateFiles(join(a.files.dir, ".."), join(a.files.dir, "..", "elsewhere", "meddle"));
  expect(await settleSwap(elsewhere, { running: "0ther0ther00", now: pool.now, logLines: () => "" })).toMatchObject({ action: "rollback" });
  expect(await readFile(a.files.exec, "utf8")).toBe(`binary ${OLD} linux-x64`);
  expect(await a.dbText()).toBe("db before");
  expect(left()).toEqual([]);

  // Confirmed, then down before its leftovers went (`.previous` goes first): the new build runs, the rest is cleared.
  await swap();
  const p = (await readPending(a.files))!;
  await rm(a.files.previous);
  expect(await settleAs(NEW)).toEqual({ action: "none", text: `build ${NEW} confirmed`, restart: false });
  expect(await readFile(a.files.exec, "utf8")).toBe(`binary ${NEW} linux-x64`);
  expect(left()).toEqual([]);

  // Asked to roll back because the pool's rollout failed elsewhere: not this node's failure.
  await writeFile(a.files.exec, `binary ${OLD} linux-x64`);
  await swap();
  await writeFile(a.files.pending, JSON.stringify({ ...p, phase: "rollback", failed: false, reason: "the rollout failed: b crashed" }));
  expect(await runGuard(a.files, pool.now, () => "never read")).toBe(`rolled back to build ${OLD}: the rollout failed: b crashed`);
  expect((await readState(a.files)).view.nodes[A]).toMatchObject({ state: "idle", reason: "the rollout failed: b crashed", build: OLD });
  expect(left()).toEqual([]);
});

test("a rollback that crashes part way is finished by the next start, the database restored once and the reason kept", async () => {
  const pool = await poolOf(A);
  const a = pool.nodes.get(A)!;
  const plan = { rollout: "r1", build: NEW, previousBuild: OLD, platform: "linux-x64", healthMs: 2 * MIN, late: false };
  await pool.down(a);
  await writeFile(a.files.staged, `binary ${NEW} linux-x64`);
  await performSwap(a.files, plan, () => pool.now);
  const p = (await readPending(a.files))!;
  // The new build ran and wrote; then the rollback recorded why, restored the databases and put the old binary back,
  // and went down before it recorded the node's state or cleared anything.
  await writeFile(join(a.files.dir, "..", "meddle.sqlite"), "written by the new build");
  await writeFile(a.files.pending, JSON.stringify({ ...p, phase: "rollback", failed: true, reason: "serve failed: no database" }));
  await writeFile(join(a.files.dir, "..", "meddle.sqlite"), "db before");
  await rename(a.files.previous, a.files.exec);
  await writeFile(join(a.files.dir, "..", "meddle.sqlite"), "written by the old build since");
  // No `.previous`, so the unit runs no guard: `serve` (the old build) finishes it, and leaves the database alone.
  await pool.boot(a);
  await settle(pool);
  expect(a.build).toBe(OLD);
  expect(await a.dbText()).toBe("written by the old build since");
  expect(own(pool, A)).toMatchObject({ state: "failed", reason: "serve failed: no database" });
  expect([a.files.pending, a.files.backup].filter((f) => existsSync(f))).toEqual([]);

  // Down before it put the old binary back: `.previous` is still there, so the guard does it all again.
  await pool.down(a);
  await writeFile(a.files.staged, `binary ${NEW} linux-x64`);
  await performSwap(a.files, plan, () => pool.now);
  await writeFile(join(a.files.dir, "..", "meddle.sqlite"), "written by the new build");
  await writeFile(a.files.pending, JSON.stringify({ ...(await readPending(a.files))!, phase: "rollback", failed: true, reason: "crashed" }));
  await rm(join(a.files.dir, "..", "meddle.sqlite"));
  await pool.boot(a);
  await settle(pool);
  expect(a.build).toBe(OLD);
  expect(await a.dbText()).toBe("written by the old build since");
  expect(own(pool, A)).toMatchObject({ state: "failed", reason: "crashed" });
});

test("a new build past its health deadline exits for the guard, unless it is healthy by then; the guard then rolls it back", async () => {
  const dir = await mkdtemp(join(tmpdir(), "meddle-health-"));
  dirs.push(dir);
  const files = updateFiles(dir, join(dir, "meddle"));
  const p = {
    v: 1, phase: "swapped" as const, rollout: "r1", build: NEW, previousBuild: OLD, platform: "linux-x64", healthMs: 2 * MIN, starts: 1,
    healthy: false, late: false,
  };
  // Due 50 ms from now (the deadline, and the second it waits past it).
  const due = { ...p, swappedAt: Date.now() - 2 * MIN - 1000 + 50 };
  let exits = 0;
  await writePending(files, due);
  watchHealth(files, due, () => exits++);
  await Bun.sleep(150);
  expect(exits).toBe(1);
  // Healthy by then: it stays.
  await writePending(files, { ...due, healthy: true });
  watchHealth(files, due, () => exits++);
  await Bun.sleep(150);
  expect(exits).toBe(1);
  // Already healthy at the start: nothing to watch.
  watchHealth(files, { ...due, healthy: true }, () => exits++)();
  // In the pool: a lone node whose new build never finishes starting is rolled back once the process has exited.
  const pool = await poolOf(A);
  await pool.nodes.get(A)!.updater!.startRollout({ binaries: [await pool.binary("linux-x64")], force: false });
  await settle(pool);
  await restartDown(pool, false);
  pool.now += 2 * MIN + 1000;
  await settle(pool);
  expect(pool.nodes.get(A)!.restarts).toBe(0);
  await pool.down(pool.nodes.get(A)!);
  await restartDown(pool);
  expect(pool.nodes.get(A)!.build).toBe(OLD);
  expect(rolloutOf(pool, A).outcome).toMatchObject({ status: "failed", node: A, reason: "not healthy within 120s of the swap" });
});

test("durations", () => {
  expect(parseDuration("30m")).toBe(30 * MIN);
  expect(parseDuration("90s")).toBe(90_000);
  expect(parseDuration("1h")).toBe(60 * MIN);
  expect(parseDuration("30")).toBeNull();
  expect(parseDuration("0m")).toBeNull();
});

/** Two nodes' channel ends over in-memory streams, as the pool's net hands streams to its listeners. */
function channelNets(ids: string[]): Map<string, ChannelNet> {
  const listeners = new Map<string, Set<(s: PeerStream) => boolean>>(ids.map((id) => [id, new Set()]));
  const nets = new Map<string, ChannelNet>();
  for (const self of ids) {
    nets.set(self, {
      async openStream(peerId, header) {
        const [mine, theirs] = loopbackPair();
        const closed = new Promise<string>(() => {});
        for (const cb of listeners.get(peerId)!) {
          if (cb({ peerId: self, header, stream: theirs, reader: new StreamReader(theirs.recv), closed })) break;
        }
        return { peerId, header, stream: mine, reader: new StreamReader(mine.recv), closed };
      },
      onStream(cb) {
        listeners.get(self)!.add(cb);
        return () => listeners.get(self)!.delete(cb);
      },
    });
  }
  return nets;
}

test("the channel exchanges views and streams a binary in pieces, checked against its hash", async () => {
  const nets = channelNets([A, B]);
  const dir = await mkdtemp(join(tmpdir(), "meddle-channel-"));
  dirs.push(dir);
  // Bigger than a frame would allow in one piece is not needed here; several send chunks are.
  const bytes = new Uint8Array(1_000_003).map((_, i) => (i * 7) % 251);
  await writeFile(join(dir, "served"), bytes);
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  let viewB: RolloutView = { rollouts: [], nodes: {} };
  const record = { v: 1, node: B, rev: 1, build: OLD, platform: "linux-arm64", state: "idle", reason: null, at: "2026-11-13T10:00:00.000Z", rollout: null } as NodeUpdate;
  viewB.nodes[B] = record;
  acceptRolloutStreams(nets.get(B)!, {
    isMember: (id) => id === A,
    received: (_from, msg) => (viewB = mergeView(viewB, msg, B).view),
    binaryFor: async (build, platform) => (build === NEW && platform === "linux-arm64" ? open(join(dir, "served"), "r") : null),
  });
  const aView: RolloutView = { rollouts: [], nodes: { [A]: { ...record, node: A, platform: "linux-x64" } } };
  const answer = await exchange(nets.get(A)!, B, aView);
  expect(answer?.nodes.map((n) => n.node).sort()).toEqual([A, B]);
  expect(viewB.nodes[A]?.platform).toBe("linux-x64");

  const want = { build: NEW, platform: "linux-arm64", sha256, size: bytes.length };
  await fetchBinary(nets.get(A)!, B, want, join(dir, "fetched"));
  expect(new Uint8Array(await readFile(join(dir, "fetched")))).toEqual(bytes);
  await expect(fetchBinary(nets.get(A)!, B, { ...want, sha256: "0".repeat(64) }, join(dir, "bad"))).rejects.toThrow("has SHA-256");
  expect(existsSync(join(dir, "bad"))).toBe(false);
  expect(existsSync(join(dir, "bad.part"))).toBe(false);
  await expect(fetchBinary(nets.get(A)!, B, { ...want, platform: "linux-x64" }, join(dir, "none"))).rejects.toThrow("does not have it");
});

test("a fetch says whose the fault is: the peer's (it lacks it, sent too little, stalled), its binary's, or this node's disk", async () => {
  const nets = channelNets([A, B]);
  const dir = await mkdtemp(join(tmpdir(), "meddle-fetch-"));
  dirs.push(dir);
  const bytes = new TextEncoder().encode("the right binary");
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const want = { build: NEW, platform: "linux-x64", sha256, size: bytes.length };
  /** What B answers next: the size it claims, and the bytes it sends (then it finishes, unless it stalls). */
  let answer: { size: number; body: Uint8Array; stall?: boolean } = { size: bytes.length, body: bytes };
  nets.get(B)!.onStream((s) => {
    void (async () => {
      await writeLine(s.stream.send, JSON.stringify({ ok: true, size: answer.size }));
      await s.stream.send.writeAll(Array.from(answer.body));
      if (!answer.stall) await s.stream.send.finish();
    })();
    return true;
  });
  const fetch = (dest = join(dir, "got"), stallMs?: number) => fetchBinary(nets.get(A)!, B, want, dest, stallMs).then(() => null, (e: unknown) => e as Error);
  expect(await fetch()).toBeNull();
  expect(await readFile(join(dir, "got"), "utf8")).toBe("the right binary");
  expect((await stat(join(dir, "got"))).mode & 0o777).toBe(0o755);
  // A part an earlier fetch left (a crash) is no obstacle.
  await writeFile(join(dir, "again.part"), "a stale part");
  expect(await fetch(join(dir, "again"))).toBeNull();
  expect(await readFile(join(dir, "again"), "utf8")).toBe("the right binary");
  expect(existsSync(join(dir, "again.part"))).toBe(false);

  const cases: Array<[typeof answer, typeof Unavailable | typeof BadBinary, string]> = [
    [{ size: bytes.length, body: bytes.slice(0, 5) }, Unavailable, "ended at 5 of 16 bytes"],
    [{ size: bytes.length, body: new TextEncoder().encode("the right binary!") }, BadBinary, "sent more than 16 bytes"],
    [{ size: bytes.length, body: new TextEncoder().encode("the wrong binary") }, BadBinary, "has SHA-256"],
    [{ size: 99, body: bytes }, BadBinary, "has it at 99 bytes, not 16"],
  ];
  for (const [given, kind, says] of cases) {
    answer = given;
    const err = await fetch(join(dir, "bad"));
    expect(err).toBeInstanceOf(kind);
    expect(err?.message).toContain(says);
    expect(existsSync(join(dir, "bad"))).toBe(false);
    expect(existsSync(join(dir, "bad.part"))).toBe(false);
  }
  // Nothing more comes: given up after the stall time, the peer's fault.
  answer = { size: bytes.length, body: bytes.slice(0, 5), stall: true };
  const stalled = await fetch(join(dir, "stalled"), 100);
  expect(stalled).toBeInstanceOf(Unavailable);
  expect(stalled?.message).toContain("reading the binary (5 of 16 bytes) timed out");
  // This node cannot write where the binary goes: neither the peer's fault nor the binary's.
  answer = { size: bytes.length, body: bytes };
  const local = await fetch(join(dir, "no such dir", "got"));
  expect(local).not.toBeInstanceOf(Unavailable);
  expect(local).not.toBeInstanceOf(BadBinary);
  expect(local?.message).toContain("ENOENT");
});

test("a binary's build is read from the file without running it, past a stray sentinel and across read chunks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "meddle-mark-"));
  dirs.push(dir);
  const mark = buildMark({ buildId: NEW, platform: "linux-arm64" });
  const open = mark.slice(0, mark.indexOf("{"));
  // A stray opening sentinel first, then the mark straddling the 1 MiB read boundary.
  const head = Buffer.alloc(1024 * 1024 - 20, 0x41);
  const file = Buffer.concat([Buffer.from(`${open}not json@@end@@`), head, Buffer.from(mark), Buffer.alloc(5000, 0x42)]);
  await writeFile(join(dir, "meddle-linux-arm64"), file);
  const info = await readBinary(join(dir, "meddle-linux-arm64"));
  expect(info).toEqual({
    buildId: NEW, platform: "linux-arm64", size: file.length, sha256: new Bun.CryptoHasher("sha256").update(file).digest("hex"),
  });
  await writeFile(join(dir, "other"), "no mark here");
  await expect(readBinary(join(dir, "other"))).rejects.toThrow("is not a meddle binary");
  expect(() => buildMark({ buildId: CHECKOUT_BUILD, platform: "linux-x64" })).toThrow();
});

test("the unit's guard runs the previous binary when there is one, escaped for systemd; a checkout has none", () => {
  expect(guardLine("/home/u/.local/bin/meddle")).toBe(
    `ExecStartPre=-/bin/sh -c 'if [ -x "/home/u/.local/bin/meddle.previous" ]; then exec "/home/u/.local/bin/meddle.previous" update-guard; fi'`,
  );
  expect(guardLine("/opt/50%/meddle")).toContain('"/opt/50%%/meddle.previous"');
  expect(guardLine(null)).toStartWith("#");
  expect(guardLine(`/home/u/it's/meddle`)).toStartWith("#");
});

test("a node whose binary or unit cannot take an update says why", async () => {
  const dir = await mkdtemp(join(tmpdir(), "meddle-blocked-"));
  dirs.push(dir);
  const files = updateFiles(dir, join(dir, "meddle"));
  const build = { buildId: NEW, platform: "linux-x64" };
  expect(await updateBlocked({ buildId: CHECKOUT_BUILD, platform: "linux-x64" }, files, {}, join(dir, "unit"))).toBe("it runs from a checkout");
  expect(await updateBlocked(build, updateFiles(dir, "/proc/meddle"), { INVOCATION_ID: "x" }, join(dir, "unit"))).toContain("is not writable");
  expect(await updateBlocked(build, files, {}, join(dir, "unit"))).toContain("not run by systemd");
  expect(await updateBlocked(build, files, { INVOCATION_ID: "x" }, join(dir, "unit"))).toContain("run meddle service install again");
  // The unit must start this very binary, and guard it with this binary's `.previous`: not merely mention a guard.
  const unit = (exec: string, guarded: string) => writeFile(join(dir, "unit"), `[Service]\n${guardLine(guarded)}\nExecStart=${exec} serve\n`);
  await unit("/usr/local/bin/meddle", join(dir, "meddle"));
  expect(await updateBlocked(build, files, { INVOCATION_ID: "x" }, join(dir, "unit"))).toBe(`its service unit does not run ${join(dir, "meddle")}: run meddle service install again from it`);
  await unit(join(dir, "meddle"), "/usr/local/bin/meddle");
  expect(await updateBlocked(build, files, { INVOCATION_ID: "x" }, join(dir, "unit"))).toContain("no update guard for this binary");
  await unit(join(dir, "meddle"), join(dir, "meddle"));
  expect(await updateBlocked(build, files, { INVOCATION_ID: "x" }, join(dir, "unit"))).toBeNull();
  // A binary whose path the guard line cannot hold has none, whatever the unit says.
  const quoted = updateFiles(dir, join(dir, "it's", "meddle"));
  await mkdir(join(dir, "it's"));
  await unit(quoted.exec, quoted.exec);
  expect(await updateBlocked(build, quoted, { INVOCATION_ID: "x" }, join(dir, "unit"))).toContain("no update guard for this binary");
});

test("meddle update against a running node: reports, reads binaries' builds, and refuses what it cannot roll out", async () => {
  const dir = await mkdtemp("/tmp/meddle-update-cli-");
  dirs.push(dir);
  await mkdir(`${dir}/t`);
  const env = { HOME: dir, MEDDLE_DATA_DIR: `${dir}/d`, MEDDLE_TASK_ROOT: `${dir}/t`, ...POOL_ENV, MEDDLE_PORT: String(await closedPort()) };
  const bad = await meddle(["update", "--within", "soon"], env);
  expect(bad.code).toBe(2);
  expect(bad.stderr).toContain("--within takes a duration");
  const node = await startServe({ ...env, MEDDLE_PORT: "0" });
  const client = { ...env, MEDDLE_PORT: String(node.port) };
  try {
    const report = await meddle(["update"], client);
    expect(report.stderr).toBe("");
    expect(report.stdout).toContain("build checkout");
    expect(report.stdout).toContain("no rollout yet");
    await writeFile(`${dir}/junk`, "not a binary");
    const junk = await meddle(["update", `${dir}/junk`], client);
    expect(junk.code).toBe(1);
    expect(junk.stderr).toContain("is not a meddle binary");
    await writeFile(`${dir}/meddle-linux-x64`, `\0\0${buildMark({ buildId: NEW, platform: "linux-x64" })}\0`);
    // A pool of one node run from a checkout: nobody to update.
    const none = await meddle(["update", `${dir}/meddle-linux-x64`], client);
    expect(none.stderr).toContain("no online node can take it: each runs from a checkout");
    const force = await meddle(["update", "--force"], client);
    expect(force.stderr).toContain("no rollout is in progress to force");
  } finally {
    await node.stop();
  }
});
