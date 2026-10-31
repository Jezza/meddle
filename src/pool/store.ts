import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";

/** What a node reports about itself to the rest of the pool. */
export type NodeSummary = { hostname: string; version: string; claudeCodeVersion: string; hostsTasks: boolean; taskCount: number };

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

export type PoolIdentity = { poolId: string; poolSecret: string; createdAt: string };

type PoolRecord = { pool_id: string; pool_secret: string; created_at: string };

type RosterRecord = {
  node_id: string; hostname: string; status: RosterRow["status"]; updated_at: string; added_by: string;
  summary: string | null; last_seen_at: string | null; last_addr: string | null;
};

const INVITE_TTL_MS = 24 * 3600_000;

function toRow(r: RosterRecord): RosterRow {
  return {
    nodeId: r.node_id,
    hostname: r.hostname,
    status: r.status,
    updatedAt: r.updated_at,
    addedBy: r.added_by,
    summary: r.summary === null ? null : (JSON.parse(r.summary) as NodeSummary),
    lastSeenAt: r.last_seen_at,
    lastAddr: r.last_addr === null ? null : (JSON.parse(r.last_addr) as WireAddr),
  };
}

function toPool(r: PoolRecord): PoolIdentity {
  return { poolId: r.pool_id, poolSecret: r.pool_secret, createdAt: r.created_at };
}

/** The pool's identity, its roster and its outstanding invites, in `meddle.sqlite`. */
export class PoolStore {
  constructor(private readonly db: Database) {}

  /** Creates a pool of one (this node) when there is none; returns the pool either way. */
  ensurePool(self: { nodeId: string; hostname: string }, now: string = new Date().toISOString()): PoolIdentity {
    return this.db.transaction(() => {
      if (this.db.query("SELECT 1 FROM pool").get() === null) {
        this.db.query("INSERT INTO pool (pool_id, pool_secret, created_at) VALUES (?, ?, ?)")
          .run(randomBytes(16).toString("hex"), randomBytes(32).toString("hex"), now);
      }
      if (this.row(self.nodeId) === null) {
        this.upsert({
          nodeId: self.nodeId, hostname: self.hostname, status: "member", updatedAt: now, addedBy: self.nodeId,
          summary: null, lastSeenAt: null, lastAddr: null,
        });
      }
      return this.pool();
    })();
  }

  pool(): PoolIdentity {
    const r = this.db.query<PoolRecord, []>("SELECT * FROM pool").get();
    if (r === null) throw new Error("no pool");
    return toPool(r);
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

  upsert(row: RosterRow): void {
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
  merge(rows: RosterRow[]): boolean {
    return this.db.transaction(() => {
      let changed = false;
      for (const remote of rows) {
        const local = this.row(remote.nodeId);
        if (local === null) {
          this.upsert(remote);
          changed = true;
          continue;
        }
        const next = { ...local };
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
      const after = Date.parse(row.updatedAt);
      const floor = Number.isFinite(after) ? new Date(after + 1).toISOString() : now;
      this.db.query("UPDATE roster SET status = 'removed', updated_at = ? WHERE node_id = ?").run(floor > now ? floor : now, nodeId);
    })();
  }

  /** Records that `nodeId` was heard from at `at`; membership and `updatedAt` are left alone. */
  seen(nodeId: string, at: string, summary: NodeSummary | null, addr: WireAddr | null): void {
    this.db.query("UPDATE roster SET summary = ?, last_seen_at = ?, last_addr = ? WHERE node_id = ?").run(
      summary === null ? null : JSON.stringify(summary), at, addr === null ? null : JSON.stringify(addr), nodeId,
    );
  }

  /** Replaces this node's pool and roster with another pool's, as when it joins that pool; drops outstanding invites. */
  replacePool(pool: PoolIdentity, roster: RosterRow[]): void {
    this.db.transaction(() => {
      this.db.exec("DELETE FROM pool");
      this.db.exec("DELETE FROM roster");
      // An invite issued for the old pool must not admit anyone into the new one.
      this.db.exec("DELETE FROM invites");
      this.db.query("INSERT INTO pool (pool_id, pool_secret, created_at) VALUES (?, ?, ?)")
        .run(pool.poolId, pool.poolSecret, pool.createdAt);
      for (const row of roster) this.upsert(row);
    })();
  }

  /** A single-use invite code, valid for 24 hours. */
  createInvite(now: Date = new Date()): { code: string; expiresAt: string } {
    const code = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now.getTime() + INVITE_TTL_MS).toISOString();
    this.db.query("INSERT INTO invites (code, created_at, expires_at, used_at) VALUES (?, ?, ?, NULL)")
      .run(code, now.toISOString(), expiresAt);
    return { code, expiresAt };
  }

  /** Marks `code` used; true only when it exists, is unused and has not expired. */
  consumeInvite(code: string, now: Date = new Date()): boolean {
    const at = now.toISOString();
    const result = this.db.query("UPDATE invites SET used_at = ? WHERE code = ? AND used_at IS NULL AND expires_at > ?")
      .run(at, code, at);
    return result.changes === 1;
  }
}
