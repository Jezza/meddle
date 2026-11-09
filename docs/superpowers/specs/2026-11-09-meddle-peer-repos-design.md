# Peer Repos: Design

Settled with the user on 2026-11-09. This replaces the home-as-authority model of
`docs/superpowers/plans/2026-11-06-meddle-task-starts.md`. The draft plan
`docs/superpowers/plans/2026-11-09-meddle-peer-repos.md` was written before this design and is superseded by it.

Statements marked **(my call)** were decided by the writer, not the user; the user should check them.

## Intent

You want to work with your agents from any machine you happen to be on. That means reviewing their work, handing
them revisions, accepting what they did, and moving your branches. No machine in the pool is special, and none has to
stay on.

Today a project's home is in charge. Starts are resolved on the home, lines live on the home, and the home's folder
*is* the project's repo, so tasks on the home are workspaces inside your own folder. That ties everything to one
machine, and it mixes meddle's working state into your checkout.

The new model treats meddle as **a git remote spread over your machines**:
- You push to it and fetch from it from any checkout.
- Every ref position has exactly one writer. A task writes its lines, and a node writes its own record of each branch
  pushed to it.
- What a shared branch points at isn't stored anywhere. Every node *computes* it from all the nodes' records, and gets
  the same answer.
- Behaviour should **emerge** from these rules, not from explicit coordination commands.

## Goals

1. **Review from any machine.** Any machine running meddle can have checkouts of any project.
2. **No machine is in charge, and none needs to be on.** Creating tasks, pushing, fetching and reviewing all work with
   whatever is reachable. Nothing ever waits for a vote, a lease or a particular machine.
3. **Your checkout is yours.** meddle changes a checkout only during a meddle command you run in it. It never adds
   workspaces to it, never snapshots it in the background, and never writes refs into it behind your back.
4. **One writer per ref position**, so a line never conflicts.
5. **Shared branches behave like git day to day:** a push that isn't a fast-forward is refused. Pushes that overlap
   while machines can't see each other are never lost. They show up as a conflict you resolve with an ordinary push.
6. **Agents can build on each other's work** by merging another task's line. Doing so never rewrites the other task's
   commits.
7. **Nothing is lost silently.**

## Non-goals

- Preventing conflicts on shared branches. Without an always-on machine that can't be done, so conflicts are allowed
  but always visible.
- Consensus, leases, votes or clocks.
- Automatic merging. meddle never makes a merge commit you didn't ask for.
- Syncing with the project's upstream (GitHub and the like). That's yours to do, from a checkout.
- Live updates pushed into checkouts. You see new work when you fetch.

## Anti-goals (failure even if it "works")

- A push reports success and its commit is later lost without a trace.
- meddle rewrites or moves your working copy, or leaves it stale.
- An agent rewrites commits that aren't its own.
- A push or a task start is blocked because some other machine is off.
- Explicit coordination commands ("take", "accept", "claim") for things that should follow from how the system works.

## Vocabulary

- **Node:** a machine running meddle's service, a member of the pool.
- **Service repo:** a node's own colocated jj repo for a project. That node's tasks are jj workspaces in it. You never
  work in it directly.
- **Checkout:** your own jj repo of a project, with a git remote named `meddle` pointing at the node on that machine.
- **Line:** a task's bookmark for one project, `meddle/task/<task>/<name>`. `<name>` is the project name or a side
  bookmark `<project>.<label>`.
- **Branch:** any other bookmark pushed to meddle (`main`, `feature-x`).
- **Row:** a record in pool sync of where one ref points, written by its single writer.

## Repos

### Service repos

- Every node keeps a service repo for every project of the pool, at `paths(cfg).replica(id)`, and applies all its
  rows. That includes the node where the project was added: your folder is no longer the repo.
- **(my call)** Every node keeps every project. Pools are a handful of personal machines, so the disk cost is
  acceptable, and in return a task's work outlives the machine it ran on.
