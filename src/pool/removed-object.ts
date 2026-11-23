// Serves RemovedProjectsObject: the removed list as dashboards and the CLI see it (`default`, which removes a project
// too) and as other nodes sync it (`peer`). Kept apart from `removed.ts`, which reads and writes the db and nothing else.
import type { Database } from "bun:sqlite";
import Type from "typebox";
import { forbidden, type Host } from "@earendil-works/chord";
import { RemovedProjectSchema, RemovedProjectsObject } from "../state/contracts";
import { gated } from "../update/gate";
import { PEER_PRINCIPAL_PREFIX, peerOf } from "./object";
import { isRemoved, listRemoved, removedChanges, type RemovedProject } from "./removed";

export type RemovedObjectDeps = {
  /** The node's database: the removed list is read from it. */
  db: Database;
  /** Why this node accepts no input now (an update awaits confirmation), or null: the default variant's methods refuse with it. */
  inputHold?(): string | null;
  /** Removes project `id` from the pool and answers its entry on the removed list. */
  remove(id: string): Promise<RemovedProject>;
};

/** Serves RemovedProjectsObject on `host`: the `peer` variant to `peer:` principals, `default` to everyone else (as `servePool`). */
export function serveRemovedProjects(host: Host, deps: RemovedObjectDeps): void {
  const { db } = deps;
  host.serve(RemovedProjectsObject, (_input, principal, self) => {
    const peer = peerOf(principal);
    if (peer === null && typeof principal === "string" && principal.startsWith(PEER_PRINCIPAL_PREFIX)) {
      throw forbidden("not a node id");
    }
    const removed = self.state("removed", Type.Array(RemovedProjectSchema), { init: () => listRemoved(db) });
    // The event fires for every node of the process: only a project this node's db lists changes its list.
    self.on("removed", removedChanges, (id, ctx) => {
      if (isRemoved(db, id)) removed.replace(ctx, listRemoved(db));
    });
    if (peer !== null) return { variant: "peer", removed };
    return gated({ variant: "default", removed, remove: ({ id }) => deps.remove(id) }, deps.inputHold);
  });
}
