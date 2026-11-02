import { homedir } from "node:os";
import { join, resolve } from "node:path";

export { paths, ensureDataDirs, checkTaskRoot } from "./paths";

export type NodeConfig = {
  dataDir: string;
  taskRoot: string;
  port: number;
  home: string;
  claudeHome: string;
  envPassthrough: string[];
  /** The iroh-lighthouse used to find the pool's members; "" disables discovery. */
  lighthouseUrl: string;
  /** `MEDDLE_LIGHTHOUSE_URL` is set (even empty): it wins over the pool's `lighthouse.url` setting. */
  lighthouseUrlExplicit: boolean;
  irohPreset: "n0" | "minimal";
  /** The iroh endpoint's bind address; null (unset or empty) for iroh's default. */
  irohBind: string | null;
  discoveryPollMs: number;
  /** The unix socket the git remote helper reaches this node at; null (unset or empty) for `<data>/git.sock`. */
  gitSocket: string | null;
  /** How long a jj command that talks to a peer (fetch, push, clone, the import after a push) may run; default 120 s. */
  jjNetworkTimeoutMs: number;
  /** How many turns may run at once on this node, `MEDDLE_MAX_RUNNING`; null (unset) for the pool's `limits.running`. */
  maxRunning: number | null;
  /**
   * What the pool's settings add to the environment of jj and of Claude Code (`JJ_USER`, `JJ_EMAIL`, `env.*`).
   * `{}` from `loadConfig`; owned by `PoolSettings.apply`, which replaces the object on every change.
   */
  poolEnv: Record<string, string>;
};

export const DEFAULT_ENV_PASSTHROUGH = [
  "TERM", "LANG", "LC_ALL", "SHELL", "TMPDIR", "XDG_RUNTIME_DIR",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
];

function parsePort(raw: string | undefined): number {
  if (raw === undefined) return 7777;
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isInteger(n)) throw new Error("MEDDLE_PORT must be an integer");
  return n;
}

function parseIrohPreset(raw: string | undefined): "n0" | "minimal" {
  if (raw === undefined) return "n0";
  if (raw !== "n0" && raw !== "minimal") throw new Error("MEDDLE_IROH_PRESET must be n0 or minimal");
  return raw;
}

function parseDiscoveryPollMs(raw: string | undefined): number {
  if (raw === undefined) return 10000;
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isInteger(n) || n < 500) {
    throw new Error("MEDDLE_DISCOVERY_POLL_MS must be an integer of at least 500");
  }
  return n;
}

function parseJjNetworkTimeoutMs(raw: string | undefined): number {
  if (raw === undefined) return 120_000;
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isInteger(n) || n < 1) throw new Error("MEDDLE_JJ_NETWORK_TIMEOUT_MS must be a positive integer");
  return n;
}

function parseMaxRunning(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error("MEDDLE_MAX_RUNNING must be a non-negative integer");
  return Number(raw);
}

export function loadConfig(env: Record<string, string | undefined> = process.env): NodeConfig {
  const home = env.HOME ?? homedir();
  return {
    dataDir: resolve(env.MEDDLE_DATA_DIR ?? join(home, ".local/share/meddle")),
    taskRoot: resolve(env.MEDDLE_TASK_ROOT ?? "/opt/meddle/tasks"),
    port: parsePort(env.MEDDLE_PORT),
    home,
    claudeHome: resolve(env.CLAUDE_CONFIG_DIR ?? join(home, ".claude")),
    envPassthrough: env.MEDDLE_ENV_PASSTHROUGH === undefined
      ? [...DEFAULT_ENV_PASSTHROUGH]
      : env.MEDDLE_ENV_PASSTHROUGH.split(" ").filter((name) => name !== ""),
    lighthouseUrl: env.MEDDLE_LIGHTHOUSE_URL ?? "https://iroh.ichor.io",
    lighthouseUrlExplicit: env.MEDDLE_LIGHTHOUSE_URL !== undefined,
    irohPreset: parseIrohPreset(env.MEDDLE_IROH_PRESET),
    // Empty is unset, as for the lighthouse: iroh's default bind address.
    irohBind: env.MEDDLE_IROH_BIND === undefined || env.MEDDLE_IROH_BIND === "" ? null : env.MEDDLE_IROH_BIND,
    discoveryPollMs: parseDiscoveryPollMs(env.MEDDLE_DISCOVERY_POLL_MS),
    gitSocket: env.MEDDLE_GIT_SOCKET === undefined || env.MEDDLE_GIT_SOCKET === "" ? null : resolve(env.MEDDLE_GIT_SOCKET),
    jjNetworkTimeoutMs: parseJjNetworkTimeoutMs(env.MEDDLE_JJ_NETWORK_TIMEOUT_MS),
    maxRunning: parseMaxRunning(env.MEDDLE_MAX_RUNNING),
    poolEnv: {},
  };
}
