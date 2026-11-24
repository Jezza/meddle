// Plugins across the pool. Each node installs plugins into its own `<data>/plugins` (Claude Code's plugin directory for
// every task: caches, marketplaces as git clones, bookkeeping with absolute paths), never synced itself. What is synced
// is the list: `plugins.json` in the profile, the plugins the pool wants (`<name>@<marketplace>` and version) and where
// each marketplace comes from. A node writes into the list only what changed in its own directory since it last looked
// (`recordPlugins`), so it never puts back a plugin another node removed; and brings its directory to the list
// (`applyPlugins`) with Claude Code's own `plugin` commands: installs what is missing, upgrades to a newer listed version
// (never down), uninstalls what the list dropped.
import { cp, lstat, mkdir, readdir, readFile, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { NodeConfig } from "./config";
import { paths } from "./paths";

/** The plugins the pool wants, by `<name>@<marketplace>`, and each marketplace's source as Claude Code records it. */
export type PluginList = { plugins: Record<string, { version: string }>; marketplaces: Record<string, { source: unknown }> };

/** Runs Claude Code with `args` (`plugin install …`); rejects when it fails. */
export type PluginRun = (args: string[]) => Promise<void>;

const empty = (): PluginList => ({ plugins: {}, marketplaces: {} });

/** The list in the profile, or null when it has none. */
export async function readPluginList(cfg: NodeConfig): Promise<PluginList | null> {
  return readJson<PluginList>(join(paths(cfg).profile, "plugins.json"));
}

/** Where a node keeps the pool's list as it last applied it, and its own directory's list as it last recorded it. */
const applied = (cfg: NodeConfig) => join(cfg.dataDir, "plugins-applied.json");
const recorded = (cfg: NodeConfig) => join(cfg.dataDir, "plugins-recorded.json");

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** `value` as the profile keeps it: keys sorted, two-space indent, a final newline. */
function stable(value: PluginList): string {
  const sorted = <T>(o: Record<string, T>) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]!]));
  return `${JSON.stringify({ plugins: sorted(value.plugins), marketplaces: sorted(value.marketplaces) }, null, 2)}\n`;
}

/**
 * What this node's plugin directory holds, as a list; null when its bookkeeping is there but can't be read (caught
 * mid-write, or in a shape this meddle does not know): never mistaken for "nothing installed".
 */
export async function installedList(cfg: NodeConfig): Promise<PluginList | null> {
  const dir = paths(cfg).plugins;
  const list = empty();
  const text = await readFile(join(dir, "installed_plugins.json"), "utf8").catch(() => null);
  if (text !== null) {
    let installed: unknown;
    try {
      installed = JSON.parse(text);
    } catch {
      return null;
    }
    const plugins = (installed as { plugins?: unknown } | null)?.plugins;
    if (typeof plugins !== "object" || plugins === null) return null;
    for (const [id, entries] of Object.entries(plugins)) {
      if (!Array.isArray(entries)) return null;
      const version = (entries as Array<{ version?: unknown }>).find((e) => typeof e?.version === "string")?.version as string | undefined;
      if (version !== undefined) list.plugins[id] = { version };
    }
  }
  const known = await readJson<Record<string, { source?: unknown }>>(join(dir, "known_marketplaces.json"));
  for (const [name, m] of Object.entries(known ?? {})) if (m.source !== undefined) list.marketplaces[name] = { source: m.source };
  return list;
}

/** Whether version `a` is newer than `b` (dot-separated, numeric parts compared as numbers). */
function newer(a: string, b: string): boolean {
  const pa = a.split(".");
  const pb = b.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const [x, y] = [pa[i] ?? "0", pb[i] ?? "0"];
    if (x === y) continue;
    const [nx, ny] = [Number(x), Number(y)];
    if (Number.isFinite(nx) && Number.isFinite(ny)) return nx > ny;
    return x > y;
  }
  return false;
}

