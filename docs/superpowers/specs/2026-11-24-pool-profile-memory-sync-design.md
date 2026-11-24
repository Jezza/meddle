# Profile and memory synced across the pool, without a home

Date: 2026-11-24. Status: design, approved approach, awaiting review of this document.

## 1. Intent

A task must behave the same wherever it runs: the same user instructions, settings, skills, agents, commands, hooks
and plugins, and the same project memory, current to within seconds, with no node the rest depend on. The original
design promised this (section 7 and 9 of `2026-10-30-meddle-design.md`: "a jj repo synced across the pool the way
memory is"), and an anti-goal there is "a move that loses ... a project memory". Neither holds today:

- **The profile is never synced.** `seedProfile` (`src/profile.ts`) copies each node's own `~/.claude` once; each
  node's copy then drifts. Gem's is empty, so a task moved there on 2026-11-23 ran without the user's CLAUDE.md and
  commits landed in main with AI attribution the user's rules forbid.
- **Memory barely works.** It follows the project's home (fetch before a turn, push after), and:
  - a turn end skips the sync while any other task of the project is live on the node. On peeriot-00X the meddle
    project's memory has had uncommitted entries for seven hours because some meddle task was always running; none
    of it reached the other node;
  - with the home offline nothing syncs;
  - every new memory adds a line to `MEMORY.md`, so two nodes writing collide there; a collision leaves jj conflict
    markers in the file Claude reads and stops that node pushing until a session tidies it;
  - the dashboard can only write memory on the home.

## 2. Goals, non-goals, anti-goals

**Goals**

- One profile for the pool and one memory per project, identical on every node that holds them once the nodes have
  heard of each other's changes.
- A change leaves its node when the file is written (seconds), not at a turn end, and never waits for other tasks
  of the project to go idle.
- No home: any member that has a change can hand it on; an offline node keeps working and catches up when back.
- Concurrent edits to one file from different nodes are both kept. Nothing ever writes conflict markers into a file
  Claude reads, and nothing blocks a sync.
- Every version is kept in history (the dashboard shows it and can restore from it).
- Deleting a file deletes it on every node.
- Plugins: a plugin installed in the profile is installed on every node.

**Non-goals**

- Two-way sync with any machine's `~/.claude`. The pool's profile is the source of truth; `~/.claude` only seeds a
  new pool. Edits come from Claudes writing through their config directory.
- A profile UI in the dashboard and a `meddle profile export`. Both later: the UI is meant to come with skill
  triggers in the dashboard (typing `/babysit` and the like), and is designed then.
- Memory of a task's non-primary projects. Claude Code reads one memory slot per session; that stays the primary
  project's (section 7 of the original design).
- Pruning old history. Memory and profile repos are small.
- Interception of writes Claude makes through Bash (`echo >> MEMORY.md`); see 6.4.

**Anti-goals** (a build that does these has failed even if it works)

- A conflict marker in any memory or profile file.
- A sync that stops (waits for a home, an idle project, a human, a session to tidy up).
- A concurrent edit silently dropped (the losing version of a non-text file stays in history, which counts as kept).
- Nodes that never settle: merging each other's merges forever, or duplicating lines on each round.
- `settings.json` left invalid by a merge.

## 3. Constraints

- Claude Code writes memory and profile files itself, through the task's config directory (`memory/` and the profile
  entries are symlinks, section 8 of the original design). The sync only ever sees whole files on disk.
- Claude Code's Edit and Write tools refuse to write a file modified since it was read ("File has been modified
  since read, either by the user or by a linter. Read it again before attempting to write it.", verified in the
  bundled binary 0.3.328). So a change landed on disk turns a stale write into a re-read.
- One Claude Code child per turn: memory (`MEMORY.md`) and the profile are read fresh at every turn's start.
- The pool already replicates without a home: rows in pool sync (`src/pool/rows.ts`), commits fetched by id from
  whichever member has one (`fetchCommit`, `src/projects/applier.ts`), over the `meddle://` git transport
  (`src/git/serve.ts`, `src/git/wire.ts`). This design reuses all three.
- jj (0.45) stays the repo for each node's memory and profile: it snapshots the working copy, keeps history, and the
  dashboard's memory view reads it.
- Nodes of a pool may run different meddle builds during a rollout.

## 4. Approaches

Considered, with what each trades off:

1. **Fix the home model** (sync on every write, never skip a live project). Cheapest; keeps one node every other
   depends on. Rejected.
2. **Each file a row, contents in the blob store**, merged by meddle's own rule. A version-control system of our own
   (content-addressed versions, parent links, three-way merge). Rejected: no reason to build what git is.
