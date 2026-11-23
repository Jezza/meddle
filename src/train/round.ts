// One round of the merge train (the spec's "A round"): the queued, eligible tasks are prepared (prepare turns that
// rebase, squash and describe their work and name its tests; leftovers abandoned), a batch of them that merges cleanly
// with the branch is picked, checked by a merge task when it has two heads or more, and landed by moving the branch;
// then the tasks that no longer merge cleanly with it, and a task the merge agent blamed, get prepare turns onto it. What the round does to the world goes through `RoundDeps`, so
// the conductor that runs it (`meddle.train`) decides where tasks live and how they are reached.
import type { NodeConfig } from "../config";
import { trialMerge } from "../git/merge-tree";
import { changesIn } from "../jj";
import type { LineRow } from "../pool/rows";
import { gitGraph } from "../projects/applier";
import type { Graph } from "../projects/branches";
import { classify, mergeParents, ownWork, pickBatch, type Candidate, type Classified } from "./batch";
import { checkBatch, type MergeDeps, type MergeVerdict } from "./merge";
import { preparePrompt, type Rewrite } from "./prompts";
import { declineReason, type TrainTurnKind } from "./tools";

/**
 * A call for a task that could not reach the node holding it, because that node is offline; `node` is how notices name
 * it. `RoundDeps.turn` and `abandonLeftovers` reject with it for that (and only for that), and the round sits the task
 * out as `waitingFor(node)`.
 */
export class NodeOffline extends Error {
  constructor(readonly node: string) {
    super(`${node} is offline`);
    this.name = "NodeOffline";
  }
}

/**
 * A task known not to exist any more: deleted, or archived. `MergeDeps.head` rejects with it for that, and only for that
 * (a holder that is offline or doesn't answer is `NodeOffline` or another error, which says nothing of the task): a round
 * resumed counts the merge task its checkpoint names as gone only so.
 */
export class TaskGone extends Error {
  constructor(readonly taskId: string) {
    super(`task ${taskId} is gone`);
    this.name = "TaskGone";
  }
}

/**
 * A task of the batch being checked (`taskId`) left the queue meanwhile: Unqueue, a message of the user's, its archive.
 * The check stops at once: `MergeDeps.turn` rejects with it (the merge turn running is no longer waited for), and so do
 * `createMergeTask` and `advance` once it is known. The round discards the merge task, which interrupts its turn, and
 * starts over without the task (`again`): nothing pauses, and nobody sits out.
 */
export class BatchChanged extends Error {
  constructor(readonly taskId: string) {
    super(`task ${taskId} left the batch being checked`);
    this.name = "BatchChanged";
  }
}

/**
 * What a round asks of the world, for the train of project `projectId` on its branch. `MergeDeps` serve the merge task
 * (`head` rejects with `TaskGone` once it is known to be gone), and `turn` the tasks' train turns too (it rejects with
 * `NodeOffline` when the task's node is offline). Once a task of the batch being checked has left the queue, the merge
 * task's `turn`, `createMergeTask` and `advance` reject with `BatchChanged`. Then:
 * - `branch`: the branch's commit now (`B`);
 * - `candidates`: the eligible tasks (queued, idle, on an online node, not in a train turn, not sitting out; held back or
 *   not, since each round decides that afresh), in the queue's order, `tip` being the line's effective head, all of it
 *   as this node's repo has it: once a call of the round's for a task has resolved (a turn, `abandonLeftovers`), what it
 *   changed is in there;
 * - `lines`: the project's line rows (a queued task's is one with `queuedAt`, not archived);
 * - `title`: how a notice names a task, also one that is no candidate;
 * - `abandonLeftovers`: abandons a task's leftovers (commit ids) where it is, on its holder;
 * - `advance`: moves the branch from `old` to `next` (`advanceBranch`), rejecting with the refusal's text;
 * - `leave`: a task leaves the queue, saying why; one that `declined` has left already, on its holder, and this only
 *   records it then (the user may have accepted it again since);
 * - `sitOut`: a task stays queued but not eligible until Retry, saying why;
 * - `holdBack`: a task stays queued but is not eligible this round, with the notice to show;
 * - `saveTests`: records the commands a task's agent named (`ready`) to run the tests covering its work at `tip`, which
 *   `candidates` answers as the task's `tests` while its tip is that;
 * - `checkpoint`: where the round is (`RoundStep`), for the train's page and for a round resumed after a restart or Retry.
 */
