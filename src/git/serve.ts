// The serving side of git over iroh: a `git` stream (a peer's, or a checkout's on this machine) runs `git upload-pack`
// or `git receive-pack` on a repo this node holds, the stream's bytes piped to the process and its output piped back.
// A checkout here is served a project repo as its view (`refs/namespaces/view/`): what the applier wrote from the
// rows, and where its push lands, gated by the `pre-receive` hook, recorded as this node's branch rows. A peer is
// served the repo itself: it fetches a project's commits by id, and pushes only to a memory repo, gated by the same
// hook (a task's lines are rows, never pushed).
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Database } from "bun:sqlite";
import type { NodeConfig } from "../config";
import { git, gitImport } from "../jj";
import { paths } from "../paths";
import type { PeerStream, PoolNet } from "../pool/net";
import { shortId } from "../pool/ids";
import { listBranchRows, writeBranchRow, type BranchRow } from "../pool/rows";
import type { PoolRuntime } from "../pool/runtime";
import { applyProject, catchUp, gitGraph, holdView, releaseView } from "../projects/applier";
import { computeBranch, planPush, type BranchHeads, type PushedRef } from "../projects/branches";
import { getProject } from "../projects/project";
import { rosterProjectIds } from "../projects/replicas";
import { repoKey, serialised } from "../serial";
import type { PushRows } from "./pre-receive";
import { parseGitHeader, repoName, type GitService, type Repo } from "./wire";

/** The git namespace a project repo is served to a checkout as. */
const NAMESPACE = "view";
const VIEW = `refs/namespaces/${NAMESPACE}/`;
/** How long a push waits, once recorded, for the view to be applied from the rows before its stream ends. */
const APPLY_AFTER_PUSH_MS = 5000;

export type GitServeDeps = {
  db: Database;
  cfg: NodeConfig;
  /** The pool: a checkout's fetch catches this node up with its peers first, and a push is applied from the rows. */
  pool: PoolRuntime;
  /** This node's id: its own streams are its checkouts'. */
  selfId: string;
  isMember(id: string): boolean;
  /** Where a refused stream is logged (`meddle: git: …`); the runtime passes a deduplicating sink. */
  log?(line: string): void;
  /** Called before each attempt to record a landed push as rows: a test makes it throw to fail one. */
  beforeRecord?(): void | Promise<void>;
};

/** The git directory of the jj repo at `repo` (`.git` when colocated), or null when it has none. */
function gitDirOf(repo: string): string | null {
  const store = join(repo, ".jj", "repo", "store");
  try {
    const dir = resolve(store, readFileSync(join(store, "git_target"), "utf8").trim());
    if (existsSync(dir)) return dir;
  } catch {
    // Not a jj repo with a git backend; a plain colocated `.git` still serves.
  }
  const dotGit = join(repo, ".git");
  return existsSync(dotGit) ? dotGit : null;
}

/**
 * The working copy of a repo this node holds: a project's replica (a project row) or a memory replica
 * (`<data>/memory/<id>`), when it is a git-backed repo; otherwise null.
 */
export function repoPath(db: Database, cfg: NodeConfig, repo: Repo): string | null {
  const path = repo.kind === "project" ? getProject(db, repo.id)?.replica ?? null : paths(cfg).memory(repo.id);
  return path !== null && gitDirOf(path) !== null ? path : null;
}

/** Ends a refused stream with no data: the opener reads its end at once. */
async function refuse(s: PeerStream): Promise<void> {
  await s.stream.send.finish().catch(() => {});
  await s.stream.recv.stop(0n).catch(() => {});
}

/** Resets a stream refused after its header was taken: the opener's next read fails. */
async function reset(s: PeerStream): Promise<void> {
  await s.stream.send.reset(0n).catch(() => {});
  await s.stream.recv.stop(0n).catch(() => {});
}

