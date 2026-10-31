// The sending side of moving a task to another node: the durable `meddle.move` (decisions 10, 11, 16, 18, 19).
import { rm } from "node:fs/promises";
import type { Database } from "bun:sqlite";
import { isChordError, type Ref } from "@earendil-works/chord";
import { awaitWithContext, BACKGROUND_CONTEXT, withAbortSignal, type Context } from "@earendil-works/chord/context";
import { defineTask, type TaskRuntime } from "@earendil-works/pi-durable";
import type { NodeConfig } from "../config";
import { bookmarkForget, workspaceForget } from "../jj";
import { paths } from "../paths";
import { shortId } from "../pool/ids";
import type { PeerStream } from "../pool/net";
import type { PoolRuntime } from "../pool/runtime";
import { getProject } from "../projects/project";
import { PeerObject } from "../state/contracts";
import { clearTaskLog, getTask } from "../store/records";
import { repoKey, serialised } from "../serial";
import { claudeCodeVersion } from "../version";
import { writeArchive } from "./archive";
import { runnerFor, type MeddleHooks, type TaskRunner } from "./durable";
import type { TaskManifest } from "./manifest";
import { exportTask, receiptsMatch, type Receipt } from "./transfer";

export type MoveInput = { taskId: string; to: string; now: boolean };
export type MoveCheckpoint = { phase: "prepare" } | { phase: "handoff" } | { phase: "commit"; receipt: Receipt } | { phase: "cleanup" };
type MoveRuntime = TaskRuntime<MoveInput, MoveCheckpoint, null, MeddleHooks>;
type PeerRef = Extract<Ref<typeof PeerObject>, { variant: "peer" }>;

/** The first prompt on the target after a "move now" cut a turn short (decision 14). */
export const MOVE_NOW_FOLLOW_UP =
  "The previous turn was interrupted to move this task to another machine. Background shells and subagents that were running were stopped and did not travel. Carry on from where you were; do not redo work that is already done.";

/** How long a step waits for the target's connection to come up (right after a restart, it is still being made). */
const PEER_WAIT_MS = 10_000;
/** How long a rollback's best-effort `abandonTask` may take. */
const ABANDON_MS = 15_000;
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
 * Moves a task to another node. `prepare` checks the move again (decision 16), marks the task `moving` and waits for its
 * turn to end (or interrupts it with `now`); `handoff` sets the task bookmarks, has the target fetch them and provision
 * the task (`receiveTask`), sends the task over a `blob` stream and compares receipts; `commit` activates the task on the
 * target and records it here as `moved`; `cleanup` archives and removes the local copy. A step that fails before the
 * target acknowledged `activateTask` rolls the move back itself (pi-durable faults a throwing phase and runs `abort`
 * only after an abort mark) and ends `failed`; `abort` rolls back the same way and ends `aborted`.
 */
