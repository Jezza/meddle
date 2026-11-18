// What the train page and the Accept buttons decide without a DOM: a project's train as the page's two columns, and
// what a task offers the train. Pure: no Preact.
import type { TrainView } from "../../train/surface";

export type { TrainView };

/** The round's steps in the order a round goes through them; a round that rebases afterwards adds `rebasing`. */
const STEPS = ["describing", "picking", "checking", "landing"] as const;

/** One step of the round, as the page draws it: finished, or the one under way (neither: still to come). */
export type StepView = { name: string; done: boolean; now: boolean };

/** What the page shows of a train: the queue, the round under way (null when none), and why it is paused. */
export type TrainColumns = {
  queued: Array<{ taskId: string; title: string; state: string }>;
  round: {
    steps: StepView[];
    /** The merge task checking the batch; null before it is made, and for a single head, which lands without one. */
    mergeTask: string | null;
    /** The batch hanging under the merge task. */
    batch: Array<{ taskId: string; title: string }>;
  } | null;
  paused: string | null;
};

/**
 * The page's columns for a train: Queued (the tasks in the order they were accepted, each with the state the home gives
 * it) and This round (its steps with the current one marked, its merge task, and the batch under it). A batch hangs
 * under the round once it is being checked or landed; before (describing) and after (rebasing), its tasks are in the
 * queue with what is being done to them, as the home states it. A task `tasks` does not list (one on a node that is not
 * answering) is shown by its id.
 */
export function trainColumns(state: TrainView, tasks: ReadonlyMap<string, { title: string }>): TrainColumns {
  const title = (taskId: string) => tasks.get(taskId)?.title ?? taskId;
  const round = state.round;
  const hanging = round !== null && (round.step === "checking" || round.step === "landing") ? round.batch : [];
  const names: string[] = round?.step === "rebasing" ? [...STEPS, "rebasing"] : [...STEPS];
  const current = round === null ? -1 : names.indexOf(round.step);
  return {
    queued: state.queued.filter((t) => !hanging.includes(t.taskId)).map((t) => ({ taskId: t.taskId, title: title(t.taskId), state: t.state })),
    round: round === null ? null : {
      steps: names.map((name, i) => ({ name, done: i < current, now: i === current })),
      mergeTask: round.mergeTask,
      batch: hanging.map((taskId) => ({ taskId, title: title(taskId) })),
    },
    paused: state.paused,
  };
}

/**
 * What the merge task's card says it is doing: starting (no task of it is listed yet), running its checks (a turn runs),
 * waiting on you, or verifying (its turn ended, and the train checks what it left); landing once the branch moves.
 */
export function mergeStatus(step: string, taskState: string | null): string {
  if (step === "landing") return "landing";
  if (taskState === null) return "starting";
  if (taskState === "running") return "running its checks";
  if (taskState === "waiting") return "waiting on you";
  return "verifying";
}

/**
 * Why the train cannot be read from `home`, as the page says it: a node of a meddle older than the train, which chord
 * refuses to bind (`upgrade_required` or `contract_mismatch`) or which lacks the member (`not_in_variant`), is said to
 * run an older meddle; any other error is shown as it came.
 */
export function trainError(error: string, home: string): string {
  return /upgrade_required|contract_mismatch|not_in_variant/.test(error) ? `${home} runs an older meddle: it has no train.` : error;
}

/**
 * The reason a train the user paused gives (`PAUSED_BY_USER`, `src/state/host.ts`). Any other reason is the train's own
 * (its merge agent got stuck), which the page offers a Retry for.
 */
const PAUSED_BY_USER = "you paused it";

/** The button that lets a paused train carry on: Resume after the user's pause, Retry after the train's own. */
export function resumeLabel(paused: string): "Resume" | "Retry" {
  return paused === PAUSED_BY_USER ? "Resume" : "Retry";
}

/** What a task offers the train: Accept, Unqueue, or neither. */
export type TrainOffer = "accept" | "unqueue" | null;

/**
 * Accept for a task that is idle or running and not queued; Unqueue for a queued task that is live; none for a merge
 * task (it lands with its train), one moving, moved, or archived, a task with no project (`projects`: how many it has;
 * there is no train for it), or a task on a node that says nothing of a queue (`queued` null: an older meddle). The node
 * says why it refuses one anyway (prompts waiting, no work to land, several projects).
 */
export function trainOffer(t: { state: string; queued: boolean | null; merge: boolean; moving: boolean; projects: number }): TrainOffer {
  if (t.merge || t.moving || t.queued === null || t.projects === 0) return null;
  if (t.queued) return t.state === "idle" || t.state === "running" || t.state === "waiting" ? "unqueue" : null;
  return t.state === "idle" || t.state === "running" ? "accept" : null;
}
