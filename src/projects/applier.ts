// The applier: each node turns a project's rows into refs, in its own service repo of the project and in the git view
// (`refs/namespaces/view/`) that checkouts fetch from. A commit a row names is fetched by id from whichever member has
// it, the row's writer first.
// - A line held elsewhere is `refs/remotes/meddle/task/<t>/<name>`, untracked; so is one held here before its task
//   made its own bookmark `meddle/task/<t>/<name>` (jj can't see a commit no ref names). Its base commits are
//   `refs/remotes/meddle/base/<t>/<name>/<i>`. Released ones are forgotten with `jj bookmark forget --include-remotes`:
//   deleting the git ref would make jj abandon the commits only it kept.
// - A branch is a local bookmark at its computed position (at the merge base while conflicted), put back there on
//   every pass whoever moved it.
// - The view, which jj never imports, shows branches, lines not archived and a conflicted branch's siblings, each only
//   once its commit is here, and `HEAD` on the default branch.
import type { NodeConfig } from "../config";
import { bookmarkRefs, git, GitError, gitImport, isJjRepo, jj, jjEnv, networkMs } from "../jj";
import { shortId } from "../pool/ids";
import { dedupe } from "../pool/report";
import { listBranchRows, listLineRows, mergeBranchRows, mergeLineRows, rowChanges, type BranchRow, type LineRow } from "../pool/rows";
import { repoKey, serialised } from "../serial";
import { PeerObject } from "../state/contracts";
import { computeBranch, type Graph, type ProjectBranch } from "./branches";
import { getProject, listProjects, type Project } from "./project";
import { ensureServiceRepo, ensureServiceRepos, meddleUrl, rosterProjectIds, type ReplicaDeps } from "./replicas";

const VIEW = "refs/namespaces/view/";
const HEADS = "refs/heads/";
const LINES = "refs/remotes/meddle/";
const FETCHED = "refs/meddle/fetched/";
/** How often a project whose rows name commits no member gave yet is applied again. */
const RETRY_MS = 15_000;
/** How long `catchUp` waits for its peers and the fetches after them, in all, unless told otherwise. */
const CATCH_UP_MS = 5000;

/** A project's commit graph as the git repo at `repo` has it. */
export function gitGraph(cfg: NodeConfig, repo: string): Graph {
  return {
    async isAncestor(a, b) {
      try {
        await git(["merge-base", "--is-ancestor", a, b], repo, cfg);
        return true;
      } catch (err) {
        if (err instanceof GitError && err.code === 1) return false;
        throw err;
      }
    },
    async mergeBases(commits) {
      try {
        return (await git(["merge-base", "--all", "--octopus", ...commits], repo, cfg)).split("\n").filter(Boolean);
      } catch (err) {
        // No common ancestor.
        if (err instanceof GitError && err.code === 1) return [];
        throw err;
      }
    },
  };
}

/** Runs git in `cwd` with `input` on its stdin, as `git` runs it otherwise. */
async function gitWithInput(args: string[], cwd: string, cfg: NodeConfig, input: string): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, env: jjEnv(cfg), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(input);
  await proc.stdin.end();
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new GitError(args, code, stderr);
  return stdout;
}

/** The commits of `commits` that the repo has. */
async function present(cfg: NodeConfig, repo: string, commits: Iterable<string>): Promise<Set<string>> {
  const asked = [...new Set(commits)];
  if (asked.length === 0) return new Set();
  const out = await gitWithInput(["cat-file", "--batch-check"], repo, cfg, asked.map((c) => `${c}\n`).join(""));
  const have = new Set<string>();
  for (const line of out.split("\n")) {
    const [id = "", type = ""] = line.split(" ");
    if (type === "commit") have.add(id);
  }
  return have;
}

/** Every ref under `prefixes`, by name, with what it points at. */
async function refsUnder(cfg: NodeConfig, repo: string, prefixes: string[]): Promise<Map<string, string>> {
  const out = await git(["for-each-ref", "--format=%(refname) %(objectname)", ...prefixes], repo, cfg);
  const refs = new Map<string, string>();
  for (const line of out.split("\n")) {
    const at = line.lastIndexOf(" ");
    if (at > 0) refs.set(line.slice(0, at), line.slice(at + 1));
  }
  return refs;
}

