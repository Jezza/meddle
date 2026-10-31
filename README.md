# meddle

meddle is a service you run on each of your machines to drive Claude Code sessions through the Agent SDK, so that a
task is created in one place and worked on wherever you assign it. Each task is a folder of jj workspaces with one
Claude Code session running in auto mode, which you watch, approve, interrupt and steer from a browser dashboard with
the fidelity of sitting at that machine's terminal. The services find each other and form one pool, sharing one
Claude login and each project's memory, and a task can move between machines without losing its conversation.

Status: Plan 2, the pool. Nodes form a pool over iroh: they find each other through a lighthouse, share the login
token, and the dashboard of any node shows every node and opens its tasks. Repo sync between nodes and moving tasks
are not here yet.

## Install

Requires [bun](https://bun.sh) and [jj](https://jj-vcs.github.io/jj/).

```sh
git clone <this repo> meddle
cd meddle
bun install
bun test
```

The commands below run from the checkout as `bun run src/cli.ts <command>`. `bun run build` also produces a compiled
`dist/meddle` for `status` and `token set`; the service itself runs from the checkout. The compiled binary embeds
iroh's native modules (two `.node` files, its glibc and musl builds), which make it about 40 MB larger (147 MB on linux-x64). It carries no `node_modules`, so it
reports its Claude Code version as `unknown`. A node served from it reports `unknown` to the pool too, so in a pool
with nodes served from a checkout the dashboard flags the members' versions as mixed.

## Task root

Every task lives under one task root, `/opt/meddle/tasks` by default. Create it once, owned by you:

```sh
sudo install -d -o $USER -g $(id -gn) -m 755 /opt/meddle/tasks
```

To use a different root, set `MEDDLE_TASK_ROOT` to it in the environment of every meddle command.

## Login token

meddle uses one token from `claude setup-token`. Store it by piping it in on stdin or from a file, never as an
argument:

```sh
claude setup-token          # copy the token it prints
bun run src/cli.ts token set               # paste it, then Ctrl-D
bun run src/cli.ts token set --file <path>
bun run src/cli.ts token status
```

It is written mode 600 in the data directory (`~/.local/share/meddle`, or `MEDDLE_DATA_DIR`) and given to Claude
Code as `CLAUDE_CODE_OAUTH_TOKEN`.

In a pool, set it on any one node. `token set` writes the token file on that node, recording the node as the one that
set it, then tells the running node (if any) that the token changed; it prints `token set` either way. The other
members pull it from there (see [Pool](#pool)).

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

### The token

The token crosses the network only as the answer to a request from a current member, over the encrypted iroh
connection. It never goes over the node's localhost socket (the CLI's and the dashboard's), and never into a ticket,
the roster or a log. Each node sees when the others' tokens were set, and pulls the token from a member whose token
was set later than its own. A token set while no node is running reaches the pool once that node serves.

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
| `MEDDLE_LIGHTHOUSE_URL` | `https://iroh.ichor.io` | The lighthouse for discovery; empty turns discovery off. |
| `MEDDLE_DISCOVERY_POLL_MS` | `10000` | How often a node looks its pool's topic up; at least `500`. |
| `MEDDLE_IROH_PRESET` | `n0` | iroh's `n0` preset (number 0's public relays and address lookup), or `minimal`: no relays and no address lookup, so nodes reach each other only at direct addresses (loopback setups and tests). |
| `MEDDLE_IROH_BIND` | iroh's default | The address iroh's UDP socket binds, as `<ip>:<port>`. |

## Projects and tasks

With the node running (next section), add a project from an existing folder or an upstream URL, then create a task
on it and send it a prompt:

```sh
bun run src/cli.ts project add ~/src/myproject [--name myproject]   # prints the project id
bun run src/cli.ts project list
bun run src/cli.ts task new --title "Fix the flaky test" --project <project-id>   # prints the task id
bun run src/cli.ts task prompt <task-id> "Find out why test_sync is flaky and fix it"
bun run src/cli.ts task retry <task-id>   # runs a turn again that repeated crashes parked
```

## Dashboard

```sh
bun run src/cli.ts serve
```

Then open <http://127.0.0.1:7777/> (`MEDDLE_PORT` changes the port). The dashboard binds to localhost only.

The dashboard of any node shows the whole pool: a card per node with its state (online, offline or removed); the
notifications of every online node; and a form for a new task on any online node that hosts tasks. An online node's
card shows its meddle and Claude Code versions, token, task root, resources and tasks. An offline member's card shows
what the roster last recorded of it (its versions, whether it hosts tasks and how many tasks it has) and when it was
last seen; a removed node's card says only that it was removed. It flags a pool whose members run different meddle or Claude Code
versions.

Another node's tasks open through the pool: the browser opens `/ws/node/<node id>` on the node it loaded the page
from, and that node carries the socket to the other one over iroh. A node that is not a member answers 404 and an
offline member 503. Settings shows this node's id, the pool id, the members, invites, joining another pool and the
token's status.

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
