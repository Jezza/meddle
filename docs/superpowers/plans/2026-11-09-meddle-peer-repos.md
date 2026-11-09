# Peer Repos Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Implementers run on Opus; every review (per task and whole branch) runs on Fable.

**Goal:** meddle becomes a git remote spread over the user's machines, with no machine in charge. Every ref position
has one writer, and shared branches are computed from per-node rows.

**Architecture:** Rows in pool sync carry where every line and branch points. Each node applies the rows:
- to its own service repo per project, where its tasks are jj workspaces;
- to a git namespace that checkouts fetch from and push to.

Commits are fetched by id from any peer. Branches are a multi-value register: heads of the live rows, minus drops.

**Tech Stack:** Bun, TypeScript, jj 0.45.1 (colocated git), git 2.47, chord over iroh (pool sync), Claude Agent SDK
hooks.

**Spec:** `docs/superpowers/specs/2026-11-09-meddle-peer-repos-design.md` (approved after three Fable reviews). Read
it before any task: section names below refer to it.

## Global Constraints

- Use jj, not git, for version control. Commit with `jj commit -m "<message>"`. No AI attribution in descriptions.
- Run only the test files each task names, plus `bun run typecheck`, until the Final step. `tsconfig` includes
  `test/`, so a task that removes a function also removes or rewrites every test importing it.
- meddle runs jj or git *in* a checkout (with the checkout as working directory or `-R`) only from the CLI process,
  inside `project add`, `checkout`, `task new` or `migrate` run by the user there. The service may *read* from a
  folder, for example with `git fetch <folder> …` run in the service repo. It never runs jj or git in one.
- A line or base ref is removed with `jj bookmark forget --include-remotes`. View-namespace refs, which jj never
  imports, are removed with `git update-ref -d`.
- No reference to trunk, sync branches, the home as an authority, leases, votes or clocks in new code or text.
- Error messages are exactly as the spec and this plan write them.

## Verified git/jj facts the tasks rely on

All on jj 0.45.1 and git 2.47.3, from Fable's scratchpads `fable2/` and `fable3/`.

- **A colocated service repo needs its HEAD moved off branches.** `jj git init --colocate` leaves HEAD pointing at an
  unborn `refs/heads/main`. git then refuses to fetch into it, and refuses pushes to the namespaced `main`. After
  `git symbolic-ref HEAD refs/jj/root`, both work. Receive-pack also gets `-c receive.denyCurrentBranch=ignore`.
- **The namespace goes on git itself:** `git --namespace=view upload-pack <dir>` (or `GIT_NAMESPACE=view`).
  `upload-pack --namespace` is an unknown option. `pre-receive` sees the stripped ref names and the spawn environment,
  and one refused ref rejects the whole push.
- **Fetch by id works over the connect helper** when the spawned `upload-pack` has `GIT_PROTOCOL=version=2`, even
  through the namespace.
- **A checkout needs `refs/namespaces/view/HEAD` to track.** With it set as a symref to the default branch, a
  `jj git clone` tracks and checks out `main`. Without it, `main@meddle` stays untracked and `jj git push -b main`
  fails.
- **Agent hooks:** the Agent SDK types `hooks` as `Partial<Record<HookEvent, HookCallbackMatcher[]>>`, with
  `PostToolUse` and a `matcher`.

## Review Focus

1. **A dropped row comes back after the dropper's next fast-forward**, because drops weren't carried. It must stay
   dropped until its writer writes a higher seq. Test in Task 2.
2. **An agent's `jj bookmark set main`** must never reach a checkout's fetch, and is put back by the applier. Test in
   Task 6.
3. **A push with one refused ref and one fine ref** is rejected whole, and jj reports it as rejected. Test in Task 5.
4. **The writer of a row goes offline** after only one peer fetched the commit. A third node gets the commit from that
   peer. Test in Task 4.
5. **No background activity touches a checkout:** a turn end, a row change or an applier pass leaves a checkout's
   `jj op log` and `.git/refs` unchanged. Test in Task 8.

---

### Task 1: Rows in pool sync

**Files:**
- Create: `src/pool/rows.ts`
- Modify: `src/store/db.ts` (tables `line_rows`, `branch_rows`), `src/state/contracts.ts` (`LineRowSchema`,
  `BranchRowSchema`, PoolObject peer state `lineRows` and `branchRows`), `src/pool/object.ts` (`servePool`: the cells,
  refreshed on `deps.changes`), `src/pool/sync.ts` (subscribe and merge the way `tokens` are),
  `test/pool-helpers.ts` (export a `threeNodes` helper built like `twoNodes`)
- Test: `test/rows.test.ts`, `test/sync.test.ts`