/** Whether `name` can be one component of a git ref: a line's name becomes one, under `meddle/task/<t>/`. */
function isRefComponent(name: string): boolean {
  return name !== "" && !name.startsWith(".") && !name.endsWith(".") && !name.endsWith(".lock")
    && !name.includes("..") && !name.includes("@{") && !/[\x00-\x20\x7f~^:?*[\\/]/.test(name);
}

/** A branch's rows neither deleted nor dropped by any row: the ones whose commits its position is computed from. */
function liveRows(rows: readonly BranchRow[]): BranchRow[] {
  const dropped = new Set(rows.flatMap((r) => r.drops.map((d) => JSON.stringify([d.node, d.seq]))));
  return rows.filter((r) => r.commit !== null && !dropped.has(JSON.stringify([r.node, r.seq])));
}

/** A project's rows, as one pass applies them. */
type Rows = { lines: LineRow[]; branches: Map<string, BranchRow[]> };

function rowsOf(deps: Pick<ReplicaDeps, "db">, projectId: string): Rows {
  const lines = listLineRows(deps.db, projectId).filter((l) => isRefComponent(l.name));
  const branches = new Map<string, BranchRow[]>();
  for (const r of listBranchRows(deps.db, projectId)) branches.set(r.branch, [...(branches.get(r.branch) ?? []), r]);
  return { lines, branches };
}

/**
 * The commits the rows name, each with the nodes whose rows name it: the live rows of each branch, and each line
 * not released, then (last, as they mostly come with the lines) its base commits.
 */
function wanted(rows: Rows): Map<string, Set<string>> {
  const want = new Map<string, Set<string>>();
  const add = (commit: string, writer: string) => want.set(commit, (want.get(commit) ?? new Set()).add(writer));
  for (const branch of rows.branches.values()) for (const r of liveRows(branch)) add(r.commit!, r.node);
  for (const l of rows.lines) if (l.commit !== null) add(l.commit, l.holder);
  for (const l of rows.lines) if (l.commit !== null) for (const b of l.base) add(b, l.holder);
  return want;
}

/** The fetches in flight, by repo and commit: two passes that want the same commit share one fetch. */
const inflight = new Map<string, Promise<boolean>>();

/** What `work` settles to, or `fallback` once `deadline` (a time, `Infinity` for none) has passed. */
function within<T>(work: Promise<T>, deadline: number, fallback: () => T): Promise<T> {
  if (deadline === Infinity) return work;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        resolve(fallback());
      } catch (err) {
        reject(err);
      }
    }, Math.max(0, deadline - Date.now()));
    work.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err: unknown) => { clearTimeout(timer); reject(err); },
    );
  });
}

/**
 * Fetches `commit` into `repo` as `refs/meddle/fetched/<commit>`, from the first of `sources` that has it, each fetch
 * limited to the time left before `deadline`. False when none gave it (or the time ran out). A caller that joins a
 * fetch already in flight waits for it only until its own `deadline`.
 */
function fetchCommit(deps: ReplicaDeps, repo: string, projectId: string, commit: string, sources: string[], deadline: number): Promise<boolean> {
  const key = `${repo}\0${commit}`;
  const running = inflight.get(key);
  if (running !== undefined) return within(running, deadline, () => false);
  const work = (async () => {
    for (const peer of sources) {
      const left = deadline - Date.now();
      if (left <= 0) return false;
      try {
        await git(
          ["fetch", "--no-tags", "--no-write-fetch-head", "--no-auto-maintenance", meddleUrl(peer, { kind: "project", id: projectId }), `${commit}:${FETCHED}${commit}`],
          repo, deps.cfg, { timeoutMs: Math.min(networkMs(deps.cfg), left) },
        );
        return true;
      } catch {
        // This member doesn't have it (or can't be reached): the next one.
      }
    }
    return false;
  })().finally(() => inflight.delete(key));
  inflight.set(key, work);
  return work;
}

/** The online members other than this node: the row's writers first, then the rest. */
function sourcesFor(deps: ReplicaDeps, writers: Set<string>): string[] {
  const { pool } = deps;
  const usable = (id: string) => id !== pool.identity.id && pool.net.isOnline(id);
  const rest = pool.store.members().map((m) => m.nodeId).filter((id) => !writers.has(id));
  return [...[...writers].filter(usable), ...rest.filter(usable)];
}