3. **A CRDT library** (Automerge, Loro): convergence guaranteed by the library, but a WebAssembly dependency, history
   that git and jj can't read, a rebuilt dashboard history, and character-level merges that can garble markdown.
   It has the same whole-file-write problem as every option (constraint above). Rejected for those costs.
4. **jj repos, every node equal; jj merges.** Spiked: fails. Once nodes have merged each other's work criss-cross a
   merge has several bases, jj makes 3- and 4-sided conflicts, and its merge tools take only 2 sides. 6 of 12
   three-node runs left conflict markers.
5. **jj repos, every node equal; git computes merges** (chosen). jj holds the repo, the working copy and history;
   `git merge-tree` (which merges several bases recursively) computes each merge with meddle's merge drivers, and git
   writes the merge commit with fixed metadata so every node merging the same heads makes the identical commit.

**Spike evidence** (throwaway, `/tmp/meddle-spike/`): three to five jj repos as nodes, random edits (new memory with
a pointer line, line edits, deletes), random partial syncs, then full sync rounds. 32 runs, 988 merges, 1,021 new
memories: every run ended with every node on the identical commit within two full rounds, no memory lost, no line
duplicated, no conflict marker. Git's plain `union` merge duplicated 44 pointer lines; the capped union (6.2) took
that to 0. Edit against delete keeps the edit, on every node, either order.

## 5. Vocabulary

- **Scope**: one synced directory. `profile` (one per pool) or `memory/<project id>` (one per project).
- **Head**: the commit a node's copy of a scope is at, published as a head row.
- **Head row**: (scope, node) → commit, written only by that node.

## 6. Design

### 6.1 Each node's repo and its head

Each scope is a colocated jj repo on every node that holds it, at the paths used today: `<data>/profile` and
`<data>/memory/<project id>`. Tasks' config directories keep symlinking at them (`linkProfile`, `linkMemory`), so
nothing about provisioning changes. A node's own head is a local bookmark (`profile`, `memory`).

**Local changes.** The node watches each scope's working copy and, a short quiet period after the last write
(builder's call, about 1 s), commits what changed and moves its bookmark onto it. Turn ends trigger the same commit
as a backstop, and a periodic scan catches anything a watcher missed. No step waits for tasks to be idle. The commit
message names the node and, where known, the tasks of the project live there (`memory from <node>: task <id>`; with
several live, all of them: the directory is shared, so the writer can't be told apart).

**Publishing.** After every move of its bookmark the node writes its head row `(scope, self) → commit` with a seq
one above the last, like a branch row. Rows ride pool sync and are relayed by every node; a peer's head row waits
until this node holds its commit, and only then is it used and relayed (as branch rows do, `branch_rows_waiting`), so
every node that hands a row on can hand its commit on too. Rows of a removed project are skipped as today.

**Fetching.** For each peer head row it lacks the commit of, the node fetches the commit by id from the row's writer
first, then any online member (`fetchCommit` generalised to any repo kind). The transport gains the `profile` repo
kind next to `project` and `memory`; both are served upload-pack only. Nothing is pushed any more.

### 6.2 Merging

When a peer's head is neither this node's head nor an ancestor of it, the node merges, peers taken in node-id order:

- this node's head is an ancestor of the peer's: fast-forward (move the bookmark);
- otherwise: `git merge-tree --write-tree <p1> <p2>` with the parents ordered by the id of the node each came from
  (whoever merges), then `git commit-tree` with fixed metadata: author and committer `meddle`, both dates the later of
  the parents' committer dates, message `merge` plus the merge rule's version (6.6). jj imports the commit. Two nodes
  merging the same heads thus make the identical commit, which is what lets them settle.

The merge is computed beside the working copy; the working copy moves only to a clean result.

**Merge drivers**, set by `.git/info/attributes` in each repo (never by a file in the scope, which a Claude could
edit), each a pure function of (base, ours, theirs) so every node computes the same bytes:

| Files | Rule |
|---|---|
| `*.md`, `*.txt` | Capped union: git's three-way union merge (both sides' lines where they overlap, the first parent's first), then no line kept more often than the side that has it most. Blank lines are exempt from the cap (builder's call: the cap can otherwise drop a paragraph break when both sides add a paragraph). |
| `*.json` | Structural: parse all three; three-way merge per object key, recursively; a key changed on one side takes that side's value; changed on both to different values, the second parent's (the higher node id's) wins; arrays changed on both become the first parent's items followed by the second's not already in it. Output is formatted with two-space indent and a trailing newline. A side that does not parse loses to the side that does; both unparseable falls to the rule below. Never invalid JSON. |
| everything else (scripts, binaries) | Whole file: the second parent's version wins when both changed it; the other stays in history. |

Git's own edit-against-delete rule keeps the edited file (verified, both orders).

The drivers run as a meddle subcommand (`meddle merge-driver <kind> %O %A %B`, alongside `meddle git-remote`) so they
ship with the binary, and are implemented in TypeScript, including the three-way line merge (no `git merge-file`):
the bytes a merge produces must not depend on the git version a node has. `git merge-tree` is left only the tree-level
work (which bases, which files changed, edit against delete), run with rename detection off; nodes need git 2.43 or
later (`merge-tree -X`; macOS needs a newer git than Apple's 2.39, e.g. Homebrew's), checked at start. The git version is not part of the rule version (6.6): with the
content merge ours and renames off, the tree-level result does not vary between those versions.

### 6.3 Updating the working copy

After a merge or fast-forward the node brings the working copy onto its new head. Edits written since the last
commit are first committed (as in 6.1) and merged in the same way, so they never become a conflict; only then is the
working copy checked out. Every step that touches a scope's repo runs under that repo's lock (`repoKey`), as today.

A Claude that read a file before the update and writes after it gets Claude Code's "modified since read" refusal and
re-reads (constraint above). That is the protection against a stale whole-file write.

### 6.4 Writes Claude makes through Bash

A write through Bash (`echo >>`, `cat >`) skips Claude Code's check, so one based on a stale read could undo a
change that landed meanwhile; the undone version stays in history. Rare for memory. Not intercepted in this build;
a PreToolUse hook refusing Bash writes into the memory and profile directories is the later fix if it shows up.

### 6.5 The profile

The `profile` scope holds `CLAUDE.md`, `settings.json`, `skills/`, `agents/`, `commands/`, `hooks/` (as
`PROFILE_ENTRIES` today) and a new `plugins.json`.

`skills/synced/` is left out: seeding and `meddle profile import` skip it, and the upgrade removes it from existing
profiles. It is Claude Code's own copy of the claude.ai account's skills (`docs`, `pdf`, `skill-creator`, ...), with
a `manifest.json` and a `.last-complete-round` marker Claude Code rewrites on every refresh. Under meddle it is dead:
the copies seeded on 2026-11-04 were never refreshed since, and tasks don't load those skills (they log in with a setup
token, as with claude.ai connectors, section 9 of the original design). Synced, it would be churn nobody edits. If a
task's Claude Code ever writes it, it is ignored there (excluded from the repo's snapshots).

