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
  /**
   * The line bookmark's commit: the workspace's working-copy change as of its last snapshot (`writeLineRows`), not
   * the workspace's live `@`.
   */
  workingCopy: boolean;
};

export type ProjectChanges = {
  /** The project's id. */
  project: string;
  name: string;
  /**
   * A local bookmark on a base commit (the project's default branch first, then any but a task's line, then a task's
   * line), else the first base's short change id.
   */
  start: string;
  /** Whether the line's bookmark is conflicted; its changes are then not listed. */
  conflicted: boolean;
  /**
   * `<base>..<line>` less what is on the project's default branch, newest first, at most `CHANGES_MAX`; none when the
   * line is absent or conflicted.
   */
  changes: TaskChange[];
};

/** Why a read was refused; its message is `<code>: <detail>`. */
export class ChangesError extends Error {
  constructor(
    public code: "bad-id" | "conflicted" | "outside" | "not-a-file" | "too-large",
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "ChangesError";
  }
}

/** The most changes `taskChanges` lists. */
export const CHANGES_MAX = 200;

/** The most `workspaceFile` reads. */
export const WORKSPACE_FILE_MAX = 2 * 1024 * 1024;

const FIELD = "\x1f";

/** One line per change; the description last, since it is the only free text. */
const CHANGE_TEMPLATE = [
  "change_id",
  "commit_id",
  "self.diff().files().len()",
  "self.diff().stat().total_added()",
  "self.diff().stat().total_removed()",
  "empty",
  "conflict",
  "description.first_line()",
].join(' ++ "\\x1f" ++ ') + ' ++ "\\n"';

/** One line per bookmark the probe lists: its remote (empty for a local one), name, conflict and target commits. */
const PROBE_TEMPLATE = 'if(present, ' + [
  "remote",
  "name",
  "conflict",
  'added_targets.map(|c| c.commit_id()).join(",")',
].join(' ++ "\\x1f" ++ ') + ' ++ "\\n")';

/** Where every task's line bookmarks are (`taskNamespace`). */
const TASK_BOOKMARKS = "meddle/task/";

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
  // Never `present()`: a base missing here must fail loudly, not widen the range to the whole history.
  return commits.length === 0 ? "root()" : commits.join(" | ");
}

/** A local bookmark as the probe lists it: its name, whether it is conflicted, and the commits it points at. */
type ProbeRow = { name: string; conflicted: boolean; targets: string[] };

/**
 * What `taskChanges` reads from in `p`: `rows`, the local bookmarks on the base commits (they name the start), the
 * task's line and the default branch, each with the commits it points at; `key`, the same twice for the same
 * `ProjectChanges`.
 */
export type ChangesProbe = { key: string; rows: ProbeRow[] };

/** `p`'s `ChangesProbe` for task `taskId` and the project's default branch, in one jj call. */
export async function changesProbe(
  cfg: NodeConfig, p: ManifestProject, taskId: string, defaultBranch: string | null,
): Promise<ChangesProbe> {
  // Names and `-r` list their union.
  const names = [lineSymbol(p, taskId), ...(defaultBranch === null ? [] : [JSON.stringify(defaultBranch)])].map((n) => `exact:${n}`);
  const out = await jj(
    ["--ignore-working-copy", "bookmark", "list", "-T", PROBE_TEMPLATE, ...names, "-r", baseRevset(p)],
    p.replica, cfg,
  );
  const local = out.split("\n").filter((row) => row.startsWith(FIELD));
  const rows = local.map((row): ProbeRow => {
    const [, name = "", conflict = "", targets = ""] = row.split(FIELD);
    return { name, conflicted: conflict === "true", targets: targets === "" ? [] : targets.split(",") };
  });
  return { key: [p.base.join(","), defaultBranch ?? "", ...local].join("\n"), rows };
}

/** A change or commit id, or its parent as `<id>-`; never a wider revset. */
function revision(id: string): string {
  if (!/^[0-9a-z]+-?$/.test(id)) throw new ChangesError("bad-id", id);
  return id;
}

/**
 * The task's changes in project `p`: `<base>..<line>` in the project's replica, less what is on
 * `options.defaultBranch` (the project's, when given), newest first and at most `CHANGES_MAX`; none when the line's
 * bookmark is not there, or is conflicted (`conflicted` then). The default branch is also the start's name when it is
 * on a base commit. Read off `options.probe` when given (`changesProbe` for the same default branch), else a new one.
 */
