# meddle

meddle is a service you run on each of your machines to drive Claude Code sessions through the Agent SDK, so that a
task is created in one place and worked on wherever you assign it. Each task is a folder of jj workspaces with one
Claude Code session running in auto mode, which you watch, approve, interrupt and steer from a browser dashboard with
the fidelity of sitting at that machine's terminal. The services find each other and form one pool, sharing one
set of Claude logins and each project's memory, and a task can move between machines without losing its conversation.

Status: peer repos, on top of Plan 4 (settings, tokens, placement, archive and spawn). Nodes given one pool secret form a pool over iroh:
they find each other through a lighthouse and prove the secret to each other, share their settings and an ordered list of login tokens (a turn whose login hits a limit
switches to the next), and the dashboard of any node shows every node and opens its tasks. meddle places a new task
on a node unless you name one, a task may have no project, and `task new` creates a task and sends its first prompt
in one command. Every node keeps a repo of every project, and
meddle works as a git remote spread over your machines: from a checkout on any of them you push branches to it, fetch
every task's work from it, start tasks from your own revisions, and accept a task's work by pushing a branch that
contains it. No machine is in charge and none has to stay on; pushes that overlap while machines can't see each other
show up as a conflict you resolve with an ordinary push. A task moves between nodes with its workspaces, conversation
and queued prompts, and an idle task can be archived off its node and restored on any node.

New here? The [user guide](docs/user-guide.md) says what has to run, how to set the first machine and the pool
up, and where things are; the sections below are the reference.

## Install