**Seeding a new pool.** A node with no profile at all (a fresh install) seeds one from its `~/.claude` (as
`seedProfile` does) and marks the seed commit as a seed (message `seed profile from <path>`). Its head row says
whether its line holds anything beyond the seed. The rules, all deterministic from the two lines' histories:

- seed-only meets anything with more than a seed: it drops its own and takes the peer's (its seed stays in its
  history, unpublished);
- seed-only meets seed-only: the lower node id's seed wins;
- seed plus edits meets an unrelated profile with more than a seed: its edits are replayed onto the peer's, the
  three-way merge taking its seed as the base (so the seed itself is not unioned in);
- two unrelated profiles both beyond a seed with nothing to replay against (two pools joined later): merged with
  an empty base.

**Migration of existing profiles.** The agreed outcome is that the pool's profile starts from peeriot-00X's and the
others' are discarded. On upgrade an existing profile is neither a seed nor published: it is the node's legacy
profile, and tasks keep using it unchanged, so no node's tasks lose their instructions in the meantime. The pool's
profile comes into being when `meddle profile import [<dir>]` runs on one node (peeriot-00X), reading `<dir>` laid
out like `~/.claude`, by default that node's own `<data>/profile` working copy. Every node with a legacy profile then
switches to the pool's (its legacy content stays in its history, unpublished; edits a Claude made to it in between
are discarded with it, as agreed). The command is also how a user later replaces the pool's profile from a directory
on purpose; that is a real-edit commit like any other.

**Plugins.** `<data>/plugins` becomes meddle's own directory. Today `ensurePlugins` makes it a symlink to
`~/.claude/plugins`, which would make it a two-way sync with `~/.claude` (a non-goal). On upgrade a symlinked one is
replaced by a copy of what it points at, with the absolute paths in its bookkeeping (`installPath` in
`installed_plugins.json`, `installLocation` in `known_marketplaces.json`) rewritten to the copy; without that Claude
Code would keep loading plugins from `~/.claude`. A fresh node copies the same way when `~/.claude/plugins` exists.
A plugin installed in a terminal Claude no longer reaches meddle's tasks; one installed inside a task reaches every
node.

