// src/update/files.ts — an update's files, and the steps on them that must survive a crash or a power loss: the swap of
// the binary and the copy of the databases, the rollback of both, and the rule each start settles a swap by (the
// unit's guard before `serve`, and `serve` itself).
//
// In the data directory, under `update/`:
// - `state.json`: this node's view of the rollout channel (`RolloutView`), its id, and how many times it has started.
//   Not in `meddle.sqlite`, so that a rollback, which restores the database, never forgets the rollout or its failure.
// - `pending.json`: a swap in progress (`Pending`), from just before the databases are copied until the rollout is
//   confirmed or rolled back.
// - `backup/`: the copy of `meddle.sqlite` and `durable.sqlite` (and their WAL files) the swap took, as one pair.
// - `binaries/<build>/<platform>`: the binaries `meddle update` gave this node, served while their rollout is open.
// Next to the running binary: `<binary>.staged` (fetched, checked, waiting for the swap) and `<binary>.previous` (the
// binary before the swap, kept until the rollout is confirmed). A swap is settled only from `pending.json`, which is
// written (atomically) before anything else and removed after everything else: `.previous` without it is a stray file,
// left alone. `.previous` appears only once the backup is complete and on disk, and goes before `pending.json` does.
import { existsSync } from "node:fs";
import { copyFile, link, mkdir, open, readFile, rename, rm, stat, statfs } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { emptyView, OTA_V, parseNodeUpdate, parseRollout, ROLLOUT_V, type NodeUpdate, type RolloutView } from "./wire";

export type UpdateFiles = {
  dir: string;
  state: string;
  pending: string;
  backup: string;
  binaries: string;
  /** The databases a swap copies, as one pair. */
  dbs: string[];
  /** The running binary, and the files beside it. */
  exec: string;
  staged: string;
  stagedPart: string;
  previous: string;
};

/** Where an update's files are, for a node with data directory `dataDir` running the binary at `exec`. */
export function updateFiles(dataDir: string, exec: string): UpdateFiles {
  const dir = join(dataDir, "update");
  return {
    dir,
    state: join(dir, "state.json"),
    pending: join(dir, "pending.json"),
    backup: join(dir, "backup"),
    binaries: join(dir, "binaries"),
    dbs: [join(dataDir, "meddle.sqlite"), join(dataDir, "durable.sqlite")],
    exec,
    staged: `${exec}.staged`,
    stagedPart: `${exec}.staged.part`,
    previous: `${exec}.previous`,
  };
}

/** The stored binary of `build` for `platform`, which this node serves. */
export function storedBinary(files: UpdateFiles, build: string, platform: string): string {
  return join(files.binaries, build, platform);
}

function messageOf(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim();
}

