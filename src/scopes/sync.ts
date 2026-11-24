// The scope sync: keeps this node's copy of each synced scope (each held project's memory, and the profile once it takes
// part) in step with the pool, continuously, with no home. A pass over a scope commits what was written here, fetches
// the commits of the peers' head rows by id from whoever has them, merges them (`reconcile`), moves the working copy
// onto the result and publishes this node's head row. Passes run on a write (watched, after `quietMs` of quiet), on a
// turn end or a dashboard write (`touched`), when a peer's head row changes, when a peer comes online, and every
// `scanMs`. One pass per scope at a time; a trigger during a pass makes one more after it. A pass never throws: a
// failure is logged (`meddle: memory of <short id>: …`, `meddle: profile: …`, each at most once a minute) and the next
// pass tries again. Repo steps run under the repo's lock (`repoKey`); fetches never do.
import { watch, type FSWatcher } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Subscribable } from "@earendil-works/chord";
import { writeMergeDriver } from "../git/scripts";
import type { Repo } from "../git/wire";
import { git, GitError, isJjRepo, networkMs } from "../jj";
import { ensureMemoryReplica } from "../memory";
import { headChanges, listHeadRows, settleHeadRows, waitingHeadRows, writeHeadRow, type HeadRow } from "../pool/heads";
import { shortId } from "../pool/ids";
import { isRemoved } from "../pool/removed";
import { topic } from "../pool/rows";
import { fetchCommit, sourcesFor } from "../projects/applier";
import { memoryChanged, memoryChanges } from "../projects/memory-sync";
import { listProjects } from "../projects/project";
import type { ReplicaDeps } from "../projects/replicas";
import { repoKey, serialised } from "../serial";
import { RULE_VERSION } from "./merge-file";
import { unmarkConflicts } from "./markers";
import { reconcile, type Peer, type Self } from "./reconcile";
import { commitLocal, headOf, isAncestor, moveTo, prepareScopeRepo } from "./repo";
import { parseScopeKey, scopeDir, scopeKey, type Scope, type ScopeState } from "./scope";

export type { ScopeState } from "./scope";

/** How the profile takes part (`src/profile.ts`): this node's standing in it, and where to keep a change of it. */
export type ProfileHooks = {
  /** This node's standing (seed, edited, legacy), or null while the profile does not sync here. */
  self(): Promise<Omit<Self, "node"> | null>;
  save(self: Omit<Self, "node">): Promise<void>;
  /** Under the repo's lock, before what was written is committed (the plugin list brought up to date). */
  beforeCommit?(): Promise<void>;
  /** After each pass over the profile; `moved`, whether it moved the profile's head. */
  afterPass?(moved: boolean): Promise<void>;
};

export type ScopeSyncDeps = ReplicaDeps & {
  /** The tasks of a project with a turn live here, for a commit's message. */
  liveTasks?(projectId: string): string[];
  /** The quiet after a write before a pass, default 1000 ms. */
  quietMs?: number;
  /** How often every scope gets a pass anyway, default 30000 ms. */
  scanMs?: number;
  profile?: ProfileHooks;
  /** Tests: runs between a pass's commit and its merge (where an older node's push can land). */
  betweenSections?(s: Scope): Promise<void>;
};

export type ScopeSync = {
  /** A turn end or a dashboard write in `s` (a turn's task id for the commit's message): a pass now. */
  touched(s: Scope, taskId?: string): void;
  /** A pass over `s` now, resolved when it (and any it made necessary) is done. Never awaited under `repoKey`. */
  syncNow(s: Scope): Promise<void>;
  /** Stops syncing `s` here (a removed project): its watcher stops and its pass in flight is waited for. */
  forget(s: Scope): Promise<void>;
  stop(): void;
  /** How each scope synced here stands. */
  state(): ScopeState[];
  /** Fires when `state()` changed. */
  changes: Subscribable<null>;
};

type Entry = {
  scope: Scope;
  watcher: FSWatcher | null;
  quiet: ReturnType<typeof setTimeout> | null;
  running: Promise<void> | null;
  again: boolean;
  tasks: string[];
  state: ScopeState;
  forgotten: boolean;
};

const LOG_EVERY_MS = 60_000;

/** The repo name a scope's commits are fetched from on a peer. */
function remoteOf(s: Scope): Repo {
  return s.kind === "profile" ? { kind: "profile", id: "pool" } : { kind: "memory", id: s.projectId };
}

/** `err` as one line. */
function oneLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim();
}

/** The commit git's HEAD is at (jj keeps it on the working copy's parent), or null. */
async function parentOf(deps: ReplicaDeps, dir: string): Promise<string | null> {
  try {
    return (await git(["rev-parse", "--verify", "-q", "HEAD"], dir, deps.cfg)).trim() || null;
  } catch (err) {
    if (err instanceof GitError) return null;
    throw err;
  }
}