export type RoundDeps = MergeDeps & {
  projectId: string;
  branch(): Promise<string>;
  candidates(): Promise<Candidate[]>;
  lines(): Promise<LineRow[]>;
  title(taskId: string): Promise<string>;
  abandonLeftovers(taskId: string, commits: string[]): Promise<void>;
  advance(old: string, next: string): Promise<void>;
  leave(taskId: string, reason: string, declined: boolean): Promise<void>;
  sitOut(taskId: string, reason: string): Promise<void>;
  holdBack(taskId: string, notice: string): Promise<void>;
  saveTests(taskId: string, tip: string, tests: string[]): Promise<void>;
  checkpoint(step: RoundStep): Promise<void>;
};

/**
 * Where a round is: `describing` (`batch`: the tasks given describe turns), `picking`, `checking` (`batch`: the batch;
 * `mergeTask`: the merge task checking it, once made), `landing` (the batch, and the merge task whose merge lands, null
 * for a single head) or `rebasing` (`batch`: the tasks given rebase or fix turns).
 */
export type RoundStep = { step: "describing" | "picking" | "checking" | "landing" | "rebasing"; batch: string[]; mergeTask: string | null };

/**
 * How a round ended. `landed`: the commit the branch was moved to, or null. `again`: whether another round should start
 * straight away, because this one could not finish against what it read (the branch moved, a task of the batch left or
 * changed), or left work for the next (a task waited for a later batch, or changed outside a turn; a train turn ended
 * with its task eligible again). `paused`: why the train pauses (its merge task got stuck or failed, the batch could not
 * be trial merged, or the branch, still at `B`, refused the landing), or null; Retry resumes from the round's last
 * checkpoint.
 */
export type RoundResult = { landed: string | null; again: boolean; paused: string | null };

/**
 * Runs one round of the train against the branch's commit `B` (`deps.branch`), in the spec's five steps. `repo` is this
 * node's repo of the project, and `prompt` the `describe.prompt` setting.
 *
 * 1. What each task would land, `B..tip`, must be pushable (`classify`): its leftovers are abandoned, and a task with
 *    undescribed or conflicted commits of its own, several revisions to squash, or no test list for its tip gets a
 *    prepare turn (a `describe` turn; all such turns at once): rebased onto `B` and squashed into one revision as its
 *    work allows (`Rewrite`), described, with the tests covering it named (`ready`, kept by `saveTests`). What the turn
 *    left undone sits it out. A task with such commits it may not change leaves, naming them; a task holding work of a
 *    task that isn't queued is held back; a task holding a queued task's work goes only with it.
 * 2. A batch is picked (`pickBatch`); a task that doesn't merge cleanly with `B` is to rebase.
 * 3. A batch with two heads or more is checked by a merge task (`checkBatch`; never for one head). A task it blames
 *    leaves the batch, with the tasks holding its work, for a fix turn, and a fresh merge task checks the rest. A batch
 *    that doesn't merge cleanly after all (jj's merge isn't git's trial merge) puts its smallest task back, with the
 *    tasks holding its work, for a later round, and the rest is checked again; when that would leave nothing, the tasks
 *    left are to rebase instead. A stuck check pauses the train. A check a task of the batch left (`BatchChanged`)
 *    stops: its merge task is discarded, and the round starts over (`again`).
 * 4. Unless a task of the batch (or one whose work it holds) left or changed meanwhile (then the round starts over:
 *    `again`), the branch is moved from `B` to the merge, or to the single head (`advance`). When that is refused, the
 *    merge task is discarded. If the branch has moved since `B`, the round starts over against it (`again`); nothing
 *    stale lands. If it is still at `B`, the refusal is one that lasts as long as nothing changes (the branch is
 *    conflicted or behind its rows, the node takes no input, the merge isn't in the replica): the train pauses with it,
 *    after step 5, rather than check the same batch again and again.
 * 5. After landing (or straight away, if nothing landed), each task to rebase gets a prepare turn (`rebase`) onto the
 *    branch's new commit, and each blamed task one (`fix`) opening with the merge agent's report, all at once. A task
 *    whose own commits another task has built on can't rebase, and leaves. The turn must leave the work on the branch's
 *    commit as one described revision, or, for work holding another task's or started off main, merging cleanly with it.
 *
 * A train turn that fails (or can't be run) or ends without doing its job sits its task out (`waiting for <node>` when
 * the node is offline); a decline makes it leave. The round's tasks are those of its first `candidates`: a task queued
 * meanwhile waits for the next round, and one gone meanwhile (unqueued, archived) is dropped. A merge task that landed is
 * left to acceptance, which archives it; any other is discarded, except a stuck one, left for the user to open.
 *
 * `resume` is the last checkpoint of a round cut off by a restart, or paused (Retry). A merge task it names is
 * discarded unless its merge landed or it is gone (`TaskGone`), so the check starts afresh; when its head can't be read
 * for another reason, the round rejects before it checkpoints anything, so the checkpoint still names it for the next.
 * The tasks it names as describing or rebasing had their turns: one that is eligible again but still needs what its turn
 * was for sits out rather than being asked again, unless all it lacks is its test list, which the restart may have lost. Then the round starts over. A failure of `deps` (but a task's turn or abandon) or of reading the repo rejects.
 */
