// src/help.ts — what each CLI command does: `meddle help [<command>]`, `meddle --help`, `meddle <command> --help`.
import { sgr, wantsColour } from "./ansi";

type Command = {
  /** The command's words, as typed after `meddle`. */
  name: string;
  /** Its forms, each as typed after `meddle`. */
  usage: string[];
  /** One line: what it does. */
  summary: string;
  /** More: what it needs, what it prints, what to know. */
  details: string;
};

type Group = { title: string; commands: Command[] };

const GROUPS: Group[] = [
  {
    title: "This node",
    commands: [
      {
        name: "serve",
        usage: ["serve"],
        summary: "Run this node: its pool connections, its tasks and the dashboard.",
        details:
          "Runs in the foreground until stopped, and prints the node's id and the dashboard's address when it starts " +
          "(http://127.0.0.1:7777/ unless MEDDLE_PORT says otherwise). Most other commands talk to it, and say " +
          '`start "meddle serve" first` when it is not running. To run it in the background, see `meddle help service install`. ' +
          "Nothing of the projects and tasks of a meddle older than service repos carries over: stop and upgrade every " +
          "node, remove that state as the README's upgrade note lists (the tokens, the pool secret, the node's identity " +
          "and the pool's settings stay), start them and add the projects again.",
      },
      {
        name: "status",
        usage: ["status"],
        summary: "Print this node's versions, data directory, task root, token, task count, id and pool, and pool updates.",
        details:
          "Works with or without the node running, and creates nothing: before the node's first start it prints " +
          "`node (none yet)` and `pool (none yet)`; before `pool secret` ran, `pool (no secret set)`. Then pool updates: " +
          "`build <id> (<platform>)` (with a swap in progress here, such as `awaiting confirmation of build <id>`), " +
          "`pool build <id>` once a rollout was confirmed, a `node <name> build <id> <state>` line for every node this one " +
          "has heard of, and the current rollout: what it waits on, or when it was confirmed or failed and why.",
      },
      {
        name: "service install",
        usage: ["service install [--dry-run]"],
        summary: "Install `meddle serve` as a systemd user service, and start it.",
        details:
          "Writes ~/.config/systemd/user/meddle.service (running `serve` from this checkout, or from the binary), " +
          "reloads systemd and enables and starts the service, then prints a command to run once to create the task " +
          "root. --dry-run prints the unit and that command and changes nothing. The service is started again whenever it " +
          "ends, unless stopped with systemctl. From the binary the unit also runs the update guard before every start, " +
          "which rolls back a pool update whose new binary cannot start: run it again from a binary with updates in it " +
          "before the first `meddle update`, and after moving the binary (a pool update swaps the binary the unit runs).",
      },
    ],
  },
  {
    title: "The pool",
    commands: [
      {
        name: "pool",
        usage: ["pool [-v]"],
        summary: "The nodes of the pool as a table: state, versions and task counts; this node marked `@`.",
        details:
          "Columns: node (short id, its unique prefix highlighted), host, state (`online`, `offline`, `gone` or " +
          "`removed`), meddle and Claude Code versions (another node's in yellow where they differ from this one's) and " +
          "tasks. `-v` adds the connection held with each node: who dialed it and that node's session on it. `gone` " +
          "means nothing was heard of the node for longer than the pool's roster.forget, so this node stopped dialling " +
          "it; it is still a member. A host shown as `-` has not sent its summary yet. Needs the node running.",
      },
      {
        name: "pool secret",
        usage: ["pool secret [--file <path> | --generate <path>] [--name <name>]"],
        summary: "Join this node to a pool: set the secret every node of the pool shares.",
        details:
          "--generate <path> makes a new secret, writes it to that file (mode 600) and sets it here; copy the file to " +
          "each other node and run `pool secret --file <path>` there. Without either flag, paste a secret of your own on " +
          "stdin and end with Ctrl-D. --name names the pool (`default` unless given); the secret and the name together " +
          "make the pool, so every node must use the same name. Setting a different secret moves the node to another " +
          "pool: its connections close and its roster starts over. Prints `pool <short id> (<name>)`.",
      },
      {
        name: "pool peer",
        usage: ["pool peer <node id>"],
        summary: "Tell this node of another by its full id, so it dials it: for pools without a lighthouse.",
        details:
          "Nodes with the same secret normally find each other through the lighthouse. With discovery off, or to " +
          "connect two nodes before the lighthouse lists them, run this on either node with the other's full id (from " +
          "its `serve` output or `status`). It records the node as a member here at once, with or without this node " +
          "running, and the running node dials it. The other node still has to prove it holds the pool secret before " +
          "anything passes between them. Refused for a removed node: use `pool allow`.",
      },
      {
        name: "pool remove",
        usage: ["pool remove <id|prefix>"],
        summary: "Remove a member: every node closes its connection and refuses it.",
        details:
          "Takes a node id or a unique prefix of one (such as the short ids `meddle pool` prints). Every member merges " +
          "the removal and refuses the node from then on. Removal is bookkeeping, not security: the node still holds the " +
          "secret, so a new secret on the nodes you keep is the only real way to shut it out. Undo with `pool allow`. " +
          "Needs the node running.",
      },
      {
        name: "pool allow",
        usage: ["pool allow <id|prefix>"],
        summary: "Make a removed node a member again.",
        details:
          "Takes a node id or a unique prefix of one. The removed node keeps knocking, so the next knock is admitted " +
          "without a restart on either side. Needs the node running.",
      },
    ],
  },
  {
    title: "Login tokens",
    commands: [
      {
        name: "token add",
        usage: ["token add [--file <path>] [--label <l>]", "token set [--file <path>] [--label <l>]"],
        summary: "Add a Claude Code login token (from `claude setup-token`), on stdin or from a file.",
        details:
          "Never takes the token as an argument: paste it and end with Ctrl-D, or give --file. --label names it (else the " +
          "first 8 characters of its id); adding the same token again with a label renames it. Tokens are shared with the " +
          "pool, and a turn uses the first usable one in order: a new token goes last, as does a removed one added " +
          "again; `token move` changes the order. `token set` is the same command. " +
          "Works with or without the node running. Prints `token <id> (<label>)`.",
      },
      {
        name: "token list",
        usage: ["token list", "token status"],
        summary: "List the tokens: id, label, status and expiry. Never prints a value.",
        details:
          "A token is `ok`, `exhausted` (out of usage until a time), or `disabled` (until `token enable`). `token status` " +
          "is the same command. Works with or without the node running.",
      },
      {
        name: "token remove",
        usage: ["token remove <id|label>"],
        summary: "Remove a token, here and across the pool.",
        details: "Takes a full id or a label; a label two tokens share is refused, so name the token by its id then.",
      },
      {
        name: "token enable",
        usage: ["token enable <id|label>"],
        summary: "Make an exhausted or disabled token usable again.",
        details: "Takes a full id or a label. The dashboard's Enable button does the same.",
      },
      {
        name: "token move",
        usage: ["token move <id|label> --before <id|label>", "token move <id|label> --after <id|label>"],
        summary: "Put a token just before or just after another in the order turns try them, across the pool.",
        details:
          "Takes full ids or labels. A turn uses the first usable token in order, so `token move a --before b` makes a " +
          "turn try a first. Works with or without the node running; the dashboard's Up and Down buttons do the same. " +
          "Prints `moved <id> (<label>) before|after <id> (<label>)`.",
      },
    ],
  },
  {
    title: "Pool settings",
    commands: [
      {
        name: "config set",
        usage: ["config set <key> <value>"],
        summary: "Set a setting for the whole pool.",
        details:
          "Keys: jj.user and jj.email (the identity every node's jj and tasks commit with), env.<NAME> (an environment " +
          "variable for every task), lighthouse.url, limits.running (turns a node runs at once; 0 is no limit) and " +
          "roster.forget (seconds a member may go unheard of before it counts as gone; 0 is never), defaults.model and " +
          "defaults.effort (low, medium, high, xhigh or max) for tasks that chose none (unset: opus, medium), " +
          "describe.prompt (one line, at most 4096 characters, that asks an agent to describe its revisions; unset: " +
          "\"Add a description (4-7 words) to your revision(s).\"), " +
          "update.within (how long a rollout has to be confirmed; 30m by default) and update.health (how long a node " +
          "has after its swap to report healthy; 2m by default, at least 30s), as durations such as 90s, 30m or 1h. " +
          "Values replicate to " +
          "every member, so they are not for secrets. Needs the node running.",
      },
      {
        name: "config unset",
        usage: ["config unset <key>"],
        summary: "Unset a pool setting, back to its default.",
        details: "Needs the node running.",
      },
      {
        name: "config list",
        usage: ["config list"],
        summary: "Print the pool's settings, one `<key> = <value>` line each.",
        details: "Needs the node running.",
      },
    ],
  },
  {
    title: "Projects",
    commands: [
      {
        name: "project add",
        usage: ["project add <path-or-url> [--name <n>] [--no-fetch]"],
        summary: "Add a project from a folder on this node or an upstream URL; the folder becomes a checkout.",
        details:
          "The node builds the project's service repo (in its data directory, where the project's tasks are jj " +
          "workspaces) from the folder's or the URL's default branch: the folder's `main`, else `master`, or the URL's " +
          "HEAD branch. Tasks start from that branch unless told otherwise (see `project set-default`). Nothing fetches " +
          "from the URL after that: fetch its later changes in a checkout and push them to meddle. The folder is " +
          "made a jj repo colocated with git if it is not a jj repo (a jj repo that keeps its git repo elsewhere is " +
          "refused), and becomes a checkout: it gets a git remote `meddle` pointing at this node, and is fetched from " +
          "it (not with --no-fetch). The node never touches a checkout: only the meddle commands you run in it do. " +
          "That remote needs git-remote-meddle, in the data directory's bin, on your PATH (git finds it by name); " +
          "without it the add is refused with `git-remote-meddle is not on your PATH; add <data>/bin to it`, before " +
          "anything is added. Every node of the pool keeps a service repo of the project. A checkout's fetch shows each " +
          "branch where the pool's pushes put it (see `project status`) and every task's work as its line, " +
          "`meddle/task/<task id>/<project>@meddle`, read-only; a push records branches. --name names it (else after " +
          "the folder, or the repo in the URL). Prints the project id. Run again on a folder that is already a project " +
          "(the one its `meddle` remote names, or the one added from that path), it adds nothing and repairs the " +
          "checkout: the remote, the fetch, and, when meddle holds no default branch for it, a push of the folder's " +
          "`main` (else `master`), made the default branch if the project had none; a different --name is refused. " +
          "An upstream URL already added prints its project. Needs the node running. The dashboard's add " +
          "form builds the service repo too, but does not make the folder a checkout.",
      },
      {
        name: "project set-default",
        usage: ["project set-default <id|name> <branch>"],
        summary: "Set the branch a task of the project starts from when it names no revision.",
        details:
          "A project's default branch is set when it is added: the folder's `main`, else `master`, or the URL's HEAD " +
          "branch. A task started from outside a checkout with no --rev starts there, and a checkout's fetch makes it " +
          "the HEAD branch. It is set on the project's home, which every node takes it from: on a node other than the " +
          "home, it is refused while the home is offline. Needs the node running.",
      },
      {
        name: "project status",
        usage: ["project status <id|name>"],
        summary: "Print each branch of a project as this node computes it, and how to resolve a conflicted one.",
        details:
          "A branch is never stored: every node computes it from each node's record of the pushes it took, so every " +
          "node prints the same once it has heard the same pushes. One line per branch, the default branch first: " +
          "`<b>  <commit>`, then `still fetching <commits>, pushed elsewhere` for other nodes' pushes of it whose commits " +
          "have not reached this node: a push counts here only once its commit has. Two pushes " +
          "that could not see each other (machines offline, or not yet caught up) leave a branch conflicted, with " +
          "both commits kept as its siblings: a checkout fetches each as `meddle/conflict/<b>/<id>@meddle` (<id> is " +
          "its commit's first 12 characters), and the branch itself at their merge base. A task can't start from a " +
          "conflicted branch, and nothing on it accepts a task's work. A conflicted branch is followed by the fix: push " +
          "a commit descending from every sibling (a merge of them), or drop the side you don't want with " +
          "`git push meddle :refs/heads/meddle/conflict/<b>/<id>` (jj pushes only the deletion of a tracked " +
          "bookmark, and conflict refs arrive untracked); when your own `<b>` had work on a sibling that is not pushed, " +
          "`jj bookmark set <b> -r <your commit>` first, then push a merge of it with each sibling. Tracking a conflict " +
          "ref with `jj bookmark track` makes that sibling mutable in your checkout until you push its deletion. " +
          "Dropping a sibling, like rewinding or deleting a branch, can make jj abandon commits only the old position " +
          "held; jj says so, and `jj op log` gets them back. Needs the node running.",
      },
      {
        name: "project remove",
        usage: ["project remove <id|name>"],
        summary: "Remove a project from every node of the pool.",
        details:
          "Refused while a task of the project that is not archived uses it (the message names them: archive or delete " +
          "them first), and while a member of the pool runs an older meddle, which could not hear of it. Every node " +
          "deletes the project's row, its service repo and memory, its line and branch rows and its train; a node that is " +
          "offline does it when it reconnects, stopping and archiving any task of the project it still runs. Archived " +
          "tasks of the project stay listed and cannot be restored. Checkouts are not touched. There is no undo, and no " +
          "question first. Run again on a removed project (its id) it prints the same line. Needs the node running.",
      },
      {
        name: "checkout",
        usage: ["checkout <id|name> [<dir>]"],
        summary: "Clone a project from this node into a new checkout of your own.",
        details:
          "Clones into <dir> (else ./<project name>, refused when it exists and is not empty) a jj repo colocated with " +
          "git, whose remote `meddle` points at this node: fetch the project from it (`jj git fetch --remote meddle`), " +
          "and push branches to it (`jj git push --remote meddle`) from any machine of the pool. A checkout is any repo " +
          "with that remote: none is registered, and meddle changes one only during a meddle command you run in it. " +
          "A push that is not a fast-forward of a branch needs jj's --allow-backwards (git's --force), and moves the " +
          "branch everywhere; nothing under `meddle/` can be pushed, except the deletion of a conflict ref (see " +
          "`project status`). Needs git-remote-meddle, in the data directory's bin, on your PATH (else " +
          "`git-remote-meddle is not on your PATH; add <data>/bin to it`), and the node running. Prints the " +
          "checkout's path.",
      },
      {
        name: "project list",
        usage: ["project list"],
        summary: "List the pool's projects: id, name, home and the nodes holding a copy.",
        details: "Works while a holder is offline (it reads the roster). Needs the node running.",
      },
    ],
  },
  {
    title: "Tasks",
    commands: [
      {
        name: "task new",
        usage: ["task new [<prompt>] [--title <t>] [--project <id|name> [--rev <rev>] [--edit]]... [--node <id|prefix> | --here]"],
        summary: "Create a task and, given a prompt, start its first turn; without one it waits idle for one.",
        details:
          "--project takes one project (an id, or a name one project of the pool has) and can be given again, the first " +
          "being the primary; with none the task has no project and works in a scratch folder, except in a checkout of " +
          "this node, where it is the checkout's project (and --rev and --edit may then come without a --project). Each " +
          "project gets a jj " +
          "workspace on a new change on its start's revision, or, with --edit too, working on the revision itself (one " +
          "with changes, nothing on top of it and no workspace on it), its work measured from the revision's parents. " +
          "The start is resolved where the revision is, on this node; no other node needs to be online. Run in a " +
          "checkout of the project (its remote `meddle` naming this node), --rev <rev> (for the --project before it) is " +
          "a revision of the checkout, and without --rev the start is the fork point of your @ (the newest revision at " +
          "or below it with changes); the command checks it there, pushes it to this node and fetches the task's line " +
          "back, so the revision is read-only in your checkout when it returns. When your @ itself has changes, it is " +
          "that fork point: it is pushed and becomes read-only, so run `jj new` to go on working. --edit still needs a " +
          "--rev there. With --edit, when your @ is an empty change whose parent is the revision, it is " +
          "moved onto the revision's parents first (`moved your empty @ off <id>`). Elsewhere, --rev is a revision of " +
          "this node's service repo, and without --rev the project starts from its default branch (see `project " +
          "set-default`), refused `<branch> is conflicted; push a merge of its siblings` while concurrent pushes left " +
          "it with several heads (see `project status`). The start is held " +
          "read-only from then on, as the task's line (`meddle/task/<task id>/<project>@meddle` in a checkout). Once " +
          "any pushed branch contains the task's line in every project the task changed, the task is archived when " +
          "idle: a scratch bookmark on the line, pushed (say with `jj git push --all`), archives it too. When the line " +
          "moves off work it neither descends from nor rewrote (the agent started over with `jj new main`, say), that " +
          "work is kept as the side line `meddle/task/<task id>/<project>.before-<n>`, archived and kept when the task " +
          "is accepted without it; a rebase keeps none. " +
          "Without --node or --here meddle picks an online node that hosts " +
          "tasks and has room, preferring the primary project's home. Without --title, the task gets two adjectives and " +
          "a noun at once, and with a prompt Claude Haiku then names it from the prompt (the first 60 characters of " +
          "the prompt's first line when it cannot), unless it was renamed by then. With a prompt it returns once the " +
          "turn has started, not when it ends: follow it in the dashboard, or send the next prompt with `task prompt`. " +
          "Prints `task <id> on <short id>`.",
      },
      {
        name: "task list",
        usage: ["task list"],
        summary: "Every task of the pool as a table: id, state, node, host, projects and title.",
        details:
          "Node by node (this one first), archived tasks after the others; each id's unique prefix is highlighted, and " +
          "every task command takes that prefix, from any node. A task is `idle`, " +
          "`running`, `waiting` (for an approval), `moving`, `receiving` or `archived`. An offline member's tasks cannot " +
          "be read; a line on stderr says how many it had. Needs the node running.",
      },
      {
        name: "task prompt",
        usage: ["task prompt <id> <text>"],
        summary: "Send a task a prompt and print its turn as it runs, until the turn ends.",
        details:
          "Waits for the turn to end, so it suits scripts. A prompt sent while a turn is running goes into that turn.",
      },
      {
        name: "task retry",
        usage: ["task retry <id>"],
        summary: "Run again a turn that was parked, interrupted or failed.",
        details: "A turn that crashed the node several times is parked rather than started again; this releases it. On an idle task it starts a new turn that carries on from where the last one stopped, e.g. after you interrupted it.",
      },
      {
        name: "task accept",
        usage: ["task accept [--continue] <task-id>..."],
        summary: "Queue tasks on their project's merge train, which lands their work on the project's default branch.",
        details:
          "Takes any number of task ids (or unique prefixes), from any node, and prints `queued <id> on <project>'s " +
          "train` for each; accepting a task that is queued changes nothing. The train runs on the project's home: it " +
          "has each task's revisions described and merging cleanly with the default branch (a task that doesn't gets a " +
          "turn of its own to describe or rebase them), has tasks that land together checked by a merge task, and then " +
          "moves the default branch to the result, which archives the tasks. A running task can be accepted; its turn " +
          "goes on. A task leaves the train again when you unqueue it, send it a prompt (or steer or retry it) or " +
          "archive it, or when the train gives up on it; the dashboard then says why. Watch the train with `train`. " +
          "Each task is tried on its own: one that is refused (`send or clear the waiting prompts first`, `accept " +
          "handles one project for now; push to land the rest` for a task of several projects, or `nothing to land: the " +
          "task's work is already on <branch>`) is reported on stderr, with its id when there are several, and the exit " +
          "status is 1 once any was. A task on a node older than the train is not found at all: that node's tasks " +
          "cannot be listed, and the refusal is `no such task: <id> (<node> runs an older meddle: its tasks are not " +
          "listed)`. Needs the node running.",
      },
      {
        name: "task unqueue",
        usage: ["task unqueue <task-id>..."],
        summary: "Take tasks off their project's merge train.",
        details:
          "Takes any number of task ids (or unique prefixes), from any node, and prints `unqueued <id>` for each that was " +
          "queued, `<id> is not queued` for one that was not. When the task is in the batch the train is working on, " +
          "the round starts over without it. A prompt you send to a queued task (or a steer, Send now or retry) takes it " +
          "off the same way. A task on a node older than the train is refused as `task accept` refuses it. Needs the node " +
          "running.",
      },
      {
        name: "task move",
        usage: ["task move <id> <node> [--now]", "task move <id> --now", "task move <id> --cancel"],
        summary: "Move a task, with its workspaces and conversation, to another node; or hurry or cancel its move.",
        details:
          "<node> is a node id or a unique prefix of one. A move waits for a running turn to end first (it says so); " +
          "--now interrupts the turn instead. The node finishes the move in the background, across restarts. While a " +
          "move waits, `task move <id> --now` interrupts the turn after all. `task move <id> --cancel` calls the move " +
          "off while it waits or hands the task over: the task stays where it is, its turn untouched; once the target " +
          "has the task it is too late.",
      },
      {
        name: "task archive",
        usage: ["task archive <id>"],
        summary: "Take an idle task's folder off its node, keeping its conversation and committed work.",
        details:
          "Writes the task to an archive in the data directory and removes its folder; only committed work (its lines, " +
          "kept and held by this node, no longer shown to checkouts) and the conversation survive. No other node is " +
          "asked anything. Refused unless the task is idle. A task whose work a pushed branch contains is archived " +
          "without this. Bring it back with `task restore`.",
      },
      {
        name: "task restore",
        usage: ["task restore <id> [--node <id|prefix> | --here]"],
        summary: "Bring an archived task back, here, on a named node, or where meddle places it.",
        details:
          "Runs on the node holding the archive. Without --node or --here meddle places the task as it places a new one. " +
          "Restoring to another node finishes in the background; the dashboard shows its progress.",
      },
      {
        name: "task delete",
        usage: ["task delete <id>"],
        summary: "Delete an archived or moved task's archive, log and conversation.",
        details:
          "Refused for any other task. An archived task's lines are released, so their commits stay only where a " +
          "branch or another line holds them; a moved task's lines stay with the node that has it.",
      },
    ],
  },
  {
    title: "Merge train",
    commands: [
      {
        name: "train",
        usage: ["train [<project>] [--follow]", "train pause [<project>]", "train resume [<project>]"],
        summary: "Show a project's merge train, or pause or resume it.",
        details:
          "Prints why the train is paused (`paused: <reason>`), the queue in the order tasks were accepted (`task " +
          "accept`) with each task's state (`queued`, `turn running`, `describing`, `rebasing onto main`, `in the " +
          "batch`, `sitting out`, `waiting for <node>`) and, for one that sits out or is held back, why; then the round " +
          "under way: its step (describing, picking, checking, landing or rebasing), its batch and the merge task " +
          "checking it. With --follow it prints again each time something changes and ends once the queue is empty. " +
          "<project> is an id or a name; without one it is the project of the checkout you are in, or else the pool's " +
          "only project (a project named pause or resume is given by its id). `train pause` stops the train: a round " +
          "under way lets its running turns finish, but nothing lands and no new round starts, until `train resume`, " +
          "which also takes up a train paused by the merge agent's trouble (its reason shows as `paused: <reason>`). " +
          "The train runs on the project's home, and these commands talk to it there: when the home is offline they say " +
          "so, and the train waits for it; when it runs a meddle older than the train, `<node> runs an older meddle`. Watching it works while a pool update awaits confirmation; pausing and " +
          "resuming do not. Needs the node running.",
      },
    ],
  },
  {
    title: "Pool updates",
    commands: [
      {
        name: "update",
        usage: ["update [--force] [--within <duration>] [<binary>...]"],
        summary: "Roll a build out to every node of the pool, or (with no binaries) say how the current rollout goes.",
        details:
          "Give one binary per platform the pool runs, of one build (`bun run build --all` makes them). Every online " +
          "node that runs a binary of another build (or another binary of this one) takes part: it fetches its " +
          "platform's binary from the pool, checks it, starts no new turns (prompts queue), and waits for its running " +
          "turns to end; `--force` cuts them off " +
          "instead (they carry on after the restart), and given alone it forces the rollout draining now. Once every " +
          "node has drained they swap together: each copies its databases, puts the new binary in place and restarts. " +
          "From then until the pool confirms, they take no input (commands and pushes say `update in progress (build " +
          "<id>), try again shortly`). It is confirmed once every one reports healthy on the new build; if one fails, " +
          "or it is not confirmed within the pool's update.within (or `--within`, such as 90s, 30m or 1h), every one " +
          "goes back to its old binary and databases, and the failure stays in `meddle update`, `meddle status` and " +
          "the dashboard until the next rollout. A node that goes offline for a minute before it swaps fails it too. " +
          "Refused before anything changes for a rollout in progress, the build the pool runs when no node is behind " +
          "it (given again, it updates just the nodes behind it), and an online node " +
          "that has no binary for its platform, speaks an OTA version this build cannot drive, or cannot be updated " +
          "(a binary in a directory the service cannot write, or a unit from before updates or for another binary: " +
          "run `service install` again). Nodes run from a checkout take no part. A node that was away catches up " +
          "when it is back, from any member running its platform's binary; one whose update failed takes part in " +
          "the next rollout. Needs the node running.",
      },
    ],
  },
  {
    title: "Other",
    commands: [
      {
        name: "git-remote",
        usage: ["git-remote <name> <url>"],
        summary: "git's remote helper for meddle:// remotes; git runs it, not you.",
        details:
          "Nodes move repos with git over the pool's connections, and a checkout fetches from and pushes to its node " +
          "through it; `serve` writes the wrapper git calls, `<data>/bin/git-remote-meddle`, which must be on your PATH " +
          "for a `jj git fetch` or `jj git push` you type. Agents can't reach meddle:// remotes: a task's Claude Code " +
          "gets neither `<data>/bin` on its PATH nor `MEDDLE_GIT_SOCKET`; its lines and the branches reach it as rows.",
      },
      {
        name: "--version",
        usage: ["--version"],
        summary: "Print meddle's version.",
        details: "",
      },
    ],
  },
];