**Interfaces (produces, in `src/pool/rows.ts`):**
```ts
type RowRef = { node: string; seq: number };
type LineRow = { project: string; task: string; name: string; holder: string; epoch: number; seq: number;
  commit: string | null /* null: released */; base: string[]; archived: boolean };
type BranchRow = { project: string; branch: string; node: string; seq: number;
  commit: string | null /* null: deleted */; drops: RowRef[] };
mergeLineRows(db, rows: readonly LineRow[]): { changed: string[] /* project ids */; rejected: number };
mergeBranchRows(db, rows: readonly BranchRow[]): { changed: string[]; rejected: number };
listLineRows(db, project?: string, task?: string): LineRow[];
listBranchRows(db, project: string, branch?: string): BranchRow[];
writeLineRow(db, row: Omit<LineRow, "seq">): LineRow;
writeBranchRow(db, selfId: string, row: Omit<BranchRow, "seq" | "node">): BranchRow;
rowChanges: Subscribable<string /* project id */>;
```

**Rules:**
- **Line rows:** the greater `(epoch, seq)` wins.
- **Branch rows:** the greater `seq` wins. A tie settles on the greater content, as `mergeTokens` does.
- **seq on write:** `seq = max(stored seq, highest seq seen for the key) + 1` (spec, Rows).
- **Rejected rows:**
  - a commit that is not 40 or 64 hex characters;
  - a `task` failing `SAFE_ID`;
  - a branch name failing `git check-ref-format --branch`, or starting with `meddle/`;
  - a non-integer seq.

- [ ] **Step 1: Write the failing tests** (`rows.test.ts`):
  - in either arrival order, `(1,1)` beats `(0,5)` for lines, and seq 4 beats seq 3 for branches;
  - an equal key and seq settle on the same row on two databases;
  - each reject case is dropped and counted;
  - `writeBranchRow` after merging a peer's copy of its own row at seq 7 writes seq 8.

  `sync.test.ts`: with `threeNodes` linked a–b and b–c only, a branch row written on a reaches c.
- [ ] **Step 2: Run** `bun test test/rows.test.ts test/sync.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** the interfaces.
- [ ] **Step 4: Run** the same tests and `bun run typecheck`. Expect PASS.
- [ ] **Step 5: Commit** `jj commit -m "Carry line and branch rows in pool sync"`.

### Task 2: Computing branches, and what a push means

**Files:**
- Create: `src/projects/branches.ts`
- Test: `test/branches.test.ts`

**Interfaces (produces):**
```ts
type Graph = { isAncestor(a: string, b: string): Promise<boolean>; mergeBases(commits: string[]): Promise<string[]> };
type BranchState =
  | { kind: "absent" }
  | { kind: "single"; commit: string; live: RowRef[] }
  | { kind: "conflicted"; siblings: string[]; served: string | null; live: RowRef[] };
computeBranch(rows: readonly BranchRow[], g: Graph): Promise<BranchState>;
type PushedRef = { ref: string; old: string | null; new: string | null };
type BranchHeads = Array<{ branch: string; commits: string[] }>; // one commit if single, the siblings if conflicted
refusePush(pushed: PushedRef[], heads: BranchHeads, g: Graph): Promise<string | null>;
planPush(selfId: string, project: string, pushed: PushedRef[], rows: readonly BranchRow[], g: Graph):
  Promise<Array<Omit<BranchRow, "seq" | "node">>>;
