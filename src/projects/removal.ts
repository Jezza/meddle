// `meddle project remove` on a node: the removal itself (`removeProject`), refused while the project is in use or a
// member could not hear of it, and the cleanup every node runs for each project on its removed list, when the entry
// lands (`watchRemoved`) and at each start (`sweepRemoved`), until nothing of the project is left here.
import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { paths } from "../config";
import { shortId } from "../pool/ids";
import { isRemoved, listRemoved, markRemoved, removedChanges, type RemovedProject } from "../pool/removed";
import { deleteProjectRows, listLineRows, topic } from "../pool/rows";
import { rosterName, type RosterRow } from "../pool/store";
import { serialised } from "../serial";
import { listTasks } from "../store/records";
import { manifestNames, MeddleTurn, type TaskRunner, type TurnInput } from "../tasks/durable";
import { forgetTrain, MeddleTrain, type TrainInput } from "../train/train";
import { withProjectLocks } from "./locks";
import { forgetProject, getProject } from "./project";
import { rosterProject, settled, type ReplicaDeps } from "./replicas";

export type RemovalDeps = ReplicaDeps & { runner: TaskRunner };

/** How long after a cleanup that left tasks it could not stop yet (`deferred`) `watchRemoved` runs it again. */
const RETRY_MS = 60_000;

/** The tables that keep rows of a project: its line, branch and waiting branch rows (`deleteProjectRows`), and its train's. */
const PROJECT_TABLES = ["line_rows", "branch_rows", "branch_rows_waiting", "trains"];

/** Each cleanup's end, on the node of `db`: whether it left tasks of the project it could not stop yet (`watchRemoved` hears). */
const cleanups = topic<{ db: Database; projectId: string; deferred: boolean }>();

