// src/update/object.ts — serves UpdateObject: pool updates as dashboards and the CLI see them, from the node's
// `Updater`, and `meddle update`'s way in.
import Type from "typebox";
import { forbidden, type Host, type Subscribable } from "@earendil-works/chord";
import { peerOf } from "../pool/object";
import { UpdateObject } from "../state/contracts";
import { gated } from "./gate";
import type { StartRequest, UpdateSnapshot } from "./updater";

/** What `serveUpdate` needs of the node's `Updater`. */
export type UpdateObjectDeps = {
  snapshot(): UpdateSnapshot;
  startRollout(req: StartRequest): Promise<{ rollout: string; build: string; escalated: boolean; participants: string[] }>;
  changes: Subscribable<null>;
  /** Why this node accepts no input now (`Updater.inputHold`), or null: `start` is refused with it. */
  inputHold?(): string | null;
};

const state = UpdateObject.def.variants.default.state;

/** Serves UpdateObject on `host` to dashboards and the CLI; another node's principal is refused (it has the channel). */
export function serveUpdate(host: Host, deps: UpdateObjectDeps): void {
  host.serve(UpdateObject, (_input, principal, self) => {
    if (peerOf(principal) !== null) throw forbidden("nodes speak the rollout channel");
    const SnapshotSchema = Type.Object(state);
    const snap = self.state("snapshot", SnapshotSchema, { init: () => deps.snapshot() });
    self.on("changes", deps.changes, (_event, ctx) => {
      snap.replace(ctx, deps.snapshot());
    });
    const field = <K extends keyof UpdateSnapshot>(key: K) => self.derive([snap], (s) => s[key]);
    return gated({
      variant: "default",
      self: field("self"),
      build: field("build"),
      poolBuild: field("poolBuild"),
      rollout: field("rollout"),
      lastFailure: field("lastFailure"),
      awaitingConfirmation: field("awaitingConfirmation"),
      held: field("held"),
      nodes: field("nodes"),
      start: (req) => deps.startRollout(req),
    }, deps.inputHold);
  });
}