export async function runRound(deps: RoundDeps, cfg: NodeConfig, repo: string, prompt: string, resume?: RoundStep): Promise<RoundResult> {
  const round = new Round(deps, cfg, repo, prompt, await deps.branch());
  if (resume !== undefined && resume.mergeTask !== null) await round.clear(resume.mergeTask);
  const asked = (step: RoundStep["step"]) => new Set(resume?.step === step ? resume.batch : []);

  await round.describe(await round.read(), asked("describing"));
  await deps.checkpoint({ step: "picking", batch: [], mergeTask: null });
  const picked = await round.pick([...round.ready.values()]);
  if ("paused" in picked) return { landed: null, again: false, paused: picked.paused };
  if (picked.later.length > 0) round.again = true;

  const blamed: Blamed[] = [];
  const landing = await round.land(picked.batch, blamed, picked.rebase);
  if (landing === "again") return { landed: null, again: true, paused: null };
  if ("paused" in landing) return { landed: null, again: false, paused: landing.paused };
  if ("refused" in landing) {
    // The branch is still at B, so the turns this round owes are as good as if nothing had been picked.
    await round.rebase(round.B, picked.rebase, blamed, asked("rebasing"));
    return { landed: null, again: false, paused: landing.refused };
  }

  await round.rebase(landing.landed ?? round.B, picked.rebase, blamed, asked("rebasing"));
  return { landed: landing.landed, again: round.again, paused: null };
}

/** The eligible tasks by id, in the queue's order; the project's lines; and the ids of its queued tasks. */
type Snapshot = { candidates: Map<string, Candidate>; lines: LineRow[]; queued: Set<string> };

/**
 * What step 1 makes of a task: ready to land (`needs`: the queued tasks whose work it holds), work to do first (leftovers
 * to abandon, the prompt of a prepare turn), or out of the round (what put it out is done).
 */
type Settled =
  | { kind: "ready"; c: Candidate; needs: string[] }
  | { kind: "work"; c: Candidate; leftovers: string[]; prepare: string | null }
  | { kind: "out" };

/**
 * Whether a task had its prepare turn when step 1 settles it: not (`no`), in this round (`now`), or before the round was
 * resumed (`resumed`: its turn ran, but what it named may have been lost to a restart or a hold).
 */
type Turned = "no" | "now" | "resumed";

/** How a prepare turn may change a task's work (`Rewrite`), and how many revisions of its own it has, leftovers aside. */
type Shape = { rewrite: Rewrite; revisions: number };

/** A task the merge agent blamed, and what it reported. */
type Blamed = { c: Candidate; report: string };

const FROZEN = "another task builds on this work, so it can't rebase";
const STILL_CONFLICTS = "its work still doesn't merge cleanly with main after its rebase turn";
const NOT_READY = "its prepare turn didn't call ready";
const OFF_MAIN = "its work isn't on main after its prepare turn";

class Round {
  /** `RoundResult.again`. */
  again = false;
  /** The tasks ready after step 1, in the queue's order, and the queued tasks whose work each holds. */
  readonly ready = new Map<string, Candidate>();
  readonly #needs = new Map<string, string[]>();
  /** The tasks that left the queue in this round. */
  readonly #left = new Set<string>();
  #lines: LineRow[] = [];
  readonly #graph: Graph;

  constructor(
    readonly deps: RoundDeps, readonly cfg: NodeConfig, readonly repo: string, readonly prompt: string, readonly B: string,
  ) {
    this.#graph = gitGraph(cfg, repo);
  }

