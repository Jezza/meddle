# meddle

meddle is a service you run on each of your machines to drive Claude Code sessions through the Agent SDK, so that a
task is created in one place and worked on wherever you assign it. Each task is a folder of jj workspaces with one
Claude Code session running in auto mode, which you watch, approve, interrupt and steer from a browser dashboard with
the fidelity of sitting at that machine's terminal. The services find each other and form one pool, sharing one
set of Claude logins and each project's memory, and a task can move between machines without losing its conversation.

Status: Plan 4, settings, tokens, placement, archive and spawn. Nodes form a pool over iroh: they find each other
through a lighthouse, share their settings and an ordered list of login tokens (a turn whose login hits a limit
switches to the next), and the dashboard of any node shows every node and opens its tasks. meddle places a new task
on a node unless you name one, a task may have no project, and `spawn` creates a task and sends its first prompt in
one command. A project's repo and memory follow its tasks to whichever node they run on, a task moves between nodes
with its workspaces, conversation and queued prompts, and an idle task can be archived off its node and restored on
any node. Moving a project's home to another node is not here yet (see [Known limits](#known-limits)).

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

The dashboard's Settings view lists the same tokens, and its Enable button does what `token enable` does for an
`exhausted` or `disabled` one; adding and removing stay on the CLI, so a value never passes through the dashboard.

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

During a turn, a `rate_limit_event` whose status is `rejected`, or an assistant message whose error is `rate_limit`,
marks the turn's token `exhausted` until the limit's reset time (one hour from now when the event gives none), with
the limit's type as its reason. The errors `billing_error`, `account_on_hold`, `authentication_failed`,
`oauth_org_not_allowed` and `verification_required` mark it `disabled` until `token enable`. The mark replicates, so
every node of the pool stops using that token. If the turn ended with an error and another token is usable, the turn
then runs once more with it, in the same session, sending this instead of the original message (a turn that succeeded
all the same, past a limit Claude Code retried, is only marked):

> The previous attempt at this message failed because the login it used hit a usage limit; meddle switched to another
> login. If you had not started on it, start now; otherwise continue where you left off and do not redo finished work.

(The original message is sent again when the session has no transcript yet to resume.) The failed attempt stays in
the task's log, followed by a status line `Token <label> exhausted until <time>; switching login`. A turn reruns for
its token at most once. When no other token is usable, the turn ends there and the node raises a notification of kind
`token` (`token <label> exhausted until <time>; no other token`, `token <label> disabled: <reason>; no other token`),
instead of a `failed` one. When the rerun's token fails too while yet another token is usable, the turn also ends,
with `token <label> exhausted until <time>; already switched login once, send the message again to use the next
token` (or the `disabled: <reason>` form; the status line ends `already switched login once`). A turn that finds no
usable token at all fails with `no usable token` and raises a `token` notification saying so. A service restart
after the fault is logged reruns the turn once with the next token when it starts again (before the fault is logged,
the message is sent again). `meddle task prompt` follows a turn through its token rerun: it exits 0 when the rerun
succeeds, and fails with the `token` notification's text when the turn ends there.

The token commands work on the node's database and secrets directory directly, with or without a running node, so a
value never goes over the node's socket; when a node runs, they tell it and it tells the pool. `token list` reads the
database read-only and, before the node's first start, prints only `active: none`.

A node that ran an older meddle with a single token (`secrets/claude-token`) imports it at its next `serve` as the
token labelled `default`, keeping when and by whom it was set; the old value file is deleted and its meta file renamed
to `*.migrated`. Until that `serve`, `token list` and `status` show no token. `serve` also removes what a crash can
leave in `secrets/tokens`: a half-written `*.tmp` and the value of a removed token.

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
removed. A pull that fails (that member has not pulled the value yet, or is unreachable) is tried again at the node's
next self refresh, every 15 seconds, from an online member that lists the token. A value crosses the network only as the answer to a request from a current member for a token the answering
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
`start "meddle serve" first`. The dashboard's Settings view lists the settings with the node that set each, unsets
one, and sets a key picked from the table below (an `env.` key with the name typed).

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
create a task on it and send it a prompt, or do both at once with `spawn`:

