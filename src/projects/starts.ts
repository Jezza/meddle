// Where a project of a new task starts, resolved on the project's home (Decisions 4 and 5): a revision (taken as a
// child of it, or edited in place), the fork point of the home folder's `@`, or a sync branch. A start at a revision
// writes the task's line there, so that the home holds it read-only. It never snapshots or moves the user's working
// copy: every read passes `--ignore-working-copy`.
import type { Database } from "bun:sqlite";
import type { NodeConfig } from "../config";
import { changesIn, gitImport, jj, JjError } from "../jj";
import { shortId } from "../pool/ids";
import { remoteReason } from "../pool/object";
import type { PoolRuntime } from "../pool/runtime";
import { repoKey, serialised } from "../serial";
import { PeerObject } from "../state/contracts";
import type { HandoffMode, Start } from "../tasks/manifest";
import { SAFE_ID } from "../tasks/provision";
import { noteStarting, releaseLines, writeLine } from "./lines";
import { getProject } from "./project";
import { findProject, type ProjectInfo } from "./replicas";

/** What jj (0.45) says of a revset that names no revision, or does not parse. */
const NOT_A_REVISION = /^Error: (Revision `.*` doesn't exist|Failed to parse revset: )/m;

/** What a start needs of its node: its config, database and id (which must be the project's home). */
export type StartDeps = { cfg: NodeConfig; db: Database; selfId: string };

const short = (change: string) => change.slice(0, 12);

/**
 * Resolves where task `taskId` starts in project `projectId`, which this node must be the home of, under
 * `handoff:<projectId>` and the home repo's key, after `gitImport`. With `rev` (`child` mode, or `edit` for working on
 * the revision W in place from its fork point) the start is that revision, unless it is one of the project's sync
 * branches: then a sync start (refused `--edit takes a revision, not the sync branch <b>` in `edit` mode). Without
 * `rev`, a folder project starts at the fork point of the folder's `@`, a url project from its first sync branch. A
 * line start writes the line (`writeLine`, named after the project) before
 * returning; a sync start writes nothing. Rejects with the reason when the start cannot be made, writing nothing, and
 * `invalid task id: <id>` for an id that is not one path segment of letters, digits, `-` and `_`.
 */
export async function startAt(deps: StartDeps, projectId: string, taskId: string, rev: string | null, mode: HandoffMode): Promise<Start> {
  const { cfg, db, selfId } = deps;
  // It may come from another node, and it names the line's ref: one safe segment only.
  if (!SAFE_ID.test(taskId)) throw new Error(`invalid task id: ${taskId}`);
  const project = getProject(db, projectId);
  if (project === null) throw new Error(`no project ${shortId(projectId)}`);
  if (project.home !== selfId) throw new Error(`a task's start is resolved on its project's home, ${shortId(project.home)}`);
  if (mode === "edit" && rev === null) throw new Error("--edit needs a revision");

  return serialised(`handoff:${projectId}`, () => serialised(repoKey(project.replica), async () => {
    const repo = project.replica;
    if (rev !== null && project.sync.includes(rev)) {
      if (mode === "edit") throw new Error(`--edit takes a revision, not the sync branch ${rev}`);
      return { projectId, kind: "sync", branch: rev } satisfies Start;
    }
    if (rev === null && project.source.kind === "upstream") {
      const [branch] = project.sync;
      if (branch === undefined) throw new Error(`${project.name} has no sync branch`);
      return { projectId, kind: "sync", branch } satisfies Start;
    }
    await gitImport(repo, cfg);

    let commit: string;
    let change: string;
    let base: string;
    if (rev === null) {
      // `@` is the folder workspace's working copy as last snapshotted: an edit on disk stays the user's.
      const forks = await changesIn(repo, "heads(::@ ~ (empty() ~ merges()))", cfg);
      const [fork] = forks;
      if (fork === undefined) throw new Error("cannot start a task on the root commit");
      if (forks.length > 1) throw new Error(`@ has ${forks.length} fork points`);
      if ((await changesIn(repo, `${fork.commitId} & @`, cfg)).length > 0) throw new Error("@ has changes; move off it first");
      ({ commitId: commit, changeId: change } = fork);
      base = commit;
    } else {
      let resolved: Array<{ changeId: string; commitId: string }>;
      try {
        resolved = await changesIn(repo, rev, cfg);
      } catch (err) {
        if (err instanceof JjError && NOT_A_REVISION.test(err.stderr)) throw new Error(`no revision ${rev} in ${project.name}`);
        throw err;
      }
      if (resolved.length === 0) throw new Error(`no revision ${rev} in ${project.name}`);
      if (resolved.length > 1) throw new Error(`${rev} names ${resolved.length} revisions in ${project.name}`);
      ({ commitId: commit, changeId: change } = resolved[0]!);
      // git holds no ref at the root commit (its id is git's null id): an edit finds it immutable first.
      if (mode === "child" && (await changesIn(repo, `${commit} & root()`, cfg)).length > 0) throw new Error("cannot start a task on the root commit");
      base = mode === "edit" ? await editable(cfg, repo, change, commit) : commit;
    }
    await writeLine(cfg, repo, taskId, project.name, commit);
    // The task does not exist anywhere yet: the janitor leaves its line alone while it is being created.
    noteStarting(repo, taskId);
    return { projectId, kind: "line", mode, commit, base };
  }));
}

/**
 * Checks that W (`change` at `commit`) can be given to a task to edit in place, in Decision 5's order: it is mutable
 * (no task's line holds it, nor the user's configuration), no workspace's working copy is on it, nothing is on top of
 * it, and it has changes. Returns the commit of its fork point. The caller holds `repoKey(repo)`.
 */
async function editable(cfg: NodeConfig, repo: string, change: string, commit: string): Promise<string> {
  const W = short(change);
  if ((await changesIn(repo, `${commit} & immutable()`, cfg)).length > 0) throw new Error(`${W} is immutable`);
  const list = await jj(["workspace", "list", "--ignore-working-copy", "-T", 'name ++ "\\x1f" ++ target.commit_id() ++ "\\n"'], repo, cfg);
  for (const line of list.split("\n").filter(Boolean)) {
    const [name = "", target = ""] = line.split("\x1f");
    if (target === commit) throw new Error(`${W} is ${name}'s working copy; move off it first`);
  }
  if ((await changesIn(repo, `children(${commit})`, cfg)).length > 0) throw new Error(`${W} has revisions on top of it`);
  if ((await changesIn(repo, `${commit} & empty()`, cfg)).length > 0) throw new Error(`nothing to hand off: ${W} has no changes`);

  const bases = await changesIn(repo, `heads(::${commit}- ~ (empty() ~ merges()))`, cfg);
  const [base] = bases;
  if (base === undefined) throw new Error(`no fork point below ${W}`);
  if (bases.length > 1) throw new Error(`${W} has ${bases.length} fork points`);
  return base.commitId;
}

/** What creating a task needs to resolve its starts: a start's deps, and the pool (without one, every home is here). */
export type CreateDeps = StartDeps & { pool?: PoolRuntime };

/** One project of a new task as a client names it: its id, and the revision it starts at (none: the default) and how. */
export type ProjectStart = { id: string; rev?: string | null; mode?: HandoffMode | null };

/**
 * Resolves where each project of new task `taskId` starts, in order, on the project's home (Decision 7): `startAt` when
 * that is this node, else the home's `PeerObject.startAt`. With the home offline, a `rev` naming one of the project's
 * sync branches (as this node knows them), or no `rev` for a url project (`upstream`: its first sync branch; refused
 * `<project> has no sync branch` without one), is a sync start from the copy the task's node fetched last; anything
 * else is refused `home <short id> is offline`. A refusal is prefixed `project <name>: `; the lines the starts before
 * it wrote are released first (`releaseStarts`).
 */
export async function resolveStarts(deps: CreateDeps, taskId: string, projects: readonly ProjectStart[]): Promise<Start[]> {
  const twice = projects.find((p, i) => projects.findIndex((q) => q.id === p.id) !== i);
  if (twice !== undefined) throw new Error(`project ${shortId(twice.id)} is named twice`);
  const starts: Start[] = [];
  for (const p of projects) {
    try {
      starts.push(await startOf(deps, taskId, p));
    } catch (err) {
      throw await releaseStarts(deps, taskId, starts, err);
    }
  }
  return starts;
}

/** Where project `p` of task `taskId` starts, asked of its home; refusals are prefixed `project <name>: `. */
async function startOf(deps: CreateDeps, taskId: string, p: ProjectStart): Promise<Start> {
  const rev = p.rev ?? null;
  const mode = p.mode ?? "child";
  const info = await projectInfoOf(deps, p.id);
  try {
    if (info.home === deps.selfId) return await startAt(deps, p.id, taskId, rev, mode);
    const { pool } = deps;
    if (pool === undefined) throw new Error(`a task's start is resolved on its project's home, ${shortId(info.home)}`);
    if (!pool.net.isOnline(info.home)) {
      const sync = info.sync ?? [];
      // A url project's default start is its first sync branch: a sync start too.
      if (rev === null && info.upstream === true) {
        const [branch] = sync;
        if (branch === undefined) throw new Error(`${info.name} has no sync branch`);
        return { projectId: p.id, kind: "sync", branch };
      }
      if (rev === null || !sync.includes(rev)) throw new Error(`home ${shortId(info.home)} is offline`);
      if (mode === "edit") throw new Error(`--edit takes a revision, not the sync branch ${rev}`);
      return { projectId: p.id, kind: "sync", branch: rev };
    }
    const ref = await pool.peerRef(info.home, PeerObject);
    try {
      if (ref.variant !== "peer") throw new Error(`${shortId(info.home)} did not serve the peer variant of PeerObject`);
      return await ref.startAt({ projectId: p.id, taskId, rev, mode });
    } finally {
      ref.release();
    }
  } catch (err) {
    // `project <name>: `, not `<name>: `: chord takes a leading `<word>: ` off a message it carries, as an error code.
    throw new Error(`project ${info.name}: ${remoteReason(err)}`);
  }
}

/**
 * What this node knows of project `projectId`: its own row, else what a summary in the roster lists, else what an online
 * member says (`findProject`). Rejects `no online node holds project <short id>` when nobody knows it.
 */
async function projectInfoOf(deps: CreateDeps, projectId: string): Promise<ProjectInfo> {
  const own = getProject(deps.db, projectId);
  if (own !== null && own.home !== "") return own;
  const { pool } = deps;
  if (pool !== undefined) {
    for (const row of pool.store.roster()) {
      const listed = row.summary?.projects.find((p) => p.id === projectId && p.home !== "");
      if (listed !== undefined) return listed;
    }
    const found = await findProject(pool, projectId);
    if (found !== null) return found;
  }
  throw new Error(`no online node holds project ${shortId(projectId)}`);
}

/**
 * Releases the line each `line` start of `starts` wrote for task `taskId` on its home (keeping none): here, or through
 * the home's `PeerObject.releaseLines`. Returns the error to throw for `cause`: itself, or, when a line could not be
 * released, `cause` saying which line stays until the janitor releases it, and why.
 */
export async function releaseStarts(deps: CreateDeps, taskId: string, starts: readonly Start[], cause: unknown): Promise<Error> {
  const stays: string[] = [];
  for (const start of starts) {
    if (start.kind !== "line") continue;
    try {
      await releaseStart(deps, taskId, start.projectId);
    } catch (err) {
      const name = getProject(deps.db, start.projectId)?.name ?? shortId(start.projectId);
      stays.push(`the line of ${name} stays until the janitor releases it: ${remoteReason(err)}`);
    }
  }
  const error = cause instanceof Error ? cause : new Error(String(cause));
  return stays.length === 0 ? error : new Error([error.message, ...stays].join("; "));
}

/** Releases every line of task `taskId` on project `projectId`'s home. */
async function releaseStart(deps: CreateDeps, taskId: string, projectId: string): Promise<void> {
  const info = await projectInfoOf(deps, projectId);
  if (info.home === deps.selfId) {
    const project = getProject(deps.db, projectId);
    if (project === null) throw new Error(`no project ${shortId(projectId)}`);
    await serialised(repoKey(project.replica), () => releaseLines(deps.cfg, project.replica, taskId, []));
    return;
  }
  const { pool } = deps;
  if (pool === undefined || !pool.net.isOnline(info.home)) throw new Error(`home ${shortId(info.home)} is offline`);
  const ref = await pool.peerRef(info.home, PeerObject);
  try {
    if (ref.variant !== "peer") throw new Error(`${shortId(info.home)} did not serve the peer variant of PeerObject`);
    await ref.releaseLines({ projectId, taskId, keep: [] });
  } finally {
    ref.release();
  }
}
