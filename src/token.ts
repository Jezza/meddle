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

export async function setToken(cfg: NodeConfig, token: string): Promise<void> {
  const trimmed = token.trim();
  if (trimmed === "") throw new Error("empty token");
  await writePrivate(paths(cfg).tokenFile, trimmed);
  await writePrivate(metaFile(cfg), JSON.stringify({ setAt: new Date().toISOString() }));
}

export async function getToken(cfg: NodeConfig): Promise<string | null> {
  try {
    return (await readFile(paths(cfg).tokenFile, "utf8")).trim();
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

export async function tokenStatus(cfg: NodeConfig): Promise<{ present: boolean; setAt?: string; expiresAt?: string }> {
  let mtime: Date;
  try {
    mtime = (await stat(paths(cfg).tokenFile)).mtime;
  } catch (err) {
    if (isMissing(err)) return { present: false };
    throw err;
  }
  let setAt: string;
  try {
    setAt = (JSON.parse(await readFile(metaFile(cfg), "utf8")) as { setAt: string }).setAt;
  } catch (err) {
    if (!isMissing(err)) throw err;
    setAt = mtime.toISOString();
  }
  const expiresAt = new Date(new Date(setAt).getTime() + YEAR_MS).toISOString();
  return { present: true, setAt, expiresAt };
}