- "Home" only means where the project was added and its id minted.

### Tasks are workspaces

- Every task on a node is a jj workspace in that node's service repo, as today.
- **(my call)** Each task's workspace keeps its own `immutable_heads()` in its jj config, as built in 2026-11-06
  (`scopeWorkspace` / `unscopeWorkspace`, cleaned up with the workspace). Inside a shared repo, that setting is what
  stops an agent rewriting:
  - its base and everything below it;
  - other tasks' lines;
  - branches.
- **The alias** is
  `present(<base>) | (bookmarks() ~ bookmarks(glob:"meddle/task/<id>/*")) | untracked_remote_bookmarks(~glob:"task/<id>/*", remote=exact:"meddle")`.
  The task's own `task/<id>/*@meddle`, which exists before provisioning and on a receiver before activation, is left
  out.
  jj's default protects only untracked remote bookmarks, and here branches and this node's other tasks' lines are local
  bookmarks. Negative patterns work in jj 0.45.1.
- **Agents can still *move* bookmarks,** because immutability doesn't stop that. So:
  - a branch's row is never read from the service repo's bookmarks;
  - the applier puts the service repo's branch bookmarks back to their computed position after every turn end and
    every row change.
- The agent's instructions forbid `jj undo` / `jj op restore`, because jj's operation log is shared by every workspace
  of the repo.

### Checkouts

- **One routine, two ways in.** `meddle project add <folder>` and `meddle checkout <project> [<dir>]` share one routine,
  `attachCheckout(dir, project)`. It adds the remote `meddle` (`meddle://<this node>/project/<id>`, served by the
  existing `git-remote-meddle` helper) and fetches. The only difference is where the repo comes from:
  - `project add` creates the project and builds the service repo *from* your folder. The folder must be a colocated
    jj repo, or not a jj repo at all, in which case it is made one.
  - `checkout` clones the folder *from* the node's service repo, into `<dir>` (default `./<project name>`).
- **Registration:** checkouts aren't registered. Any repo with a `meddle` remote works.
- **The helper on your PATH.** git finds the helper by name, so `git-remote-meddle` must be on your PATH for a
  `jj git fetch` you type yourself. `attachCheckout` checks that it is, and refuses with
  `git-remote-meddle is not on your PATH; add <data>/bin to it` if not.
- **Fetching** (`jj git fetch --remote meddle`, which prunes deleted refs by default) shows:
  - every branch at its computed position (see Branches);
  - every live task line, as `meddle/task/<t>/<name>@meddle`. Untracked, so jj won't let you rewrite it.
  - the siblings of any conflicted branch, as `meddle/conflict/<b>/<id>@meddle`.
- **Pushing** (`jj git push --remote meddle`) records branches. Pushing under `meddle/` is refused, with two
  exceptions:
  - deleting a `meddle/conflict/…` ref, which drops that sibling;
  - `refs/meddle/incoming/*`, which `meddle task new` uses.
- **Getting your work to tasks:** your changes reach tasks only when you push them.

### What meddle does in a checkout

meddle runs jj or git in a checkout only during a meddle command you ran in it (`meddle project add`,
`meddle checkout`, `meddle task new` from inside it). Those commands may snapshot, as any jj command you type does.
Nothing touches a checkout in the background.

## Rows

Ref positions travel as **rows** in pool sync, next to the roster, settings and tokens it already carries
(`src/pool/sync.ts`).
- **One writer per row,** with a sequence number only that writer increments.
- **Each write uses `max(own seq, highest seq seen for this key) + 1`.** That way a node that lost its data but kept
  its id can never write rows that lose to its own older ones.
- **Rows are relayed by every node,** so a machine that was asleep catches up from whoever it reaches first.
- **Commits travel separately.** A node fetches a commit a row names, by id, from any member that has it, the writer
  first. The spawned `upload-pack` gets `GIT_PROTOCOL=version=2`, under which any object can be fetched by id
  (verified).
