// Serves PoolObject: the pool as dashboards and the CLI see it (`default`), and as other nodes sync it (`peer`): the
// roster, the tokens' metadata and the settings.
import type { Database } from "bun:sqlite";
import Type from "typebox";
import { forbidden, type Ctx, type Host, type Subscribable } from "@earendil-works/chord";
import type { NodeConfig } from "../config";
import { NodeSummarySchema, PoolObject, RosterRowSchema, SettingRowSchema, TokenMetaSchema } from "../state/contracts";
import { listTokens, pickToken, tokenRow, tokenValue } from "../token";
import { isNodeId } from "./identity";
import type { PoolSettings } from "./settings";
import type { NodeSummary, PoolStore, RosterRow } from "./store";

export type PoolObjectDeps = {
  store: PoolStore;
  /** The node's database: the token rows are read from it. */
  db: Database;
  cfg: NodeConfig;
  selfId: string;
  isOnline(nodeId: string): boolean;
  /** This node's current summary, for its own row. */
  liveSummary(): NodeSummary | Promise<NodeSummary>;
  invite(): string;
  join(ticket: string): Promise<{ poolId: string; members: number }>;
  remove(nodeId: string): Promise<void>;
  tokenChanged(): Promise<void>;
  /** The pool's settings, read by both variants. */
  settings: PoolSettings;
  /** Sets a setting here and tells the pool (rejects what `PoolSettings.set` refuses). */
  setSetting(key: string, value: string): Promise<void>;
  /** Unsets a setting here and tells the pool. */
  unsetSetting(key: string): Promise<void>;
  /** Fires whenever the roster, a peer's online state, the tokens or the settings changed, and on each self refresh. */
  changes: Subscribable<null>;
};

export const PEER_PRINCIPAL_PREFIX = "peer:";

/** The node id of a `peer:<id>` principal, else null. */
export function peerOf(principal: unknown): string | null {
  if (typeof principal !== "string" || !principal.startsWith(PEER_PRINCIPAL_PREFIX)) return null;
  const id = principal.slice(PEER_PRINCIPAL_PREFIX.length);
  return isNodeId(id) ? id : null;
}

const defaultState = PoolObject.def.variants.default.state;
const LiveSchema = Type.Object({ summary: NodeSummarySchema, at: Type.String() });
type Live = Type.Static<typeof LiveSchema>;
type PoolNode = Type.Static<typeof defaultState.nodes>[number];

/** One roster row as a dashboard sees it; this node's own row shows its live summary. */
function nodeOf(row: RosterRow, selfId: string, live: Live, online: readonly string[]): PoolNode {
  const self = row.nodeId === selfId;
  const summary = self ? live.summary : row.summary;
  return {
    nodeId: row.nodeId,
    hostname: summary?.hostname ?? row.hostname,
    status: row.status,
    online: self || online.includes(row.nodeId),
    version: summary?.version ?? "",
    claudeCodeVersion: summary?.claudeCodeVersion ?? "",
    hostsTasks: summary?.hostsTasks ?? false,
    taskCount: summary?.taskCount ?? 0,
    lastSeenAt: self ? live.at : row.lastSeenAt,
  };
}

/** Members (with a known summary) report more than one meddle or Claude Code version. */
function mixed(rows: readonly RosterRow[], selfId: string, live: Live): boolean {
  const summaries = rows
    .filter((r) => r.status === "member")
    .map((r) => (r.nodeId === selfId ? live.summary : r.summary))
    .filter((s): s is NodeSummary => s !== null);
  return new Set(summaries.map((s) => s.version)).size > 1 || new Set(summaries.map((s) => s.claudeCodeVersion)).size > 1;
}

