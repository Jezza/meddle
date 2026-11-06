# Task Starts and Lines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every project of a new task starts at a revision handed to it — a given revision, the fork point of the
home's `@`, or one of the project's sync branches — and the task owns its line on the home: you can see it, only the task
writes it.

**Architecture:** The home holds each task's line as git refs `refs/remotes/meddle/task/<id>/<name>`, which jj shows
as untracked remote bookmarks and so keeps immutable with their ancestors. A task on the home stays a jj workspace of
the home repo, as on main; a workspace-level jj config lets its agent write its own line and nothing below its base.
A task elsewhere pushes its line to the home. Trunk goes away.

**Tech Stack:** Bun, TypeScript, jj 0.45.1 (colocated git), chord RPC between pool nodes.

**Spec:** The decisions below, settled with the user on 2026-11-06. Supersedes the unmerged change `wosklsmk`
("Hand a revision to an agent's task, which owns its line"), which stays as a source to port code from
(`jj file show -r wosklsmk <path>`); never restore it wholesale.

## Decisions

1. **Line.** Task `<id>`'s line `<name>` (the project name, or a side bookmark `<project>.<label>`) is the git ref
   `refs/remotes/meddle/task/<id>/<name>` in the project's home repo, shown by jj as `task/<id>/<name>@meddle`. The
   user's jj (default `immutable_heads()`) holds it and every ancestor immutable. Only the task's holder moves it: on
   the home by `git update-ref` under `repoKey`, from elsewhere by a forced git push. It is removed only through jj
   (`jj bookmark forget --include-remotes`), never by deleting the ref.
2. **Tasks on the home stay in the home repo**, as jj workspaces, as on main: no clones. Each task workspace gets a
   workspace-level jj config (`jj config set --workspace`), in every project repo, on every node:
   `revset-aliases."immutable_heads()" = present(<base commit>) | untracked_remote_bookmarks(~glob:"task/<id>/*", remote=exact:"meddle")`.
   The agent may rewrite its own line but nothing at or below its base, nor another task's line. Anything else
   in the repo is as writable to it as on main.
