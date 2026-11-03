import type { Database } from "bun:sqlite";
import { shortId } from "./ids";
import { DEFAULT_POOL_NAME, poolKey } from "./secret";

/** A project a node holds (its own or a replica), as the rest of the pool sees it. */
export type NodeProject = { id: string; name: string; home: string };

/**
 * What a node reports about itself to the rest of the pool. `running`: its tasks in state `running` or `waiting`;
 * `limit`: how many may run at once (0 is no limit); `projects`: every project it holds. A node of an older meddle
 * reports none of the three: they read as 0, 0 and [] (`withSummaryDefaults`).
 */
export type NodeSummary = {
  hostname: string; version: string; claudeCodeVersion: string; hostsTasks: boolean; taskCount: number;
  running: number; limit: number; projects: NodeProject[];
};

/** A summary as a peer may send it: an older meddle's has no `running`, `limit` or `projects`. */
export type WireSummary = Omit<NodeSummary, "running" | "limit" | "projects"> & Partial<Pick<NodeSummary, "running" | "limit" | "projects">>;

/** A summary with what an older peer left out filled in: nothing running, no limit, no projects. */
export function withSummaryDefaults(s: WireSummary): NodeSummary {
  return { ...s, running: s.running ?? 0, limit: s.limit ?? 0, projects: s.projects ?? [] };
}

/** An iroh endpoint address in JSON form: `id` is the node id. */
export type WireAddr = { id: string; relay: string | null; direct: string[] };

/**
 * One node of the pool. `status`, `hostname`, `updatedAt` and `addedBy` are membership, merged
 * last-writer-wins on `updatedAt`; `summary`, `lastSeenAt` and `lastAddr` are presence, merged on `lastSeenAt`.
 */
export type RosterRow = {
  nodeId: string; hostname: string; status: "member" | "removed"; updatedAt: string; addedBy: string;
  summary: NodeSummary | null; lastSeenAt: string | null; lastAddr: WireAddr | null;
};

/** A roster row as a peer may send it (its summary perhaps an older meddle's). */
export type WireRosterRow = Omit<RosterRow, "summary"> & { summary: WireSummary | null };

/**
 * The pool this node is in: `poolId` is the topic public key `poolName` and `poolSecret` derive (`poolKey`), and both it
 * and the secret are empty until `meddle pool secret` set one. `createdAt` is when the secret was set here.
 */
export type PoolIdentity = { poolId: string; poolName: string; poolSecret: string; createdAt: string };

type PoolRecord = { pool_id: string; pool_secret: string | null; created_at: string | null; name: string | null };

/**
 * The `updatedAt` of the row a node gets here when it proved the secret before anything was heard of it: older than
 * any row the node sends of itself, so that one wins the merge and fills in its hostname.
 */
export const PROVISIONAL_AT = "1970-01-01T00:00:00.000Z";

type RosterRecord = {
  node_id: string; hostname: string; status: RosterRow["status"]; updated_at: string; added_by: string;
  summary: string | null; last_seen_at: string | null; last_addr: string | null;
};

function toRow(r: RosterRecord): RosterRow {
  return {
    nodeId: r.node_id,
    hostname: r.hostname,
    status: r.status,
    updatedAt: r.updated_at,
    addedBy: r.added_by,
    summary: r.summary === null ? null : withSummaryDefaults(JSON.parse(r.summary) as WireSummary),
    lastSeenAt: r.last_seen_at,
    lastAddr: r.last_addr === null ? null : (JSON.parse(r.last_addr) as WireAddr),
  };
}

/** A pool row of an older meddle (no name) reads as an empty pool: its random id and secret derive nothing. */
function toPool(r: PoolRecord): PoolIdentity {
  if (r.name === null) return { poolId: "", poolName: DEFAULT_POOL_NAME, poolSecret: "", createdAt: r.created_at ?? "" };
  return { poolId: r.pool_id, poolName: r.name, poolSecret: r.pool_secret ?? "", createdAt: r.created_at ?? "" };
}

