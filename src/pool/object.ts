// Serves PoolObject: the pool as dashboards and the CLI see it (`default`), and as other nodes sync it (`peer`): the
// roster, the tokens' metadata and the settings.
import type { Database } from "bun:sqlite";
import Type from "typebox";
import { forbidden, type Ctx, type Host, type Subscribable } from "@earendil-works/chord";
import type { NodeConfig } from "../config";
import { NodeSummarySchema, PoolObject, RosterRowSchema, SettingRowSchema, TokenMetaSchema } from "../state/contracts";
import { TOKEN_ID, enableToken, listTokens, moveToken, pickToken, tokenRow, tokenValue, type TokenMeta } from "../token";
import { isNodeId } from "./identity";
import type { PoolSettings } from "./settings";
import type { NodeSummary, PoolStore, WireRosterRow } from "./store";

export type PoolObjectDeps = {
  store: PoolStore;
  /** The node's database: the token rows are read from it. */
  db: Database;
  cfg: NodeConfig;
  selfId: string;
  isOnline(nodeId: string): boolean;
  /** Whether this node counts the member gone (not heard of for longer than `roster.forget`). */
  isGone(nodeId: string): boolean;
  /** The connection held with the member (`PoolNet.linkOf`), or null. */
  linkOf?(nodeId: string): { dialer: string; session: string } | null;
  /** This node's session (`PoolNet.session`). */
  session?: string;
  /** This node's current summary, for its own row. */
  liveSummary(): NodeSummary | Promise<NodeSummary>;
  /** The pool row or the roster changed under the node (the CLI wrote it): re-read it. */
  poolChanged(): Promise<void>;
  remove(nodeId: string): Promise<void>;
  /** Makes a removed node a member again. */
  allow(nodeId: string): Promise<void>;
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
export type Live = Type.Static<typeof LiveSchema>;
type PoolNode = Type.Static<typeof defaultState.nodes>[number];

/** A peer's error as it said it: without the `<code>: ` (or `<code>/<reason>: `) a chord error's message starts with. */
export function remoteReason(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && err.message.startsWith(code)) return err.message.replace(/^[^:]*: /, "");
  return err.message;
}

/**
 * One roster row as a dashboard sees it; this node's own row shows its live summary. A summary from an older meddle
 * (no `running`, `limit` or `projects`) shows 0, 0 and [], as placement reads it. `lastSeenAt` is the newer of the
 * node's own last word and the newest report of a member connected to it.
 */
export function nodeOf(
  row: WireRosterRow, selfId: string, live: Live, online: readonly string[], gone: readonly string[] = [],
  links: Readonly<Record<string, { dialer: string; session: string }>> = {},
): PoolNode {
  const self = row.nodeId === selfId;
  const reached = row.reachedAt ?? null;
  const heard = reached !== null && (row.lastSeenAt === null || reached > row.lastSeenAt) ? reached : row.lastSeenAt;
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
    running: summary?.running ?? 0,
    limit: summary?.limit ?? 0,
    projects: summary?.projects ?? [],
    lastSeenAt: self ? live.at : heard,
    gone: !self && gone.includes(row.nodeId),
    link: self ? null : links[row.nodeId] ?? null,
  };
}

/** Members (with a known summary) report more than one meddle or Claude Code version. */
function mixed(rows: readonly WireRosterRow[], selfId: string, live: Live): boolean {
  const summaries = rows
    .filter((r) => r.status === "member")
    .map((r) => (r.nodeId === selfId ? live.summary : r.summary))
    .filter((s) => s !== null);
  return new Set(summaries.map((s) => s.version)).size > 1 || new Set(summaries.map((s) => s.claudeCodeVersion)).size > 1;
}

/**
 * The token the dashboard names by `id`: only a full id the table lists, not removed (a label is the CLI's convenience;
 * the dashboard always has the id). Throws `no such token: <id>`, echoing the text sent only when it has an id's shape.
 */
function listedToken(db: Database, id: string): TokenMeta {
  const row = TOKEN_ID.test(id) ? tokenRow(db, id) : null;
  if (row === null || row.removed) throw new Error(TOKEN_ID.test(id) ? `no such token: ${id}` : "no such token");
  return row;
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
    const goneNow = () => store.roster().map((r) => r.nodeId).filter((id) => id !== selfId && deps.isGone(id));
    const live = self.state("live", LiveSchema, { init: liveNow });
    const online = self.state("online", Type.Array(Type.String()), { init: onlineNow });
    const goneIds = self.state("gone", Type.Array(Type.String()), { init: goneNow });
    const LinkSchema = Type.Object({ dialer: Type.String(), session: Type.String() });
    const linksNow = () => Object.fromEntries(
      store.roster().flatMap((r) => {
        const link = r.nodeId === selfId ? null : deps.linkOf?.(r.nodeId) ?? null;
        return link === null ? [] : [[r.nodeId, link] as const];
      }),
    );
    const links = self.state("links", Type.Record(Type.String(), LinkSchema), { init: linksNow });
    const poolId = self.state("poolId", defaultState.poolId, { init: () => store.pool().poolId });
    const poolName = self.state("poolName", defaultState.poolName, { init: () => store.pool().poolName });
    /** The settings with a value, as the dashboard lists them: who set each, and when. */
    const withValue = () => settings.rows()
      .flatMap(({ key, value, setBy, updatedAt }) => (value === null ? [] : [{ key, value, setBy, updatedAt }]));
    const listed = self.state("settings", defaultState.settings, { init: withValue });
    self.on("changes", deps.changes, async (_event, ctx) => {
      roster.replace(ctx, store.roster());
      listed.replace(ctx, withValue());
      tokens.replace(ctx, listTokens(db));
      online.replace(ctx, onlineNow());
      goneIds.replace(ctx, goneNow());
      links.replace(ctx, linksNow());
      poolId.replace(ctx, store.pool().poolId);
      poolName.replace(ctx, store.pool().poolName);
      await Promise.all([refreshActive(ctx), liveNow().then((l) => { if (!ctx.signal.aborted) live.replace(ctx, l); })]);
    });
    return {
      variant: "default",
      poolId,
      poolName,
      self: self.state("self", defaultState.self, selfId),
      session: self.state("session", Type.String(), deps.session ?? ""),
      nodes: self.derive([roster, live, online, goneIds, links], (rows, l, on, g, k) => rows.map((r) => nodeOf(r, selfId, l, on, g, k))),
      tokens,
      activeTokenId: active,
      mixedVersions: self.derive([roster, live], (rows, l) => mixed(rows, selfId, l)),
      settings: listed,
      poolChanged: () => deps.poolChanged(),
      remove: ({ nodeId }) => deps.remove(nodeId),
      allow: ({ nodeId }) => deps.allow(nodeId),
      tokenChanged: () => deps.tokenChanged(),
      enableToken: async ({ id }) => {
        enableToken(db, listedToken(db, id).id);
        await deps.tokenChanged();
      },
      moveToken: async ({ id, before, after }) => {
        if ((before === undefined) === (after === undefined)) throw new Error("give one of before and after");
        const moving = listedToken(db, id).id;
        const anchor = listedToken(db, (before ?? after)!).id;
        moveToken(db, moving, before !== undefined ? { before: anchor } : { after: anchor });
        await deps.tokenChanged();
      },
      setSetting: ({ key, value }) => deps.setSetting(key, value),
      unsetSetting: ({ key }) => deps.unsetSetting(key),
    };
  });
}
