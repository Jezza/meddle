import { cp, lstat, mkdir, mkdtemp, readdir, rename, rm, rmdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NodeConfig } from "./config";
import { paths } from "./paths";
import { git, initColocated, isJjRepo, jj } from "./jj";
import { headOf, moveTo, prepareScopeRepo } from "./scopes/repo";
import type { Scope } from "./scopes/scope";
import type { ProfileHooks, ScopeSync } from "./scopes/sync";
import { applyPlugins, ownPluginsDir, recordPlugins, startPluginList, type PluginRun } from "./plugins";
import { repoKey, serialised } from "./serial";

const PROFILE: Scope = { kind: "profile" };

export const PROFILE_ENTRIES = ["CLAUDE.md", "settings.json", "skills", "agents", "commands", "hooks"] as const;

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function createDefault(entry: (typeof PROFILE_ENTRIES)[number], dst: string): Promise<void> {
  if (entry === "settings.json") await writeFile(dst, "{}");
  else if (entry === "CLAUDE.md") await writeFile(dst, "");
  else await mkdir(dst, { recursive: true });
}

/** This node's standing in the pool's profile (`Self` without the node): see `src/scopes/reconcile.ts`. */
export type ProfileStanding = { seed: string | null; edited: boolean; legacy: boolean };

/** Where a profile repo keeps its standing: its own git config. */
const STANDING = { legacy: "meddle.legacy", seed: "meddle.seed", edited: "meddle.edited" } as const;

/** Claude Code's own copy of the claude.ai account's skills: never part of the profile. */
const SYNCED_SKILLS = join("skills", "synced");

/** Copies the profile's entries (and `plugins.json`) from `from` to `to`, `skills/synced` left out. */
async function copyEntries(from: string, to: string, fill: boolean): Promise<void> {
  const synced = join(from, SYNCED_SKILLS);
  for (const entry of [...PROFILE_ENTRIES, "plugins.json"] as const) {
    const src = join(from, entry);
    const dst = join(to, entry);
    if (await exists(src)) await cp(src, dst, { recursive: true, dereference: true, filter: (path) => path !== synced && !path.startsWith(`${synced}/`) });
    else if (fill && entry !== "plugins.json") await createDefault(entry, dst);
  }
}

/** This node's standing in the profile, or null while it has no profile repo. */
export async function profileStanding(cfg: NodeConfig): Promise<ProfileStanding | null> {
  const dir = paths(cfg).profile;
  if (!(await isJjRepo(dir))) return null;
  const out = await git(["config", "--get-regexp", "^meddle\\."], dir, cfg).catch(() => "");
  const values = new Map(out.split("\n").filter((l) => l !== "").map((l) => {
    const space = l.indexOf(" ");
    return space < 0 ? [l, ""] as const : [l.slice(0, space), l.slice(space + 1)] as const;
  }));
  const legacy = values.get(STANDING.legacy);
  // A repo an older meddle seeded, not yet looked at by `seedProfile`: legacy.
  if (legacy === undefined || legacy === "true") return { seed: null, edited: true, legacy: true };
  const seed = values.get(STANDING.seed) ?? "";
  return { seed: seed === "" ? null : seed, edited: values.get(STANDING.edited) === "true", legacy: false };
}

/**
 * This node's standing as one word: `legacy` (an older meddle's profile, this node's alone until an import), `seed`
 * (seeded here, yielding to the pool's), `pool` (the pool's), `none` (no profile repo yet).
 */
export async function profileWord(cfg: NodeConfig): Promise<"legacy" | "seed" | "pool" | "none"> {
  const standing = await profileStanding(cfg);
  if (standing === null) return "none";
  if (standing.legacy) return "legacy";
  return standing.seed !== null && !standing.edited ? "seed" : "pool";
}

/** Records this node's standing in the profile. */
export async function saveStanding(cfg: NodeConfig, standing: ProfileStanding, dir = paths(cfg).profile): Promise<void> {
  await git(["config", STANDING.legacy, String(standing.legacy)], dir, cfg);
  await git(["config", STANDING.seed, standing.seed ?? ""], dir, cfg);
  await git(["config", STANDING.edited, String(standing.edited)], dir, cfg);
}

/**
 * The profile of a node with none: a repo seeded from this machine's `~/.claude` (`skills/synced` left out), its one
 * commit marked a seed (`meddle-seed: 1`), the line seed-only until something is written on it; it yields to the pool's
 * profile once it hears of one (spec 6.5). A profile an older meddle seeded (never synced) becomes legacy instead: kept
 * as it is and never published until `importProfile` (here or on another node) makes the pool's.
 */