/** The pool's identity (name, secret, id) and its roster, in `meddle.sqlite`. */
export class PoolStore {
  constructor(private readonly db: Database) {}

  /**
   * Makes sure there is a pool row (empty: no secret yet) and a member row for this node; returns the pool. A pool row
   * of an older meddle (no name: a random id and secret that derive nothing) is reset to empty.
   */
  ensurePool(self: { nodeId: string; hostname: string }, now: string = new Date().toISOString()): PoolIdentity {
    return this.db.transaction(() => {
      const r = this.db.query<PoolRecord, []>("SELECT * FROM pool").get();
      if (r === null) {
        this.db.query("INSERT INTO pool (pool_id, pool_secret, created_at, name) VALUES ('', '', ?, ?)").run(now, DEFAULT_POOL_NAME);
      } else if (r.name === null) {
        this.db.query("UPDATE pool SET pool_id = '', pool_secret = '', created_at = ?, name = ?").run(now, DEFAULT_POOL_NAME);
      }
      this.ensureSelf(self, now);
      return this.pool();
    })();
  }

  private ensureSelf(self: { nodeId: string; hostname: string }, now: string): void {
    if (this.row(self.nodeId) === null) {
      this.upsert({
        nodeId: self.nodeId, hostname: self.hostname, status: "member", updatedAt: now, addedBy: self.nodeId,
        summary: null, lastSeenAt: null, lastAddr: null,
      });
    }
  }

  pool(): PoolIdentity {
    const r = this.db.query<PoolRecord, []>("SELECT * FROM pool").get();
    if (r === null) throw new Error("no pool");
    return toPool(r);
  }

  /** Whether a pool secret is set here. */
  hasSecret(): boolean {
    return this.pool().poolSecret !== "";
  }

  /**
   * Sets the pool's name and secret (its id follows from them) and, when that is another pool than before, starts the
   * roster over with this node alone (`resetRoster`): the nodes of the old pool, or of no pool, are not this pool's
   * members until they prove the new secret. The same name and secret again change nothing. The settings and the
   * tokens stay: they are this node's, and merge with the pool's as any member's do.
   */
  setSecret(self: { nodeId: string; hostname: string }, name: string, secret: string, now: string = new Date().toISOString()): PoolIdentity {
    const { id } = poolKey(name, secret);
    return this.db.transaction(() => {
      const before = this.db.query("SELECT 1 FROM pool").get() === null ? null : this.pool();
      if (before?.poolId === id) return before;
      if (before === null) {
        this.db.query("INSERT INTO pool (pool_id, pool_secret, created_at, name) VALUES (?, ?, ?, ?)").run(id, secret, now, name);
      } else {
        this.db.query("UPDATE pool SET pool_id = ?, pool_secret = ?, created_at = ?, name = ?").run(id, secret, now, name);
      }
      this.resetRoster(self, now);
      return this.pool();
    })();
  }

  /** Starts the roster over with this node alone, as a member from `now` (whatever its old row said of it). */
  resetRoster(self: { nodeId: string; hostname: string }, now: string = new Date().toISOString()): void {
    this.db.transaction(() => {
      this.db.exec("DELETE FROM roster");
      this.ensureSelf(self, now);
    })();
  }

  /**
   * The status of `nodeId`'s row after making sure it has one: a node that proved the secret and was never heard of
   * gets a provisional member row (named by its short id, `updatedAt` PROVISIONAL_AT, added by `by`, at `addr` when
   * one is known), which the row it sends of itself replaces at the first sync.
   */
  ensureMember(nodeId: string, by: string, addr: WireAddr | null = null): RosterRow["status"] {
    return this.db.transaction(() => {
      const row = this.row(nodeId);
      if (row !== null) return row.status;
      this.upsert({
        nodeId, hostname: shortId(nodeId), status: "member", updatedAt: PROVISIONAL_AT, addedBy: by,
        summary: null, lastSeenAt: null, lastAddr: addr,
      });
      return "member";
    })();
  }

