// The sending side of moving a task to another node: the durable `meddle.move` (decisions 10, 11, 16, 18, 19).
import { existsSync } from "node:fs";
import { rename, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { isChordError, type Ref } from "@earendil-works/chord";
import { awaitWithContext, BACKGROUND_CONTEXT, withAbortSignal, type Context } from "@earendil-works/chord/context";
import { defineTask, type TaskRuntime } from "@earendil-works/pi-durable";
import type { NodeConfig } from "../config";
import { bookmarkForget } from "../jj";
import { ensurePrivateDir, paths } from "../paths";
import { shortId } from "../pool/ids";
import { listLineRows } from "../pool/rows";
import type { PeerStream } from "../pool/net";
import type { PoolRuntime } from "../pool/runtime";
import { PeerObject } from "../state/contracts";
import { clearTaskLog, getTask } from "../store/records";
import { repoKey, serialised } from "../serial";
import { claudeCodeVersion } from "../version";
import { readArchive, writeArchive } from "./archive";
import { runnerFor, type MeddleHooks, type TaskRunner } from "./durable";
import { taskGlob, type TaskManifest } from "./manifest";
import { dropWorkspace } from "./provision";
import { exportArchive, exportTask, receiptsMatch, type Receipt } from "./transfer";

/**
 * `fromArchive`: the task is archived here and is restored on `to` from its archive (a restore-move). A move stored by
 * an earlier meddle has none: read it as false.
 */
export type MoveInput = { taskId: string; to: string; now: boolean; fromArchive?: boolean };
/** `attempt` counts the times `commit` had no answer from the target (absent: none yet). */
export type MoveCheckpoint =
  | { phase: "prepare" }
  | { phase: "handoff" }
  | { phase: "commit"; receipt: Receipt; attempt?: number }
  | { phase: "cleanup" };
type MoveRuntime = TaskRuntime<MoveInput, MoveCheckpoint, null, MeddleHooks>;
type PeerRef = Extract<Ref<typeof PeerObject>, { variant: "peer" }>;

/** The first prompt on the target after a "move now" cut a turn short (decision 14). */
export const MOVE_NOW_FOLLOW_UP =
  "The previous turn was interrupted to move this task to another machine. Background shells and subagents that were running were stopped and did not travel. Carry on from where you were; do not redo work that is already done.";

/** How long a step waits for the target's connection to come up (right after a restart, it is still being made). */
const PEER_WAIT_MS = 10_000;
/** How long a call to the target may take before it counts as no answer. */
const CALL_MS = 30_000;
/** The first wait before `commit` asks an unanswering target again; it doubles up to `RETRY_MAX_MS`. */
const RETRY_FIRST_MS = 2_000;
const RETRY_MAX_MS = 30_000;
/**
 * How long a rollback's best-effort `abandonTask` may take: the target runs it after a `receiveTask` of the task still
 * in progress there (both are serialised per task), which may be cloning a project.
 */
const ABANDON_MS = 120_000;
/** How soon a commit whose bookkeeping failed after the target took the task tries again. */
const COMMIT_RETRY_MS = 5_000;

/** The memo that records that `prepare` interrupted a live turn, so `commit` sends the follow-up. */
const CUT_MEMO = "cut";

function messageOf(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim();
}

/** The Harness is closing or the move is being aborted: the step stops where it is, to run again or be aborted. */
function stopping(runtime: MoveRuntime, context: Context): boolean {
  return context.abortSignal?.aborted === true || runtime.signal.aborted;
}

/**
 * Moves a task to another node. `prepare` checks the move again (decision 16), marks the task `moving`, waits for its
 * turn to end (or interrupts it with `now`) and writes the task's lines as rows while this node still holds it
 * (`writeTaskLines`); `handoff` writes them once more, sends them to the target, which provisions the task from them
 * (`receiveTask`), sends the task over a `blob` stream and compares receipts; `commit` activates the task on the
 * target (which takes its lines' rows over, one epoch up) and records it here as `moved`; `cleanup` archives and
 * removes the local copy. A restore-move (`fromArchive`, spec 21.4, decision 8) moves a task archived here: no turn
 * to wait for, its lines' archived rows as they are, the archive sent instead of the live task, no follow-up, and the
 * archive kept as the leftover; one that fails leaves the task `archived` here again. A rollback from `commit` takes
 * the lines back two epochs up (`failMove`). A step before `commit` that fails rolls the move back itself (pi-durable
 * faults a throwing phase and runs `abort` only after an abort mark) and ends `failed`. Once the receipt is recorded,
 * only a definite answer from the target rolls back (`activateTask` answering `ok: false` or `forbidden`); without an
 * answer, `commit` keeps asking (2 s doubling to 30 s) while the task stays `moving`, and a restart asks again from the
 * checkpoint. `handoff` and `commit` go on only while the task's row
 * says `moving` (a rerun after a rollback whose end was lost rolls back again). `abort` rolls back unless the target
 * says it has the task, and ends `aborted`; the runner sends one for a move parked before the receipt, once it has
 * made the task live here again, and then `abort` only drops the target's copy.
 */
export const MeddleMove = defineTask<MoveInput, MoveCheckpoint, null, MeddleHooks>({
  name: "meddle.move",
  version: 1,
  initial: () => ({ phase: "prepare" }),
  phases: {
    prepare: (task, runtime, phaseContext) => step("prepare", task.input, runtime, phaseContext, async (runner, context) => {
      const { taskId, to, now } = task.input;
      const fromArchive = task.input.fromArchive ?? false;
      runner.checkMove(taskRow(runner, taskId), to, true, fromArchive);
      runner.enterMove(taskId, to, "prepare");
      await runner.moveDeps().hooks?.afterEnterMove?.(taskId, runtime.signal);
      // Remembered before the interrupt: a rerun after a crash still knows it cut the turn. An archived task has no turn.
      if (!fromArchive) {
        await runner.awaitTurnEnd(taskId, now, context, async () => { await runtime.memo(CUT_MEMO, true, context); });
        // The task's lines are written while this node still holds it: once the row says `moved`, it never writes.
        await runner.writeTaskLines(taskId);
      }
      await runtime.commit(() => ({ status: "running", checkpoint: { phase: "handoff" } }), context);
    }),
    handoff: (task, runtime, phaseContext) => step("handoff", task.input, runtime, phaseContext, async (runner, context) => {
      const { taskId, to } = task.input;
      const { cfg, db, pool } = runner.moveDeps();
      // A rerun after this move was rolled back here (its end never recorded) finds the task live again: it stops.
      runner.requireMoving(taskId);
      runner.enterMove(taskId, to, "handoff");
      const fromArchive = task.input.fromArchive ?? false;
      const manifest = JSON.parse(taskRow(runner, taskId).manifest) as TaskManifest;
      // A restore-move's task has no workspace: its lines' rows are as its archive left them.
      if (!fromArchive) {
        // Nothing is written or sent under a turn: one that is running here ends first.
        await runner.awaitTurnEnd(taskId, false, context, async () => {});
        await runner.writeTaskLines(taskId);
      }
      // The rows as this node last wrote them travel with the request: the target never starts from a stale one.
      const lineRows = listLineRows(db, undefined, taskId);
      // A rerun of this step finds its partial copy there: the target replaces it.
      // No time limit: the target may clone the project from its home first. A dropped link still fails it at once.
      const answer = await withPeer(
        pool, to, context, (peer) => peer.receiveTask({ manifest, claudeCodeVersion: claudeCodeVersion(), lineRows }), null,
      );
      if (!answer.ok) throw new Error(answer.reason ?? `${shortId(to)} refused the task`);
      const exporter: Exporter = fromArchive
        ? async (send) => exportArchive(cfg, await readArchive(paths(cfg).archiveFile(taskId)), send)
        : (send) => exportTask(cfg, db, taskId, send);
      const receipt = await sendTask(pool, to, taskId, context, exporter);
      await runtime.commit(() => ({ status: "running", checkpoint: { phase: "commit", receipt } }), context);
    }),
    commit: async (task, runtime, context) => {
      const runner = await runnerFor(runtime, context);
      const { taskId, to } = task.input;
      const checkpoint = task.state.checkpoint;
      const { db, pool, log, callMs } = runner.moveDeps();
      // A rerun after the task was recorded as moved: only the cleanup is left.
      if (getTask(db, taskId)?.state !== "moved") {
        // The receipt is recorded: from here on, only a definite answer from the target rolls the move back.
        // A rerun after this move was rolled back here (its end never recorded): the task is live here again, so the
        // target must not activate it; only the rollback's end is left.
        if (getTask(db, taskId)?.state !== "moving") {
          await rollback(runner, runtime, context, task.input, "commit", "task is no longer moving");
          return;
        }
        let refusal: string | null = null;
        try {
          runner.enterMove(taskId, to, "commit");
          // A restore-move's task had no turn to cut.
          const cut = !(task.input.fromArchive ?? false) && (await runtime.memo<boolean>(CUT_MEMO, context)) === true;
          // A repeated call (a retry, or a rerun after a crash) is a no-op `ok` for a task the target activated.
          const answer = await withPeer(
            pool, to, context, (peer) => peer.activateTask({ taskId, followUp: cut ? MOVE_NOW_FOLLOW_UP : null }), callMs ?? CALL_MS,
          );
          if (!answer.ok) refusal = `${shortId(to)} could not activate the task`;
        } catch (err) {
          if (stopping(runtime, context)) throw err;
          if (isChordError(err, "forbidden")) {
            // It has no copy of the task from this node to activate.
            refusal = messageOf(err);
          } else {
            // No answer (offline, a dropped link, a timeout): the target may have the task. The task stays moving, and
            // the step sleeps durably before asking again (a sleep is progress: crashes meanwhile never park the move).
            const attempt = (checkpoint.attempt ?? 0) + 1;
            log(`meddle: move: ${taskId} waits for ${shortId(to)} to activate it: ${messageOf(err)}`);
            const delay = Math.min(RETRY_FIRST_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
            await runtime.sleepUntil(Date.now() + delay, { phase: "commit", receipt: checkpoint.receipt, attempt }, context);
            return;
          }
        }
        if (refusal !== null) {
          await rollback(runner, runtime, context, task.input, "commit", refusal);
          return;
        }
        // The task is the target's now: nothing here rolls back any more.
        try {
          runner.completeMove(taskId, to);
        } catch (err) {
          log(`meddle: move: ${taskId} is on ${shortId(to)}, but could not be recorded as moved here: ${messageOf(err)}; trying again`);
          await runtime.sleepUntil(Date.now() + COMMIT_RETRY_MS, checkpoint, context);
          return;
        }
      }
      await runtime.commit(() => ({ status: "running", checkpoint: { phase: "cleanup" } }), context);
    },
    cleanup: async (task, runtime, context) => {
      const runner = await runnerFor(runtime, context);
      const { taskId, to } = task.input;
      const { cfg, db, log } = runner.moveDeps();
      try {
        if (task.input.fromArchive ?? false) await removeArchivedCopy(cfg, db, taskId);
        else await removeLocalCopy(cfg, db, taskId);
      } catch (err) {
        if (stopping(runtime, context)) throw err;
        // The task lives on the target; what is left here is only disk space.
        log(`meddle: move: ${taskId} moved to ${shortId(to)}, but its copy here was not removed: ${messageOf(err)}`);
      }
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
    },
  },
  abort: async (task, runtime, context) => {
    const runner = await runnerFor(runtime, context);
    const { taskId, to } = task.input;
    const { db, pool } = runner.moveDeps();
    const phase = task.state.checkpoint.phase;
    const row = getTask(db, taskId);
    if (row !== null && row.state !== "moved" && !runner.isMovingHere(taskId)) {
      // Released here already (a move parked before the receipt): only the target's partial copy is left to drop.
      if (phase !== "prepare") await abandonOnTarget(pool, to, taskId);
    } else if (row?.state !== "moved") {
      const where = phase === "prepare" ? "abandoned" : await abandonOnTarget(pool, to, taskId);
      if (phase === "commit" && where === "active") runner.completeMove(taskId, to);
      // Cancelled (`task move --cancel`): the task stays here, which is no failure.
      else await runner.failMove(taskId, to, phase, runner.takeCancel(taskId) ? null : "the move was aborted");
    }
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
  },
});

/**
 * Runs one step that may roll back: a failure (other than the Harness closing or an abort, which leave the step to run
 * again or to `abort`) abandons the target's copy, makes the task live here again, and ends the move `failed`. The
 * body's context aborts with the run too (`abortTask`, a cancel), so that a wait for the turn or for the target stops.
 */
async function step(
  phase: MoveCheckpoint["phase"],
  input: MoveInput,
  runtime: MoveRuntime,
  phaseContext: Context,
  body: (runner: TaskRunner, context: Context) => Promise<void>,
): Promise<void> {
  const signals = phaseContext.abortSignal ? [phaseContext.abortSignal, runtime.signal] : [runtime.signal];
  const context = withAbortSignal(AbortSignal.any(signals), phaseContext);
  const runner = await runnerFor(runtime, context);
  try {
    await body(runner, context);
  } catch (err) {
    if (stopping(runtime, context)) throw err;
    await rollback(runner, runtime, context, input, phase, messageOf(err));
  }
}

/**
 * Rolls a move back and ends it `failed`: the target drops its copy (best effort; before the handoff it was asked
 * nothing), the task is live here again. The terminal outcome is committed whatever happens before it.
 */
async function rollback(
  runner: TaskRunner, runtime: MoveRuntime, context: Context, input: MoveInput, phase: MoveCheckpoint["phase"], error: string,
): Promise<void> {
  try {
    if (phase !== "prepare") await abandonOnTarget(runner.moveDeps().pool, input.to, input.taskId);
    await runner.failMove(input.taskId, input.to, phase, error);
  } catch (err) {
    runner.moveDeps().log(`meddle: move: ${input.taskId}: the rollback did not finish: ${messageOf(err)}`);
  } finally {
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "failed", error: { message: error } } }), context);
  }
}

