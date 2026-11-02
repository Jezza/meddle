# meddle

meddle is a service you run on each of your machines to drive Claude Code sessions through the Agent SDK, so that a
task is created in one place and worked on wherever you assign it. Each task is a folder of jj workspaces with one
Claude Code session running in auto mode, which you watch, approve, interrupt and steer from a browser dashboard with
the fidelity of sitting at that machine's terminal. The services find each other and form one pool, sharing one
Claude login and each project's memory, and a task can move between machines without losing its conversation.

Status: Plan 3, repos across the pool and task moves. Nodes form a pool over iroh: they find each other through a
lighthouse, share their login tokens, and the dashboard of any node shows every node and opens its tasks. A project's
repo and memory follow its tasks to whichever node they run on, and a task moves between nodes with its workspaces,
conversation and queued prompts. Moving a project's home to another node is not here yet (see
[Known limits](#known-limits)).

## Install

Requires [bun](https://bun.sh), [jj](https://jj-vcs.github.io/jj/) and git.

```sh
git clone <this repo> meddle
cd meddle
bun install
bun test
```

The commits meddle makes in your repos carry a jj identity, and meddle does not invent one. Set it once for the
whole pool, with a node running (see [Pool settings](#pool-settings)):

```sh
bun run src/cli.ts config set jj.user "Your Name"
bun run src/cli.ts config set jj.email you@example.com
```

Every node of the pool then runs jj and every task with that identity. Without one (neither the pool setting nor a
jj user config on the node) jj refuses to push the commits, so every push to a project's home fails and each turn end
logs a `meddle: git: …` line saying so (see [Projects across the pool](#projects-across-the-pool)).

The commands below run from the checkout as `bun run src/cli.ts <command>`. `bun run build` also produces a compiled
`dist/meddle` for `status` and the `token` commands; the service itself runs from the checkout. The compiled binary embeds
iroh's native modules (two `.node` files, its glibc and musl builds), which make it about 40 MB larger (147 MB on
linux-x64). It carries no `node_modules`, so it reports its Claude Code version as `unknown`. A node served from it
reports `unknown` to the pool too, so in a pool with nodes served from a checkout the dashboard flags the members'
versions as mixed, and it can neither move its tasks away nor take tasks from other nodes (see
[Moving a task](#moving-a-task)).

## Task root

Every task lives under one task root, `/opt/meddle/tasks` by default. Create it once, owned by you:

```sh
sudo install -d -o $USER -g $(id -gn) -m 755 /opt/meddle/tasks
```

To use a different root, set `MEDDLE_TASK_ROOT` to it in the environment of every meddle command.

## Login tokens

meddle keeps an ordered list of tokens from `claude setup-token`, one per login. Add one by piping it in on stdin or
from a file, never as an argument:

```sh
claude setup-token          # copy the token it prints
bun run src/cli.ts token add --label work                 # paste it, then Ctrl-D
bun run src/cli.ts token add --file <path> [--label <l>]
bun run src/cli.ts token list                             # or token status
bun run src/cli.ts token remove <id|label>
bun run src/cli.ts token enable <id|label>
```

A token's id is the first 16 hex characters of the SHA-256 of its value, so the same token added twice, on one node
or on two, is listed once. Adding it again with `--label` renames it, and adding a removed token brings it back.
Without `--label` a token is named after the first 8 characters of its id; a label is at most 64 characters. `token
add` prints `token <id> (<label>)`, and `token set` is the same command. `remove` and `enable` take a full id or a
label; a label two tokens share is refused (`ambiguous token label`), so name the token by its id then.

Each value is written mode 600 to `secrets/tokens/<id>` in the data directory (`~/.local/share/meddle`, or
`MEDDLE_DATA_DIR`; the directory is mode 700) and given to Claude Code as `CLAUDE_CODE_OAUTH_TOKEN`. The list itself
(each token's label, who set it and when, its status and its expiry, a year after it was set) is in the node's
database.

A turn uses the first token in order (by when each was set) whose status is `ok`, or `exhausted` until a time that
has passed, and whose value the node holds. A `disabled` token waits for `token enable`. With no usable token a turn
fails with `no usable token`, and `task new` is refused the same way. `token list` prints a line per token (id, label,
status with its time and reason, expiry) and then `active: <id>`, the token a turn starting now would use, or
`active: none`.

The token commands work on the node's database and secrets directory directly, with or without a running node, so a
value never goes over the node's socket; when a node runs, they tell it and it tells the pool. `token list` reads the
database read-only and, before the node's first start, prints only `active: none`.

A node that ran an older meddle with a single token (`secrets/claude-token`) imports it at its next `serve` as the
token labelled `default`, keeping when and by whom it was set, and renames the old files to `*.migrated`.

## Pool

Every node is in a pool. On its first `serve` a node creates a pool of its own; other nodes join it with an invite
ticket.

### Node ids

A node's identity is an iroh secret key at `<data dir>/secrets/iroh.key` (64 hex characters, mode 600), created on
first use. Its node id is the lowercase hex of the public key, 64 characters; `meddle pool` and the dashboard's node
cards print its first 10 characters. `serve` prints the full id when it starts:

```
node <node id>
dashboard at http://127.0.0.1:7777/
```

`status` prints `node <node id>`, or `node (none yet)` before the key exists, and `pool <pool id> members <n>`, or
`pool (none yet)` before the node first served. It creates neither the key nor the database.

### Invite and join

With both nodes running:

```sh
bun run src/cli.ts invite          # on a node in the pool: prints a ticket, meddle1…
bun run src/cli.ts join <ticket>   # on the new node: prints "joined pool <short id> with <n> nodes"
```

A ticket is valid for 24 hours and admits one node, once. It carries only a one-time code and the inviting node's
address, never the pool secret: the joining node connects to the inviter over iroh, and the pool id, the pool secret
and the roster come back in the inviter's reply, inside that encrypted connection.

A node that shares its pool with other members cannot join another; remove them first. A node alone in its pool (as
after its first start) gives that pool up when it joins, along with any tickets it issued for it. The dashboard's
Settings view creates tickets and joins with one too.

### Discovery

Members find each other's current addresses through an iroh-lighthouse, the hosted `https://iroh.ichor.io` by
default (`MEDDLE_LIGHTHOUSE_URL` names another). Each node announces itself on a topic derived from the pool id and
the pool secret, so only holders of the secret can announce on it or look it up. An announce asks for 300 s and is
renewed at half the time the lighthouse grants; a node looks the topic up every `MEDDLE_DISCOVERY_POLL_MS`. Only
addresses of nodes the roster lists as members are used.

If the lighthouse is unreachable the node still starts; it retries with backoff and logs each distinct error at most
once a minute. Set `MEDDLE_LIGHTHOUSE_URL=` (empty) to turn discovery off: nodes then reach each other at the
addresses recorded in the roster, and a joining node at the address in its ticket.

### Connections and removal

Nodes talk over iroh: QUIC, encrypted end to end, through iroh's relays when there is no direct path. A node accepts
pool connections only from nodes its roster lists as members, and closes any other before reading from it. Of two
members, the one with the smaller node id dials and the other accepts. When a node cannot reach a member (a dial
fails or is not answered, the member keeps refusing it, or it cannot read the member's pool state) it logs why, as
`meddle: pool: …`, each distinct message at most once a minute; a healthy pool logs nothing.

A member is removed from the dashboard's Settings view (a node cannot remove itself). The removal is a roster change
every member merges, and every member enforces it: each one closes its connection to the removed node, and refuses
it when it dials, with the reason `removed <time>`. The removed node learns it was removed from the roster when it is
connected at the time, or else from that refusal; it then closes its connections, stops announcing, and can be
invited again. The pool secret is not rotated on removal, so a removed node still knows it.

One known limit: a node removed while it is unreachable learns of it only when it next dials a member, and a node
dials only members whose ids sort after its own. If its id sorts after every remaining member's, nobody dials it and
it dials nobody, so it keeps showing itself as a member with every other node offline; it is connected to no one. To
bring it back, remove the other nodes from its own Settings view, then join it with a new ticket.

### Tokens

Every member lists every token. A token's metadata replicates per id, last writer wins on the time it last changed
(on equal times every node settles on the same row), and a removal replicates as a removed row. A node pulls the value
of each token it lists but lacks, by id, from the member that listed it, and deletes the value of a token the pool
removed. A value crosses the network only as the answer to a request from a current member for a token the answering
node lists, over the encrypted iroh connection. It never goes over the node's localhost socket (the CLI's and the
dashboard's), and never into a ticket, the roster, the pool's replicated state or a log. A node drops a replicated row
whose id is not 16 hex characters, whose label is empty, longer than 64 characters or holds control characters, or
whose status or times are malformed, and logs `meddle: tokens: ignored replicated token "<id>"` once per id. A token
added while no node is running reaches the pool once that node serves.

Tokens are the logins of the people who added them, not the pool's: a node that joins another pool keeps its tokens,
and they replicate to the new pool like any member's. The join itself carries none; the joiner pulls the pool's
tokens like every other member.

### Pool settings

A few settings hold for the whole pool. Set, unset and list them from any node with that node running:

```sh
bun run src/cli.ts config set <key> <value>
bun run src/cli.ts config unset <key>
bun run src/cli.ts config list
```

`config list` prints one `<key> = <value>` line per setting, by key. Without a running node they fail with
`start "meddle serve" first`.

| Key | Applied as |
| --- | --- |
| `jj.user`, `jj.email` | `JJ_USER` and `JJ_EMAIL` for every jj command meddle runs and for every task's Claude Code, so commits carry one identity on every node. Neither can be empty. |
| `env.<NAME>` | `<NAME>` (upper case, digits and `_`) in every task's Claude Code environment and in every jj command meddle runs (with the git processes jj starts). Not in the `git upload-pack` and `git receive-pack` a node runs to serve another node's fetch or push. A project's context `env` wins over it for that project's tasks. |
| `lighthouse.url` | The discovery lighthouse, applied live; it cannot be set empty. A node that sets `MEDDLE_LIGHTHOUSE_URL` (even empty, which turns discovery off there) uses its own instead. |
| `limits.running` | How many turns a node runs at once before placement treats it as full (a non-negative integer; `0`, the default, is unlimited). A node that sets `MEDDLE_MAX_RUNNING` uses its own instead. |

Each key replicates on its own, last writer wins on the time it was set, the roster's rule (on equal times, the
setting from the node with the greater id wins, then the greater value); an unset replicates too. A value is at most
4096 characters, with no control characters other than tab. Values are plain pool state: every member sees and stores
them, so they are not for secrets (tokens have their own path). Some names cannot be set through `env.*`, because
meddle sets them itself or because they would let a member take over another node's processes: `PATH`, `HOME`,
`CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_PROJECT_DIR_NAME`, `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `JJ_USER`, `JJ_EMAIL`, `JJ_CONFIG`, `GIT_CONFIG_GLOBAL`,
`GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_COUNT`, `GIT_DIR`, `GIT_SSH_COMMAND`, `GIT_EXEC_PATH`, `XDG_CONFIG_HOME`,
`LD_PRELOAD`, `LD_LIBRARY_PATH`, `LD_AUDIT`, `NODE_OPTIONS`, `BASH_ENV`, and every name starting `MEDDLE_`,
`GIT_CONFIG_KEY_` or `GIT_CONFIG_VALUE_`. `config set` refuses them and any value it cannot take; a node ignores such
a setting from a peer, logging `meddle: settings: ignored replicated key "<key>"` once per key. A node that joins
another pool drops its old pool's settings and takes the new pool's.

### `meddle pool`

```sh
bun run src/cli.ts pool
```

prints one line per node in the roster:

```
<short id> <hostname> <online|offline|removed> meddle <version> claude <claude code version> tasks <n>
```

with `(this node)` after this node's line.

### Environment

| Variable | Default | |
| --- | --- | --- |
| `MEDDLE_PORT` | `7777` | The localhost port of the dashboard and of the socket the CLI talks to the node on. |
| `MEDDLE_DATA_DIR` | `~/.local/share/meddle` | The node's data: database, secrets, replicas, memory, archives. |
| `MEDDLE_TASK_ROOT` | `/opt/meddle/tasks` | Where tasks' folders are made (see [Task root](#task-root)). |
| `MEDDLE_GIT_SOCKET` | `<data dir>/git.sock` | The unix socket the git remote helper reaches the node at (see [`meddle://` remotes](#meddle-remotes)). |
| `MEDDLE_ENV_PASSTHROUGH` | `TERM LANG LC_ALL SHELL TMPDIR XDG_RUNTIME_DIR SSL_CERT_FILE SSL_CERT_DIR NODE_EXTRA_CA_CERTS HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy` | The space-separated names of this node's environment passed on to every task's Claude Code (besides `PATH` and `HOME`). |
| `MEDDLE_MAX_RUNNING` | the pool's `limits.running` | How many turns this node runs at once before placement treats it as full, overriding the pool setting here; a non-negative integer, `0` unlimited. |
| `MEDDLE_LIGHTHOUSE_URL` | the pool's `lighthouse.url`, else `https://iroh.ichor.io` | The lighthouse for discovery, overriding the pool setting here; empty turns discovery off. |
| `MEDDLE_DISCOVERY_POLL_MS` | `10000` | How often a node looks its pool's topic up; at least `500`. |
| `MEDDLE_IROH_PRESET` | `n0` | iroh's `n0` preset (number 0's public relays and address lookup), or `minimal`: no relays and no address lookup, so nodes reach each other only at direct addresses (loopback setups and tests). |
| `MEDDLE_IROH_BIND` | iroh's default | The address iroh's UDP socket binds, as `<ip>:<port>`. |
| `MEDDLE_JJ_NETWORK_TIMEOUT_MS` | `120000` | How long a jj fetch or push with another node may take before meddle kills it (with its git processes) and fails it as `jj <args> timed out after <ms> ms`. A clone (from a peer or from an upstream) may take ten times as long. |

## Projects and tasks

With the node running (see [Dashboard](#dashboard)), add a project from an existing folder or an upstream URL, then
create a task on it and send it a prompt:

```sh
bun run src/cli.ts project add ~/src/myproject [--name myproject]   # prints the project id
bun run src/cli.ts project list
bun run src/cli.ts task new --title "Fix the flaky test" --project <project-id>   # prints the task id
bun run src/cli.ts task prompt <task-id> "Find out why test_sync is flaky and fix it"
bun run src/cli.ts task retry <task-id>   # runs a turn again that repeated crashes parked
bun run src/cli.ts task move <task-id> <node> [--now]   # moves the task to another node
```

`project list` prints one line per project this node holds: `<id>  <name>  <replica>  home <short id>`. A task is
`idle`, `running` or `waiting` (for an approval) while it lives on a node; a task moving away is `moving` on the node
it leaves and `receiving` on the node it goes to until it arrives, and the node it left keeps it as `moved`.

## Projects across the pool

### Homes and replicas

The node a project is added on is its home, and the project keeps the id its home gave it on every node; adding the
same folder or URL on two nodes makes two projects. A task can be created on any node that hosts tasks. On a node
that has never seen the project, `task new --project <id>` (the id from the home's `project list` or the dashboard's
Projects view) asks the online members which of them holds it, then clones the project from its home into
`<data dir>/replicas/<id>` and its memory into `<data dir>/memory/<id>`. The dashboard's new-task form offers the
projects the chosen node already holds.

A new task starts from the home's `trunk`. On the home, meddle keeps a local `trunk` bookmark in the project's repo
(your own folder, for a folder project) at the newest of jj's `trunk()` (the upstream's main, master or trunk) and
the local `trunk`, `main` and `master` bookmarks. It moves it when the project is added, when a task is created on
the home, and before another node fetches the project. Another node fetches `trunk` from the home as it creates a
task, so creating a task of a project homed elsewhere needs the home online (`home <short id> is offline`
otherwise). A project with nothing trunk-like starts its tasks at the root.

At the end of every completed turn meddle points each of the task's bookmarks, `meddle/task/<task id>/<project name>`, at its
workspace's working copy, and a node that is not the project's home pushes the bookmark to the home, so the home
holds every task's latest work. A push that fails (the home offline, no jj identity: see [Install](#install)) does not fail the turn: it is
logged as `meddle: git: push of <bookmark> to <short id> failed: …` (each distinct line at most once a minute, so a
missing identity does not fill the log), and the next turn end pushes again. A turn that fails pushes nothing; the
next completed turn pushes its work too.

A replica names its remote for another node after that node's short id, the first 10 characters of its node id, so
on a node that is not the home `trunk@<short id>` is the home's trunk.

The dashboard's Projects view lists every project of the pool once, merged across the online nodes that hold a copy:
its home, the nodes holding it, and each node's bookmarks (`name`, `name@<short id>`, or `name@origin` for a project
added from an upstream URL, with its change id, flagged when conflicted). It also adds a project on this node.

### Memory

Each project has a memory repo on every node that holds it, `<data dir>/memory/<project id>`, shared under the
`memory` bookmark. It is the memory directory of every task whose primary project it is (linked into the task's
Claude Code config). A folder project's starts from the memory Claude Code already keeps for that folder, if any.

The memory of a task's primary project is synced around each of its turns, on every node, except while another task
whose primary project is the same has a turn running on this node (a task that only uses the project as a second
project does not count): its session is reading and writing the same files, so the sync waits for the last of them
to end.

- Before a turn: a node that is not the home fetches `memory` from the home, and the memory repo's working copy is
  rebased onto `memory` when it is not already on it.
- After every completed turn: what the turn wrote is committed as `memory from <short id>`, `memory` moves onto it
  (rebased first when `memory` has moved meanwhile), and a node that is not the home pushes it to the home. A turn
  that ends while another such task is still running leaves this to that task's turn end, which commits what both
  wrote.

A conflict between two nodes' edits stays in the files as jj's conflict markers, for a later session to tidy. jj
will not push a commit with conflicts, so until then this node's memory does not reach the home (each turn end logs
why); the turn end after the tidy-up folds it into the conflicted commit, which then pushes as usual. A
`memory` bookmark that is itself conflicted takes the home's when the home's is clean, and otherwise one of its own
targets, logged as `meddle: git: memory of <short id> had a conflicted bookmark; resolved to <change>`. A sync that
fails is logged as `meddle: git: memory of <short id> was not synced before the turn: …` (or `after`) and the turn
goes ahead; the next turn tries again.

### `meddle://` remotes

Nodes move repos with git, over the pool's iroh connections. Before anything runs jj, `serve` writes into the data
directory:

- `bin/git-remote-meddle`, git's remote helper for `meddle://<node id>/project/<project id>` and
  `meddle://<node id>/memory/<project id>` URLs. It runs `meddle git-remote`, which passes git's connection through
  this node's git socket to the other node.
- `git-hooks/update`, the hook every push from another node meets (below).

It then listens on that socket, `<data dir>/git.sock` (mode 600; `MEDDLE_GIT_SOCKET` names another), replacing a
stale socket file and refusing to start when another meddle serves it.

meddle puts `<data dir>/bin` first on `PATH` and sets `MEDDLE_GIT_SOCKET` for every jj it runs and every Claude Code
it starts, so jj and git inside a task reach `meddle://` remotes too. Your own jj in a terminal needs the same, in a
replica or in a folder project that has a remote for another node (one is added for each node a task of the project
moved here from). Add to your shell profile, with your data directory if `MEDDLE_DATA_DIR` names another:

```sh
export PATH="$HOME/.local/share/meddle/bin:$PATH"
export MEDDLE_GIT_SOCKET="$HOME/.local/share/meddle/git.sock"
```

Without `MEDDLE_GIT_SOCKET` the helper uses `<data dir>/git.sock`. With no node running it fails at once with
`meddle: cannot reach this node's git socket at <path> (is "meddle serve" running?)`, and when the other node is
offline or does not hold the repo with `meddle: <short id> did not serve <repo> (offline, or it does not hold it)`.

A node serves only members of its pool, only the repos it holds, and only fetches (`upload-pack`) and pushes
(`receive-pack`); it logs a request for a repo it does not hold as `meddle: git: unknown repo <repo>`. A push runs
under the `update` hook, which accepts task bookmarks (`refs/heads/meddle/task/*`) into a project repo and the
`memory` bookmark into a memory repo, and refuses deletions (`meddle: deleting <ref> is not accepted here`) and every
other ref (`meddle: ref <ref> is not accepted here`). So `trunk` and your own bookmarks change only on the home,
whatever another node, or a model pushing from inside a task, sends it. While the hook is missing or cannot run, the
node refuses every push, logging `meddle: git: update hook missing; refusing receive-pack` (`serve` writes it again
at start). A push it took is imported into jj without snapshotting the repo's working copy, and a fetch of a project
homed here moves `trunk` the same way: your edits in a folder project are never recorded by another node's fetch or
push. One consequence: if your own `@` on the home is built on a running task's bookmark and the task's next push
rewrites that commit, jj reports your working copy as stale at your next command; `jj workspace update-stale`
brings it back.

What a member can push: the whole `refs/heads/meddle/task/*` namespace of every project repo and `refs/heads/memory`
of every memory repo, on any node that holds them. So a model inside any task on any node can push over another
task's bookmark on the home (its backup) or move `memory` there. The task's owner sets and pushes its bookmark again
at its next turn end, the next memory sync builds on whatever `memory` then is, and jj's operation log on the home
keeps every earlier target (`jj op log`), so nothing is lost; but within the pool, task bookmarks and memory are not
protected from each other.

## Moving a task

A task moves to another node of the pool from its view in the dashboard (Move to, with an optional "move now") or
from the CLI:

```sh
bun run src/cli.ts task move <task-id> <node>         # waits for the running turn, if any, to end
bun run src/cli.ts task move <task-id> <node> --now   # interrupts it
```

`<node>` is a node id or a unique prefix of one, such as the short ids `meddle pool` prints. The command prints
`moving <task-id> to <short id>` once the move has started; the node runs it to its end as a durable task, across
restarts.

### Who can take a task

A move is refused before it starts unless the target is another online member of the pool, hosts tasks, and reports
the same Claude Code version as this node, with neither reporting `unknown` (as a node served from the compiled
binary does). The refusal names the reason, such as `<short id> does not host tasks` or
`claude code <version> here, unknown there`. A task that is already moving, has moved or is being received is refused
too, as is one whose turn is parked (retry it first). The dashboard offers only the nodes that can take the task.

### What travels

- The task's workspaces. meddle points each task bookmark at its workspace's working copy; the target fetches the
  bookmarks from this node and starts its workspaces from them. Edits not yet committed travel in the working-copy
  commit; files git ignores do not. The target first clones any project it does not hold from the project's home,
  so moving a task of a project the target has never held needs the home online.
- The conversation: the task's event log, the transcript mirror's rows, and Claude Code's transcript files in the
  task's config dir (the session and its subagents' transcripts with their sidecar files). Symlinks are skipped (the
  memory link among them).
- The task's title, session, settings (model, effort, permission mode), turn count and queued prompts.

The transfer is checked: the target answers with its counts and a SHA-256 over everything it received, and a
mismatch fails the move. What does not travel: background shells and subagents (see "Move now" below); the rest of
the task's Claude Code config dir, which the target sets up as for a new task; and memory, which the target syncs
with the project's home around the task's turns there, as for any task.

### Steps

While a task moves, its view shows `Moving to <node>: <step>` and disables its controls and composer.

1. `prepare` checks the move again, marks the task `moving` and waits for its turn to end (or interrupts it).
2. `handoff` sets the task bookmarks; the target clones what it lacks, fetches them and provisions the task as
   `receiving`; then the task's log, transcript and files go over one stream, and the two sides' receipts must match.
3. `commit` has the target activate the task (it is `idle` there, and its queued prompts start), and records it here
   as `moved`.
4. `cleanup` archives and removes this node's copy.

### "Move now"

A move waits for a running turn to end. "Move now" (`--now`) interrupts the turn instead, and closes it if it has not
ended 15 seconds later. Background shells and subagents that the turn started stop and do not travel; the dashboard
warns of this but cannot list them (the Agent SDK has no way to). When a turn was cut short, the task's first turn
on the target starts with:

> The previous turn was interrupted to move this task to another machine. Background shells and subagents that were
> running were stopped and did not travel. Carry on from where you were; do not redo work that is already done.

### Prompts during a move

While the move waits for the turn to end (`prepare`), a prompt sent to the task (with `task prompt`; the dashboard's
composer is disabled) is queued and travels with it; `task prompt` then prints
`queued; it runs once the task has arrived` and exits rather than waiting for a turn that runs on the other node. Later in the move a prompt is refused with
`task is moving; send it again once it has arrived`; interrupting, retrying and changing settings are refused with
`task is moving` throughout. On the target the queued prompts, after the "move now" text if there is one, run one
turn each, in order, each recorded as your prompt.

### When a move fails

Until the target's receipt is recorded, any failure rolls the move back: the target drops its partial copy, the task
is live here again (prompts queued meanwhile run here), `meddle: move: <task id> failed at <step>: <error>` is logged
and the dashboard notifies `Move to <short id> failed at <step>: <error>`.

After the receipt is recorded, the move is rolled back only on a definite answer from the target: it could not
activate the task, or holds no copy of it from this node. Without an answer (the target went offline, the link
dropped, 30 seconds passed) the target may already be running the task, so the move does not roll back: the task
stays `moving` here and this node asks again, after 2 seconds doubling up to 30, logging
`meddle: move: <task id> waits for <short id> to activate it: …`, until it gets one.

A node restarted in the middle of a move resumes it from its last step. A node restarted while it was receiving a
task drops the partial copy. A task left `moving` with no move behind it is made live again at start, logged as
`meddle: move: <task id> was left moving with no move in progress; it is live here again`; one whose move kept
crashing the node in `prepare` or `handoff` until it was parked is made live again too and its move given up, logged
as `meddle: move: <task id> to <short id> at <step> parked; released` (a move parked in `commit` is left, as the
target may have the task). A task that is live again keeps a turn that is being rerun (`running`), never `idle`
under it. A step of a move that was already rolled back here goes no further: the move ends
`failed at <step>: task is no longer moving`.

### On the node a task left

Once the target has activated the task, this node writes its archive, `<data dir>/archive/<task id>.json.gz`
(directory mode 700, file 600: the task's row, manifest, event log, transcript rows and transcript files), before it
removes anything. It then forgets the task's workspaces and, unless it is the project's home (where they stay as the
backup), its task bookmarks, and removes the task folder (with its Claude Code config dir) and its event and
transcript rows. The task's row stays, as `moved`: its view here says where it went and links there, and commands on
it answer `task has moved to <short id>`. A task can move back to a node it left.

A janitor deletes archives older than seven days, when `serve` starts and every 24 hours after. meddle has no
command to restore one.

## Known limits

- A project's home cannot be moved to another node yet (planned for Plan 4). While the home is offline, other nodes
  cannot create tasks of its projects or clone them; their tasks' turns still run, and their pushes and memory syncs
  are logged and retried at the next turn end.
- When a node's last push of a project's memory to the home failed, the memory commits it has not pushed do not
  travel with a task that moves away: the target syncs memory from the home. They stay in this node's memory repo
  and reach the home only with a later turn of that project here.
- A node whose Claude Code version is `unknown` (served from the compiled binary) cannot move tasks, either away or
  to it.
- Background shells and subagents do not travel on "move now", and the dashboard cannot list them.
- When a node restarts in the middle of a turn, the turn's rerun resumes the session and tells Claude to carry on;
  text you sent into that turn that Claude Code had not yet written to its transcript is not sent again.

## Dashboard

```sh
bun run src/cli.ts serve
```

Then open <http://127.0.0.1:7777/> (`MEDDLE_PORT` changes the port). The dashboard binds to localhost only.

The dashboard of any node shows the whole pool: a card per node with its state (online, offline or removed); the
notifications of every online node; and a form for a new task on any online node that hosts tasks. An online node's
card shows its meddle and Claude Code versions, token, task root, resources and tasks. An offline member's card shows
what the roster last recorded of it (its versions, whether it hosts tasks and how many tasks it has) and when it was
last seen; a removed node's card says only that it was removed. It flags a pool whose members run different meddle
or Claude Code versions. The Projects view lists every project of the pool (see
[Homes and replicas](#homes-and-replicas)), and a task's view moves it (see [Moving a task](#moving-a-task)).

Another node's tasks open through the pool: the browser opens `/ws/node/<node id>` on the node it loaded the page
from, and that node carries the socket to the other one over iroh. A node that is not a member answers 404 and an
offline member 503. Settings shows this node's id, the pool id, the members, invites, joining another pool and the
tokens in order, with the one a turn would use now marked active.

## Service

To run the node as a systemd user service, look at what would be installed first:

```sh
bun run src/cli.ts service install --dry-run
```

It prints the unit (`ExecStart=<bun> run src/cli.ts serve` with `WorkingDirectory=` this checkout) and the task-root
command. Without `--dry-run` it writes `~/.config/systemd/user/meddle.service`, runs `systemctl --user daemon-reload`
and `systemctl --user enable --now meddle.service`, and prints the task-root command to run once.

## Links

- [Design](docs/superpowers/specs/2026-10-30-meddle-design.md)
- [Plan 1: single node](docs/superpowers/plans/2026-10-30-meddle-single-node.md)
- [Plan 2: pool over iroh](docs/superpowers/plans/2026-10-31-meddle-pool.md)
- [Plan 3: repos across the pool and task moves](docs/superpowers/plans/2026-10-31-meddle-mesh.md)