  /** The queue now; a task whose tip is on `B` already has nothing to land, and is none of the round's. */
  async read(): Promise<Snapshot> {
    const [all, lines] = await Promise.all([this.deps.candidates(), this.deps.lines()]);
    this.#lines = lines;
    const candidates = new Map<string, Candidate>();
    for (const c of all) if (!(await this.#graph.isAncestor(c.tip, this.B))) candidates.set(c.taskId, c);
    const queued = new Set(lines.filter((l) => !l.archived && l.queuedAt !== null && !this.#left.has(l.task)).map((l) => l.task));
    return { candidates, lines, queued };
  }

  /**
   * A merge task named by the round resumed: discarded unless its merge landed or it is gone (`TaskGone`). Any other
   * failure to read its head rejects: it may still be there, and the checkpoint naming it must stay for the next resume.
   */
  async clear(taskId: string): Promise<void> {
    let head: string;
    try {
      head = (await this.deps.head(taskId)).commitId;
    } catch (err) {
      if (err instanceof TaskGone) return;
      throw err;
    }
    // A merge that landed is in this repo, below B; one that isn't in the repo didn't land.
    if (await this.#graph.isAncestor(head, this.B).catch(() => false)) return;
    await this.deps.discard(taskId);
  }

  /** Step 1 for the tasks of `s` (`asked`: those that had a prepare turn before the round was resumed): fills `ready`. */
  async describe(s: Snapshot, asked: ReadonlySet<string>): Promise<void> {
    const ready = new Map<string, Extract<Settled, { kind: "ready" }>>();
    const work: Array<Extract<Settled, { kind: "work" }>> = [];
    for (const c of s.candidates.values()) {
      const r = await this.#settle(c, s, asked.has(c.taskId) ? "resumed" : "no");
      if (r.kind === "ready") ready.set(c.taskId, r);
      else if (r.kind === "work") work.push(r);
    }

    if (work.length > 0) {
      const preparing = work.filter((w) => w.prepare !== null).map((w) => w.c.taskId);
      await this.deps.checkpoint({ step: "describing", batch: preparing, mergeTask: null });
      const fixed = await Promise.all(work.map((w) => this.#fix(w)));
      // Every task is read again: those fixed have changed, and any may have left meanwhile.
      const fresh = await this.read();
      // The tasks still in the round after their fix, and whether they had a prepare turn; the tests a turn named are
      // kept for the work it left.
      const back = new Map<string, boolean>();
      for (const [i, w] of work.entries()) {
        const f = fixed[i];
        if (f === null || f === undefined) continue;
        back.set(w.c.taskId, f.turned);
        const c = fresh.candidates.get(w.c.taskId);
        if (c !== undefined && f.tests !== null) await this.#saveTests(c, f.tests);
      }
      for (const id of [...ready.keys(), ...back.keys()]) {
        const c = fresh.candidates.get(id);
        const r = c === undefined ? null : await this.#settle(c, fresh, back.get(id) === true ? "now" : "no");
        if (r?.kind === "ready") {
          ready.set(id, r);
          continue;
        }
        ready.delete(id);
        if (r?.kind === "work") {
          // It changed since it was read (its agent left empty revisions, or its work was changed outside a turn): it
          // goes in the next round.
          if (r.prepare === null) await this.#fix(r);
          this.again = true;
        }
      }
    }

    // A task holding a queued task's work goes only with it: it waits while that one isn't ready, and is held back when
    // that one left the queue in this round.
    for (let changed = true; changed;) {
      changed = false;
      for (const [id, r] of ready) {
        const missing = r.needs.find((n) => !ready.has(n));
        if (missing === undefined) continue;
        ready.delete(id);
        changed = true;
        if (this.#left.has(missing)) await this.#holdBack(r.c, missing);
      }
    }
    for (const id of s.candidates.keys()) {
      const r = ready.get(id);
      if (r === undefined) continue;
      this.ready.set(id, r.c);
      this.#needs.set(id, r.needs);
    }
  }

  /**
   * What step 1 makes of candidate `c`. A task needs a prepare turn when it has undescribed or conflicted revisions of
   * its own, several revisions it may squash, or no test list for its tip. After its turn (`now`), what it left
   * undone sits it out (`#problem`). A task whose turn ran before the round was resumed (`resumed`) sits out only for
   * revisions still undescribed or conflicted, which any turn asked for: what else it lacks (its test list, lost to a
   * restart or a hold; a squash or rebase an older meddle's turn didn't ask for) it is asked for again.
   */
  async #settle(c: Candidate, s: Snapshot, turned: Turned): Promise<Settled> {
    const k = await classify(this.cfg, this.repo, this.B, c, s.queued, s.lines);
    if (k.unfixable.length > 0) {
      const names = await this.#changes(k.unfixable.map((u) => u.commit));
      await this.#leave(c.taskId, k.unfixable.map((u, i) => `${short(names[i]!)} ${u.reason}`).join("; "));
      return { kind: "out" };
    }
    const outside = k.foreign.find((f) => !f.queued);
    if (outside !== undefined) {
      await this.#holdBack(c, outside.taskId);
      return { kind: "out" };
    }
    const shape = await this.#shape(c, this.B, s.lines, k, 1);
    const needs = k.foreign.map((f) => f.taskId);
    const problem = turned === "no" ? null : await this.#problem(c, this.B, shape, k, turned === "resumed");
    // A turn before a resume may have been one of an older meddle, which asked only for descriptions: it sits out for
    // those alone, and is asked again for the rest.
    if (problem !== null && (turned === "now" || k.toFix.length > 0)) {
      await this.#sitOut(c.taskId, problem);
      return { kind: "out" };
    }
    const turn = turned === "now"
      ? false
      : turned === "resumed"
      ? c.tests === null || problem !== null
      : k.toFix.length > 0 || c.tests === null || (isSquash(shape.rewrite) && shape.revisions > 1);
    if (!turn && k.leftovers.length === 0) return { kind: "ready", c, needs };
    const prepare = turn
      ? preparePrompt(
        { main: this.B, rewrite: shape.rewrite, describe: k.toFix.length > 0, conflicted: await this.#changes(k.conflicted) },
        this.prompt,
      )
      : null;
    return { kind: "work", c, leftovers: k.leftovers, prepare };
  }

  /**
   * Abandons `w`'s leftovers, then gives it its prepare turn: whether it had one and the tests it named, or null when
   * that put it out. A task the train only abandoned leftovers of keeps its test list, for the work as it is now.
   */
  async #fix(w: Extract<Settled, { kind: "work" }>): Promise<{ turned: boolean; tests: string[] | null } | null> {
    if (w.leftovers.length > 0) {
      try {
        await this.deps.abandonLeftovers(w.c.taskId, w.leftovers);
      } catch (err) {
        await this.#sitOut(w.c.taskId, failure(err, "the train could not abandon its empty revisions"));
        return null;
      }
    }
    if (w.prepare === null) {
      const now = (await this.deps.candidates()).find((c) => c.taskId === w.c.taskId);
      if (w.c.tests !== null && now !== undefined && now.tip !== w.c.tip) await this.#saveTests(now, w.c.tests);
      return { turned: false, tests: null };
    }
    const ended = await this.#turn(w.c.taskId, "describe", w.prepare);
    return ended === null ? null : { turned: true, tests: ended.tests };
  }

  /**
   * How a prepare turn onto `main` may change `c`'s work (`Shape`), `k` being what it would land (`classify`): not at all
   * when another task builds on it (`lines`: the project's line rows), nor in step 1 when it holds another task's work
   * (`keep`), which step 5 rebases; work that started off main is squashed where it is in step 1, and rebased in step 5;
   * the rest is rebased and squashed.
   */
  async #shape(c: Candidate, main: string, lines: readonly LineRow[], k: Classified, step: 1 | 5): Promise<Shape> {
    const own = await ownWork(this.cfg, this.repo, main, c, lines);
    const revisions = own.filter((x) => !k.leftovers.includes(x.commitId)).length;
    if (own.some((x) => !x.mutable)) return { rewrite: "none", revisions };
    if (k.foreign.length > 0) return { rewrite: step === 1 ? "keep" : "rebase", revisions };
    for (const b of c.base) {
      if (!(await this.#graph.isAncestor(b, main).catch(() => false))) return { rewrite: step === 1 ? "squash-here" : "rebase", revisions };
    }
    return { rewrite: "squash", revisions };
  }

  /**
   * What `c`'s prepare turn onto `main` left undone, as its sitting out says, or null: no test list (unless `resumed`,
   * where a lost list is asked for again), work to squash that isn't on main, work to rebase that doesn't merge cleanly
   * with it, revisions still undescribed or conflicted (`k`), or several revisions left to squash.
   */
  async #problem(c: Candidate, main: string, shape: Shape, k: Classified, resumed: boolean): Promise<string | null> {
    if (!resumed && c.tests === null) return NOT_READY;
    if (shape.rewrite === "squash" && !(await this.#graph.isAncestor(main, c.tip))) return OFF_MAIN;
    if (shape.rewrite === "rebase" && (await this.#conflicts(main, c.tip))) return STILL_CONFLICTS;
    if (k.toFix.length > 0) {
      const names = (await this.#changes(k.toFix)).map(short);
      return `${names.join(", ")} ${names.length === 1 ? "is" : "are"} still undescribed or conflicted after its prepare turn`;
    }
    if (isSquash(shape.rewrite) && shape.revisions > 1) return `its work is still ${shape.revisions} revisions after its prepare turn`;
    return null;
  }

  /** Keeps the tests `c`'s agent named for its work as it is now (`c.tip`). */
  async #saveTests(c: Candidate, tests: string[]): Promise<void> {
    await this.deps.saveTests(c.taskId, c.tip, tests);
    c.tests = tests;
  }

  /** Step 2 (`pickBatch`). Work git can't trial merge with `B` at all sits its task out, and the rest are picked again. */
  async pick(eligible: Candidate[]): Promise<Awaited<ReturnType<typeof pickBatch>> | { paused: string }> {
    try {
      return await pickBatch(this.cfg, this.repo, this.B, eligible);
    } catch (err) {
      const rest: Candidate[] = [];
      for (const c of eligible) {
        try {
          await trialMerge(this.cfg, this.repo, [this.B, c.tip]);
          rest.push(c);
        } catch (e) {
          await this.#sitOut(c.taskId, `its work could not be trial merged with main: ${messageOf(e)}`);
        }
      }
      if (rest.length === eligible.length) return { paused: `the batch could not be trial merged: ${messageOf(err)}` };
      return this.pick(rest);
    }
  }

  /**
   * Steps 3 and 4: checks `batch` (a task blamed goes to `blamed`, one whose merge isn't clean after all may go to
   * `rebase`) and lands what passes, as `runRound` says.
   */
  async land(
    batch: Candidate[], blamed: Blamed[], rebase: Candidate[],
  ): Promise<{ landed: string | null } | { paused: string } | { refused: string } | "again"> {
    let rest = batch;
    while (rest.length > 0) {
      const ids = rest.map((c) => c.taskId);
      const parents = await mergeParents(this.#graph, this.B, rest.map((c) => c.tip));
      let L = parents[0]!;
      let mergeTask: string | null = null;
      if (parents.length > 1) {
        await this.deps.checkpoint({ step: "checking", batch: ids, mergeTask: null });
        const verdict = await this.#check(rest);
        if (verdict.kind === "changed") return "again";
        if (verdict.kind === "stuck") return { paused: verdict.reason };
        if (verdict.kind === "unclean") {
          // The batch is the biggest first: the smallest task waits for a later round, unless nothing would be left.
          const others = this.#without(rest, rest.at(-1)!.taskId);
          if (others.length === 0) {
            rebase.push(...rest);
            return { landed: null };
          }
          this.again = true;
          rest = others;
          continue;
        }
        if (verdict.kind === "blamed") {
          const culprit = rest.find((c) => c.taskId === verdict.task)!;
          blamed.push({ c: culprit, report: verdict.reason });
          rest = this.#without(rest, culprit.taskId);
          continue;
        }
        ({ L, mergeTask } = verdict);
      }
      // `read` leaves out the tasks already on B, so the one head is never B: moving a branch to where it is isn't a no-op.
      if (L === this.B) return { landed: null };
      if (!(await this.#unchanged(rest))) {
        if (mergeTask !== null) await this.deps.discard(mergeTask);
        return "again";
      }
      await this.deps.checkpoint({ step: "landing", batch: ids, mergeTask });
      try {
        await this.deps.advance(this.B, L);
      } catch (err) {
        if (mergeTask !== null) await this.deps.discard(mergeTask);
        if (err instanceof BatchChanged || (await this.deps.branch()) !== this.B) return "again";
        return { refused: `landing was refused: ${messageOf(err)}` };
      }
      return { landed: L };
    }
    return { landed: null };
  }

  /**
   * `checkBatch`, with the merge task it makes recorded (`checkpoint`). When the check fails outright (`deps` rejects),
   * the merge task is discarded and the check is stuck; one that can't be discarded then is still named by the
   * checkpoint, for the round resumed to discard. A check a task of the batch left (`BatchChanged`) is `changed`, once
   * its merge task is discarded; one that can't be discarded then rejects, for the next round to discard it.
   */
  async #check(batch: Candidate[]): Promise<MergeVerdict | { kind: "changed" }> {
    const { deps } = this;
    const ids = batch.map((c) => c.taskId);
    const made = { task: null as string | null };
    const tracked: MergeDeps = {
      async createMergeTask(input) {
        const task = await deps.createMergeTask(input);
        made.task = task.taskId;
        await deps.checkpoint({ step: "checking", batch: ids, mergeTask: task.taskId });
        return task;
      },
      turn: (taskId, kind, text) => deps.turn(taskId, kind, text),
      head: (taskId) => deps.head(taskId),
      async discard(taskId) {
        await deps.discard(taskId);
        if (taskId === made.task) made.task = null;
      },
    };
    try {
      return await checkBatch(tracked, this.cfg, this.repo, { projectId: deps.projectId, B: this.B, batch, prompt: this.prompt });
    } catch (err) {
      if (err instanceof BatchChanged) {
        if (made.task !== null) await deps.discard(made.task);
        return { kind: "changed" };
      }
      if (made.task !== null) await deps.discard(made.task).catch(() => {});
      return { kind: "stuck", reason: failure(err, "the batch's check failed"), mergeTask: null };
    }
  }

  /** `batch` without task `id` and the tasks holding its work, which would land it. */
  #without(batch: Candidate[], id: string): Candidate[] {
    const dropped = new Set([id]);
    for (let changed = true; changed;) {
      changed = false;
      for (const c of batch) {
        if (dropped.has(c.taskId) || !(this.#needs.get(c.taskId) ?? []).some((n) => dropped.has(n))) continue;
        dropped.add(c.taskId);
        changed = true;
      }
    }
    return batch.filter((c) => !dropped.has(c.taskId));
  }

  /** Whether the tasks of `batch`, and those whose work they hold, are still eligible, at the tips they were picked at. */
  async #unchanged(batch: Candidate[]): Promise<boolean> {
    const now = new Map((await this.deps.candidates()).map((c) => [c.taskId, c.tip]));
    const ids = new Set(batch.flatMap((c) => [c.taskId, ...(this.#needs.get(c.taskId) ?? [])]));
    return [...ids].every((id) => now.get(id) === this.ready.get(id)?.tip);
  }

  /**
   * Step 5: prepare turns onto `main` (the branch's commit now) for `toRebase` (`rebase` turns) and `blamed` (`fix` turns,
   * opening with what the merge agent reported), all at once; a task whose own work another task has built on can't
   * rebase, and leaves. Each is read again after its turn, against `main` and the line rows now, and what it left undone
   * sits it out (`#problem`). A task `asked` had its turn already (a round resumed): as in step 1, only revisions still
   * undescribed or conflicted sit it out, and it is asked again for the rest.
   */
  async rebase(main: string, toRebase: Candidate[], blamed: Blamed[], asked: ReadonlySet<string>): Promise<void> {
    const lines = await this.deps.lines();
    const shapeOf = async (c: Candidate) => {
      const k = await classify(this.cfg, this.repo, main, c, new Set(), lines);
      return { k, shape: await this.#shape(c, main, lines, k, 5) };
    };
    const turns: Array<{ c: Candidate; kind: "rebase" | "fix"; rewrite: Rewrite; text: string }> = [];
    const asTurn = (c: Candidate, kind: "rebase" | "fix", rewrite: Rewrite, report?: string) => turns.push({
      c, kind, rewrite,
      text: preparePrompt({ main, rewrite, describe: true, conflicted: [], ...(report === undefined ? {} : { report }) }, this.prompt),
    });
    for (const c of toRebase) {
      const { k, shape } = await shapeOf(c);
      if (shape.rewrite === "none") {
        await this.#leave(c.taskId, FROZEN);
      } else if (asked.has(c.taskId)) {
        // As in step 1, only what every turn asked for sits it out; the rest it is asked for again.
        const problem = await this.#problem(c, main, shape, k, true);
        if (problem !== null && k.toFix.length > 0) await this.#sitOut(c.taskId, problem);
        else if (problem !== null || c.tests === null) asTurn(c, "rebase", shape.rewrite);
        else this.again = true;
      } else {
        asTurn(c, "rebase", shape.rewrite);
      }
    }
    for (const { c, report } of blamed) {
      const { shape } = await shapeOf(c);
      if (shape.rewrite === "none") await this.#leave(c.taskId, FROZEN);
      else asTurn(c, "fix", shape.rewrite, report);
    }
    if (turns.length === 0) return;

    await this.deps.checkpoint({ step: "rebasing", batch: turns.map((t) => t.c.taskId), mergeTask: null });
    const ended = await Promise.all(turns.map((t) => this.#turn(t.c.taskId, t.kind, t.text)));
    if (ended.every((e) => e === null)) return;
    const [now, fresh] = await Promise.all([this.deps.candidates(), this.deps.lines()]);
    const byId = new Map(now.map((c) => [c.taskId, c]));
    for (const [i, t] of turns.entries()) {
      const c = byId.get(t.c.taskId);
      const e = ended[i];
      if (e === null || e === undefined || c === undefined) continue;
      if (e.tests !== null) await this.#saveTests(c, e.tests);
      const k = await classify(this.cfg, this.repo, main, c, new Set(), fresh);
      const own = await ownWork(this.cfg, this.repo, main, c, fresh);
      const shape: Shape = { rewrite: t.rewrite, revisions: own.filter((x) => !k.leftovers.includes(x.commitId)).length };
      const problem = await this.#problem(c, main, shape, k, false);
      if (problem !== null) await this.#sitOut(c.taskId, problem);
      else this.again = true;
    }
  }

  /** Whether `tip` doesn't merge cleanly with `main` (work git can't trial merge is the next round's to find). */
  async #conflicts(main: string, tip: string): Promise<boolean> {
    try {
      return (await trialMerge(this.cfg, this.repo, [main, tip])).tree === null;
    } catch {
      return false;
    }
  }

  /**
   * Gives task `taskId` a train turn: the tests its agent named (`ready`) when it ended as asked, or null when it didn't.
   * A decline makes the task leave; a failure sits it out.
   */
  async #turn(taskId: string, kind: TrainTurnKind, text: string): Promise<{ tests: string[] | null } | null> {
    let outcome;
    try {
      outcome = await this.deps.turn(taskId, kind, text);
    } catch (err) {
      await this.#sitOut(taskId, failure(err, `its ${kind} turn could not run`));
      return null;
    }
    if (outcome.kind === "declined") {
      await this.#leave(taskId, declineReason(outcome.reason), true);
      return null;
    }
    if (outcome.kind === "failed") {
      await this.#sitOut(taskId, `its ${kind} turn failed: ${outcome.reason}`);
      return null;
    }
    return { tests: outcome.kind === "done" ? outcome.tests ?? null : null };
  }

  /** The change ids of `commits` (commit ids), in their order. */
  async #changes(commits: string[]): Promise<string[]> {
    if (commits.length === 0) return [];
    const found = new Map((await changesIn(this.repo, commits.join(" | "), this.cfg)).map((k) => [k.commitId, k.changeId]));
    return commits.map((commit) => found.get(commit) ?? commit);
  }

  async #leave(taskId: string, reason: string, declined = false): Promise<void> {
    this.#left.add(taskId);
    await this.deps.leave(taskId, reason, declined);
  }

  async #sitOut(taskId: string, reason: string): Promise<void> {
    await this.deps.sitOut(taskId, reason);
  }

  async #holdBack(c: Candidate, other: string): Promise<void> {
    await this.deps.holdBack(c.taskId, `${c.title} includes work from ${await this.deps.title(other)}, which isn't queued`);
  }
}

/**
 * Why a task whose node is offline sits out: `waiting for <node>`. Such a task comes back by itself when the node does,
 * unlike the others, which wait for Retry: the conductor clears it once the node is back (and until then `candidates`
 * leaves it out anyway).
 */
export function waitingFor(node: string): string {
  return `waiting for ${node}`;
}

/** Why a call for a task failed, as its sitting out says (`waitingFor` when the node is offline). */
function failure(err: unknown, what: string): string {
  return err instanceof NodeOffline ? waitingFor(err.node) : `${what}: ${messageOf(err)}`;
}

function messageOf(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim();
}

/** Whether a task's work is to be squashed into one revision. */
function isSquash(rewrite: Rewrite): boolean {
  return rewrite === "squash" || rewrite === "squash-here";
}

/** A change id as a notice names it: its first 12 characters, as unambiguous as jj needs in practice. */
function short(changeId: string): string {
  return changeId.slice(0, 12);
}