function taskRow(runner: TaskRunner, taskId: string) {
  const row = getTask(runner.moveDeps().db, taskId);
  if (row === null) throw new Error(`unknown task: ${taskId}`);
  return row;
}

/**
 * Calls the target's `PeerObject` through a Ref taken for this call (a reconnect replaces the client host) and released
 * after it; waits up to `PEER_WAIT_MS` for the connection to come up. A call that has not settled after `timeoutMs`
 * (connection wait included; null: no limit) rejects: a hung link counts as no answer.
 */
async function withPeer<T>(
  pool: PoolRuntime, to: string, outer: Context, call: (peer: PeerRef) => Promise<T>, timeoutMs: number | null,
): Promise<T> {
  const controller = new AbortController();
  const timer = timeoutMs === null
    ? undefined
    : setTimeout(() => controller.abort(new Error(`${shortId(to)} did not answer within ${timeoutMs / 1000} s`)), timeoutMs);
  const follow = () => controller.abort(outer.abortSignal?.reason);
  if (outer.abortSignal?.aborted) follow();
  else outer.abortSignal?.addEventListener("abort", follow, { once: true });
  const context = withAbortSignal(controller.signal, outer);
  try {
    const deadline = Date.now() + PEER_WAIT_MS;
    let ref: Ref<typeof PeerObject>;
    for (;;) {
      context.abortSignal?.throwIfAborted();
      const pending = pool.peerRef(to, PeerObject);
      try {
        ref = await awaitWithContext(pending, context);
        break;
      } catch (err) {
        pending.then((r) => r.release(), () => {});
        if (context.abortSignal?.aborted || Date.now() > deadline || !messageOf(err).startsWith("not connected")) throw err;
        await Bun.sleep(100);
      }
    }
    try {
      if (ref.variant !== "peer") throw new Error(`${shortId(to)} did not serve the peer variant of PeerObject`);
      return await awaitWithContext(call(ref), context);
    } finally {
      ref.release();
    }
  } finally {
    clearTimeout(timer);
    outer.abortSignal?.removeEventListener("abort", follow);
  }
}

