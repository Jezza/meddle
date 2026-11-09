// `git-pre-receive`: the gate of every push to this node (a checkout's to a project's view, a peer's to a memory repo),
// run by git's `pre-receive` hook (the script `writePreReceiveHook` writes) before any ref of the push lands. One refused ref rejects the whole push, and so does
// a push the node could not record: it never lands only to be undone. Run as its own entry point, it loads only what
// it needs: git runs it on every push.
import { readFile } from "node:fs/promises";
import type { BranchRow } from "../pool/rows";
import { planPush, refusePush, type BranchHeads, type Graph, type PushedRef } from "../projects/branches";

/**
 * What a push is planned from: the file `MEDDLE_ROWS` names, written by the node as it spawns `receive-pack`. `stale`
 * are the branches the view does not show where the rows put them (the applier has yet to catch up).
 */
export type PushRows = { selfId: string; project: string; rows: BranchRow[]; stale: string[] };

const HEADS = "refs/heads/";
const CONFLICT = "refs/heads/meddle/conflict/";

/** Reads all of `stream` as text. */
async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

/** git's `<old> <new> <ref>` lines as pushed refs: an all-zero id is a creation's old side or a deletion's new side. */
export function parsePushLines(text: string): PushedRef[] {
  const zero = (id: string) => /^0+$/.test(id);
  const pushed: PushedRef[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const [old = "", next = "", ref = ""] = line.split(" ");
    pushed.push({ ref, old: zero(old) ? null : old, new: zero(next) ? null : next });
  }
  return pushed;
}

/** Runs git in the repo the hook runs in, with its environment (the pushed objects, still in quarantine, visible). */
function gitIn(env: Record<string, string | undefined>) {
  return async (args: string[]) => {
    const proc = Bun.spawn(["git", ...args], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, code };
  };
}

/** The commit graph of the repo git runs the hook in, the pushed objects (still in quarantine) included. */
function hookGraph(env: Record<string, string | undefined>): Graph {
  const run = gitIn(env);
  return {
    async isAncestor(a, b) {
      const { stderr, code } = await run(["merge-base", "--is-ancestor", a, b]);
      if (code === 0 || code === 1) return code === 0;
      throw new Error(`git merge-base --is-ancestor ${a} ${b} exited with code ${code}: ${stderr.trim()}`);
    },
    async mergeBases(commits) {
      const { stdout, stderr, code } = await run(["merge-base", "--all", "--octopus", ...commits]);
      if (code === 1) return [];
      if (code !== 0) throw new Error(`git merge-base exited with code ${code}: ${stderr.trim()}`);
      return stdout.split("\n").filter(Boolean);
    },
  };
}

/** `MEDDLE_HEADS` as the node gave it, or null when it is missing or not a list of `{ branch, commits }`. */
function headsOf(text: string | undefined): BranchHeads | null {
  if (text === undefined) return null;
  try {
    const value = JSON.parse(text) as unknown;
    if (!Array.isArray(value)) return null;
    const ok = value.every((h: unknown) => {
      const { branch, commits } = (h ?? {}) as { branch?: unknown; commits?: unknown };
      return typeof branch === "string" && Array.isArray(commits) && commits.every((c) => typeof c === "string");
    });
    return ok ? (value as BranchHeads) : null;
  } catch {
    return null;
  }
}

/** The rows the file `MEDDLE_ROWS` names hold, or null when there is none or it is not what the node writes. */
async function rowsOf(file: string | undefined): Promise<PushRows | null> {
  if (file === undefined) return null;
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as Partial<PushRows> | null;
    if (typeof value?.selfId !== "string" || typeof value.project !== "string" || !Array.isArray(value.rows)) return null;
    if (!Array.isArray(value.stale) || !value.stale.every((b) => typeof b === "string")) return null;
    return value as PushRows;
  } catch {
    return null;
  }
}

/** The branch a pushed ref moves: `refs/heads/<b>`, or a sibling's `refs/heads/meddle/conflict/<b>/<id>`. */
function branchOf(ref: string): string | null {
  if (ref.startsWith(CONFLICT)) {
    const rest = ref.slice(CONFLICT.length);
    const slash = rest.lastIndexOf("/");
    return slash > 0 ? rest.slice(0, slash) : null;
  }
  return ref.startsWith(HEADS) ? ref.slice(HEADS.length) : null;
}

