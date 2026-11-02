// Pool settings: a key/value table every member holds, merged last-writer-wins per key like the roster's membership,
// that gives every node of the pool the same jj identity, task environment, lighthouse and running limit.
import type { Database } from "bun:sqlite";
import type { NodeConfig } from "../config";

/** The keys a pool setting may have; `env.<NAME>` sets `<NAME>` for jj and for every task's Claude Code. */
export const SETTING_KEY = /^(jj\.user|jj\.email|lighthouse\.url|limits\.running|env\.[A-Z_][A-Z0-9_]*)$/;

/**
 * Environment names an `env.*` setting may not set (besides every `MEDDLE_*`): what meddle sets itself, the token and
 * API settings, the jj and git identity and config, and the loaders that could hijack a child.
 */
export const RESERVED_ENV: Set<string> = new Set([
  "PATH", "HOME", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_PROJECT_DIR_NAME",
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
  "JJ_USER", "JJ_EMAIL", "JJ_CONFIG", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_PARAMETERS", "GIT_DIR",
  "LD_PRELOAD", "LD_LIBRARY_PATH", "MEDDLE_GIT_SOCKET",
]);

/** `name` is in `RESERVED_ENV` or starts `MEDDLE_`. */
export function reservedEnv(name: string): boolean {
  return RESERVED_ENV.has(name) || name.startsWith("MEDDLE_");
}

/** One setting as stored and replicated; `value: null` is an unset (a tombstone, kept so the unset replicates). */
export type SettingRow = { key: string; value: string | null; updatedAt: string; setBy: string };

type SettingRecord = { key: string; value: string | null; updated_at: string; set_by: string };

const ENV_PREFIX = "env.";
const NON_NEGATIVE_INTEGER = /^\d+$/;

function toRow(r: SettingRecord): SettingRow {
  return { key: r.key, value: r.value, updatedAt: r.updated_at, setBy: r.set_by };
}

/** Why `key` may not be stored (`invalid setting key: …`, `reserved environment name: …`), or null when it may. */
function keyProblem(key: string): string | null {
  if (!SETTING_KEY.test(key)) return `invalid setting key: ${key}`;
  if (key.startsWith(ENV_PREFIX) && reservedEnv(key.slice(ENV_PREFIX.length))) {
    return `reserved environment name: ${key.slice(ENV_PREFIX.length)}`;
  }
  return null;
}