/**
 * Asks the target to drop its copy of the task, best effort: `abandoned` (it had none left, or a partial one),
 * `active` (it refused: the task is live there), or `unknown` (no answer).
 */
async function abandonOnTarget(pool: PoolRuntime, to: string, taskId: string): Promise<"abandoned" | "active" | "unknown"> {
  try {
    await withPeer(pool, to, BACKGROUND_CONTEXT, (peer) => peer.abandonTask({ taskId }), ABANDON_MS);
    return "abandoned";
  } catch (err) {
    return isChordError(err, "forbidden") ? "active" : "unknown";
  }
}

/** Writes a task's frames on a stream: `exportTask`, or `exportArchive` for a restore-move. */
type Exporter = (send: PeerStream["stream"]["send"]) => Promise<Receipt>;

/**
 * Sends the task to `to` over a `blob` stream (its frames as `exporter` writes them) and checks its receipt against
 * the sender's; the sender's receipt.
 */
async function sendTask(pool: PoolRuntime, to: string, taskId: string, context: Context, exporter: Exporter): Promise<Receipt> {
  const s = await awaitWithContext(pool.net.openStream(to, { stream: "blob", kind: "task", taskId }), context);
  try {
    const sent = await awaitWithContext(exporter(s.stream.send), context);
    const line = await awaitWithContext(s.reader.readLine().catch(() => null), context);
    if (line === null) throw new Error("no receipt");
    let got: Receipt;
    try {
      got = JSON.parse(line) as Receipt;
    } catch {
      throw new Error("no receipt");
    }
    if (!receiptsMatch(sent, got)) throw new Error("receipt mismatch");
    return sent;
  } catch (err) {
    await reset(s);
    throw err;
  }
}

