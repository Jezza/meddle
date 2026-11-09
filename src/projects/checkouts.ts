// Checkouts: your own jj repos of a project, each with a git remote `meddle` pointing at the node on this machine
// (`meddle://<node id>/project/<id>`, which the `git-remote-meddle` helper serves). Only the CLI process runs these,
// inside a command you ran (`project add`, `checkout`, `task new`): nothing of meddle's service ever runs jj or git in
// a checkout.
import { readdir } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { paths, type NodeConfig } from "../config";
import { bookmarkRefs, changesIn, cloneColocated, git, initColocated, isJjRepo, jj, JjError, networkMs, track } from "../jj";
import type { HandoffMode } from "../tasks/manifest";
import { checkColocated, type Project } from "./project";

/** The remote a checkout fetches from and pushes to. */
const CHECKOUT_REMOTE = "meddle";

/** The url of project `projectId` on node `selfId`, a checkout's remote `meddle`. */
function checkoutUrl(selfId: string, projectId: string): string {
  return `meddle://${selfId}/project/${projectId}`;
}

/**
 * Rejects `git-remote-meddle is not on your PATH; add <data>/bin to it` unless `env.PATH` has it: git finds the helper
 * by name, so a `jj git fetch` you type in a checkout needs it there.
 */
export function checkHelperOnPath(cfg: NodeConfig, env: Record<string, string | undefined> = process.env): void {
  if (Bun.which("git-remote-meddle", { PATH: env.PATH ?? "" }) === null) {
    throw new Error(`git-remote-meddle is not on your PATH; add ${paths(cfg).bin} to it`);
  }
}

/**
 * Makes `dir` a colocated jj repo when it is not a jj repo (a plain folder, or a git repo); rejects
 * `<dir> is a jj repo without a colocated git repo` for one jj keeps its git repo for elsewhere.
 */
export async function colocate(cfg: NodeConfig, dir: string): Promise<void> {
  const path = resolve(dir);
  if (!(await isJjRepo(path))) await initColocated(path, cfg);
  await checkColocated(path);
}

/**
 * Attaches the colocated jj repo `dir` to `project` on this node (`selfId`) as a checkout: the remote `meddle`
 * (`git remote add`, or its url corrected), then `jj git fetch --remote meddle`, tracking `<default>@meddle` when the
 * project's default branch arrived. Without `fetch` (default true), only the remote. Rejects first, with nothing done,
 * unless `git-remote-meddle` is on `env.PATH`.
 */
export async function attachCheckout(
  cfg: NodeConfig, selfId: string, dir: string, project: Pick<Project, "id" | "defaultBranch">,
  env: Record<string, string | undefined> = process.env, options: { fetch?: boolean } = {},
): Promise<void> {
  checkHelperOnPath(cfg, env);
  const url = checkoutUrl(selfId, project.id);
  const current = await git(["remote", "get-url", CHECKOUT_REMOTE], dir, cfg).then((out) => out.trim(), () => null);
  if (current === null) await git(["remote", "add", CHECKOUT_REMOTE, url], dir, cfg);
  else if (current !== url) await git(["remote", "set-url", CHECKOUT_REMOTE, url], dir, cfg);
  if (options.fetch === false) return;
  await jj(["git", "fetch", "--remote", CHECKOUT_REMOTE], dir, cfg, { timeoutMs: networkMs(cfg) });
  const branch = project.defaultBranch;
  if (branch === null) return;
  const fetched = (await bookmarkRefs(dir, `exact:${branch}`, cfg)).find((r) => r.remote === CHECKOUT_REMOTE);
  if (fetched !== undefined && !fetched.tracked) await track(dir, `exact:${branch}`, CHECKOUT_REMOTE, cfg);
}

/**
 * Clones `project` from this node (`selfId`) into `dir` (default `./<project name>`) as a colocated checkout whose
 * remote is `meddle`; returns its path. Rejects `<dir> exists and is not empty`, and, first, unless
 * `git-remote-meddle` is on `env.PATH`.
 */
export async function makeCheckout(
  cfg: NodeConfig, selfId: string, project: Pick<Project, "id" | "name">, dir?: string,
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  checkHelperOnPath(cfg, env);
  const path = resolve(dir ?? basename(project.name));
  const entries = await readdir(path).catch(() => null);
  if (entries !== null && entries.length > 0) throw new Error(`${path} exists and is not empty`);
  await cloneColocated(checkoutUrl(selfId, project.id), path, cfg, CHECKOUT_REMOTE);
  return path;
}

