# Pool Updates (OTA): Design

Settled with the user on 2026-11-13. Statements marked **(my call)** were decided by the writer, not the user; the
user should check them.

## Intent

Updating meddle today means, on every machine: clone the repo, `bun run build`, `install` the binary, move it into
place, `systemctl --user restart meddle`. The pool runs on x86 machines and on a Raspberry Pi 5 (linux-arm64).

Instead: build once, on one machine, for every platform (the cross-compile already works:
`bun run build --target=bun-linux-arm64`), hand the binaries to the local node, and let **the pool spread them**.
Every node takes the binary for its own platform, swaps it in, restarts, and checks itself. The update is
all-or-nothing: if any node fails, the whole pool rolls back to the previous version and the failure, with its
reason, stays visible to the pool so it can be fixed and rolled out again.

## Goals

1. **One command rolls out a build to the whole pool**, both platforms at once, from any node.
2. **Spread over the pool's own links**: no central server, no GitHub release, nothing new to run.
3. **All-or-nothing**: a rollout is confirmed only when every participating node reports healthy on the new build.
   One failure rolls every participant back, binary and database.
4. **Failures are explained**: the failing node's reason (a crash on start, a database error, a health timeout) is
   recorded and shown in the pool (CLI and dashboard) until the next rollout.
5. **Nothing is accepted on an unconfirmed build**: no turns, tasks or other input until the whole pool confirms, so
   a rollback never discards anything.
6. **Running turns are respected by default**, and you can force past them.
7. **Nodes that were away catch up** when they come back, and **errored nodes are updated by the next rollout**.
8. **Bounded**: a rollout not confirmed within its deadline rolls back.

## Non-goals

- Updating nodes that run from a checkout (`bun run src/cli.ts serve`): they are reported as not updatable and left
  out **(my call)**. You run binaries everywhere.
- Updating jj, git, or anything else on the machine.
- Staged or canary rollouts, scheduled rollouts, automatic retries of a failed build.
- Versioning every pool message. The user notes most messages *should* be versioned, and that is worth doing, but
  it is separate work. This design versions only the messages it adds **(my call)**.
- Updating the systemd unit. A rollout swaps the binary; a changed unit still needs `meddle service install`.

## Anti-goals (it fails even if it technically works)

- A node left on a broken build that it cannot get off by itself.
- A rollback that loses work silently: turns that ran on the new build, then had their records wiped by the database
  restore.
- A pool split across versions without anyone being told. Mismatched builds cannot move tasks between them.
- A node unable to report its failure because the failure changed how nodes talk to each other.

## How a rollout goes

### Building

`bun run build` gains a way to build every platform the pool needs in one go (x64 and arm64 for linux, at
least), writing one binary per platform **(my call; the flag's name and output paths are the builder's)**.

Every build carries a **build id** embedded at build time. The package version is `0.1.0` and never changes, so it
can't tell builds apart. The build id must identify the source, for example the jj commit id, and be the same for
the x64 and arm64 binaries of the same source, so the pool knows they are one release **(my call)**. Each binary
also carries its platform (it already embeds its Claude Code platform).

### Starting it

`meddle update <binary>...` (run against the local node, from the CLI of a binary or a checkout) takes one binary per
platform. It reads each one's build id and platform from the file itself, and checks that the build ids agree.
It refuses before anything changes when:

- an online, participating node's platform has no binary,
- a node's binary location isn't writable by the service's user (for example, installed into `/usr/local/bin`
  by root),
- a rollout is already in progress.

It replicates a **rollout record** to the pool: the build id, a binary per platform, who started it, when, the mode
(queued or forced), and the **participants**, meaning the nodes online at that moment. Rolling out the build the pool
already runs is refused, unless some online node is errored (a red dot). Then it updates just those nodes, so a node
whose update failed for its machine's reasons can be retried with the same build **(my call)**. Rolling out a build
that failed before is allowed: the failure may have been the machine's, not the build's **(my call)**.

### Spreading the binaries