const COMMANDS = GROUPS.flatMap((g) => g.commands);

/** How help is drawn: with ANSI colours (on a terminal), or plain. */
type Paint = {
  title(s: string): string;
  /** A command's own words. */
  command(s: string): string;
  /** A `<placeholder>`. */
  arg(s: string): string;
  /** A `--flag`. */
  flag(s: string): string;
  /** What is quoted in backticks in prose: drawn as code, the backticks dropped. */
  code(s: string): string;
  dim(s: string): string;
  bold(s: string): string;
  /** A line of description: bright blue, its code spans returning to it rather than to the default colour. */
  desc(s: string): string;
  /** Whether `code` drops the backticks. */
  colour: boolean;
};

const COLOUR: Paint = {
  title: sgr("1;33", "22;39"),
  command: sgr("1;36", "22;39"),
  arg: sgr("32", "39"),
  flag: sgr("35", "39"),
  code: sgr("33", "39"),
  dim: sgr("2", "22"),
  bold: sgr("1", "22"),
  desc: (s) => `\x1b[94m${s.replaceAll("\x1b[39m", "\x1b[94m")}\x1b[39m`,
  colour: true,
};

const id = (s: string) => s;
const PLAIN: Paint = { title: id, command: id, arg: id, flag: id, code: id, dim: id, bold: id, desc: id, colour: false };

