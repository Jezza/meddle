// Serves ScopeHeadsObject: how each synced scope stands on this node as dashboards and the CLI see it (`default`) and
// the head rows as other nodes sync them (`peer`). Kept apart from `heads.ts`, which reads and writes the db and nothing
// else.
import type { Database } from "bun:sqlite";
import Type from "typebox";
import { forbidden, type Host, type Subscribable } from "@earendil-works/chord";
import { HeadRowSchema, ScopeHeadsObject, ScopeStateSchema } from "../state/contracts";
import type { ScopeState } from "../scopes/scope";
import { allHeadRows, headChanges } from "./heads";
import { PEER_PRINCIPAL_PREFIX, peerOf } from "./object";

export type HeadsObjectDeps = {
  /** The node's database: the head rows are read from it. */
  db: Database;
  /** How each scope stands here now (none before the scopes sync), and when that changed. */
  scopes?(): ScopeState[];
  scopeChanges?: Subscribable<null>;
};

/** Serves ScopeHeadsObject on `host`: the `peer` variant to `peer:` principals, `default` to everyone else (as `servePool`). */
export function serveScopeHeads(host: Host, deps: HeadsObjectDeps): void {
  const { db } = deps;
  host.serve(ScopeHeadsObject, (_input, principal, self) => {
    const peer = peerOf(principal);
    if (peer === null && typeof principal === "string" && principal.startsWith(PEER_PRINCIPAL_PREFIX)) {
      throw forbidden("not a node id");
    }
    if (peer !== null) {
      const heads = self.state("heads", Type.Array(HeadRowSchema), { init: () => allHeadRows(db) });
      self.on("heads", headChanges, (_scope, ctx) => heads.replace(ctx, allHeadRows(db)));
      return { variant: "peer", heads };
    }
    const now = () => deps.scopes?.() ?? [];
    const scopes = self.state("scopes", Type.Array(ScopeStateSchema), { init: now });
    self.on("heads", headChanges, (_scope, ctx) => scopes.replace(ctx, now()));
    if (deps.scopeChanges !== undefined) self.on("scopes", deps.scopeChanges, (_e, ctx) => scopes.replace(ctx, now()));
    return { variant: "default", scopes };
  });
}
