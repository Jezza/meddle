// Helpers for tests of synced scopes: a node config with the merge driver written, scope repos in it, commits made by
// hand, and commits carried between repos by id.
import { afterAll } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ensureDataDirs, loadConfig, type NodeConfig } from "../src/config";
import { writeMergeDriver } from "../src/git/scripts";
import { git, jj } from "../src/jj";
import { prepareScopeRepo } from "../src/scopes/repo";
import type { Scope } from "../src/scopes/scope";

const homes: string[] = [];
afterAll(async () => {
  for (const h of homes) await rm(h, { recursive: true, force: true });
});

export const MEMORY: Scope = { kind: "memory", projectId: "p1" };
export const PROFILE: Scope = { kind: "profile" };

/** A node config in a fresh temp home, its merge driver written. */
export async function makeCfg(): Promise<NodeConfig> {
  const home = await mkdtemp("/tmp/meddle-scope-");
  homes.push(home);
  const cfg = loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/d`, MEDDLE_TASK_ROOT: `${home}/t` });
  await ensureDataDirs(cfg);
  await writeMergeDriver(cfg);
  return cfg;
}

/** A prepared scope repo at `<data>/<name>`. */
export async function scopeRepo(cfg: NodeConfig, s: Scope, name: string): Promise<string> {
  const dir = join(cfg.dataDir, name);
  await prepareScopeRepo(cfg, dir, s);
  return dir;
}

export const read = (path: string) => readFile(path, "utf8").catch(() => null);

/** Writes `files` into `dir` (null deletes one). */
export async function put(dir: string, files: Record<string, string | null>): Promise<void> {
  for (const [f, t] of Object.entries(files)) {
    if (t === null) await rm(join(dir, f), { force: true });
    else {
      await mkdir(dirname(join(dir, f)), { recursive: true });
      await writeFile(join(dir, f), t);
    }
  }
}

/** A commit on `parent` (null: a new root) holding `parent`'s files changed by `files`, made with jj; returns its id. */
export async function commitOn(cfg: NodeConfig, dir: string, parent: string | null, files: Record<string, string | null>, message = "edit"): Promise<string> {
  if (parent !== null) {
    await git(["update-ref", `refs/heads/t-${parent.slice(0, 12)}`, parent], dir, cfg);
    await jj(["new", parent], dir, cfg);
  } else {
    await jj(["new", "root()"], dir, cfg);
  }
  await put(dir, files);
  await jj(["commit", "-m", message], dir, cfg);
  return (await jj(["log", "-r", "@-", "--no-graph", "-T", "commit_id"], dir, cfg)).trim();
}

/** Fetches `commit` from repo `from` into repo `to` by id. */
export async function carry(cfg: NodeConfig, from: string, to: string, commit: string): Promise<void> {
  await git(["fetch", "--no-tags", from, `+${commit}:refs/meddle/fetched/${commit}`], to, cfg);
}

/** `file` as commit `rev` has it, or null. */
export function show(cfg: NodeConfig, dir: string, rev: string, file: string): Promise<string | null> {
  return git(["show", `${rev}:${file}`], dir, cfg).catch(() => null);
}

/** The files commit `rev` holds. */
export async function filesOf(cfg: NodeConfig, dir: string, rev: string): Promise<string[]> {
  return (await git(["ls-tree", "-r", "--name-only", rev], dir, cfg)).split("\n").filter((l) => l !== "");
}
