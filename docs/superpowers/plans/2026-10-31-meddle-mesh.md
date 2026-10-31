# meddle Plan 3: Repos across the Mesh and Task Moves Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A project's repo and memory follow its tasks across the pool over iroh with no upstream, every turn's commits are backed up to the project's home, and a task can be moved from one node to another with its workspaces, event log, transcript and queue intact and its session resumed where it was.

**Architecture:** Three layers on top of Plan 2. (1) **Git over iroh:** a `git-remote-meddle` helper (the `meddle git-remote` subcommand behind a wrapper script in `<data>/bin`) speaks git's remote-helper `connect` protocol on stdio and pipes the pack protocol to the local service over a unix socket; the service carries it to the peer on a `git` stream, where the peer runs `git upload-pack` or `git receive-pack` on the named replica, the latter under a meddle `update` hook that admits only task and memory refs. jj's `git fetch`/`git push`/`git clone` then work against `meddle://<nodeId>/project/<id>` and `meddle://<nodeId>/memory/<id>` remotes. (2) **Replicas:** a project has a home node; another node that needs the project clones it and its memory repo from home on demand (remote named after the home's short id), starts tasks from the home's `trunk`, pushes each task's bookmark to home at every turn end (tracking the home's copy first, so pushes keep working after a move), and syncs the memory repo around turns, the home included (its working copy follows the `memory` bookmark). (3) **Moves:** a durable `meddle.move` on the source drives the spec's procedure: mark moving (in memory, so the live turn cannot overwrite it), settle the turn, have the target fetch the task's changes and provision the folder, stream the event log, the transcript mirror and the transcript files over a `blob` stream, verify the target's receipt, record it, activate the task on the target, and only then hand over ownership and clean up, keeping a compressed archive for seven days. Every phase rolls back on its own failure (pi-durable faults a throwing phase; it does not run `abort`). Node-to-node calls ride the Plan 2 client hosts through a new `PeerObject`, taken fresh per step.

**Tech Stack:** Plan 2's stack. No new dependencies. jj 0.45.1 and git 2.47 on every node.

**Spec:** `docs/superpowers/specs/2026-10-30-meddle-design.md`, sections 7 (repos across the mesh, remotes, bookmarks, when data moves, archive, memory repos), 8 (`meddle.move`, `meddle.sync`, `meddle.memory`), 9 (version coupling), 10 (transcripts and moves), 12 (move controls, Projects view). Plans 1 and 2 are the base; their Global Constraints still apply. A Fable review of the first draft (2026-10-31) shaped decisions 1, 4, 5, 9, 10, 11, 16 to 20 and the verified facts below.

## Decisions this plan makes beyond the spec