/** Which of `commits` the repo at `dir` holds. */
async function present(deps: ReplicaDeps, dir: string, commits: Iterable<string>): Promise<Set<string>> {
  const have = new Set<string>();
  for (const c of commits) {
    try {
      await git(["cat-file", "-e", `${c}^{commit}`], dir, deps.cfg);
      have.add(c);
    } catch {
      // Not here.
    }
  }
  return have;
}

/**
 * Replaces jj's conflict markers left as text in the scope's markdown and text files with the merge of their sides
 * (`unmarkConflicts`); a file whose markers can't be read is left and `say`s so.
 */
async function unmarkFiles(dir: string, say: (message: string) => void): Promise<void> {
  const names = await readdir(dir, { recursive: true }).catch(() => [] as string[]);
  for (const name of names) {
    if (name === ".jj" || name === ".git" || name.startsWith(".jj/") || name.startsWith(".git/") || !/\.(md|txt)$/i.test(name)) continue;
    const file = join(dir, name);
    const st = await stat(file).catch(() => null);
    if (st === null || !st.isFile() || st.size > 1024 * 1024) continue;
    const content = await readFile(file, "utf8");
    if (!content.includes("<<<<<<< conflict")) continue;
    const fixed = unmarkConflicts(content);
    if (fixed === null) say(`conflict markers in ${name} could not be read; left as they are`);
    else await writeFile(file, fixed);
  }
}