/**
 * The first branch of the push whose live rows (neither deleted nor dropped) name a commit this repo lacks: the node
 * can't tell what such a push means until the applier has fetched it.
 */
async function unfetched(pushed: PushedRef[], rows: readonly BranchRow[], env: Record<string, string | undefined>): Promise<string | null> {
  const run = gitIn(env);
  for (const branch of new Set(pushed.map((p) => branchOf(p.ref)).filter((b) => b !== null))) {
    const ofBranch = rows.filter((r) => r.branch === branch);
    const dropped = new Set(ofBranch.flatMap((r) => r.drops.map((d) => `${d.node}\0${d.seq}`)));
    for (const r of ofBranch) {
      if (r.commit === null || dropped.has(`${r.node}\0${r.seq}`)) continue;
      if ((await run(["cat-file", "-e", `${r.commit}^{commit}`])).code !== 0) return branch;
    }
  }
  return null;
}

/**
 * Why a push of `pushed` is refused, or null when it is accepted. `MEDDLE_REPO_KIND` names the repo: a memory repo
 * takes only `refs/heads/memory`, and never its deletion. A project's push goes through `refusePush`, with the branches' heads from
 * `MEDDLE_HEADS`, then is planned (`planPush`) from the rows the file `MEDDLE_ROWS` names (both the node's, when it
 * spawned `receive-pack`): refused with `<b>: this node is still fetching it; push again shortly` while the view shows a
 * pushed branch behind its rows or a live row of one names a commit this repo lacks, and refused when planning fails.
 */
export async function preReceiveRefusal(pushed: PushedRef[], env: Record<string, string | undefined>): Promise<string | null> {
  const kind = env.MEDDLE_REPO_KIND;
  if (kind === "memory") {
    const other = pushed.find((p) => p.ref !== "refs/heads/memory");
    if (other !== undefined) return `ref ${other.ref} is not accepted here`;
    const deleted = pushed.find((p) => p.new === null);
    return deleted === undefined ? null : `deleting ${deleted.ref} is not accepted here`;
  }
  if (kind !== "project") return "meddle: no repo kind given; refusing the push";
  const heads = headsOf(env.MEDDLE_HEADS);
  const plan = await rowsOf(env.MEDDLE_ROWS);
  if (heads === null || plan === null) return "meddle: no branches given; refusing the push";
  const graph = hookGraph(env);
  const refused = await refusePush(pushed, heads, graph);
  if (refused !== null) return refused;
  // A branch the view shows behind its rows: the pusher judged its push against the view, the plan would judge it
  // against rows the pusher never saw (and drop them as if forced).
  const behind = pushed.map((p) => branchOf(p.ref)).find((b) => b !== null && plan.stale.includes(b));
  if (behind !== undefined && behind !== null) return `${behind}: this node is still fetching it; push again shortly`;
  const missing = await unfetched(pushed, plan.rows, env);
  if (missing !== null) return `${missing}: this node is still fetching it; push again shortly`;
  try {
    await planPush(plan.selfId, plan.project, pushed, plan.rows, graph);
  } catch (err) {
    return `meddle: the push could not be recorded: ${err instanceof Error ? err.message : String(err)}`;
  }
  return null;
}

/** The hook: git's lines on stdin; exit 1 with the refusal on stderr, or 0. */
export async function gitPreReceive(
  stdin: ReadableStream<Uint8Array> = Bun.stdin.stream(), env: Record<string, string | undefined> = process.env,
): Promise<number> {
  const refusal = await preReceiveRefusal(parsePushLines(await readAll(stdin)), env);
  if (refusal === null) return 0;
  console.error(refusal);
  return 1;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] !== "git-pre-receive") {
    console.error("usage: git-pre-receive");
    process.exit(2);
  }
  try {
    process.exit(await gitPreReceive());
  } catch (err) {
    console.error(`meddle: ${(err as Error).message}`);
    process.exit(1);
  }
}
