// The merge train's check of a batch (the spec's step 3): a merge task, a normal task on a start with the batch's tips as
// its parents, whose agent runs the tests that cover the batch and describes the merge. `checkBatch` creates it, drives its
// turns, verifies what it left, and discards it when the agent blamed a task. Where the task lives, and how its turns and
// its head are reached, is `MergeDeps`'s.
import type { NodeConfig } from "../config";
import { treeOf, trialMerge } from "../git/merge-tree";
import { git, type CommitInfo } from "../jj";
import { gitGraph } from "../projects/applier";
import { mergeParents, type Candidate } from "./batch";
import { mergePrompt, mergeTitle } from "./prompts";
import type { TrainTurnKind, TrainTurnOutcome } from "./tools";

/**
 * What `checkBatch` asks of the world. `createMergeTask` places a task on a start with `parents` (in production like any
 * new task, `chooseNode` and then `createTaskAt`) and answers where it is; `batch` is the ids of the tasks it checks.
 * `turn` runs a train turn on it and answers how it went (`TaskRunner.trainTurn`), `head` reads its line's head, and
 * `discard` archives it and then deletes it.
 */
export type MergeDeps = {
  createMergeTask(input: { projectId: string; parents: string[]; title: string; batch: string[] }): Promise<{ taskId: string; nodeId: string }>;
  turn(taskId: string, kind: TrainTurnKind, text: string): Promise<TrainTurnOutcome>;
  head(taskId: string): Promise<CommitInfo>;
  discard(taskId: string): Promise<void>;
};

/**
 * How checking a batch ended:
 * - `ready`: `mergeTask`'s line head `L` (a commit id) is the merge, described, with no conflicts and no file changed;
 * - `blamed`: the merge agent blamed the batch's task `task` (its id) for a failure, and the merge task is discarded;
 * - `unclean`: the batch doesn't merge cleanly after all: git's trial merge of its heads conflicts, or jj's merge, the
 *   one the merge task started on, has conflicts or other files than git's (git and jj can disagree, over a rename for
 *   one). No merge task is left: it is discarded before its first turn;
 * - `stuck`: the batch can't be checked, or the merge agent didn't get a verdict right (its turn failed, or follow-ups
 *   didn't put it right), and the train pauses for `reason`. The merge task made is left alive, for the user to open and
 *   for Retry to carry on with, and `mergeTask` is its id (the caller discards it when it unqueues a task or the branch
 *   moves); `null` when none was made (nothing to merge, or the trial merge failed).
 */
export type MergeVerdict =
  | { kind: "ready"; mergeTask: string; L: string }
  | { kind: "blamed"; task: string; reason: string }
  | { kind: "unclean" }
  | { kind: "stuck"; reason: string; mergeTask: string | null };

/** The follow-up turns the merge agent gets to put its result right, before the train gives up on it (Global Constraints). */
const FOLLOW_UPS = 3;

/** What is wrong with the merge task's result (`what`, for the user) and what to do about it (`fix`, for the agent). */
type Problem = { what: string; fix: string };

/**
 * Checks `input.batch`, the tasks that merge cleanly with `B` together (`pickBatch`), by a merge task: a task whose
 * start is the merge of the batch's tips (`mergeParents`: a tip another contains drops out, and so does `B` when the tips
 * are built on it). The agent runs the tests and describes the merge (`input.prompt` is the `describe.prompt` setting),
 * or blames a task for a failing test, which discards the merge task and answers `blamed` with that task's id (the agent
 * may name it by title, id, or as the prompt does). After a turn that ends otherwise, the head `L` has to be the merge
 * itself (the same change as the task started on, with the parents chosen), with a description and no conflicts, and
 * its tree has to be the clean trial merge's tree (`trialMerge`): the agent changed no file. If not, the agent gets a
 * follow-up turn that names what is wrong, up to three, and then the verdict is `stuck`, as it is when a turn fails.
 *
 * There is nothing to merge when the parents are fewer than two (the caller lands that one head as it is): `stuck`,
 * before any task is made. A trial merge that conflicts is `unclean`, before any task is made too, and so is a merge
 * task whose start, read before its first turn, has conflicts or other files than the trial merge: it is discarded. A
 * failure of `deps` itself rejects.
 */
