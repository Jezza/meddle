import { cp, lstat, mkdir, readdir, rename, rm, rmdir, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { NodeConfig } from "./config";
import { paths } from "./paths";
import { initColocated, isJjRepo, jj } from "./jj";

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

export async function seedProfile(cfg: NodeConfig): Promise<void> {
  const profile = paths(cfg).profile;
  if (await isJjRepo(profile)) return;
  const staging = `${profile}.seeding`;
  await rm(staging, { recursive: true, force: true });
  await initColocated(staging);
  for (const entry of PROFILE_ENTRIES) {
    const src = join(cfg.claudeHome, entry);
    const dst = join(staging, entry);
    if (await exists(src)) await cp(src, dst, { recursive: true, dereference: true });
    else await createDefault(entry, dst);
  }
  await jj(
    ["commit", "-m", `seed profile from ${cfg.claudeHome}`, "--config", 'snapshot.max-new-file-size="50MiB"'],
    staging,
  );
  if (await exists(profile)) await rmdir(profile);
  await rename(staging, profile);
}

export async function ensurePlugins(cfg: NodeConfig): Promise<void> {
  const plugins = paths(cfg).plugins;
  const source = join(cfg.claudeHome, "plugins");
  let current: "missing" | "empty" | "other" = "missing";
  try {
    const st = await lstat(plugins);
    if (st.isSymbolicLink()) return;
    current = st.isDirectory() && (await readdir(plugins)).length === 0 ? "empty" : "other";
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (current === "other") return;
  if (await exists(source)) {
    if (current === "empty") await rmdir(plugins);
    await symlink(source, plugins);
  } else if (current === "missing") {
    await mkdir(plugins, { recursive: true });
  }
}

export async function linkProfile(configDir: string, cfg: NodeConfig): Promise<void> {
  const p = paths(cfg);
  await mkdir(configDir, { recursive: true });
  const links: [string, string][] = PROFILE_ENTRIES.map((entry) => [entry, join(p.profile, entry)]);
  links.push(["plugins", p.plugins]);
  for (const [name, target] of links) {
    const at = join(configDir, name);
    await rm(at, { recursive: true, force: true });
    await symlink(target, at);
  }
}