1. **Git transport is a remote helper over a unix socket.** `git-remote-meddle` (a shell wrapper in `<data>/bin` that runs `meddle git-remote`) implements the remote-helper `connect` capability and pipes stdio to `<data>/git.sock`, where the service opens a `git` stream to the peer. jj (git subprocess) and git inherit `PATH` and `MEDDLE_GIT_SOCKET` from the environment meddle gives them; a user's own jj in a terminal gets the helper by having `<data>/bin` on `PATH` (the README says so). git's `ext::` transport is not an alternative: jj's git subprocess does not allow it.
2. **The receiving side restricts refs.** `receive-pack` runs with `core.hooksPath=<data>/git-hooks`, where meddle writes an `update` hook (mode 755) that admits `refs/heads/meddle/task/*` on `project/*` repos and `refs/heads/memory` on `memory/*` repos, refuses deletions (a zero new oid) and every other ref; the repo kind reaches the hook as `MEDDLE_REPO_KIND`. `trunk` belongs to the home (spec 7) even against a buggy member or a model pushing from inside a task. Non-fast-forward moves of task bookmarks stay allowed: jj moves them sideways after a squash.
3. **Repo names on the wire are `project/<projectId>` and `memory/<projectId>`**; a peer serves only repos it holds and only `upload-pack` and `receive-pack`. Remotes are named after the peer's `shortId`; a clone names its remote with `--remote <shortId(home)>` so jj's own `trunk()` alias for the replica points at the right remote.
4. **Project ids are pool-wide.** A project keeps the id its home minted; a node that clones it stores the same id, name and `home`. Two projects added independently on two nodes are two projects.
5. **The parent of a new task is the home's `trunk`.** On the home, `trunkFor` resolves `latest(trunk() ~ root() | bookmarks(exact:"trunk") | bookmarks(exact:"main") | bookmarks(exact:"master"))` and falls back to `root()` only when that is empty (jj's default `trunk()` alias consults only `origin`/`upstream` remotes, so Plan 1's `trunkRevset` started folder projects at root; this fixes that). On another node, `trunk@<shortId(home)>` after a fetch.
6. **Pushes to home track the home's copy first.** `pushBookmark` does, in order: fetch the bookmark from home (exit 0 when absent), `jj bookmark track <b>@<home>` (idempotent), `jj bookmark set <b> -r <change> --allow-backwards`, then `jj git push --remote <home> --bookmark <b>`. jj 0.45.1 refuses a push when an untracked same-named remote bookmark exists, when the local bookmark tracks another remote with no entry at the target, or when the remote entry is stale; this sequence survives all three, including a task that moved. A node never tracks a `@<source>` remote bookmark: a tracked bookmark the source later deletes would delete the local one on the next fetch.
7. **The transcript travels as files plus mirror rows.** Claude Code keeps sidecar files beside subagent transcripts (`agent-<id>.meta.json`) that the `SessionStore` never sees, so a move copies the task's `projects/<slot>/` tree as it is (the main `<sessionId>.jsonl` and the `<sessionId>/` subtree) and also sends the event-log and transcript-mirror rows for the target's database. Symlinks are skipped (`projects/<slot>/memory` is the memory replica).
8. **One `blob` stream per move** carries JSON header frames (kind 0) and file bytes (kind 1) in order, ends with a `done` frame carrying the sender's counts and a SHA-256 over every frame, and the receiver answers with one receipt line on the same stream. The receipt is counts, the last event seq and the hash (the spec's "count and last uuid" in a stronger form).
9. **`PeerObject`** (`meddle.peer`, `hostNamed("node")`, served only to `peer:` principals) carries the node-to-node calls: project info, `receiveTask`, `activateTask`, `abandonTask`. Bulk goes over `git` and `blob` streams. `activateTask`, `abandonTask` and the blob acceptor accept only the node recorded as the task's `receiving_from`, and only while the task is `receiving`. A `Ref` to a peer object is taken fresh for each step (a reconnect replaces the client host).
10. **Move phases roll back inside themselves.** pi-durable marks a throwing phase `faulted` and runs `abort` only after an external abort mark, so each phase of `meddle.move` catches its own failure, rolls back (best-effort `abandonTask` on the target, the task `idle` again, queued prompts replayed, one `meddle: move: …` log line, a `move` notification) and commits `{ status: "terminal", outcome: { status: "failed", error } }`. Rollback is permitted until the target acknowledges `activateTask`; a rerun of `commit` after a source crash retries `activateTask`, which is a no-op `{ ok: true }` for a task the target already activated; a rerun of `handoff` makes the target discard its partial copy first; the target abandons orphaned `receiving` rows at start.
11. **The move's state lives in memory while it runs.** `TaskRunner` keeps a `#moving` map; while a task is in it, turn paths do not write the row's state, `prompt` queues, and `interrupt`/`retry`/settings refuse with `task is moving`. The row says `moving` for restarts and the dashboard; `prepare` observes the live turn's end through the runner's own state events.
12. **A moved task keeps a row on the source** with state `moved` and `moved_to`, so the dashboard can link to it and a stale URL explains itself; the row holds no events, transcript or folder, and its `TaskObject` reads the manifest from the row, not the disk. `listLiveTasks` (every state but `moved` and `receiving`) feeds task ids, counts and `status`. `archived` stays reserved for Plan 4.
13. **Prompts sent to a moving task are queued** in a `queued` column of the task row and replayed on the target after activation as one turn: the first text (the follow-up, when a "move now" cut a turn) is the turn's prompt and the rest are pushed with priority `next`, each recorded as a user event.
14. **"Move now" follow-up text:** `The previous turn was interrupted to move this task to another machine. Background shells and subagents that were running were stopped and did not travel. Carry on from where you were; do not redo work that is already done.` The SDK has no API to list background tasks, so the dashboard's warning names the fact, not the processes.
15. **Memory repos sync around turns on every node, when no task of the project is live there.** Before a turn: a non-home node fetches `memory@<home>`; any node then rebases `@` onto `memory` when `@` is not its descendant (`jj rebase -b @ -d memory`), so the working copy tasks read follows the bookmark; a conflict stays as jj's markers for the next session to tidy. After every turn: commit memory changes (`memory from <shortId(self)>`), move `memory` to `@-` only when `@-` descends from it (otherwise rebase first), and push `memory` to home from a non-home node. A node that is live for the project defers the sync to the next idle turn.
16. **Moves are refused** when the target is offline, does not host tasks, reports a different Claude Code version, or reports `unknown` on either side (a compiled binary reports `unknown`); when the task is already moving or has moved; and when the source cannot reach the target's `PeerObject`.
17. **Home reassignment** (spec 7) and the slow bookmark poll (spec 7 "polls bookmarks slowly for the view") are deferred to Plan 4; the browser already shows each node's own heads, since it holds every node.
18. **The archive** is `<data>/archive/<taskId>.json.gz` (directory 700, file 600) holding the manifest, the event log, the transcript rows and the transcript files (base64), written before the source deletes anything; a janitor deletes archives older than seven days at start and every 24 hours.
19. **Cleanup on the source forgets, never deletes.** Task bookmarks on a non-home source go with `jj bookmark forget --include-remotes` (a `delete` would leave a deletion to push); on the home they stay as the backup. Workspaces are forgotten; the folder and config dir are removed; event and transcript rows are deleted.
20. **Accepted limitation:** the memory commits of a non-home source whose last push to home failed do not travel with the move (the target syncs memory from home); the source keeps them in its replica.
21. **`meddle.sync` and `meddle.memory`** from spec 8's table are functions inside turns rather than durable task types: they are idempotent fetch/push steps retried at the next turn end.

## Verified behaviour (2026-10-31, jj 0.45.1, git 2.47.3, bun 1.4.4)