async function reset(s: PeerStream): Promise<void> {
  await s.stream.send.reset(0n).catch(() => {});
  await s.stream.recv.stop(0n).catch(() => {});
}

/**
 * Writes the task's leftover to `<data>/moved/` (decision 18, kept seven days), then removes it from this node
 * (decision 19): `releaseFolder`, then its event and transcript rows. The row stays, `moved`. A rerun finds pieces
 * already gone.
 */
async function removeLocalCopy(cfg: NodeConfig, db: Database, taskId: string): Promise<void> {
  const row = getTask(db, taskId);
  if (row === null) return;
  await writeArchive(cfg, db, taskId, paths(cfg).movedFile(taskId));
  await releaseFolder(cfg, db, taskId);
  clearTaskLog(db, taskId, row.session_id);
}

/**
 * What a restore-move leaves of a task archived here once the target has it: its archive becomes the move's leftover
 * in `<data>/moved/` (kept seven days from now, as a move's), any task bookmark left here is forgotten
 * (`releaseFolder`; it has no folder or workspace), and its event and transcript rows go. The row stays, `moved`. A
 * rerun finds pieces already gone.
 */
async function removeArchivedCopy(cfg: NodeConfig, db: Database, taskId: string): Promise<void> {
  const row = getTask(db, taskId);
  if (row === null) return;
  const p = paths(cfg);
  await ensurePrivateDir(p.moved);
  const moved = p.movedFile(taskId);
  try {
    await rename(p.archiveFile(taskId), moved);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  // Also on a rerun after the rename: the janitor keeps the leftover seven days from the restore.
  if (existsSync(moved)) {
    const now = new Date();
    await utimes(moved, now, now);
  }
  await releaseFolder(cfg, db, taskId);
  clearTaskLog(db, taskId, row.session_id);
}

/**
 * Takes task `taskId`'s folder off this node: removes its workspaces' jj config and forgets them (`dropWorkspace`)
 * and, in each project's repo here, every bookmark under the task's namespace (its lines are rows, whose refs the
 * applier keeps); removes the task folder with its Claude Code config dir. Writes no archive and leaves the rows alone.
 * A task without a row, and pieces already gone, are no-ops.
 */
export async function releaseFolder(cfg: NodeConfig, db: Database, taskId: string): Promise<void> {
  const row = getTask(db, taskId);
  if (row === null) return;
  const manifest = JSON.parse(row.manifest) as TaskManifest;
  for (const p of manifest.projects) {
    await dropWorkspace(cfg, p.replica, `meddle-${taskId}`, join(paths(cfg).task(taskId), p.workspace));
    await serialised(repoKey(p.replica), () => bookmarkForget(p.replica, taskGlob(taskId), cfg)).catch(() => {});
  }
  await rm(paths(cfg).task(taskId), { recursive: true, force: true });
}