/** Whether help written to `stream` is coloured (re-exported for the CLI and its tests). */
export { wantsColour };

const WIDTH = 88;

/** Folds `text` into lines of at most `width` characters, each starting with `indent`. */
function wrap(text: string, indent: string, width = WIDTH): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line !== "" && indent.length + line.length + 1 + word.length > width) {
      lines.push(indent + line);
      line = word;
    } else line = line === "" ? word : `${line} ${word}`;
  }
  if (line !== "") lines.push(indent + line);
  return lines;
}

/** Prose, wrapped, with its backticked spans drawn as code (a span may run across lines). */
function prose(text: string, indent: string, paint: Paint): string[] {
  let inCode = false;
  return wrap(text, indent).map((line) => {
    let out = "";
    let run = "";
    for (const ch of line) {
      if (ch !== "`") {
        run += ch;
        continue;
      }
      // Plain, the backticks stay; coloured, the colour shows the span instead.
      if (inCode) {
        out += paint.code(paint.colour ? run : `${run}\``);
      } else {
        out += run;
      }
      run = inCode || paint.colour ? "" : "`";
      inCode = !inCode;
    }
    return out + (inCode ? paint.code(run) : run);
  });
}

/** A usage form, `meddle` and the command's words picked out from its arguments. */
function usageLine(usage: string, paint: Paint): string {
  const lead = leadingWords(usage);
  const tail = usage.slice(lead.length);
  const args = tail.replace(/(<[^>]+>)|(--?[a-z][a-z-]*)/g, (_m, arg: string | undefined, flag: string | undefined) =>
    arg !== undefined ? paint.arg(arg) : paint.flag(flag!),
  );
  return `${paint.dim("meddle")} ${paint.command(lead === "" ? usage : lead)}${lead === "" ? "" : args}`;
}