export const MeddleMove = defineTask<MoveInput, MoveCheckpoint, null, MeddleHooks>({
  name: "meddle.move",
  version: 1,
  initial: () => ({ phase: "prepare" }),
  phases: {
    prepare: (task, runtime, context) => step("prepare", task.input, runtime, context, async (runner) => {
      const { taskId, to, now } = task.input;
      runner.checkMove(taskRow(runner, taskId), to, true);
      runner.enterMove(taskId, to, "prepare");
      // Remembered before the interrupt: a rerun after a crash still knows it cut the turn.
      await runner.awaitTurnEnd(taskId, now, context, async () => { await runtime.memo(CUT_MEMO, true, context); });
      await runtime.commit(() => ({ status: "running", checkpoint: { phase: "handoff" } }), context);
    }),
    handoff: (task, runtime, context) => step("handoff", task.input, runtime, context, async (runner) => {
      const { taskId, to } = task.input;
      const { cfg, db, pool } = runner.moveDeps();
      runner.enterMove(taskId, to, "handoff");
      const manifest = JSON.parse(taskRow(runner, taskId).manifest) as TaskManifest;
      await runner.setTaskBookmarks(manifest);
      // A rerun of this step finds its partial copy there: the target replaces it.
      const answer = await withPeer(pool, to, context, (peer) => peer.receiveTask({ manifest, claudeCodeVersion: claudeCodeVersion() }));
      if (!answer.ok) throw new Error(answer.reason ?? `${shortId(to)} refused the task`);
      const receipt = await sendTask(cfg, db, pool, to, taskId, context);
      await runtime.commit(() => ({ status: "running", checkpoint: { phase: "commit", receipt } }), context);
    }),
    commit: async (task, runtime, context) => {
      const runner = await runnerFor(runtime, context);
      const { taskId, to } = task.input;
      const { pool, log } = runner.moveDeps();
      const row = getTask(runner.moveDeps().db, taskId);
      // A rerun after the task was recorded as moved: only the cleanup is left.
      if (row?.state !== "moved") {
        let failure: string | null = null;
        try {
          runner.enterMove(taskId, to, "commit");
          const cut = (await runtime.memo<boolean>(CUT_MEMO, context)) === true;
          // A rerun after a crash asks again; the target answers `ok` for a task it already activated.
          const answer = await withPeer(pool, to, context, (peer) => peer.activateTask({ taskId, followUp: cut ? MOVE_NOW_FOLLOW_UP : null }));
          if (!answer.ok) throw new Error(`${shortId(to)} did not activate the task`);
        } catch (err) {
          if (stopping(runtime, context)) throw err;
          failure = messageOf(err);
        }
        if (failure !== null) {
          // The answer can be lost after the target took the task: it refuses to abandon only a task it activated.
          if ((await abandonOnTarget(pool, to, taskId)) !== "active") {
            await runner.failMove(taskId, to, "commit", failure);
            await runtime.commit(() => ({ status: "terminal", outcome: { status: "failed", error: { message: failure } } }), context);
            return;
          }
          log(`meddle: move: ${taskId} is active on ${shortId(to)} although its activation failed (${failure}); the move completes`);
        }
        // The task is the target's now: nothing here rolls back any more.
        try {
          runner.completeMove(taskId, to);
        } catch (err) {
          log(`meddle: move: ${taskId} is on ${shortId(to)}, but could not be recorded as moved here: ${messageOf(err)}; trying again`);
          await runtime.sleepUntil(Date.now() + COMMIT_RETRY_MS, task.state.checkpoint, context);
          return;
        }
      }
      await runtime.commit(() => ({ status: "running", checkpoint: { phase: "cleanup" } }), context);
    },
    cleanup: async (task, runtime, context) => {
      const runner = await runnerFor(runtime, context);
      const { taskId, to } = task.input;
      const { cfg, db, pool, log } = runner.moveDeps();
      try {
        await removeLocalCopy(cfg, db, pool.identity.id, taskId);
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
    if (getTask(db, taskId)?.state !== "moved") {
      const where = phase === "prepare" ? "abandoned" : await abandonOnTarget(pool, to, taskId);
      if (phase === "commit" && where === "active") runner.completeMove(taskId, to);
      else await runner.failMove(taskId, to, phase, "the move was aborted");
    }
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
  },
});

/**
 * Runs one step that may roll back: a failure (other than the Harness closing or an abort, which leave the step to run
 * again or to `abort`) abandons the target's copy, makes the task live here again, and ends the move `failed`.
 */
async function step(
  phase: MoveCheckpoint["phase"],
  input: MoveInput,
  runtime: MoveRuntime,
  context: Context,
  body: (runner: TaskRunner) => Promise<void>,
): Promise<void> {
  const runner = await runnerFor(runtime, context);
  try {
    await body(runner);
  } catch (err) {
    if (stopping(runtime, context)) throw err;
    const error = messageOf(err);
    // Before the handoff the target was asked nothing.
    if (phase !== "prepare") await abandonOnTarget(runner.moveDeps().pool, input.to, input.taskId);
    await runner.failMove(input.taskId, input.to, phase, error);
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
 * after it; waits up to `PEER_WAIT_MS` for the connection to come up.
 */
async function withPeer<T>(pool: PoolRuntime, to: string, context: Context, call: (peer: PeerRef) => Promise<T>): Promise<T> {
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
}

/**
 * Asks the target to drop its copy of the task, best effort: `abandoned` (it had none left, or a partial one),
 * `active` (it refused: the task is live there), or `unknown` (no answer).
 */
async function abandonOnTarget(pool: PoolRuntime, to: string, taskId: string): Promise<"abandoned" | "active" | "unknown"> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("no answer")), ABANDON_MS);
  try {
    await withPeer(pool, to, withAbortSignal(controller.signal, BACKGROUND_CONTEXT), (peer) => peer.abandonTask({ taskId }));
    return "abandoned";
  } catch (err) {
    return isChordError(err, "forbidden") ? "active" : "unknown";
  } finally {
    clearTimeout(timer);
  }
}

/** Sends the task to `to` over a `blob` stream and checks its receipt against the sender's; the sender's receipt. */
async function sendTask(cfg: NodeConfig, db: Database, pool: PoolRuntime, to: string, taskId: string, context: Context): Promise<Receipt> {
  const s = await awaitWithContext(pool.net.openStream(to, { stream: "blob", kind: "task", taskId }), context);
  try {
    const sent = await awaitWithContext(exportTask(cfg, db, taskId, s.stream.send), context);
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
 * Archives the task (decision 18), then removes it from this node (decision 19): forgets its workspaces and, unless
 * this node is the project's home (where they stay as the backup), its task bookmarks; removes its folder (the config
 * dir with it) and its event and transcript rows. The row stays, `moved`. A rerun finds pieces already gone.
 */
async function removeLocalCopy(cfg: NodeConfig, db: Database, self: string, taskId: string): Promise<void> {
  const row = getTask(db, taskId);
  if (row === null) return;
  await writeArchive(cfg, db, taskId);
  const manifest = JSON.parse(row.manifest) as TaskManifest;
  for (const p of manifest.projects) {
    await workspaceForget(p.replica, `meddle-${taskId}`, cfg).catch(() => {});
    if (getProject(db, p.id)?.home === self) continue;
    const bookmark = `meddle/task/${taskId}/${p.name}`;
    await serialised(repoKey(p.replica), () => bookmarkForget(p.replica, bookmark, cfg)).catch(() => {});
  }
  await rm(paths(cfg).task(taskId), { recursive: true, force: true });
  clearTaskLog(db, taskId, row.session_id);
}