/** What changed from list `from` to list `to`: plugins added, removed, and upgraded (a lower version is no change). */
export function listChanges(from: PluginList, to: PluginList): { add: string[]; remove: string[]; upgrade: string[] } {
  const ids = (l: PluginList) => Object.keys(l.plugins);
  return {
    add: ids(to).filter((id) => from.plugins[id] === undefined).sort(),
    remove: ids(from).filter((id) => to.plugins[id] === undefined).sort(),
    upgrade: ids(to).filter((id) => from.plugins[id] !== undefined && newer(to.plugins[id]!.version, from.plugins[id]!.version)).sort(),
  };
}

/**
 * Writes into the profile's `plugins.json` what changed in this node's plugin directory since it last looked (the first
 * look only notes where it starts). True when the list changed.
 */
export async function recordPlugins(cfg: NodeConfig): Promise<boolean> {
  const now = await installedList(cfg);
  // Unreadable now: nothing is recorded, and the next good read compares with the last one.
  if (now === null) return false;
  const before = await readJson<PluginList>(recorded(cfg));
  await writeFile(recorded(cfg), stable(now));
  if (before === null) return false;
  const { add, remove, upgrade } = listChanges(before, now);
  if (add.length + remove.length + upgrade.length === 0) return false;
  const pool = (await readPluginList(cfg)) ?? empty();
  for (const id of [...add, ...upgrade]) {
    pool.plugins[id] = now.plugins[id]!;
    const market = id.slice(id.lastIndexOf("@") + 1);
    if (now.marketplaces[market] !== undefined) pool.marketplaces[market] = now.marketplaces[market]!;
  }
  for (const id of remove) delete pool.plugins[id];
  await writeFile(join(paths(cfg).profile, "plugins.json"), stable(pool));
  return true;
}

/** Writes this node's plugins as the profile's whole list, and notes them as recorded and applied (a seed, an import). */
export async function startPluginList(cfg: NodeConfig, profileDir = paths(cfg).profile): Promise<void> {
  const now = (await installedList(cfg)) ?? empty();
  await writeFile(join(profileDir, "plugins.json"), stable(now));
  await writeFile(recorded(cfg), stable(now));
  await writeFile(applied(cfg), stable(now));
}

/** A marketplace's source as `claude plugin marketplace add` takes it. */
function sourceArg(source: unknown): string | null {
  if (typeof source !== "object" || source === null) return null;
  const s = source as { repo?: unknown; url?: unknown; path?: unknown };
  for (const v of [s.repo, s.url, s.path]) if (typeof v === "string" && v !== "") return v;
  return null;
}

/**
 * Brings this node's plugin directory to the profile's list with `run` (Claude Code's `plugin` commands): marketplaces a
 * new plugin needs, installs, upgrades, then uninstalls of what the list dropped since this node last applied it. Each
 * failure is logged and left for the next time; resolves with how many failed. Nothing without a list.
 */