- **Two kinds of row:**

| Kind | Key | Value | Written by |
|---|---|---|---|
| Line | (project, task, name) | holder, epoch, seq, commit or released, base commits | the task's holder |
| Branch | (project, branch, node) | seq, commit or deleted, drops: the `(node, seq)` rows it replaced | that node |

- **Applying rows to a service repo:**
  - A line held by this node is its task's local bookmark, which the task writes.
  - A line held elsewhere becomes `refs/remotes/meddle/task/<t>/<name>`, untracked.
  - A line's base commits become `refs/remotes/meddle/base/<t>/<name>/<i>`, untracked.
  - A branch becomes a local bookmark at its computed position, so agents can read and rebase onto it.
  - Released refs are removed with `jj bookmark forget --include-remotes`, never by deleting the git ref. Deleting the
    ref makes jj abandon commits that only it kept.
- **The git view served to checkouts** is a git namespace that only the node writes, `refs/namespaces/view/`:
  - it is served with `git upload-pack --namespace view` and received with `git receive-pack --namespace view`;
  - jj in the service repo never imports it, so an agent's bookmark move never reaches a checkout (verified);
  - the node writes it from rows. It shows branches as `refs/heads/<b>`, lines as
    `refs/heads/meddle/task/<t>/<name>` and siblings as `refs/heads/meddle/conflict/<b>/<id>`.
  - It only shows refs whose commits this node already has.
  - **(my call)** A fetch first catches the node up on that project with every reachable peer, so a fetch is as current
    as whatever you can reach. The catch-up is bounded to 5 s in all; a fetch never waits longer for a slow peer.

## Branches (emergent shared branches)

### Pushing

A checkout pushes to the node on its machine, into the view namespace.

**The gate.** A `pre-receive` hook checks the push. It sees every ref of the push, runs before anything lands, and a
non-zero exit rejects the whole push with a clean `pre-receive hook declined` report (verified with jj). The node
passes the branches' computed positions into the hook's environment when it spawns `receive-pack`, so the hook needs
no call back to the node. The hook refuses the push when any ref is under `meddle/`, other than the two exceptions
above. `reference-transaction` can't serve as this gate: without `--atomic`, which jj never sends, it aborts per ref.
In testing that left a push half applied and misreported.

**What a push means.** Servers never see whether a push was forced; that is enforced by the client alone. But both
clients already make you do something explicit to send a non-fast-forward (git `--force`, jj `--allow-backwards`).
So the meaning comes from the commit graph:

Every row a node writes carries forward the `drops` its previous row had. In the table, "the drops it carried" means
those. "Every current row" means every row that survives step 2 of the computation below, not only the heads.

| You push | It counts as | What it records |
|---|---|---|
| A commit descending from the branch's single computed position | A fast-forward | Your node's row: that commit, plus the drops it carried |
| A commit not descending from it (a rewind or sideways move) | A forced push | The commit, plus the drops it carried, plus every current row of the branch |
| A deletion of the branch | A forced push | Deleted, plus the drops it carried, plus every current row |
| On a conflicted branch: a commit descending from *every* sibling | A fast-forward, which resolves it | The commit, plus the drops it carried |
| On a conflicted branch: a commit not descending from every sibling | Refused | `<b> is conflicted; push a merge of its siblings, or delete the ones you don't want` |
| A deletion of `meddle/conflict/<b>/<id>` | A drop of that sibling | See below |

**A drop of a sibling** adds every row at that sibling's commit to your row's drops, your own row included if it is
one of them. What your row then holds:
- **Your row isn't at that commit:** it keeps its current commit. If you have no row yet, which is normal for a
  machine that only reviews, it is created deleted.
- **Your row is at that commit:** it becomes deleted.

**Pruning drops:** a node may remove the drop `(n, s)` from its row once it has seen a row from `n` with a seq above
`s`. That row supersedes the dropped one anyway.