Each machine needs [jj](https://jj-vcs.github.io/jj/) 0.46.0 or later (a task's workspaces are made with
`jj workspace add --colocate`, which 0.45 lacks) and git, and either the single binary (see
[The single binary](#the-single-binary)) or a checkout run with [bun](https://bun.sh):

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
jj user config on the node) jj refuses to push the commits it makes, so the node's memory syncs to a project's home
fail and each turn end logs a `meddle: git: …` line saying so (see [Memory](#memory)).

The commands below run from the checkout as `bun run src/cli.ts <command>`; `bin/meddle` runs the same CLI from
anywhere once linked onto your `PATH` (`ln -s $PWD/bin/meddle ~/.local/bin/meddle`). `meddle help` lists every command with
what it does, and `meddle help <command>` (or `meddle <command> --help`) says more about one; on a terminal it is
coloured (`NO_COLOR` turns that off, `FORCE_COLOR` on).

### The single binary

```sh
bun run build                              # dist/meddle, for this machine
bun run build --target=bun-linux-arm64     # for another platform (a Raspberry Pi)
bun run build --embed-claude               # with Claude Code inside, for machines that cannot reach the npm registry
```

`bun run build` makes `dist/meddle`, one file that runs a node with nothing else installed but jj and git: no bun, no
checkout, no `node_modules`. It embeds bun, the dashboard (its page and bundled script), the service unit's template,
iroh's native modules (both the glibc and the musl build), and which Claude Code to run: the version the Agent SDK
pins, with the SHA-256 and size its manifest gives for the target platform's binary. About 150 MB on linux-x64. One
binary runs on one platform: the machine's own by default, or the `--target` given
(`bun-<linux|darwin|windows>-<x64|arm64>[-musl]`, a Bun compile target). On Linux the build picks the musl platform
when the machine has no glibc.

Copy it onto each machine's `PATH` (`~/.local/bin/meddle`, say) and use it as `meddle <command>`. When `serve` starts
and `<data dir>/bin/claude-<version>` is not there, it downloads the Agent SDK's platform package for that version
from the npm registry (`MEDDLE_NPM_REGISTRY`, `https://registry.npmjs.org` by default; about 140 MB for linux-x64),
unpacks Claude Code from it as it arrives, and installs it there (mode 755, in the data directory rather than a temp
directory, which may be mounted `noexec`) only if its size and SHA-256 are the pinned ones; turns run that file. It
logs `meddle: downloading Claude Code <version> (<platform>) from <url>`, then `… installed at <path> (SHA-256
verified)`. A download that fails or does not match stops `serve` with the reason, leaves nothing at that path, and is
tried again at the next start. Later starts find the file and download nothing.

`--embed-claude` puts Claude Code itself into the binary instead (about 450 MB on linux-x64, of which Claude Code is
285 MB): `serve` installs it from there, checked the same way, and never needs the registry. It needs the target
platform's Agent SDK package installed when building; `bun install` brings only this machine's, so for another
`bun add --no-save @anthropic-ai/claude-agent-sdk-<platform>` first (the build says which).

Either way the binary reports the pinned version, so nodes running the same build can move tasks between them, and so
can a node served from a checkout whose `node_modules` hold the same Agent SDK. Files of older versions in
`<data dir>/bin` are not removed.

## Task root

Every task lives under one task root, `/opt/meddle/tasks` by default. Create it once, owned by you:

```sh
sudo install -d -o $USER -g $(id -gn) -m 755 /opt/meddle/tasks
```

To use a different root, set `MEDDLE_TASK_ROOT` to it in the environment of every meddle command.

A node hosts tasks only while its task root is a writable directory and `jj` and `git` are on its `PATH`; otherwise
`serve` logs why (`meddle: jj is not on this node's PATH (<PATH>); this node will not host tasks`), `status` prints
it, the pool sees the node as hosting no tasks, and a move to it is refused before it starts with that reason. A
service runs with the `PATH` written into its unit (see [Service](#service)), not your login shell's.

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
bun run src/cli.ts token move <id|label> --before <id|label>   # or --after <id|label>
```

The dashboard's Settings view lists the same tokens, in order. Its Enable button does what `token enable` does for an
`exhausted` or `disabled` one, and its Up and Down buttons move a token past its neighbour as `token move` does.
Adding and removing stay on the CLI, so a value never passes through the dashboard.

A token's id is the first 16 hex characters of the SHA-256 of its value, so the same token added twice, on one node
or on two, is listed once. Adding it again with `--label` renames it and leaves it where it is in the order. Adding a
removed token brings it back at the end of the list, keeping when it was first set (and so its expiry).
Without `--label` a token is named after the first 8 characters of its id; a label is at most 64 characters. `token
add` prints `token <id> (<label>)`, and `token set` is the same command. `remove` and `enable` take a full id or a
label; a label two tokens share is refused (`ambiguous token label`), so name the token by its id then.

The order is each token's rank, kept apart from when it was set. A new token goes last: its rank is the time it was
added, or just past the last token's when this node's clock is behind. `token move a --before b` (or `--after b`)
puts `a` right next to `b` by giving it a rank between `b`'s and its neighbour's, rewriting `a`'s row alone, so a
move replicates like any other change to a token and does not undo a mark another node made on another token at the
same time. When two ranks are too close for one between them, the list is renumbered. `move` takes full ids or labels,
refuses moving a token before or after itself, prints `moved <id> (<label>) before|after <id> (<label>)`, and works
with or without the node running. A node of an older meddle sends no rank: its rows sort by when they were set, and
a move it overwrites with a later change to the same token is lost.

Each value is written mode 600 to `secrets/tokens/<id>` in the data directory (`~/.local/share/meddle`, or
`MEDDLE_DATA_DIR`; the directory is mode 700) and given to Claude Code as `CLAUDE_CODE_OAUTH_TOKEN`. The list itself
(each token's label, who set it and when, its status and its expiry, a year after it was set) is in the node's
database.

A turn uses the first token in order whose status is `ok`, or `exhausted` until a time that
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

A pool is a name and a secret. Every node given the same name and secret (`meddle pool secret`, below) is in the same
pool: it finds the others through the lighthouse and proves the secret to each of them. Until a secret is set a node
is alone: it dials nobody and admits nobody, and its dashboard and tasks work on their own.

### Node ids

A node's identity is an iroh secret key at `<data dir>/secrets/iroh.key` (64 hex characters, mode 600), created on
first use. Its node id is the lowercase hex of the public key, 64 characters; `meddle pool` and the dashboard's node
cards print its first 10 characters. `serve` prints the full id when it starts:

```
node <node id>
dashboard at http://127.0.0.1:7777/
```

`status` prints `node <node id>`, or `node (none yet)` before the key exists, and `pool <pool id> (<name>) members
<n>`, `pool (no secret set)` before `pool secret` ran, or `pool (none yet)` before the node first served. It creates
neither the key nor the database.

### The pool secret

```sh
bun run src/cli.ts pool secret --generate <path>   # a new secret, written to that file (mode 600) and set here
bun run src/cli.ts pool secret --file <path>       # the same file, copied to each other node
bun run src/cli.ts pool secret [--name <name>]     # or a secret of your own, pasted on stdin, then Ctrl-D
```

prints `pool <short id> (<name>)`. The secret and the name (`default` unless given; 1 to 64 letters, digits, `.`, `_`
or `-`) derive the pool: the secret, stretched with scrypt (128 MiB, about a quarter of a second) under the versioned
topic name, derives the lighthouse topic, an ed25519 keypair, and its public key is the pool id, which `status`, the
dashboard and the pool's topic show and which is safe to log. That id is public, so the secret must not be guessable
from it: use the generated one (32 random bytes), or at least 16 characters of your own (no control characters, at
most 4096). The same name and secret give the same id on every machine; never pass the secret as an argument. Run
it on each node, with or without the node running: the command writes the node's database directly (the secret
never crosses the node's socket, as a token never does) and tells the running node, which re-keys at once: every
connection is closed (whoever is in the new pool proves its secret afresh), the roster starts over with this node
alone, and discovery moves to the new topic. The same secret again changes nothing. The node's settings and tokens
stay, and merge with the pool's like any member's. A new secret on the nodes you keep is how a node is shut out of
the pool for good; Remove (below) is for the meantime, and neither takes back the login tokens the node pulled while
it was a member: revoke or reissue those too (`claude setup-token` again, `token remove` the old one).

Two nodes with the secret find each other through the lighthouse (below). Without one, tell either node the other's
id: `pool peer <node id>` records it here as a member at once, listed and counted as one, with or without the node
running, so that this node dials it (iroh resolves an id by DNS under the `n0` preset; not under `minimal`). The other
node still has to prove the secret before anything passes between them.

### Discovery

Nodes find each other through an iroh-lighthouse, the hosted `https://iroh.ichor.io` by default
(`MEDDLE_LIGHTHOUSE_URL` names another). Each node announces itself on the pool's topic, signed with the topic key,
and looks the topic up: only holders of the secret can do either, so every node the lighthouse lists is dialled and is
a member once the two have proved the secret to each other; a node
the roster has as removed is left alone, and one that leaves the topic before it proved anything is dropped again.
An announce asks for 300 s and is renewed at half the time the lighthouse grants; a node looks the topic up every
`MEDDLE_DISCOVERY_POLL_MS`. The lighthouse is only ever a hint: a node it lists that does not prove the secret is
refused, so a lighthouse of someone else's cannot add a member.

If the lighthouse is unreachable the node still starts; it retries with backoff and logs each distinct error at most
once a minute. Set `MEDDLE_LIGHTHOUSE_URL=` (empty) to turn discovery off: nodes then reach each other at the
addresses recorded in the roster (see [Addresses and forgetting](#addresses-and-forgetting)), and a new node is told
of with `pool peer`.

### Connections and removal

Nodes talk over iroh: QUIC, encrypted end to end, through iroh's relays when there is no direct path. A connection
opens with a proof of the pool secret each way, one line on a one-way stream: the dialer's first, then the
acceptor's, each the prover's session id and the topic key's signature over `meddle/admit/2.<prover>.<verifier>.<session>`
(iroh authenticates the ids, so a proof is good for that pair, that way, that process, and nothing else). A session
id is made once per process: its start time, then random bytes, so a node's sessions sort by when they started. The acceptor refuses, before reading anything else, a dialer that sends no
proof or another pool's (`bad proof`), any dialer while it has no secret itself (`no pool secret`), and a node its
roster has as removed (`removed <time>`); the dialer closes an acceptor that does not prove the secret and logs
`<short id> did not prove the pool secret`. The acceptor proves itself before it gives a verdict, and a dialer takes
a refusal as the peer's word only from a peer that proved the secret (one closed before proving is logged as a
failed dial); a removal dated more than five minutes ahead of this node's clock is ignored. A node that proves the
secret and was never heard of becomes a member here on the spot, named by its short id until its own row arrives
with the first sync.

Every node dials every member it has no connection with, and accepts their dials too. A node that starts dials every
member at once; one that loses a connection, or fails to make one, dials again after a delay that doubles from 1 s
to 30 s, each jittered by half either way so that two nodes do not keep dialling in step. When both have dialled at
once, or a connection from a restarted process meets one from before, each node keeps exactly one by a rule both
apply on their own and agree on: of two sessions of the peer the newer one's connection wins (the older process is
gone or going); within one session, the connection the smaller node id dialed wins. The other is closed (code 0,
`duplicate`), or, when the acceptor already holds the winner, answered `duplicate` instead of `admitted`, and the
dialer lets it go quietly. When a node cannot reach a member (a dial fails or is not answered,
the member keeps refusing it, or it cannot read the member's pool state) it logs why, as `meddle: pool: …`, each
distinct message at most once a minute; a healthy pool logs nothing.

A member is removed from the dashboard's Settings view or with `pool remove <id|prefix>` (a node cannot remove
itself). The removal is a roster change every member merges, and every member enforces it: each one closes its
connection to the removed node, and refuses it when it dials, with the reason `removed <time>`. The removed node
learns it was removed from the roster when it is connected at the time, or else from that refusal; it then closes its
connections and keeps knocking at the members it dials (refused each time, quietly), so that allowing it again (Allow
again in Settings, or `pool allow <id|prefix>`) takes effect without a restart: the next knock is admitted, and the
sync over it tells the node it is a member once more. Removal is bookkeeping, not security: a removed node still holds
the secret, can look the topic up, and with a new node key is simply a new node that proves the secret. A new secret
on the nodes you keep is the only real revocation.

A node removed while it is unreachable learns of it the next time it dials a member, which it does as soon as it is
back.

### Addresses and forgetting

Each node records its own address in its roster row at every self refresh (every 15 s), and also reports, for every
member it is connected to, that it is (with the time, on its clock) and the address it sees that member at: at once
when the connection comes up, and again at every self refresh. Those reports replicate with the roster, the newest
winning, and a node dials a member at the newer of the member's own word and the newest report. A node that comes
back at a new address (a restart picks a new port unless `MEDDLE_IROH_BIND` fixes one) therefore needs to reach only
one member, at the address it remembers, for the whole pool to learn where it is, with or without the lighthouse. A
report dated more than five minutes ahead of the receiving node's clock is ignored.

A member is last heard of at the newest of: a connection with this node, a member's report of a connection with it,
and the lighthouse listing it on the pool's topic. One not heard of for longer than the pool's `roster.forget`
([Pool settings](#pool-settings), 900 s by default, `0` never) is **gone** on this node: it drops out of the address
book, so it is neither dialled nor offered an address, `pool` lists it as `gone` and the dashboard shows it so. It is
not removed: its roster row stays a member, tasks and projects keep its id, and it rejoins by dialling a member and
proving the secret, after which it is online and no longer gone. Placement counts a gone node's work as lost: it is
not a candidate, and neither its load nor the projects it holds count. Gone is each node's own judgement and is not
replicated. The clock only runs while the node itself hears of the pool: a node with no connection and no lighthouse
forgets nobody (so it keeps dialling everyone), and a node that just started or woke from sleep judges no one by the
time it was away; the threshold runs from then.

### Tokens

Every member lists every token. A token's metadata replicates per id, last writer wins on the time it last changed
(on equal times every node settles on the same row), and a removal replicates as a removed row. A node pulls the value
of each token it lists but lacks, by id, from the member that listed it, and deletes the value of a token the pool
removed. A pull that fails (that member has not pulled the value yet, or is unreachable) is tried again at the node's
next self refresh, every 15 seconds, from an online member that lists the token. A value crosses the network only as the answer to a request from a current member for a token the answering
node lists, over the encrypted iroh connection. It never goes over the node's localhost socket (the CLI's and the
dashboard's), and never into the roster, the pool's replicated state or a log. A node drops a replicated row
whose id is not 16 hex characters, whose label is empty, longer than 64 characters or holds control characters, or
whose status or times are malformed, and logs `meddle: tokens: ignored replicated token "<id>"` once per id. A token
added while no node is running reaches the pool once that node serves.

Tokens are the logins of the people who added them, not the pool's: a node given a new pool secret keeps its tokens,
and they replicate to the new pool like any member's; it pulls the pool's tokens like every other member.

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
| `roster.forget` | How long, in seconds, a member may go unheard of before a node counts it gone ([Addresses and forgetting](#addresses-and-forgetting)): `0` never, else at least `60`; `900` (three lighthouse announce TTLs) when unset. A node that sets `MEDDLE_FORGET_MS` uses its own instead. |
| `defaults.model`, `defaults.effort` | The model, and the effort (`low`, `medium`, `high`, `xhigh` or `max`), of a turn whose task chose none, and what the dashboard picks for a new task; unset, `opus` and `medium`. A model cannot be set empty. |

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
a setting from a peer, logging `meddle: settings: ignored replicated key "<key>"` once per key. A node given a new
pool secret keeps its settings, and they merge with the new pool's by the same rule: on a new pool's first node, set
the secret first and the settings after, and know that the newest value wins where two nodes set the same key alone.

### `meddle pool`

```sh
bun run src/cli.ts pool        # or pool -v
```

prints the roster as a table, this node first and marked `@`:

```
   NODE        HOST         STATE   MEDDLE  CLAUDE   TASKS
@  1743a65f16  peeriot-00X  online  0.1.0   2.1.314  0
   164ff3e5ed  Gem          online  0.1.0   2.1.314  1
```

`STATE` is `online`, `offline`, `gone` or `removed`; `HOST` and the versions are `-` until the node's summary has
reached this one. `-v` adds `DIALER` (the node that dialed the connection held with that node) and `SESSION` (that
node's session on it; this node's own on its row).

### Ids and prefixes

Wherever the CLI takes a node, a task or a project by id, it takes a unique prefix of one too, as jj does: `task move
e98d 164`. A task's prefix is unique among every task of the pool (and the rows this node keeps of tasks that
moved away); a node's among the roster; a project's among the pool's projects (a project's name wins over a prefix).
`ambiguous task: e98 (e98a…, e98d…)` names the candidates. On a terminal, `pool`, `task list` and `project list`
print each id's shortest unique prefix in bold magenta: what you need to type. (`NO_COLOR` turns colour off,
`FORCE_COLOR` on.)

The task commands (`task prompt`, `retry`, `move`, `archive`, `restore`, `delete`) work from any node: they act on
the node the task lives on (or is archived on), reaching it through this node as the dashboard does. A task named by
its whole id that lives on this node needs no other node; a prefix is looked up across every online member. Nodes are
named by short id and hostname in what they print, such as `moving e98d79415f8e to 164ff3e5ed (Gem)`.

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
| `MEDDLE_NPM_REGISTRY` | `https://registry.npmjs.org` | Where the single binary downloads its pinned Claude Code from on first start (see [The single binary](#the-single-binary)); a mirror of the npm registry. |
| `MEDDLE_FORGET_MS` | the pool's `roster.forget` | How long, in ms, a member may go unheard of before this node counts it gone, overriding the pool setting here; a non-negative integer, `0` never (no 60 s floor: for tests and labs). |
| `MEDDLE_IROH_PRESET` | `n0` | iroh's `n0` preset (number 0's public relays and address lookup), or `minimal`: no relays and no address lookup, so nodes reach each other only at direct addresses (loopback setups and tests). |
| `MEDDLE_IROH_BIND` | iroh's default | The address iroh's UDP socket binds, as `<ip>:<port>`. |
| `MEDDLE_JJ_NETWORK_TIMEOUT_MS` | `120000` | How long a jj fetch or push with another node may take before meddle kills it (with its git processes) and fails it as `jj <args> timed out after <ms> ms`. A clone (from a peer or from an upstream) may take ten times as long. |

## Projects and tasks

With the node running (see [Dashboard](#dashboard)), add a project from an existing folder or an upstream URL, then
create a task on it and send it a prompt, or do both at once with `task new <prompt>`:

```sh
bun run src/cli.ts project add ~/src/myproject [--name myproject] [--no-fetch]   # prints the project id
bun run src/cli.ts project set-default <id|name> <branch>   # the branch a task starts from without --rev
bun run src/cli.ts project status <id|name>   # each branch, and how to resolve a conflicted one
bun run src/cli.ts checkout <id|name> [<dir>]   # clones the project from this node into a checkout of your own
bun run src/cli.ts project list
bun run src/cli.ts task new "Find out why test_sync is flaky and fix it" --project myproject   # prints: task <id> on <node>
bun run src/cli.ts task new --title "Fix the flaky test" --project <project-id|name>   # no prompt: it waits idle
bun run src/cli.ts task new "Finish this" --project myproject --rev <rev> --edit   # works on that revision itself
cd ~/src/myproject && bun run ~/src/meddle/src/cli.ts task new "Go on" --project myproject   # from your checkout's @
bun run src/cli.ts task prompt <task-id> "Find out why test_sync is flaky and fix it"
bun run src/cli.ts task list   # every task of the pool, with its state and node
bun run src/cli.ts task retry <task-id>   # runs a parked turn again, or carries on an idle task after an interrupt or failure
bun run src/cli.ts task move <task-id> <node> [--now]   # moves the task to another node
bun run src/cli.ts task archive <task-id>   # takes an idle task's folder off its node, keeps its log
bun run src/cli.ts task restore <task-id> [--node <id|prefix> | --here]   # brings an archived task back, here or on another node
bun run src/cli.ts task delete <task-id>    # deletes an archived or moved task's log and archive
```

`task new [<prompt>] [--title <t>] [--project <id|name> [--rev <rev>] [--edit]]... [--node <id|prefix> | --here]` creates a task, placed as
[Where a new task runs](#where-a-new-task-runs) says. Given a prompt (the words that are not options), it sends it as
the task's first turn, which starts on the node chosen, and prints `task <id> on <short id>` once the turn has
started, not when it ends (follow it in the dashboard, or send the next prompt with `task prompt`); without one the
task waits idle. Without `--title`, the task is created at once with two adjectives and a noun (`quiet amber otter`);
given a prompt, Claude Haiku then names it from the prompt (one short query with the token of the node the task is on,
alongside its first turn), or when that fails or takes over 20 seconds, the first 60 characters of the prompt's first
line replace the name. A task renamed before that answer keeps the name it was given. `--project` is repeatable, one project each, the first the primary; with
none the task has no project (in a checkout of this node, it is the checkout's project). `--rev <rev>` and `--edit` apply to the `--project` before them and say where that
project starts (see [Where a task starts](#where-a-task-starts)); either one before any `--project` is a usage error
(except in a checkout of this node with no `--project` at all, where they apply to the checkout's project),
and so is `--edit` without `--rev` (`meddle: --edit needs --rev`).

A message to a busy task is never refused, as in a terminal agent. While a turn runs it goes into that turn, and
Claude Code takes it at its next step (between tool calls) without cutting the turn short, or, if the turn is
finishing, runs it as a turn of its own right after; either way it is the same turn to meddle, which ends only once
every message sent into it has been taken. A message the running turn can no longer take (its result is in, or the
turn is being created, resumed or retried) waits for the task's next turn, one turn per message, in order, and so does
one the turn ended without taking (it was killed, say). Until Claude takes it, a message shows as `queued` under the
task's thread and is not in its log; it enters the log where Claude took it. Interrupt is what cuts a turn short.
`task prompt` to a busy task waits for the turn that takes its text and follows that one to its end.

`task list` prints a table of every task of the pool, node by node (this node first), the archived ones after the
others: `ID`, `STATE`, `NODE`, `HOST`, `PROJECTS` (comma-separated, `-` for none) and `TITLE`; nothing when there are
none. It reads each online member's tasks over the pool, as the dashboard does; an offline member's are not listed,
and a line on stderr says how many it had when last heard of (or that a member online did not answer within 10 s).

Each node keeps its own repo of every project, its service repo, where the project's tasks are jj workspaces; you
never work in it. You work in checkouts: your folder after `project add`, or one `checkout` clones, on any machine of
the pool. From a checkout you push branches to meddle and fetch tasks' work back. [Projects across the
pool](#projects-across-the-pool) says how.

`project list` prints one line per project of the pool, from what each node's summary in the roster says (this node
included), so it works while a holder is offline: `<id>  <name>  home <short id>  on <short id>,<short id>,…`, named as
its home names it, with the nodes that hold a copy after `on`.

`--project` (of `task new`) takes a project's id, or a name exactly one project of the pool has: `ambiguous project
name: <name>` when several have it, `unknown project: <x>` when none does (pass the id then). An id the roster does not
list yet (12 hex digits) is passed on to the node, which asks the online members for it. A task is `idle`, `running` or `waiting` (for an approval) while it lives on a node; a task moving away is `moving` on the node
it leaves and `receiving` on the node it goes to until it arrives, and the node it left keeps it as `moved`. An
archived task is `archived` (see [Archiving a task](#archiving-a-task)).

### Where a new task runs

`task new` creates the task on the node meddle picks for it, and prints `task <id> on <short id>`; `--here` creates
it on this node and `--node <id|prefix>` on that member (an id or a unique prefix of one; `no such node: <x>`
otherwise). The dashboard's new-task form has the same choice: `Automatic` (the default) or one of the online nodes
that host tasks; the form also takes a first prompt, and needs neither a project nor a title (it is named as
`task new` names one).

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

A task may have no project: `task new` without `--project` (outside a checkout), or the dashboard's form with
no project ticked. Claude Code then starts in the task folder with the user settings layer only and
`CLAUDE_CODE_PROJECT_DIR_NAME` unset, so its memory and transcript key on the task folder inside the task's config
directory: they travel with the task and end with it, and nothing syncs them. The task folder holds only a generated
`CLAUDE.md` saying so; it is scratch space that moves with the task. Such a task has no bookmarks, pushes nothing and
syncs no memory; meddle places it by load alone. A task with a project keeps per-project memory as before.

Claude Code keys the transcript and memory of such a task on the task folder's path, and meddle does not shorten a
long path the way Claude Code does when it makes that key, so a task without a project under a very long task root
may not resume its session.

## Projects across the pool

meddle works as a git remote spread over your machines. You push to it and fetch from it from a checkout on any
machine; no machine is in charge, and none has to stay on. Every ref position has one writer: a task writes its lines,
and a node writes its own record of each branch pushed to it. What a shared branch points at is stored nowhere: every
node computes it from all the nodes' records, and gets the same answer.

Words used below:

- **Node:** a machine running `meddle serve`, a member of the pool.
- **Service repo:** a node's own jj repo of a project. That node's tasks are jj workspaces in it. You never work in
  it.
- **Checkout:** your own jj repo of a project, with a git remote `meddle` pointing at the node on that machine.
- **Line:** a task's bookmark for one project, `meddle/task/<task id>/<name>`, where `<name>` is the project's name or
  a side bookmark `<project>.<label>`.
- **Branch:** any other bookmark pushed to meddle (`main`, `feature-x`).
- **Row:** a record, carried by pool sync, of where one ref points, written by that ref's one writer.

### Service repos

Every node keeps a service repo of every project of the pool, in `<data dir>/replicas/<project id>` (a jj repo
colocated with git), and applies all of the project's rows to it; the node a project was added on included. So a
task's work outlives the machine it ran on. The project's home is only where it was added and its id was made; adding
the same folder or URL on two nodes makes two projects. A node that hears of a project it has no service repo of
(from the roster, a row, or `task new --project <id>`) makes an empty one and fetches what the rows name from any
member that has it, so no particular node needs to be online. It clones the project's memory from its home into
`<data dir>/memory/<id>` (see [Memory](#memory)).

How rows become refs in a service repo:

- a line held by this node is its task's own local bookmark, `meddle/task/<task id>/<name>`, which the task writes;
- a line held elsewhere is the remote bookmark `task/<task id>/<name>@meddle`, untracked;
- a line's base commits (what its work is measured from) are `base/<task id>/<name>/<i>@meddle`, untracked;
- a branch is a local bookmark at its computed position, so agents can read it and rebase onto it. The node puts it
  back there after every turn end and every row change, whoever moved it;
- a released line is forgotten (`jj bookmark forget --include-remotes`), never deleted as a git ref: deleting the ref
  would make jj abandon commits only it kept.

A commit a row names is fetched by id, from the row's writer first, then from any other online member.

Each task's workspace has its own `immutable_heads()` in its jj config: its base and everything below it, every other
task's line, and every branch. So in a repo every task shares, an agent cannot rewrite its base, another task's work
or a branch. It can still move a branch's bookmark (immutability does not stop that), which is why a branch's position
is never read from a service repo, and why the node puts it back. The agent's instructions forbid `jj undo` and
`jj op restore`, as jj's operation log is shared by every workspace of the repo.

### Checkouts

```sh
bun run src/cli.ts project add ~/src/myproject    # this folder becomes a checkout
bun run src/cli.ts checkout myproject [<dir>]      # or clone a new one, on any machine of the pool
cd myproject
jj git fetch --remote meddle                       # every branch, every task's line, any conflict
jj git push --remote meddle -b main                # record a branch
```

`project add <folder>` and `checkout <id|name> [<dir>]` share one routine. It adds a git remote `meddle`
(`meddle://<this node>/project/<project id>`, served by `git-remote-meddle`) and fetches from it (`--no-fetch` skips
that for `project add`). They differ in where the repo comes from:

- `project add` creates the project and builds the service repo from your folder's default branch: `main`, else
  `master` (for a URL, the upstream's HEAD branch). The folder must be a jj repo colocated with git, or not a jj repo at
  all, in which case the command makes it one; a jj repo that keeps its git repo elsewhere is refused with `<folder> is
  a jj repo without a colocated git repo`. The node only reads your folder (`git fetch <folder> <branch>`).
- `checkout` clones a new checkout from this node's service repo into `<dir>` (default `./<project name>`; refused
  `<dir> exists and is not empty`), and prints its path.

Checkouts are not registered: any repo with a `meddle` remote is one. git finds the remote helper by name, so
`git-remote-meddle` must be on your PATH for a `jj git fetch` you type; both commands check that it is, and refuse with
`git-remote-meddle is not on your PATH; add <data>/bin to it` before anything is added (see
[`meddle://` remotes](#meddle-remotes)). The dashboard's add-project form builds a service repo from a folder too, but
the node never touches a checkout, so it cannot attach the folder: use `meddle project add` for that.

**Your checkout is yours.** meddle runs jj or git in a checkout only during a meddle command you ran in it
(`project add`, `checkout`, `task new`). Those may snapshot, as any jj command you type does. Nothing
touches a checkout in the background: you see new work when you fetch.

**Fetching** (`jj git fetch --remote meddle`) first catches this node up on the project with every peer it can reach
(5 s at most in all), then shows:

- every branch at its computed position (see [Branches](#branches));
- every live task's line, as `meddle/task/<task id>/<name>@meddle`, untracked, so jj won't let you rewrite it (an
  archived task's lines are not shown);
- the siblings of any conflicted branch, as `meddle/conflict/<b>/<id>@meddle`.

It shows only refs whose commits this node already has, and prunes the ones that went.

**Pushing** (`jj git push --remote meddle`) records branches. Your changes reach tasks only when you push them. A
pushed ref under `meddle/` is refused (`ref <ref> is not accepted here`), except the deletion of a
`meddle/conflict/<b>/<id>` sibling, and `refs/meddle/incoming/*`, which `task new` uses. One refused ref refuses the
whole push.

### Branches

A push to a branch is recorded as your node's own row for it: the commit, and the rows it replaced (its drops). Every
node computes the branch from every node's row for it: leave out the deleted rows and those some other row drops; the
branch is the heads of the commits left. Your push lands on your own node at once, and reaches the others when they
can see it; it never waits for another machine.

| You push | It counts as | What happens |
|---|---|---|
| A commit descending from the branch | A fast-forward | The branch moves there, everywhere |
| A commit not descending from it (`--allow-backwards` in jj, `--force` in git) | A forced push | Your row drops every current row: the branch is at your commit everywhere, a rewind included |
| A deletion of the branch | A forced push | The branch is gone everywhere |
| On a conflicted branch, a commit descending from every sibling | A fast-forward | It resolves the conflict, everywhere |
| On a conflicted branch, any other commit | Refused | `<b> is conflicted; push a merge of its siblings, or delete the ones you don't want`, then the siblings and the fix (below) |
| A deletion of `meddle/conflict/<b>/<id>` | A drop of that sibling | That sibling is dropped everywhere |

A push to a branch whose rows name a commit this node is still fetching is refused with `<b>: this node is still
fetching it; push again shortly`.

**Conflicts.** Two pushes to one branch from machines that could not see each other are both kept: the branch is
then **conflicted**, on every node, and the commits are its siblings. While it is conflicted, a checkout's fetch shows:

- each sibling as `meddle/conflict/<b>/<id>@meddle`, named after its commit's first 12 characters, so a name never
  points at a different commit and deleting one from a stale fetch can't drop the wrong side;
- the branch itself at the siblings' merge base (the smallest commit id among several), or not at all when they share
  no history. It can't simply go away: jj would delete your tracked bookmark and abandon commits nothing else holds.

`meddle project status <id|name>` prints each branch of a project as this node computes it, the default branch first:
`<b>  <commit>`, or for a conflicted one the siblings and the fix:

```
main  1f0c2a9b7d3e (default)
feature  conflicted, at its siblings' merge base 1f0c2a9b7d3e
feature is conflicted; push a merge of its siblings, or delete the ones you don't want
  meddle/conflict/feature/5a1e0c4d9b2f@meddle
  meddle/conflict/feature/c3d47e8a1b60@meddle
  to keep your own work: jj bookmark set feature -r <your commit>
```

The dashboard's project page shows the same. To resolve a conflict:

- **Merge:** `jj new meddle/conflict/<b>/<id1>@meddle meddle/conflict/<b>/<id2>@meddle`, resolve, then
  `jj bookmark set <b> -r @` and push it. It descends from every sibling, so it is the only commit left.
- **Drop a side:** `git push meddle :refs/heads/meddle/conflict/<b>/<id>`. jj pushes the deletion of tracked bookmarks
  only, and conflict refs arrive untracked, so use git for this.
- **Your own work:** if your local `<b>` had unpushed work on top of a sibling, jj makes your `<b>` conflicted when it
  fetches the merge base. `jj bookmark set <b> -r <your commit>`, then push a merge of it with each sibling.

Tracking a conflict ref with `jj bookmark track` makes that sibling mutable in your checkout until you push its
deletion. Dropping a sibling, rewinding a branch and deleting one can each make jj abandon, in a checkout, commits only
the old position held; jj says so, and `jj op log` gets them back.

A task can't start from a conflicted branch (`<b> is conflicted; push a merge of its siblings`), and a conflicted
branch accepts no task's work until it is resolved.

Each project has a default branch: `main`, else `master`, in the folder at `project add`, or the upstream's HEAD
branch for a URL. A task started from outside a checkout with no `--rev` starts there, and a checkout's fetch makes it
the remote's HEAD. `project set-default <id|name> <branch>` changes it on this node. Nothing fetches from a URL
project's upstream after the add: syncing with the upstream is yours to do, in a checkout (fetch from it, push to
meddle).

### Where a task starts

A start is resolved where the revision is, on the node you asked (the one `meddle` talks to); no other node is
involved, and none needs to be online.

Run in a checkout of the project (a repo whose remote `meddle` names this node), `task new --project <that project>`
starts from your checkout, and so does `task new` with no `--project`, which there means the checkout's project
(`--rev` and `--edit` without a `--project` then apply to it):

- `--rev <rev>`: that revision of your checkout; without `--rev`, the fork point of your `@` (the newest revision at or
  below it with changes, `heads(::@ ~ (empty() ~ merges()))`). When your `@` itself has changes, that is `@`: it is
  pushed and becomes read-only in your checkout, so run `jj new` to go on working. `--edit` without `--rev` is still
  `meddle: --edit needs --rev`.
- The command checks it there, pushes the commit to this node (`git push meddle <commit>:refs/meddle/incoming/<commit>`),
  creates the task, and fetches the task's line back (`jj git fetch --remote meddle`). The revision is therefore
  read-only in your checkout, as `meddle/task/<task id>/<project>@meddle`, when the command returns.
- With `--edit`, when the revision's only child is your own `@` and `@` is empty (as it usually is), the command
  rebases `@` onto the revision's parents first and says so: `moved your empty @ off <W>`.

From anywhere else (another directory, the dashboard):

- `--rev <rev>`: a revision of this node's service repo (a change or commit id, a bookmark, any revset that names one
  revision).
- No `--rev`: the project's default branch, as the branch's rows compute it (see `project set-default`):
  `<project> has no default branch; name a revision` when it has none, `no bookmark <branch> in <project>` when no
  node has it, `<branch> is not here yet; try again shortly` while this node lacks its commit, and `<branch> is
  conflicted; push a merge of its siblings` while concurrent pushes left it with several heads.

Either way, without `--edit` the task's workspace is a new change on the revision R, and its work is measured from R.
With `--edit` the workspace works on R itself, and the task's work is measured from R's parents. An edit is refused,
in this order, in your checkout and in the node's service repo and its workspaces: `<W> is immutable` (another task's
line holds it, or your jj config does), `<W> is <workspace>'s working copy; move off it first` (any workspace, your
checkout's `@` included), `<W> has revisions on top of it`, `nothing to hand off: <W> has no changes`. Without them
your checkout would show divergent changes once the agent rewrote W. Any start also refuses `no revision <rev> in
<project>`, `<rev> names <n> revisions in <project>` and, for a new change on it, `cannot start a task on the root
commit`. Each refusal starts with `project <name>: `.

A start writes the task's line as a row, held by the node you asked, before the task exists. The node the task is
placed on fetches the line's commits, takes the line over (one epoch up) and from then on is the only node that moves
it. A multi-project task resolves each project's start the same way; when a later start, or the creation, fails, the
lines the earlier starts wrote are released again. When the node it asked to create the task did not answer (the
connection dropped), it asks that node whether it has the task, and keeps the lines when it does or cannot tell.

### Lines

A task's lines are written only by the node holding the task. Its project's own line is
`meddle/task/<task id>/<project name>`; a side bookmark the agent (or you) adds is
`meddle/task/<task id>/<project name>.<label>`, for example `meddle/task/<task id>/app.spike`. The task's `CLAUDE.md`
tells the agent so. The label follows a dot, not a slash: git keeps refs as files, so it cannot hold `…/app` and
`…/app/spike` side by side.

The line moves as the agent works: after the agent's file-changing tool calls (Edit, Write, Bash), 5 s after the last
one, meddle snapshots the task's workspace and writes its lines' rows, and at every turn end once more. A side
bookmark the agent deleted is released; the project's own line is always kept. A write that fails is logged as
`meddle: line: …` and made again at the turn end. The dashboard's task view lists the task's bookmarks.

The line follows the agent's working copy, so an agent that starts over (`jj new main`, say) would take its earlier
attempt off the line. meddle keeps it: when a project's own line moves to a commit that neither descends from the work
it held nor holds a rewrite of it, that work first gets a side bookmark of its own,
`meddle/task/<task id>/<project name>.before-<n>` (`n` counts up from 1), logged as `meddle: line: <task id>'s line
<short id>/<project name> moved off its work at <commit>; kept as <project name>.before-<n>`. A rewrite is a rebase or
an amend (the same change id below the new head) or a squash (the old head in the evolution of a commit below it), so
rebasing the line onto a moved branch keeps no side line. Like any side line it is kept, held and archived, when the
task's work is accepted without it. The agent (or you) can delete the bookmark to let it go.

Agents build on each other's work by merging another task's line into their own. The other task's commits arrive as
an untracked remote bookmark, so they can't be rewritten, only built on, and the other task carries on unaffected.

A move hands the task's lines over with it: the node it leaves writes its last rows and sends them with the move, and
the target takes the lines over (one epoch up) when the move activates, not before, since a move can still roll back.
A late write from the former holder has a lower epoch and loses.

| Event | The task's lines |
|---|---|
| Accepted (below) | The lines a branch contains are released; any other line stays, held by the archiving node, archived |
| Archived by hand | Kept, held by the archiving node, and left out of what checkouts fetch |
| Restored | Live again, held by the node it is restored on |
| Deleted | Released |

A released line's commits stay only where a branch or another line holds them.

### Taking a task's work

Accepting a task's work emerges from a push; there is no command for it:

1. Ask the agent to rebase onto your branch (each project's line onto that project's branch, for a task of several).
2. Review its work in a checkout: `jj git fetch --remote meddle`, then `jj log -r meddle/task/<task id>/<project>@meddle`
   or `jj new meddle/task/<task id>/<project>@meddle` to try it.
3. Fast-forward your branch onto the line and push: `jj bookmark set main -r meddle/task/<task id>/<project>@meddle`,
   `jj git push --remote meddle -b main`.

Once a branch's computed position contains the task's line, for every project the task changed, the task's work is
accepted. Any branch counts, not only the default one: a scratch bookmark you set on a task's line and push (a
`jj git push --remote meddle --all` pushes every bookmark) accepts the task and archives it too, so push a bookmark on
a task's line only when you mean to take its work. (A line is judged by its effective head: empty changes on top of it, such as an agent's empty `@`, are left
out, and a project whose line is still at its base, untouched, does not count.) The node holding the task checks this
whenever the project's rows change and whenever it writes the task's lines. An idle task that is accepted is archived,
the lines a branch contains released; one mid-turn is archived when its turn ends, if it is still accepted then. A
branch that contains the lines of only some of the task's projects archives nothing; the dashboard shows the task as
partly accepted. A conflicted branch accepts nothing until it is resolved, so a sibling that is later dropped can't
leave the work held by nothing.

You can also go on from a task's work in your own way: `jj new meddle/task/<task id>/<project>@meddle`, or a rebase of
your own work onto it. Take it once the task's turn has ended: while a turn runs, the line follows the agent's working
copy, which its next snapshot rewrites.

### Upgrading to service repos

A meddle older than service repos kept a folder project's repo in the folder itself and its tasks' workspaces inside
it. Nothing carries that state over: upgrading starts the pool's projects and tasks afresh, and keeps the pool itself
(its name, secret and members), each node's identity, the login tokens and the pool's settings. Upgrade every node of
the pool together:

1. Stop `meddle serve` on every node (`systemctl --user stop meddle` for the service).
2. In each folder an older meddle had as a project's repo, keep what you want of the old tasks' work, then forget
   their workspaces and bookmarks. Run `jj status` in an old task's workspace first, so its edits are snapshotted,
   then give the work a name of your own (`jj bookmark rename meddle/task/<task id>/<project> <name>`): nothing
   under `meddle/` can be pushed to meddle.

   ```sh
   jj workspace list   # each old task's workspace is meddle-<task id>
   jj workspace forget meddle-<task id> ...
   jj bookmark forget --include-remotes 'glob:meddle/task/*'
   ```
3. Upgrade meddle on every node.
4. On each node, remove the old projects' and tasks' state (`<data dir>` and `<task root>` as in
   [Environment](#environment); the `sqlite3` command line tool is needed):

   ```sh
   rm -rf <data dir>/replicas <data dir>/memory <data dir>/archives <data dir>/archive <data dir>/moved \
     <data dir>/git-hooks <data dir>/durable.sqlite <data dir>/durable.sqlite-wal <data dir>/durable.sqlite-shm
   rm -rf <task root>/*
   sqlite3 <data dir>/meddle.sqlite 'DROP TABLE IF EXISTS projects; DROP TABLE IF EXISTS tasks;
     DROP TABLE IF EXISTS events; DROP TABLE IF EXISTS transcript; DROP TABLE IF EXISTS line_rows;
     DROP TABLE IF EXISTS branch_rows;'
   ```

   Keep the rest of the data dir: `meddle.sqlite`'s `pool`, `roster`, `settings` and `tokens` tables, `secrets/`
   (the token values and the node's key, `secrets/iroh.key`), `profile/`, `plugins/` and `bin/`. The node makes the
   dropped tables again, empty, as it starts.
5. Start every node, and add each project again, once for the pool: `meddle project add <folder>` on the node the
   folder is on (the folder becomes a checkout as it is added), or `meddle project add <url>`. Then create tasks as
   before. Until a member has started on the new meddle, the pool still lists its old projects, and adding a project
   of the same name is refused as ambiguous; `meddle pool remove` any member you won't bring back.

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
  this node's git socket to the node the URL names (this node itself, for a checkout here).
- `checkout-hooks/pre-receive`, the hook every push to this node meets, from a checkout on this machine or from
  another node (below).

It then listens on that socket, `<data dir>/git.sock` (mode 600; `MEDDLE_GIT_SOCKET` names another), replacing a
stale socket file and refusing to start when another meddle serves it.

meddle puts `<data dir>/bin` first on `PATH` and sets `MEDDLE_GIT_SOCKET` for every jj it runs. It gives neither to
an agent: a task's Claude Code gets `PATH` without `<data dir>/bin` (taken off even when meddle's own `PATH` has it)
and no `MEDDLE_GIT_SOCKET`, so jj and git inside a task can't reach `meddle://` remotes. An agent needs none: its
lines and the branches reach every node as rows, and a push through this node's git socket would count as one of
your checkouts'. Your own jj and git in a checkout need the helper:
git finds `git-remote-meddle` by name, and `project add` and `checkout` refuse with `git-remote-meddle is not on your
PATH; add <data>/bin to it` without it. Add to your shell profile, with your data directory if `MEDDLE_DATA_DIR`
names another:

```sh
export PATH="$HOME/.local/share/meddle/bin:$PATH"
export MEDDLE_GIT_SOCKET="$HOME/.local/share/meddle/git.sock"
```

Without `MEDDLE_GIT_SOCKET` the helper uses `<data dir>/git.sock`. With no node running it fails at once with
`meddle: cannot reach this node's git socket at <path> (is "meddle serve" running?)`, and when the other node is
offline or does not hold the repo with `meddle: <short id> did not serve <repo> (offline, or it does not hold it)`.

A node serves only members of its pool, and this machine's checkouts, only the repos it holds, and only fetches
(`upload-pack`) and pushes (`receive-pack`); it logs a request for a repo it does not hold as `meddle: git: unknown
repo <repo>`.

- **A checkout on this machine** (its remote `meddle` names this node) is served a project as its view, a git
  namespace (`refs/namespaces/view/`) that only the node writes, from the pool's rows; jj in the service repo never
  imports it, so an agent's bookmark move never reaches a checkout. Its fetch first catches the node up with every
  peer it can reach (5 s at most). Its push meets the `pre-receive` hook, which admits or refuses the whole push as
  [Checkouts](#checkouts) and [Branches](#branches) say, before anything lands; what it changed is recorded as this
  node's branch rows.
- **A peer** is served the repo itself: it fetches a project's commits by id. It never pushes to a project repo
  (refused, logged `meddle: git: <short id> may not push to project/<id>`): lines and branches travel as rows. It
  pushes only the `memory` bookmark to a memory repo, under the same `pre-receive` hook, which refuses its deletion
  (`deleting <ref> is not accepted here`) and every other ref (`ref <ref> is not accepted here`).

While the hook is missing or cannot run, the node refuses every push, logging `meddle: git: pre-receive hook missing;
refusing receive-pack`; `serve` writes it again at start.

## Moving a task

A task moves to another node of the pool from the dashboard (its node in the task's bar, or Move to… on its sidebar
row, choosing whether to wait for the turn or move now) or from the CLI:

```sh
bun run src/cli.ts task move <task-id> <node>         # waits for the running turn, if any, to end
bun run src/cli.ts task move <task-id> <node> --now   # interrupts it
```

`<node>` is a node id or a unique prefix of one, such as the short ids `meddle pool` prints. The command prints
`moving <task-id> to <short id>` once the move has started; the node runs it to its end as a durable task, across
restarts.

### Who can take a task

A move is refused before it starts unless the target is another online member of the pool, hosts tasks, and reports
the same Claude Code version as this node, with neither reporting `unknown` (as a node of a meddle before the single
binary embedded Claude Code does when served from its compiled binary). The refusal names the reason, such as `<short id> does not host tasks` or
`claude code <version> here, unknown there`. A task that is already moving, has moved or is being received is refused
too, as is one whose turn is parked (retry it first). The dashboard offers only the nodes that can take the task.

### What travels

- The task's work. This node writes the task's lines a last time and sends their rows with the move; the target
  fetches the commits they name (from this node or any member that has them) and starts its workspaces from the
  project lines, side lines included. Edits not yet committed travel in the working-copy commit; files git ignores
  do not. A project the target has no service repo of yet gets one first (see [Service repos](#service-repos)).
- The conversation: the task's event log, the transcript mirror's rows, and Claude Code's transcript files in the
  task's config dir (the session and its subagents' transcripts with their sidecar files). Symlinks are skipped (the
  memory link among them).
- The task's title, session, settings (model, effort, permission mode), turn count and queued prompts.

The transfer is checked: the target answers with its counts and a SHA-256 over everything it received, and a
mismatch fails the move. What does not travel: background shells and subagents (see "Move now" below); the rest of
the task's Claude Code config dir, which the target sets up as for a new task; and memory, which the target syncs
with the project's home around the task's turns there, as for any task. The target takes the task's lines over (one
epoch up) when it activates the task, not before: until then the move can still roll back, and this node then writes
the lines again above any epoch the target could have written.

### Steps

While a task moves, its view shows `Moving to <node>: <step>` and disables its controls and composer.

1. `prepare` checks the move again, marks the task `moving` and waits for its turn to end (or interrupts it).
2. `handoff` writes the task's lines and sends their rows; the target fetches their commits and provisions the task as
   `receiving`; then the task's log, transcript and files go over one stream, and the two sides' receipts must match.
3. `commit` has the target activate the task (it is `idle` there, and its queued prompts start), and records it here
   as `moved`.
4. `cleanup` archives and removes this node's copy.

### "Move now"

A move waits for a running turn to end: `task move` then says `moving <id> to <node> once its turn ends`, and the
dashboard `Moving to <host> once the current turn ends`. "Move now" (`--now`) interrupts the turn instead, and closes
it if it has not ended 15 seconds later. A move already waiting can be hurried the same way: `task move <id> --now`,
or Move now in the dashboard's banner. Background shells and subagents that the turn started stop and do not travel; the dashboard
warns of this but cannot list them (the Agent SDK has no way to). When a turn was cut short, the task's first turn
on the target starts with:

> The previous turn was interrupted to move this task to another machine. Background shells and subagents that were
> running were stopped and did not travel. Carry on from where you were; do not redo work that is already done.

### Cancelling a move

`task move <id> --cancel` (or Cancel move in the dashboard's banner) calls a move off while it waits for the turn or
hands the task over: the task stays on this node, live again in the state its turn has (a waiting or running turn is
never touched), the prompts queued meanwhile run here, and whatever the target had received is dropped there. The move
ends without an error: it is logged as `meddle: move: <id> to <short id> cancelled at <step>`, and no notification is
raised. Once the target holds the whole task and is taking it over, it is too late: `too late to cancel: <short id>
has the task and is taking it over`; move it back afterwards instead.

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
format as an [archive](#archiving-a-task)), before it removes anything. It then forgets the task's workspaces and
every bookmark under the task's namespace (the lines stay, as the rows the target writes), and removes the task folder (with its Claude Code config dir) and its event and
transcript rows. The task's row stays, as `moved`: its view here says where it went and links there, and commands on
it answer `task has moved to <short id>`. A task can move back to a node it left.

A janitor deletes the files in `moved/` older than seven days, when `serve` starts and every 24 hours after; meddle
has no command to restore one. An earlier meddle kept them in `<data dir>/archive/`: the janitor applies the same rule
there and removes that directory once it is empty. It never touches `archives/`, the archives of archived tasks.
`task delete <task-id>` deletes a `moved` task's row (and its file in `moved/`) at once.

## Archiving a task

An idle task can be archived on the node that holds it, from its view in the dashboard (Archive) or with
`task archive <task-id>`: meddle writes the task's lines a last time, archived (kept, held by this node, and left out
of what checkouts fetch), writes the task's files to `<data dir>/archives/<task id>.json.gz` (directory mode 700, file
600: the task's row, manifest, event log, transcript rows and the transcript files under its Claude Code config dir),
forgets its workspaces and bookmarks, removes its folder, keeps its event and transcript rows, and records the row as
`archived` on this node. No other node is asked anything. Only committed work (in the lines) and the conversation
survive an archive: files git ignores inside a workspace are lost with the folder. Archives are kept until the task
is restored or deleted; the seven-day janitor never touches them. A task whose work a pushed branch contains is
archived without being asked (see [Taking a task's work](#taking-a-tasks-work)).

An archived task renders read-only from its rows in its view (its thread, no composer and no controls), with Restore
and Delete as the only actions. The pool view lists the archived tasks of every online node in one "Archived" list,
each with the node that holds it, with Restore and Delete links. Prompts, moves and the other controls answer
`task is archived: <id>`.

Only an idle task archives: one with a turn running or waiting, prompts queued, or a move in progress is refused
(`task is running`, `task has queued prompts`, `task is moving`, …); a refused or failed archive leaves the task idle
and in place.

`task restore <task-id> [--node <id|prefix> | --here]` (or Restore, whose node select defaults to Automatic) brings
the task back, on any node that can take it. Without `--node` or `--here` meddle places it as it places a new task of
the task's projects (see [Where a new task runs](#where-a-new-task-runs)): the primary project's home first, skipping
nodes a move would refuse (another or an unknown Claude Code version, no task root, offline). The node
holding the archive runs it: `task restore` on that node, or Restore in the dashboard of any node.

On the node it was archived on (`--here`, or placement picks it), the task's bookmarks come back from its lines' rows,
each project's workspace starts on its project's line, the folder is provisioned again from the manifest, and the
archive's files are unpacked into it (a task without a project's transcript into this node's slot). The task is
`idle` again, its lines live again, its next turn resumes its session, and the archive is deleted; no other node is
asked anything, and a restore that fails leaves the task archived. It prints `task <task-id> on <short id>`.

On another node, the archiving node runs the [move procedure](#moving-a-task) with the archive as its source: it is
refused as a move is (an offline target, one that hosts no tasks, another Claude Code version, …), the task is
`moving` meanwhile (prompts answer `task is being restored; send it again once it has arrived`), and there is no turn
to wait for. The lines' rows travel as the archive left them, and the target fetches their commits; it then gets the
same frames a move sends, read from the archive, under the same receipt rule. Once the target has activated the task
(its next turn resumes the session, with no follow-up prompt) and taken its lines over, the archive becomes the move's
leftover in `<data dir>/moved/` (kept seven days, see [On the node a task left](#on-the-node-a-task-left)), the event
and transcript rows go, and a `moved` row remains. A restore-move that fails (the target refuses, a restart parks it
before the receipt) leaves the task `archived` here again, its archive intact; one parked in `commit` stays `moving`,
as [When a move fails](#when-a-move-fails) describes, because the target may already hold the task. The command
prints `restoring to <short id>` once the move has started and returns; the move goes on in the background, and the
task's view in the dashboard shows how it goes (`status` does not).

`task delete <task-id>` (or Delete) deletes an archived task's archive, row, event log and transcript rows; it is
refused for a task that is not archived or moved (`task is idle`, …). It also forgets the task's bookmarks
(`meddle/task/<task id>/*`) in each project's repo on this node and, for an archived task, releases its lines, so their
commits stay only where a branch or another line holds them (a moved task lives on elsewhere: its lines stay). No
other node is asked anything.

## Known limits

- A removed node still holds the pool secret: it can look the pool's topic up and see the members' addresses, it
  keeps knocking, and with a fresh node key it is a new node that proves the secret. A new secret on the nodes you
  keep (`pool secret` on each) is the only real revocation, and the login tokens it pulled meanwhile must be revoked
  or reissued separately.
- Two groups of members cut off from each other for longer than `roster.forget`, with no lighthouse either side can
  reach, count each other gone and stop dialling: when the cut heals they stay apart until a node on either side
  restarts (it dials every member it knows at once) or the lighthouse lists them again.
- Two nodes that dial each other at the same moment (both starting, or both redialling after a cut) may each show the
  other offline and online again once, within a second or so, while they settle on one connection.
- The lighthouse cannot admit anyone, but it chooses whom a node dials and with what address: one that lies can keep
  a node from reaching members it is not already connected to, and learns which nodes hold the secret, since the
  dialer's proof goes first.
- A project's memory stays with its home, which cannot be moved to another node yet. While the home is offline, other
  nodes' memory syncs are logged and retried at the next turn end; their tasks' turns still run.
- When a node's last push of a project's memory to the home failed, the memory commits it has not pushed do not
  travel with a task that moves away: the target syncs memory from the home. They stay in this node's memory repo
  and reach the home only with a later turn of that project here.
- A node whose Claude Code version is `unknown` (an older meddle served from its compiled binary) cannot move tasks,
  either away or to it.
- The single binary runs on one platform; each platform needs its own build. It downloads Claude Code (about 140 MB)
  on the first start of each version, so that start needs the npm registry or a mirror, unless it was built with
  `--embed-claude` (about 450 MB).
- Background shells and subagents do not travel on "move now", and the dashboard cannot list them.
- When a node restarts in the middle of a turn, the turn's rerun resumes the session and tells Claude to carry on;
  text you sent into that turn that Claude Code had not yet written to its transcript is not sent again.
- Every node of a pool must be upgraded together: the nodes' peer interface gained calls without a new version, so a
  newer node cannot use an older node's at all (no task created there, no move to it), and placement tends to pick an
  older node, which reports no running turns (see [Where a new task runs](#where-a-new-task-runs)).
- The commits meddle makes no longer need a jj user config on each node: the pool's `jj.user` and `jj.email` settings
  give every node one identity (see [Install](#install)). Without them, and without a node's own config, jj refuses to
  push the commits that node makes, so its memory syncs to a project's home fail.
- A side bookmark whose name git can't hold as one ref component (a slash after the project name, say) is neither
  applied on other nodes nor shown to checkouts.
- Nothing prevents conflicts on a shared branch: without a machine that is always on, it can't be done. Pushes that
  overlap while machines can't see each other are kept and show as a conflict, for you to resolve (see
  [Branches](#branches)).
- Every node keeps a service repo of every project of the pool, with all its tasks' work: a disk cost per project on
  each machine, in return for work that outlives the machine it ran on.
- Files git ignores inside a workspace are lost on archive; only committed work and the conversation are kept.
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

The dashboard of any node shows the whole pool. Its sidebar lists the pool's projects, each with the tasks that work
in it alone and a New task row; then Tasks, the tasks with no project or several (each marked with how many); then
Archived, collapsed, every online node's archived tasks; and at its foot Nodes, every member with what runs on it and
its load, or since when it has been offline. A task's row shows its state (a dot: running, waiting on you, idle), how
many approvals and questions wait on you, and the node it runs on (`from → to` while it moves); its ⋯ menu (or a
right click) renames it, moves it, archives it, or for an archived task restores or deletes it. Within a project,
tasks are listed by latest activity. The sidebar hides (◧), and on a narrow screen it is a drawer. Opening the
dashboard shows the task that waits on you most recently, else a new task. Failed turns, moves and token trouble show
as notices in the top right until dismissed. It flags a pool whose members run different meddle or Claude Code
versions in the Nodes header.

A task opens beside the sidebar: its title (✎ renames it), state and actions (Interrupt, Retry, Archive; Restore and
Delete for an archived one), its thread with the assistant's text as Markdown and each run of tool calls folded into
one line, what waits on you inline (Allow, Edit & allow, Deny, Deny & interrupt; a question's options), the messages it
was sent and has not taken yet (`queued`), the composer (Queue while a turn runs, Send otherwise),
and a bar with its projects, its node, its bookmark, the latest turn's tokens, its permission mode, and its model and
effort as one pill (the pool's defaults where it chose none) that opens the node's models and the efforts the picked
one takes. The node in the bar opens the move menu: every other member, those that cannot take the task greyed with why,
and whether the move waits for the running turn or interrupts it (see [Moving a task](#moving-a-task)); a task that
moved is followed to its new node. New task opens an empty composer: its projects (the one it was opened under, more
added with ＋ project), the node (Automatic, the default, or a chosen online node that hosts tasks; see
[Where a new task runs](#where-a-new-task-runs)), its model and effort (the pool's defaults until changed) and its
first prompt; Start creates it and opens it. A project's page
(its name in the sidebar) shows its home; its branches, the default one marked, each at its commit, a conflicted one
flagged with its siblings (`meddle/conflict/<b>/<id>@meddle`) and how to resolve it, as `meddle project status`
prints them (see [Branches](#branches)); the nodes holding a copy with their service repos' bookmarks; and its
tasks. A task whose work a pushed branch contains in only some of its projects shows as partly accepted. ＋ beside
Projects adds a project from a folder on this node or a URL; it builds the service repo but cannot make the folder a
checkout, for which the form points you to `meddle project add` on the command line. A node's page (from Nodes) shows its meddle and Claude Code versions, token, task root, resources and tasks while
it is online, and what the roster last recorded of it (and when it was last seen) while it is not.

Another node's tasks open through the pool: the browser opens `/ws/node/<node id>` on the node it loaded the page
from, and that node carries the socket to the other one over iroh. A node that is not a member answers 404 and an
offline member 503.

Settings shows this node's id, the pool's name and id (or that no secret is set), the members (with Remove, and
Allow again on a removed one); then the
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

It prints the unit and the task-root command. From a checkout the unit runs `ExecStart=<bun> run src/cli.ts serve`
with `WorkingDirectory=` this checkout; from the single binary, `ExecStart=<the binary> serve` with
`WorkingDirectory=%h` (your home), so put the binary where it will stay before installing, and run `service install`
again after moving it. Without `--dry-run` it writes `~/.config/systemd/user/meddle.service`, runs `systemctl --user daemon-reload`
and `systemctl --user enable --now meddle.service`, and prints the task-root command to run once. The unit sets
`Environment=PATH=…` to the `PATH` of the shell you ran it from (less what `bun run` adds), because a user service
otherwise runs with systemd's own, which often lacks `~/.cargo/bin` or wherever `jj` lives; run `service install`
again after installing `jj` or `git` somewhere new.

## Links

- [User guide](docs/user-guide.md)
- [Design](docs/superpowers/specs/2026-10-30-meddle-design.md)
- [Plan 1: single node](docs/superpowers/plans/2026-10-30-meddle-single-node.md)
- [Plan 2: pool over iroh](docs/superpowers/plans/2026-10-31-meddle-pool.md)
- [Plan 3: repos across the pool and task moves](docs/superpowers/plans/2026-10-31-meddle-mesh.md)
- [Plan 4: settings, tokens, placement, archive and spawn](docs/superpowers/plans/2026-11-02-meddle-settings-placement-archive.md)
- [Peer repos: design](docs/superpowers/specs/2026-11-09-meddle-peer-repos-design.md)
