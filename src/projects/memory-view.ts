// src/projects/memory-view.ts — reads a project's memory repo for the dashboard: its entries on disk, the history
// under `memory`, a file at a change and a change's diff. Read-only, and no jj call here snapshots the working copy
// (`--ignore-working-copy`): an agent may be mid-turn writing there, and its writes belong to that turn's sync.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { NodeConfig } from "../config";
import { jj, JjError } from "../jj";
import { MEMORY_BOOKMARK } from "../memory";

export type MemoryChange = {
  change: string;
  /** The author timestamp, ISO 8601 in UTC. */
  at: string;
  node: string | null;
  task: string | null;
  kind: "task" | "dashboard" | "import" | "node" | "other";
  /** The description's first line. */
  description: string;
  files: string[];
  added: number;
  removed: number;
};

export type MemoryEntry = {
  path: string;
  size: number;
  /** sha256 hex of the bytes on disk. */
  hash: string;
  name: string | null;
  description: string | null;
  type: string | null;
  /** The newest change under `memory` touching the path; null when the file is not in it yet. */
  last: MemoryChange | null;
};

const INDEX = "MEMORY.md";
const FIELD = "\x1f";
const FILE = "\x1e";

/** One line per change: its id, author time, lines added and removed, files touched, and description's first line. */
const CHANGE_TEMPLATE = [
  "change_id",
  'author.timestamp().utc().format("%Y-%m-%dT%H:%M:%S%.3fZ")',
  "self.diff().stat().total_added()",
  "self.diff().stat().total_removed()",
  'self.diff().files().map(|f| f.path()).join("\\x1e")',
  "description.first_line()",
].join(' ++ "\\x1f" ++ ') + ' ++ "\\n"';

/** Every change of the memory history (none before the first import or sync). */
const HISTORY = `::present(${MEMORY_BOOKMARK}) ~ root()`;