The plugin files themselves are not synced: the directory is mostly caches (37 MB, about 1,500 files on
peeriot-00X), holds the marketplaces as git clones, and stores machine-specific absolute paths. What is synced is the
list: `plugins.json` in the profile records the plugins the pool wants (`<name>@<marketplace>` with its version) and
each marketplace's source as `known_marketplaces.json` has it. A node edits it only for what changed in its own
`installed_plugins.json` since it last applied the list (an install, a removal, an upgrade), never by writing out its
whole installed set, so it never puts back a plugin another node removed. Every node brings its directory to the list:
installs what is missing (the marketplace first, if unknown), removes what the list dropped, and upgrades to a newer
listed version; never downgrades (a listed version older than the installed one is left, and the next edit lists the
newer). Failures are logged and retried later. `enabledPlugins` already travels in `settings.json`.

### 6.6 The merge rule is a pool protocol

Nodes settle only because every node computes the same merge from the same parents. A build that changed a driver
or the ordering would make different commits from the same heads, and the nodes would keep merging. So the rule
carries a version (in the merge commit's message and in the head row). A node merges only heads whose rows carry
its own rule version; a head of another version waits (logged once) until the rollout brings every node to one.

### 6.7 Mixed builds during the upgrade

A pool update rolls every node to the new build together, but for its duration old and new nodes coexist:

- an old node keeps pushing `memory` to the project's home; a new home accepts that push (the pre-receive gate as
  today) and treats the pushed commit as a local change to merge and publish. Nothing is lost;
- an old node's fetch from the home keeps working: a new node's `memory` bookmark is still its head;
- once no old node remains, the push path and its `pre-receive` branch go (a later release).

A node's first start on the new build commits whatever its memory working copies hold uncommitted (on peeriot-00X
that is seven hours of meddle's memory) and publishes its heads. Before it publishes, any conflict the old sync left
is resolved with the new drivers: a conflicted file's sides are merged by the rule for its kind (folded pairwise, in
a fixed order, when there are more than two), and any conflict markers left in a file's text by an earlier
materialised conflict are replaced the same way. A commit whose tree holds jj's conflict entries (`.jjconflict-*`) is
never published, on upgrade or after. Existing memory repos share history through the old
`memory` bookmark, so their first merges are ordinary; a replica that started empty (a clone that failed) merges with
an empty base.

### 6.8 Moving a task

Step 4 of the move ("B syncs the project memory repos") becomes: B makes sure it holds the project's memory repo
(created and filled from the head rows like any replica) and has merged every head it holds the commit of. The
source has published on every write, so nothing waits on the source unless it is offline.

### 6.9 The dashboard

- Memory is read from any node holding the project (all are equal); `memorySource` drops its home preference.
- Writes happen on any node: written into the working copy, committed (`memory: dashboard`) and published like any
  change. The `not-home` and `busy` refusals go; the `changed` refusal (the file is not what was read) stays.
- History is the node's head line. The builder decides how merge commits show (probably collapsed, with the merged
  sides' changes shown under them).
- An entry in a memory file's history can be restored: the file's text at that change written through the same
  write as an edit (so it is checked against what was read, committed and published).
- The profile gets no dashboard view in this build (history through jj on any node).
- A per-node sync state for each scope where the node page lists it: in step, or how many peer heads are not merged
  yet and why (waiting for a commit, another rule version).

### 6.10 What goes

- `syncMemoryBefore` / `syncMemoryAfter` and their turn-start and turn-end calls (`src/tasks/durable.ts`), and
  `followHome` (`src/state/host.ts`).
- Cloning memory from the home (`cloneMemoryReplica`'s home remote) and pushing it there (`pushBookmark` for memory),
  after the mixed-build window.
- The `memory of <id> was not synced …` log lines, replaced by the sync's own.
- README sections "Memory", the home limitations under known limits, and the user guide's "Profile: the user layer"
  (which says the profile is not synced).

## 7. Testing

- The spike's randomized test, ported into the suite: N in-process nodes (repos in a temp dir, rows exchanged
  directly), random edits and partial syncs, then assert identical heads, nothing lost, no duplicates, no markers.
  Small by default, larger under an env var.
- Each merge driver on its own: fixed inputs, determinism (same output from the same three inputs), JSON always
  parses, capped union's blank-line exemption.
- The working-copy update with a write landing between commit and checkout.
- Seed adoption: seed-only meets real, seed meets seed, real meets real unrelated.
- Mixed builds: an old node's push to a new home lands and is published.

## 8. Left to the builder

The quiet period and scan interval; watcher mechanics; the row's storage and wire shape (following
`BranchRow`); the subcommand's name; how merge commits show in history; how a plugin is installed and removed
(Claude Code's own `plugin` commands against the node's directory are the obvious route); log line wording (terse, as
the rest of meddle's).