/** Fetches every commit the rows name that the repo lacks, while `deadline` allows; returns the ones it got. */
async function fetchMissing(deps: ReplicaDeps, project: Project, deadline: number): Promise<string[]> {
  const repo = project.replica;
  const want = wanted(rowsOf(deps, project.id));
  const have = await present(deps.cfg, repo, want.keys());
  const fetched: string[] = [];
  for (const [commit, writers] of want) {
    if (have.has(commit)) continue;
    // An earlier fetch may have brought it along (a base below its line).
    if ((await present(deps.cfg, repo, [commit])).has(commit)) continue;
    if (Date.now() >= deadline) break;
    if (await fetchCommit(deps, repo, project.id, commit, sourcesFor(deps, writers), deadline)) fetched.push(commit);
  }
  return fetched;
}

/**
 * The view refs a checkout's push landed in that no row records yet, by repo: each ref as the push left it (its commit,
 * or null when the push deleted it), or `"all"` when what the push changed could not be read. The applier leaves such a
 * ref as it is while it still shows what the push left (`"all"`: the whole view), so a push reported done is never
 * undone before its rows are written. Kept in memory: a restart forgets them, which the push's log line says.
 */
const unrecorded = new Map<string, Map<string, string | null> | "all">();

/**
 * Keeps the view of repo `repo` as a landed push left it, until `releaseView`: the refs it changed (`ref` as a checkout
 * sees it, `refs/heads/…`, at `new`), or the whole view (`"all"`).
 */
export function holdView(repo: string, refs: ReadonlyArray<{ ref: string; new: string | null }> | "all"): void {
  const held = unrecorded.get(repo);
  if (refs === "all" || held === "all") {
    unrecorded.set(repo, "all");
    return;
  }
  const next = new Map(held ?? []);
  for (const r of refs) next.set(r.ref, r.new);
  unrecorded.set(repo, next);
}

/** Lets the applier set the refs `holdView` kept of repo `repo` from the rows again: their push is recorded. */
export function releaseView(repo: string, refs: ReadonlyArray<{ ref: string; new: string | null }>): void {
  const held = unrecorded.get(repo);
  if (held === undefined || held === "all") return;
  for (const r of refs) if (held.get(r.ref) === r.new) held.delete(r.ref);
  if (held.size === 0) unrecorded.delete(repo);
}