  /**
   * Makes a removed node a member again, at `now` or 1 ms after its row's `updatedAt` when that is later, as `remove`
   * dates its change; false when the node has no row here.
   */
  allow(nodeId: string, now: string = new Date().toISOString()): boolean {
    return this.db.transaction(() => {
      const row = this.row(nodeId);
      if (row === null) return false;
      this.db.query("UPDATE roster SET status = 'member', updated_at = ? WHERE node_id = ?").run(this.after(row, now), nodeId);
      return true;
    })();
  }

  /** `now`, or 1 ms after the row's `updatedAt` when that is later (another node's clock may be ahead of this one's). */
  private after(row: RosterRow, now: string): string {
    const at = Date.parse(row.updatedAt);
    const floor = Number.isFinite(at) ? new Date(at + 1).toISOString() : now;
    return floor > now ? floor : now;
  }

  roster(): RosterRow[] {
    return this.db.query<RosterRecord, []>("SELECT * FROM roster ORDER BY node_id").all().map(toRow);
  }

  members(): RosterRow[] {
    return this.db.query<RosterRecord, []>("SELECT * FROM roster WHERE status = 'member' ORDER BY node_id").all().map(toRow);
  }

  row(nodeId: string): RosterRow | null {
    const r = this.db.query<RosterRecord, [string]>("SELECT * FROM roster WHERE node_id = ?").get(nodeId);
    return r === null ? null : toRow(r);
  }

  isMember(nodeId: string): boolean {
    return this.row(nodeId)?.status === "member";
  }

  upsert(row: WireRosterRow): void {
    this.db.query(
      `INSERT OR REPLACE INTO roster (node_id, hostname, status, updated_at, added_by, summary, last_seen_at, last_addr)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.nodeId, row.hostname, row.status, row.updatedAt, row.addedBy,
      row.summary === null ? null : JSON.stringify(row.summary), row.lastSeenAt,
      row.lastAddr === null ? null : JSON.stringify(row.lastAddr),
    );
  }

  /**
   * Folds a peer's roster into this one: membership fields when the remote `updatedAt` is newer,
   * presence fields when the remote `lastSeenAt` is newer. Returns true when any row changed.
   */
  merge(rows: WireRosterRow[]): boolean {
    return this.db.transaction(() => {
      let changed = false;
      for (const remote of rows) {
        const local = this.row(remote.nodeId);
        if (local === null) {
          this.upsert(remote);
          changed = true;
          continue;
        }
        const next: WireRosterRow = { ...local };
        let rowChanged = false;
        if (remote.updatedAt > local.updatedAt) {
          next.hostname = remote.hostname;
          next.status = remote.status;
          next.updatedAt = remote.updatedAt;
          next.addedBy = remote.addedBy;
          rowChanged = true;
        }
        if (typeof remote.lastSeenAt === "string" && (local.lastSeenAt === null || remote.lastSeenAt > local.lastSeenAt)) {
          next.summary = remote.summary;
          next.lastSeenAt = remote.lastSeenAt;
          next.lastAddr = remote.lastAddr;
          rowChanged = true;
        }
        if (rowChanged) {
          this.upsert(next);
          changed = true;
        }
      }
      return changed;
    })();
  }

  /**
   * Marks `nodeId` removed at `now`, or 1 ms after its row's `updatedAt` when that is later (another node's clock may
   * be ahead of this one's): a removal always supersedes the row it acts on.
   */
  remove(nodeId: string, now: string = new Date().toISOString()): void {
    this.db.transaction(() => {
      const row = this.row(nodeId);
      if (row === null) return;
      this.db.query("UPDATE roster SET status = 'removed', updated_at = ? WHERE node_id = ?").run(this.after(row, now), nodeId);
    })();
  }

  /** Records that `nodeId` was heard from at `at`; membership and `updatedAt` are left alone. */
  seen(nodeId: string, at: string, summary: NodeSummary | null, addr: WireAddr | null): void {
    this.db.query("UPDATE roster SET summary = ?, last_seen_at = ?, last_addr = ? WHERE node_id = ?").run(
      summary === null ? null : JSON.stringify(summary), at, addr === null ? null : JSON.stringify(addr), nodeId,
    );
  }
}