export async function applyPlugins(cfg: NodeConfig, run: PluginRun, log: (line: string) => void = (l) => console.error(l)): Promise<number> {
  const list = await readPluginList(cfg);
  if (list === null) return 0;
  const have = await installedList(cfg);
  if (have === null) {
    log("meddle: plugins: installed_plugins.json can't be read; nothing applied");
    return 1;
  }
  const last = (await readJson<PluginList>(applied(cfg))) ?? empty();
  const install = Object.keys(list.plugins).filter((id) => have.plugins[id] === undefined).sort();
  const update = Object.keys(list.plugins)
    .filter((id) => have.plugins[id] !== undefined && newer(list.plugins[id]!.version, have.plugins[id]!.version)).sort();
  const uninstall = Object.keys(last.plugins).filter((id) => list.plugins[id] === undefined && have.plugins[id] !== undefined).sort();
  const markets = [...new Set(install.map((id) => id.slice(id.lastIndexOf("@") + 1)))]
    .filter((m) => have.marketplaces[m] === undefined).sort();
  let failed = 0;
  const attempt = async (what: string, args: string[]) => {
    try {
      await run(args);
    } catch (err) {
      failed++;
      log(`meddle: plugin ${what}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    }
  };
  for (const m of markets) {
    const source = sourceArg(list.marketplaces[m]?.source);
    if (source === null) log(`meddle: plugin marketplace ${m}: no source to add it from`);
    else await attempt(`marketplace ${m}`, ["plugin", "marketplace", "add", source]);
  }
  for (const id of install) await attempt(id, ["plugin", "install", id]);
  for (const id of update) await attempt(id, ["plugin", "update", id]);
  for (const id of uninstall) await attempt(id, ["plugin", "uninstall", id]);
  await writeFile(applied(cfg), stable(list));
  // What this did is the pool's, not a change of this node's to record.
  const after = await installedList(cfg);
  if (after !== null) await writeFile(recorded(cfg), stable(after));
  return failed;
}

/**
 * Claude Code's `plugin` commands against this node's plugin directory: run from a config directory of their own
 * (`<data>/plugin-admin`) whose `plugins` is `<data>/plugins`.
 */
export function pluginRunner(cfg: NodeConfig, claude: string): PluginRun {
  return async (args) => {
    const admin = join(cfg.dataDir, "plugin-admin");
    await mkdir(admin, { recursive: true });
    const link = join(admin, "plugins");
    if ((await readlink(link).catch(() => null)) !== paths(cfg).plugins) {
      await rm(link, { recursive: true, force: true });
      await symlink(paths(cfg).plugins, link);
    }
    const proc = Bun.spawn([claude, ...args], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: admin }, stdin: "ignore", stdout: "ignore", stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    if (code !== 0) throw new Error(`claude ${args.join(" ")} exited with ${code}: ${stderr.trim()}`);
  };
}

/** Every string in `value` that starts with one of `from` + `/`, starting with `to` + `/` instead. */
function rewrite(value: unknown, from: string[], to: string): unknown {
  if (typeof value === "string") {
    for (const f of from) if (value === f || value.startsWith(`${f}/`)) return `${to}${value.slice(f.length)}`;
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => rewrite(v, from, to));
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewrite(v, from, to)]));
  return value;
}

/**
 * Makes `<data>/plugins` meddle's own directory: one that is a link (to `~/.claude/plugins`, as an older meddle made it),
 * or missing or empty while `~/.claude/plugins` exists, becomes a copy of it, the absolute paths in its bookkeeping
 * (`installed_plugins.json`, `known_marketplaces.json`) pointing into the copy; otherwise an empty directory when there
 * is none. A directory of its own is left as it is.
 */
export async function ownPluginsDir(cfg: NodeConfig): Promise<void> {
  const own = paths(cfg).plugins;
  const theirs = join(cfg.claudeHome, "plugins");
  const st = await lstat(own).catch(() => null);
  let source: string | null = null;
  let names: string[] = [theirs];
  if (st?.isSymbolicLink()) {
    const target = await readlink(own);
    source = await realpath(own).catch(() => null);
    names = [target, ...(source === null ? [] : [source]), theirs];
  } else if (st === null || (st.isDirectory() && (await readdir(own)).length === 0)) {
    source = (await lstat(theirs).catch(() => null))?.isDirectory() === true ? await realpath(theirs) : null;
    if (source !== null) names = [theirs, source];
  }
  if (source === null) {
    if (st?.isSymbolicLink()) await rm(own, { force: true });
    await mkdir(own, { recursive: true });
    return;
  }
  const copying = `${own}.copying`;
  await rm(copying, { recursive: true, force: true });
  await cp(source, copying, { recursive: true, verbatimSymlinks: true });
  for (const file of ["installed_plugins.json", "known_marketplaces.json"]) {
    const json = await readJson<unknown>(join(copying, file));
    if (json !== null) await writeFile(join(copying, file), `${JSON.stringify(rewrite(json, [...new Set(names)], own), null, 2)}\n`);
  }
  // The link (or the empty directory) goes first: a directory is never renamed onto either.
  await rm(own, { recursive: true, force: true });
  await rename(copying, own);
}
