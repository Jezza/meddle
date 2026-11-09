// Accepting a task's work emerges from a push: you fast-forward a branch onto the task's line and push it. Once a
// branch's computed position contains the task's line, for every project of the task its agent did work in, the work
// is accepted, and the task's holder archives it, releasing the lines a branch contains (`TaskRunner`). A branch
// containing only some of those projects' lines makes the task partly accepted, which archives nothing; a conflicted
// branch accepts nothing until it is resolved, since its siblings may yet be dropped.
//
// A line is judged by its effective head (`effectiveHead`): its head with the empty changes on top stripped off, such
// as the empty working copy jj leaves above committed work, or a turn end leaves above an untouched project's start.
import type { NodeConfig } from "../config";
import { git } from "../jj";
import type { BranchRow } from "../pool/rows";
import { listBranchRows, listLineRows } from "../pool/rows";
import { applyProject, gitGraph } from "../projects/applier";
import { computeBranch } from "../projects/branches";
import { getProject } from "../projects/project";
import type { ReplicaDeps } from "../projects/replicas";
import type { ManifestProject, TaskManifest } from "./manifest";

/** Whether a task's work is accepted: for every project it did work in, for some only, or for none. */
export type Acceptance = "accepted" | "partly" | "no";

/** A line of a task: its project's id and its name. */
export type LineName = { project: string; name: string };

/**
 * A project's branches as its rows compute them: the commits of those in the `single` state, and (`error`) why some
 * branch could not be computed (a commit its repo lacks), if one could not.
 */
export type BranchTips = { tips: string[]; error: string | null };

/** What a check reads each project's branches from: `branchTips`, or a cache of it. */
export type TipsOf = (projectId: string) => Promise<BranchTips>;

/** The outcome of a check: see `acceptanceOf`. */
export type AcceptanceCheck = { verdict: Acceptance; contained: LineName[]; pending: string | null };

/** How long a check may spend fetching branch commits this node's rows name and its repo lacks, per project. */
const FETCH_MS = 5000;
/** How many commits one `git log` of `effectiveHead` reads at a time. */
const STRIP_WINDOW = 64;

function messageOf(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim();
}

/**
 * Commit `head` of `repo` with the empty changes on its top stripped off: while the commit has exactly one parent and
 * that parent's tree, its parent. One `git log --first-parent` per 64 commits stripped.
 */
export async function effectiveHead(cfg: NodeConfig, repo: string, head: string): Promise<string> {
  let at = head;
  for (;;) {
    const out = await git(["log", "--first-parent", `--max-count=${STRIP_WINDOW}`, "--format=%H %T %P", at], repo, cfg);
    const entries = out.split("\n").filter(Boolean).map((line) => line.split(" "));
    for (let i = 0; i < entries.length; i++) {
      const [hash, tree, ...parents] = entries[i]!;
      if (parents.length !== 1) return hash!;
      const parent = entries[i + 1];
      if (parent === undefined) {
        if (i === 0) return hash!;
        at = hash!; // the parent's tree is past this window: read on from here
        break;
      }
      if (parent[1] !== tree) return hash!;
    }
  }
}

/** Whether `commit` is one of `tips` or below one of them: one `git rev-list`. */
export async function containedIn(cfg: NodeConfig, repo: string, commit: string, tips: readonly string[]): Promise<boolean> {
  if (tips.length === 0) return false;
  return (await git(["rev-list", "--max-count=1", commit, "--not", ...tips], repo, cfg)).trim() === "";
}

/** Project `projectId`'s branches in the `single` state, as this node's rows and repo have them (`BranchTips`). */
export async function branchTips(deps: ReplicaDeps, projectId: string): Promise<BranchTips> {
  const project = getProject(deps.db, projectId);
  if (project === null) return { tips: [], error: null };
  const g = gitGraph(deps.cfg, project.replica);
  const branches = new Map<string, BranchRow[]>();
  for (const r of listBranchRows(deps.db, projectId)) branches.set(r.branch, [...(branches.get(r.branch) ?? []), r]);
  const tips: string[] = [];
  let error: string | null = null;
  for (const rows of branches.values()) {
    try {
      const state = await computeBranch(rows, g);
      if (state.kind === "single") tips.push(state.commit);
    } catch (err) {
      error ??= messageOf(err);
    }
  }
  return { tips, error };
}