/** `meddle help`: every command, a line on what each does. */
export function overview(paint: Paint = PLAIN): string {
  const out = [paint.bold("meddle runs Claude Code tasks on a pool of your machines."), ""];
  for (const group of GROUPS) {
    out.push(paint.title(group.title));
    for (const c of group.commands) {
      for (const u of c.usage) out.push(`  ${usageLine(u, paint)}`);
      out.push(...prose(c.summary, "      ", paint).map(paint.desc));
    }
    out.push("");
  }
  out.push(...prose("`meddle help <command>` (or `meddle <command> --help`) says more about one; the README says everything.", "", paint));
  return out.join("\n");
}

/** One command, in full. */
function describe(c: Command, paint: Paint): string[] {
  const out = c.usage.map((u, i) => `${paint.dim(i === 0 ? "usage:" : "      ")} ${usageLine(u, paint)}`);
  out.push("", ...prose(c.summary, "  ", paint).map(paint.bold));
  if (c.details !== "") out.push("", ...prose(c.details, "  ", paint).map(paint.desc));
  return out;
}

/** The words a usage form starts with (`token set [--file <path>]` gives `token set`). */
function leadingWords(usage: string): string {
  const words = usage.split(" ");
  const end = words.findIndex((w) => !/^[a-z][a-z-]*$/.test(w));
  return words.slice(0, end === -1 ? words.length : end).join(" ");
}

