# meddle user guide

How to get meddle running, what has to be running, and how to set a pool up. The [README](../README.md) is the
reference for each feature; this guide is the path through it, in the order you meet things.

## What runs where

meddle is one program and one long-running process per machine: the **node**, `meddle serve`. That one process is
everything a machine contributes to the pool:

- the task runner, which starts a Claude Code session for every turn of every task on the machine;
- the dashboard, on `http://127.0.0.1:7777/`, and the socket every `meddle` command talks to (the same port);
- the pool endpoint, an iroh (QUIC) connection to each other node, over which settings, tokens, task moves and the
  other nodes' dashboards travel;
- a service repo of every project of the pool, where that machine's tasks are jj workspaces;
- the git server other nodes fetch commits and memory from, and your checkouts on that machine fetch from and push to,
  on a unix socket in the data directory.

There is nothing else to run. No database server (the state is SQLite files in the data directory), no broker, no
worker processes, no separate web server. One machine is a pool of one, and everything below works on one machine;
a second machine joins the pool and runs the same process.

Outside the node:

- **A lighthouse**, so nodes with the same pool secret can find each other. By default the hosted one at
  `https://iroh.ichor.io`; set `lighthouse.url` to your own [iroh-lighthouse](https://github.com/Jezza/iroh-lighthouse)
  instead, or turn discovery off with `MEDDLE_LIGHTHOUSE_URL=` (empty) and tell each node the others' ids with
  `meddle pool peer`. A node runs without it, and the lighthouse is only ever a hint: a node it lists still has to
  prove the secret.
- **iroh's relays**, when two nodes have no direct path. Nothing to set up.
- **Your browser**, on any node's dashboard. The dashboard binds to localhost only; for a remote machine, tunnel it
  (`ssh -L 7777:127.0.0.1:7777 <host>`, the same port at both ends: the node accepts a browser only on its own port)
  and open the same URL.
- **On each machine:** [jj](https://jj-vcs.github.io/jj/) 0.46.0 or later and git, and the `meddle` binary (below).
  Claude Code itself is inside it, so a task needs no `claude` on the machine. The `claude` CLI is needed once, on
  any machine, to mint a login token (`claude setup-token`); the token then reaches every node through the pool.

## Is it a binary?

Yes. On one machine with a checkout (`bun install` done), build it:

```sh
bun run build    # writes dist/meddle
```

`dist/meddle` is one file, about 150 MB, holding bun, meddle and the dashboard, and naming the exact Claude Code to
run. Copy it to each machine of the same platform and put it on the `PATH`:

```sh
scp dist/meddle <host>:.local/bin/meddle
```

Those machines need jj and git, and nothing else: no bun, no checkout. The first time a node starts, it downloads
that Claude Code from the npm registry (about 140 MB) and checks it against the checksum the build carries; a machine
that cannot reach the registry needs a build made with `bun run build --embed-claude` (about 450 MB, Claude Code
inside). Give every machine the same build, so that they all run the same Claude Code and can move tasks to each
other. A build runs on one platform; for a machine of
another (a Raspberry Pi is `bun-linux-arm64`), see the README's [single binary](../README.md#the-single-binary).

You can still run from a checkout instead: `bin/meddle` is a wrapper that runs the checkout's CLI from anywhere
(`ln -s ~/projects/meddle/bin/meddle ~/.local/bin/meddle`), with bun and `node_modules` installed on that machine.

The rest of this guide writes `meddle <command>`; `bun run src/cli.ts <command>` from a checkout is the same thing.

## The first machine

### 1. Install

```sh
jj git clone git@github.com:Jezza/meddle.git ~/projects/meddle
cd ~/projects/meddle
bun install
ln -s "$PWD/bin/meddle" ~/.local/bin/meddle
meddle --version
```

`bun test` runs the suite (about seven minutes on a laptop); it is not needed to run meddle.

### 2. The task root

Tasks' folders are made under one directory, `/opt/meddle/tasks` by default. Create it once, owned by you:

```sh
sudo install -d -o $USER -g $(id -gn) -m 755 /opt/meddle/tasks
```

Or put `MEDDLE_TASK_ROOT=<dir>` in the environment of every meddle command (and of the service, below). A node whose
task root is missing still serves: it is in the pool, its dashboard works and it can be a project's home, but no
task is placed on it (`serve` logs `this node will not host tasks`).

### 3. Start the node in a terminal

```sh
meddle serve
```

It prints its node id and the dashboard URL and keeps running; Ctrl-C stops it. Leave it running for the next steps,
which talk to it. The first start creates the data directory, `~/.local/share/meddle` (mode 700; `MEDDLE_DATA_DIR`
names another), and in it, some at that start and some on first use:

| Path | What |
| --- | --- |
| `meddle.sqlite`, `durable.sqlite` | The node's state: tasks, projects, event logs, transcripts, the pool secret and roster, and the turns in flight. |
| `secrets/iroh.key` | The node's identity; its node id is this key's public half. Keep it; a new key is a new node. |
| `secrets/tokens/<id>` | The login tokens' values, one file each (from the first `token add`). |
| `profile/` | A jj repo seeded from this machine's `~/.claude` (`CLAUDE.md`, `settings.json`, `skills`, `agents`, `commands`, `hooks`): the user layer every task's Claude Code sees. See [Profile](#profile-the-user-layer). |
| `plugins` | A symlink to `~/.claude/plugins` when that exists, else an empty directory. |
| `replicas/<project id>`, `memory/<project id>` | The service repo of every project of the pool, where this node's tasks are jj workspaces (you never work in it), and every project's memory repo. |
| `bin/git-remote-meddle`, `checkout-hooks/pre-receive`, `git.sock` | The git plumbing other nodes fetch through, and your checkouts here fetch and push through. |
| `archives/`, `moved/` | Archived tasks, and what a task that moved away left (kept seven days); made by the first archive and the first move. |

Until a pool secret is set (see [The second machine](#the-second-machine)) the node is alone: its dashboard and tasks
work, it just talks to nobody.

### 4. Add a login

```sh
claude setup-token              # prints a token; copy it
meddle token add --label laptop # paste it, then Ctrl-D
meddle token list
```

Or `meddle token add --file <path>`. Never pass the token as an argument. The token commands work with or without
the node running. Add a second login the same way: it goes to the end of the list, and a turn whose login hits a
usage limit switches to the next token in the list by itself ([Login tokens](../README.md#login-tokens)). To have a
turn try one login before another, `meddle token move <a> --before <b>` (or the Up and Down buttons in the dashboard's
Settings view).

### 5. Set the jj identity

```sh
meddle config set jj.user "Your Name"
meddle config set jj.email you@example.com
```

This needs the node running. It is a pool setting: every node, and every task's Claude Code, commits with it. Without
it jj refuses to push the commits it makes, so the node's memory syncs to a project's home fail (each turn end logs
`meddle: git: …`). `config list` shows what is set ([Pool settings](../README.md#pool-settings)).

### 6. Run the first task

meddle finds `git-remote-meddle` the way git does, by name, so put the data directory's `bin` on your `PATH` first
(in your shell profile; `serve` writes the helper there):

```sh
export PATH="$HOME/.local/share/meddle/bin:$PATH"
export MEDDLE_GIT_SOCKET="$HOME/.local/share/meddle/git.sock"
```

Add a project from a folder you already have (it becomes a colocated jj repo if it is not one) or from an upstream
URL, and give it a task:

```sh
meddle project add ~/src/myproject --name myproject
cd ~/src/myproject
meddle task new "Find out why test_sync is flaky and fix it"
```

`project add` builds the project's service repo (in the data directory) from the folder's `main` (else `master`),
and makes the folder a **checkout**: it gets a git remote `meddle` pointing at this node. Without the helper on your
`PATH` it is refused (`git-remote-meddle is not on your PATH; add <data>/bin to it`). On any other machine of the
pool, `meddle checkout myproject` clones a checkout of your own. (The dashboard can add a project too, but it cannot
make your folder a checkout: use `meddle project add` for that.)

`task new` prints `task <id> on <short id>` once the first turn has started. Open `http://127.0.0.1:7777/`: the pool
view shows this node and its task; the task's view shows the conversation as it goes, with Approve and Deny for the
tool calls Claude Code asks about, Interrupt, a composer for the next message, and the task's model, effort and
permission mode. A task needs no project: `meddle task new "Compare these two libraries for me"`, run outside a
checkout, starts in a scratch folder of its own with your user layer only.

Run in a checkout with no `--project`, `task new` is a task of the checkout's project, and it starts on the newest
commit at or below your `@` that has changes (its fork point): the command pushes that commit to meddle and fetches
the task's line back, so it is read-only in your checkout when the command returns. If `@` itself has changes, `@` is
that commit, so run `jj new` afterwards to go on working. `--rev <rev>` starts it on another revision, and `--rev <rev>
--edit` has it work on that revision itself ([Where a task starts](../README.md#where-a-task-starts)). From anywhere
else, `--project myproject` starts it on the project's default branch.

The task's work is its line, which a checkout's fetch shows as the read-only bookmark
`meddle/task/<task id>/myproject@meddle`; it moves as the agent works. To take the work, fetch, review, then
fast-forward your branch onto the line and push it:

```sh
jj git fetch --remote meddle
jj bookmark set main -r meddle/task/<task id>/myproject@meddle
jj git push --remote meddle -b main
```

Once a pushed branch contains the task's work, the task is archived on its own
([Taking a task's work](../README.md#taking-a-tasks-work)). meddle never merges anything. The task's folder, with a jj
workspace per project, is under the task root.

### 7. Run it as a service

Stop the foreground node (Ctrl-C), then:

```sh
meddle service install --dry-run   # prints the unit it would write and the task-root command
meddle service install             # writes ~/.config/systemd/user/meddle.service and starts it
```

The unit runs `meddle serve` (the binary where it is now, or from the checkout), restarts it on failure, and starts it
at login. If you move the binary later, run `service install` again. Then:

- `journalctl --user -u meddle -f` follows its log; `systemctl --user restart meddle` restarts it.
- On a machine you are not logged in to (a server), make user services run without a login session:
  `sudo loginctl enable-linger $USER`.
- To set `MEDDLE_TASK_ROOT`, `MEDDLE_DATA_DIR`, `MEDDLE_PORT` or another variable for the service, run
  `systemctl --user edit meddle` and add `[Service]` / `Environment=NAME=value` lines. The `meddle` commands you type
  need the same values in your shell, or they talk to a different data directory and port.

A node running as a service and one started by hand in a terminal cannot run at once: the second fails to start
(on the git socket, or on the port when they use different data directories).

## The second machine

Repeat steps 1 to 3 there: clone at the same commit, `bun install`, link `bin/meddle`, create the task root, start
`serve` (or install the service straight away). Do not add tokens or settings again: they come with the pool.

A pool is a secret. Generate one on the first machine, copy the file to the second, and give it to that node too;
never pass it as an argument:

```sh
meddle pool secret --generate ~/pool-secret   # first machine: writes the file (mode 600) and sets it; prints "pool <short id> (default)"
scp ~/pool-secret gem:                        # or however you copy a file between the two
meddle pool secret --file ~/pool-secret       # second machine: prints the same pool id
meddle pool                                   # on either: one line per node, online, offline or gone
```

The pool id is public (the lighthouse sees it), so a secret of your own must not be guessable from it: the generated
one is 32 random bytes; a chosen one is accepted from 16 characters and is stretched with scrypt before use.

The two nodes announce themselves on a topic derived from the secret, find each other through the lighthouse, and
prove the secret to each other when they connect; nothing else admits a node. The command works with or without the
node running, and a running node takes the new secret at once. A node you want out of the pool is removed in the
dashboard's Settings view or with `meddle pool remove <id>`, and allowed back with Allow again or `meddle pool allow
<id>`; a removed node still knows the secret and the login tokens it pulled, so to shut it out for good give the
nodes you keep a new secret and reissue the logins ([The pool secret](../README.md#the-pool-secret)).

What follows on its own:

- the pool settings and the token list, within seconds; the new node pulls each token's value from a member that has
  it;
- every project: the new node makes a service repo of each, and fetches the commits the pool's rows name from any
  member, and each project's memory from its home. `meddle project list` on either node lists every project of the
  pool with its home and the nodes holding a copy, and `meddle checkout <project>` there gives you a checkout to work
  in;
- placement: `task new` without `--node` now picks between the two, preferring the project's home, then
  the node holding the project, then the one with fewer turns running. `--here` or `--node <short id>` chooses.

What does not follow: the profile (see below), and the checkout itself. A node given the secret before the first
node had set its settings merges its own settings with the pool's, newest value winning, so set the secret on the
first machine before its settings when you can, or check `config list` afterwards. Both machines must run the same meddle
commit: a newer node cannot create a task on an older one or move a task to it ([Where a new task
runs](../README.md#where-a-new-task-runs)).

The two nodes find each other through the lighthouse and connect directly when they can, through iroh's relays
otherwise. Nothing needs opening in a firewall for that. If you want a fixed UDP port to allow inbound, set
`MEDDLE_IROH_BIND=<ip>:<port>` for the service (the unit's comment shows where).

## Day to day

**Starting work.** `meddle task new "<prompt>" [--project <name> [--rev <rev>] [--edit]]...` from any machine, or New task in the
dashboard's sidebar (under a project, or under Tasks for none or several): the composer takes the projects, the node
and the first prompt. Without a prompt `task new` creates a task that waits idle;
`meddle task prompt <id> "<text>"` sends one and waits for the turn to end, so it is the command for scripts. A message
to a busy task is queued, never refused: Claude takes it at its next step, or runs it next
([README](../README.md#projects-and-tasks)).
`meddle task list` lists every task of the pool with its state and node.

**Watching.** Any node's dashboard shows the whole pool: a sidebar of projects and their tasks (each with its state,
what waits on you and the node it runs on), the nodes with their load at its foot, every task's thread wherever it
runs, and notices for a failed turn, a login out of tokens or a move that rolled back. A node's own tasks and another node's open the same way; the page's node relays the other's over the
pool.

**Moving a task.** From the dashboard (the node in the task's bar, or Move to… on its sidebar row) or `meddle task move <id> <short id>`, with `--now` to interrupt a
running turn instead of waiting for it. The workspaces, the conversation and queued prompts travel; the background
shells of an interrupted turn do not ([Moving a task](../README.md#moving-a-task)).

**Putting a task away.** `meddle task archive <id>` takes an idle task's folder off its node and keeps its log; the
dashboard shows it read-only. `meddle task restore <id>` brings it back, on the node meddle picks, `--here`, or
`--node <short id>`, with its session resumed. `meddle task delete <id>` deletes an archived task for good
([Archiving a task](../README.md#archiving-a-task)). Archiving is how you stop paying for an idle Claude Code session
without losing the thread.

**Working with branches.** You work in checkouts, never in a service repo. `jj git fetch --remote meddle` shows every
branch, every live task's line and any conflict; `jj git push --remote meddle` records branches, on any machine,
online or not. Pushes made from two machines that could not see each other are both kept, and the branch shows as
conflicted, with its sides as `meddle/conflict/<b>/<id>@meddle`. `meddle project status <project>` (or the project's
page in the dashboard) shows each branch and how to resolve one: push a merge of the sides, or drop one with
`git push meddle :refs/heads/meddle/conflict/<b>/<id>` ([Branches](../README.md#branches)).

### Profile: the user layer

On its first start a node copies `CLAUDE.md`, `settings.json`, `skills`, `agents`, `commands` and `hooks` from that
machine's `~/.claude` (or `CLAUDE_CONFIG_DIR`) into `<data dir>/profile`, a jj repo, and symlinks every task's Claude
Code config directory at it. `plugins` is a live symlink to `~/.claude/plugins` when that directory exists at the first start, else an empty
directory.

Two things to know. It is a snapshot: later changes to `~/.claude` do not reach it. Edit the files under
`<data dir>/profile` instead (new sessions see them), or stop the node, delete `<data dir>/profile` and start it again
to seed it afresh. And it is per node, not per pool: the design means for the profile to sync like memory does, but
that is not built, so a second machine seeds from its own `~/.claude`, or from empty defaults (an empty `CLAUDE.md`, `{}` settings,
empty directories) if there is none. Copy the entries
you want there before its first start, or copy the profile repo over.

### Per-project context

A project can carry `.meddle/context.toml` in its repo, read when a task of it starts: `env` (variables for the
task's Claude Code, winning over the pool's `env.*` settings), `claude.ask` (tool rules that stop for your approval),
`claude.autoMode.allow` / `soft_deny` / `hard_deny`, `claude.mcpServers`, `claude.skills` (a list, or `"all"`),
`instructions` (appended to the task's generated `CLAUDE.md`) and `resources` (`memoryMb`, `runs`, shown on the task
card). A `.claude/settings.json` in the project is layered under it as Claude Code's project settings.

## Updating

On every machine, together:

```sh
cd ~/projects/meddle
jj git fetch
jj new main              # or rebase your working copy onto the fetched main
bun install
systemctl --user restart meddle
```

A move is refused when the two nodes report different Claude Code versions, and nodes at different meddle commits
may not be able to talk at all (a newer node cannot use an older node's calls), so update them in one go: all nodes
together, before you use the pool again. The data directory and the task root carry over, except across the update
to service repos: nothing carries the projects and tasks of an older meddle over to it. Stop every node, update them
all, remove the old projects' and tasks' state on each (the replicas, memory repos, archives, task folders and
their tables; the tokens, the pool secret, the node's identity and the pool's settings stay), start them again and
add your projects again. [Upgrading to service repos](../README.md#upgrading-to-service-repos) lists exactly what to
remove and what to keep.

## When something is wrong

| You see | It means | Do |
| --- | --- | --- |
| `start "meddle serve" first` | The command needs the node and found nothing on port 7777 (or `MEDDLE_PORT`). | Start the node or the service; check your shell's `MEDDLE_PORT` matches the service's. |
| `pool (no secret set)` in `status`; the other node never shows up | This node has no pool secret, so it announces nothing and admits nobody. | `meddle pool secret` on it, with the pool's secret. |
| `… refused the connection: closed by peer: bad proof` or `… did not prove the pool secret` in the log | The two nodes have different secrets (or pool names). | Set the same secret with the same name on both. |
| `no usable token` | No token is `ok` (or its value is not on this node yet). | `meddle token list`; add one, or `token enable` a disabled one. |
| `this node has no task root` / `no online node hosts tasks` | The task root is missing or not writable on every candidate. | Create it (step 2) and restart the node. |
| `meddle: git: memory of <short id> …` in the log | A turn end could not sync the project's memory with its home: no jj identity, or the home offline. | `meddle config set jj.user …` and `jj.email`; check `meddle pool`. The next turn end tries again. |
| `git-remote-meddle is not on your PATH; add <data>/bin to it` | `project add` or `checkout` needs git's remote helper for meddle, which git finds by name. | Put `<data dir>/bin` on your shell's `PATH` (step 6). |
| `<b> is conflicted; push a merge of its siblings…` | Two machines pushed `<b>` without seeing each other; both commits are kept. | `meddle project status <project>` shows the sides and the fix. |
| A node shows offline though it runs | In the network lab (`lab/REPORT-2026-11-02.md`) a node that went away was noticed only after about 30 s. A node that restarted dials every member it remembers at once, and the first one it reaches tells the rest where it is now. | Wait half a minute; check the lighthouse URL in Settings; `meddle pool` on both sides. |
| `Move to … failed at handoff: Executable not found in $PATH: "jj"`, or `meddle status` says `jj is not on this node's PATH` | The service on that node runs with a `PATH` that lacks `jj` (a user service does not get your shell's). | On that node, run `meddle service install` again from your shell (the unit then carries its `PATH`), or link `jj` into a directory on the service's `PATH` (`ln -s ~/.cargo/bin/jj ~/.local/bin/jj`). |
| A move waits and you want it off | It waits for the running turn to end. | `meddle task move <id> --cancel` (or Cancel move in the task's view); `--now` instead interrupts the turn and goes ahead. |
| A node shows `gone` | Nothing was heard of it (no connection, no member connected to it, no lighthouse listing) for longer than the pool's `roster.forget` (15 min by default), so this node stopped dialling it. It is still a member. | Start it: it dials the others, proves the secret and is back. `meddle pool remove` it if it is not coming back. |
| `claude code <v> here, <w> there` on a move | The two nodes run different builds (or checkouts with different Agent SDKs). | Give both the same build. |
| Mixed-versions flag on the pool view | Nodes run different meddle or Claude Code versions. | Update every node (above). |
| Dashboard unreachable from another machine | It binds to localhost. | `ssh -L 7777:127.0.0.1:7777 <host>`, then open the local URL. |

The node logs to stderr: in the journal under the service, or the terminal when started by hand. A healthy pool logs
nothing; each distinct problem is logged at most once a minute.

## Starting over

```sh
systemctl --user disable --now meddle
rm -rf ~/.local/share/meddle      # the node's identity, pool, tokens, replicas and logs
sudo rm -rf /opt/meddle/tasks/*   # the task folders
```

A node started after that is a new node with a new id and a new pool of its own; the other nodes still list the old
one as a member until you remove it from their Settings view. Your checkouts are untouched: what they fetched stays
in them (`jj bookmark list --all-remotes 'glob:meddle/*'`), and their `meddle` remote points at the old node until you
change it.