/** The non-negative integer `raw` spells, else null. */
function nonNegativeInteger(raw: string): number | null {
  if (!NON_NEGATIVE_INTEGER.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * The pool's settings in `meddle.sqlite`. Local writes (`set`, `unset`) validate the key and value; replicated rows
 * (`merge`) are filtered by key only, and the readers (`env`, `runningLimit`, `lighthouseUrl`) cope with any value.
 * `apply` puts the settings into `cfg.poolEnv`, which `jjEnv` and the engine overlay on their environments.
 */
export class PoolSettings {
  /** Replicated rows dropped because of their key, since this object was made. */
  ignored = 0;
  /** The keys whose drop was logged already: each is logged once. */
  private readonly logged = new Set<string>();
  private readonly log: (line: string) => void;

  constructor(
    private readonly db: Database,
    private readonly cfg: NodeConfig,
    private readonly selfId: string,
    log?: (line: string) => void,
  ) {
    this.log = log ?? ((line) => console.error(line));
  }

  private row(key: string): SettingRow | null {
    const r = this.db.query<SettingRecord, [string]>("SELECT * FROM settings WHERE key = ?").get(key);
    return r === null ? null : toRow(r);
  }

  private upsert(row: SettingRow): void {
    this.db.query("INSERT OR REPLACE INTO settings (key, value, updated_at, set_by) VALUES (?, ?, ?, ?)")
      .run(row.key, row.value, row.updatedAt, row.setBy);
  }

  /** The value of `key`, or null when it is unset. */
  get(key: string): string | null {
    return this.row(key)?.value ?? null;
  }

  /** Every setting with a value, by key. */
  list(): { key: string; value: string }[] {
    return this.db.query<{ key: string; value: string }, []>("SELECT key, value FROM settings WHERE value IS NOT NULL ORDER BY key").all();
  }

  /** Every row, tombstones included, by key: what a peer merges. */
  rows(): SettingRow[] {
    return this.db.query<SettingRecord, []>("SELECT * FROM settings ORDER BY key").all().map(toRow);
  }

  /**
   * Sets `key` to `value` as this node, at `now` or 1 ms after the row's `updatedAt` when that is later (another node's
   * clock may be ahead of this one's): a local write always supersedes the row it acts on.
   */
  set(key: string, value: string, now: string = new Date().toISOString()): SettingRow {
    const problem = keyProblem(key);
    if (problem !== null) throw new Error(problem);
    if (key === "limits.running" && nonNegativeInteger(value) === null) throw new Error("limits.running must be a non-negative integer");
    if (key === "lighthouse.url" && value === "") throw new Error("lighthouse.url must not be empty");
    return this.write(key, value, now);
  }

  /** Unsets `key` (a tombstone, so the unset replicates), with `set`'s timestamp rule. */
  unset(key: string, now: string = new Date().toISOString()): SettingRow {
    const problem = keyProblem(key);
    if (problem !== null) throw new Error(problem);
    return this.write(key, null, now);
  }

  private write(key: string, value: string | null, now: string): SettingRow {
    return this.db.transaction(() => {
      const local = this.row(key);
      const after = local === null ? NaN : Date.parse(local.updatedAt);
      const floor = Number.isFinite(after) ? new Date(after + 1).toISOString() : now;
      const row: SettingRow = { key, value, updatedAt: floor > now ? floor : now, setBy: this.selfId };
      this.upsert(row);
      return row;
    })();
  }

  /**
   * Folds a peer's rows into this node's: a row is taken when its `updatedAt` is later than the local one's (an ISO
   * string compare, as the roster's). Rows with an invalid key or a reserved env name are dropped, and each such key
   * is logged once (`meddle: settings: ignored replicated key <key>`). True when any row changed.
   */
  merge(rows: SettingRow[]): boolean {
    return this.db.transaction(() => {
      let changed = false;
      for (const remote of rows) {
        if (keyProblem(remote.key) !== null) {
          this.ignored++;
          if (!this.logged.has(remote.key)) {
            this.logged.add(remote.key);
            this.log(`meddle: settings: ignored replicated key ${remote.key}`);
          }
          continue;
        }
        const local = this.row(remote.key);
        if (local !== null && !(remote.updatedAt > local.updatedAt)) continue;
        this.upsert({ key: remote.key, value: remote.value, updatedAt: remote.updatedAt, setBy: remote.setBy });
        changed = true;
      }
      return changed;
    })();
  }

  /** The environment the settings give jj and Claude Code: `jj.user`, `jj.email` and `env.*`, reserved names left out. */
  env(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const { key, value } of this.list()) {
      if (key === "jj.user") env.JJ_USER = value;
      else if (key === "jj.email") env.JJ_EMAIL = value;
      else if (key.startsWith(ENV_PREFIX)) {
        const name = key.slice(ENV_PREFIX.length);
        if (!reservedEnv(name)) env[name] = value;
      }
    }
    return env;
  }

  /** `MEDDLE_MAX_RUNNING` when the node sets it, else `limits.running` when it is a non-negative integer, else 0. */
  runningLimit(): number {
    if (this.cfg.maxRunning !== null) return this.cfg.maxRunning;
    const raw = this.get("limits.running");
    return raw === null ? 0 : nonNegativeInteger(raw) ?? 0;
  }

  /** `lighthouse.url`, or null when it is unset or empty (a replicated empty value must not reach discovery). */
  lighthouseUrl(): string | null {
    const url = this.get("lighthouse.url");
    return url === null || url === "" ? null : url;
  }

  /** Puts `env()` into `cfg.poolEnv` (a new object each time). Called at start and after every change. */
  apply(): void {
    this.cfg.poolEnv = this.env();
  }
}

/**
 * The lighthouse discovery uses now: the node's own `MEDDLE_LIGHTHOUSE_URL` when it sets one (even empty), else the
 * pool's `lighthouse.url`, else the default.
 */
export function discoveryLighthouseUrl(cfg: NodeConfig, settings: PoolSettings): string {
  if (cfg.lighthouseUrlExplicit) return cfg.lighthouseUrl;
  return settings.lighthouseUrl() ?? cfg.lighthouseUrl;
}