/**
 * The help for the command `words` name, or for every command under them (`pool` gives `pool` and the `pool …`
 * commands), or null when they name none.
 */
function helpFor(words: string[], paint: Paint): string | null {
  const topic = words.join(" ");
  const names = (c: Command) => [c.name, ...c.usage.map(leadingWords)];
  const exact = COMMANDS.filter((c) => names(c).includes(topic));
  const under = words.length > 1 && exact.length > 0 ? exact : COMMANDS.filter((c) => names(c).some((n) => n === topic || n.startsWith(`${topic} `)));
  const rule = paint.dim("─".repeat(WIDTH));
  return under.length === 0 ? null : under.map((c) => describe(c, paint).join("\n")).join(`\n\n${rule}\n\n`);
}

/**
 * The help `args` ask for, or null when they ask for none: `help`, `--help` or `-h` first (then what follows names
 * the command, or nothing for the overview), or `--help` or `-h` after a command's words. `found` is false when the
 * words name no command; `text` then says so, followed by the overview. `colour` draws it with ANSI colours.
 */
export function helpRequest(args: string[], colour = false): { text: string; found: boolean } | null {
  const paint = colour ? COLOUR : PLAIN;
  const [first, ...rest] = args;
  if (first === undefined) return null;
  if (first === "help" || first === "--help" || first === "-h") {
    if (rest.length === 0) return { text: overview(paint), found: true };
    const text = helpFor(rest, paint);
    return text === null ? notFound(rest, paint) : { text, found: true };
  }
  // git runs the remote helper with arguments of its own choosing.
  if (first === "git-remote") return null;
  const at = args.findIndex((a) => a === "--help" || a === "-h");
  if (at === -1) return null;
  // `task new "a prompt" --help` is about task new: the longest run of the leading words that names a command.
  const words = args.slice(0, at);
  for (let n = Math.min(words.length, 2); n > 0; n--) {
    const text = helpFor(words.slice(0, n), paint);
    if (text !== null) return { text, found: true };
  }
  return notFound(words, paint);
}

/**
 * The usage forms for a command line that named no command, narrowed to the longest run of its leading words (at most
 * two) that some form starts with: `token frob` gives every `token` form, `task move x` the `task move` forms. Null
 * when no form starts with its first word, or with no words at all.
 */
export function usageFor(args: string[]): string | null {
  const forms = COMMANDS.flatMap((c) => c.usage);
  for (let n = Math.min(args.length, 2); n > 0; n--) {
    const topic = args.slice(0, n).join(" ");
    const matching = forms.filter((u) => {
      const lead = leadingWords(u);
      return lead === topic || lead.startsWith(`${topic} `);
    });
    if (matching.length > 0) {
      const lines = matching.map((u, i) => `${i === 0 ? "usage:" : "      "} meddle ${u}`);
      return [...lines, "", `meddle help ${topic} says more.`].join("\n");
    }
  }
  return null;
}

function notFound(words: string[], paint: Paint): { text: string; found: false } {
  return { text: `meddle: no such command: ${words.join(" ")}\n\n${overview(paint)}`, found: false };
}