**Recording it.** Once the push lands, which `serve.ts` already waits for, the node writes its own branch rows with
`seq + 1`.

Pushes never wait for any other machine. A push made offline is accepted by your own node, and tasks there see it at
once.

### Computing a branch's position

For branch `b`, a node computes:
1. Take every node's row for `b`.
2. Remove the rows that are deleted, and the rows some other row drops. **Drops name rows,** `(node, seq)`, not
   commits, so re-pushing a commit that was once dropped makes a fresh row that counts again. A row's drops apply
   whatever that row's own state is, even if it is itself deleted or dropped.
3. The branch is the heads of the remaining rows' commits.

Every node computes the same answer once it has the same rows. A rewind works: the forced row drops the rows above it,
so its own commit is the only head left.

| Commits left | Branch state |
|---|---|
| None, because every row is deleted or dropped | The branch doesn't exist |
| One | That's the branch |
| Several | The branch is **conflicted**, and these are its siblings |

**(my call)** While a branch is conflicted, the git view serves:
- each sibling as `meddle/conflict/<b>/<id>`, named by its 12-character commit id. A name never points at a different
  commit, so deleting one from a stale fetch can't drop the wrong side.
- the branch itself at the **merge base** of the siblings: the head of their common ancestry, or, if there are
  several, the one with the smallest commit id.

That position is computed from rows like everything else, so every node serves the same `main`.

Why the branch can't simply disappear while conflicted: jj deletes a tracked bookmark whose remote vanished, and
abandons the commits nothing else holds (verified). Moving the branch back to the merge base is safe because the
conflict refs keep the siblings visible.
- **Siblings with no common ancestor** (unrelated histories): the branch itself isn't served until it's resolved. The
  conflict refs still hold the siblings, so nothing is abandoned.
- **If your checkout's local `main` had unpushed work on a sibling:** jj makes your `main` conflicted when it fetches
  the merge base. Every conflict message and `meddle project status` include the fix:
  `jj bookmark set <b> -r <your commit>`, then push a merge of it with each sibling. The message names the siblings
  (`meddle/conflict/<b>/<id>@meddle`), so the merge can be typed from the message alone.

**Side effect of every forced change:** dropping a sibling, rewinding a branch and deleting a branch can all make jj
abandon commits in checkouts. That happens to commits that only the old position held; jj reports it, and `jj op log`
recovers it.

**Tracking a conflict ref** with `jj bookmark track` makes that sibling mutable in your checkout until you push its
deletion. The help text says so.

The dashboard and `meddle project status` show the conflict. Starting a task from a conflicted branch is refused:
`<b> is conflicted; push a merge of its siblings`.

### What emerges

| You do | What happens everywhere |
|---|---|
| Push a fast-forward | Every node computes the new position |
| Push while offline | Your node has it at once, and the others when you reconnect |
| Push concurrently from two machines that can't see each other | Both commits are kept, and the branch is conflicted everywhere |
| Push a merge of the siblings | It descends from both, so it's the only commit left: resolved everywhere |
| Delete the conflict ref of the side you don't want | That sibling is dropped: resolved everywhere |
| Rewind a branch (`--allow-backwards`) | The newer rows are dropped: the branch is at your commit everywhere |
| Push a branch onto a task's line | The task's work is accepted (below) |

## Tasks

### Lines have one writer

- A task's lines are written only by the node holding the task.
- **(my call)** The line moves as the agent works, not only at turn end. meddle snapshots the task's workspace and
  writes the line rows after the agent's file-changing tool calls: Claude Code's `PostToolUse` hook for Edit, Write
  and Bash, debounced to 5 s. At turn end it writes them once more. The workspace is meddle's own, so snapshotting it
  is fine.
- A side bookmark the agent deleted is released; the project's own line is always kept.

### Moves

A move hands a task between two online nodes, as today.
1. The sender writes its final rows and sends them with the move request.
2. The receiver merges those rows, fetches the commits and provisions the task.
3. When the move activates, the receiver writes the rows with `epoch + 1` as the new holder. That is not done at
   receive, because a move can still roll back.