export async function seedProfile(cfg: NodeConfig): Promise<void> {
  const profile = paths(cfg).profile;
  if (await isJjRepo(profile)) {
    await upgradeLegacyProfile(cfg);
    return;
  }
  const staging = `${profile}.seeding`;
  await rm(staging, { recursive: true, force: true });
  await initColocated(staging, cfg);
  await copyEntries(cfg.claudeHome, staging, true);
  // The plugins this node has are where the seed's list starts, not an edit of it.
  await startPluginList(cfg, staging);
  await jj(
    ["commit", "-m", `seed profile from ${cfg.claudeHome}\n\nmeddle-seed: 1`, "--config", 'snapshot.max-new-file-size="50MiB"'],
    staging,
    cfg,
  );
  const seed = (await jj(["log", "-r", "@-", "--no-graph", "-T", "commit_id"], staging, cfg)).trim();
  await jj(["bookmark", "set", "profile", "-r", "@-"], staging, cfg);
  await saveStanding(cfg, { seed, edited: false, legacy: false }, staging);
  if (await exists(profile)) await rmdir(profile);
  await rename(staging, profile);
}

/** A profile repo with no standing yet (an older meddle's): legacy, `skills/synced` dropped from its working copy. */
async function upgradeLegacyProfile(cfg: NodeConfig): Promise<void> {
  const dir = paths(cfg).profile;
  if ((await git(["config", "--get", STANDING.legacy], dir, cfg).catch(() => "")).trim() !== "") return;
  await rm(join(dir, SYNCED_SKILLS), { recursive: true, force: true });
  await saveStanding(cfg, { seed: null, edited: true, legacy: true });
}

/**
 * Makes the profile laid out in `dir` (like `~/.claude`; default this node's own profile) the pool's: a commit on top
 * of the pool's line when this node is on it (so it replaces it), else with no parent (so no node's earlier history
 * goes with it), holding its entries and `plugins.json` (`skills/synced` left out),
 * checked out here, this node's standing an imported line; then `sync` publishes it and every other node takes it.
 * Returns the commit.
 */
export async function importProfile(cfg: NodeConfig, dir: string, sync: ScopeSync | null): Promise<string> {
  const profile = paths(cfg).profile;
  const stage = await mkdtemp(join(tmpdir(), "meddle-profile-import-"));
  try {
    await copyEntries(dir, stage, false);
    const commit = await serialised(repoKey(profile), async () => {
      if (!(await isJjRepo(profile))) await initColocated(profile, cfg);
      await prepareScopeRepo(cfg, profile, PROFILE);
      // On the pool's line already: on top of it, so the import replaces it rather than merging with it. Otherwise (a
      // legacy profile, a seed, none) a new root, so no earlier history goes with it.
      const standing = await profileStanding(cfg);
      const onPool = standing !== null && !standing.legacy && standing.seed === null && (await headOf(cfg, profile, PROFILE)) !== null;
      await jj(["new", onPool ? "profile" : "root()"], profile, cfg);
      for (const entry of [...PROFILE_ENTRIES, "plugins.json"]) await rm(join(profile, entry), { recursive: true, force: true });
      await cp(stage, profile, { recursive: true });
      for (const entry of PROFILE_ENTRIES) if (!(await exists(join(profile, entry)))) await createDefault(entry, join(profile, entry));
      // Without a list of its own, the pool's plugins are this node's.
      if (!(await exists(join(profile, "plugins.json")))) await startPluginList(cfg, profile);
      await jj(["commit", "-m", `profile import from ${dir}`], profile, cfg);
      const made = (await jj(["log", "-r", "@-", "--no-graph", "-T", "commit_id"], profile, cfg)).trim();
      await moveTo(cfg, profile, PROFILE, made, `profile from ${dir}`);
      await saveStanding(cfg, { seed: null, edited: true, legacy: false });
      return made;
    });
    sync?.touched(PROFILE);
    return commit;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

/**
 * What the scope sync asks of the profile: this node's standing; before a commit, what changed in its plugins written
 * into the list; after a pass, its plugins brought to the list with `run` (none: left as they are) on the first pass,
 * whenever the head moved, and again after a pass where that failed.
 */
export function profileHooks(cfg: NodeConfig, run?: PluginRun, log?: (line: string) => void): ProfileHooks {
  let due = true;
  return {
    self: () => profileStanding(cfg),
    save: (standing) => saveStanding(cfg, standing),
    beforeCommit: async () => {
      if ((await profileStanding(cfg))?.legacy === false) await recordPlugins(cfg);
    },
    afterPass: async (moved) => {
      if (run === undefined || !(due || moved)) return;
      due = (await applyPlugins(cfg, run, log)) > 0;
    },
  };
}

/** Makes `<data>/plugins` meddle's own (`ownPluginsDir`): a copy of `~/.claude/plugins`, never a link to it. */
export async function ensurePlugins(cfg: NodeConfig): Promise<void> {
  await ownPluginsDir(cfg);
}

export async function linkProfile(configDir: string, cfg: NodeConfig): Promise<void> {
  const p = paths(cfg);
  await mkdir(configDir, { recursive: true });
  const links: [string, string][] = PROFILE_ENTRIES.map((entry) => [entry, join(p.profile, entry)]);
  links.push(["plugins", p.plugins], ["sessions", p.sessions]);
  for (const [name, target] of links) {
    const at = join(configDir, name);
    await rm(at, { recursive: true, force: true });
    await symlink(target, at);
  }
}