Each participant fetches its platform's binary from any member that has it, over the pool's existing iroh links
(the move code's `blob` stream is prior art), verifies it against a SHA-256 in the rollout record, and stages it
next to the running binary **(my call: hash-verified)**. Members that have it can serve it, so the Pi doesn't
depend on the node that started the rollout staying up.

**A node already running a build serves its own binary** (the user's requirement). A node on build X and platform P
gives out the file it runs (`process.execPath`) as P's binary of X, after hashing it again and checking it against
the hash it took at boot. Only the starter stores binaries for other platforms, and only while its rollout is open. After that, each node
serves only the binary it runs.

**Every node reports its binary's SHA-256** (the user's requirement), taken at boot, in its frozen record. This keeps
everyone provably on the same version, and catches a bad binary:
- A node whose hash differs from its build's expected hash for its platform gets a red dot and is updated like any
  errored node.
- Two nodes on the same build and platform with different hashes both get a red dot, when no rollout says which is
  right.
- A node re-hashes its file before serving it and every few minutes. If the file on disk no longer matches what it
  booted from (someone replaced the binary under the running process), it gets a red dot ("binary on disk changed
  since start") and stops serving that file. Its own swap during an update doesn't count.

### Preflight

Before it restarts, a node runs the **staged binary** in a check mode (a subcommand, the builder's to name). The
check proves that the binary runs on this machine at all, and fetches what the new build needs before the swap:
mainly the Claude Code version it pins, which can be a 140 MB download from npm. A preflight failure fails the
rollout on that node before anything restarts **(my call)**.

### Queued (default) versus forced

- **Queued** (`meddle update <binaries>`): each participant stops starting turns, so new prompts queue as they do
  today. It lets running turns finish and reports itself drained once it has none. Until the swap, everything
  else (new tasks, prompts, settings, pushes) is accepted as normal. It all lands in the database before the copy
  is taken, so a rollback keeps it.
- **Forced** (`meddle update --force <binaries>`): each participant cuts its running turns off and counts as
  drained at once. A cut-off turn is resumed later, exactly as after any service restart today ("The meddle service
  restarted while you were working…", `src/tasks/durable.ts:136`).
- **Escalation**: `meddle update --force` while a queued rollout is draining forces that rollout. It doesn't
  start a new one.

**Participants swap together (my call):** no node swaps until every participant has drained. Then they all copy,
swap and restart. This keeps the window between a node's database copy and confirmation down to the swap-and-health
time, not the length of the slowest turn.

While it's queued, the pool sits paused until the slowest running turn anywhere ends. So the CLI and dashboard show
what a rollout is waiting on: which nodes, which tasks' turns.

### The rollout's deadline

A rollout has an **upper bound** (the user's requirement). If it isn't confirmed within its deadline, counted from
when it started, it fails and rolls back like any other failure. The reason names what it was still waiting on (for
example "not confirmed within 30m: waiting on pi's turn in task 0012"). A rollout that times out while still
draining has swapped nothing, so its rollback just drops the staged binaries and lifts the hold on turns.

The deadline is 30 minutes by default **(my call on the number)**. A pool setting changes the default, and
`meddle update --within <duration>` overrides it for one rollout **(my call)**. The per-node health deadline below
still applies inside it.

### Swapping

Once every participant has drained:

1. It stops taking turns (already true), and holds task moves, archives and restores **(my call)**.
2. It **copies its databases**, `meddle.sqlite` and `durable.sqlite` in the data directory, as one consistent pair,
   so the pair can be restored.
3. It keeps the **previous binary** beside the new one, so a rollback needs nothing from the network.
4. It moves the staged binary into place over the running binary's path (atomically: rename, not copy), and
   restarts itself under systemd.

Task workspaces are not copied. They are only changed by turns, and no turns run until confirmation.

### Awaiting confirmation: no input

From the moment a node copies its databases until the rollout is confirmed or rolled back, it **accepts no input**
(the user's requirement). That means no new tasks, prompts or turns, and **(my call)** also no approvals, token or
setting changes, pushes, moves, archives or restores. Anything accepted then would be wiped by a rollback's restore.

- The dashboard covers itself with a **blind**, or disables all of its input. The user offered either, so the
  builder chooses. Whichever it is, it shows the rollout's progress: each participant's state, and the
  deadlines.
- The CLI and the git remote refuse with a clear message (for example `meddle: update in progress (build <id>),
  try again shortly`).

### Health

On the new build, a node is **healthy** once it has started `serve` completely (database opened, Claude Code in
place, dashboard listening) and rejoined the pool. Rejoining means connecting to at least one other participant
that's online. A node with no online peers counts as rejoined once it is serving **(my call)**. It then reports
healthy in the rollout record. It doesn't start or resume any turn yet.

A node **fails** when:
- the preflight fails,
- `serve` fails on start, including a database error (the user's own example),
- the process crashes or keeps restarting,
- it isn't healthy within a deadline after the swap.

The deadline is 2 minutes by default, and a pool setting can change it **(my call on the number)**. The failure's
reason (the error text, the last log lines, or "not healthy within 2m") goes into the rollout record.

**A binary that cannot start at all must still roll back.** Nothing can depend on the new binary running to undo
itself. So something that is known good has to decide, on start, whether the new build has had its chance and failed:
the previous binary, or a small guard the unit runs before `serve` (for example an `ExecStartPre=` running the kept
previous binary), with a start-attempt count kept in the data directory. It then swaps back. The mechanism is the
builder's. The requirement is not. Watch the unit's `Restart=on-failure` / `RestartSec=2` loop: it must not mask a
crash loop, and it must not burn through the deadline without anyone noticing.

### Confirmation

The rollout is **confirmed** when every participant has reported healthy. Then each node:
- resumes turns (cut-off ones with the existing carry-on prompt) and lets queued prompts start,
- releases held moves, archives and restores,
- deletes its database copy and its previous binary.

A participant that goes offline after it has swapped, and doesn't report healthy by its deadline, counts as failed
**(my call: safe over convenient)**. A participant that goes offline (or to sleep) **before** it swaps, whether
still draining or already drained, **fails the rollout** once it has been offline for a minute. The reason names it
("pi went offline"), and you run the rollout again. Once **every** participant has drained, though, an offline one
may be in the middle of its swap (copying databases on an SD card can take over a minute), so it gets the same time
as a swapped node: the health deadline plus a grace **(my call, from review)**. Participants are never dropped (the
user chose this over dropping, as simpler). Draining is bounded by the rollout's deadline. Forcing is the way past a long turn before
then.

### Rollback

When any participant fails, the rollout is **failed** and every participant rolls back. It restores its database
copy and its previous binary, restarts on the old build, then resumes turns there. The failure (node, reason, time,
build id) stays in the pool, shown in `meddle status`, in the dashboard and in `meddle update` output, until the next
rollout replaces it. Nothing retries automatically.

Participants that never got as far as swapping drop the staged binary. Any member that sees a rollout fail rolls
back, so a node cut off from the failing one still learns of it through the others.

### Nodes that were away

A node that wasn't a participant (offline when the rollout started) learns of the confirmed build when it rejoins.
Until it has updated it runs a mismatched build: it doesn't host tasks or take part in moves. It then updates
itself the same way (fetch, preflight, copy, swap, health). Its update is its alone:

- If it succeeds, it rejoins as a normal member.
- If it fails, it rolls **only itself** back, stays off its old build's turns and out of the pool's work, and
  reports the error. The dashboard shows that node with a **red dot** and the reason. It doesn't roll back the pool.

It updates in the original rollout's mode: queued (its running turns finish first) or forced **(my call)**. The
turns of tasks it hosts are held from the moment it learns it is mismatched until its update succeeds.

A late node that can't get the pool's binary for its platform (no member online has it) fails its update with that
reason, and gets a red dot. Members keep only the binaries they need. Nobody stores every platform's binary just in
case.

**A new rollout updates errored nodes too** (the user's requirement). An online node with a red dot (one that failed
its late update, or is otherwise mismatched) is a normal participant of the next `meddle update`, whatever build it
is on. It is fetched, drained, swapped and confirmed with the rest, and its failure fails the rollout like anyone
else's. This is how "fix it and roll it out again" reaches it. A late node that failed also tries again at its next
service restart **(my call)**.

**Who counts as mismatched (my call):**
- A **binary** node whose build id differs from the pool's last confirmed build, including one installed by hand the
  old way, is treated as a late node and updated to the pool's build. You change the pool's build with
  `meddle update`, not by copying a binary onto one machine.
- A **checkout** node reports its build id as `checkout` and is exempt. It keeps today's behaviour: the dashboard's
  existing mixed-versions flag (`mixedVersions`, `src/pool/object.ts`), with no gate. Otherwise a development
  checkout would be locked out after the first rollout.
- A pool that has never had a rollout has no confirmed build, so nothing is mismatched until the first one.

### Staying able to talk across versions

A failed or mismatched node must still be seen and still report why. The messages this design adds (the rollout
record, the per-node update state, the failure report) carry an explicit **version** field and follow
forward-compatible rules: readers ignore fields they don't know, and fields may be added but never removed or
changed in meaning. The minimum every build understands is: build id, platform, update state (`idle`, `staged`,
`draining`, `swapped`, `healthy`, `failed`), and failure reason. That minimum must never change shape. The node
summary already copes with older peers (`WireSummary`, `withSummaryDefaults`); this follows the same habit,
made explicit with a version number.

**The update process is versioned too** (the user's requirement, kept light). Each node advertises, in its frozen
record, the **OTA protocol version** its build speaks: one small integer, starting at 1. Bump it only when the
rollout steps or their wire meaning change incompatibly. A build lists the OTA versions it can drive (initially just
`[1]`). `meddle update` includes a node whose OTA version it can drive, whatever build that node is on. It refuses
up front, naming the node and its OTA version, when an online node's version is one it can't drive. Nodes from
before this feature have no channel at all and are still refused, as before. Nothing more elaborate is wanted:
the user keeps OTA working across builds by hand, and this number is the safety catch for when that fails.

So rollout state travels on **its own channel** (its own stream or chord contract), frozen and versioned as above,
and **not** as a row in `PoolObject`'s sync **(my call)**. A chord consumer binds only to a provider whose contract
covers it, so a build that changes `PoolObject` couldn't read an older node's rollout rows. That would happen
exactly when a failure has to cross between versions. All other sync between nodes on different builds (tokens,
settings, line and branch rows) may stop for the length of a rollout. That's acceptable, because no turns run then
**(my call)**.

## What you see

- `meddle update` with no binaries reports the current rollout: build id, mode, and each participant's state, with
  what a queued rollout is waiting on, or the last failure and its reason.
- `meddle status` shows each node's build id and update state.
- The dashboard shows a rollout in progress, and the nodes and turns it waits on. It shows a failed rollout with
  its reason. A node that failed its late update, or is otherwise on a mismatched build, gets a red dot with the
  reason.

## Constraints

- One binary per platform. The pool today is linux-x64 and linux-arm64 (glibc, Pi 5). musl and darwin builds use
  the same mechanism if a node needs them.
- The service runs as a systemd **user** unit with `ExecStart=<binary> serve` (`install/meddle.service`). The binary
  is wherever you put it (often `~/.local/bin/meddle`), and the swap replaces that file.
- Only pool members (nodes that proved the pool secret) can start a rollout. They already share the pool's login
  tokens, so this is the existing trust boundary **(my call)**.
- Binaries are ~150 MB each (~450 MB with `--embed-claude`). Transfers must stream, not buffer in memory
  (`MAX_FRAME` is 16 MB).

## Left to the builder

- Command and flag names beyond `meddle update [--force] <binary>...`.
- The build-all flag and its output names.
- Where the staged binary, previous binary, database copy and attempt counter live (the data directory is the
  natural place).
- How the rollout channel is built, within the frozen, versioned and separate-from-`PoolObject` rules above.
- The guard mechanism for a binary that can't start.
- How preflight is invoked and what exactly it checks, beyond the two requirements above.