/** Whether meddle's hook `hook` is in place: a file that can run. Without it, `receive-pack` would take any ref. */
async function hookReady(hook: string): Promise<boolean> {
  try {
    const st = await stat(hook);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** `err` as one line. */
function oneLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim();
}

/**
 * The git command serving `service` on the repo itself at `gitDir`; a push (to a memory repo) meets meddle's
 * `pre-receive` hook.
 */
function command(cfg: NodeConfig, service: GitService, gitDir: string): string[] {
  return service === "upload-pack"
    ? ["git", "upload-pack", gitDir]
    : ["git", "-c", `core.hooksPath=${paths(cfg).checkoutHooks}`, "receive-pack", gitDir];
}

/**
 * The git command serving a checkout `service` on a project's `gitDir`: its view namespace; a push through meddle's
 * `pre-receive` hook, into a repo whose `HEAD` may name a branch (`receive.denyCurrentBranch=ignore`).
 */
function viewCommand(cfg: NodeConfig, service: GitService, gitDir: string): string[] {
  return service === "upload-pack"
    ? ["git", `--namespace=${NAMESPACE}`, "upload-pack", gitDir]
    : ["git", `--namespace=${NAMESPACE}`, "-c", "receive.denyCurrentBranch=ignore", "-c", `core.hooksPath=${paths(cfg).checkoutHooks}`, "receive-pack", gitDir];
}

/** The refs of the view, by name as a checkout sees them (`refs/…`, the namespace stripped), with their commits. */
async function viewRefs(cfg: NodeConfig, repo: string): Promise<Map<string, string>> {
  const out = await git(["for-each-ref", "--format=%(refname) %(objectname)", VIEW], repo, cfg);
  const refs = new Map<string, string>();
  for (const line of out.split("\n")) {
    const at = line.lastIndexOf(" ");
    if (at <= 0) continue;
    const ref = line.slice(VIEW.length, at);
    // `HEAD` is the applier's symref, never pushed.
    if (ref.startsWith("refs/")) refs.set(ref, line.slice(at + 1));
  }
  return refs;
}

/** The refs a push changed: what differs between the view before it and after it. */
function pushedRefs(before: Map<string, string>, after: Map<string, string>): PushedRef[] {
  const pushed: PushedRef[] = [];
  for (const ref of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const old = before.get(ref) ?? null;
    const next = after.get(ref) ?? null;
    if (old !== next) pushed.push({ ref, old, new: next });
  }
  return pushed;
}

/** Where the view shows branch `branch`: its own ref and its siblings' (`meddle/conflict/<b>/<id>`), as one key. */
function shownAt(view: Map<string, string>, branch: string): string {
  const conflicts = `refs/heads/meddle/conflict/${branch}/`;
  const siblings = [...view].filter(([ref]) => ref.startsWith(conflicts) && !ref.slice(conflicts.length).includes("/"));
  return JSON.stringify([view.get(`refs/heads/${branch}`) ?? null, siblings.map(([, commit]) => commit).sort()]);
}

/**
 * Each branch's heads from the project's rows, for the hook: its commit, or its siblings while conflicted. And the
 * branches the view does not show where the rows put them (`stale`): a row the applier has not applied yet (or whose
 * commit this repo lacks, so its heads are unknown), which a checkout's jj has not seen either. A push to one of them
 * is refused until the view catches up: judged against rows the pusher never saw, it would drop them.
 */
async function branchStates(
  cfg: NodeConfig, repo: string, rows: BranchRow[], view: Map<string, string>,
): Promise<{ heads: BranchHeads; stale: string[] }> {
  const byBranch = new Map<string, BranchRow[]>();
  for (const r of rows) byBranch.set(r.branch, [...(byBranch.get(r.branch) ?? []), r]);
  // A branch the view shows with no rows at all is out of date too.
  for (const ref of view.keys()) {
    if (ref.startsWith("refs/heads/") && !ref.startsWith("refs/heads/meddle/") && ref !== "refs/heads/meddle") {
      const branch = ref.slice("refs/heads/".length);
      if (!byBranch.has(branch)) byBranch.set(branch, []);
    }
  }
  const graph = gitGraph(cfg, repo);
  const heads: BranchHeads = [];
  const stale: string[] = [];
  for (const [branch, branchRows] of byBranch) {
    let state: Awaited<ReturnType<typeof computeBranch>>;
    try {
      state = await computeBranch(branchRows, graph);
    } catch {
      // A commit missing here.
      stale.push(branch);
      continue;
    }
    let expected: string;
    if (state.kind === "single") {
      heads.push({ branch, commits: [state.commit] });
      expected = JSON.stringify([state.commit, []]);
    } else if (state.kind === "conflicted") {
      heads.push({ branch, commits: state.siblings });
      expected = JSON.stringify([state.served, [...state.siblings].sort()]);
    } else {
      expected = JSON.stringify([null, []]);
    }
    if (shownAt(view, branch) !== expected) stale.push(branch);
  }
  return { heads, stale };
}

/** How many times reading what a landed push changed in the view is tried, at once, under the repo's lock. */
const READ_TRIES = 3;
/** How many times a landed push's recording is tried again, and the pause before the first retry (doubling). */
const RECORD_RETRIES = 5;
const RECORD_RETRY_MS = 250;

/** A landed push still to be recorded as this node's branch rows: what it changed, and the rows it was planned from. */
type Recording = {
  repo: string;
  project: string;
  pushed: PushedRef[];
  rows: BranchRow[];
  /** Its planned rows not written yet; null until planned. */
  todo: Array<Omit<BranchRow, "seq" | "node">> | null;
};

/** Plans `rec` (once) and writes its rows not written yet, each dropped from `todo` as it is written. */
async function record(deps: GitServeDeps, rec: Recording): Promise<void> {
  await deps.beforeRecord?.();
  rec.todo ??= await planPush(deps.selfId, rec.project, rec.pushed, rec.rows, gitGraph(deps.cfg, rec.repo));
  while (rec.todo.length > 0) {
    writeBranchRow(deps.db, deps.selfId, rec.todo[0]!);
    rec.todo.shift();
  }
}

/**
 * What a push changed in the view of project `project` (repo `repo`; the view `before` it,
 * planned from `rows`), recorded as this node's branch rows: `landed` when it changed something (or what it changed
 * can't be read). Its refs are held in the view (`holdView`) until they are recorded; `retry` is the recording when this
 * first try failed, for `recordLater`. When what it changed can't be read, the whole view is held, and that is logged.
 */
async function landPush(
  deps: GitServeDeps, repo: string, project: string, before: Map<string, string>, rows: BranchRow[],
): Promise<{ landed: boolean; retry: Recording | null }> {
  let after: Map<string, string> | null = null;
  let error: unknown = null;
  for (let i = 0; i < READ_TRIES && after === null; i++) after = await viewRefs(deps.cfg, repo).catch((err: unknown) => { error = err; return null; });
  if (after === null) {
    holdView(repo, "all");
    deps.log?.(`meddle: git: a push to project/${project} landed, but what it changed could not be read, so it is not recorded: ${oneLine(error)}; the view of project ${shortId(project)} stays as it is until meddle restarts, and no other node sees the push`);
    return { landed: true, retry: null };
  }
  const rec: Recording = { repo, project, pushed: pushedRefs(before, after), rows, todo: null };
  if (rec.pushed.length === 0) return { landed: false, retry: null };
  holdView(repo, rec.pushed);
  try {
    await record(deps, rec);
  } catch (err) {
    deps.log?.(`meddle: git: the push to project/${project} was not recorded yet: ${oneLine(err)}; trying again`);
    return { landed: true, retry: rec };
  }
  releaseView(repo, rec.pushed);
  return { landed: true, retry: null };
}

/**
 * Tries recording `rec` again, up to `RECORD_RETRIES` times, the pause doubling from `RECORD_RETRY_MS`; its refs stay
 * held in the view meanwhile. Recorded, they are released and the project applied; never recorded, that is logged, and
 * they stay held.
 */
async function recordLater(deps: GitServeDeps, rec: Recording): Promise<void> {
  let error: unknown = null;
  for (let i = 0; i < RECORD_RETRIES; i++) {
    await Bun.sleep(RECORD_RETRY_MS * 2 ** i);
    try {
      await record(deps, rec);
    } catch (err) {
      error = err;
      continue;
    }
    releaseView(rec.repo, rec.pushed);
    const replicaDeps = { cfg: deps.cfg, db: deps.db, pool: deps.pool, log: deps.log };
    await applyProject(replicaDeps, rec.project, APPLY_AFTER_PUSH_MS).catch(() => {});
    return;
  }
  const refs = rec.pushed.map((p) => p.ref.replace(/^refs\/heads\//, "")).join(", ");
  deps.log?.(`meddle: git: a push to project/${rec.project} landed but was never recorded (${RECORD_RETRIES + 1} tries): ${oneLine(error)}; ${refs} stay in this node's view as pushed until meddle restarts, and no other node sees them: push them again`);
}

/** What serving a stream came to: the process's exit code, whether all its output reached the opener, and the input. */
type Served = { code: number; delivered: boolean; input: Promise<void> };

/**
 * Pipes the stream's bytes into `proc` and its output back, until `proc` exits. `input` settles once the opener's side
 * ends (what it sends after `proc` exited is dropped).
 */
async function pipe(s: PeerStream, proc: Bun.Subprocess<"pipe", "pipe", "ignore">): Promise<Served> {
  // The peer's bytes into the process; once it cannot take them (it exited), the rest is read and dropped.
  const input = (async () => {
    let open = true;
    for (;;) {
      const chunk = await s.reader.readChunk();
      if (chunk === null) break;
      if (!open) continue;
      try {
        proc.stdin.write(chunk);
        await proc.stdin.flush();
      } catch {
        open = false;
      }
    }
    if (open) await Promise.resolve(proc.stdin.end()).catch(() => {});
  })();
  let delivered = true;
  try {
    for await (const chunk of proc.stdout) await s.stream.send.writeAll(Array.from(chunk));
  } catch {
    delivered = false;
    proc.kill();
  }
  return { code: await proc.exited, delivered, input };
}

async function serve(s: PeerStream, deps: GitServeDeps): Promise<void> {
  // This node's own streams are its checkouts'.
  const local = s.peerId === deps.selfId;
  if (!local && !deps.isMember(s.peerId)) return refuse(s);
  let request: { repo: Repo; service: GitService };
  try {
    request = parseGitHeader(s.header);
  } catch {
    deps.log?.("meddle: git: bad git header");
    return refuse(s);
  }
  // A checkout here is served a project as its view; anything else (a peer's stream) the repo itself.
  const project = local && request.repo.kind === "project" ? request.repo.id : null;
  // A peer writes nothing to a project repo: its lines and branches travel as rows, their commits fetched by id.
  if (!local && request.repo.kind === "project" && request.service === "receive-pack") {
    deps.log?.(`meddle: git: ${shortId(s.peerId)} may not push to ${repoName(request.repo)}`);
    return refuse(s);
  }

  // A checkout's fetch first catches this node up on the project with every reachable peer (bounded), so it is as
  // current as whatever the pool can reach; a repo still being made is nothing to serve yet. A peer's fetch (a commit
  // by id) never waits on that: it would wait on this node's own fetches from that peer.
  if (project !== null && request.service === "upload-pack"
    && (getProject(deps.db, project) !== null || rosterProjectIds(deps.pool).has(project))) {
    await catchUp({ cfg: deps.cfg, db: deps.db, pool: deps.pool, log: deps.log }, project).catch((err: unknown) => {
      deps.log?.(`meddle: git: project ${shortId(project)} was not caught up: ${oneLine(err)}`);
    });
  }

  const repo = repoPath(deps.db, deps.cfg, request.repo);
  const gitDir = repo === null ? null : gitDirOf(repo);
  if (repo === null || gitDir === null) {
    deps.log?.(`meddle: git: unknown repo ${repoName(request.repo)}`);
    return refuse(s);
  }

  // A push goes through the hook or not at all: a missing hook would let any ref in.
  if (request.service === "receive-pack" && !(await hookReady(paths(deps.cfg).hookPreReceive))) {
    deps.log?.("meddle: git: pre-receive hook missing; refusing receive-pack");
    return reset(s);
  }

  const spawn = (args: string[], extraEnv: Record<string, string>) => Bun.spawn(args, {
    cwd: repo,
    // Protocol v2 serves any object by id: the applier fetches the commits rows name from whichever member has them.
    env: { ...process.env, MEDDLE_REPO_KIND: request.repo.kind, ...(request.service === "upload-pack" ? { GIT_PROTOCOL: "version=2" } : {}), ...extraEnv },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });

  let served: Served;
  if (project === null) {
    served = await pipe(s, spawn(command(deps.cfg, request.service, gitDir), {}));
  } else if (request.service === "upload-pack") {
    served = await pipe(s, spawn(viewCommand(deps.cfg, request.service, gitDir), {}));
  } else {
    // One push at a time, never during an applier pass: what the view holds before and after it is what it pushed.
    let landed = false;
    let unrecorded: Recording | null = null;
    served = await serialised(repoKey(repo), async () => {
      const rows = listBranchRows(deps.db, project);
      const before = await viewRefs(deps.cfg, repo);
      const { heads, stale } = await branchStates(deps.cfg, repo, rows, before);
      // The hook plans the push from these rows too, and refuses it when that can't be done: what lands is recorded.
      const dir = await mkdtemp(join(tmpdir(), "meddle-push-"));
      try {
        const rowsFile = join(dir, "rows.json");
        await writeFile(rowsFile, JSON.stringify({ selfId: deps.selfId, project, rows, stale } satisfies PushRows));
        const done = await pipe(s, spawn(viewCommand(deps.cfg, request.service, gitDir), {
          MEDDLE_HEADS: JSON.stringify(heads), MEDDLE_ROWS: rowsFile,
        }));
        // What landed is what changed in the view, whatever receive-pack's exit (0 also when the hook declined).
        ({ landed, retry: unrecorded } = await landPush(deps, repo, project, before, rows));
        return done;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
    if (unrecorded !== null) void recordLater(deps, unrecorded);
    // The view and the service repo's branches as the rows put them, before the pusher hears the push is done: also
    // after a push that recorded nothing (a ref the view shows only from rows goes back to where they put it).
    if (landed) {
      const replicaDeps = { cfg: deps.cfg, db: deps.db, pool: deps.pool, log: deps.log };
      await applyProject(replicaDeps, project, APPLY_AFTER_PUSH_MS).catch((err: unknown) => {
        deps.log?.(`meddle: git: project ${shortId(project)} was not applied after a push: ${oneLine(err)}`);
      });
    }
  }
  const { code, delivered, input } = served;
  // A peer's push landed in the memory repo: jj imports it now, so the bookmark is there when its push returns.
  // Without a snapshot. (A checkout's push lands in the view, which jj never imports.)
  if (code === 0 && request.service === "receive-pack" && project === null) {
    await gitImport(repo, deps.cfg).catch((err: unknown) => {
      deps.log?.(`meddle: git: what ${shortId(s.peerId)} pushed to ${repoName(request.repo)} was not imported: ${oneLine(err)}`);
    });
  }
  if (delivered) await s.stream.send.finish().catch(() => {});
  else await s.stream.send.reset(0n).catch(() => {});
  // The process is gone: nothing more the peer sends has anywhere to go.
  await s.stream.recv.stop(0n).catch(() => {});
  await input;
}

/**
 * Serves the `git` streams members (and this node's checkouts, through its own streams) open to this node: only repos
 * it holds (`repoPath`) and only `upload-pack` and `receive-pack`, refused (logged, the stream ended with no data)
 * before anything is spawned.
 * - A peer is served the repo itself. Its push to a project repo is refused (logged `meddle: git: <short> may not push
 *   to project/<id>`); one to a memory repo runs under `core.hooksPath=<data>/checkout-hooks` with `MEDDLE_REPO_KIND`,
 *   so the `pre-receive` hook decides whether it may land.
 * - A checkout here is served a project as its view namespace, its fetch after `catchUp`. Its push runs under
 *   `core.hooksPath=<data>/checkout-hooks` with `MEDDLE_HEADS` (each branch's heads) and `MEDDLE_ROWS` (a file of the
 *   rows it is planned from), so the `pre-receive` hook admits or refuses it whole; what it changed in the view is
 *   recorded as this node's branch rows (`planPush`), then applied. Once a push has landed, the applier leaves its
 *   refs in the view until they are recorded (`holdView`), which is tried again a few times when it fails.
 * While the hook a push needs is missing or cannot run, the push is refused (logged, the stream reset).
 * Returns the unsubscribe.
 */
export function acceptGitStreams(net: PoolNet, deps: GitServeDeps): () => void {
  return net.onStream((s) => {
    if (s.header.stream !== "git") return false;
    void serve(s, deps).catch(() => refuse(s));
    return true;
  });
}