- `jj git fetch --remote <name>`, `jj git fetch -b 'glob:meddle/task/*'`, `jj git push --remote <name> --bookmark <b>` and `jj git clone --remote <name>` work through a remote helper implementing only `connect`; the helper inherits jj's environment; an all-digit or hex remote name works in `trunk@<name>`.
- A colocated jj repo's git `HEAD` is detached: any branch accepts a push; `jj git import` in a colocated repo prints "No import needed" and any jj command imports.
- Plain `receive-pack` lets a peer force-move `trunk` and delete bookmarks; a `core.hooksPath` `update` hook refuses both and admits the task namespace.
- jj's default `trunk()` is `latest(remote_bookmarks(main|master|trunk @ origin|upstream) | root())`: a local `trunk` bookmark alone resolves to root.
- Push refusals: `Non-tracking remote bookmark B@R exists`; `Refusing to create new remote bookmark B@R`; `(reason: stale info)`; `jj bookmark track` is idempotent; `bookmark set --allow-backwards` on a conflicted bookmark pushes as "move sideways".
- After a push into the home's memory repo, the bookmark moves but `@` stays on the old base; `jj rebase -b @ -d memory` brings the working copy along.
- `jj bookmark delete` on a tracked bookmark leaves `(deleted)` with remote entries; `forget --include-remotes` removes it cleanly. A glob fetch with no match exits 0 ("Nothing changed").
- `Bun.listen({ unix })` fails on a live socket file and succeeds on a stale one; `socket.write` may be partial.
- Agent SDK: `SessionKey = { projectKey, sessionId, subpath? }`; subagent subpaths `subagents/agent-<id>` map to `<slot>/<sessionId>/subagents/agent-<id>.jsonl` with sidecar `agent-<id>.meta.json`; `Query` has `interrupt()`, `stopTask`, `backgroundTasks(toolUseId?)` and no listing API. pi-durable's `defineTask<I, S extends { phase: string }, R, H>` keys phases by `S["phase"]`; a throwing phase faults the task; `abort` runs only after an abort mark.

## Global Constraints