- **Rollback:** if the move rolls back, the sender writes its rows with an epoch above any the receiver could have
  written, and an abandoned receive writes no rows.
- **Stale rows:** the sender's rows travel with the request, so the receiver never provisions from a stale row.
- **Late writes:** a late write from the former holder has a lower epoch and loses.
- **Restore:** restoring an archived task on another node works the same way.

### Starting a task

A start is resolved where the revision is, on the node you asked. No other node is involved.

**From inside a checkout** (`meddle task new …` run in it):
- **The revision:** the given revision of the checkout, or by default the fork point of the checkout's `@`, as
  `startAt` reads it today.
- **Getting it to meddle:** the command pushes that commit to its node (`git push meddle <commit>:refs/meddle/incoming/<commit>`).
  The node writes the line row, and the command fetches it back into the checkout. The revision is therefore
  immutable on your side before the command returns.

**From anywhere else** (the dashboard, another directory):
- a revision the node's service repo has;
- or by default the project's default branch. **(my call)** That is the folder's `main`, else `master`, at
  `project add`, or the upstream's HEAD branch for a url project, changeable with `meddle project set-default`.

**Modes:**
- **`child`** (default) is `jj new R`, with base `[R]`.
- **`edit`** is `jj edit R`, with base = R's parents.

**Edit refusals, in this order.** They stay because without them your checkout would show divergent changes once the
agent rewrites R. They are checked against the checkout *and* the node's service repo, including its workspaces.
1. `<R> is immutable`;
2. `<R> is <workspace>'s working copy; move off it first`, for any workspace, including the checkout's own `@`;
3. `<R> has revisions on top of it`;
4. `nothing to hand off: <R> has no changes`.

**(my call)** In a checkout, `@` is usually an empty change on top of R, which would trip refusal 3 on almost every
`--edit`. When R's only child is the checkout's own `@`, and `@` is empty, the command (which you ran) rebases `@` onto
R's parents and says so. That is what you'd do yourself, and it loses nothing.

**Child refusal:** `cannot start a task on the root commit`.

**Multi-project tasks:** each project's start is resolved the same way. If one start fails, the earlier starts' lines
are released. When the task is placed on another node, that node fetches the commits and takes over the lines with
`epoch + 1`.

### Using another task's work

An agent merges another task's line into its own. The other task's commits arrive as an untracked remote ref, so they
can't be rewritten; they can only be built on. The other task carries on unaffected.

### Accepting a task's work emerges from a push

1. You ask the agent to rebase onto your branch. For a multi-project task, it rebases each project's line onto that
   project's branch.
2. You review its work.
3. You fast-forward your branch onto the line and push.

When a branch's computed position contains a live task's line head, for every project of the task, the task's work
is accepted.
- The task holder re-checks this after every row change and at every line write.
- A task that is idle and still contained is archived, with its lines released.
- A task mid-turn is archived when its turn ends, if it is still contained then.

**(my call)** A branch containing only some of a task's projects' lines archives nothing. The dashboard shows the task
as partly accepted.

**A conflicted branch accepts nothing until it's resolved.** Otherwise the task's lines could be released because of
a sibling that is later dropped, and the dropped sibling would be the only ref still holding the work.

### Lines after archive and delete **(my call)**

| Event | What happens to the lines |
|---|---|
| Archive (by acceptance or by hand) | Released when accepted. Kept, held by the archiving node, when you archive by hand, and left out of the git view served to checkouts. |
| Restore on another node | Handled like a move |
| Delete | Released |

### Stranded tasks **(my call)**

Nothing in this design takes a task's lines away from it, so "stranded" only arises when a task's node is removed from
the pool while holding it. Its lines' last rows stay, so the work isn't lost, and you can start a new task from them.
No stranded state is built in this round.

## Projects