3. **Turn end** writes each bookmark under `meddle/task/<id>/` to the line: on the home by `writeLine`; elsewhere by
   `git push --force <home url> +refs/heads/meddle/task/<id>/*:refs/remotes/meddle/task/<id>/*`. One writer, so no
   fetch-and-merge before the push (main's `pushNamespace` goes). A side bookmark the agent deleted is given back:
   its line is released on the home (the project's own name is always kept).
4. **Starts, per project.** Each project of a task resolves its own start on its own home:
   - a revision given for it: that revision (`child` mode unless `--edit`); if it is the name of one of the
     project's sync branches, a sync start from that branch instead;
   - none given, a folder project: the **fork point** of the home folder's `@` (the workspace at the project's
     folder, normally the root workspace) — `heads(::@ ~ (empty() ~ merges()))`, read with
     `--ignore-working-copy`. If that is `@` itself (`@` has content), refuse: meddle never moves a workspace;
   - none given, a url project: a sync start from its first sync branch.
   A start at a revision writes the line there before the task exists (child mode at the revision F, edit mode at
   W). A sync start writes no line; the task's first push does.
5. **Modes.** `child` (default): the workspace is a new change on F; the base is F. `edit` (`--edit`, only with a
   given revision): the workspace edits W; the base is W's fork point. Edit refusals, in this order:
   `<W> is immutable` (another task's line holds it, or the user's config), `<W> is <workspace>'s working copy; move
   off it first` (any workspace), `<W> has revisions on top of it`, `nothing to hand off: <W> has no changes`,
   `no fork point below <W>`, `<W> has <n> fork points`. Child refuses `cannot start a task on the root commit`.
   Either refuses `no revision <rev> in <project>` and `<rev> names <n> revisions in <project>`.
6. **Sync branches.** A project names an ordered list of bookmarks as its sync branches; the first is a url
   project's default start. `project add <url>` starts the list with the upstream's default branch, `project add
   <folder>` with nothing; each `--sync <b>` (repeatable) appends one; `project sync <id|name> <b>...` replaces the
   list (none given: empties it). Nothing polls them: a sync start fetches its one branch from the home as the task
   is created (the home first fetches every sync branch of a url project from upstream when another node fetches
   the project, and the one branch from upstream when it creates such a start itself). With the home offline, a
   sync start uses the copy this node fetched last; with no copy, or any other start, it refuses
   `home <short id> is offline`.
7. **Creation.** The node a client asks (`NodeObject.createTask`) mints the task id, asks each project's home for its
   start (`PeerObject.startAt`, or locally), then creates the task on the placed node with those starts
   (`PeerObject.createTaskAt`, a new method: an older peer fails loudly instead of starting the task elsewhere).
   When a start or the creation certainly failed, the lines already written are released; when the creation's answer
   was lost, it asks the target (`taskHeld`) and keeps the lines if the task exists.
8. **No trunk.** `refreshTrunk`, `trunkFor`, `HOME_TRUNK`, the home's `trunk` bookmark upkeep, the git server's trunk
   refresh and the runner's offline trunk fallback go. A task with no projects is unchanged.
9. **Accepting** a task's work is the user's: `jj new <line head>` or a rebase of their own work onto it. meddle never
   moves the user's working copy and never snapshots it (`--ignore-working-copy` on every read of the home repo).

## Verified behaviour (jj 0.45.1, 2026-11-06)

- An untracked remote bookmark `task/t1/p@meddle` at W freezes W and its ancestors for the user.
- With Decision 2's workspace config, the agent edits and describes W in its workspace of the same repo; rewriting
  the base A is refused `Commit … is immutable`.
- Mid-turn the old W shows as hidden under the remote bookmark; nothing is divergent; the new W2 is mutable to the
  user until the turn end moves the ref, then immutable. jj 0.45 imports git refs by itself in a colocated repo.
- Deleting a line's git ref directly makes jj abandon commits only it kept, the user's included, and rebase `@` off
  them; `jj bookmark forget --include-remotes` does not.
- Workspace config lives at `~/.config/jj/workspaces/<id>/config.toml` (`jj config path --workspace`), not in the
  workspace; `jj workspace forget` does not remove it.

## Global Constraints

- Use jj, not git, for version control; commit with `jj commit -m`. No AI attribution in descriptions.
- Run the targeted test files each task names, not the whole suite, until the final review.
- Never snapshot or move the user's working copy: every jj read of a home repo passes `--ignore-working-copy`.
- A line is removed only by `jj bookmark forget --include-remotes`; never `git update-ref -d` on it.
- No new reference to trunk anywhere (`trunk()`, `trunk` bookmarks, "trunk" in user-facing text).

## Review Focus

1. A user's unsnapshotted edits on `@` when a folder project forks: the fork point is read without a snapshot, so
   the edits stay the user's and `@` (empty as last snapshotted) is skipped. Test in Task 4.
2. Two hand-offs of one revision at once (two clients): the second edit-mode hand-off is refused immutable, never
   given W too. Test in Task 4 (starts under `serialised("handoff:<projectId>")`).
3. A multi-project task whose second home refuses: the first home's line is released, nothing is left frozen.
   Test in Task 5.
4. A task moved off and back onto the home: its workspace config is rewritten with the same base, and its line
   still moves only by the holder. Test in Task 2.
5. A task deleted on the home: its line is released, its workspace config file removed, the user's commits under it
   become mutable again and none is abandoned. Test in Task 2.

---

### Task 1: Lines on the home

**Files:**
- Create: `src/projects/lines.ts` (port from `wosklsmk`, without `ownerOf`, `pushLines`' task-repo logic,
  `isLegacyHomeTask` and `projectUrl`'s task-repo case)
- Modify: `src/git/scripts.ts` (update hook), `src/state/contracts.ts`, `src/state/host.ts` (PeerObject handlers)
- Test: `test/lines.test.ts` (port the parts covering what this task keeps), `test/git.test.ts`

**Interfaces:**
- Produces, in `src/projects/lines.ts`:
  `LINE_REMOTE = "meddle"`; `linePrefix(taskId): string`;
  `writeLine(cfg, homeRepo, taskId, name, commit): Promise<void>` (update-ref, then `gitImport`; caller holds `repoKey`);
  `homeLines(cfg, homeRepo, taskId?): Promise<Array<{ taskId; name; commitId }>>`;
  `releaseLines(cfg, homeRepo, taskId, keep: string[]): Promise<string[]>` (jj forget only);
  `pushLines(cfg, repo, project, taskId): Promise<void>` (forced refspec push of Decision 3 to `meddleUrl(home)`);
  `fetchLines(cfg, repo, project, from: string, taskId, source: "home" | "holder"): Promise<Array<{ name; commitId }>>`
  (`--prune`, into `refs/heads/meddle/task/<id>/`; `source` picks the home's lines or the holder's local bookmarks);
  `whereIs(deps, taskId): Promise<"held" | "offline" | "gone">`.
- Produces on `PeerObject`: `releaseLines({ taskId, keep }) → { released: string[] }` (home only; refuses when this
  node is not the project's home) and `taskHeld({ id }) → boolean`.

- [ ] **Step 1: Write the failing tests** — port from `wosklsmk:test/lines.test.ts`: a written line shows as
  `task/<id>/<name>@meddle` and makes the commit and its parent immutable (`jj log -r 'immutable()'`); `releaseLines`
  with `keep: ["p"]` releases `p.x`, keeps `p`, and the released commit is mutable and still visible; `homeLines`
  lists by name; the hook accepts `refs/remotes/meddle/task/t/p` and refuses `refs/remotes/meddle/other` and a
  deletion (`git.test.ts`). Keep main's `refs/heads/meddle/task/*` hook case passing: Task 2 removes it.
- [ ] **Step 2: Run** `bun test test/lines.test.ts test/git.test.ts` — expect the new tests to FAIL.
- [ ] **Step 3: Implement** the interfaces above; the hook admits `project:refs/remotes/meddle/task/*` beside the
  existing cases.
- [ ] **Step 4: Run** `bun test test/lines.test.ts test/git.test.ts && bun run typecheck` — expect PASS.
- [ ] **Step 5: Commit** `jj commit -m "Keep a task's line on the home as read-only remote bookmarks"`.

### Task 2: The holder writes the line

**Files:**
- Modify: `src/tasks/durable.ts` (`#pushToHome`, `archive`, `receiveTask`, `#fetchTaskChange`, `restoreHere`,
  `stageNamespace`, `deleteTask`, startup), `src/tasks/provision.ts`, `src/tasks/manifest.ts`,
  `src/projects/replicas.ts` (remove `pushNamespace`, `pushBookmark` if unused), `src/git/scripts.ts`, `src/cli.ts`
  (serve: janitor), `src/jj.ts` (a `configSetWorkspace` / workspace config path helper)
- Test: `test/move.test.ts`, `test/archive.test.ts`, `test/replicas.test.ts`, `test/provision.test.ts`,
  `test/lines.test.ts`

**Interfaces:**
- Consumes: Task 1's `lines.ts` and PeerObject methods.
- Produces: manifest project entries gain `base: string` (a commit id; for now the commit of `parent`).
  `scopeWorkspace(cfg, workspace, taskId, base): Promise<void>` in `src/tasks/provision.ts` writes Decision 2's
  config; `unscopeWorkspace(cfg, workspace)` removes the file (`jj config path --workspace`) before
  `workspaceForget`.

- [ ] **Step 1: Write the failing tests:**
  - a home task's turn end writes `task/<id>/<project>@meddle` at its bookmark, and the user's repo then refuses
    `jj describe` of that commit as immutable;
  - a remote task's turn end pushes the same ref to the home, and the home's `refs/heads/meddle/task/*` stay
    untouched;
  - the agent's workspace can `jj describe` its line's head but not its base (`immutable`);
  - a side bookmark the agent deleted is released on the home at the next turn end, and the project's line is kept;
  - move off the home and back (Review Focus 4): the receiver fetches the line from the home, and the
    workspace config names the same base;
  - restore from archive and stage fetch the line from the home;
  - delete on the home (Review Focus 5): the line is released, the config file is gone, and the user's commit
    under it is mutable and visible;
  - a push that failed while the home was offline is retried when the home comes back (`#unpushed`, seeded at start);
  - the janitor releases the line of a task gone from every node, and keeps one an offline node may hold.
- [ ] **Step 2: Run** `bun test test/move.test.ts test/archive.test.ts test/replicas.test.ts test/provision.test.ts test/lines.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.** Port `giveBackLines`, `releaseOnHome`, `releaseGoneLines` and the `#unpushed` re-push
  from `wosklsmk` (`src/projects/lines.ts`, `src/tasks/durable.ts`), adapted to tasks on the home living in the
  home repo: there, turn end and move-prepare `writeLine` each bookmark under `repoKey(project.replica)`; elsewhere
  `pushLines`. Every place main fetched `meddle/task/<id>/*` from the home's `refs/heads` fetches the line
  (`fetchLines(…, "home")`). Every workspace `provisionTask` or `provisionFromManifest` adds gets `scopeWorkspace`;
  every one removed gets `unscopeWorkspace`. Drop the hook's `refs/heads/meddle/task/*` case and `pushNamespace`.
- [ ] **Step 4: Run** the same tests and `bun run typecheck` — expect PASS.
- [ ] **Step 5: Commit** `jj commit -m "Write a task's line by its holder only, and scope its workspace to it"`.

### Task 3: Sync branches

**Files:**
- Modify: `src/store/db.ts` (column `projects.sync TEXT`, a JSON array of names), `src/store/records.ts`, `src/projects/project.ts`,
  `src/projects/replicas.ts`, `src/state/contracts.ts` (`ProjectSchema`, `ProjectInfoSchema`, `NodeObject`
  `addProject*` inputs, new `setProjectSync`), `src/state/host.ts`, `src/git/serve.ts`, `src/cli.ts`, `src/help.ts`,
  `README.md`
- Test: `test/replicas.test.ts`, `test/git.test.ts`, `test/cli.test.ts`, `test/help.test.ts`

**Interfaces:**
- Produces: `Project.sync: string[]`; `ProjectInfo.sync: string[]` (a replica takes it from the home on every
  `projectInfo` answer and on `ensureReplica`; an existing row reads as `[]`);
  `addProjectFromFolder(cfg, db, folder, home, name?, sync: string[] = [])`,
  `addProjectFromUpstream(cfg, db, url, home, name?, sync: string[] = [])` (the list is the upstream's default
  branch, from `git ls-remote --symref <url> HEAD`, followed by `sync` without repeats; just `sync` when the
  upstream has no default branch);
  `setProjectSync(db, projectId, sync: string[])`;
  `fetchSync(deps, project, branch): Promise<string>` in `src/projects/replicas.ts` — the commit sync branch
  `branch` (one of `project.sync`, else rejects `<branch> is not a sync branch of <project>`) points at for a new
  task here: on the home, after fetching it from `origin` for a url project, the local bookmark for a folder project;
  elsewhere `<branch>@<short home>` after fetching it, or the last fetched copy when the home is offline (logged
  `meddle: project <name>: home offline; starting from <branch> as fetched last`); rejects `home <short> is offline`
  with no copy.
- CLI: `project add <path-or-url> [--name <n>] [--sync <bookmark>]...`, `project sync <id|name> [<bookmark>...]`;
  `project list` shows each project's sync branches.

- [ ] **Step 1: Write the failing tests:** a url project added from a repo whose HEAD is `master` with
  `--sync dev --sync master` has sync `["master", "dev"]`; a folder project has `[]` until
  `project sync <p> main release/1.2` sets `["main", "release/1.2"]`, and `project sync <p>` empties it; a replica
  learns the list from the home; `fetchSync(…, "release/1.2")` on another node returns the home's commit, then (home
  stopped) the same commit from the last fetch, then rejects on a node that never fetched it; `fetchSync` of a name
  not in the list rejects; serving an `upload-pack` of a url project homed here fetches every sync branch from
  upstream first (replacing main's trunk refresh test in `git.test.ts`).
- [ ] **Step 2: Run** `bun test test/replicas.test.ts test/git.test.ts test/cli.test.ts test/help.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** the interfaces; `serve.ts`'s trunk refresh becomes the url projects' sync fetch (failure logged,
  never refusing the fetch).
- [ ] **Step 4: Run** the same tests and `bun run typecheck` — expect PASS.
- [ ] **Step 5: Commit** `jj commit -m "Give a project sync branches, fetched as a task is created"`.

### Task 4: Starts on the home

**Files:**
- Create: `src/projects/starts.ts` (port the checks of `wosklsmk:src/projects/handoff.ts`, minus `ownerOf`)
- Modify: `src/tasks/manifest.ts`, `src/state/contracts.ts`, `src/state/host.ts`
- Test: `test/starts.test.ts`

**Interfaces:**
- Produces in `src/tasks/manifest.ts`:
  `type HandoffMode = "edit" | "child"`;
  `type Start = { projectId: string; kind: "line"; mode: HandoffMode; commit: string; base: string } | { projectId: string; kind: "sync"; branch: string }`
  (`commit` and `base` are commit ids).
- Produces in `src/projects/starts.ts`:
  `startAt(deps, projectId, taskId, rev: string | null, mode: HandoffMode): Promise<Start>` — this node must be the
  project's home; under `serialised("handoff:<projectId>")` and `repoKey`; resolves Decision 4 and 5 with
  `--ignore-working-copy` after `gitImport`, refuses with their exact messages, and for a `line` start calls
  `writeLine(…, taskId, project.name, commit)` before returning. `mode: "edit"` with `rev: null` rejects
  `--edit needs a revision`.
- Produces on `PeerObject`: `startAt({ projectId, taskId, rev, mode }) → Start`.

- [ ] **Step 1: Write the failing tests** (`test/starts.test.ts`, on one node's folder project unless said):
  - no rev, `@` empty on P with content: a child `line` start at P, the line written at P;
  - no rev, `@` with content: refused `@ has changes; move off it first`, nothing written;
  - no rev, an unsnapshotted edit in the folder and `@` empty as last snapshotted (Review Focus 1): starts at `@-`,
    and `jj status` in the folder afterwards still shows the edit as the user's;
  - no rev, a url project with sync `["main", "dev"]`: `{ kind: "sync", branch: "main" }`, nothing written;
    `rev: "dev"`: `{ kind: "sync", branch: "dev" }`; no rev on a url project with no sync branches: refused
    `<project> has no sync branch`;
  - `--edit` on W: a line at W with base P; each edit refusal of Decision 5 in order; the second of two concurrent
    edit starts of W refused `is immutable` (Review Focus 2);
  - child at `root()` refused; `no revision nosuchrev in a`; `@ | @- names 2 revisions in a`;
  - asked of a node that is not the home: `a task's start is resolved on its project's home, <short id>`.
- [ ] **Step 2: Run** `bun test test/starts.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** `startAt` and the PeerObject method.
- [ ] **Step 4: Run** `bun test test/starts.test.ts && bun run typecheck` — expect PASS.
- [ ] **Step 5: Commit** `jj commit -m "Resolve a project's start on its home: a revision, the fork point or the sync branch"`.

### Task 5: Create a task from its starts; drop trunk

**Files:**
- Modify: `src/state/host.ts` (`createTask`, `placeTask`, new `PeerObject.createTaskAt`), `src/state/contracts.ts`,
  `src/tasks/durable.ts` (`create`, remove `#startOf`), `src/tasks/provision.ts` (`provisionTask` takes `taskId` and
  `starts`), `src/projects/replicas.ts` (remove `refreshTrunk`, `trunkFor`, `HOME_TRUNK`), `src/projects/project.ts`,
  `src/git/serve.ts`, `src/cli.ts`, `src/help.ts`, `README.md`
- Test: `test/create-starts.test.ts`, `test/cli.test.ts`, `test/help.test.ts`, `test/placement-pool.test.ts`,
  `test/replicas.test.ts`, `test/provision.test.ts`, `test/jj.test.ts`

**Interfaces:**
- Consumes: `startAt`, `Start`, `fetchSync`, `fetchLines`, `releaseLines`, `taskHeld`.
- Produces: `NodeObject.createTask` input `{ title?, projects: Array<{ id: string; rev?: string; mode?: HandoffMode }>, prompt?, node? }`
  (replacing `projectIds`); `PeerObject.createTaskAt({ title, taskId, starts: Start[], prompt })`;
  `runner.create({ title, taskId, starts })`; the old `PeerObject.createTask` is removed.
- CLI: `task new [<prompt>] [--title <t>] [--project <id|name> [--rev <rev>] [--edit]]... [--node <id|prefix> | --here]`;
  `--rev` and `--edit` apply to the `--project` before them; `--rev` or `--edit` with no `--project` before it, or
  `--edit` without `--rev`, is a usage error (`meddle: --edit needs --rev`).

- [ ] **Step 1: Write the failing tests** (`test/create-starts.test.ts` on two pool nodes, A home of `a` and `b`
  homed on B, unless said):
  - a task of `a` and `b`, no revs, placed on B: `a` starts on a child of A's fork point, `b` on B's; both lines
    written on their homes; each workspace's config names its base;
  - B refuses `b`'s start (`@` has changes): `a`'s line on A is released, no task exists (Review Focus 3);
  - the creation's answer is lost and the target holds the task: the lines stay;
  - `--rev <one of a's sync branches>` with A offline: starts from the copy B fetched last, no line until its first turn end;
  - no rev with A offline: refused `home <short> is offline`;
  - a task with no projects starts as on main;
  - CLI: `--project a --rev X --edit --project b` sends `[{ id: a, rev: X, mode: "edit" }, { id: b }]`; the usage
    errors above; help and README show the new usage line and no "trunk".
  Replace every main test that asserted a trunk start with its fork-point or sync equivalent; delete tests of
  `refreshTrunk` and `trunkFor`.
- [ ] **Step 2: Run** `bun test test/create-starts.test.ts test/cli.test.ts test/help.test.ts test/placement-pool.test.ts test/replicas.test.ts test/provision.test.ts test/jj.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.** Port `CreationSent` and the release-or-ask flow from `wosklsmk:src/state/host.ts`.
  The target provisions each `line` start at its commit after `fetchLines(…, "home")` (on the home, the commit is
  already there), as `jj workspace add -r <commit>` then `jj edit <commit>` for edit, or a new change on it for
  child; each `sync` start from `fetchSync(…, branch)`, base its commit. README: replace the trunk sections ("A new task starts
  from the home's `trunk`", "Rebasing a task onto trunk", landing) with Decisions 4–6 and 9.
- [ ] **Step 4: Run** the same tests, then `grep -rni trunk src README.md` (expect no match), then `bun run typecheck`.
- [ ] **Step 5: Commit** `jj commit -m "Start each project of a task where its home says; drop trunk"`.

### Final

- [ ] Run the whole suite once (`bun test`) and `bun run typecheck`; dispatch the whole-branch review.
