// src/train/surface.ts — what the CLI says and takes of a project's merge train: its text, the arguments of `meddle
// train`, the project it names, and telling a holder of an older meddle (one that has no train) by what chord answers.
import { isChordError } from "@earendil-works/chord";
import type { Static } from "typebox";
import { resolveProject, type PoolProject } from "../pool/projects";
import type { TrainStateSchema } from "../state/contracts";

/** A train as a node serves it (`ProjectObject.train`): `TrainState`, a task's state as the open string it travels as. */
export type TrainView = Static<typeof TrainStateSchema>;

/**
 * A train as `meddle train` prints it: why it is paused (when it is), the queue in the order tasks were accepted, each
 * with its title, id and state (and the reason it sits out, or is held back, when there is one), then the round under
 * way: its step, its batch and its merge task. A task `titles` lacks (one of a node that is not answering) is shown by
 * its id alone.
 */
export function trainText(state: TrainView, titles: ReadonlyMap<string, string>): string {
  const named = (id: string) => (titles.has(id) ? `${titles.get(id)} (${id})` : id);
  const lines: string[] = [];
  if (state.paused !== null) lines.push(`paused: ${state.paused}`);
  if (state.queued.length === 0) lines.push("nothing queued");
  else {
    lines.push("queued:");
    for (const t of state.queued) lines.push(`  ${named(t.taskId)}  ${t.state}${t.reason === null ? "" : `: ${t.reason}`}`);
  }
  if (state.round !== null) {
    lines.push(`round: ${state.round.step}`);
    if (state.round.batch.length > 0) lines.push(`  batch: ${state.round.batch.map(named).join(", ")}`);
    if (state.round.mergeTask !== null) lines.push(`  merge task: ${named(state.round.mergeTask)}`);
  }
  return lines.join("\n");
}

/** What `meddle train …` was asked to do: show the train (`follow`: until its queue is empty), pause it, or resume it. */
export type TrainArgs = { action: "show" | "pause" | "resume"; project: string | undefined; follow: boolean };

/**
 * The arguments after `train`: `[<project>] [--follow]`, or `pause|resume [<project>]`; null for anything else (two
 * projects, another flag, `--follow` repeated or with pause or resume). A project called `pause` or `resume` is named by
 * its id.
 */
export function trainArgs(args: string[]): TrainArgs | null {
  const action = args[0] === "pause" || args[0] === "resume" ? args[0] : "show";
  const rest = action === "show" ? args : args.slice(1);
  const follows = rest.filter((a) => a === "--follow").length;
  const words = rest.filter((a) => a !== "--follow");
  if (follows > 1 || (follows === 1 && action !== "show") || words.length > 1 || words.some((w) => w.startsWith("--"))) return null;
  if (words[0] === "pause" || words[0] === "resume") return null;
  return { action, project: words[0], follow: follows === 1 };
}

/**
 * The project a train command acts on: the one `arg` names (an id or a name, see `resolveProject`); without one, the
 * project of the checkout the command runs in (`here`, its id) when the pool lists it, else the pool's only project.
 * Throws `unknown project: <x>` for one the pool does not list (it names no home to run the train on), `the pool has no
 * projects`, and `name a project: <name> (<id>), …` when none can be chosen.
 */
export function trainProjectChoice(projects: readonly PoolProject[], arg: string | undefined, here: string | null): PoolProject {
  if (arg !== undefined) {
    const id = resolveProject(projects, arg);
    const found = projects.find((p) => p.id === id);
    if (found === undefined) throw new Error(`unknown project: ${arg}`);
    return found;
  }
  const checkedOut = projects.find((p) => p.id === here);
  if (checkedOut !== undefined) return checkedOut;
  if (projects.length === 1) return projects[0]!;
  if (projects.length === 0) throw new Error("the pool has no projects");
  throw new Error(`name a project: ${projects.map((p) => `${p.name} (${p.id})`).join(", ")}`);
}

/**
 * Whether `err` is what a node of a meddle older than the train answers a client that asks for it: a member it does
 * not have (`not_in_variant`), or, as the client binds the object, a contract that lacks a member the client's has
 * (chord refuses the binding as `contract_mismatch`, told to a client as `upgrade_required`). A contract that differs
 * in another way (a version, another placement) is not this.
 */
export function olderHolder(err: unknown): boolean {
  if (!isChordError(err)) return false;
  if (err.code === "not_in_variant") return true;
  return (err.code === "upgrade_required" || err.code === "contract_mismatch") && err.message.includes(" missing or of another kind)");
}