/** Serves PoolObject on `host`: the `peer` variant to `peer:` principals, `default` to everyone else. */
export function servePool(host: Host, deps: PoolObjectDeps): void {
  const { store, db, cfg, selfId, settings } = deps;
  host.serve(PoolObject, (_input, principal, self) => {
    const peer = peerOf(principal);
    if (peer === null && typeof principal === "string" && principal.startsWith(PEER_PRINCIPAL_PREFIX)) {
      throw forbidden("not a node id");
    }
    // The self row as stored: its presence is refreshed by PoolSync.refreshSelf, so a peer merging it sees a change
    // only when the node refreshed it (a fresh `lastSeenAt` on every refresh would bounce between nodes forever).
    const roster = self.state("roster", Type.Array(RosterRowSchema), { init: () => store.roster() });

    if (peer !== null) {
      const rows = self.state("settings", Type.Array(SettingRowSchema), { init: () => settings.rows() });
      const tokens = self.state("tokens", Type.Array(TokenMetaSchema), { init: () => listTokens(db, { includeRemoved: true }) });
      self.on("changes", deps.changes, (_event, ctx) => {
        roster.replace(ctx, store.roster());
        rows.replace(ctx, settings.rows());
        tokens.replace(ctx, listTokens(db, { includeRemoved: true }));
      });
      return {
        variant: "peer",
        roster,
        settings: rows,
        tokens,
        fetchToken: async ({ id }) => {
          if (!store.isMember(peer)) throw forbidden("not a member");
          // The table first: an id this node does not list never reaches the filesystem.
          const row = tokenRow(db, id);
          if (row === null || row.removed) throw forbidden("unknown token");
          const value = await tokenValue(cfg, row.id);
          if (value === null) throw new Error("the token's value is not on this node");
          return { value };
        },
      };
    }

    const activeNow = async () => (await pickToken(cfg, db))?.id ?? null;
    const tokens = self.state("tokens", defaultState.tokens, { init: () => listTokens(db) });
    const active = self.state("activeTokenId", defaultState.activeTokenId, { init: activeNow });
    /** Active-token reads in flight: only the newest one's result is kept, and none once the host closed meanwhile. */
    let activeReads = 0;
    const refreshActive = async (ctx: Ctx) => {
      const n = ++activeReads;
      const next = await activeNow();
      if (n === activeReads && !ctx.signal.aborted) active.replace(ctx, next);
    };

    const liveNow = async (): Promise<Live> => ({ summary: await deps.liveSummary(), at: new Date().toISOString() });
    const onlineNow = () => store.roster().map((r) => r.nodeId).filter((id) => id !== selfId && deps.isOnline(id));
    const live = self.state("live", LiveSchema, { init: liveNow });
    const online = self.state("online", Type.Array(Type.String()), { init: onlineNow });
    const poolId = self.state("poolId", defaultState.poolId, { init: () => store.pool().poolId });
    const listed = self.state("settings", defaultState.settings, { init: () => settings.list() });
    self.on("changes", deps.changes, async (_event, ctx) => {
      roster.replace(ctx, store.roster());
      listed.replace(ctx, settings.list());
      tokens.replace(ctx, listTokens(db));
      online.replace(ctx, onlineNow());
      poolId.replace(ctx, store.pool().poolId);
      await Promise.all([refreshActive(ctx), liveNow().then((l) => { if (!ctx.signal.aborted) live.replace(ctx, l); })]);
    });
    return {
      variant: "default",
      poolId,
      self: self.state("self", defaultState.self, selfId),
      nodes: self.derive([roster, live, online], (rows, l, on) => rows.map((r) => nodeOf(r, selfId, l, on))),
      tokens,
      activeTokenId: active,
      mixedVersions: self.derive([roster, live], (rows, l) => mixed(rows, selfId, l)),
      settings: listed,
      invite: async () => ({ ticket: deps.invite() }),
      join: ({ ticket }) => deps.join(ticket),
      remove: ({ nodeId }) => deps.remove(nodeId),
      tokenChanged: () => deps.tokenChanged(),
      setSetting: ({ key, value }) => deps.setSetting(key, value),
      unsetSetting: ({ key }) => deps.unsetSetting(key),
    };
  });
}
