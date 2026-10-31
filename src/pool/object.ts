// Serves PoolObject: the pool as dashboards and the CLI see it (`default`), and as other nodes sync it (`peer`).
import Type from "typebox";
import { forbidden, type Ctx, type Host, type Subscribable } from "@earendil-works/chord";
import type { NodeConfig } from "../config";
import { NodeSummarySchema, PoolObject, RosterRowSchema } from "../state/contracts";
import { getToken, tokenStatus } from "../token";
import { isNodeId } from "./identity";
import type { NodeSummary, PoolStore, RosterRow } from "./store";

export type PoolObjectDeps = {
  store: PoolStore;
  cfg: NodeConfig;
  selfId: string;
  isOnline(nodeId: string): boolean;
  /** This node's current summary, for its own row. */
  liveSummary(): NodeSummary | Promise<NodeSummary>;
  invite(): string;
  join(ticket: string): Promise<{ poolId: string; members: number }>;
  remove(nodeId: string): Promise<void>;
  tokenChanged(): Promise<void>;
  /** Fires whenever the roster, a peer's online state or the token changed. */
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
type TokenView = Type.Static<typeof defaultState.token>;
type PoolNode = Type.Static<typeof defaultState.nodes>[number];

async function tokenNow(cfg: NodeConfig): Promise<TokenView> {
  const s = await tokenStatus(cfg);
  return { present: s.present, setAt: s.setAt ?? null, setBy: s.setBy ?? null, expiresAt: s.expiresAt ?? null };
}

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
  const { store, cfg, selfId } = deps;
  host.serve(PoolObject, (_input, principal, self) => {
    const peer = peerOf(principal);
    if (peer === null && typeof principal === "string" && principal.startsWith(PEER_PRINCIPAL_PREFIX)) {
      throw forbidden("not a node id");
    }
    // The self row as stored: its presence is refreshed by PoolSync.refreshSelf, so a peer merging it sees a change
    // only when the node refreshed it (a fresh `lastSeenAt` on every refresh would bounce between nodes forever).
    const roster = self.state("roster", Type.Array(RosterRowSchema), { init: () => store.roster() });
    const token = self.state("token", defaultState.token, { init: () => tokenNow(cfg) });
    /** Token reads in flight: only the newest one's result is kept, and none once the host closed meanwhile. */
    let tokenReads = 0;
    const refreshToken = async (ctx: Ctx) => {
      const n = ++tokenReads;
      const next = await tokenNow(cfg);
      if (n === tokenReads && !ctx.signal.aborted) token.replace(ctx, next);
    };

    if (peer !== null) {
      self.on("changes", deps.changes, async (_event, ctx) => {
        roster.replace(ctx, store.roster());
        await refreshToken(ctx);
      });
      return {
        variant: "peer",
        roster,
        token: self.derive([token], (t) => (t.setAt === null ? null : { setAt: t.setAt, setBy: t.setBy })),
        fetchToken: async () => {
          if (!store.isMember(peer)) throw forbidden("not a member");
          const [value, meta] = await Promise.all([getToken(cfg), tokenStatus(cfg)]);
          if (value === null || meta.setAt === undefined) throw new Error("no token on this node");
          return { value, setAt: meta.setAt, setBy: meta.setBy ?? null };
        },
      };
    }

    const liveNow = async (): Promise<Live> => ({ summary: await deps.liveSummary(), at: new Date().toISOString() });
    const onlineNow = () => store.roster().map((r) => r.nodeId).filter((id) => id !== selfId && deps.isOnline(id));
    const live = self.state("live", LiveSchema, { init: liveNow });
    const online = self.state("online", Type.Array(Type.String()), { init: onlineNow });
    const poolId = self.state("poolId", defaultState.poolId, { init: () => store.pool().poolId });
    self.on("changes", deps.changes, async (_event, ctx) => {
      roster.replace(ctx, store.roster());
      online.replace(ctx, onlineNow());
      poolId.replace(ctx, store.pool().poolId);
      await Promise.all([refreshToken(ctx), liveNow().then((l) => { if (!ctx.signal.aborted) live.replace(ctx, l); })]);
    });
    return {
      variant: "default",
      poolId,
      self: self.state("self", defaultState.self, selfId),
      nodes: self.derive([roster, live, online], (rows, l, on) => rows.map((r) => nodeOf(r, selfId, l, on))),
      token,
      mixedVersions: self.derive([roster, live], (rows, l) => mixed(rows, selfId, l)),
      invite: async () => ({ ticket: deps.invite() }),
      join: ({ ticket }) => deps.join(ticket),
      remove: ({ nodeId }) => deps.remove(nodeId),
      tokenChanged: () => deps.tokenChanged(),
    };
  });
}
