// What the merge train asks of tasks and of the merge agent, in the spec's words.

/**
 * How a prepare turn may change a task's own work: `squash` (rebase it onto main and squash it into one revision),
 * `squash-here` (squash it where it is: it started on a revision that isn't on main, which lands with it), `rebase`
 * (rebase its own revisions onto main, without squashing: they hold another task's work, or its start isn't on main),
 * `keep` (it holds another task's work: neither) or `none` (another task builds on it: neither).
 */
export type Rewrite = "squash" | "squash-here" | "rebase" | "keep" | "none";

const DECLINE =
  "If your change no longer makes sense on main, because something it relies on is gone or has changed meaning, call decline with the reason.";

/**
 * A prepare turn onto main at `main`: as `rewrite` allows, rebase, squash and describe the task's work, and call
 * `ready` with the commands that run its tests. `prompt` is the `describe.prompt` setting; for `keep` and `none` it is
 * asked only when the task has undescribed or conflicted revisions of its own (`describe`). The conflicted ones
 * (`conflicted`, change ids) are named where no rebase is asked (`squash-here`, `keep`, `none`). A blamed task's turn opens with the merge agent's `report`.
 */
export function preparePrompt(
  p: { main: string; rewrite: Rewrite; describe: boolean; conflicted: string[]; report?: string }, prompt: string,
): string {
  const tests = "run the tests your change affects (not the full suite)";
  const ready = "Then call ready with the commands that run those tests.";
  let body: string;
  if (p.rewrite === "squash") {
    body = `rebase it onto main (${p.main}) and fix any conflicts, ${tests}, squash your revisions into one, then ${prompt} ${ready}`;
  } else if (p.rewrite === "squash-here") {
    // Not rebased, so not told to fix conflicts as a rebase would: told which of its revisions are conflicted.
    const conflicts = p.conflicted.length === 0 ? "" : `resolve the conflicts in ${listed(p.conflicted)}, `;
    body = `${conflicts}${tests}, squash your revisions into one, then ${prompt} ${ready}`;
  } else if (p.rewrite === "rebase") {
    body = `rebase your own revisions onto main (${p.main}) and fix any conflicts, ${tests}, then ${prompt} ${ready}`;
  } else {
    const lead = p.rewrite === "keep"
      ? "it holds another task's work, so don't rebase or squash it."
      : "another task builds on your revisions, so don't rebase or squash them.";
    const conflicts = p.conflicted.length === 0 ? "" : `Resolve the conflicts in ${listed(p.conflicted)}, then `;
    const describe = p.describe ? `${conflicts}${prompt} ` : "";
    body = `${lead} ${describe}Run the tests your change affects (not the full suite), then call ready with the commands that run them.`;
  }
  const turn = `Before your work lands on main: ${body} ${DECLINE}`;
  if (p.report === undefined) return turn;
  return `The merge agent that checked your work together with other tasks on main reported: ${p.report}\n\n${turn}`;
}

/**
 * The merge task's first prompt: check that `tasks`, merged cleanly as `change`, work together, running the tests each
 * task's agent named (`tests`, null when it named none) and any others the combination needs; then `prompt`.
 */
export function mergePrompt(tasks: Array<{ task: string; tests: string[] | null }>, change: string, prompt: string): string {
  const named = tasks.filter((t) => t.tests !== null && t.tests.length > 0);
  const run = named.length === 0
    ? "Run the typecheck and the tests that cover what they change; "
    : "Their agents name the tests that cover their changes: " +
      `${named.map((t) => `${t.task}: ${t.tests!.map((c) => `\`${c}\``).join(", ")}`).join("; ")}. ` +
      "Run the typecheck, those tests, and any others the combination needs; ";
  return (
    `Check that ${listed(tasks.map((t) => t.task))} work together on main. Merged cleanly as ${change}. ${run}` +
    "don't run the full suite, and don't change any files. If a test fails, call blame with the task responsible and what " +
    `failed. Otherwise: ${prompt}`
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
