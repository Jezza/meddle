// A scope's repo on one node: a colocated jj repo whose bookmark (`profile`, `memory`) is the node's head. What the
// node's tasks write is committed onto it (`commitLocal`); other nodes' heads are merged into it by git with meddle's
// merge drivers (`mergeHeads`), deterministically, so two nodes merging the same heads make the identical commit and the
// pool settles; the working copy then moves onto the new head (`moveTo`) without ever holding a conflict.
// Every function expects its caller to hold `serialised(repoKey(dir))`.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { NodeConfig } from "../config";
import { git, GitError, initColocated, isJjRepo, jj } from "../jj";
import { paths } from "../paths";
import { RULE_VERSION } from "./merge-file";
import { scopeBookmark, type Scope } from "./scope";

const ROOT = "0".repeat(40);

/** The date of commits meddle makes that stand for no one's work (the empty base, a conflict's sides): git refuses 0. */
const SYNTHETIC_DATE = 1_700_000_000;

/** The git version merges need: `merge-tree -X` came in 2.43. */
const GIT_FLOOR = [2, 43] as const;

/** Throws `meddle needs git 2.43 or later (found <v>)` when this machine's git is older (or unreadable). */
export async function checkGit(): Promise<void> {
  const out = (await git(["--version"], process.cwd()).catch(() => "")).trim();
  const match = /(\d+)\.(\d+)/.exec(out);
  const found = match === null ? null : [Number(match[1]), Number(match[2])] as const;
  if (found === null || found[0] < GIT_FLOOR[0] || (found[0] === GIT_FLOOR[0] && found[1] < GIT_FLOOR[1])) {
    throw new Error(`meddle needs git ${GIT_FLOOR.join(".")} or later (found ${out === "" ? "none" : out})`);
  }
}