- **Url projects.** **(my call)** The service repo is cloned from the upstream once, by the node that adds the
  project. After that, upstream changes come in when you fetch them in a checkout and push them to meddle.
- **Memory repos** are unchanged.

## Removed by this design

- Starts resolved only on the home: `PeerObject.startAt` and the `handoff:` lock.
- Lines pushed to the home, the update hook's line case, `#unpushed` / `#pushAgain`.
- Sync branches, `fetchSync`, and the upstream fetch inside `serve.ts`.
- The `no fork point` / `<n> fork points` edit refusals.
- Your folder as the project's repo, and task workspaces inside it.

## Migration

An existing install upgrades in place.
- **A folder project whose repo is the folder:**
  - **(my call)** It is migrated by a command you run inside the folder, `meddle migrate`, because migrating touches
    the folder. It changes only the folder it was run in.
  - Until you do, `meddle serve` lists the folders still to migrate, and refuses new tasks on those projects with
    `<project> needs meddle migrate, run in <folder>`. There is no second code path for unmigrated projects.
  - It waits until none of the project's tasks is mid-turn, because an agent's process has its working directory
    inside the workspace being moved. It then reserves those tasks, the way archiving does, so no queued prompt can
    start a turn before the move finishes.
  - `meddle migrate`, for the folder's project:
    1. Builds a service repo from the folder, then attaches the folder (`attachCheckout`).
    2. Moves each live task into the service repo: it moves the old task folder aside, re-adds the workspace at the
       same commit (`jj workspace add` refuses a non-empty folder), then copies untracked files back or logs them.
    3. Forgets the moved tasks' workspaces from the folder's repo.
- **Rows:**
  - Every node writes rows for the lines of tasks it holds.
  - The adding node writes a branch row for each project's default branch.
- **Legacy line refs:** a legacy line ref with no row is left in place and logged.

## Left to the builder

- Row and table layout, and how sync carries the rows (the way it carries tokens).
- How the applier batches and retries fetches.
- Dashboard presentation of conflicts, and of partly accepted tasks.
- Exact CLI help text, within the commands and messages named here.

## Evidence

All on jj 0.45.1 and git 2.47.3, 2026-11-09. Scripts are in the session scratchpad.

**This session's experiments:**
- A merge commit resolves a tracked bookmark conflict on every repo, including one that was offline.
- The same move arriving by two paths is idempotent.
- Picking a side resolves only locally. That is why `drops` exists.
- `reference-transaction` fires for `receive-pack`, `fetch` and `update-ref`, but not for jj's own ref writes.

**From Fable's design review (scratchpad `fable2/e1`–`e8.sh`):**
- Without `--atomic`, `reference-transaction` aborts per ref and half-applies a push, while `pre-receive` rejects all
  of it cleanly.
- The server can't tell a forced push from a normal one.
- jj's default `immutable_heads()` leaves local bookmarks mutable, and an agent's `jj bookmark set` updates
  `refs/heads/*` at once.
- A `--namespace` view is invisible to jj in the service repo.
- With `GIT_PROTOCOL=version=2`, any object can be fetched by id.
- jj deletes a tracked bookmark whose remote ref vanished and abandons its commits.
- Conflict and line refs fetched into a checkout are untracked and immutable.

**From Fable's review:**
- `--ignore-working-copy` skips colocated auto-import, and an import run by meddle in a checkout can leave the working
  copy stale. That is why meddle never writes into checkouts.
- A checkout's bookmarks, fetched as untracked remotes, freeze the commits they point at. That is why the service repo
  never fetches from checkouts: they push.
- Fetching by id needs `allowAnySHA1InWant` on protocol v0.
- `jj workspace add` refuses a non-empty folder.

**Prior art:**
- multi-value registers with siblings (Dynamo, Riak);
- Radicle's per-peer namespaces;
- GitHub Spokes, Gitaly, JGit Ketch and Gerrit multi-site, which rely on always-on quorums, ruled out here.
