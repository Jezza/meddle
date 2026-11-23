// `meddle project remove` on a node: the removal itself (`removeProject`), refused while the project is in use or a
// member could not hear of it, and the cleanup every node runs for each project on its removed list, when the entry
// lands (`watchRemoved`) and at each start (`sweepRemoved`), until nothing of the project is left here.
import { rm } from "node:fs/promises";
import { paths } from "../config";
import { shortId } from "../pool/ids";
import { isRemoved, listRemoved, markRemoved, removedChanges, type RemovedProject } from "../pool/removed";
import { deleteProjectRows, listLineRows } from "../pool/rows";
import type { RosterRow } from "../pool/store";
import { serialised } from "../serial";
import type { TaskRunner } from "../tasks/durable";
import { forgetTrain } from "../train/train";
import { withProjectLocks } from "./locks";
import { forgetProject, getProject } from "./project";
import { rosterProject, settled, type ReplicaDeps } from "./replicas";

export type RemovalDeps = ReplicaDeps & { runner: TaskRunner };

/**
 * Removes project `projectId` from what this node holds, once it is on the removed list (else, as for a removal heard
 * by another node of the process, nothing): once any making of its service repo or clone of its memory in flight has
 * settled, and any `create`, `receiveTask` or restore holding its lock has inserted its task (and refuses from then
 * on), its train is stopped (`forgetTrain`, so that no round drives its tasks), its tasks here are stopped and archived
 * (`stopForRemoval`), then, under its lock, its row, service repo, memory repo and rows go. A task that cannot be
 * stopped while a pool update holds turns leaves the rest for later: `watchRemoved` runs it again when the hold lifts.
 * One at a time per project, and each run again finds what is left; a failure is logged and left for the next sweep.
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
      if (deferred.length > 0) return;
      // Deletes only: a stop under the lock would wait for a task key that a `receiveTask` holds while it waits for the lock.
      await withProjectLocks([projectId], async () => {
        if (getProject(db, projectId) !== null) forgetProject(db, projectId);
        await rm(paths(cfg).replica(projectId), { recursive: true, force: true });
        await rm(paths(cfg).memory(projectId), { recursive: true, force: true });
        deleteProjectRows(db, projectId);
      });
    });
  } catch (err) {
    (deps.log ?? ((line) => console.error(line)))(
      `meddle: project ${shortId(projectId)}: cleanup: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** `cleanupRemoved` for each project on the removed list, one after another: what a start finishes of a removal cut short. */
export async function sweepRemoved(deps: RemovalDeps): Promise<void> {
  for (const { id } of listRemoved(deps.db)) await cleanupRemoved(deps, id);
}

/**
 * Runs `cleanupRemoved` for each project the removed list gains, and `sweepRemoved` whenever a pool update's hold on
 * turns lifts (a cleanup that met it is left waiting). Returns the stop.
 */
export function watchRemoved(deps: RemovalDeps): () => void {
  const offRemoved = removedChanges.subscribe((id) => { void cleanupRemoved(deps, id); });
  let turns = deps.runner.holds().turns;
  const offHolds = deps.runner.onHolds((holds) => {
    const was = turns;
    turns = holds.turns;
    if (was !== null && turns === null) void sweepRemoved(deps);
  });
  return () => {
    offRemoved();
    offHolds();
  };
}

/**
 * Removes project `projectId` from the pool: adds it to the removed list, which sync carries to every node, and cleans
 * it up here (`cleanupRemoved`). A project already removed answers its entry, and nothing else happens. Refused
 * `unknown project: <id>` for a project neither held here nor listed by a member's summary; `<node> runs an older
 * meddle` while an online member does not serve the removed list, or has not answered yet; `project <name> is used by
 * <ids>` while a line row of it says a task holds it that is not archived (unless released, or held by a node the
 * roster marks removed).
 */
export async function removeProject(deps: RemovalDeps, projectId: string): Promise<RemovedProject> {
  const { db, pool } = deps;
  const removed = listRemoved(db).find((e) => e.id === projectId);
  if (removed !== undefined) return removed;
  const name = getProject(db, projectId)?.name ?? rosterProject(pool, db, projectId)?.name;
  if (name === undefined) throw new Error(`unknown project: ${projectId}`);
  for (const member of pool.store.members()) {
    if (member.nodeId === pool.identity.id || !pool.net.isOnline(member.nodeId)) continue;
    if (pool.removedSupport(member.nodeId) !== "held") throw new Error(`${nodeLabel(member)} runs an older meddle`);
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