export async function taskChanges(
  cfg: NodeConfig, p: ManifestProject, taskId: string,
  options: { defaultBranch?: string | null; probe?: ChangesProbe } = {},
): Promise<ProjectChanges> {
  const defaultBranch = options.defaultBranch ?? null;
  const { rows } = options.probe ?? await changesProbe(cfg, p, taskId, defaultBranch);
  const lineRow = rows.find((r) => r.name === lineName(p, taskId));
  const start = await startName(cfg, p, rows, defaultBranch);
  const conflicted = lineRow?.conflicted === true;
  const at = lineRow?.targets[0];
  if (at === undefined || conflicted) return { project: p.id, name: p.name, start, conflicted, changes: [] };
  // The commits the probe saw, so that the list is the one its key stands for.
  const main = rows.find((r) => r.name === defaultBranch)?.targets ?? [];
  const range = `(${baseRevset(p)})..${at}${main.length === 0 ? "" : ` ~ ::(${main.join(" | ")})`}`;
  const listed = await jj(
    ["--ignore-working-copy", "log", "--no-graph", "--limit", String(CHANGES_MAX), "-r", range, "-T", CHANGE_TEMPLATE],
    p.replica, cfg,
  );
  const changes = listed.split("\n").filter(Boolean).map((row): TaskChange => {
    const [change = "", commit = "", files = "0", added = "0", removed = "0", empty = "", conflict = "", ...rest] = row.split(FIELD);
    return {
      change,
      commit,
      description: rest.join(FIELD),
      files: Number(files),
      added: Number(added),
      removed: Number(removed),
      empty: empty === "true",
      conflicted: conflict === "true",
      workingCopy: commit === at,
    };
  });
  return { project: p.id, name: p.name, start, conflicted, changes };
}

/**
 * A local bookmark on a base commit (`defaultBranch` first, then any but a task's line, then a task's line, each by
 * name), from the probe's `rows`; else the first base's short change id.
 */
async function startName(cfg: NodeConfig, p: ManifestProject, rows: readonly ProbeRow[], defaultBranch: string | null): Promise<string> {
  const rank = (name: string) => (name === defaultBranch ? 0 : name.startsWith(TASK_BOOKMARKS) ? 2 : 1);
  const named = rows.filter((r) => r.targets.some((c) => p.base.includes(c))).map((r) => r.name);
  const first = named.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))[0];
  if (first !== undefined) return first;
  const base = bases(p)[0];
  if (base === undefined) return "root";
  return (await jj(["--ignore-working-copy", "log", "--no-graph", "-r", base, "-T", "change_id.short(8)"], p.replica, cfg)).trim();
}

/**
 * A change's diff against its parent, in git's format; for `"all"`, the line's whole diff from its start, `""` when
 * the line is not there; rejects `conflicted` when the line's bookmark is. A task with several base commits (an edit
 * start on a merge) is diffed from the first: what `--from` their merge would be is not well defined.
 */
export async function changeDiff(cfg: NodeConfig, p: ManifestProject, taskId: string, change: string | "all"): Promise<string> {
  if (change !== "all") return jj(["--ignore-working-copy", "diff", "--git", "-r", revision(change)], p.replica, cfg);
  const from = bases(p)[0] ?? "root()";
  const { rows } = await changesProbe(cfg, p, taskId, null);
  const line = rows.find((r) => r.name === lineName(p, taskId));
  if (line?.conflicted === true) throw new ChangesError("conflicted", lineName(p, taskId));
  if (line === undefined || line.targets[0] === undefined) return "";
  return jj(["--ignore-working-copy", "diff", "--git", "--from", from, "--to", line.targets[0]], p.replica, cfg);
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
 * The file at `path` (absolute) as it is now in task `taskId`'s workspace of one of `projects` (for a task with none,
 * its folder, where its agent works: `cwdFor`), or null when it is absent. Its real path must be in one of those
 * folders' real paths (`..` and symlinks resolved), else `outside`; it
 * must be a regular file, else `not-a-file`, of at most `WORKSPACE_FILE_MAX` bytes, else `too-large`.
 *
 * The check stops a caller naming an arbitrary path. A folder on the path swapped for a symlink between the realpath
 * and the open could still lead outside, but only the workspace's own agent could win that race, and it runs as this
 * same user, so it can read such a file anyway.
 */
export async function workspaceFile(cfg: NodeConfig, projects: readonly ManifestProject[], taskId: string, path: string): Promise<string | null> {
  if (!isAbsolute(path)) throw new ChangesError("outside", path);
  const task = paths(cfg).task(taskId);
  const roots = projects.length === 0 ? [task] : projects.map((p) => join(task, p.workspace));
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
    // Its real path: a symlink put there since is not followed. Non-blocking: a FIFO opens at once, and is no file.
    file = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
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
