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
  };
}