/** Task `taskId`'s project `p` as a check finds it: its own line's effective head, and which of its lines are contained. */
type ProjectCheck = { own: string | null; contained: string[]; error: string | null };

/**
 * Which of task `taskId`'s live lines in project `p` a branch contains (`tips`): the line's effective head is a tip or
 * below one. `own` is the effective head of the project's own line (null when released or missing).
 */
async function checkProject(deps: ReplicaDeps, taskId: string, p: ManifestProject, tips: BranchTips): Promise<ProjectCheck> {
  const project = getProject(deps.db, p.id);
  if (project === null) return { own: null, contained: [], error: null };
  const repo = project.replica;
  let error = tips.error;
  let own: string | null = null;
  const contained: string[] = [];
  for (const line of listLineRows(deps.db, p.id, taskId)) {
    if (line.commit === null) continue;
    try {
      const head = await effectiveHead(deps.cfg, repo, line.commit);
      if (line.name === p.name) own = head;
      if (await containedIn(deps.cfg, repo, head, tips.tips)) contained.push(line.name);
    } catch (err) {
      error ??= messageOf(err);
    }
  }
  return { own, contained, error };
}

/**
 * Whether `manifest`'s task's work is accepted, as this node's rows have it (see `acceptance`); the task's live lines
 * some branch contains (`contained`), side lines and the own lines of projects holding no work included; and, when a
 * commit a row names was still missing here after a bounded fetch, why (`pending`): the check is worth making again
 * later. Branches are read through `tipsOf`
 * (default `branchTips`); a project whose check lacked a commit is applied (fetching it, at most 5 s) and read afresh.
 */
export async function acceptanceOf(
  deps: ReplicaDeps, manifest: TaskManifest, tipsOf: TipsOf = (id) => branchTips(deps, id),
): Promise<AcceptanceCheck> {
  const checks: Array<{ p: ManifestProject; check: ProjectCheck }> = [];
  let pending: string | null = null;
  for (const p of manifest.projects) {
    let check = await checkProject(deps, manifest.id, p, await tipsOf(p.id));
    if (check.error !== null) {
      // The commits a push on another node named come with the rows' apply: fetched here, within the budget.
      await applyProject(deps, p.id, FETCH_MS).catch(() => {});
      check = await checkProject(deps, manifest.id, p, await branchTips(deps, p.id));
    }
    pending ??= check.error;
    checks.push({ p, check });
  }
  const contained = checks.flatMap(({ p, check }) => check.contained.map((name) => ({ project: p.id, name })));
  // No project's line contained: nothing is accepted, whatever holds work.
  if (!checks.some(({ p, check }) => check.contained.includes(p.name))) return { verdict: "no", contained, pending };
  let worked = 0;
  let count = 0;
  for (const { p, check } of checks) {
    if (check.own === null) continue;
    const project = getProject(deps.db, p.id);
    const row = listLineRows(deps.db, p.id, manifest.id).find((r) => r.name === p.name);
    const base = [...new Set([...(row?.base ?? []), ...p.base])];
    let work = true;
    try {
      // No work: the effective head is at or below a base commit.
      if (project !== null) work = !(await containedIn(deps.cfg, project.replica, check.own, base));
    } catch (err) {
      pending ??= messageOf(err);
    }
    if (!work) continue;
    worked++;
    if (check.contained.includes(p.name)) count++;
  }
  const verdict = worked > 0 && count === worked ? "accepted" : count > 0 ? "partly" : "no";
  return { verdict, contained, pending };
}

/**
 * Whether `manifest`'s task's work is accepted. Each line is judged by its effective head (`effectiveHead`). A project
 * whose line holds no work of the task's own (its effective head at or below its base commits) is left out; of the
 * others, `"accepted"` when some branch in the `single` state has each one's effective head at or below it,
 * `"partly"` when that holds for some of them only, and `"no"` otherwise, and for a task with no work in any project.
 * A conflicted branch counts for nothing. Read from this node's rows; commits its repo lacks are fetched first, for at
 * most 5 s per project.
 */
export async function acceptance(deps: ReplicaDeps, manifest: TaskManifest): Promise<Acceptance> {
  return (await acceptanceOf(deps, manifest)).verdict;
}
