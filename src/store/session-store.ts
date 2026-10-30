import type { Database } from "bun:sqlite";
import type { SessionKey, SessionStore, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";

function entryTs(entry: SessionStoreEntry): number {
  const parsed = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

/** Mirrors Claude Code's transcript lines into the `transcript` table. */
export class SqliteSessionStore implements SessionStore {
  constructor(private readonly db: Database) {}

  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    const insert = this.db.query(
      `INSERT OR IGNORE INTO transcript (project_key, session_id, subpath, seq, uuid, ts, json)
       SELECT $project_key, $session_id, $subpath, COALESCE(MAX(seq), 0) + 1, $uuid, $ts, $json
       FROM transcript WHERE project_key = $project_key AND session_id = $session_id AND subpath = $subpath`,
    );
    this.db.transaction(() => {
      for (const entry of entries) {
        insert.run({
          $project_key: key.projectKey,
          $session_id: key.sessionId,
          $subpath: key.subpath ?? "",
          $uuid: typeof entry.uuid === "string" ? entry.uuid : null,
          $ts: entryTs(entry),
          $json: JSON.stringify(entry),
        });
      }
    })();
  }

  /**
   * Always null. When `load` returns entries the SDK resumes from a temporary
   * config directory of its own, which carries neither the task's profile
   * symlinks nor its memory. meddle resumes through Claude Code's own files
   * under the task's config dir and keeps this store as a mirror only; use
   * `loadStored` to read the mirrored entries.
   */
  async load(_key: SessionKey): Promise<SessionStoreEntry[] | null> {
    return null;
  }

  async loadStored(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    const rows = this.db
      .query<{ json: string }, [string, string, string]>(
        "SELECT json FROM transcript WHERE project_key = ? AND session_id = ? AND subpath = ? ORDER BY seq",
      )
      .all(key.projectKey, key.sessionId, key.subpath ?? "");
    if (rows.length === 0) return null;
    return rows.map((row) => JSON.parse(row.json) as SessionStoreEntry);
  }

  async listSessions(projectKey: string): Promise<Array<{ sessionId: string; mtime: number }>> {
    return this.db
      .query<{ sessionId: string; mtime: number }, [string]>(
        "SELECT session_id AS sessionId, CAST(MAX(ts) AS INTEGER) AS mtime FROM transcript WHERE project_key = ? GROUP BY session_id",
      )
      .all(projectKey);
  }

  async listSubkeys(key: { projectKey: string; sessionId: string }): Promise<string[]> {
    return this.db
      .query<{ subpath: string }, [string, string]>(
        "SELECT DISTINCT subpath FROM transcript WHERE project_key = ? AND session_id = ? AND subpath != '' ORDER BY subpath",
      )
      .all(key.projectKey, key.sessionId)
      .map((row) => row.subpath);
  }

  async delete(key: SessionKey): Promise<void> {
    if (key.subpath === undefined) {
      this.db
        .query("DELETE FROM transcript WHERE project_key = ? AND session_id = ?")
        .run(key.projectKey, key.sessionId);
    } else {
      this.db
        .query("DELETE FROM transcript WHERE project_key = ? AND session_id = ? AND subpath = ?")
        .run(key.projectKey, key.sessionId, key.subpath);
    }
  }
}