/** Applies `ops` (`git update-ref --stdin` lines) at once; when that fails, one by one, logging the ones that fail. */
async function updateRefs(deps: ReplicaDeps, repo: string, ops: string[]): Promise<void> {
  if (ops.length === 0) return;
  try {
    await gitWithInput(["update-ref", "--stdin"], repo, deps.cfg, ops.map((op) => `${op}\n`).join(""));
  } catch {
    for (const op of ops) {
      await gitWithInput(["update-ref", "--stdin"], repo, deps.cfg, `${op}\n`).catch((err: unknown) => {
        deps.log?.(`meddle: applier: ${op} failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }
}

/** Sets the service repo's refs and the view from the rows, with the commits the repo has; returns the ones it lacks. */
async function applyRows(deps: ReplicaDeps, project: Project): Promise<string[]> {
  const { cfg } = deps;
  const repo = project.replica;
  const self = deps.pool.identity.id;
  const rows = rowsOf(deps, project.id);
  const want = wanted(rows);
  const have = await present(cfg, repo, want.keys());
  // Local bookmarks jj holds conflicted (an agent's move raced this node's): git's ref may already be at the position.
  const conflicted = new Set(
    rows.branches.size === 0
      ? []
      : (await bookmarkRefs(repo, "glob:*", cfg)).filter((b) => b.remote === null && b.conflicted).map((b) => b.name),
  );
  const refs = await refsUnder(cfg, repo, [HEADS, LINES, `${VIEW}${HEADS}`]);

  /** `update-ref` lines for the service repo's refs, imported into jj afterwards. */
  const updates: string[] = [];
  /** Names to forget with `jj bookmark forget --include-remotes` (line and base refs), and local branches to forget. */
  const forgetRemote: string[] = [];
  const forgetBranch: string[] = [];
  /** Branches jj holds conflicted, with the position they go back to. */
  const reset: Array<[string, string]> = [];
  /** What the view should show, by ref under `refs/heads/`, and what it keeps as it is while commits are missing. */
  const view = new Map<string, string>();
  const keep: Array<(ref: string) => boolean> = [];

  const graph = gitGraph(cfg, repo);
  for (const [branch, branchRows] of rows.branches) {
    const local = `${HEADS}${branch}`;
    const conflicts = `${HEADS}meddle/conflict/${branch}/`;
    if (liveRows(branchRows).some((r) => !have.has(r.commit!))) {
      // Its position can't be computed until every live row's commit is here: as it was until then.
      keep.push((ref) => ref === local || ref.startsWith(conflicts));
      continue;
    }
    const state = await computeBranch(branchRows, graph);
    const at = state.kind === "single" ? state.commit : state.kind === "conflicted" ? state.served : null;
    if (at !== null) {
      if (refs.get(local) !== at) updates.push(`update ${local} ${at}`);
      if (conflicted.has(branch)) reset.push([branch, at]);
      view.set(local, at);
    } else if (refs.has(local) || conflicted.has(branch)) {
      forgetBranch.push(branch);
    }
    if (state.kind === "conflicted") for (const s of state.siblings) view.set(`${conflicts}${s.slice(0, 12)}`, s);
  }

  for (const l of rows.lines) {
    const name = `task/${l.task}/${l.name}`;
    const remote = `${LINES}${name}`;
    const bases = `${LINES}base/${l.task}/${l.name}/`;
    const viewRef = `${HEADS}meddle/${name}`;
    const baseRefs = [...refs.keys()].filter((ref) => ref.startsWith(bases));
    if (l.commit === null) {
      if (refs.has(remote)) forgetRemote.push(name);
      for (const ref of baseRefs) forgetRemote.push(ref.slice(LINES.length));
      continue;
    }
    // A line held here is its task's own bookmark, once the task made it.
    if (l.holder === self && refs.has(`${HEADS}meddle/${name}`)) {
      if (refs.has(remote)) forgetRemote.push(name);
    } else if (have.has(l.commit) && refs.get(remote) !== l.commit) {
      updates.push(`update ${remote} ${l.commit}`);
    }
    l.base.forEach((b, i) => {
      const ref = `${bases}${i}`;
      if (have.has(b) && refs.get(ref) !== b) updates.push(`update ${ref} ${b}`);
    });
    for (const ref of baseRefs) if (Number(ref.slice(bases.length)) >= l.base.length) forgetRemote.push(ref.slice(LINES.length));
    if (l.archived) continue;
    if (have.has(l.commit)) view.set(viewRef, l.commit);
    else keep.push((ref) => ref === viewRef);
  }

  await updateRefs(deps, repo, updates);
  // Also before forgetting: jj forgets only what it imported, and a ref it never saw would stay for good.
  if (updates.length > 0 || forgetRemote.length > 0 || forgetBranch.length > 0) await gitImport(repo, cfg);
  for (const [branch, at] of reset) {
    await jj(["--ignore-working-copy", "bookmark", "set", branch, "-r", at, "--allow-backwards"], repo, cfg);
  }
  if (forgetRemote.length > 0) {
    await jj(["--ignore-working-copy", "bookmark", "forget", "--include-remotes", ...forgetRemote.map((n) => `exact:${n}`)], repo, cfg);
  }
  if (forgetBranch.length > 0) {
    await jj(["--ignore-working-copy", "bookmark", "forget", ...forgetBranch.map((n) => `exact:${n}`)], repo, cfg);
  }

  // The view: written only by this node, never imported by jj; a landed push not recorded yet stays as it left it.
  const held = unrecorded.get(repo);
  const pinned = (shown: string) => held === "all"
    || (held !== undefined && held.has(shown) && (refs.get(`${VIEW}${shown}`) ?? null) === held.get(shown));
  const viewOps: string[] = [];
  for (const [ref, commit] of refs) {
    if (!ref.startsWith(`${VIEW}${HEADS}`)) continue;
    const shown = ref.slice(VIEW.length);
    if (!view.has(shown) && !keep.some((k) => k(shown)) && !pinned(shown)) viewOps.push(`delete ${ref} ${commit}`);
  }
  for (const [shown, commit] of view) {
    if (refs.get(`${VIEW}${shown}`) !== commit && !pinned(shown)) viewOps.push(`update ${VIEW}${shown} ${commit}`);
  }
  await updateRefs(deps, repo, viewOps);
  if (project.defaultBranch !== null) {
    const head = `${VIEW}${HEADS}${project.defaultBranch}`;
    const now = await git(["symbolic-ref", "-q", `${VIEW}HEAD`], repo, cfg).then((out) => out.trim(), () => null);
    if (now !== head) {
      // A default branch git can't name leaves the view's HEAD as it was, and the rest of the pass stands.
      await git(["symbolic-ref", `${VIEW}HEAD`, head], repo, cfg).catch((err: unknown) => {
        deps.log?.(`meddle: applier: the view's HEAD of ${project.name} was not set: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }

  return [...want.keys()].filter((c) => !have.has(c));
}

/**
 * Project `projectId`'s branches as this node's rows and service repo have them now, by name (`ProjectBranch`): what
 * `meddle project status` prints and the dashboard's project page shows. Empty for a project not here.
 */
export async function projectBranches(deps: Pick<ReplicaDeps, "cfg" | "db">, projectId: string): Promise<ProjectBranch[]> {
  const project = getProject(deps.db, projectId);
  if (project === null) return [];
  const rows = rowsOf(deps, projectId);
  const have = await present(deps.cfg, project.replica, wanted({ ...rows, lines: [] }).keys());
  const graph = gitGraph(deps.cfg, project.replica);
  const out: ProjectBranch[] = [];
  for (const [name, branchRows] of [...rows.branches].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (liveRows(branchRows).some((r) => !have.has(r.commit!))) {
      out.push({ name, state: "fetching", commit: null, siblings: [] });
      continue;
    }
    const state = await computeBranch(branchRows, graph);
    if (state.kind === "single") out.push({ name, state: "single", commit: state.commit, siblings: [] });
    else if (state.kind === "conflicted") out.push({ name, state: "conflicted", commit: state.served, siblings: state.siblings });
  }
  return out;
}

/**
 * The project's service repo here, made (`ensureServiceRepo`, without its memory: the applier's sweep clones that)
 * when this node has none yet, by `deadline`; rejects `no service repo of project <shortId> in time` past it (the repo
 * is still made, for a later pass).
 */
async function serviceRepo(deps: ReplicaDeps, projectId: string, deadline: number): Promise<Project> {
  const row = getProject(deps.db, projectId);
  if (row !== null && (await isJjRepo(row.replica))) return row;
  const making = ensureServiceRepo(deps, projectId, { memory: false });
  making.catch(() => {});
  return within(making, deadline, () => {
    throw new Error(`no service repo of project ${shortId(projectId)} in time`);
  });
}

/** Deletes the temp refs of `commits` that are still there (a pass sharing a fetch may have deleted them already). */
async function dropFetched(deps: ReplicaDeps, repo: string, commits: string[]): Promise<void> {
  if (commits.length === 0) return;
  const mine = new Set(commits.map((c) => `${FETCHED}${c}`));
  const refs = await refsUnder(deps.cfg, repo, [FETCHED]);
  await updateRefs(deps, repo, [...refs].filter(([ref]) => mine.has(ref)).map(([ref, at]) => `delete ${ref} ${at}`));
}

/**
 * Applies project `projectId`'s rows to this node's service repo of it (made first when there is none) and to its
 * view. Each missing commit a row names is fetched by id, from the row's writer first, then from each online member;
 * with `budgetMs`, fetching stops once that much time has gone. `pending` are the commits the rows name that the repo
 * still lacks: their refs wait, as they were, for a later pass.
 */
export async function applyProject(deps: ReplicaDeps, projectId: string, budgetMs?: number): Promise<{ pending: string[] }> {
  const deadline = budgetMs === undefined ? Infinity : Date.now() + budgetMs;
  const project = await serviceRepo(deps, projectId, deadline);
  // Outside the repo's lock (it touches only git's objects and `refs/meddle/fetched/`): a slow member must never hold
  // the lock past catchUp's budget.
  const fetched = await fetchMissing(deps, project, deadline);
  return serialised(repoKey(project.replica), async () => {
    try {
      return { pending: await applyRows(deps, project) };
    } finally {
      await dropFetched(deps, project.replica, fetched);
    }
  });
}

/**
 * Catches this node up on project `projectId`: asks every online member for its rows of it (`PeerObject.rowsOf`) at
 * once, merges what returns within `budgetMs`, then applies the project with the time left. Never waits past the
 * budget for a slow peer, a fetch in flight or making the service repo (setting the refs from what it has takes what
 * it takes); rejects `no service repo of project <shortId> in time` when that could not be made within it.
 */
export async function catchUp(deps: ReplicaDeps, projectId: string, budgetMs = CATCH_UP_MS): Promise<void> {
  const { pool } = deps;
  const deadline = Date.now() + budgetMs;
  const peers = pool.store.members().map((m) => m.nodeId).filter((id) => id !== pool.identity.id && pool.net.isOnline(id));
  const asks = peers.map(async (peer) => {
    const ref = await pool.peerRef(peer, PeerObject);
    try {
      if (ref.variant !== "peer") return;
      const rows = await ref.rowsOf({ projectId });
      if (Date.now() > deadline) return;
      mergeLineRows(deps.db, rows.lineRows.filter((r) => r.project === projectId));
      mergeBranchRows(deps.db, rows.branchRows.filter((r) => r.project === projectId));
    } finally {
      ref.release();
    }
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const out = new Promise<void>((resolve) => { timer = setTimeout(resolve, Math.max(0, deadline - Date.now())); });
  try {
    await Promise.race([Promise.allSettled(asks), out]);
  } finally {
    clearTimeout(timer);
  }
  await applyProject(deps, projectId, Math.max(0, deadline - Date.now()));
}

/**
 * Keeps every project applied: each project held here or listed in the roster is applied (getting a service repo when
 * it has none) at start, whenever one of its rows changes and whenever a peer comes online, each time followed by the
 * `ensureServiceRepos` sweep (what homes say now, and memory clones), which nothing applied waits for; a project left
 * with pending commits (or that failed) is tried again every 15 s. One pass per project at a time; a change during a pass makes one more after
 * it. Failures are logged (`meddle: applier: …`, each at most once a minute). Returns the stop.
 */
export function startApplier(deps: ReplicaDeps): () => void {
  let stopped = false;
  const log = dedupe(deps.log ?? ((line) => console.error(line)));
  const quiet: ReplicaDeps = { ...deps, log };
  const retry = new Set<string>();
  /** The projects being applied, and whether another pass was asked for meanwhile. */
  const passes = new Map<string, { again: boolean }>();

  const run = (projectId: string): void => {
    if (stopped) return;
    const running = passes.get(projectId);
    if (running !== undefined) {
      running.again = true;
      return;
    }
    const pass = { again: false };
    passes.set(projectId, pass);
    void (async () => {
      do {
        pass.again = false;
        try {
          const { pending } = await applyProject(quiet, projectId);
          if (pending.length > 0) retry.add(projectId);
          else retry.delete(projectId);
        } catch (err) {
          retry.add(projectId);
          if (!stopped) log(`meddle: applier: project ${shortId(projectId)}: ${err instanceof Error ? err.message : String(err)}`);
        }
      } while (pass.again && !stopped);
      passes.delete(projectId);
    })();
  };

  // Rows first: every project held or listed is applied at once (a new one gets its service repo without waiting on
  // its home); then the sweep, which refreshes what homes say and clones memory, as slowly as homes answer.
  const all = async (): Promise<void> => {
    for (const id of new Set([...listProjects(deps.db).map((p) => p.id), ...rosterProjectIds(deps.pool), ...retry])) run(id);
    await ensureServiceRepos(quiet);
  };
  const everything = () => {
    if (!stopped) void all().catch((err: unknown) => log(`meddle: applier: ${err instanceof Error ? err.message : String(err)}`));
  };

  const stopRows = rowChanges.subscribe(run);
  const stopPeers = deps.pool.net.onPeer((_id, online) => { if (online) everything(); });
  const timer = setInterval(() => { for (const id of [...retry]) run(id); }, RETRY_MS);
  timer.unref();
  everything();
  return () => {
    stopped = true;
    stopRows();
    stopPeers();
    clearInterval(timer);
  };
}