/** Starts the scope sync of this node (see the top of the file). */
export function startScopeSync(deps: ScopeSyncDeps): ScopeSync {
  const self = deps.pool.identity.id;
  const quietMs = deps.quietMs ?? 1000;
  const log = deps.log ?? ((line: string) => console.error(line));
  const entries = new Map<string, Entry>();
  const changed = topic<null>();
  const logged = new Map<string, number>();
  let stopped = false;
  const driver = writeMergeDriver(deps.cfg).catch((err: unknown) => log(`meddle: merge driver not written: ${oneLine(err)}`));

  const say = (s: Scope, message: string) => {
    const line = s.kind === "profile" ? `meddle: profile: ${message}` : `meddle: memory of ${shortId(s.projectId)}: ${message}`;
    const last = logged.get(line);
    if (last !== undefined && Date.now() - last < LOG_EVERY_MS) return;
    logged.set(line, Date.now());
    log(line);
  };

  /** The scopes this node syncs now. */
  const held = async (): Promise<Scope[]> => {
    const scopes: Scope[] = listProjects(deps.db)
      .filter((p) => !isRemoved(deps.db, p.id))
      .map((p) => ({ kind: "memory", projectId: p.id }));
    if (deps.profile !== undefined && (await deps.profile.self()) !== null) scopes.push({ kind: "profile" });
    return scopes;
  };

  const entryOf = (s: Scope): Entry => {
    const key = scopeKey(s);
    let e = entries.get(key);
    if (e === undefined) {
      e = { scope: s, watcher: null, quiet: null, running: null, again: false, tasks: [], forgotten: false, state: { scope: key, head: null, behind: 0, waiting: [] } };
      entries.set(key, e);
    }
    return e;
  };

  const watchDir = (e: Entry, dir: string) => {
    if (e.watcher !== null || stopped || e.forgotten) return;
    try {
      e.watcher = watch(dir, { recursive: true }, (_event, name) => {
        const file = String(name ?? "");
        if (file === ".jj" || file === ".git" || file.startsWith(".jj/") || file.startsWith(".git/")) return;
        if (e.quiet !== null) clearTimeout(e.quiet);
        e.quiet = setTimeout(() => {
          e.quiet = null;
          void run(e);
        }, quietMs);
        e.quiet.unref?.();
      });
      e.watcher.on("error", () => {
        e.watcher?.close();
        e.watcher = null;
      });
    } catch {
      // No watcher (the scan still finds what was written).
      e.watcher = null;
    }
  };

  /** The commit message for what was written in `s` here. */
  const messageOf = (e: Entry): string => {
    if (e.scope.kind === "profile") return `profile from ${shortId(self)}`;
    const tasks = [...new Set([...e.tasks, ...(deps.liveTasks?.(e.scope.projectId) ?? [])])];
    return `memory from ${shortId(self)}${tasks.length === 0 ? "" : `: task ${tasks.join(", ")}`}`;
  };

  const pass = async (e: Entry): Promise<void> => {
    const s = e.scope;
    const key = scopeKey(s);
    const dir = scopeDir(deps.cfg, s);
    const removed = () => s.kind === "memory" && isRemoved(deps.db, s.projectId);
    if (removed()) return;
    await driver;
    let me: Self;
    if (s.kind === "profile") {
      const standing = await deps.profile?.self();
      if (standing === undefined || standing === null) return;
      me = { node: self, ...standing };
    } else {
      me = { node: self, seed: null, edited: true, legacy: false };
    }
    const message = messageOf(e);
    e.tasks = [];

    // What was written here, committed; a bookmark someone else moved folded in.
    const before = await serialised(repoKey(dir), async () => {
      if (removed()) return undefined;
      if (s.kind === "memory" && !(await isJjRepo(dir))) await ensureMemoryReplica(deps.cfg, s.projectId);
      if (s.kind === "profile") await mkdir(dir, { recursive: true });
      await prepareScopeRepo(deps.cfg, dir, s);
      // Before this node first publishes the scope: markers an older sync left as text never spread.
      if (!listHeadRows(deps.db, key).some((r) => r.node === self)) await unmarkFiles(dir, (m) => say(s, m));
      const was = await headOf(deps.cfg, dir, s);
      if (s.kind === "profile") await deps.profile?.beforeCommit?.();
      const head = await commitLocal(deps.cfg, dir, s, message);
      if (head !== null && head !== (await parentOf(deps, dir))) await moveTo(deps.cfg, dir, s, head, message);
      return { was, head };
    });
    if (before === undefined) return;
    watchDir(e, dir);
    if (s.kind === "profile" && !me.legacy && me.seed !== null && !me.edited && before.head !== before.was && before.was !== null) {
      me = { ...me, edited: true };
      await deps.profile?.save({ seed: me.seed, edited: me.edited, legacy: me.legacy });
    }

    // The peers' commits, fetched outside the lock: a fetch may take a while.
    const waiting = waitingHeadRows(deps.db, key).filter((r) => r.commit !== null);
    const have = await present(deps, dir, waiting.map((r) => r.commit!));
    for (const r of waiting) {
      if (stopped || e.forgotten) return;
      if (have.has(r.commit!)) continue;
      const deadline = Date.now() + networkMs(deps.cfg);
      if (await fetchCommit(deps, dir, remoteOf(s), r.commit!, sourcesFor(deps, new Set([r.node])), deadline)) have.add(r.commit!);
    }
    settleHeadRows(deps.db, key, have);

    const rows = listHeadRows(deps.db, key).filter((r) => r.node !== self && r.commit !== null);
    // An admitted head this repo lacks (the repo was made again): fetched like a waiting one, and passed over until it is.
    const admitted = await present(deps, dir, rows.map((r) => r.commit!));
    for (const r of rows) {
      if (stopped || e.forgotten) return;
      if (admitted.has(r.commit!)) continue;
      const deadline = Date.now() + networkMs(deps.cfg);
      if (await fetchCommit(deps, dir, remoteOf(s), r.commit!, sourcesFor(deps, new Set([r.node])), deadline)) admitted.add(r.commit!);
    }
    const missing = rows.filter((r) => !admitted.has(r.commit!));
    const current = rows.filter((r) => r.rule === RULE_VERSION && admitted.has(r.commit!));
    const peers: Peer[] = current.map((r) => ({ node: r.node, commit: r.commit!, seed: r.seed, edited: r.edited }));
    for (const r of rows.filter((r) => r.rule !== RULE_VERSION)) say(s, `head of ${shortId(r.node)} uses merge rules ${r.rule}, this node ${RULE_VERSION}; not merged`);

    await deps.betweenSections?.(s);
    // Merged, and the working copy moved onto the result.
    const result = await serialised(repoKey(dir), async () => {
      if (removed() || e.forgotten) return undefined;
      // Again: what was written since, and a bookmark an older node's push moved meanwhile, folded into this line.
      const own = await commitLocal(deps.cfg, dir, s, message);
      const r = await reconcile(deps.cfg, dir, me, own, peers, { profile: s.kind === "profile" });
      if (r.head !== null && r.head !== (await parentOf(deps, dir))) await moveTo(deps.cfg, dir, s, r.head, message);
      return { ...r, own };
    });
    if (result === undefined) return;
    if (s.kind === "profile" && JSON.stringify(result.self) !== JSON.stringify(me)) {
      await deps.profile?.save({ seed: result.self.seed, edited: result.self.edited, legacy: result.self.legacy });
    }

    // Published: this node's row, when its head moved (never for a legacy profile, which is this node's alone).
    const head = result.head;
    const mine = listHeadRows(deps.db, key).find((r) => r.node === self);
    if (head !== null && !result.self.legacy && !removed()) {
      const row: Omit<HeadRow, "node" | "seq"> = { scope: key, commit: head, rule: RULE_VERSION, seed: result.self.seed, edited: result.self.edited };
      if (mine === undefined || mine.commit !== row.commit || mine.rule !== row.rule || mine.seed !== row.seed || mine.edited !== row.edited) {
        writeHeadRow(deps.db, self, row);
      }
    }
    if (head !== before.was && s.kind === "memory") memoryChanged(s.projectId);
    if (s.kind === "profile") await deps.profile?.afterPass?.(head !== before.was);

    // Fetched commits now in the line need no ref of their own.
    if (head !== null) {
      const refs = (await git(["for-each-ref", "--format=%(refname) %(objectname)", "refs/meddle/fetched/"], dir, deps.cfg)).split("\n");
      for (const line of refs) {
        const [ref, commit] = line.split(" ");
        if (ref === undefined || commit === undefined || ref === "") continue;
        if (await isAncestor(deps.cfg, dir, commit, head)) await git(["update-ref", "-d", ref], dir, deps.cfg);
      }
    }

    // How it stands.
    const behind: ScopeState["waiting"] = [];
    let count = 0;
    for (const p of peers) {
      if (head !== null && (await isAncestor(deps.cfg, dir, p.commit, head))) continue;
      count++;
    }
    for (const w of waitingHeadRows(deps.db, key)) behind.push({ node: w.node, why: "fetch" });
    for (const m of missing) if (!behind.some((b) => b.node === m.node)) behind.push({ node: m.node, why: "fetch" });
    for (const r of rows.filter((r) => r.rule !== RULE_VERSION)) behind.push({ node: r.node, why: "rule" });
    for (const k of result.skipped) behind.push({ node: k.node, why: k.why });
    const state: ScopeState = { scope: key, head, behind: count, waiting: behind };
    if (JSON.stringify(state) !== JSON.stringify(e.state)) {
      e.state = state;
      changed.tell(null);
    }
  };

  const run = (e: Entry): Promise<void> => {
    if (stopped || e.forgotten) return Promise.resolve();
    if (e.running !== null) {
      e.again = true;
      return e.running;
    }
    e.running = (async () => {
      do {
        e.again = false;
        try {
          await pass(e);
        } catch (err) {
          say(e.scope, `not synced: ${oneLine(err)}`);
        }
      } while (e.again && !stopped && !e.forgotten);
    })().finally(() => {
      e.running = null;
    });
    return e.running;
  };

  const everything = async () => {
    if (stopped) return;
    for (const s of await held()) void run(entryOf(s));
  };

  const stopHeads = headChanges.subscribe((key) => {
    const s = parseScopeKey(key);
    if (s === null || stopped) return;
    const e = entries.get(key);
    if (e !== undefined) void run(e);
    // A scope not synced here yet: a project held here, or the profile (its pass does nothing while there is none).
    else if (s.kind === "profile" ? deps.profile !== undefined : listProjects(deps.db).some((p) => p.id === s.projectId)) void run(entryOf(s));
  });
  // A peer's push into a memory repo here (an older meddle's) moved its bookmark: a pass folds it in.
  const stopMemory = memoryChanges.subscribe((projectId) => {
    const e = entries.get(scopeKey({ kind: "memory", projectId }));
    if (e !== undefined && e.running === null) void run(e);
  });
  const stopPeers = deps.pool.net.onPeer((_id, online) => {
    if (online) void everything();
  });
  const timer = setInterval(() => void everything(), deps.scanMs ?? 30_000);
  timer.unref?.();
  void everything();

  /** Whether `s` is a removed project's memory: never synced again. */
  const gone = (s: Scope) => s.kind === "memory" && isRemoved(deps.db, s.projectId);

  return {
    touched(s, taskId) {
      if (stopped || gone(s)) return;
      const e = entryOf(s);
      if (taskId !== undefined && !e.tasks.includes(taskId)) e.tasks.push(taskId);
      void run(e);
    },
    async syncNow(s) {
      if (gone(s)) return;
      const e = entryOf(s);
      await run(e);
      // A pass already under way may have read before the caller's change: one more after it.
      if (e.running !== null) await e.running;
    },
    async forget(s) {
      const e = entries.get(scopeKey(s));
      if (e === undefined) return;
      e.forgotten = true;
      e.watcher?.close();
      e.watcher = null;
      if (e.quiet !== null) clearTimeout(e.quiet);
      await e.running;
      entries.delete(scopeKey(s));
      changed.tell(null);
    },
    stop() {
      stopped = true;
      stopHeads();
      stopMemory();
      stopPeers();
      clearInterval(timer);
      for (const e of entries.values()) {
        e.watcher?.close();
        e.watcher = null;
        if (e.quiet !== null) clearTimeout(e.quiet);
      }
    },
    state: () => [...entries.values()].filter((e) => !e.forgotten).map((e) => e.state),
    changes: changed.subscribable,
  };
}
