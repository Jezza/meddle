import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureDataDirs, loadConfig, paths, type NodeConfig } from "../src/config";
import { applyPlugins, listChanges, ownPluginsDir, readPluginList, recordPlugins, type PluginList } from "../src/plugins";
import { profileHooks } from "../src/profile";

async function node(): Promise<{ cfg: NodeConfig; home: string; close(): Promise<void> }> {
  const home = await mkdtemp("/tmp/meddle-plugins-");
  const cfg = loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/d`, MEDDLE_TASK_ROOT: `${home}/t` });
  await ensureDataDirs(cfg);
  await mkdir(paths(cfg).profile, { recursive: true });
  return { cfg, home, close: () => rm(home, { recursive: true, force: true }) };
}

/** Writes Claude Code's bookkeeping into `dir` for `plugins` (name@marketplace → version), installed under `dir`. */
async function installed(dir: string, plugins: Record<string, string>, marketplaces: Record<string, string> = { mk: "o/mk" }): Promise<void> {
  await mkdir(dir, { recursive: true });
  const entries = Object.fromEntries(Object.entries(plugins).map(([id, version]) => [id, [{
    scope: "user", installPath: `${dir}/cache/${id.split("@")[1]}/${id.split("@")[0]}/${version}`, version,
  }]]));
  await writeFile(join(dir, "installed_plugins.json"), JSON.stringify({ version: 2, plugins: entries }, null, 2));
  const known = Object.fromEntries(Object.entries(marketplaces).map(([m, repo]) => [m, {
    source: { source: "github", repo }, installLocation: `${dir}/marketplaces/${m}`,
  }]));
  await writeFile(join(dir, "known_marketplaces.json"), JSON.stringify(known, null, 2));
}

const list = (plugins: Record<string, string>): PluginList => ({
  plugins: Object.fromEntries(Object.entries(plugins).map(([id, version]) => [id, { version }])),
  marketplaces: { mk: { source: { source: "github", repo: "o/mk" } } },
});

test("ownPluginsDir replaces a link to ~/.claude/plugins with a copy whose paths point at it", async () => {
  const { cfg, home, close } = await node();
  try {
    const theirs = `${home}/.claude/plugins`;
    await installed(theirs, { "superpowers@mk": "7.0.2" });
    const own = paths(cfg).plugins;
    await rm(own, { recursive: true, force: true });
    await symlink(theirs, own);
    await ownPluginsDir(cfg);
    expect((await lstat(own)).isSymbolicLink()).toBe(false);
    const text = await readFile(join(own, "installed_plugins.json"), "utf8");
    expect(text).toContain(`${own}/cache/mk/superpowers/7.0.2`);
    expect(text).not.toContain(theirs);
    expect(await readFile(join(own, "known_marketplaces.json"), "utf8")).toContain(`${own}/marketplaces/mk`);
    // ~/.claude's own stays as it was.
    expect(await readFile(join(theirs, "installed_plugins.json"), "utf8")).toContain(`${theirs}/cache`);
  } finally {
    await close();
  }
});

test("ownPluginsDir leaves meddle's own directory alone", async () => {
  const { cfg, close } = await node();
  try {
    await installed(paths(cfg).plugins, { "a@mk": "1.0.0" });
    const before = await readFile(join(paths(cfg).plugins, "installed_plugins.json"), "utf8");
    await ownPluginsDir(cfg);
    expect(await readFile(join(paths(cfg).plugins, "installed_plugins.json"), "utf8")).toBe(before);
  } finally {
    await close();
  }
});

test("listChanges finds adds, removals and upgrades, never a downgrade", () => {
  expect(listChanges(list({ "a@mk": "1.0.0", "b@mk": "2.0.0", "c@mk": "3.0.0" }), list({ "a@mk": "1.2.0", "c@mk": "2.9.9", "d@mk": "0.1.0" })))
    .toEqual({ add: ["d@mk"], remove: ["b@mk"], upgrade: ["a@mk"] });
  expect(listChanges(list({ "a@mk": "1.10.0" }), list({ "a@mk": "1.9.0" }))).toEqual({ add: [], remove: [], upgrade: [] });
});

test("recordPlugins writes only what changed on this node into the pool's list", async () => {
  const { cfg, close } = await node();
  try {
    const own = paths(cfg).plugins;
    await installed(own, { "a@mk": "1.0.0", "x@mk": "1.0.0" });
    // First look: what is installed is where this node starts, not a change.
    expect(await recordPlugins(cfg)).toBe(false);
    // The pool's list as another node left it: x removed there.
    await writeFile(join(paths(cfg).profile, "plugins.json"), JSON.stringify(list({ "a@mk": "1.0.0" }), null, 2));
    // Here a new plugin goes in; x, still installed here, is not put back.
    await installed(own, { "a@mk": "1.0.0", "x@mk": "1.0.0", "n@mk": "0.1.0" });
    expect(await recordPlugins(cfg)).toBe(true);
    expect(await readPluginList(cfg)).toEqual(list({ "a@mk": "1.0.0", "n@mk": "0.1.0" }));
  } finally {
    await close();
  }
});

test("applyPlugins installs, upgrades and uninstalls to match the pool's list", async () => {
  const { cfg, close } = await node();
  try {
    const own = paths(cfg).plugins;
    await installed(own, { "old@mk": "1.0.0", "keep@mk": "1.0.0", "gone@mk": "1.0.0" });
    await writeFile(join(paths(cfg).profile, "plugins.json"), JSON.stringify(list({ "old@mk": "1.0.0", "keep@mk": "1.0.0", "gone@mk": "1.0.0" }), null, 2));
    await applyPlugins(cfg, async () => {});
    // The pool's list moves on: old upgraded, gone removed, fresh added, from a new marketplace.
    const next: PluginList = {
      plugins: { "old@mk": { version: "2.0.0" }, "keep@mk": { version: "1.0.0" }, "fresh@other": { version: "1.0.0" } },
      marketplaces: { mk: { source: { source: "github", repo: "o/mk" } }, other: { source: { source: "github", repo: "o/other" } } },
    };
    await writeFile(join(paths(cfg).profile, "plugins.json"), JSON.stringify(next, null, 2));
    const ran: string[][] = [];
    await applyPlugins(cfg, async (args) => { ran.push(args); });
    expect(ran).toEqual([
      ["plugin", "marketplace", "add", "o/other"],
      ["plugin", "install", "fresh@other"],
      ["plugin", "update", "old@mk"],
      ["plugin", "uninstall", "gone@mk"],
    ]);
  } finally {
    await close();
  }
});

test("applyPlugins without a pool list does nothing", async () => {
  const { cfg, close } = await node();
  try {
    await installed(paths(cfg).plugins, { "a@mk": "1.0.0" });
    const ran: string[][] = [];
    await applyPlugins(cfg, async (args) => { ran.push(args); });
    expect(ran).toEqual([]);
  } finally {
    await close();
  }
});

test("an installed_plugins.json that can't be read records nothing, and its next good read changes nothing", async () => {
  const { cfg, close } = await node();
  try {
    const own = paths(cfg).plugins;
    await installed(own, { "a@mk": "1.0.0", "b@mk": "1.0.0" });
    expect(await recordPlugins(cfg)).toBe(false);
    await writeFile(join(paths(cfg).profile, "plugins.json"), JSON.stringify(list({ "a@mk": "1.0.0", "b@mk": "1.0.0" }), null, 2));
    // Caught mid-write by Claude Code, and in a shape this meddle does not know.
    for (const text of ['{"version": 2, "plugins": {"a@mk": [', '{"version": 1, "plugins": {"a@mk": {"version": "1.0.0"}}}']) {
      await writeFile(join(own, "installed_plugins.json"), text);
      expect(await recordPlugins(cfg)).toBe(false);
      expect(await readPluginList(cfg)).toEqual(list({ "a@mk": "1.0.0", "b@mk": "1.0.0" }));
    }
    await installed(own, { "a@mk": "1.0.0", "b@mk": "1.0.0" });
    expect(await recordPlugins(cfg)).toBe(false);
    expect(await readPluginList(cfg)).toEqual(list({ "a@mk": "1.0.0", "b@mk": "1.0.0" }));
  } finally {
    await close();
  }
});

test("the profile's passes apply the list on the first one and retry after a failure, not only when it moves", async () => {
  const { cfg, close } = await node();
  try {
    await installed(paths(cfg).plugins, {});
    await writeFile(join(paths(cfg).profile, "plugins.json"), JSON.stringify(list({ "x@mk": "1.0.0" }), null, 2));
    let fail = true;
    const ran: string[][] = [];
    const hooks = profileHooks(cfg, async (args) => {
      ran.push(args);
      if (fail) throw new Error("marketplace unreachable");
    }, () => {});
    await hooks.afterPass!(false);
    expect(ran).toEqual([["plugin", "install", "x@mk"]]);
    fail = false;
    await hooks.afterPass!(false);
    expect(ran).toHaveLength(2);
    // Applied (as far as this node knows): nothing more until the list moves.
    await hooks.afterPass!(false);
    expect(ran).toHaveLength(2);
  } finally {
    await close();
  }
});
