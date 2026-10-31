import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { paths, type NodeConfig } from "./config";

const YEAR_MS = 365 * 86400_000;

function metaFile(cfg: NodeConfig): string {
  return join(paths(cfg).secrets, "claude-token.meta.json");
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

async function writePrivate(file: string, contents: string): Promise<void> {
  await writeFile(file, contents, { mode: 0o600 });
  await chmod(file, 0o600);
}

/** Who set the token and when: `setBy` is the node id it came from, absent when set on this node by hand. */
type TokenMeta = { setAt?: string; setBy?: string };

export async function setToken(cfg: NodeConfig, token: string, meta?: TokenMeta): Promise<void> {
  const trimmed = token.trim();
  if (trimmed === "") throw new Error("empty token");
  await writePrivate(paths(cfg).tokenFile, trimmed);
  const setAt = meta?.setAt ?? new Date().toISOString();
  await writePrivate(metaFile(cfg), JSON.stringify({ setAt, setBy: meta?.setBy ?? null }));
}

export async function getToken(cfg: NodeConfig): Promise<string | null> {
  try {
    return (await readFile(paths(cfg).tokenFile, "utf8")).trim();
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

export async function tokenStatus(
  cfg: NodeConfig,
): Promise<{ present: boolean; setAt?: string; setBy?: string; expiresAt?: string }> {
  let mtime: Date;
  try {
    mtime = (await stat(paths(cfg).tokenFile)).mtime;
  } catch (err) {
    if (isMissing(err)) return { present: false };
    throw err;
  }
  let setAt: string;
  let setBy: string | null = null;
  try {
    const meta = JSON.parse(await readFile(metaFile(cfg), "utf8")) as { setAt: string; setBy?: string | null };
    setAt = meta.setAt;
    setBy = meta.setBy ?? null;
  } catch (err) {
    if (!isMissing(err)) throw err;
    setAt = mtime.toISOString();
  }
  const expiresAt = new Date(new Date(setAt).getTime() + YEAR_MS).toISOString();
  return setBy === null ? { present: true, setAt, expiresAt } : { present: true, setAt, setBy, expiresAt };
}