```sh
bun run src/cli.ts project add ~/src/myproject [--name myproject]   # prints the project id
bun run src/cli.ts project list
bun run src/cli.ts task new --title "Fix the flaky test" --project <project-id|name>   # prints: task <id> on <node>
bun run src/cli.ts task prompt <task-id> "Find out why test_sync is flaky and fix it"
bun run src/cli.ts spawn "Find out why test_sync is flaky and fix it" --project myproject   # prints: task <id> on <node>
bun run src/cli.ts task retry <task-id>   # runs a turn again that repeated crashes parked
bun run src/cli.ts task move <task-id> <node> [--now]   # moves the task to another node
bun run src/cli.ts task archive <task-id>   # takes an idle task's folder off its node, keeps its log
bun run src/cli.ts task restore <task-id> [--node <id|prefix> | --here]   # brings an archived task back, here or on another node
bun run src/cli.ts task delete <task-id>    # deletes an archived or moved task's log and archive
```

`spawn <prompt> [--project <id|name>]... [--node <id|prefix> | --here] [--title <t>]` creates a task, places it like
`task new` (see [Where a new task runs](#where-a-new-task-runs)) and sends it the prompt as its first turn, which starts
on the node chosen; it prints `task <id> on <short id>` once the turn has started, not when it ends (follow it in the
dashboard, or send the next prompt with `task prompt`). The title defaults to the first 60 characters of the prompt's
first line. `--project` is repeatable, one project each, the first the primary; with none the task has no project.

`project list` prints one line per project of the pool, from what each node's summary in the roster says (this node
included), so it works while a holder is offline: `<id>  <name>  home <short id>  on <short id>,<short id>,…`, named as
its home names it, with the nodes that hold a copy after `on`. `--project` (of `task new` and `spawn`) takes a
project's id, or a name exactly one project of the pool has: `ambiguous project name: <name>` when several have it,
`unknown project: <x>` when none does (pass the id then). An id the roster does not list yet (12 hex digits) is
passed on to the node, which asks the online members for it. A task is
`idle`, `running` or `waiting` (for an approval) while it lives on a node; a task moving away is `moving` on the node
it leaves and `receiving` on the node it goes to until it arrives, and the node it left keeps it as `moved`. An
archived task is `archived` (see [Archiving a task](#archiving-a-task)).

### Where a new task runs

`task new` creates the task on the node meddle picks for it, and prints `task <id> on <short id>`; `--here` creates
it on this node and `--node <id|prefix>` on that member (an id or a unique prefix of one; `no such node: <x>`
otherwise). The dashboard's new-task form has the same choice: `Automatic` (the default) or one of the online nodes
that host tasks; the form also takes a first prompt, and needs no project.

meddle picks among the online members that host tasks (have a task root) and run fewer tasks (`running` or `waiting`)
than their limit, `limits.running` (see [Pool settings](#pool-settings); `MEDDLE_MAX_RUNNING` on a node overrides it,
and `0` is no limit). Of those it prefers the home of the task's first project; else the nodes holding a copy of every
project of the task; else any of them. Ties go to the fewest running tasks, then the fewest tasks, then the lower
node id. With no node to pick, creation fails with `no online node hosts tasks` or `every node is at its running
limit`; when this node is the only member, or the only one online, it says why this node cannot take it: `this node
has no task root`, or `this node is at its running limit; use --here` (`--here` skips the limit). A pick or a named
node never skips the task's own checks there: that node refuses a create without a task root or a usable token as it
would locally, and its refusal reaches you prefixed with its short id (`<short id>: <reason>`).

meddle picks from what the roster says of each node: every node reports its running count, its limit and the
projects it holds with its summary, at once when a task starts or ends, a task is created or a project is added, and
every 15 s. The node that took the request asks the chosen node to create the task (and to run its first prompt, when
one is given); the task is born there, no move involved. Only a member may ask. A node of an older meddle reports none
of this: it counts as idle, with no limit and no projects, and it cannot create a task for another node, so a task
placed on it fails; name a node with `--node` or `--here` while the pool upgrades. Worse, an older node reports
`running` 0, so placement tends to pick it. Upgrade every node of the pool together: the nodes' peer interface
gained calls in this release without a new version, so a newer node cannot use an older node's at all: it can neither
create a task there nor move one to it.

### Tasks without a project

A task may have no project: `spawn` without `--project`, `task new` without `--project`, or the dashboard's form with
no project ticked. Claude Code then starts in the task folder with the user settings layer only and
`CLAUDE_CODE_PROJECT_DIR_NAME` unset, so its memory and transcript key on the task folder inside the task's config
directory: they travel with the task and end with it, and nothing syncs them. The task folder holds only a generated
`CLAUDE.md` saying so; it is scratch space that moves with the task. Such a task has no bookmarks, pushes nothing and
syncs no memory; meddle places it by load alone. A task with a project keeps per-project memory as before.

Claude Code keys the transcript and memory of such a task on the task folder's path, and meddle does not shorten a
long path the way Claude Code does when it makes that key, so a task without a project under a very long task root
may not resume its session.

## Projects across the pool

### Homes and replicas

The node a project is added on is its home, and the project keeps the id its home gave it on every node; adding the
same folder or URL on two nodes makes two projects. A task can be created on any node that hosts tasks. On a node
that has never seen the project, `task new --project <id>` (the id from the home's `project list` or the dashboard's
Projects view) asks the online members which of them holds it, then clones the project from its home into
`<data dir>/replicas/<id>` and its memory into `<data dir>/memory/<id>`. The dashboard's new-task form offers every
project the online members hold.

A new task starts from the home's `trunk`. On the home, meddle keeps a local `trunk` bookmark in the project's repo
(your own folder, for a folder project) at the newest of jj's `trunk()` (the upstream's main, master or trunk) and
the local `trunk`, `main` and `master` bookmarks. It moves it when the project is added, when a task is created on
the home, and before another node fetches the project. Another node fetches `trunk` from the home as it creates a
task, so creating a task of a project homed elsewhere needs the home online (`home <short id> is offline`
otherwise), unless this node has fetched the home's `trunk` before: it then starts the task from that `trunk@<short
id>` and logs `meddle: project <name>: home unreachable; starting from the last fetched trunk`. A project with nothing
trunk-like starts its tasks at the root.

A task's bookmarks all live under its namespace, `meddle/task/<task id>/`, in each project's repo: the project's own
bookmark `meddle/task/<task id>/<project name>`, and any side bookmark the agent (or you) adds as
`meddle/task/<task id>/<project name>.<label>`, for example `meddle/task/<task id>/app.spike`. The task's
`CLAUDE.md` tells the agent so. The label follows a dot, not a slash: git keeps refs as files, so it cannot hold
`…/app` and `…/app/spike` side by side, and refuses the second. Everything under the namespace is backed up, travels
when the task moves (see [What travels](#what-travels)) and is listed in the task's view on the dashboard (its name
after the namespace and its change id; re-read when the task changes state and every 60 s); bookmarks outside it are
not backed up and stay behind on a move.

At the end of every completed turn meddle points the task's project bookmark at its workspace's working copy, and a
node that is not the project's home pushes the whole namespace to the home. That push is the backup: the home never
fetches a task's bookmarks itself. What the node holding the task changed since its last push wins: its positions
replace the home's, sideways or backwards too. A bookmark it did not change follows the home: one deleted or moved
in the home's repo is deleted or moved on the holder at the next turn end, so a side bookmark is deleted on the home.
The home refuses deletions pushed to it, so a side bookmark deleted on the holder comes back from the home's copy at
the next turn end: while the task is on a node that is not the home, delete a side bookmark in the home's repo. A
push that fails (the home offline, no jj identity: see [Install](#install), a bookmark git refuses, such as one with
a slash after the project name, which fails every turn end's push until it is deleted) does not fail the turn: it is
logged as `meddle: push: meddle/task/<task id>/* to <short id> failed: …` (each distinct line at most once a minute,
so a missing identity does not fill the log), and the next turn end pushes again. When the home refuses one
bookmark, the others still land. A turn that fails pushes nothing; the next completed turn pushes its work too.

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

- The task's workspaces. meddle points each task bookmark at its workspace's working copy; the target fetches every
  bookmark under the task's namespace from this node, side bookmarks included, and starts its workspaces from the
  project bookmarks. Edits not yet committed travel in the working-copy
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
2. `handoff` sets the task bookmarks; the target clones what it lacks, fetches the task's namespace and provisions the task as
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

Once the target has activated the task, this node writes what it leaves of it, `<data dir>/moved/<task id>.json.gz`
(directory mode 700, file 600: the task's row, manifest, event log, transcript rows and transcript files, in the same
format as an [archive](#archiving-a-task)), before it removes anything. It then forgets the task's workspaces and, unless it is the project's home (where they stay as the
backup), every bookmark under the task's namespace, and removes the task folder (with its Claude Code config dir) and its event and
transcript rows. The task's row stays, as `moved`: its view here says where it went and links there, and commands on
it answer `task has moved to <short id>`. A task can move back to a node it left.

A janitor deletes the files in `moved/` older than seven days, when `serve` starts and every 24 hours after; meddle
has no command to restore one. An earlier meddle kept them in `<data dir>/archive/`: the janitor applies the same rule
there and removes that directory once it is empty. It never touches `archives/`, the archives of archived tasks.
`task delete <task-id>` deletes a `moved` task's row (and its file in `moved/`) at once.

## Archiving a task

An idle task can be archived on the node that holds it, from its view in the dashboard (Archive) or with
`task archive <task-id>`: meddle writes the task's files to `<data dir>/archives/<task id>.json.gz` (directory mode
700, file 600: the task's row, manifest, event log, transcript rows and the transcript files under its Claude Code
config dir), forgets its workspaces, removes its folder, keeps its event and transcript rows, and records the row as
`archived` on this node. The task's bookmarks stay as a move's cleanup leaves them: on a project's home they stay as
the backup, on any other node they are forgotten after the push below. Only committed work (in the bookmarks) and the
conversation survive an archive: files git ignores inside a workspace are lost with the folder. Archives are kept
until the task is restored or deleted; the seven-day janitor never touches them.

An archived task renders read-only from its rows in its view (its thread, no composer and no controls), with Restore
and Delete as the only actions. The pool view lists the archived tasks of every online node in one "Archived" list,
each with the node that holds it, with Restore and Delete links. Prompts, moves and the other controls answer
`task is archived: <id>`.

Only an idle task archives: one with a turn running or waiting, prompts queued, or a move in progress is refused
(`task is running`, `task has queued prompts`, `task is moving`, …). On a node that is not a project's home, the
archive first sets the task's bookmarks and pushes every bookmark under its namespace to the home, as a turn end does:
once this node forgets them, the home's copy is the only one. The home must be online, or the archive is refused with
`cannot archive: home <short id> of <project> is offline`, and a push that fails refuses it with the push's error;
either way the task stays idle and in place. A bookmark git refuses (such as one with a slash after the project name,
see [Homes and replicas](#homes-and-replicas)) therefore blocks every archive of the task on a node that is not the
home until it is deleted.

`task restore <task-id> [--node <id|prefix> | --here]` (or Restore, whose node select defaults to Automatic) brings
the task back, on any node that can take it. Without `--node` or `--here` meddle places it as it places a new task of
the task's projects (see [Where a new task runs](#where-a-new-task-runs)): the primary project's home first. The node
holding the archive runs it: `task restore` on that node, or Restore in the dashboard of any node.

On the node it was archived on (`--here`, or placement picks it), each project's workspace starts on the task's
project bookmark (on the project's home, the local one; elsewhere, fetched from the home with the rest of the task's
namespace, so the home must be online: `cannot restore: home <short id> of <project> is offline`), the folder is
provisioned again from the manifest, and the archive's files are unpacked into it (a task without a project's
transcript into this node's slot). The task is `idle` again, its next turn resumes its session, and the archive is
deleted; a restore that fails leaves the task archived. It prints `task <task-id> on <short id>`.

On another node, the archiving node runs the [move procedure](#moving-a-task) with the archive as its source: it is
refused as a move is (an offline target, one that hosts no tasks, another Claude Code version, …), the task is
`moving` meanwhile (prompts answer `task is being restored; send it again once it has arrived`), and there is no turn
to wait for. Since the archiving node has no workspace to set the task's bookmarks from, it first stages them: for
each project homed on another node, it fetches every bookmark under the task's namespace from the home (which must be
online: `home <short id> of <project> is offline` fails the restore) and sets them as local bookmarks, so the target
fetches them from it as in any move; on a project's home they are there already. It then sends the same frames a move
sends, read from the archive, under the same receipt rule. Once the target has activated the task (its next turn
resumes the session, with no follow-up prompt), the archive becomes the move's leftover in `<data dir>/moved/` (kept
seven days, see [On the node a task left](#on-the-node-a-task-left)), the staged bookmarks are forgotten again off the
home, the event and transcript rows go, and a `moved` row remains. A restore-move that fails (the target refuses, the
home is offline, a restart parks it) leaves the task `archived` here again, its archive intact and nothing staged. The
command prints `restoring to <short id>` once the move has started and returns; the move goes on in the background,
and the task's view in the dashboard shows how it goes (`status` does not).

`task delete <task-id>` (or Delete) deletes an archived task's archive, row, event log and transcript rows; it is
refused for a task that is not archived or moved (`task is idle`, …). The bookmarks the home keeps for the task stay;
`jj bookmark delete 'glob:meddle/task/<task id>/*'` in the project's repo on the home removes them.

## Known limits

- A project's home cannot be moved to another node yet (left for a later plan). While the home is offline, other nodes
  cannot clone its projects, and create tasks of them only from the `trunk` they fetched last; their tasks' turns still run, and their pushes and memory syncs
  are logged and retried at the next turn end.
- When a node's last push of a project's memory to the home failed, the memory commits it has not pushed do not
  travel with a task that moves away: the target syncs memory from the home. They stay in this node's memory repo
  and reach the home only with a later turn of that project here.
- A node whose Claude Code version is `unknown` (served from the compiled binary) cannot move tasks, either away or
  to it.
- Background shells and subagents do not travel on "move now", and the dashboard cannot list them.
- When a node restarts in the middle of a turn, the turn's rerun resumes the session and tells Claude to carry on;
  text you sent into that turn that Claude Code had not yet written to its transcript is not sent again.
- Every node of a pool must be upgraded together: the nodes' peer interface gained calls without a new version, so a
  newer node cannot use an older node's at all (no task created there, no move to it), and placement tends to pick an
  older node, which reports no running turns (see [Where a new task runs](#where-a-new-task-runs)).
- The commits meddle makes no longer need a jj user config on each node: the pool's `jj.user` and `jj.email` settings
  give every node one identity (see [Install](#install)). Without them, and without a node's own config, pushes to a
  project's home fail.
- A side bookmark cannot be deleted on a node that is not the project's home while the task is there: the home
  refuses deletions and the next turn end restores it. Delete it in the home's repo. A bookmark name git refuses (a
  slash after the project name) fails every turn end's push, and every archive of the task off the home, until it is
  deleted.
- Deleting a task leaves its bookmarks in each project's repo on the home; `jj bookmark delete
  'glob:meddle/task/<task id>/*'` there removes them.
- Archiving on a node that is not a project's home needs every such home online: the push to the home is the archive's
  precondition. Files git ignores inside a workspace are lost on archive; only committed work and the conversation are
  kept.
- Archives in `<data dir>/archives/` are kept until the task is restored or deleted, however old; the files in
  `<data dir>/moved/` (what a task that moved away, or an archive restored on another node, left) are deleted after
  seven days, and meddle has no command to restore one.
- `task restore` to another node prints `restoring to <short id>` and finishes in the background: the dashboard shows
  its progress, `status` does not.
- Tokens from different organisations may not offer the same models: a turn that switches to the next token may run
  under a login whose organisation does not allow the task's model, and fail there.
- Claude Code keys a task without a project on its folder's path, and meddle does not shorten long paths the way
  Claude Code does, so such a task under a very long task root may not resume its session.

## Dashboard

```sh
bun run src/cli.ts serve
```

Then open <http://127.0.0.1:7777/> (`MEDDLE_PORT` changes the port). The dashboard binds to localhost only.

The dashboard of any node shows the whole pool: a card per node with its state (online, offline or removed); the
notifications of every online node; and a form for a new task, placed by meddle (the node select's Automatic, the
default) or on a chosen online node that hosts tasks (see [Where a new task runs](#where-a-new-task-runs)), with any
of the pool's projects or none, and an optional first prompt that starts the task's first turn. An online node's
card shows its meddle and Claude Code versions, token, task root, resources and tasks. An offline member's card shows
what the roster last recorded of it (its versions, whether it hosts tasks and how many tasks it has) and when it was
last seen; a removed node's card says only that it was removed. It flags a pool whose members run different meddle
or Claude Code versions. The Projects view lists every project of the pool (see
[Homes and replicas](#homes-and-replicas)), and a task's view moves it (see [Moving a task](#moving-a-task)) or
archives it (see [Archiving a task](#archiving-a-task)); the pool view lists every online node's archived tasks in
one "Archived" list naming the node that holds each, and Restore offers a node select (Automatic by default).

Another node's tasks open through the pool: the browser opens `/ws/node/<node id>` on the node it loaded the page
from, and that node carries the socket to the other one over iroh. A node that is not a member answers 404 and an
offline member 503.

Settings shows this node's id, the pool id, the members (with Remove), invites and joining another pool; then the
pool settings, as a table of key, value and the node that set it, each with Unset, and a form that sets a key picked
from `jj.user`, `jj.email`, `lighthouse.url`, `limits.running` or `env.<NAME>` (see [Pool settings](#pool-settings)),
under a note that every member and its dashboard see these values, so none is for a secret; then the tokens in
order (label, id, status, set by, expiry), with the one a turn would use now marked active and an Enable button on
each `exhausted` or `disabled` one. Token values never pass through the dashboard: tokens are added and removed with
the CLI.

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
- [Plan 4: settings, tokens, placement, archive and spawn](docs/superpowers/plans/2026-11-02-meddle-settings-placement-archive.md)
