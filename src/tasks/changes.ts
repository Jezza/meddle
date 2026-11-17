// src/tasks/changes.ts — a task's changes in each of its projects, for the dashboard: the changes of its line since its
// start, a change's (or the whole line's) diff, a file at a revision, and a file as it is now in the task's workspace.
// Read-only, and no jj call here snapshots a working copy (`--ignore-working-copy`): the replica's may be the user's
// own checkout, and the task's workspace is its agent's, which may be mid-turn writing there; its work shows as of the
// last snapshot (`writeLineRows`, which also moves the line).
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { NodeConfig } from "../config";
import { jj, JjError } from "../jj";
import { paths } from "../paths";
import { memoryFileset as fileset } from "../projects/memory-names";
import { taskNamespace, type ManifestProject } from "./manifest";

export type TaskChange = {
  change: string;
  commit: string;
  /** The description's first line. */
  description: string;
  files: number;
  added: number;
  removed: number;
  empty: boolean;
  conflicted: boolean;
  /** The line's own commit: the bookmark sits on the workspace's working-copy change. */
  workingCopy: boolean;
};

export type ProjectChanges = {
  /** The project's id. */
  project: string;
  name: string;
  /** A local bookmark on a base commit (the project's default branch first), else the first base's short change id. */
  start: string;
  /** `<base>..<line>`, newest first. */
  changes: TaskChange[];
};

/** Why a read was refused; its message is `<code>: <detail>`. */
export class ChangesError extends Error {
  constructor(
    public code: "bad-id" | "outside" | "not-a-file" | "too-large",
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "ChangesError";
  }
}

/** The most `workspaceFile` reads. */
export const WORKSPACE_FILE_MAX = 2 * 1024 * 1024;

const FIELD = "\x1f";
const LIST = "\x1e";

/** One line per change; the description last, since it is the only free text. */
const CHANGE_TEMPLATE = [
  "change_id",
  "commit_id",
  "self.diff().files().len()",
  "self.diff().stat().total_added()",
  "self.diff().stat().total_removed()",
  "empty",
  "conflict",
  'local_bookmarks.map(|b| b.name()).join("\\x1e")',
  "description.first_line()",
].join(' ++ "\\x1f" ++ ') + ' ++ "\\n"';

/** One line per base commit: its id, short change id and local bookmarks. */
const BASE_TEMPLATE = ['commit_id', "change_id.short(8)", 'local_bookmarks.map(|b| b.name()).join("\\x1e")']
  .join(' ++ "\\x1f" ++ ') + ' ++ "\\n"';

/** The task's line in `p`: its bookmark's name. */
function lineName(p: ManifestProject, taskId: string): string {
  return `${taskNamespace(taskId)}${p.name}`;
}

/** The line as a revset symbol: a jj string literal, so that its `/`s are no operators. */
function lineSymbol(p: ManifestProject, taskId: string): string {
  return JSON.stringify(lineName(p, taskId));
}

/** The task's base commits in `p`, each checked to be a commit id (`COMMIT_ID` in `provision.ts`). */
function bases(p: ManifestProject): string[] {
  for (const c of p.base) if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(c)) throw new ChangesError("bad-id", c);
  return p.base;
}

/** The task's base commits in `p` as a revset (the root when it has none). */
function baseRevset(p: ManifestProject): string {
  const commits = bases(p);
  return commits.length === 0 ? "root()" : commits.map((c) => `present(${c})`).join(" | ");
}

/** A change or commit id, or its parent as `<id>-`; never a wider revset. */
function revision(id: string): string {
  if (!/^[0-9a-z]+-?$/.test(id)) throw new ChangesError("bad-id", id);
  return id;
}

/**
 * The task's changes in project `p`: `<base>..<line>` in the project's replica, newest first; none when the line's
 * bookmark is not there. `options.defaultBranch` (the project's) is the start's name when it is on a base commit.
 */
export async function taskChanges(
  cfg: NodeConfig, p: ManifestProject, taskId: string, options: { defaultBranch?: string | null } = {},
): Promise<ProjectChanges> {
  const line = lineName(p, taskId);
  const range = `(${baseRevset(p)})..present(${lineSymbol(p, taskId)})`;
  const [listed, start] = await Promise.all([
    jj(["--ignore-working-copy", "log", "--no-graph", "-r", range, "-T", CHANGE_TEMPLATE], p.replica, cfg),
    startName(cfg, p, options.defaultBranch ?? null),
  ]);
  const changes = listed.split("\n").filter(Boolean).map((row): TaskChange => {
    const [change = "", commit = "", files = "0", added = "0", removed = "0", empty = "", conflict = "", bookmarks = "", ...rest] = row.split(FIELD);
    return {
      change,
      commit,
      description: rest.join(FIELD),
      files: Number(files),
      added: Number(added),
      removed: Number(removed),
      empty: empty === "true",
      conflicted: conflict === "true",
      workingCopy: bookmarks.split(LIST).includes(line),
    };
  });
  return { project: p.id, name: p.name, start, changes };
}