/** The checkout `cwd` is in: its root, and the node and project its remote `meddle` names; null when it is none. */
export async function checkoutAt(cfg: NodeConfig, cwd: string): Promise<{ dir: string; nodeId: string; projectId: string } | null> {
  let dir: string;
  try {
    dir = (await jj(["root", "--ignore-working-copy"], cwd, cfg)).trim();
  } catch {
    return null;
  }
  const url = await git(["remote", "get-url", CHECKOUT_REMOTE], dir, cfg).then((out) => out.trim(), () => null);
  const match = url === null ? null : /^meddle:\/\/([^/]+)\/project\/([^/]+)$/.exec(url);
  return match === null ? null : { dir, nodeId: match[1]!, projectId: match[2]! };
}

/** What jj (0.45) says of a revset that names no revision, or does not parse. */
const NOT_A_REVISION = /^Error: (Revision `.*` doesn't exist|Failed to parse revset: )/m;

/** The fork point of a checkout's `@`: the nearest revisions below it with changes (or merges). */
const FORK_POINT = "heads(::@ ~ (empty() ~ merges()))";

/**
 * The checkout side of a task's start, in the checkout `dir` of project `name` (run by `task new`, the user's command
 * there): resolves `rev` there (none: the fork point of `@`), refused `no revision <rev> in <project>`,
 * `<rev> names <n> revisions in <project>`, and `cannot start a task on the root commit` for a child of the root. In
 * `edit` mode, checks W there in the spec's order: `<W> is immutable`, `<W> is <workspace>'s working copy; move off it
 * first`, `<W> has revisions on top of it` and `nothing to hand off: <W> has no changes`; when W's only child is the
 * checkout's own `@` and `@` is empty, it rebases `@` onto W's parents instead of refusing, and `moved` says so. Then
 * pushes the commit to the node (`git push meddle <commit>:refs/meddle/incoming/<commit>`). Returns the commit.
 */
export async function pushStart(
  cfg: NodeConfig, dir: string, name: string, rev: string | null, mode: HandoffMode,
): Promise<{ commit: string; moved: string | null }> {
  // A snapshot first, as any jj command you type takes: `@` as it is now.
  await jj(["log", "-r", "@", "--no-graph", "-T", "''"], dir, cfg);
  let resolved: Array<{ changeId: string; commitId: string }>;
  try {
    resolved = await changesIn(dir, rev ?? FORK_POINT, cfg);
  } catch (err) {
    if (err instanceof JjError && NOT_A_REVISION.test(err.stderr)) throw new Error(`no revision ${rev ?? FORK_POINT} in ${name}`);
    throw err;
  }
  // Nothing below `@` has changes: its fork point is the root.
  if (resolved.length === 0 && rev === null) throw new Error("cannot start a task on the root commit");
  if (resolved.length === 0) throw new Error(`no revision ${rev} in ${name}`);
  if (resolved.length > 1) throw new Error(`${rev ?? FORK_POINT} names ${resolved.length} revisions in ${name}`);
  const { changeId, commitId: commit } = resolved[0]!;
  const W = changeId.slice(0, 12);
  let moved: string | null = null;
  if (mode === "child") {
    if ((await changesIn(dir, `${commit} & root()`, cfg)).length > 0) throw new Error("cannot start a task on the root commit");
  } else {
    if ((await changesIn(dir, `${commit} & immutable()`, cfg)).length > 0) throw new Error(`${W} is immutable`);
    const list = await jj(["workspace", "list", "--ignore-working-copy", "-T", 'name ++ "\\x1f" ++ target.commit_id() ++ "\\n"'], dir, cfg);
    for (const line of list.split("\n").filter(Boolean)) {
      const [workspace = "", target = ""] = line.split("\x1f");
      if (target === commit) throw new Error(`${W} is ${workspace}'s working copy; move off it first`);
    }
    const children = await changesIn(dir, `children(${commit})`, cfg);
    const emptyAt = await changesIn(dir, "@ & empty()", cfg);
    const onlyEmptyAt = children.length === 1 && emptyAt.length === 1 && children[0]!.commitId === emptyAt[0]!.commitId;
    if (children.length > 0 && !onlyEmptyAt) throw new Error(`${W} has revisions on top of it`);
    if ((await changesIn(dir, `${commit} & empty()`, cfg)).length > 0) throw new Error(`nothing to hand off: ${W} has no changes`);
    if (onlyEmptyAt) {
      const parents = await changesIn(dir, `${commit}-`, cfg);
      await jj(["rebase", "-r", "@", ...parents.flatMap((p) => ["-o", p.commitId])], dir, cfg);
      moved = `moved your empty @ off ${W}`;
    }
  }
  await git(["push", "--quiet", CHECKOUT_REMOTE, `${commit}:refs/meddle/incoming/${commit}`], dir, cfg, { timeoutMs: networkMs(cfg) });
  return { commit, moved };
}

/** Fetches the node's view into checkout `dir` (`jj git fetch --remote meddle`): the new task's line among it. */
export async function fetchCheckout(cfg: NodeConfig, dir: string): Promise<void> {
  await jj(["git", "fetch", "--remote", CHECKOUT_REMOTE], dir, cfg, { timeoutMs: networkMs(cfg) });
}