/** `text` quoted for sh. */
function shq(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

async function writeIfChanged(file: string, text: string): Promise<void> {
  if ((await readFile(file, "utf8").catch(() => null)) !== text) await writeFile(file, text);
}

/**
 * Makes `dir` a scope repo (a colocated jj repo first, when it is none): every file merges through meddle's driver; jj
 * keeps a commit a bookmark moved off (a sideways move never strands the working copy) and snapshots files up to
 * 50 MiB; the profile never takes `skills/synced` (Claude Code's own copy of the account's skills). Idempotent.
 */
export async function prepareScopeRepo(cfg: NodeConfig, dir: string, s: Scope): Promise<void> {
  if (!(await isJjRepo(dir))) await initColocated(dir, cfg);
  const info = join(dir, ".git", "info");
  await mkdir(info, { recursive: true });
  await writeIfChanged(join(info, "attributes"), "* merge=meddle\n");
  const driver = `${shq(paths(cfg).binMergeDriver)} %O %A %B %P`;
  const current = (await git(["config", "--get", "merge.meddle.driver"], dir, cfg).catch(() => "")).trim();
  if (current !== driver) {
    await git(["config", "merge.meddle.name", "meddle"], dir, cfg);
    await git(["config", "merge.meddle.driver", driver], dir, cfg);
  }
  if ((await git(["config", "--get", "meddle.prepared"], dir, cfg).catch(() => "")).trim() !== "1") {
    await jj(["config", "set", "--repo", "git.abandon-unreachable-commits", "false"], dir, cfg);
    await jj(["config", "set", "--repo", "snapshot.max-new-file-size", "50MiB"], dir, cfg);
    await git(["config", "meddle.prepared", "1"], dir, cfg);
  }
  if (s.kind === "profile") {
    const exclude = join(info, "exclude");
    const text = (await readFile(exclude, "utf8").catch(() => "")) ?? "";
    if (!text.split("\n").includes("/skills/synced/")) await writeFile(exclude, `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}/skills/synced/\n`);
  }
}

/** The commit the scope's bookmark is at as git has it (a peer's push included), or null without one. */
export async function headOf(cfg: NodeConfig, dir: string, s: Scope): Promise<string | null> {
  try {
    return (await git(["rev-parse", "--verify", "-q", `refs/heads/${scopeBookmark(s)}^{commit}`], dir, cfg)).trim() || null;
  } catch (err) {
    if (err instanceof GitError && err.code === 1) return null;
    throw err;
  }
}

/** Whether commit `a` is `b` or an ancestor of it. */
export async function isAncestor(cfg: NodeConfig, dir: string, a: string, b: string): Promise<boolean> {
  try {
    await git(["merge-base", "--is-ancestor", a, b], dir, cfg);
    return true;
  } catch (err) {
    if (err instanceof GitError && err.code === 1) return false;
    throw err;
  }
}

/** Whether commits `a` and `b` hold the same files. */
export async function sameTree(cfg: NodeConfig, dir: string, a: string, b: string): Promise<boolean> {
  const tree = async (c: string) => (await git(["rev-parse", `${c}^{tree}`], dir, cfg)).trim();
  return (await tree(a)) === (await tree(b));
}

/** The committer time of `commit`, in seconds. */
async function committedAt(cfg: NodeConfig, dir: string, commit: string): Promise<number> {
  return Number((await git(["log", "-1", "--format=%ct", commit], dir, cfg)).trim());
}

/** A commit of `tree` with meddle's fixed metadata at `date` (seconds): the same bytes, so the same id, on every node. */
async function commitTree(cfg: NodeConfig, dir: string, tree: string, parents: string[], message: string, date: number): Promise<string> {
  const stamp = `${date} +0000`;
  const env = {
    GIT_AUTHOR_NAME: "meddle", GIT_AUTHOR_EMAIL: "meddle@localhost", GIT_AUTHOR_DATE: stamp,
    GIT_COMMITTER_NAME: "meddle", GIT_COMMITTER_EMAIL: "meddle@localhost", GIT_COMMITTER_DATE: stamp,
  };
  const args = ["-c", "commit.gpgsign=false", "commit-tree", tree, ...parents.flatMap((p) => ["-p", p]), "-F", "-"];
  return (await git(args, dir, cfg, { env, input: message })).trim();
}

/** A parentless commit of the empty tree: the base two unrelated lines merge over. */
async function emptyCommit(cfg: NodeConfig, dir: string): Promise<string> {
  const tree = (await git(["mktree"], dir, cfg, { input: "" })).trim();
  return commitTree(cfg, dir, tree, [], "empty\n", SYNTHETIC_DATE);
}

/**
 * The base `first` and `second` merge over, chosen by meddle so it never depends on how git orders bases: none, the
 * empty commit; one, it; several, folded in commit-id order, each step a merge of its own.
 */
async function mergeBaseOf(cfg: NodeConfig, dir: string, first: string, second: string): Promise<string> {
  let out = "";
  try {
    out = await git(["merge-base", "--all", first, second], dir, cfg);
  } catch (err) {
    if (!(err instanceof GitError && err.code === 1)) throw err;
  }
  const bases = out.split("\n").filter((l) => l !== "").sort();
  if (bases.length === 0) return emptyCommit(cfg, dir);
  let base = bases[0]!;
  for (const next of bases.slice(1)) base = await mergeHeads(cfg, dir, base, next);
  return base;
}

type MergeMessage = { paths: string[]; type: string; message: string };

/** `git merge-tree --write-tree -z --name-only --messages` output: the tree, the conflicted paths and the messages. */
function parseMergeTree(out: string): { tree: string; messages: MergeMessage[] } {
  const parts = out.split("\0");
  const tree = parts[0]!.trim();
  let i = 1;
  while (i < parts.length && parts[i] !== "") i++;
  i++;
  const messages: MergeMessage[] = [];
  while (i < parts.length && parts[i] !== "") {
    const count = Number(parts[i]);
    const paths = parts.slice(i + 1, i + 1 + count);
    i += 1 + count;
    messages.push({ paths, type: parts[i]!, message: (parts[i + 1] ?? "").trim() });
    i += 2;
  }
  return { tree, messages };
}

/** `tree` with each of `fix` (and what lies under it) as `second` has it: how a conflict of kinds of entry resolves. */
async function takeSecond(cfg: NodeConfig, dir: string, tree: string, second: string, fix: Set<string>): Promise<string> {
  const index = join(dir, ".git", `meddle-merge-${randomUUID()}.index`);
  const env = { GIT_INDEX_FILE: index };
  try {
    await git(["read-tree", tree], dir, cfg, { env });
    for (const path of fix) await git(["rm", "--cached", "-r", "-q", "--ignore-unmatch", "--", path], dir, cfg, { env });
    let entries = "";
    for (const path of fix) {
      for (const line of (await git(["ls-tree", "-r", "-z", second, "--", path], dir, cfg)).split("\0")) {
        const match = /^(\d+) \w+ ([0-9a-f]+)\t(.*)$/s.exec(line);
        if (match !== null) entries += `${match[1]} ${match[2]}\t${match[3]}\0`;
      }
    }
    if (entries !== "") await git(["update-index", "--add", "-z", "--index-info"], dir, cfg, { env, input: entries });
    return (await git(["write-tree"], dir, cfg, { env })).trim();
  } finally {
    await rm(index, { force: true });
  }
}

/**
 * Merges commits `first` and `second` (first is the lower node id's side) into a new commit, unreferenced, and returns
 * its id: `git merge-tree` over the base meddle chose (`opts.base`, else `mergeBaseOf`), with renames off and every file
 * through meddle's driver; an edit beats a delete; a conflict of kinds of entry (file against directory, mode,
 * symlink) takes the second's; a failed file merge throws. The commit has meddle's fixed metadata dated the later of
 * the two, the parents `first` and `second` (only `second` with `opts.replay`: `first`'s changes over `opts.base` put on
 * top of it), so any node merging the same two makes the same commit. Throws rather than make a tree with jj's
 * conflict entries.
 */
export async function mergeHeads(
  cfg: NodeConfig, dir: string, first: string, second: string, opts: { base?: string; replay?: boolean } = {},
): Promise<string> {
  const base = opts.base ?? (await mergeBaseOf(cfg, dir, first, second));
  const args = [
    "-c", "core.commitGraph=false", "-c", `merge.meddle.driver=${shq(paths(cfg).binMergeDriver)} %O %A %B %P`,
    "merge-tree", "--write-tree", "-z", "--name-only", "--messages", "-X", "no-renames", "--merge-base", base, first, second,
  ];
  let out: string;
  try {
    out = await git(args, dir, cfg);
  } catch (err) {
    if (!(err instanceof GitError && err.code === 1)) throw err;
    out = err.stdout;
  }
  const parsed = parseMergeTree(out);
  let tree = parsed.tree;
  const fix = new Set<string>();
  for (const m of parsed.messages) {
    if (!m.type.startsWith("CONFLICT") || m.type === "CONFLICT (modify/delete)") continue;
    if (m.type === "CONFLICT (contents)" || m.type === "CONFLICT (binary)") throw new Error(`merging ${first} and ${second}: ${m.message}`);
    for (const p of m.paths) fix.add(p);
  }
  if (fix.size > 0) tree = await takeSecond(cfg, dir, tree, second, fix);
  const top = (await git(["ls-tree", "--name-only", tree], dir, cfg)).split("\n");
  if (top.some((name) => name.startsWith(".jjconflict") || name === "JJ-CONFLICT-README")) {
    throw new Error(`merging ${first} and ${second} would publish a jj conflict`);
  }
  const date = Math.max(await committedAt(cfg, dir, first), await committedAt(cfg, dir, second));
  return commitTree(cfg, dir, tree, opts.replay === true ? [second] : [first, second], `merge\n\nmeddle-merge: ${RULE_VERSION}\n`, date);
}

/** Whether `rev` holds a jj conflict. */
async function isConflicted(cfg: NodeConfig, dir: string, rev: string): Promise<boolean> {
  return (await jj(["log", "-r", rev, "--no-graph", "-T", "conflict"], dir, cfg)).trim() === "true";
}

/**
 * Resolves the jj conflict commit `rev` holds: each side's tree (`.jjconflict-side-<i>`) folded into the first over the
 * base before it (`.jjconflict-base-<i-1>`) with meddle's merge, jj's conflict entries dropped. Returns a new commit with
 * `rev`'s parents and message; nothing points at it yet.
 */
export async function resolveConflicts(cfg: NodeConfig, dir: string, rev: string): Promise<string> {
  const trees = new Map<string, string>();
  for (const line of (await git(["ls-tree", "-z", rev], dir, cfg)).split("\0")) {
    const match = /^\d+ tree ([0-9a-f]+)\t(\.jjconflict-(?:base|side)-\d+)$/.exec(line);
    if (match !== null) trees.set(match[2]!, match[1]!);
  }
  const wrap = (tree: string) => commitTree(cfg, dir, tree, [], "conflict side\n", SYNTHETIC_DATE);
  const side = (i: number) => trees.get(`.jjconflict-side-${i}`);
  if (side(0) === undefined) throw new Error(`${rev} holds no jj conflict`);
  let acc = await wrap(side(0)!);
  for (let i = 1; side(i) !== undefined; i++) {
    const base = trees.get(`.jjconflict-base-${i - 1}`);
    acc = await mergeHeads(cfg, dir, acc, await wrap(side(i)!), base === undefined ? {} : { base: await wrap(base) });
  }
  const tree = (await git(["rev-parse", `${acc}^{tree}`], dir, cfg)).trim();
  const parents = (await git(["log", "-1", "--format=%P", rev], dir, cfg)).trim().split(" ").filter((p) => p !== "");
  const message = await git(["log", "-1", "--format=%B", rev], dir, cfg);
  return commitTree(cfg, dir, tree, parents, message, await committedAt(cfg, dir, rev));
}

/** Points the scope's bookmark at `commit` (made by git or not) and has jj take it. */
async function setBookmark(cfg: NodeConfig, dir: string, s: Scope, commit: string): Promise<void> {
  const bookmark = scopeBookmark(s);
  await git(["update-ref", `refs/heads/${bookmark}`, commit], dir, cfg);
  await jj(["git", "import"], dir, cfg);
  // A bookmark jj had conflicted stays so after an import: set it outright, now that jj knows the commit.
  const targets = (await jj(["log", "-r", `bookmarks(exact:"${bookmark}")`, "--no-graph", "-T", 'commit_id ++ "\\n"'], dir, cfg)).trim();
  if (targets !== commit) await jj(["bookmark", "set", bookmark, "-r", commit, "--allow-backwards"], dir, cfg);
}

/** The commit `rev` names, or null for the root. */
async function commitOfRev(cfg: NodeConfig, dir: string, rev: string): Promise<string | null> {
  const id = (await jj(["log", "-r", rev, "--no-graph", "-T", "commit_id"], dir, cfg)).trim();
  return id === ROOT ? null : id;
}

/**
 * Commits what was written in the working copy as `message` (nothing when nothing was), resolving a jj conflict its
 * parent holds, and returns the scope's head: the bookmark moved onto that commit, or, when someone else moved the
 * bookmark meanwhile (an old node's push, a conflicted bookmark from an upgrade), the merge of this line with each of
 * the bookmark's targets. Null when the repo has nothing but its root. The caller moves the working copy (`moveTo`)
 * when the head is not the working copy's parent.
 */
export async function commitLocal(cfg: NodeConfig, dir: string, s: Scope, message: string): Promise<string | null> {
  const empty = (await jj(["log", "-r", "@", "--no-graph", "-T", "empty"], dir, cfg)).trim() === "true";
  if (!empty) await jj(["commit", "-m", message], dir, cfg);
  let head = await commitOfRev(cfg, dir, "@-");
  if (head !== null && (await isConflicted(cfg, dir, "@-"))) head = await resolveConflicts(cfg, dir, head);
  const bookmark = scopeBookmark(s);
  const targets = (await jj(["log", "-r", `bookmarks(exact:"${bookmark}")`, "--no-graph", "-T", 'commit_id ++ "\\n"'], dir, cfg))
    .split("\n").filter((l) => l !== "").sort();
  for (const t of targets) {
    if (head === null) head = t;
    else if (t === head || (await isAncestor(cfg, dir, t, head))) continue;
    else if (await isAncestor(cfg, dir, head, t)) head = t;
    else head = await mergeHeads(cfg, dir, head, t);
  }
  if (head !== null && !(targets.length === 1 && targets[0] === head)) await setBookmark(cfg, dir, s, head);
  return head;
}

/**
 * Points the scope's bookmark at `commit` and brings the working copy onto it. What was written since the caller's last
 * `commitLocal` (or lands while this runs) is committed as `message` and merged in, then the move is made again, so a
 * write is never lost and the working copy never holds a conflict. (A write landing inside jj's own snapshot-to-checkout
 * window, milliseconds, can still be overwritten: inherent to checking out under a writer.) `beforeNew` is for tests.
 */
export async function moveTo(
  cfg: NodeConfig, dir: string, s: Scope, commit: string, message: string, opts: { beforeNew?: () => Promise<void> } = {},
): Promise<void> {
  let target = commit;
  for (let round = 0; round < 10; round++) {
    const before = (await jj(["log", "-r", "@", "--no-graph", "-T", "change_id"], dir, cfg)).trim();
    await setBookmark(cfg, dir, s, target);
    if (round === 0) await opts.beforeNew?.();
    await jj(["new", scopeBookmark(s)], dir, cfg);
    const stray = await jj(["log", "-r", `present(${before}) ~ empty()`, "--no-graph", "-T", "commit_id"], dir, cfg).catch(() => "");
    if (stray.trim() === "") return;
    await jj(["describe", "-r", before, "-m", message], dir, cfg);
    const described = (await jj(["log", "-r", before, "--no-graph", "-T", "commit_id"], dir, cfg)).trim();
    const parent = (await git(["log", "-1", "--format=%P", described], dir, cfg)).trim().split(" ")[0];
    // Only what was written, on top of the target: the old head it was written on may be one the target left behind.
    target = await mergeHeads(cfg, dir, described, target, parent === undefined || parent === "" ? { replay: true } : { base: parent, replay: true });
  }
  throw new Error("the working copy kept changing during a move");
}