/** A local bookmark on a base commit (`defaultBranch` first, then by name), else the first base's short change id. */
async function startName(cfg: NodeConfig, p: ManifestProject, defaultBranch: string | null): Promise<string> {
  const out = await jj(["--ignore-working-copy", "log", "--no-graph", "-r", baseRevset(p), "-T", BASE_TEMPLATE], p.replica, cfg);
  const rows = new Map(out.split("\n").filter(Boolean).map((row) => {
    const [commit = "", short = "", bookmarks = ""] = row.split(FIELD);
    return [commit, { short, bookmarks: bookmarks === "" ? [] : bookmarks.split(LIST).sort() }] as const;
  }));
  const bases = p.base.map((c) => rows.get(c)).filter((r) => r !== undefined);
  const bookmarks = bases.flatMap((r) => r.bookmarks);
  if (defaultBranch !== null && bookmarks.includes(defaultBranch)) return defaultBranch;
  return bookmarks[0] ?? bases[0]?.short ?? (p.base[0] ?? "root").slice(0, 8);
}

/**
 * A change's diff against its parent, in git's format; for `"all"`, the line's whole diff from its start, `""` when the
 * line is not there. A task with several base commits (an edit start on a merge) is diffed from the first: what
 * `--from` their merge would be is not well defined.
 */
export async function changeDiff(cfg: NodeConfig, p: ManifestProject, taskId: string, change: string | "all"): Promise<string> {
  if (change !== "all") return jj(["--ignore-working-copy", "diff", "--git", "-r", revision(change)], p.replica, cfg);
  const from = bases(p)[0] ?? "root()";
  const line = lineSymbol(p, taskId);
  const present = await jj(["--ignore-working-copy", "log", "--no-graph", "-r", `present(${line})`, "-T", '"x"'], p.replica, cfg);
  if (present === "") return "";
  return jj(["--ignore-working-copy", "diff", "--git", "--from", from, "--to", line], p.replica, cfg);
}

/**
 * The file `path` (from the repo's root) at `rev` (a change id, its parent as `<change>-`, or a commit id such as a
 * base's), or null when it is absent there.
 */
export async function changeFile(cfg: NodeConfig, p: ManifestProject, rev: string, path: string): Promise<string | null> {
  try {
    return await jj(["--ignore-working-copy", "file", "show", "-r", revision(rev), fileset(path)], p.replica, cfg);
  } catch (err) {
    if (err instanceof JjError && err.stderr.includes("No such path")) return null;
    throw err;
  }
}

/** Whether `path` is `root` or under it (both resolved). */
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel));
}

/**
 * The file at `path` (absolute) as it is now in task `taskId`'s workspace of one of `projects`, or null when it is
 * absent. Its real path must be in one of the workspaces' real paths (`..` and symlinks resolved), else `outside`; it
 * must be a regular file, else `not-a-file`, of at most `WORKSPACE_FILE_MAX` bytes, else `too-large`.
 */
export async function workspaceFile(cfg: NodeConfig, projects: readonly ManifestProject[], taskId: string, path: string): Promise<string | null> {
  if (!isAbsolute(path)) throw new ChangesError("outside", path);
  const roots = projects.map((p) => join(paths(cfg).task(taskId), p.workspace));
  const reals = (await Promise.all(roots.map((r) => realpath(r).catch(() => null)))).filter((r) => r !== null);
  // Refused before it is looked up, so that an absent path outside reads as outside, not as absent.
  if (![...roots, ...reals].some((r) => inside(r, resolve(path)))) throw new ChangesError("outside", path);
  let real: string;
  try {
    real = await realpath(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw err;
  }
  if (!reals.some((r) => inside(r, real))) throw new ChangesError("outside", path);
  let file;
  try {
    // Its real path: a symlink put there since is not followed.
    file = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP") throw new ChangesError("outside", path);
    throw err;
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new ChangesError("not-a-file", path);
    if (stat.size > WORKSPACE_FILE_MAX) throw new ChangesError("too-large", path);
    // At most one byte over the limit, however much it has grown since.
    const buffer = Buffer.alloc(WORKSPACE_FILE_MAX + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > WORKSPACE_FILE_MAX) throw new ChangesError("too-large", path);
    return buffer.subarray(0, length).toString("utf8");
  } finally {
    await file.close();
  }
}
