// Pool settings: a key/value table every member holds, merged last-writer-wins per key like the roster's membership,
// that gives every node of the pool the same jj identity, task environment, lighthouse and running limit.
import type { Database } from "bun:sqlite";
import type { NodeConfig } from "../config";

/** The keys a pool setting may have; `env.<NAME>` sets `<NAME>` for jj and for every task's Claude Code. */
export const SETTING_KEY = /^(jj\.user|jj\.email|lighthouse\.url|limits\.running|env\.[A-Z_][A-Z0-9_]*)$/;

/**
 * Environment names an `env.*` setting may not set (besides those starting with a `RESERVED_ENV_PREFIXES` entry):
 * what meddle sets itself, the token and API settings, the jj and git identity and config, and the loaders that could
 * hijack a child.
 */
export const RESERVED_ENV: Set<string> = new Set([
  "PATH", "HOME", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_PROJECT_DIR_NAME",
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
  "JJ_USER", "JJ_EMAIL", "JJ_CONFIG", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_DIR",
  "GIT_SSH_COMMAND", "GIT_EXEC_PATH", "XDG_CONFIG_HOME",
  "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT", "NODE_OPTIONS", "BASH_ENV", "MEDDLE_GIT_SOCKET",
]);

/** Every environment name starting with one of these is reserved too. */
export const RESERVED_ENV_PREFIXES: readonly string[] = ["MEDDLE_", "GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_"];

/** `name` is in `RESERVED_ENV` or starts with one of `RESERVED_ENV_PREFIXES`. */
export function reservedEnv(name: string): boolean {
  return RESERVED_ENV.has(name) || RESERVED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** One setting as stored and replicated; `value: null` is an unset (a tombstone, kept so the unset replicates). */
export type SettingRow = { key: string; value: string | null; updatedAt: string; setBy: string };

type SettingRecord = { key: string; value: string | null; updated_at: string; set_by: string };

const ENV_PREFIX = "env.";
const NON_NEGATIVE_INTEGER = /^\d+$/;
/** The longest value a setting may have: it goes into the environment of every jj and Claude Code. */
export const MAX_SETTING_VALUE = 4096;
/** Control characters other than tab: a NUL makes every spawn throw, the others have no place in a setting. */
const CONTROL = /[\x00-\x08\x0a-\x1f\x7f]/;
const BAD_VALUE = `setting value must be at most ${MAX_SETTING_VALUE} characters with no control characters`;
/** The keys whose value may not be empty: an empty jj identity overrides the node's own and jj refuses to push. */
const NON_EMPTY = new Set(["jj.user", "jj.email", "lighthouse.url"]);
/** The most distinct ignored keys logged; later ones are only counted. */
const MAX_LOGGED = 100;
/** How much of an ignored key a log line shows. */
const LOGGED_KEY_CHARS = 80;

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

/**
 * Why `value` may not be stored under `key` (`setting value must be …`, `<key> must not be empty`,
 * `limits.running must be …`), or null when it may.
 */
function valueProblem(key: string, value: string): string | null {
  if (value.length > MAX_SETTING_VALUE || CONTROL.test(value)) return BAD_VALUE;
  if (NON_EMPTY.has(key) && value === "") return `${key} must not be empty`;
  if (key === "limits.running" && nonNegativeInteger(value) === null) return "limits.running must be a non-negative integer";
  return null;
}

/**
 * Whether a replicated value may be stored: the checks every reader relies on (length, control characters, a
 * non-empty identity). An odd `limits.running` or an empty `lighthouse.url` is stored and the readers ignore it.
 */
function replicableValue(key: string, value: string | null): boolean {
  if (value === null) return true;
  if (value.length > MAX_SETTING_VALUE || CONTROL.test(value)) return false;
  return !((key === "jj.user" || key === "jj.email") && value === "");
}

/** Orders two rows of one key: the later `updatedAt`, then the greater `setBy`, then the greater value (null least). */
function newer(remote: SettingRow, local: SettingRow): boolean {
  if (remote.updatedAt !== local.updatedAt) return remote.updatedAt > local.updatedAt;
  if (remote.setBy !== local.setBy) return remote.setBy > local.setBy;
  if (remote.value === local.value) return false;
  if (local.value === null) return true;
  if (remote.value === null) return false;
  return remote.value > local.value;
}

/** The non-negative integer `raw` spells, else null. */
function nonNegativeInteger(raw: string): number | null {
  if (!NON_NEGATIVE_INTEGER.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * The pool's settings in `meddle.sqlite`. Local writes (`set`, `unset`) validate the key and value; replicated rows
 * (`merge`) are filtered by key and by what every reader needs of a value (`replicableValue`), and the readers
 * (`env`, `runningLimit`, `lighthouseUrl`) cope with the rest.
 * `apply` puts the settings into `cfg.poolEnv`, which `jjEnv` and the engine overlay on their environments.
 */
export class PoolSettings {
  /** Replicated rows dropped because of their key or value, since this object was made. */
  ignored = 0;
  /** The keys whose drop was logged already (at most `MAX_LOGGED`): each is logged once. */
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
    const problem = keyProblem(key) ?? valueProblem(key, value);
    if (problem !== null) throw new Error(problem);
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
   * string compare, as the roster's); on equal times the greater `setBy`, then the greater value wins, so that every
   * node ends on the same row. Rows with an invalid key, a reserved env name or a value no reader could use (too long,
   * a control character, an empty jj identity) are dropped, and each such key is logged once
   * (`meddle: settings: ignored replicated key "<key>"`, the key JSON-escaped and cut to 80 characters).
   * True when any row changed.
   */
  merge(rows: SettingRow[]): boolean {
    return this.db.transaction(() => {
      let changed = false;
      for (const remote of rows) {
        if (keyProblem(remote.key) !== null || !replicableValue(remote.key, remote.value)) {
          this.ignore(remote.key);
          continue;
        }
        const local = this.row(remote.key);
        if (local !== null && !newer(remote, local)) continue;
        this.upsert({ key: remote.key, value: remote.value, updatedAt: remote.updatedAt, setBy: remote.setBy });
        changed = true;
      }
      return changed;
    })();
  }

  /** Counts a dropped replicated row and logs its key, once per key and for at most `MAX_LOGGED` keys. */
  private ignore(key: string): void {
    this.ignored++;
    if (this.logged.has(key) || this.logged.size >= MAX_LOGGED) return;
    this.logged.add(key);
    this.log(`meddle: settings: ignored replicated key ${JSON.stringify(key.slice(0, LOGGED_KEY_CHARS))}`);
  }

  /**
   * The environment the settings give jj and Claude Code: `jj.user`, `jj.email` and `env.*`, reserved names and values
   * no spawn could take (or an empty identity) left out.
   */
  env(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const { key, value } of this.list()) {
      if (!replicableValue(key, value)) continue;
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
