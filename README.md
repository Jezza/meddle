# meddle

meddle is a service you run on each of your machines to drive Claude Code sessions through the Agent SDK, so that a
task is created in one place and worked on wherever you assign it. Each task is a folder of jj workspaces with one
Claude Code session running in auto mode, which you watch, approve, interrupt and steer from a browser dashboard with
the fidelity of sitting at that machine's terminal. The services find each other and form one pool, sharing one
Claude login and each project's memory, and a task can move between machines without losing its conversation.

Status: Plan 1, single node. You can create tasks on a node, run Claude Code turns in auto mode, and watch and steer
them from the dashboard; the pool, repo sync between nodes and moving tasks are not here yet.

## Install

Requires [bun](https://bun.sh) and [jj](https://jj-vcs.github.io/jj/).

```sh
git clone <this repo> meddle
cd meddle
bun install
bun test
```

The commands below run from the checkout as `bun run src/cli.ts <command>`. `bun run build` also produces a compiled
`dist/meddle` for `status` and `token set`; the service itself runs from the checkout.

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
