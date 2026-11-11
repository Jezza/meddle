// Pool settings: a key/value table every member holds, merged last-writer-wins per key like the roster's membership,
// that gives every node of the pool the same jj identity, task environment, lighthouse and running limit.
import type { Database } from "bun:sqlite";
import type { NodeConfig } from "../config";

/** The keys a pool setting may have; `env.<NAME>` sets `<NAME>` for jj and for every task's Claude Code. */
export const SETTING_KEY = /^(jj\.user|jj\.email|lighthouse\.url|limits\.running|roster\.forget|defaults\.model|defaults\.effort|env\.[A-Z_][A-Z0-9_]*)$/;

/** How long a member goes unheard of before it is gone (`roster.forget`'s default): three lighthouse announce TTLs. */
export const DEFAULT_FORGET_SECS = 900;
/** The shortest `roster.forget` other than 0: a member is reported every 15 s, so a shorter one would make it flap. */
export const MIN_FORGET_SECS = 60;

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
/** The one form of `updatedAt` a replicated row may carry: what `new Date().toISOString()` prints. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** The longest key a setting may have: an `env.*` name goes into the environment of every jj and Claude Code. */
export const MAX_SETTING_KEY = 256;
/** The most the settings add to an environment, counting each name's and value's length; later entries are left out. */
export const MAX_POOL_ENV = 65536;
/**
 * Control characters (C0 other than tab, DEL and C1): a NUL makes every spawn throw, and the others could print a
 * terminal escape in `config list`.
 */
const CONTROL = /[\x00-\x08\x0a-\x1f\x7f-\x9f]/;
const BAD_VALUE = `setting value must be at most ${MAX_SETTING_VALUE} characters with no control characters`;
/** The keys whose value may not be empty: an empty jj identity overrides the node's own and jj refuses to push. */
const NON_EMPTY = new Set(["jj.user", "jj.email", "lighthouse.url", "defaults.model"]);
/** The efforts `defaults.effort` may name. */
export const EFFORT_LEVELS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];
/** The most distinct ignored keys logged; later ones are only counted. */
const MAX_LOGGED = 100;
/** How much of an ignored key a log line shows. */
const LOGGED_KEY_CHARS = 80;

function toRow(r: SettingRecord): SettingRow {
  return { key: r.key, value: r.value, updatedAt: r.updated_at, setBy: r.set_by };
}

/** Why `key` may not be stored (`invalid setting key: …`, `reserved environment name: …`), or null when it may. */
function keyProblem(key: string): string | null {
  if (key.length > MAX_SETTING_KEY || !SETTING_KEY.test(key)) return `invalid setting key: ${key.slice(0, LOGGED_KEY_CHARS)}`;
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
  if (key === "defaults.effort" && !EFFORT_LEVELS.includes(value)) return `defaults.effort must be one of ${EFFORT_LEVELS.join(", ")}`;
  if (key === "roster.forget") {
    const secs = nonNegativeInteger(value);
    if (secs === null || (secs !== 0 && secs < MIN_FORGET_SECS)) return `roster.forget must be 0 or at least ${MIN_FORGET_SECS} (seconds)`;
  }
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
  /** `env()` logged that the settings exceed `MAX_POOL_ENV`: it says so once. */
  private loggedOversize = false;
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
   * a control character, an empty jj identity) or an `updatedAt` that is not a millisecond ISO time (a time that is
   * not one would sort above every real one, or make the next local write throw) are dropped, and each such key is
   * logged once
   * (`meddle: settings: ignored replicated key "<key>"`, the key JSON-escaped and cut to 80 characters).
   * True when any row changed.
   */
  merge(rows: SettingRow[]): boolean {
    return this.db.transaction(() => {
      let changed = false;
      for (const remote of rows) {
        if (
          keyProblem(remote.key) !== null || !replicableValue(remote.key, remote.value) ||
          !ISO_TIME.test(remote.updatedAt)
        ) {
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

  /**
   * Counts a dropped replicated row and logs its key, once per key (as cut to `LOGGED_KEY_CHARS`, so keys that differ
   * only further on share a line and the set stays small) and for at most `MAX_LOGGED` keys.
   */
  private ignore(key: string): void {
    this.ignored++;
    const shown = key.slice(0, LOGGED_KEY_CHARS);
    if (this.logged.has(shown) || this.logged.size >= MAX_LOGGED) return;
    this.logged.add(shown);
    this.log(`meddle: settings: ignored replicated key ${JSON.stringify(shown)}`);
  }

  /**
   * The environment the settings give jj and Claude Code: `jj.user`, `jj.email` and `env.*`, in key order, with
   * invalid keys, reserved names and values no spawn could take (or an empty identity) left out. Once the names and
   * values added would exceed `MAX_POOL_ENV` characters, no later entry is added (logged once: an environment that
   * large makes every spawn fail).
   */
  env(): Record<string, string> {
    const env: Record<string, string> = {};
    let total = 0;
    for (const { key, value } of this.list()) {
      if (keyProblem(key) !== null || !replicableValue(key, value)) continue;
      let name: string;
      if (key === "jj.user") name = "JJ_USER";
      else if (key === "jj.email") name = "JJ_EMAIL";
      else if (key.startsWith(ENV_PREFIX)) name = key.slice(ENV_PREFIX.length);
      else continue;
      if (total + name.length + value.length > MAX_POOL_ENV) {
        if (!this.loggedOversize) {
          this.loggedOversize = true;
          this.log("meddle: settings: environment over 64 KiB; later settings not applied");
        }
        break;
      }
      total += name.length + value.length;
      env[name] = value;
    }
    return env;
  }

  /** `MEDDLE_MAX_RUNNING` when the node sets it, else `limits.running` when it is a non-negative integer, else 0. */
  runningLimit(): number {
    if (this.cfg.maxRunning !== null) return this.cfg.maxRunning;
    const raw = this.get("limits.running");
    return raw === null ? 0 : nonNegativeInteger(raw) ?? 0;
  }

  /**
   * How long, in ms, a member may go unheard of before it is gone: `MEDDLE_FORGET_MS` when the node sets it, else
   * `roster.forget` (seconds; one below `MIN_FORGET_SECS` reads as that), else `DEFAULT_FORGET_SECS`; null when it is 0
   * (members are never forgotten).
   */
  forgetAfterMs(): number | null {
    if (this.cfg.forgetMs !== null) return this.cfg.forgetMs === 0 ? null : this.cfg.forgetMs;
    const raw = this.get("roster.forget");
    const secs = raw === null ? DEFAULT_FORGET_SECS : nonNegativeInteger(raw) ?? DEFAULT_FORGET_SECS;
    return secs === 0 ? null : Math.max(secs, MIN_FORGET_SECS) * 1000;
  }

  /** `defaults.model`, the model of a task that chose none; null when unset or empty (Claude Code then picks its own). */
  defaultModel(): string | null {
    const model = this.get("defaults.model");
    return model === null || model === "" ? null : model;
  }

  /** `defaults.effort`, the effort of a task that chose none; null when unset or not a known level. */
  defaultEffort(): string | null {
    const effort = this.get("defaults.effort");
    return effort !== null && EFFORT_LEVELS.includes(effort) ? effort : null;
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