export async function checkBatch(
  deps: MergeDeps, cfg: NodeConfig, repo: string, input: { projectId: string; B: string; batch: Candidate[]; prompt: string },
): Promise<MergeVerdict> {
  const { batch } = input;
  const stuck = (reason: string, mergeTask: string | null = null): MergeVerdict => ({ kind: "stuck", reason, mergeTask });

  const parents = await mergeParents(gitGraph(cfg, repo), input.B, batch.map((c) => c.tip));
  if (parents.length < 2) return stuck(`the batch has ${parents.length} head${parents.length === 1 ? "" : "s"}, so there is no merge to check`);
  let tree: string;
  try {
    const trial = await trialMerge(cfg, repo, parents);
    if (trial.tree === null) return { kind: "unclean" };
    tree = trial.tree;
  } catch (err) {
    return stuck(`the batch could not be trial merged: ${err instanceof Error ? err.message : String(err)}`);
  }

  const { taskId } = await deps.createMergeTask({
    projectId: input.projectId, parents, title: mergeTitle(batch.map((c) => c.title)), batch: batch.map((c) => c.taskId),
  });
  // The merge as the task started on it: a head that is no other change. jj made it, and it must be git's clean merge.
  const start = await deps.head(taskId);
  if (start.conflict || (await treeOf(cfg, repo, start.commitId)) !== tree) {
    await deps.discard(taskId);
    return { kind: "unclean" };
  }
  const change = start.changeId;
  const tasks = batch.map(label);
  let text = mergePrompt(tasks, change, input.prompt);

  for (let followUps = 0; ; followUps++) {
    const outcome = await deps.turn(taskId, "merge", text);
    let problems: Problem[];
    if (outcome.kind === "failed") return stuck(`the merge agent's turn failed: ${outcome.reason}`, taskId);
    if (outcome.kind === "declined") return stuck(`the merge agent declined: ${outcome.reason}`, taskId);
    if (outcome.kind === "blamed") {
      const blamed = blamedTask(batch, outcome.task);
      if (blamed !== undefined) {
        await deps.discard(taskId);
        return { kind: "blamed", task: blamed.taskId, reason: outcome.reason };
      }
      problems = [{
        what: `it blamed "${outcome.task}", which is no task of the batch (${tasks.join(", ")})`,
        fix: "If a test fails, call blame with one of those tasks and what failed.",
      }];
    } else {
      const head = await deps.head(taskId);
      problems = await verify(cfg, repo, { head, change, parents, tree, prompt: input.prompt });
      if (problems.length === 0) return { kind: "ready", mergeTask: taskId, L: head.commitId };
    }
    if (followUps === FOLLOW_UPS) {
      return stuck(`the merge agent did not put the merge right after ${FOLLOW_UPS} follow-ups: ${problems.map((p) => p.what).join("; ")}`, taskId);
    }
    text = `The merge ${change} can't land yet: ${problems.map((p) => p.what).join("; ")}. ${problems.map((p) => p.fix).join(" ")}`;
  }
}

/** How the prompt names a task, so that its title and its id both tell it apart. */
function label(c: Candidate): string {
  return `${c.title} (${c.taskId})`;
}

/**
 * The task of `batch` that `named` means: a task's id, a label (`label`), or its title in any case, as long as it is one
 * task. Nothing when `named` is none, or its title is shared.
 */
function blamedTask(batch: readonly Candidate[], named: string): Candidate | undefined {
  const lower = named.trim().toLowerCase();
  if (lower === "") return undefined;
  const only = (matches: (c: Candidate) => boolean) => {
    const found = batch.filter(matches);
    return found.length === 1 ? found[0] : undefined;
  };
  return only((c) => lower === c.taskId.toLowerCase())
    ?? only((c) => lower.includes(c.taskId.toLowerCase()))
    ?? only((c) => lower === c.title.trim().toLowerCase());
}

/** What is wrong with `head` as the merge of `parents`, which started as `change` and has the clean merge's `tree`. */
async function verify(
  cfg: NodeConfig, repo: string, want: { head: CommitInfo; change: string; parents: string[]; tree: string; prompt: string },
): Promise<Problem[]> {
  const { head, change, parents } = want;
  const problems: Problem[] = [];
  if (head.changeId !== change) {
    problems.push({ what: `your work ends at ${head.changeId}, not at the merge`, fix: "Keep the merge as the revision your work ends on." });
  }
  if (head.parents.length !== parents.length || !parents.every((p) => head.parents.includes(p))) {
    problems.push({
      what: `its parents are ${short(head.parents)}, not ${short(parents)}`,
      fix: "Keep the merge's parents as they were.",
    });
  }
  if (head.conflict) problems.push({ what: "it has conflicts", fix: "Restore the merge as it was." });
  if (head.description.trim() === "") problems.push({ what: "it has no description", fix: want.prompt });
  // A conflicted commit's tree holds its conflicts, which says nothing else.
  if (!head.conflict && (await treeOf(cfg, repo, head.commitId)) !== want.tree) {
    // `-z` leaves no path quoted.
    const out = await git(["diff-tree", "-r", "--name-only", "-z", want.tree, `${head.commitId}^{tree}`], repo, cfg);
    const files = out.split("\0").filter(Boolean);
    const named = files.length > 5 ? `${files.slice(0, 5).join(", ")} and ${files.length - 5} more` : files.join(", ");
    problems.push({
      what: `its files differ from the clean merge's${named === "" ? "" : ` (${named})`}`,
      fix: "Restore those files: the merge must not change any.",
    });
  }
  return problems;
}

/** Commit ids as the agent sees them in jj: the first 12 characters. */
function short(commits: string[]): string {
  return commits.map((c) => c.slice(0, 12)).join(" and ");
}
