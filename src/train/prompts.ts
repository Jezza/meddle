// What the merge train asks of tasks and of the merge agent, in the spec's words.

/**
 * A describe turn: `Before your work lands on main: `, then (when any are conflicted) `resolve the conflicts in
 * <changes>, then `, then `prompt` (the `describe.prompt` setting) as it is.
 */
export function describePrompt(prompt: string, conflicted: string[]): string {
  const conflicts = conflicted.length === 0 ? "" : `resolve the conflicts in ${listed(conflicted)}, then `;
  return `Before your work lands on main: ${conflicts}${prompt}`;
}

/**
 * A rebase turn onto main at `commit`. A fix turn (a task the merge agent blamed) opens with the agent's `report`.
 */
export function rebasePrompt(commit: string, report?: string): string {
  const rebase =
    `main moved on, and your work no longer merges cleanly with it. Rebase onto main (${commit}), fix the conflicts, ` +
    "run the tests your changes affect (not the full suite), and keep each revision described. If your change no " +
    "longer makes sense on main, because something it relies on is gone or has changed meaning, call decline with the reason.";
  if (report === undefined) return rebase;
  return `The merge agent that checked your work together with other tasks on main reported: ${report}\n\n${rebase}`;
}

/** The merge task's first prompt: check that `tasks`, merged cleanly as `change`, work together; then `prompt`. */
export function mergePrompt(tasks: string[], change: string, prompt: string): string {
  return (
    `Check that ${listed(tasks)} work together on main. Merged cleanly as ${change}. Run the typecheck and the tests ` +
    "that cover what they change; don't run the full suite, and don't change any files. If a test fails, call blame " +
    `with the task responsible and what failed. Otherwise: ${prompt}`
  );
}

/** The merge task's title: `Merge <task titles>`, the titles apart by commas (a title may hold an "and"). */
export function mergeTitle(titles: string[]): string {
  return `Merge ${titles.join(", ")}`;
}

/** `a`, `a and b`, `a, b and c`. */
function listed(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)!}`;
}