function logOf(deps: RemovalDeps): (line: string) => void {
  return deps.log ?? ((line) => console.error(line));
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Removes project `projectId` from what this node holds, once it is on the removed list (else, as for a removal heard
 * by another node of the process, nothing): once any making of its service repo or clone of its memory in flight has
 * settled, and any `create`, `receiveTask` or restore holding its lock has inserted its task (and refuses from then
 * on), its train is stopped (`forgetTrain`, so that no round drives its tasks), its tasks here are stopped and archived
 * (`stopForRemoval`), then, under its lock, its row, service repo, memory repo and rows go. A task that cannot be
 * stopped now leaves the rest for later: `watchRemoved` runs it again when a pool update's hold on turns lifts, and
 * every `RETRY_MS` until no task is left so. One at a time per project, and each run again finds what is left; a
 * failure is logged and left for the next sweep.
 */
export async function cleanupRemoved(deps: RemovalDeps, projectId: string): Promise<void> {
  const { cfg, db, runner } = deps;
  try {
    if (!isRemoved(db, projectId)) return;
    await serialised(`removal\0${projectId}`, async () => {
      await settled(cfg, projectId);
      // A barrier: whatever took the lock before the entry landed has written its task by now.
      await withProjectLocks([projectId], async () => {});
      await forgetTrain(runner.harness, db, projectId);
      const { deferred } = await runner.stopForRemoval(projectId);
      if (deferred.length > 0) {
        cleanups.tell({ db, projectId, deferred: true });
        return;
      }
      // Deletes only: a stop under the lock would wait for a task key that a `receiveTask` holds while it waits for the lock.
      await withProjectLocks([projectId], async () => {
        if (getProject(db, projectId) !== null) forgetProject(db, projectId);
        await rm(paths(cfg).replica(projectId), { recursive: true, force: true });
        await rm(paths(cfg).memory(projectId), { recursive: true, force: true });
        deleteProjectRows(db, projectId);
      });
      cleanups.tell({ db, projectId, deferred: false });
    });
  } catch (err) {
    logOf(deps)(`meddle: project ${shortId(projectId)}: cleanup: ${messageOf(err)}`);
  }
}

/**
 * `cleanupRemoved` for each project on the removed list that still has anything here (`leftHere`), one after another:
 * what a start finishes of a removal cut short.
 */
export async function sweepRemoved(deps: RemovalDeps): Promise<void> {
  for (const { id } of listRemoved(deps.db)) if (await leftHere(deps, id)) await cleanupRemoved(deps, id);
}

/**
 * Whether anything of project `projectId` is left on this node: its row, its service or memory repo, a row of it, a
 * task here whose manifest names it that is not archived or moved, or a turn of such a task or a round of its train
 * that the Harness has not finished.
 */
async function leftHere(deps: RemovalDeps, projectId: string): Promise<boolean> {
  const { cfg, db, runner } = deps;
  if (getProject(db, projectId) !== null) return true;
  if (existsSync(paths(cfg).replica(projectId)) || existsSync(paths(cfg).memory(projectId))) return true;
  if (PROJECT_TABLES.some((table) => db.query(`SELECT 1 FROM ${table} WHERE project = ? LIMIT 1`).get(projectId) !== null)) return true;
  const tasks = listTasks(db).filter((row) => manifestNames(row, projectId));
  if (tasks.some((row) => row.state !== "archived" && row.state !== "moved")) return true;
  const taskIds = new Set(tasks.map((row) => row.id));
  const { tasks: records } = await runner.harness.inspect(BACKGROUND_CONTEXT);
  return records.some(({ record }) => record.state.status !== "terminal" && (
    record.kind === MeddleTrain.definition.name
      ? (record.input as TrainInput).projectId === projectId
      : record.kind === MeddleTurn.definition.name && taskIds.has((record.input as TurnInput).taskId)
  ));
}

/**
 * Runs `cleanupRemoved` for each project the removed list gains, `sweepRemoved` whenever a pool update's hold on turns
 * lifts (a cleanup that met it is left waiting), and `cleanupRemoved` again every `retryMs` (default `RETRY_MS`) for
 * each project whose last cleanup here left tasks it could not stop yet, until none does. Returns the stop.
 */
export function watchRemoved(deps: RemovalDeps, options: { retryMs?: number } = {}): () => void {
  const log = logOf(deps);
  const sweep = () => { sweepRemoved(deps).catch((err: unknown) => log(`meddle: removal sweep: ${messageOf(err)}`)); };
  const offRemoved = removedChanges.subscribe((id) => { void cleanupRemoved(deps, id); });
  let turns = deps.runner.holds().turns;
  const offHolds = deps.runner.onHolds((holds) => {
    const was = turns;
    turns = holds.turns;
    if (was !== null && turns === null) sweep();
  });
  // The projects whose last cleanup on this node left tasks, and the timer that runs their cleanups again.
  const deferred = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const arm = () => {
    if (stopped || timer !== undefined || deferred.size === 0) return;
    timer = setTimeout(async () => {
      for (const id of [...deferred]) if (!stopped) await cleanupRemoved(deps, id);
      timer = undefined;
      arm();
    }, options.retryMs ?? RETRY_MS);
    timer.unref();
  };
  const offCleanups = cleanups.subscribable.subscribe(({ db, projectId, deferred: left }) => {
    if (db !== deps.db) return;
    if (left) deferred.add(projectId);
    else deferred.delete(projectId);
    arm();
  });
  return () => {
    stopped = true;
    clearTimeout(timer);
    offRemoved();
    offHolds();
    offCleanups();
  };
}

/**
 * Removes project `projectId` from the pool: adds it to the removed list, which sync carries to every node, and cleans
 * it up here (`cleanupRemoved`). A project already removed answers its entry, and nothing else happens. Refused
 * `unknown project: <id>` for a project neither held here nor listed by a member's summary; `<node> runs an older
 * meddle` while an online member does not serve the removed list, `<node> has not answered yet; try again` while it
 * has not said whether it does; `project <name> is used by <ids>` while a line row of it says a task holds it that is
 * not archived (unless released, or held by a node the roster marks removed).
 */
export async function removeProject(deps: RemovalDeps, projectId: string): Promise<RemovedProject> {
  const { db, pool } = deps;
  const removed = listRemoved(db).find((e) => e.id === projectId);
  if (removed !== undefined) return removed;
  const name = getProject(db, projectId)?.name ?? rosterProject(pool, db, projectId)?.name;
  if (name === undefined) throw new Error(`unknown project: ${projectId}`);
  for (const member of pool.store.members()) {
    if (member.nodeId === pool.identity.id || !pool.net.isOnline(member.nodeId)) continue;
    const support = pool.removedSupport(member.nodeId);
    const label = nodeLabel({ nodeId: member.nodeId, hostname: rosterName(member, pool.identity.id) });
    if (support === "older") throw new Error(`${label} runs an older meddle`);
    if (support === "pending") throw new Error(`${label} has not answered yet; try again`);
  }
  const used = new Set(
    listLineRows(db, projectId)
      .filter((r) => !r.archived && r.commit !== null && pool.store.row(r.holder)?.status !== "removed")
      .map((r) => r.task),
  );
  if (used.size > 0) throw new Error(`project ${name} is used by ${[...used].join(", ")}`);
  const mine: RemovedProject = { id: projectId, name, removedAt: new Date().toISOString(), removedBy: pool.identity.id };
  // An entry a peer's sync merged meanwhile stays.
  const entry = markRemoved(db, mine) ? mine : listRemoved(db).find((e) => e.id === projectId)!;
  await cleanupRemoved(deps, projectId);
  return entry;
}

/** `<short id> (<hostname>)`, or the short id alone while its hostname is not known (as the CLI's). */
function nodeLabel(node: Pick<RosterRow, "nodeId" | "hostname">): string {
  const short = shortId(node.nodeId);
  return node.hostname === "" || node.hostname === short ? short : `${short} (${node.hostname})`;
}