/** The `---` block at the top only: top-level `name`, `description` and `type`, and `type` nested under `metadata:`. */
export function parseFrontmatter(text: string): { name: string | null; description: string | null; type: string | null } {
  const lines = text.split(/\r?\n/);
  const found = { name: null as string | null, description: null as string | null, type: null as string | null };
  if (lines[0]?.trimEnd() !== "---") return found;
  let metadataType: string | null = null;
  let section: string | null = null;
  for (const line of lines.slice(1)) {
    if (line.trimEnd() === "---") break;
    const m = /^(\s*)([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, indent, key, raw] = m as unknown as [string, string, string, string];
    if (indent === "") {
      section = key;
      if (key === "name" || key === "description" || key === "type") found[key] = unquote(raw);
    } else if (section === "metadata" && key === "type") {
      metadataType = unquote(raw);
    }
  }
  return { ...found, type: metadataType ?? found.type };
}

/** A YAML scalar's value: quotes taken off; empty is null. */
function unquote(raw: string): string | null {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  return value === "" ? null : value;
}

/**
 * Every memory file (`isMemoryPath`) in the repo's top folder on disk that is a regular file (never a symlink: peers
 * push to a memory repo), `MEMORY.md` first, then by `name ?? path`.
 */
export async function memoryEntries(cfg: NodeConfig, repo: string): Promise<MemoryEntry[]> {
  const files = (await readdir(repo, { withFileTypes: true })).filter((d) => d.isFile() && isMemoryPath(d.name)).map((d) => d.name);
  const entries = await Promise.all(
    files.map(async (path): Promise<MemoryEntry | null> => {
      const bytes = await readRegular(repo, path);
      if (bytes === null) return null;
      const [last] = await changes(cfg, repo, `(${HISTORY}) & files(${fileset(path)})`, 1);
      return {
        path,
        size: bytes.length,
        hash: createHash("sha256").update(bytes).digest("hex"),
        ...parseFrontmatter(bytes.toString("utf8")),
        last: last ?? null,
      };
    }),
  );
  const key = (e: MemoryEntry) => e.name ?? e.path;
  return entries.filter((e) => e !== null).sort((a, b) => Number(b.path === INDEX) - Number(a.path === INDEX) || key(a).localeCompare(key(b)));
}

/**
 * The file on disk, or at `change` (a change id, or its parent as `<change>-`); null when it is absent there, when
 * `path` is not a memory path (`isMemoryPath`), or when on disk it is not a regular file (a symlink is never followed).
 */
export async function memoryFile(cfg: NodeConfig, repo: string, path: string, change?: string): Promise<string | null> {
  if (!isMemoryPath(path)) return null;
  if (change === undefined) return (await readRegular(repo, path))?.toString("utf8") ?? null;
  try {
    return await jj(["--ignore-working-copy", "file", "show", "-r", revision(change), fileset(path)], repo, cfg);
  } catch (err) {
    if (err instanceof JjError && err.stderr.includes("No such path")) return null;
    throw err;
  }
}

/** The bytes of `path` in `repo` when it is a regular file there; null when absent, a symlink (never followed) or not a file. */
async function readRegular(repo: string, path: string): Promise<Buffer | null> {
  let file;
  try {
    file = await open(join(repo, path), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ELOOP") return null;
    throw err;
  }
  try {
    return (await file.stat()).isFile() ? await file.readFile() : null;
  } finally {
    await file.close();
  }
}

/** The history under `memory`, newest first: only changes touching `path` when given, starting below `before` when given. */
export async function memoryHistory(
  cfg: NodeConfig, repo: string, opts: { before?: string; limit: number; path?: string },
): Promise<MemoryChange[]> {
  let revset = `(${HISTORY})`;
  if (opts.before !== undefined) revset += ` & ::(${revision(opts.before)}-)`;
  if (opts.path !== undefined) {
    if (!isMemoryPath(opts.path)) return [];
    revset += ` & files(${fileset(opts.path)})`;
  }
  return changes(cfg, repo, revset, opts.limit);
}

/** `change`'s diff, in git's format. */
export async function memoryDiff(cfg: NodeConfig, repo: string, change: string): Promise<string> {
  return jj(["--ignore-working-copy", "diff", "--git", "-r", revision(change)], repo, cfg);
}

async function changes(cfg: NodeConfig, repo: string, revset: string, limit: number): Promise<MemoryChange[]> {
  const out = await jj(["--ignore-working-copy", "log", "--no-graph", "-r", revset, "-n", String(limit), "-T", CHANGE_TEMPLATE], repo, cfg);
  return out.split("\n").filter(Boolean).map(parseChange);
}

function parseChange(line: string): MemoryChange {
  const [change = "", at = "", added = "0", removed = "0", files = "", ...rest] = line.split(FIELD);
  const description = rest.join(FIELD);
  return {
    change,
    at,
    ...author(description),
    description,
    files: files === "" ? [] : files.split(FILE),
    added: Number(added),
    removed: Number(removed),
  };
}

/** Who a change's description says made it. */
function author(description: string): Pick<MemoryChange, "kind" | "node" | "task"> {
  let m = /^memory from (\S+): task (\S+)$/.exec(description);
  if (m) return { kind: "task", node: m[1]!, task: m[2]! };
  m = /^memory from (\S+)$/.exec(description);
  if (m) return { kind: "node", node: m[1]!, task: null };
  if (description === "memory: dashboard") return { kind: "dashboard", node: null, task: null };
  if (description.startsWith("import memory from ")) return { kind: "import", node: null, task: null };
  return { kind: "other", node: null, task: null };
}

/** A memory file's name: a `*.md` file in the repo's top folder, named as the dashboard can write it. */
export function isMemoryPath(path: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(path);
}

/** Exactly the file `path` at the repo's root, as a jj fileset. */
function fileset(path: string): string {
  return `root-file:${JSON.stringify(path)}`;
}

/** A change or commit id (or a bookmark name), or its parent as `<id>-`; never a wider revset. */
function revision(id: string): string {
  if (!/^[0-9a-z]+-?$/.test(id)) throw new Error(`not a change id: ${id}`);
  return id;
}