- Plans 1 and 2's Global Constraints apply unchanged.
- Repo names: `project/<projectId>` and `memory/<projectId>`. Remote URLs: `meddle://<nodeId>/<repo>`. Remote names: the peer's `shortId`. Task bookmarks: `meddle/task/<taskId>/<projectName>` (Plan 1). Memory bookmark: `memory`.
- Stream kinds added: `git` with header `{ "stream": "git", "repo": "<repo>", "service": "upload-pack" | "receive-pack" }`, and `blob` with header `{ "stream": "blob", "kind": "task", "taskId": "<id>" }`.
- The unix socket is `<data>/git.sock` (`MEDDLE_GIT_SOCKET` overrides for the helper and tests); a stale socket file is removed before listening. The wrapper is `<data>/bin/git-remote-meddle`, mode 755; the hook is `<data>/git-hooks/update`, mode 755. meddle prepends `<data>/bin` to `PATH` and sets `MEDDLE_GIT_SOCKET` for every `jj` it runs and for every Claude Code child.
- Task states: `idle`, `running`, `waiting`, `receiving`, `moving`, `moved`, `archived`. `receiving` refuses `prompt`, `interrupt`, `retry` and settings with `task is being received`; `moving` queues `prompt` and refuses the rest with `task is moving`; `moved` refuses everything with `task has moved to <shortId>`.
- A move is refused unless the target is online, `hostsTasks`, and reports the same non-`unknown` `claudeCodeVersion` as the source.
- The source deletes nothing before the target has acknowledged `activateTask`; before deleting, it writes the archive.
- Tests use the Plan 2 loopback setup (`presetMinimal`, `127.0.0.1:0`, no lighthouse) and the Plan 1 replayer; tests that run jj over the helper or move a task state `15_000`; the two-process end-to-end test states `90_000`. Polls print the last observed state in their failure message.
- New log lines: `meddle: git: …` (a refused repo or service; a failed push to home) and `meddle: move: …` (a move's rollback), deduplicated by the Plan 2 helper; `RunnerDeps.log?(line)` (default `console.error`) lets tests capture them.

## Review Focus

1. A turn-end push to home that fails (home unreachable) must not fail the turn: the turn completes, one line is logged, and the next turn end pushes successfully once the home is back. Test in Task 4.
2. A move whose target fails between the receipt and `activateTask` rolls back: the source is `idle` again with folder and rows intact, the target has nothing, a `move` notification names the step. Test in Task 7.
3. A move whose source crashes after recording the receipt resumes on restart, retries `activateTask` (a no-op on the target) and completes the cleanup. Test in Task 7.
4. The `git` acceptor serves only repos this node holds and only the two services, and its `update` hook refuses a push to `trunk` and a deletion, before or without spawning anything beyond `receive-pack` itself. Test in Task 2.
5. A task created on a non-home node for a project it has never seen clones the project and its memory from home, starts from the home's `trunk`, and the first turn's bookmark reaches the home. Test in Task 4.

---

## File structure

```
src/
  config.ts                   + gitSocket
  paths.ts                    + bin, binHelper, hooks, hookUpdate, gitSocket, archiveDir, archive(taskId)
  jj.ts                       jj(args, cwd, cfg?) with jjEnv; + remoteAdd, remoteList, fetch, push, bookmarkList (with conflict flag), track, rebaseOnto, isDescendant
  engine/options.ts           PATH prepend + MEDDLE_GIT_SOCKET
  git/wire.ts                 repo names, header types, meddle url
  git/serve.ts                acceptGitStreams, repoPath
  git/socket.ts               GitSocket
  git/helper.ts               runRemoteHelper
  git/scripts.ts              writeHelperWrapper, writeUpdateHook
  projects/project.ts         Project.home; addProject*(…, home); registerReplica; projectChanges
  projects/replicas.ts        ensureReplica, ensureRemote, fetchBookmarks, pushBookmark, remoteHeads, trunkFor
  projects/memory-sync.ts     syncMemoryBefore, syncMemoryAfter
  tasks/durable.ts            optional pool; turn-end push and memory sync; #moving; queued replay; states
  tasks/transfer.ts           exportTask / importTask over blob frames
  tasks/provision.ts          provisionTask uses trunkFor; + provisionFromManifest
  tasks/move.ts               MeddleMove; MoveRunner glue
  tasks/archive.ts            writeArchive, runJanitor
  pool/sync.ts                + hostFor(peerId)
  pool/runtime.ts             + peerRef(nodeId, contract)
  state/contracts.ts          PeerObject; TaskStateSchema; TaskObject move/movedTo/moveTo; ProjectObject home/heads; Notification kind move
  state/host.ts               servePeer; manifest from the row; live task lists
  dashboard/ui/Task.tsx       Move to control; moving/moved rendering
  dashboard/ui/Projects.tsx   pool-wide projects: home, holders, heads (conflicts marked)
  cli.ts                      git-remote; task move; project list shows home; serve starts the pool before the runner
test/
  git.test.ts  replicas.test.ts  memory-sync.test.ts  transfer.test.ts  move.test.ts  move-e2e.test.ts
  pool-helpers.ts             + twoPoolNodes(), restartPoolNode()
  fake-claude/replay.ts       MEDDLE_FIXTURE_MEMORY=1 writes memory/MEMORY.md
```

---

### Task 1: Project homes and the peer object

**Files:**
- Modify: `src/store/db.ts` (ADDED_COLUMNS: `projects.home TEXT`, `tasks.queued TEXT`, `tasks.moved_to TEXT`, `tasks.receiving_from TEXT`), `src/store/records.ts`, `src/projects/project.ts`, `src/state/contracts.ts`, `src/state/host.ts`, `src/pool/sync.ts`, `src/pool/runtime.ts`, `test/helpers.ts`, `test/pool-helpers.ts`
- Test: `test/project.test.ts` (extend), `test/pool-state.test.ts` (extend)

**Interfaces:**
```ts
// project.ts
export type Project = { id: string; name: string; source: ...; replica: string; home: string };
export async function addProjectFromFolder(cfg, db, folder: string, home: string, name?: string): Promise<Project>;
export async function addProjectFromUpstream(cfg, db, url: string, home: string, name?: string): Promise<Project>;
export function registerReplica(db, project: { id: string; name: string; home: string; replica: string }): Project;
/** Fires after any project is added or registered on this node. */
export const projectChanges: Subscribable<null>;      // one module-level emitter; host.ts subscribes
// records.ts
export function listLiveTasks(db): TaskRow[];         // states other than moved and receiving
// contracts.ts
export const ProjectInfoSchema = Type.Object({ id: Type.String(), name: Type.String(), home: Type.String() });
export const PeerObject = remote("meddle.peer", { version: 1, input: Type.Object({}), host: hostNamed("node"),
  variants: { peer: {
    state: { projects: Type.Array(ProjectInfoSchema), claudeCodeVersion: Type.String(), hostsTasks: Type.Boolean() },
    methods: { projectInfo: method(Type.Object({ id: Type.String() }), Nullable(ProjectInfoSchema)) },   // Task 6 adds the move methods
  } } });
// ProjectObject.default gains state `home: Type.String()`.
// sync.ts
PoolSync.hostFor(peerId: string): Host | undefined;
// runtime.ts
PoolRuntime.peerRef<C extends AnyContract>(nodeId: string, contract: C): Promise<Ref<C>>;   // rejects "not connected to <shortId>"; callers release it when done
// host.ts
export function servePeer(host, deps: { db; claudeCodeVersion: string; hostsTasks(): Promise<boolean>; changes: Subscribable<null> }): void;   // forbidden() for a non-peer principal
```
`NodeStore.taskIds`, `PoolSummaryDeps.taskCount` and `status` use `listLiveTasks`. Existing callers of `addProjectFrom*` pass the node id (the host has `pool.identity.id`; `setupNode` passes a fixed test id; the CLI's `project add` goes through the host).

- [ ] **Step 1: Write the failing tests.** `test/project.test.ts`: `home` stored and returned; `registerReplica` stores the given id and home; an older database gains the columns. `test/pool-state.test.ts` (15_000): two joined nodes; A adds a project; `B.pool.peerRef(A.id, PeerObject)` → `projects.value` lists it with `home === A.id` (after A's `projectChanges` fired); `projectInfo({ id: "nope" })` is null; `linkClient(A.host)` (principal `owner`) calling `get(PeerObject, {})` rejects `forbidden`.
- [ ] **Step 2: Run to verify they fail.** **Step 3: Implement.** **Step 4: `bun test`, `bun run typecheck`.**
- [ ] **Step 5: Commit** — `jj commit -m "feat: project homes and the peer object for node-to-node calls"`

---

### Task 2: Git over iroh

**Files:**
- Create: `src/git/wire.ts`, `src/git/serve.ts`, `src/git/socket.ts`, `src/git/helper.ts`, `src/git/scripts.ts`
- Modify: `src/config.ts`, `src/paths.ts`, `src/jj.ts`, `src/pool/frames.ts` (`readChunk`), `src/engine/options.ts`, `src/cli.ts`, `test/pool-helpers.ts`
- Test: `test/git.test.ts`

**Interfaces:**
```ts
// wire.ts
export type Repo = { kind: "project" | "memory"; id: string };
export function parseRepo(text: string): Repo;                 // "project/<id>" | "memory/<id>"; throws "bad repo name"
export function repoName(repo: Repo): string;
export type GitService = "upload-pack" | "receive-pack";
export type GitHeader = { stream: "git"; repo: string; service: GitService };
export function parseMeddleUrl(url: string): { nodeId: string; repo: Repo };   // meddle://<64 hex>/<repo>; throws "bad meddle url"
// frames.ts
StreamReader.readChunk(): Promise<Uint8Array | null>;   // buffered bytes first, then the next read; null at end
// serve.ts
export type GitServeDeps = { db; cfg; isMember(id: string): boolean; log?(line: string): void };
export function acceptGitStreams(net: PoolNet, deps: GitServeDeps): () => void;   // claims git streams; refuses before spawning; `git -c core.hooksPath=<hooks> receive-pack` with MEDDLE_REPO_KIND
export function repoPath(db, cfg, repo: Repo): string | null;
// socket.ts
export class GitSocket { constructor(cfg: NodeConfig, net: PoolNet); start(): Promise<void>; stop(): Promise<void>; readonly path: string; }   // header line { node, repo, service } ≤ 4 KiB, then raw bytes; partial writes honoured; half-close per direction
// helper.ts
export async function runRemoteHelper(args: { url: string; socketPath: string; stdin: ReadableStream; stdout: WritableStream; stderr: WritableStream }): Promise<number>;
// scripts.ts
export async function writeHelperWrapper(cfg): Promise<string>;   // <data>/bin/git-remote-meddle: `#!/bin/sh` exec of this process's cli with `git-remote "$@"`
export async function writeUpdateHook(cfg): Promise<string>;       // <data>/git-hooks/update: refuses deletes; admits refs/heads/meddle/task/* for MEDDLE_REPO_KIND=project and refs/heads/memory for memory; message "meddle: ref <ref> is not accepted here"
// paths.ts
bin, binHelper, hooks, hookUpdate, gitSocket (cfg.gitSocket ?? join(data, "git.sock"))
// jj.ts
export function jjEnv(cfg): Record<string, string>;
export async function jj(args: string[], cwd: string, cfg?: NodeConfig): Promise<string>;   // every meddle call site passes cfg from now on
export async function cloneColocated(url, dir, cfg?, remote = "origin");   // --remote <remote>
export async function remoteAdd(repo, name, url, cfg), remoteList(repo, cfg), fetch(repo, remote, bookmarks: string[], cfg), push(repo, remote, bookmark, cfg), track(repo, bookmark, remote, cfg),
  bookmarkList(repo, cfg): Promise<Array<{ name: string; remote: string | null; changeId: string; conflicted: boolean }>>   // -T template with the conflict flag
```

- [ ] **Step 1: Write the failing tests** (`twoPoolNodes()` in `test/pool-helpers.ts`: two joined `startPoolNode`s with wrapper and hook written, a `GitSocket` started and `acceptGitStreams` registered; `close()` stops them). `test/git.test.ts` (15_000 each): parse functions with exact errors; B fetches A's `trunk` through the helper (`remoteAdd` + `fetch` → `bookmarkList` shows `trunk@<shortA>`); B pushes `meddle/task/t1/p` back and A's `bookmarkList` shows it; refusals: repo `project/nope` and an absent `memory/<id>` end the stream with no data and log `meddle: git: unknown repo …`; service `foo` logs `bad git header`; a push to `refs/heads/trunk` and a `--delete` of the task bookmark from B are refused with the hook's message in jj's stderr and A's bookmarks unchanged (Review Focus 4); `cloneColocated(url, dir, B.cfg, shortId(A))` → `trunk@<shortA>` resolves and `trunk()` works in the clone.
- [ ] **Step 2–4.** Implementation notes: `serve.ts` pumps bytes with `readChunk` and `send.writeAll(Array.from(chunk))`, finishes the send side when the process exits, runs `jj bookmark list` (any jj command imports) after a successful `receive-pack`; `socket.ts` unlinks a stale file first and uses `socket.write`'s return value with `drain`; `helper.ts` exits 1 with `unknown command` for anything but the three lines; `cli.ts`: `meddle git-remote <name> <url>`; `serve` writes the wrapper and hook before any jj runs, starts the socket after the pool, registers the acceptor, and stops both in `shutdown`; `engine/options.ts` prepends `<data>/bin` to `PATH` and sets `MEDDLE_GIT_SOCKET`.
- [ ] **Step 5: Commit** — `jj commit -m "feat: git over iroh through a remote helper, a unix socket and an update hook"`

---

### Task 3: Replicas and memory across the mesh

**Files:**
- Create: `src/projects/replicas.ts`, `src/projects/memory-sync.ts`
- Modify: `src/memory.ts`, `test/fake-claude/replay.ts` (`MEDDLE_FIXTURE_MEMORY=1` appends a line to `<CLAUDE_CONFIG_DIR>/projects/<slot>/memory/MEMORY.md`), `src/cli.ts` (`MEDDLE_FIXTURE_MEMORY` in `runnerDeps`' passthrough), `test/helpers.ts`
- Test: `test/replicas.test.ts`, `test/memory-sync.test.ts`

**Interfaces:**
```ts
// replicas.ts
export type ReplicaDeps = { cfg: NodeConfig; db: Database; pool: PoolRuntime };
export async function ensureReplica(deps, projectId: string): Promise<Project>;   // clones project and memory from home with --remote shortId(home) when absent (home must be online: "home <shortId> is offline"); registers the row
export async function ensureRemote(cfg, replica, nodeId, repo: Repo): Promise<string>;
export async function fetchBookmarks(cfg, replica, nodeId, bookmarks: string[]): Promise<void>;   // verifies each expected <b>@<shortId> exists afterwards; throws "bookmark <b> not found on <shortId>"
export async function pushBookmark(cfg, replica, home, bookmark, changeId): Promise<void>;   // decision 6's four steps
export async function remoteHeads(cfg, replica): Promise<Array<{ name; remote; changeId; conflicted }>>;
export async function trunkFor(deps, project: Project): Promise<string>;    // decision 5
// memory-sync.ts
export async function syncMemoryBefore(deps, projectId, live: boolean, log?): Promise<void>;   // decision 15; never throws
export async function syncMemoryAfter(deps, projectId, log?): Promise<void>;                  // decision 15; never throws
```

- [ ] **Step 1: Write the failing tests** (15_000, over `twoPoolNodes`). `replicas.test.ts`: `ensureReplica(B, id)` clones project and memory with remote `shortA`, registers `home === A.id`, `trunkFor` on B is `trunk@<shortA>` and resolves to A's change; on A `trunkFor` resolves the local `trunk` bookmark (not root) for a folder project; a second call is a no-op; with A unwatched (`B.net.unwatch(A.id, "bye")`) it rejects `home <shortA> is offline`; `pushBookmark` succeeds three times in a row (fresh, after a fetch created an untracked `@shortA`, after A's copy moved ahead); `fetchBookmarks` for a missing bookmark throws. `memory-sync.test.ts`: A writes `MEMORY.md`, `syncMemoryAfter(A)` commits (bookmark `memory` at `@-`); `syncMemoryBefore(B, id, false)` fetches and B's working copy has the file; B writes `NOTES.md`, `syncMemoryAfter(B)` pushes; `syncMemoryBefore(A, id, false)` → A's working copy has `NOTES.md` (the file, not just the bookmark); `syncMemoryBefore(B, id, true)` does nothing; conflicting edits on both sides leave conflict markers on the puller and no throw; `syncMemoryAfter` on the home after a peer's push does not move `memory` sideways (B's commit stays an ancestor of `memory`).
- [ ] **Step 2–4.** **Step 5: Commit** — `jj commit -m "feat: project and memory replicas follow tasks across the mesh"`

---

### Task 4: Turns across the mesh

**Files:**
- Modify: `src/tasks/durable.ts`, `src/tasks/provision.ts`, `src/state/host.ts`, `src/cli.ts` (start the pool before the harness and runner), `test/helpers.ts`, `test/pool-helpers.ts` (`restartPoolNode(node)`: reopen the same home, identity and db with a new `startPool` and host)
- Test: `test/durable.test.ts` (extend), `test/pool-state.test.ts` (extend)

**Interfaces:** `RunnerDeps` gains `pool?: PoolRuntime` (absent: Plan 1 single-node behaviour) and `log?(line: string)`. `TaskRunner.create()` → `ensureReplica` for every project when `pool` is present, parents from `trunkFor` (on a single node `trunkFor` with a stub home = self). `runTurnPhase` → `syncMemoryBefore(primary, live = another task of the project is live here)`. `finishTurnPhase` → Plan 1's bookmark set, then for each project whose home is not this node `pushBookmark` (failure → `log("meddle: git: push of <b> to <shortId> failed: …")`, never thrown), then `syncMemoryAfter(primary)`. `provisionTask` takes `parents` from the caller (the runner) instead of calling `trunkRevset`.

- [ ] **Step 1: Write the failing tests** (15_000): Review Focus 5: B creates a task for A's project it has never seen → project registered with home A, workspace parent is A's trunk change; a replayed turn ends and A's `bookmarkList` has `meddle/task/<id>/<name>` at B's change; with `MEDDLE_FIXTURE_MEMORY=1` A's memory working copy has B's line after A's next `syncMemoryBefore`. Review Focus 1: `B.net.unwatch(A.id, "bye")`; a turn on B completes with `result`; B's captured log has exactly one `meddle: git: push …` line; `B.net.watch(A.id)` + `offerAddress` → the next turn end pushes and A has the new change. Plan 1's tests keep passing with no pool.
- [ ] **Step 2–4.** **Step 5: Commit** — `jj commit -m "feat: turns push to home and sync memory across the mesh"`

---

### Task 5: Task transfer frames

**Files:**
- Create: `src/tasks/transfer.ts`
- Test: `test/transfer.test.ts`

**Interfaces:**
```ts
export type TransferFrame =
  | { t: "manifest"; manifest: TaskManifest; settings: TaskSettings | null; queued: string[]; turns: number }
  | { t: "event"; seq: number; json: string }
  | { t: "transcript"; projectKey: string; sessionId: string; subpath: string; seq: number; uuid: string | null; ts: number; json: string }
  | { t: "file"; path: string; size: number }      // relative to <taskConfig>/projects/; followed by one kind-1 frame of `size` bytes
  | { t: "done"; events: number; transcript: number; files: number; bytes: number; sha256: string };
export type Receipt = { events: number; transcript: number; files: number; bytes: number; lastEventSeq: number; sha256: string };
export async function exportTask(cfg, db, taskId, send: SendStream): Promise<Receipt>;     // lstat walk, symlinks skipped; hash over every frame's bytes in order
export async function importTask(cfg, db, reader: StreamReader, expect: { taskId: string }): Promise<{ manifest; settings; queued; turns; receipt: Receipt }>;   // one transaction for rows, rolled back on "transfer ended early"; files written under the task's config dir
export function receiptsMatch(sent: Receipt, got: Receipt): boolean;
```

- [ ] **Step 1: Write the failing tests:** round trip over an `endpointPair` stream after a replayed turn (events, transcript rows, the `<sessionId>.jsonl` file, a fake `<sessionId>/subagents/agent-x.jsonl` and `agent-x.meta.json`) → rows equal, files byte-equal, receipts match, hashes equal; a populated memory replica behind the `memory` symlink contributes zero `file` frames; a sender that closes before `done` → `importTask` rejects `transfer ended early` and no rows remain; a manifest for another task id is rejected.
- [ ] **Step 2–4.** **Step 5: Commit** — `jj commit -m "feat: task transfer frames for moves"`

---

### Task 6: The move receiver

**Files:**
- Modify: `src/tasks/provision.ts` (`provisionFromManifest`), `src/state/contracts.ts` (`TaskStateSchema` + `receiving`; `PeerObject` methods), `src/state/host.ts`, `src/tasks/durable.ts`
- Test: `test/move.test.ts` (receiver half)

**Interfaces:**
```ts
// provision.ts
export async function provisionFromManifest(cfg, db, manifest: TaskManifest, parents: Record<string, string>, state: TaskState): Promise<TaskManifest>;   // rewrites each project's `replica` (this node's) and `parent` (the fetched change id); writes task.json and the row (started = 1, state)
// PeerObject.peer methods
receiveTask: method(Type.Object({ manifest: TaskManifestSchema, claudeCodeVersion: Type.String() }), Type.Object({ ok: Type.Boolean(), reason: Type.Optional(Type.String()) }));
activateTask: method(Type.Object({ taskId: Type.String(), followUp: Nullable(Type.String()) }), Type.Object({ ok: Type.Boolean() }));
abandonTask: method(Type.Object({ taskId: Type.String() }));
// TaskRunner (the caller's node id comes from peerOf(principal) in the factory)
async receiveTask(manifest, from: string, version: string): Promise<{ ok: true } | { ok: false; reason: string }>;   // version equal and not "unknown" ("claude code <a> here, <b> there"); hostsTasks; an existing receiving row for the id from `from` is abandoned first; ensureReplica per project; fetchBookmarks(meddle/task/<id>/*) from `from` (verified); provisionFromManifest(state "receiving", receiving_from = from)
async importIncoming(taskId, from, reader): Promise<Receipt>;    // requires state receiving and from === receiving_from
async activateTask(taskId, from, followUp): Promise<{ ok: true }>;   // idle; replays queued (decision 13); a task already idle/running from `from` → { ok: true } no-op
async abandonTask(taskId, from): Promise<void>;                  // only receiving rows; rows, folder, workspaces, local bookmarks (forget) removed
abandonOrphans(): Promise<void>;                                  // at start: every receiving row
```
`acceptBlobStreams(net, runner)` claims `{ stream: "blob", kind: "task" }` streams, runs `importIncoming(taskId, s.peerId, s.reader)`, writes the receipt line, finishes; a refusal resets the stream.

- [ ] **Step 1: Write the failing tests** (15_000): A's task after one replayed turn → B's `receiveTask` from A's `peerRef` → B has the folder and workspaces at A's change, row `receiving` with `receiving_from = A`, manifest `replica` paths are B's; `exportTask` from A over a blob stream → B's receipt matches; `activateTask` → B's task `idle`, a prompt on B runs a resumed turn (the replayer sees `--resume`), and a second `activateTask` is a no-op `{ ok: true }`; `abandonTask` on a receiving task leaves nothing; a third node C calling `activateTask`/`abandonTask`/opening a blob stream for A's task → `forbidden`/reset; version mismatch and `unknown` → `{ ok: false, reason }`; a second `receiveTask` for the same id replaces the partial.
- [ ] **Step 2–4.** **Step 5: Commit** — `jj commit -m "feat: receive a moved task: fetch, provision, import, activate"`

---

### Task 7: The move

**Files:**
- Create: `src/tasks/move.ts`, `src/tasks/archive.ts`
- Modify: `src/tasks/durable.ts`, `src/tasks/harness.ts` (install `MeddleMove`), `src/state/contracts.ts` (`TaskStateSchema` + `moving`, `moved`; `TaskObject` `move`, `movedTo`, `moveTo`; `NotificationSchema.kind` + `move`), `src/state/host.ts` (manifest from the row; `runner.onMove`), `src/paths.ts`
- Test: `test/move.test.ts` (source half), `test/durable.test.ts`

**Interfaces:**
```ts
// move.ts
export type MoveInput = { taskId: string; to: string; now: boolean };
export type MoveCheckpoint = { phase: "prepare" } | { phase: "handoff" } | { phase: "commit"; receipt: Receipt } | { phase: "cleanup" };
export const MeddleMove = defineTask<MoveInput, MoveCheckpoint, null, MeddleHooks>({ name: "meddle.move", version: 1, ... });
// phases: prepare (refusals per decision 16; #moving; wait for the live turn's end through onState, or interrupt() and wait when `now`) → handoff (bookmarks set; peerRef(to).receiveTask; blob exportTask; receipt compared → commit checkpoint { receipt }) → commit (peerRef(to).activateTask with the follow-up when `now` cut a turn; row state moved + moved_to → checkpoint cleanup) → cleanup (archive; forget workspaces; forget local task bookmarks unless home; rm folder and config dir; delete event and transcript rows; terminal completed).
// every phase: catch → rollback (abandonTask best effort before activate acknowledged; row idle; #moving cleared; queued replayed as one turn; log "meddle: move: <taskId> failed at <phase>: <error>"; notification kind move) → terminal failed. abort(): the same rollback → terminal aborted.
// archive.ts
export async function writeArchive(cfg, db, taskId): Promise<string>;    // <data>/archive/<taskId>.json.gz (dir 700, file 600)
export async function runJanitor(cfg, now = Date.now()): Promise<number>;
// TaskRunner
async moveTo(taskId, to, now): Promise<void>;   // one move per task; refusals throw before the durable task starts
onMove(cb: (taskId, move: { to; phase; error: string | null } | null) => void): () => void;
// TaskObject.default
state: TaskStateSchema; move: Nullable(Type.Object({ to: Type.String(), phase: Type.String(), error: Nullable(Type.String()) })); movedTo: Nullable(Type.String());
moveTo: method(Type.Object({ nodeId: Type.String(), now: Type.Boolean() }));
```

- [ ] **Step 1: Write the failing tests** (15_000): full move of an idle task A→B (A: `moving` → `moved` with `movedTo`, `TaskObject` still renders from the row, no folder, no rows, an archive file 600 in a 700 dir; B: `idle`, a resumed turn runs; A is home so its task bookmark stays; after B's turn A's bookmark is at B's new change and B logged no push failure); a running task moved without `now` waits for the turn and the row never leaves `moving` meanwhile (the live turn's end does not write `idle`); with `now` the turn is interrupted and the follow-up is B's first prompt; prompts during the move are queued and run on B as one turn in order (user events in order); Review Focus 2 (a test hook makes B's `activateTask` throw once): rollback → A `idle`, folder and rows intact, B has nothing, a `move` notification with phase `commit`; Review Focus 3: close and reopen A's harness after the `commit` checkpoint (as `test/durable.test.ts` does for turns) → cleanup completes, B's `activateTask` saw a second no-op call; refusals: offline target, version mismatch, `unknown`, moving twice, moved task prompt → `task has moved to <shortB>`.
- [ ] **Step 2–4.** **Step 5: Commit** — `jj commit -m "feat: move a task to another node with its workspaces, log, transcript and queue"`

---

### Task 8: Dashboard and CLI

**Files:**
- Modify: `src/dashboard/ui/Task.tsx`, `src/dashboard/ui/Pool.tsx`, `src/dashboard/ui/Projects.tsx`, `src/state/contracts.ts` (`ProjectObject` `heads: Array<{ name, remote, changeId, conflicted }>`), `src/state/host.ts`, `src/cli.ts`, `test/helpers.ts`
- Test: `test/ui.test.ts`, `test/cli.test.ts`, `test/move-e2e.test.ts`

Task view: "Move to" picker over online members with `hostsTasks` and the same non-`unknown` Claude Code version; a "move now" checkbox with the warning (background shells and subagents stop and do not travel); `moving` shows the phase; `moved` shows a link to the task on its new node; a `move` notification opens the task. Pool cards list live tasks only. Projects view: one row per project id merged across nodes: name, home node, nodes holding it, each holder's heads with conflicted bookmarks marked. CLI: `meddle task move <id> <node> [--now]` (node by full id or unique short prefix; prints `moving <id> to <shortId>`), `project list` shows `home`.

- [ ] **Step 1: Write the failing tests:** ui bundle builds; usage text; `test/move-e2e.test.ts` (90_000, polls with deadlines that print the last state): two `serve` processes with the fake lighthouse; A: project, task, a turn; `meddle task move <id> <shortB>` on A; poll until B's `meddle pool`/status lists the task and A's lists 0; `meddle task prompt` on B → `result/success`; a tunnel client from A sees the task on B; both exit 0 with empty stderr.
- [ ] **Step 2–4.** **Step 5: Commit** — `jj commit -m "feat: move tasks from the dashboard and the CLI; pool-wide projects view"`

---

### Task 9: README

- [ ] Document projects and homes, `meddle://` remotes, the helper and hook (PATH line for terminals), what travels on a move and what does not, "move now", queued prompts, the archive and janitor, memory sync on every node, version refusal including `unknown`, the known limits (decisions 17 and 20). Verify `bun run build`; `dist/meddle git-remote x meddle://…` without a socket exits non-zero with a clear message. `bun test`, `bun run typecheck`.

`jj commit -m "docs: repos across the mesh and task moves in the README"`

---

## Self-review notes

- Spec coverage: 7 (Tasks 1–4, 7; decisions 5, 6, 15, 17, 19, 20), 8 (`meddle.move` Task 7; decision 21), 9 version coupling (decision 16, Tasks 6–7), 10 (Tasks 5–7; decisions 7–14), 12 move controls, Projects view and the failed-move notification (Tasks 7–8).
- Names used across tasks: `Project.home`, `registerReplica`, `projectChanges`, `listLiveTasks`, `PeerObject`, `peerRef`, `hostFor`, `servePeer`, `Repo`/`parseRepo`/`parseMeddleUrl`, `readChunk`, `acceptGitStreams`, `repoPath`, `GitSocket`, `runRemoteHelper`, `writeHelperWrapper`, `writeUpdateHook`, `jjEnv`, `cloneColocated(url, dir, cfg, remote)`, `bookmarkList` (with `conflicted`), `ensureReplica`, `ensureRemote`, `fetchBookmarks`, `pushBookmark`, `remoteHeads`, `trunkFor`, `syncMemoryBefore/After`, `RunnerDeps.pool?/log?`, `exportTask`/`importTask`/`Receipt`/`receiptsMatch`, `provisionFromManifest`, `receiveTask`/`importIncoming`/`activateTask`/`abandonTask`/`abandonOrphans`, `acceptBlobStreams`, `MeddleMove`/`MoveCheckpoint.phase`, `writeArchive`/`runJanitor`, `moveTo`/`onMove`, `restartPoolNode`.
- Review Focus 1–5 are pinned in Tasks 4, 7, 7, 2 and 4.
