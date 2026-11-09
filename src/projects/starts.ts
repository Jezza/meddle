// Where a project of a new task starts, resolved where the revision is: on the node asked, from a revision its service
// repo has (or one `task new` pushed there from your checkout, which checked it in the checkout first), or the
// project's default branch as its rows compute it. A start writes the task's line row there, held by that node at
// epoch 0, and applies it, so that the node holds the revision read-only before the task exists anywhere. Every read
// passes `--ignore-working-copy`.
import type { Database } from "bun:sqlite";
import type { NodeConfig } from "../config";
import { changesIn, git, GitError, jj, JjError } from "../jj";
import { shortId } from "../pool/ids";
import { remoteReason } from "../pool/object";
import { listBranchRows, writeLineRow, type BranchRow } from "../pool/rows";
import type { PoolRuntime } from "../pool/runtime";
import { serialised } from "../serial";
import type { HandoffMode, Start } from "../tasks/manifest";
import { COMMIT_ID, SAFE_ID } from "../tasks/provision";
import { applyProject, catchUp, gitGraph } from "./applier";
import { computeBranch } from "./branches";
import { getProject, type Project } from "./project";
import { ensureServiceRepo } from "./replicas";

/** What jj (0.45) says of a revset that names no revision, or does not parse. */
const NOT_A_REVISION = /^Error: (Revision `.*` doesn't exist|Failed to parse revset: )/m;

/** Where an incoming commit from a checkout sits in the service repo: in the view, which jj never imports. */
const INCOMING = "refs/namespaces/view/refs/meddle/incoming/";

/** jj's root commit, which git has no object for. */
const ROOT = /^0+$/;

/**
 * What a start needs of its node: its config, database and id, and its pool (without one, a start writes its row but
 * nothing applies it).
 */
export type StartDeps = { cfg: NodeConfig; db: Database; selfId: string; pool?: PoolRuntime; log?: (line: string) => void };

/** Where a start is asked for: a revision (null: the default branch) taken as `mode`, and the checkout that pushed it. */
export type StartRequest = { projectId: string; taskId: string; rev: string | null; mode: HandoffMode; checkout: string | null };

const short = (change: string) => change.slice(0, 12);

/** Whether the git object store of `repo` has commit `commit`. */
async function hasCommit(cfg: NodeConfig, repo: string, commit: string): Promise<boolean> {
  try {
    await git(["cat-file", "-e", `${commit}^{commit}`], repo, cfg);
    return true;
  } catch (err) {
    if (err instanceof GitError) return false;
    throw err;
  }
}

/** The parents of `commit` in `repo`, in order, read with git (jj may not know the commit yet); none for a root. */
async function parentsOf(cfg: NodeConfig, repo: string, commit: string): Promise<string[]> {
  const [, ...parents] = (await git(["rev-list", "--parents", "-n", "1", commit], repo, cfg)).trim().split(/\s+/);
  return parents;
}

/**
 * Resolves where task `taskId` starts in project `projectId`, here, and writes its line row (holder this node, epoch 0)
 * and applies it (`applyProject`, with a pool, fetching for at most 5 s: the start's own commit is here already). Under
 * `start:<projectId>`, so that two starts here never both take the same revision to edit.
 * - With `rev` and a `checkout`: `rev` is the commit `task new` pushed from your checkout (`refs/meddle/incoming/`),
 *   refused `no revision <rev> in <project>` when it is not here. The push's ref goes once the start is made or
 *   refused. A commit jj does not know yet passes refusals 1–3
 *   (nothing in the service repo holds it, sits on it or builds on it; the checkout checked refusal 4); one it knows
 *   is checked against all four in the service repo and its workspaces.
 * - With `rev` alone: a revset of the service repo, which must name one revision (`no revision <rev> in <project>`,
 *   `<rev> names <n> revisions in <project>`).
 * - Without `rev`: the project's default branch as its rows compute it (`computeBranch`): refused
 *   `<project> has no default branch; name a revision` without one, `no bookmark <b> in <project>` when no row has
 *   it, and `<b> is conflicted; push a merge of its siblings` while conflicted.
 * In `child` mode the base is `[R]` (refused `cannot start a task on the root commit` at the root); in `edit` mode
 * (refused `--edit needs a revision` without `rev`) it is R's parents, read with git. Rejects with the reason, writing
 * nothing, when the start cannot be made, and `invalid task id: <id>` for an id that is not one path segment of
 * letters, digits, `-` and `_`.
 */
export async function startAt(deps: StartDeps, request: StartRequest): Promise<Start> {
  const { cfg, db, pool } = deps;
  const { projectId, taskId, rev, mode, checkout } = request;
  // It names the line's ref: one safe segment only.
  if (!SAFE_ID.test(taskId)) throw new Error(`invalid task id: ${taskId}`);
  if (mode === "edit" && rev === null) throw new Error("--edit needs a revision");
  const project = pool === undefined
    ? getProject(db, projectId)
    : await ensureServiceRepo({ cfg, db, pool, ...(deps.log === undefined ? {} : { log: deps.log }) }, projectId, { memory: false });
  if (project === null) throw new Error(`no project ${shortId(projectId)}`);
  const repo = project.replica;

  return serialised(`start:${projectId}`, async () => {
    try {
      return await resolveAndWrite(deps, request, project);
    } finally {
      // The line holds it now, or the start was refused: either way nothing needs the push's ref any more.
      if (checkout !== null && rev !== null && COMMIT_ID.test(rev)) await git(["update-ref", "-d", `${INCOMING}${rev}`], repo, cfg).catch(() => {});
    }
  });
}

/** How long a start's apply may spend fetching commits the project's rows name: its own commit is here already. */
const APPLY_AT_START_MS = 5000;

/** `startAt`'s work under its lock: the commit, its checks, its base, and the line row written and applied. */
async function resolveAndWrite(deps: StartDeps, request: StartRequest, project: Project): Promise<Start> {
  const { cfg, db, selfId, pool } = deps;
  const { projectId, taskId, rev, mode, checkout } = request;
  const repo = project.replica;
  let commit: string;
  if (rev === null) commit = await defaultBranchCommit(deps, project);
  else if (checkout !== null) {
    if (!COMMIT_ID.test(rev) || !(await hasCommit(cfg, repo, rev))) throw new Error(`no revision ${rev} in ${project.name}`);
    commit = rev;
  } else commit = await resolveRev(cfg, project, rev);

  let base: string[];
  if (mode === "child") {
    if (ROOT.test(commit)) throw new Error("cannot start a task on the root commit");
    base = [commit];
  } else {
    const known = await changesIn(repo, `present(${commit})`, cfg);
    if (known.length > 0) await editable(cfg, repo, known[0]!.changeId, commit);
    base = await parentsOf(cfg, repo, commit);
  }

  writeLineRow(db, { project: projectId, task: taskId, name: project.name, holder: selfId, epoch: 0, commit, base, archived: false });
  if (pool !== undefined) {
    await applyProject({ cfg, db, pool, ...(deps.log === undefined ? {} : { log: deps.log }) }, projectId, APPLY_AT_START_MS);
  }
  return { projectId, mode, commit, base };
}

/** The one commit `rev` names in `project`'s service repo, refused as `startAt` says. */
async function resolveRev(cfg: NodeConfig, project: Project, rev: string): Promise<string> {
  let resolved: Array<{ changeId: string; commitId: string }>;
  try {
    resolved = await changesIn(project.replica, rev, cfg);
  } catch (err) {
    if (err instanceof JjError && NOT_A_REVISION.test(err.stderr)) throw new Error(`no revision ${rev} in ${project.name}`);
    throw err;
  }
  if (resolved.length === 0) throw new Error(`no revision ${rev} in ${project.name}`);
  if (resolved.length > 1) throw new Error(`${rev} names ${resolved.length} revisions in ${project.name}`);
  return resolved[0]!.commitId;
}

/** How long a start waits to catch up on a default branch whose rows or commits are not here yet. */
const CATCH_UP_MS = 5000;

/**
 * The commit of `project`'s default branch, computed from its rows (`computeBranch`), refused as `startAt` says. With
 * no row of it here, or a row whose commit is not here yet, it catches up first (`catchUp`: the peers' rows, then the
 * commits); refused `<b> is not here yet; try again shortly` when a commit still is not.
 */
async function defaultBranchCommit(deps: StartDeps, project: Project): Promise<string> {
  const { cfg, db, pool } = deps;
  const branch = project.defaultBranch;
  if (branch === null) throw new Error(`${project.name} has no default branch; name a revision`);
  const missing = async (rows: readonly BranchRow[]) => {
    for (const r of rows) if (r.commit !== null && !(await hasCommit(cfg, project.replica, r.commit))) return true;
    return false;
  };
  let rows = listBranchRows(db, project.id, branch);
  if (pool !== undefined && (rows.length === 0 || (await missing(rows)))) {
    await catchUp({ cfg, db, pool }, project.id, CATCH_UP_MS).catch(() => {});
    rows = listBranchRows(db, project.id, branch);
  }
  if (await missing(rows)) throw new Error(`${branch} is not here yet; try again shortly`);
  const state = await computeBranch(rows, gitGraph(cfg, project.replica));
  if (state.kind === "absent") throw new Error(`no bookmark ${branch} in ${project.name}`);
  if (state.kind === "conflicted") throw new Error(`${branch} is conflicted; push a merge of its siblings`);
  return state.commit;
}

/**
 * Checks that W (`change` at `commit`), which jj knows, can be given to a task to edit in place, in the spec's order:
 * it is mutable (no line holds it, nor the repo's configuration), no workspace's working copy is on it, nothing is on
 * top of it, and it has changes.
 */
async function editable(cfg: NodeConfig, repo: string, change: string, commit: string): Promise<void> {
  const W = short(change);
  if ((await changesIn(repo, `${commit} & immutable()`, cfg)).length > 0) throw new Error(`${W} is immutable`);
  const list = await jj(["workspace", "list", "--ignore-working-copy", "-T", 'name ++ "\\x1f" ++ target.commit_id() ++ "\\n"'], repo, cfg);
  for (const line of list.split("\n").filter(Boolean)) {
    const [name = "", target = ""] = line.split("\x1f");
    if (target === commit) throw new Error(`${W} is ${name}'s working copy; move off it first`);
  }
  if ((await changesIn(repo, `children(${commit})`, cfg)).length > 0) throw new Error(`${W} has revisions on top of it`);
  if ((await changesIn(repo, `${commit} & empty()`, cfg)).length > 0) throw new Error(`nothing to hand off: ${W} has no changes`);
}

/**
 * One project of a new task as a client names it: its id, the revision it starts at (none: the default branch) and
 * how, and the checkout `task new` pushed that revision from.
 */
export type ProjectStart = { id: string; rev?: string | null; mode?: HandoffMode | null; checkout?: string | null };

/**
 * Resolves where each project of new task `taskId` starts, in order, here (`startAt`), each writing its line row. A
 * refusal is prefixed `project <name>: `; the caller releases the rows the starts before it wrote.
 */
export async function resolveStarts(deps: StartDeps, taskId: string, projects: readonly ProjectStart[]): Promise<Start[]> {
  const twice = projects.find((p, i) => projects.findIndex((q) => q.id === p.id) !== i);
  if (twice !== undefined) throw new Error(`project ${shortId(twice.id)} is named twice`);
  const starts: Start[] = [];
  for (const p of projects) {
    try {
      starts.push(await startAt(deps, { projectId: p.id, taskId, rev: p.rev ?? null, mode: p.mode ?? "child", checkout: p.checkout ?? null }));
    } catch (err) {
      const name = getProject(deps.db, p.id)?.name ?? shortId(p.id);
      // `project <name>: `, not `<name>: `: chord takes a leading `<word>: ` off a message it carries, as an error code.
      throw new Error(`project ${name}: ${remoteReason(err)}`);
    }
  }
  return starts;
}