/** Flushes a file, or a directory's entries (a rename or a new file in it), to disk. */
export async function syncPath(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Copies `from` to `to` and flushes the copy to disk. */
async function copySynced(from: string, to: string): Promise<void> {
  await copyFile(from, to);
  await syncPath(to);
}

/**
 * Writes `text` to `path` by way of a temporary file (its own, so that two writers never share one) and a rename, each
 * flushed to disk: a crash or a power loss leaves the old file or the new one, never an empty one.
 */
export async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${crypto.randomUUID()}.tmp`;
  const handle = await open(tmp, "w", 0o600);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, path);
  await syncPath(dirname(path));
}

/** What `state.json` holds: this node's id, its view of the channel, and how many times `serve` has started here. */
export type StoredState = { self: string | null; view: RolloutView; boots: number };

/** Reads `state.json`; an absent or unreadable one is an empty view (its records are checked as a peer's would be). */
export async function readState(files: UpdateFiles): Promise<StoredState> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(files.state, "utf8"));
  } catch {
    return { self: null, view: emptyView(), boots: 0 };
  }
  const r = (raw ?? {}) as { self?: unknown; rollouts?: unknown; nodes?: unknown; boots?: unknown };
  const view = emptyView();
  if (Array.isArray(r.rollouts)) view.rollouts = r.rollouts.map(parseRollout).filter((x) => x !== null);
  if (typeof r.nodes === "object" && r.nodes !== null) {
    for (const n of Object.values(r.nodes)) {
      const rec = parseNodeUpdate(n);
      if (rec !== null) view.nodes[rec.node] = rec;
    }
  }
  const boots = typeof r.boots === "number" && Number.isSafeInteger(r.boots) && r.boots >= 0 ? r.boots : 0;
  return { self: typeof r.self === "string" ? r.self : null, view, boots };
}

export async function writeState(files: UpdateFiles, state: StoredState): Promise<void> {
  await writeAtomic(files.state, JSON.stringify({ v: ROLLOUT_V, self: state.self, boots: state.boots, ...state.view }));
}

/**
 * A swap in progress. `swapping`: the databases are being copied and the binary moved (the node is down; a crash here
 * means the swap never finished); `swapped`: the new binary is in place, awaiting confirmation; `rollback`: the swap is
 * being undone (`reason`, `failed` when this node's own update failed rather than the pool's).
 */
export type Pending = {
  v: number;
  phase: "swapping" | "swapped" | "rollback";
  rollout: string;
  build: string;
  previousBuild: string;
  platform: string;
  /** When the new binary went into place (ms). */
  swappedAt: number;
  healthMs: number;
  /** How many times the new binary has been started (counted by the guard), since the swap or since it was healthy. */
  starts: number;
  /** The new binary reported healthy: the guard no longer judges it by the health deadline. */
  healthy: boolean;
  /** The update is the node's own (a late one): its failure rolls back only this node. */
  late: boolean;
  /**
   * The binary the swap replaced, whose `.previous` and `.staged` it made: the swap is settled there, whichever binary
   * starts next (one `meddle service install` put elsewhere meanwhile). Absent only in a record from before it was kept.
   */
  exec?: string;
  reason?: string;
  failed?: boolean;
};

export async function readPending(files: UpdateFiles): Promise<Pending | null> {
  try {
    const p = JSON.parse(await readFile(files.pending, "utf8")) as Pending;
    return typeof p === "object" && p !== null && typeof p.phase === "string" && typeof p.build === "string" ? p : null;
  } catch {
    return null;
  }
}

export async function writePending(files: UpdateFiles, p: Pending): Promise<void> {
  await writeAtomic(files.pending, JSON.stringify(p));
}

/** The database files that exist, with their WAL and shared-memory files. */
function dbFiles(db: string): string[] {
  return [db, `${db}-wal`, `${db}-shm`].filter((f) => existsSync(f));
}

/** What a swap needs to know beyond the files: what it records in `pending.json`. */
export type SwapPlan = Omit<Pending, "phase" | "starts" | "healthy" | "swappedAt" | "v" | "exec">;

/** The files of the swap `p` recorded: those of the binary it replaced, which may not be the one running now. */
export function swapFiles(files: UpdateFiles, p: Pending | null): UpdateFiles {
  return p?.exec === undefined || p.exec === files.exec ? files : updateFiles(dirname(files.dir), p.exec);
}

/**
 * Swaps the staged binary in, with the node stopped (its databases closed), each step on disk before the next: records
 * the swap, copies the databases into `backup/` as a pair, keeps the running binary as `<binary>.previous` (a hard
 * link: instant, and the same file), renames the staged binary over the running one (atomic: the path always holds a
 * whole binary), then records it swapped (its health deadline counts from `clock()` then). A crash at any point leaves
 * what the next start rolls back (`swapVerdict`). A step that fails is undone here, its error recorded as this node's
 * failure (so the rollout fails with the real reason), and the error rethrown.
 */
export async function performSwap(files: UpdateFiles, plan: SwapPlan, clock: () => number = Date.now, log: (line: string) => void = () => {}): Promise<void> {
  const pending: Pending = { ...plan, v: ROLLOUT_V, phase: "swapping", starts: 0, healthy: false, swappedAt: clock(), exec: files.exec };
  try {
    await writePending(files, pending);
    await rm(files.previous, { force: true });
    await rm(files.backup, { recursive: true, force: true });
    await mkdir(files.backup, { recursive: true, mode: 0o700 });
    for (const db of files.dbs) for (const f of dbFiles(db)) await copySynced(f, join(files.backup, basename(f)));
    await syncPath(files.backup);
    await syncPath(files.staged);
    // A hard link where the filesystem has them; else a copy, whole before it takes the name.
    await link(files.exec, files.previous).catch(async () => {
      await copySynced(files.exec, `${files.previous}.part`);
      await rename(`${files.previous}.part`, files.previous);
    });
    await syncPath(dirname(files.exec));
    await rename(files.staged, files.exec);
    await syncPath(dirname(files.exec));
    await writePending(files, { ...pending, phase: "swapped", swappedAt: clock() });
  } catch (err) {
    await rollBack(files, pending, { failed: true, reason: `the swap failed: ${messageOf(err)}` }, log).catch((undo: unknown) => {
      log(`meddle: update: undoing the failed swap failed: ${messageOf(undo)}`);
    });
    throw err;
  }
}

/**
 * Undoes swap `p`, in an order a crash at any point resumes from: the reason goes into `pending.json` first; while
 * `.previous` is there, each database whose copy is in the backup comes back from it (complete, since `.previous` is;
 * a database with no copy is never touched) and then the previous binary goes back over the new one (the rename ends
 * the marker). The backup goes before anything else is written, so that a full disk does not stop the rest, and this
 * node's own record in `state.json` says what happened (`failed` with `reason` when its own update failed, else `idle`
 * on the previous build); a record that cannot be written is logged, not fatal.
 */
export async function rollBack(files: UpdateFiles, p: Pending, outcome: { failed: boolean; reason: string }, log: (line: string) => void = () => {}): Promise<void> {
  if (p.phase !== "rollback") {
    await writePending(files, { ...p, phase: "rollback", failed: outcome.failed, reason: outcome.reason }).catch(() => {});
  }
  if (existsSync(files.previous)) {
    for (const db of files.dbs) {
      if (!existsSync(join(files.backup, basename(db)))) continue;
      for (const f of [db, `${db}-wal`, `${db}-shm`]) await rm(f, { force: true });
      for (const f of [db, `${db}-wal`, `${db}-shm`]) {
        const saved = join(files.backup, basename(f));
        if (existsSync(saved)) await copySynced(saved, f);
      }
    }
    await syncPath(dirname(files.dbs[0]!));
    await rename(files.previous, files.exec);
    await syncPath(dirname(files.exec));
  }
  await rm(files.backup, { recursive: true, force: true });
  await recordOwn(files, p, outcome).catch((err: unknown) => log(`meddle: update: recording the rollback failed: ${messageOf(err)}`));
  await clearSwap(files);
}

/**
 * Drops what a swap leaves once it is over (confirmed or rolled back): `.previous` first, on disk (on confirmation, the
 * moment the swap is settled), then the backup, the staged binaries, and last the record.
 */
export async function clearSwap(files: UpdateFiles): Promise<void> {
  await rm(files.previous, { force: true });
  await syncPath(dirname(files.exec)).catch(() => {});
  await rm(files.backup, { recursive: true, force: true });
  await rm(files.staged, { force: true });
  await rm(files.stagedPart, { force: true });
  await rm(files.pending, { force: true });
}

/**
 * Writes this node's own record in `state.json` after a rollback, its `rev` above the last one. A failure records the
 * start it belongs to (`failedBoot`): the next one, which the rollback causes, so that a node behind the pool tries
 * again only at the one after.
 */
async function recordOwn(files: UpdateFiles, p: Pending, outcome: { failed: boolean; reason: string }): Promise<void> {
  const state = await readState(files);
  if (state.self === null) return;
  const prev = state.view.nodes[state.self];
  const rec: NodeUpdate = {
    ...(prev ?? {}),
    v: ROLLOUT_V,
    node: state.self,
    rev: Math.max(Date.now(), (prev?.rev ?? 0) + 1),
    build: p.previousBuild,
    platform: p.platform,
    // The guard is the previous binary, whose OTA version this is; its `serve` writes it again if not, and its hash.
    ota: OTA_V,
    sha256: undefined,
    binaryChanged: undefined,
    state: outcome.failed ? "failed" : "idle",
    reason: outcome.reason,
    at: new Date().toISOString(),
    rollout: p.rollout,
    step: null,
    drained: false,
    waitingOn: [],
    late: p.late,
    ...(outcome.failed ? { failedBoot: state.boots + 1 } : {}),
  };
  state.view.nodes[state.self] = rec;
  await writeState(files, state);
}

/** How many starts the new binary gets before the guard counts it as crashing and rolls it back. */
export const MAX_STARTS = 3;

/** The last lines of the service's log, for a failure's reason; "" when there is no journal to ask. */
export function lastLogLines(n = 12): string {
  try {
    const out = Bun.spawnSync(["journalctl", "--user", "-u", "meddle.service", "-n", String(n), "--no-pager", "-o", "cat"], {
      stdout: "pipe", stderr: "ignore", timeout: 3000,
    });
    return out.success ? out.stdout.toString().trim() : "";
  } catch {
    return "";
  }
}

export type SwapVerdict =
  | { action: "none" }
  | { action: "run"; pending: Pending }
  | { action: "rollback"; failed: boolean; reason: string };

/**
 * Which build should run now, from what swap `p` left (its `pending.json`) and whether `.previous` is there. `running`
 * is the build of the binary asking (`serve`'s), or null for the guard, which runs as the previous binary and does not
 * know the new one's; `counting` counts this start (the guard does).
 * - `none`: a confirmed swap whose leftovers are to be cleared (`.previous` already gone).
 * - `rollback`: a swap that did not finish, one asked to be rolled back, a new binary started more than `MAX_STARTS`
 *   times or not healthy by its deadline, or another build running than the one swapped in.
 * - `run`: the new build, awaiting confirmation (with the start counted).
 */
export function swapVerdict(p: Pending, previous: boolean, now: number, running: string | null, counting: boolean): SwapVerdict {
  if (p.phase === "rollback") return { action: "rollback", failed: p.failed === true, reason: p.reason ?? "rolled back" };
  if (p.phase === "swapping") return { action: "rollback", failed: true, reason: "the swap did not finish" };
  const other = { action: "rollback", failed: true, reason: `build ${running} was running after the swap to ${p.build}` } as const;
  if (!previous) return running === null || running === p.build ? { action: "none" } : other;
  if (running !== null && running !== p.build) return other;
  const starts = counting ? p.starts + 1 : p.starts;
  if (starts > MAX_STARTS) {
    return { action: "rollback", failed: true, reason: `the new build did not keep running: ${MAX_STARTS} starts failed` };
  }
  if (!p.healthy && now > p.swappedAt + p.healthMs) {
    return { action: "rollback", failed: true, reason: `not healthy within ${Math.round(p.healthMs / 1000)}s of the swap` };
  }
  return { action: "run", pending: { ...p, starts } };
}

/**
 * Settles a swap before a start, by `swapVerdict`: rolls it back (adding the service's last log lines to a new
 * binary's own failure), clears a confirmed one's leftovers, or counts the start; with no `pending.json`, there is no
 * swap (a stray `.previous` is only logged). It acts on the files of the binary the swap replaced (`swapFiles`). Run by
 * the guard (`meddle update-guard`, the unit's `ExecStartPre`, as the previous binary: `running` null, counting) and by
 * `serve` (its own build, not counting: for a guard that did not run). `restart`: the binary in place changed, so a
 * `serve` must exit for systemd to start it again. `text` says what it did, for the log.
 */
export async function settleSwap(
  running: UpdateFiles, opts: { running: string | null; now?: number; logLines?: () => string; log?: (line: string) => void },
): Promise<{ action: SwapVerdict["action"]; text: string; restart: boolean }> {
  const p = await readPending(running);
  if (p === null) {
    const stray = existsSync(running.previous);
    if (stray) opts.log?.(`meddle: update: ${running.previous} is there with no update pending; left alone`);
    return { action: "none", text: stray ? `no update pending (${running.previous} left alone)` : "no update pending", restart: false };
  }
  const files = swapFiles(running, p);
  const previous = existsSync(files.previous);
  const verdict = swapVerdict(p, previous, opts.now ?? Date.now(), opts.running, opts.running === null);
  if (verdict.action === "none") {
    await clearSwap(files);
    return { action: "none", text: `build ${p.build} confirmed`, restart: false };
  }
  if (verdict.action === "run") {
    if (opts.running === null) await writePending(files, verdict.pending);
    return { action: "run", text: `build ${verdict.pending.build} start ${verdict.pending.starts} of ${MAX_STARTS}`, restart: false };
  }
  const lines = verdict.failed && p.phase !== "rollback" ? (opts.logLines ?? lastLogLines)() : "";
  const reason = lines === "" ? verdict.reason : `${verdict.reason}; last log lines:\n${lines}`;
  await rollBack(files, p, { failed: verdict.failed, reason }, opts.log);
  return { action: "rollback", text: `rolled back to build ${p.previousBuild}: ${verdict.reason}`, restart: previous };
}

/** The guard's run (`meddle update-guard`): `settleSwap` as the previous binary, counting the start. */
export async function runGuard(files: UpdateFiles, now = Date.now(), logLines: () => string = lastLogLines): Promise<string> {
  return (await settleSwap(files, { running: null, now, logLines })).text;
}

/**
 * Why the disk cannot take what an update writes, or null: `needs` is how many bytes go into each directory, summed
 * per filesystem and compared with what it has free (less a margin for everything else the node writes).
 */
export async function spaceProblem(needs: { dir: string; bytes: number }[]): Promise<string | null> {
  const byDevice = new Map<number, { dir: string; bytes: number }>();
  for (const n of needs) {
    const dev = (await stat(n.dir)).dev;
    const seen = byDevice.get(dev);
    byDevice.set(dev, { dir: seen?.dir ?? n.dir, bytes: (seen?.bytes ?? 0) + n.bytes });
  }
  const mb = (bytes: number) => `${Math.ceil(bytes / 1024 / 1024)} MB`;
  for (const { dir, bytes } of byDevice.values()) {
    const fs = await statfs(dir);
    const free = fs.bavail * fs.bsize - SPACE_MARGIN;
    if (bytes > free) return `not enough disk space in ${dir}: the update needs ${mb(bytes)}, ${mb(Math.max(0, free))} is free`;
  }
  return null;
}

/** What a disk keeps free beyond an update's own files, for the node's other writes. */
const SPACE_MARGIN = 64 * 1024 * 1024;

/**
 * What a swap writes, by directory: the staged binary of `size` bytes beside the running one, and a copy of the running
 * one as `.previous` (where the filesystem has no hard links: counted always, to be safe), and the database copy.
 */
export async function swapNeeds(files: UpdateFiles, size: number): Promise<{ dir: string; bytes: number }[]> {
  let db = 0;
  for (const name of files.dbs) for (const f of dbFiles(name)) db += (await stat(f)).size;
  const exec = (await stat(files.exec).catch(() => null))?.size ?? 0;
  return [{ dir: dirname(files.exec), bytes: size + exec }, { dir: dirname(files.dbs[0]!), bytes: db }];
}

/**
 * Watches the health deadline of new build `p` from inside it: once the deadline has passed (and a second more, so
 * that the guard's verdict agrees), calls `exit` unless `pending.json` says by then that it is healthy, or settled.
 * However it hangs on its way to healthy (a database that does not open, a pool that never starts), the process then
 * exits for systemd to start it again, and the guard rolls it back. Returns the cancel.
 */
export function watchHealth(files: UpdateFiles, p: Pending, exit: () => void, now = Date.now()): () => void {
  if (p.healthy) return () => {};
  const timer = setTimeout(() => {
    void readPending(files).then((at) => {
      if (at?.phase === "swapped" && !at.healthy) exit();
    });
  }, Math.max(0, p.swappedAt + p.healthMs + 1000 - now));
  timer.unref?.();
  return () => clearTimeout(timer);
}