```

**What they do:**
- `computeBranch` follows the spec's three steps. Drops apply whatever the dropping row's own state. `live` is the rows
  surviving step 2.
- `served` is the merge base with the smallest commit id, or `null` when the siblings share no history.
- `refusePush` returns the first refusal, or `null`:
  - `ref <ref> is not accepted here`, for a ref under `refs/heads/meddle/` other than a deletion of
    `refs/heads/meddle/conflict/<b>/<id>`, or any ref other than `refs/heads/*` and `refs/meddle/incoming/*`;
  - `<b> is conflicted; push a merge of its siblings, or delete the ones you don't want`, followed by one line per
    sibling `  meddle/conflict/<b>/<id>@meddle` and the line `  to keep your own work: jj bookmark set <b> -r <your commit>`.
- `planPush` assumes `refusePush` passed. It implements the spec's push table, the drop-of-a-sibling rules, carrying
  drops forward, and pruning `(n, s)` once a row from `n` with seq above `s` exists. `refs/meddle/incoming/*` records
  nothing.

- [ ] **Step 1: Write the failing tests** on a fake in-memory DAG `Graph`. One `test(…)` per scenario:
  - a fast-forward;
  - concurrent pushes give two siblings, served at their merge base;
  - a merge resolves it;
  - a rewind over a stale ancestor row;
  - a deletion;
  - a re-push of a dropped commit counts again;
  - dropping another node's sibling keeps your commit;
  - dropping your own sibling makes your row deleted;
  - a reviewer node with no row drops a sibling, and its row is created deleted;
  - a sibling held by two rows, one of them yours, is dropped as the union of both;
  - **Review Focus 1:** A drops `(B,3)`, then A fast-forwards. The branch stays single until B writes seq 4.
  - dropping a dropper doesn't resurrect what it dropped;
  - unrelated siblings give `served: null`;
  - both refusal texts, exactly.
- [ ] **Step 2: Run** `bun test test/branches.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** the interfaces.
- [ ] **Step 4: Run** the same tests and `bun run typecheck`. Expect PASS.
- [ ] **Step 5: Commit** `jj commit -m "Compute branches from rows, and plan what a push records"`.

### Task 3: Service repos, checkouts, default branch

**Files:**
- Create: `src/projects/checkouts.ts`
- Modify: `src/projects/project.ts` (`addProjectFromFolder`, `addProjectFromUpstream`, column `default_branch`),
  `src/store/db.ts`, `src/projects/replicas.ts` (`ensureReplica` → `ensureServiceRepo`), `src/projects/starts.ts`
  (no-`rev` default), `src/cli.ts` (`project add` runs `attachCheckout` in the CLI process; `checkout`;
  `project set-default`), `src/help.ts`, `README.md`, `test/helpers.ts` (`setupNode` sets bookmark `main` on its
  `init` commit before `addProjectFromFolder`, so its project has a default branch),
  `test/create-starts.test.ts` (its fork-point expectations become default-branch starts)
- Test: `test/checkouts.test.ts`, `test/projects.test.ts`, `test/starts.test.ts`, `test/create-starts.test.ts`,
  `test/cli.test.ts`, `test/help.test.ts`

**Interfaces (produces):**
- `Project.defaultBranch: string | null`, chosen as the spec's "Starting a task" says, and
  `setDefaultBranch(db, projectId, b)`.
- `ensureServiceRepo(deps, projectId): Promise<Project>` runs `jj git init --colocate`, then
  `git symbolic-ref HEAD refs/jj/root`. It never clones a peer.
- **The CLI's `project add`, before it calls the node:** makes the folder a colocated jj repo when it isn't a jj repo,
  or refuses `<folder> is a jj repo without a colocated git repo`.
- **`addProjectFromFolder`, run on the node:**
  1. checks the folder is a colocated jj repo, reading only;
  2. creates the service repo with `ensureServiceRepo`'s steps;
  3. runs `git fetch <folder> <default>:refs/heads/<default>`, then `jj git import`;
  4. writes the default branch's row with `writeBranchRow`.

  It never runs `attachCheckout`.
- **`addProjectFromUpstream`** does the same, fetching from the upstream URL.
- **In `src/projects/checkouts.ts`, run only by the CLI process:**
  - `attachCheckout(cfg, selfId, dir, project, env = process.env): Promise<void>`. It checks `git-remote-meddle` is
    on `env.PATH` (`Bun.which(…, { PATH })`), else refuses `git-remote-meddle is not on your PATH; add <data>/bin to it`.
    It then runs `git remote add meddle meddle://<selfId>/project/<id>` and `jj git fetch --remote meddle`, and tracks
    `<default>@meddle` when the default branch exists. Tests pass their own `env`.
  - `makeCheckout(cfg, selfId, project, dir?, env = process.env): Promise<string>` runs
    `jj git clone --colocate --remote meddle <url> <dir>`, and refuses `<dir> exists and is not empty`.
  - Until Task 5 serves the view, `attachCheckout`'s fetch and `makeCheckout` are exercised only by Task 5's tests.
    `project add` in this task's tests passes a flag that skips the fetch.
- **Starts:** `startAt` with `rev: null` now resolves the project's default branch bookmark in the service repo,
  refusing `<project> has no default branch; name a revision`. The fork-point-of-`@` path is deleted. `test/helpers.ts`
  and `test/starts.test.ts` are updated to match.
- **CLI:** `checkout <project> [<dir>]` and `project set-default <project> <branch>`, in help and README.

- [ ] **Step 1: Write the failing tests:**
  - `project add` of a folder with `main` and `wip`: `project.replica` is not the folder, the folder has no new
    workspace and has remote `meddle`, the service repo has bookmark `main` and not `wip`, its `@` is still on root,
    and a branch row for `main` exists;
  - a non-colocated jj folder is refused;
  - with `git-remote-meddle` off PATH, the exact refusal;
  - `project set-default p dev` persists;
  - `createTask` with no rev starts at `main`;
  - CLI usage lines in help.
- [ ] **Step 2: Run** `bun test test/checkouts.test.ts test/projects.test.ts test/starts.test.ts test/create-starts.test.ts test/cli.test.ts test/help.test.ts`.
  Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same tests and `bun run typecheck`. Expect PASS.
- [ ] **Step 5: Commit** `jj commit -m "Give each project a service repo, and checkouts attached to it"`.

### Task 4: The applier

**Files:**
- Create: `src/projects/applier.ts`
- Modify: `src/git/serve.ts` (`upload-pack` spawned with `GIT_PROTOCOL=version=2`), `src/state/contracts.ts` and
  `src/state/host.ts` (`PeerObject.rowsOf({ projectId }) → { lineRows, branchRows }`), `src/cli.ts` (serve starts the
  applier), `src/projects/replicas.ts` (every member keeps every project: `ensureServiceRepo` for each project in the
  roster)
- Test: `test/applier.test.ts`

**Interfaces (produces):**
- `applyProject(deps, projectId, budgetMs?: number): Promise<{ pending: string[] }>`. Under `repoKey(service)`, it:
  - fetches each missing commit a row names, with `git fetch <meddleUrl(peer)> <commit>:refs/meddle/fetched/<commit>`
    (the temp ref deleted after), trying the row's writer first, then each online member. With `budgetMs`, it stops
    fetching when the budget runs out, and what's left is `pending`.
  - sets the service repo's refs as the spec's "Applying rows" says, through `gitImport`. **One addition:** a line
    held by this node whose local bookmark `meddle/task/<t>/<name>` doesn't exist yet (between a start and its task's
    provisioning) gets `refs/remotes/meddle/task/<t>/<name>`, as a line held elsewhere does. jj can't see a commit no
    ref names. That remote ref is forgotten (`jj bookmark forget --include-remotes exact:task/<t>/<name>`) once the
    local bookmark exists; otherwise it would make the task's own head immutable.
  - resets each branch bookmark to `computeBranch(...).commit`, or to `served` when conflicted;
  - rewrites `refs/namespaces/view/refs/heads/*` with `git update-ref` from rows: branches, lines not `archived`, and
    conflict siblings named by 12-char id. It writes only refs whose commits are present, and sets
    `refs/namespaces/view/HEAD` as a symref to the default branch.
- `startApplier(deps): () => void` runs `applyProject` on each `rowChanges` and when a peer comes online, and retries
  projects with pending commits every 15 s.
- `catchUp(deps, projectId, budgetMs = 5000): Promise<void>` calls `rowsOf` on each reachable peer in parallel, merges
  what returns within the budget, then runs `applyProject` with the remaining budget.

- [ ] **Step 1: Write the failing tests** on three `poolNodes`:
  - a branch row written on n1 gives n2 and n3 the commit and the bookmark;
  - a line row held by n1 is `task/t/p@meddle` on n2, with base `base/t/p/0@meddle`;
  - on n1, a held line with no local bookmark is `task/t/p@meddle`, and the remote ref disappears once
    `meddle/task/t/p` is set;
  - **Review Focus 4:** n1 writes a row, n2 fetches, the test closes n1 itself and drops it from the list `close()`
    walks, and n3 gets the commit from n2;
  - the view namespace on n2 lists `refs/heads/main` and `refs/heads/meddle/task/t/p`, hides an archived line, and
    has `HEAD` → `refs/heads/main`;
  - a conflicted branch's view has `meddle/conflict/main/<id>` for both siblings, and `main` at the merge base;
  - a released line is forgotten, and its commit is still visible if a branch holds it;
  - `catchUp` returns within 6 s with one peer unreachable.
- [ ] **Step 2: Run** `bun test test/applier.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same tests and `bun run typecheck`. Expect PASS.
- [ ] **Step 5: Commit** `jj commit -m "Apply rows to service repos and the view namespace"`.

### Task 5: Serving checkouts: fetch and push

**Files:**
- Modify: `src/git/serve.ts`:
  - both services spawned as `git --namespace=view …`;
  - before `upload-pack`, `catchUp`;
  - `receive-pack` with `-c receive.denyCurrentBranch=ignore`, `core.hooksPath`, and env `MEDDLE_HEADS` (the
    `BranchHeads` JSON);
  - around `receive-pack`, under `repoKey(service)`, a snapshot of `refs/namespaces/view/` before and after. The
    difference is the pushed refs: it feeds `planPush`, then `writeBranchRow`s, then `applyProject`.
- Modify: `src/git/scripts.ts`. Remove the `update` hook. Add a `pre-receive` hook running `meddle git-pre-receive`.
  `hookReady` checks `pre-receive`.
- Create: `src/git/pre-receive.ts` (the `git-pre-receive` command, run through the meddle binary the way
  `git-remote-meddle` is), with its `dispatch` entry in `src/cli.ts`
- Test: `test/git.test.ts`, `test/checkouts.test.ts`

**Interfaces:**
- `meddle git-pre-receive` reads git's `old new ref` lines.
  - With `MEDDLE_REPO_KIND=memory`, it exits 1 with `ref <ref> is not accepted here` for any ref other than
    `refs/heads/memory`, else 0.
  - For a project, it calls `refusePush` with a `Graph` backed by `git merge-base --is-ancestor` in the quarantine,
    and exits 1 with the refusal on stderr, or 0.
- **Dropping a sibling:** conflict refs arrive untracked, and jj pushes deletions of tracked bookmarks only. So a
  sibling is dropped with `git push meddle :refs/heads/meddle/conflict/<b>/<id>`. The tests use that, and Task 13's
  help text says so.

- [ ] **Step 1: Write the failing tests** with jj in checkouts made by `makeCheckout`:
  - the clone tracks `main@meddle`;
  - `jj git push --remote meddle -b main` (a fast-forward) records a row, and a fetch in a checkout on another node
    shows it;
  - `jj git push --allow-backwards` of a rewind records drops, and the branch is at the rewind everywhere;
  - **Review Focus 3:** `main` (fine) together with `meddle/task/x/p` is rejected whole. jj says rejected, and `main`'s
    row is unchanged;
  - a non-descending push to a conflicted branch is refused with the exact text;
  - deleting `meddle/conflict/main/<id>` resolves the branch on every node;
  - a memory repo push still works;
  - `attachCheckout` on an existing folder tracks `main@meddle`.
- [ ] **Step 2: Run** `bun test test/git.test.ts test/checkouts.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same tests and `bun run typecheck`. Expect PASS.
- [ ] **Step 5: Commit** `jj commit -m "Serve checkouts a view namespace, gated by pre-receive"`.

### Task 6: Workspace scope and agent rules

**Files:**
- Modify: `src/tasks/provision.ts`. `workspaceImmutableHeads(taskId, base: string[])` returns
  `<present(c) for each base commit, joined by |> | (bookmarks() ~ bookmarks(glob:"meddle/task/<id>/*")) | untracked_remote_bookmarks(~glob:"task/<id>/*", remote=exact:"meddle")`.
  The last term leaves out the task's *own* `task/<id>/*@meddle`, which exists before provisioning and on a receiver
  before activation; without that, `jj edit R` is refused immutable (verified). Base refs, `base/<id>/…`, stay
  immutable.
- Modify: `src/projects/context.ts` (agent instructions), `src/tasks/durable.ts` (turn
  end calls `applyProject`), `test/create-starts.test.ts` and `test/durable.test.ts` (callers pass `[base]`)
- Test: `test/provision.test.ts`, `test/applier.test.ts`

**Base stays a string for now.** The manifest's `base` and `scopeWorkspace`'s parameter stay `string` until Task 7.
Callers wrap them as `[base]`.

**Exact text.** The agent's instructions gain, verbatim: "If jj says a commit is immutable, it isn't yours: leave it.
Never pass --ignore-immutable. Only set or delete bookmarks under meddle/task/<id>/. Never run jj undo or jj op
restore: the operation log is shared with other tasks."

- [ ] **Step 1: Write the failing tests:**
  - in a task workspace, `jj describe main` and `jj describe` of another local task's line head are both refused
    `immutable`. The task's own line head can be described, both with its local bookmark and with only its
    pre-provision `task/<id>/p@meddle` remote ref present;
  - **Review Focus 2:** the agent runs `jj bookmark set main -r @ --allow-backwards`. After turn end the service
    repo's `main` is back at its row, and the view's `main` never moved.
- [ ] **Step 2: Run** `bun test test/provision.test.ts test/applier.test.ts test/create-starts.test.ts test/durable.test.ts`.
  Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same tests and `bun run typecheck`. Expect PASS.
- [ ] **Step 5: Commit** `jj commit -m "Scope task workspaces to their own lines, and reset branches agents move"`.

### Task 7: Starts where the revision is

**Files:**
- Modify: `src/projects/starts.ts`. Rewrite `startAt` and `editable`. Remove `startOf`'s home path,
  `projectInfoOf`'s home checks, the `handoff:` lock, sync starts and every import from `lines.ts` except
  `linePrefix`.
- Modify: `src/tasks/manifest.ts` (`Start` = `{ projectId; mode; commit; base: string[] }`; the manifest's `base`
  becomes `string[]`, and a stored string reads as `[base]`), `src/tasks/provision.ts` (`scopeWorkspace` takes
  `string[]`), `src/state/contracts.ts` (remove `PeerObject.startAt` and `PeerObject.releaseLines`; `createTask`
  input gains `checkout?: string`), `src/state/host.ts` (their handlers; creation releases lines with
  `releaseLineRows`), `src/tasks/durable.ts` (`create`: line starts only; the sync-start branch goes),
  `src/cli.ts` (`task new` inside a checkout runs the checkout side below), `src/tasks/provision.ts`
  (`checkReceivedManifest` accepts a `base` array of commit ids, or a legacy single string), `src/help.ts`,
  `README.md`
- Test: `test/starts.test.ts`, `test/create-starts.test.ts`, `test/cli.test.ts`, `test/help.test.ts`

**Interfaces:**
- In `src/projects/lines.ts`, add:
  - `releaseLineRows(db, taskId, keep: string[]): void`, which writes released rows. The old `releaseLines` stays
    until Task 8.
  - `awaitLine(deps, projectId, taskId, name, timeoutMs): Promise<string>`, which resolves the commit once the row's
    commit is in the service repo, else rejects `line <t>/<n> is not here yet`.
- `durable.create` on the placed node uses `awaitLine` for each line start, where it called `fetchLines` before.
- `startAt(deps, { projectId, taskId, rev, mode, checkout }: { …; checkout: string | null }): Promise<Start>` runs on
  the node, in this order:
  1. It asks the service repo's jj `present(<commit>)`.
  2. A commit jj doesn't know yet, because it only sits in `refs/meddle/incoming/`, passes refusals 1–3: nothing in
     the service repo can hold it, sit on it or build on it. Refusal 4 was already checked by the CLI. A commit jj
     knows is checked against refusals 1–4 in the service repo and its workspaces.
  3. It writes the line row (`writeLineRow`, holder = self, epoch 0) and runs `applyProject`.
  - **Base:** in child mode, `base = [R]`. In edit mode, `base` is R's parents. For a commit jj doesn't know yet, the
    node reads the parents with git in the service repo: `git rev-list --parents -n 1 <c>`.
- **The checkout side, in the CLI process** (it's the user's command):
  1. resolves the revision in the checkout, or the fork point of the checkout's `@`
     (`heads(::@ ~ (empty() ~ merges()))`);
  2. checks refusals 1–4 there;
  3. when R's only child is the checkout's own `@` and `@` is empty, rebases `@` onto R's parents and prints
     `moved your empty @ off <R>`;
  4. runs `git push meddle <commit>:refs/meddle/incoming/<commit>`;
  5. calls `createTask` with `checkout` set;
  6. runs `jj git fetch --remote meddle`.
- **Without a checkout:** the default branch, refused `<b> is conflicted; push a merge of its siblings` while
  conflicted.
- **Until Task 8,** the old turn-end line push stays in place alongside the new start rows.

- [ ] **Step 1: Write the failing tests:**
  - a child start from a checkout at P: P is immutable in the checkout when the command returns;
  - `--edit W` with `@` an empty child of W: `@` is rebased, and the start's base is W's parents;
  - `--edit W` with `@` non-empty on W: refusal 2, naming the checkout's workspace;
  - W with another child: refusal 3;
  - a conflicted default branch is refused with the exact text;
  - two projects where the second refuses: the first's line row is released;
  - the task placed on n2 takes the lines with epoch 1;
  - `PeerObject` has no `startAt` (contract test).
- [ ] **Step 2: Run** `bun test test/starts.test.ts test/create-starts.test.ts test/cli.test.ts test/help.test.ts`.
  Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same tests, then `grep -rn "handoff:" src` (expect no match), then `bun run typecheck`.
- [ ] **Step 5: Commit** `jj commit -m "Resolve a task's start where its revision is"`.

### Task 8: Lines as rows

**Files:**
- Modify: `src/projects/lines.ts`. Keep `LINE_REMOTE`, `linePrefix`, `releaseLineRows` and `awaitLine`. Remove `writeLine`,
  `writeLines`, `pushLines`, `holdLines`, `fetchLines`, `releaseOnHome`, `giveBackLines`, `homeLines`,
  `releaseGoneLines`, `noteStarting`, `whereIs` and the old `releaseLines`.
- Modify: `src/tasks/durable.ts`: `finishTurnPhase`, `pushTaskLines`, `#pushLinesOf`, `#pushAgain`, `#watchHomes`,
  `#unpushed`, `setHandoffBookmarks`, `receiveTask`, `#fetchLine`, `archive`, `restoreHere`, `deleteTask`. Every
  caller is rewritten here in its simplest correct form; Task 10 refines moves.
- Modify: `src/engine/options.ts` (a `PostToolUse` hook with matcher `Edit|Write|Bash` calling a new
  `EngineInput.onFilesChanged`), `src/engine/session.ts` (pass it), `src/cli.ts` (drop the janitor)
- Remove the tests of removed functions from: `test/git.test.ts`, `test/jj.test.ts`, `test/replicas.test.ts`,
  `test/provision.test.ts`, `test/lines.test.ts`
- Test: `test/lines.test.ts`, `test/durable.test.ts`, `test/move.test.ts`, `test/archive.test.ts`

**Interfaces (produces, in `src/projects/lines.ts`):**
- `writeLineRows(deps, manifest): Promise<void>`. It snapshots each workspace, sets the task's bookmarks, writes one
  row per bookmark under `meddle/task/<id>/`, and releases the ones the agent deleted (the project's own line is
  kept).
- **Timing:** `PostToolUse` writes are debounced 5 s per task. Turn end flushes the debounce, then writes once more.

- [ ] **Step 1: Write the failing tests:**
  - a turn end on n1 makes `task/t/p@meddle` appear in a checkout fetch on n2;
  - an Edit tool call mid-turn moves the line within 6 s;
  - a deleted side bookmark is released on n2;
  - archive and delete work with every other node offline;
  - **Review Focus 5:** after a turn end and an applier pass, a checkout's `jj op log -T id` and `git show-ref` are
    byte-identical to before.
- [ ] **Step 2: Run** `bun test test/lines.test.ts test/durable.test.ts test/move.test.ts test/archive.test.ts test/git.test.ts test/jj.test.ts test/replicas.test.ts test/provision.test.ts`.
  Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same tests, then `grep -rn "pushLines\|holdLines\|fetchLines\|releaseOnHome\|#unpushed" src test`
  (expect no match), then `bun run typecheck`.
- [ ] **Step 5: Commit** `jj commit -m "Write a task's lines as rows as it works"`.

### Task 9: Remove sync branches

**Files:**
- Modify: `src/projects/project.ts` (drop `sync`, `upstream`, `setProjectSync`, `checkSyncNames`),
  `src/projects/replicas.ts` (drop `fetchSync`, `fetchFromUpstream`), `src/git/serve.ts` (the upstream fetch),
  `src/state/contracts.ts` (`ProjectSchema`, `ProjectInfoSchema`, `setProjectSync`), `src/state/host.ts`,
  `src/pool/store.ts` (`NodeProject`), `src/pool/projects.ts`, `src/dashboard/ui/Projects.tsx`, `src/cli.ts`
  (`project sync`), `src/help.ts`, `README.md`, `test/pool-helpers.ts` (`poolSummaryOf`)
- Before starting, grep for every user:
  `grep -rln "\.sync\b\|upstream\b\|fetchSync\|setProjectSync\|checkSyncNames" src test`
- Test: every file that grep lists, plus `test/help.test.ts`

- [ ] **Step 1: Write the failing test:** help and README contain no "sync branch", and `meddle project sync` is an
  unknown command.
- [ ] **Step 2: Run** `bun test test/help.test.ts test/cli.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.** Update or delete the tests that used `sync` or `upstream`.
- [ ] **Step 4: Run** the grep's test files, then `grep -rni "sync branch\|fetchSync" src` (expect no match), then
  `bun run typecheck`.
- [ ] **Step 5: Commit** `jj commit -m "Drop sync branches"`.

### Task 10: Moves, restores and epochs

**Files:**
- Modify: `src/tasks/move.ts`, `src/tasks/durable.ts`:
  - `receiveTask` takes the sender's rows and merges them before `awaitLine`;
  - activation writes `epoch + 1`;
  - rollback has the sender write `epoch + 2`;
  - an abandoned receive writes no rows.
- Modify: `src/state/contracts.ts` (the move request carries `lineRows`)
- Test: `test/move.test.ts`, `test/move-e2e.test.ts`, `test/archive.test.ts`

- [ ] **Step 1: Write the failing tests:**
  - n1→n2 gives epoch 1 only after activation;
  - an activation refused at n2 rolls back with n1 at epoch 2, and n1's next turn end wins;
  - a late n1 write at epoch 0 after the move changes no node's line;
  - restoring on n3 a task archived on n1 gives n3 the next epoch.
- [ ] **Step 2: Run** `bun test test/move.test.ts test/move-e2e.test.ts test/archive.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same tests and `bun run typecheck`. Expect PASS.
- [ ] **Step 5: Commit** `jj commit -m "Hand lines over by epoch at activation"`.

### Task 11: Accepting by push

**Files:**
- Create: `src/tasks/accept.ts`
- Modify: `src/tasks/durable.ts` (re-check on `rowChanges` and after each `writeLineRows`; archive when idle, or at
  turn end), `src/dashboard/ui/Task.tsx` (show "partly accepted")
- Test: `test/accept.test.ts`

**Interfaces (produces):** `acceptance(deps, manifest): Promise<"accepted" | "partly" | "no">`. It is "accepted"
when, for every project, some branch in the `single` state has that project's line head as an ancestor. A conflicted
branch counts for nothing.

- [ ] **Step 1: Write the failing tests:**
  - a push of `main` onto an idle task's line archives the task, and its lines are released on every node;
  - the same push mid-turn archives the task at turn end;
  - a two-project task with one project pushed shows "partly", and stays live;
  - a conflicted branch containing the line archives nothing.
- [ ] **Step 2: Run** `bun test test/accept.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same tests and `bun run typecheck`. Expect PASS.
- [ ] **Step 5: Commit** `jj commit -m "Archive a task once a pushed branch contains its work"`.

### Task 12: Upgrade and `meddle migrate`

**Files:**
- Create: `src/projects/migrate.ts`
- Modify: `src/cli.ts` (the `migrate` command; serve start runs `upgradeNode`, then lists unmigrated folders),
  `src/state/contracts.ts` and `src/state/host.ts` (`NodeObject.migrateProject`; refuse new tasks on unmigrated
  projects), `src/tasks/durable.ts` (reserve tasks, the way `archive` does)
- Test: `test/migrate.test.ts`

**Interfaces:**
- `upgradeNode(deps): Promise<void>` is idempotent and runs at serve start. It:
  - writes a line row for every bookmark of every task this node holds, idle ones included, where none exists;
  - for each project with no `default_branch`, sets it (`main`, else `master` in the service repo; a url project's
    upstream HEAD via `git ls-remote --symref`) and, on the project's home, writes that branch's row;
  - logs once per ref `meddle: legacy line <ref> left in <repo>`, for each line ref with no row.
- **The service side,** `NodeObject.migrateProject({ projectId }) → { workspaces: string[]; untrackedLost: Record<string, string[]> }`.
  On the node, it:
  1. reserves the project's tasks and waits for their turns to end;
  2. builds the service repo from the folder (reading only);
  3. moves each task folder aside, re-adds its workspace in the service repo at the same commit, and copies
     untracked files back;
  4. writes the rows;
  5. sets `project.replica` to the service repo;
  6. answers with the old workspace names.
- **The CLI side,** `meddle migrate` run in the folder, calls it, then:
  1. runs `jj workspace forget --ignore-working-copy <names>` in the folder;
  2. runs `attachCheckout`;
  3. prints what `untrackedLost` lists.
- A project is unmigrated when `project.replica` is its folder. The refusal is
  `<project> needs meddle migrate, run in <folder>`.

- [ ] **Step 1: Write the failing tests.** Build the legacy layout with `insertProject` with `replica: folder`, then
  `provisionTask`. Then:
  - migration moves the live task: it runs a turn in its new workspace, and the folder's `jj workspace list` shows
    only `default`;
  - a task mid-turn delays the migration until its turn ends;
  - running it again changes nothing;
  - before migration a new task is refused with the exact text;
  - `upgradeNode` writes rows for an idle task, and sets `default_branch`.
- [ ] **Step 2: Run** `bun test test/migrate.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same tests and `bun run typecheck`. Expect PASS.
- [ ] **Step 5: Commit** `jj commit -m "Upgrade nodes and migrate folder projects onto service repos"`.

### Task 13: Docs, status and conflicts in the dashboard

**Files:**
- Modify: `README.md`, `docs/user-guide.md`, `src/help.ts`, `src/cli.ts` (`project status <project>`: each branch,
  its state, siblings, and the fix text from `refusePush`), `src/dashboard/ui/Projects.tsx` (a conflicted branch shows
  its siblings)
- Test: `test/help.test.ts`, `test/cli.test.ts`, `test/ui.test.ts`

- [ ] **Step 1: Write the failing tests:**
  - `project status` on a conflicted branch prints each sibling as `meddle/conflict/<b>/<id>@meddle` and the
    `jj bookmark set` hint;
  - help documents `checkout`, `migrate`, `project set-default` and `project status`. It also says that a sibling is
    dropped with `git push meddle :refs/heads/meddle/conflict/<b>/<id>`, and that tracking a conflict ref makes it
    mutable.
  - the projects page model marks a conflicted branch.
- [ ] **Step 2: Run** `bun test test/help.test.ts test/cli.test.ts test/ui.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.** Rewrite the README's repo, task and starts sections from the spec.
- [ ] **Step 4: Run** the same tests and `bun run typecheck`. Expect PASS.
- [ ] **Step 5: Commit** `jj commit -m "Document peer repos, checkouts and branch conflicts"`.

### Final

- [ ] Run `bun test` and `bun run typecheck` once.
- [ ] Dispatch the whole-branch review on Fable.
