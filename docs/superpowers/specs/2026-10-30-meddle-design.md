# meddle: design

Date: 2026-10-30. Status: draft, awaiting builder check.

meddle is a service you install on each of your machines. The services find
each other and form one pool. From any service's dashboard you add projects,
create tasks, assign a task to a machine, watch the Claude Code session that
works on it with the same fidelity as sitting at that machine's terminal, and
move the task to another machine when you want to. Everything is a jj repo.

The name follows `faff`, the author's local tool for faffing with Claude
Code workspaces. meddle is the one that reaches into other machines.

## 1. Intent and why

The author runs Claude Code in auto mode across several machines: a laptop,
a dev box called gem, and others. Today each session is bound to the machine
and terminal that started it. Compile-heavy tasks (Rust) want the big box,
exploratory ones want the laptop, and the author wants to decide that per
task, after the fact, without losing the conversation.

Three things must therefore be true:

1. **Placement is a choice, not an accident.** A task is created in one place
   and assigned anywhere. Reassigning it moves it.
2. **Nothing is lost on a move.** The conversation, the classifier's
   decisions, the files, and the project's memory all arrive intact.
3. **It is Claude Code, not an imitation.** The dashboard shows what Claude
   Code did and lets you do what its terminal lets you do. The auto mode
   classifier, skills, subagents, web search and auto memory all behave as
   they do in a terminal.

## 2. Vocabulary

| Term | Meaning |
|---|---|
| **service**, **node** | One meddle process on one machine. Has a stable iroh endpoint identity. |
| **pool** | The set of nodes that know each other. One per author. |
| **project** | A jj repo meddle knows about, from an existing folder or an upstream. Has a **context**. |
| **context** | Per-project configuration meddle applies to every task that touches the project: environment, tools, Claude Code settings, instructions. |
| **task** | A unit of work with a title, an owner node, attached projects, and one Claude Code session. Lives in a **task folder**. |
| **workspace** | A jj workspace of a project inside a task folder. One per attached project. |
| **session** | The Claude Code conversation of a task, identified by Claude Code's session id, which meddle chooses. |
| **move** | Reassigning a task to another node, carrying workspaces, session and queue. |
| **dashboard** | The browser UI any node serves. Shows the whole pool. |

## 3. Goals, non-goals, anti-goals

**Goals**

- Create, watch, steer, approve, interrupt and move tasks from a browser.
- Full parity with Claude Code's terminal: every tool call and result, diffs,
  subagent runs nested under their call, web searches, thinking, classifier
  denials with the rule that fired, usage and context size.
- Projects as jj repos, workspaces per task, peer-to-peer sync between nodes
  with no upstream required.
- One Claude login for the whole pool, rotated from any node.
- Project memory shared by every task of a project, on every node.
- Visible resource use per node and per task, with budgets you set.

**Non-goals**

- Multiple users or tenants. The pool is one person's.
- Automatic placement or scheduling. You assign; the dashboard helps you see
  where there is room.
- Engines other than Claude Code. Keep the seam, don't build the second one.
- Windows. Linux and macOS.
- Replacing faff on a single machine.

**Anti-goals** (a build that does these has failed even if it works)

- Claude Code behaving differently under meddle than in a terminal: stripped
  tools, altered prompts, a different approval model, memory off.
- A move that loses a transcript, a queued message, or a project memory.
- A move that needs an upstream repository.
- The service process rivalling a Claude Code child for memory.

## 4. Constraints and decided how

These were decided in conversation. They are not up to the builder.

- **Runtime: bun.** TypeScript throughout. Verified today: the Agent SDK,
  pi-durable with SQLite, chord and the iroh bindings all load and run
  under bun 1.4.4.
- **Engine: Claude Code through the Agent SDK** (`@anthropic-ai/claude-agent-sdk`,
  TypeScript). The SDK bundles the Claude Code binary; SDK 0.3.314 carries
  Claude Code 2.1.314. The SDK version is the Claude Code version.
- **Durable tasks: pi-durable** (`@earendil-works/pi-durable`) with SQLite
  storage, one Harness per service.
- **Replicated state and hot reload: chord** (`@earendil-works/chord`).
- **Networking: iroh** through the Node bindings (`@number0/iroh`, 1.2.0).
  Peer to peer, hole-punched QUIC with relay fallback.
- **Version control: jj**, colocated with git so git tooling and transports
  work. Commits never carry AI attribution.
- **Login: a `claude setup-token` token** held as pool state. Verified today
  on two machines at once; not device-bound.
- **Performance is monitored from day one**, with a rewrite of the service
  as the escape hatch if the service itself, not its children, becomes the
  cost.

## 5. Architecture

One bun process per machine. Inside it:

```
┌──────────────────────────────── meddle (bun) ────────────────────────────────┐
│  chord host ── Pool / Node / Project / Task / Session objects (replicated)   │
│      │ in-memory link           │ WebSocket link            │ iroh link      │
│  pi-durable Harness             browser dashboard            other nodes     │
│   SQLite: tasks, turns,                                                      │
│   transcripts (SessionStore)                                                 │
│      │                                                                       │
│  Agent SDK query() per live task ──► claude (bundled binary) per task        │
│  jj / git transport over iroh ──► project repos, task workspaces             │
└──────────────────────────────────────────────────────────────────────────────┘
```

Data flows:

- **Claude Code → meddle.** The SDK yields every message of a session. The
  service stores each one in SQLite, updates the Task and Session chord
  objects, and forwards transcript lines to its `SessionStore`.
- **meddle → Claude Code.** Steer and follow-up messages through streaming
  input; approvals through `canUseTool`; interrupt, mode, model and effort
  through the `Query` handle.
- **node ↔ node.** chord frames over an iroh stream for state; the git pack
  protocol over another iroh stream for commits; transcript and memory
  transfer on move.
- **browser ↔ node.** chord frames over WebSocket. The browser sees the
  whole pool through whichever node it connected to.

## 6. The pool

**Identity.** Each node has an iroh secret key persisted in its data
directory. Its endpoint id is its name in the pool.

**Membership is closed and explicit.** A pool starts with one node. Another
node joins with a ticket produced by a member (`meddle invite` prints an
iroh ticket; `meddle join <ticket>` on the newcomer). The member admits the
newcomer's endpoint id to the roster, and the roster replicates. A node
accepts streams only from roster members. Removal is an edit to the roster.

**Discovery** is the author's own iroh-lighthouse
(https://github.com/Jezza/iroh-lighthouse): a rendezvous server where a node
announces its full iroh address on a topic with a TTL and gets back every
other node on that topic in one round trip. A topic is a name plus a secret;
the pool's topic is `meddle/<pool-id>` with the pool secret, so the server
never learns names and outsiders cannot read the membership. The session
re-announces at half the TTL and on address change, and polls for changes.
meddle uses it from bun through the TypeScript client, iroh-lighthouse-ts,
against the author's hosted instance by default and a self-hosted one by
configuration. Dialing then uses iroh's n0 preset, relays and DNS, so a node
is reachable by id from anywhere and directly on a LAN.

The lighthouse tells a node who is on the topic; the roster says who is
allowed in. Both must agree before a stream is accepted.

**Transport.** Three ALPNs on the one endpoint, names illustrative:

| ALPN | Carries |
|---|---|
| `meddle/chord/0` | chord frames between hosts |
| `meddle/git/0` | git pack protocol: `git-upload-pack` and `git-receive-pack` for a named project repo |
| `meddle/blob/0` | files on move: transcript, side directory, anything else bulk |

**State replication** is chord's job. Each node hosts the objects it owns
(its Node, the Tasks it runs) and holds references to the rest. Every
browser and every node sees one consistent picture. The builder designs the
contracts; the objects and their state are sketched in section 13.

## 7. Projects, context and memory

**Repos across the mesh.** Every node that holds a project keeps one jj
repo for it in its data directory, colocated with git: that node's
**replica**. Adding a project from an existing folder makes that folder the
replica on that node; adding from an upstream clones one. Replicas are
peers. None is a mirror of another, and no upstream is needed for any of
what follows.

- **Home.** The node where a project was added is its home, reassignable in
  the dashboard. The home's `trunk` bookmark is the reference: the one the
  dashboard shows and new tasks start from. A project with an upstream has
  its home track `trunk` from the upstream, and by default only the home
  talks to the upstream; other nodes receive upstream changes through the
  home.
- **Remotes.** Each replica has one git remote per peer that holds the
  project, named after the node, with a `meddle://<endpoint-id>/<project-id>`
  URL served by `git-remote-meddle` over `meddle/git/0`. Peer bookmarks show
  up as `name@node` remote bookmarks in jj, so the Projects view shows every
  node's heads without meddle inventing a model of its own.
- **Bookmarks.** `trunk` belongs to the home. Each task owns
  `meddle/task/<task-id>/<project>` on the node running it, following the
  workspace's commits as they advance. Nothing else is shared.
- **When data moves.** Fetch on demand: a node fetches `trunk` from home
  when it first gets a task for a project, fetches the task bookmark from
  the source when a task moves in, and polls bookmarks slowly for the view.
  Push as backup: at every turn end the running node pushes the task
  bookmark to home, so a node that dies loses at most one turn of commits.
  On a move the target fetches the task bookmark from the source, and the
  source deletes its copy once the move completes.
- **Archive.** The task bookmark is pushed to home and kept there. Landing
  the work, rebase onto `trunk` and push upstream, is yours in jj or
  Claude's inside the task; meddle lands nothing in v1 and a "land" action
  is a later addition. Diverged bookmarks are jj's conflicted bookmarks and
  are shown as such.
- **Memory repos.** Each project has a second repo, its memory, under the
  same home and remote rules; see below.

**Context** is a file in the project, `.meddle/context.toml` by default,
with a node-side override for repos you don't control. The builder designs
the schema. It covers at least:

- environment variables and tools to ensure (mise-style; may delegate to
  mise if present);
- Claude Code settings fragments: extra `autoMode` allow and deny rules,
  `permissions.ask` rules for human checkpoints, MCP servers, hooks, skills
  to enable;
- instructions appended to the task's CLAUDE.md;
- resource hints shown on the task card (expected memory, "runs cargo").

The service materialises context into the task's Claude config directory
and SDK options on every start and resume.

**Memory.** Claude Code's auto memory lives in the project slot of the
Claude config directory, `projects/<slot>/memory/`. Each task has its own
config directory (section 8), so meddle makes that `memory/` a symlink to
the node's memory replica for the project, `<data>/memory/<project-id>/`,
which is a jj repo. Every task of a project on a node then shares one
memory, the faff trick, and `CLAUDE_CODE_PROJECT_DIR_NAME` set to the
project id, verified today to name the slot, keeps the link target
predictable. Across nodes the memory repo follows the repo rules above:
fetch and rebase before a session starts, push after it ends. Changes are
small and rare; a conflict keeps both sides for the next session to tidy.
When a project is added from an existing folder, the memory Claude Code
already kept for that path is imported into the replica.

A session reads one slot, so a task with several projects uses the primary
(first attached) project's memory. This is the author's agent's call; see
section 17.

Skills, agents, commands, hooks, the user CLAUDE.md and user settings are
shared the same way, through the node's profile replica (section 9), which
is one jj repo for the pool rather than one per project.

## 8. Tasks

**Folder.** One task root for the whole pool, default `/opt/meddle/tasks`,
created when the service is installed. Every task lives at the same
absolute path on every node it ever runs on; this is a requirement, not a
default (section 10).

```
<task-root>/<task-id>/
  .meddle/
    task.json              manifest: id, title, projects, owner, session id, root on this node
    claude/                CLAUDE_CONFIG_DIR for this task
      CLAUDE.md      -> <data>/profile/CLAUDE.md       the user layer, symlinked from the
      settings.json  -> <data>/profile/settings.json   node's profile replica (section 9)
      skills/        -> <data>/profile/skills/
      agents/        -> <data>/profile/agents/
      commands/      -> <data>/profile/commands/
      hooks/         -> <data>/profile/hooks/
      plugins/       -> <data>/plugins/                node-local, installed per node
      projects/<proj>/     transcript slot; memory/ -> <data>/memory/<proj>/
  CLAUDE.md                generated: what this task is, which folder is which project
  <project-a>/             jj workspace
  <project-b>/             jj workspace
```

**One Claude config directory per task.** Isolation is the point: tasks
never share transcripts, history or scratch state, and the directory is
regenerated on the target after a move rather than carried. What must be
shared is shared by symlink, the faff trick applied to the whole user
layer: memory from the project's memory replica (section 7), and
CLAUDE.md, settings, skills, agents, commands and hooks from the node's
**profile** replica, a jj repo synced across the pool the way memory is
("Supplying `~/.claude`" in section 9). The login comes in by environment
(section 11). Verified today: Claude Code discovers skills through a
symlinked `skills/` and leaves a symlinked `memory/` in place.

**Workspaces.** For each attached project, `jj workspace add --colocate`
from the node's project repo into the task folder, starting a new empty
change on the chosen parent (default: the project's trunk bookmark; the
dashboard lets you pick a change). `--colocate` gives the workspace a Git
worktree, so Claude Code's git awareness and any `git` command the model
runs work inside it. jj gives each workspace its own working-copy commit,
which satisfies "no two workspaces at the same revision, common parents
allowed" without extra rules. Attaching a project later adds a workspace
the same way.

**Lifecycle**, as pi-durable task types (names illustrative):

| Type | Does |
|---|---|
| `meddle.task` | Owns the task's life: provision, run turns, pause, move, archive. |
| `meddle.turn` | One Claude Code turn: start or resume the session, submit the prompt, record every message until the result, store queue state. The checkpoint is the session id and turn uuid, so a crashed service resumes the session rather than replaying the turn. |
| `meddle.move` | The move procedure, section 10. |
| `meddle.sync` | jj fetch and push for a project between two nodes. |
| `meddle.memory` | Memory repo sync for a project. |

pi-durable commits before showing, so the dashboard never sees state the
service could forget. One service process owns the SQLite file.

**Working directory.** A single-project task runs Claude Code with `cwd` in
that workspace and `projectConfigRoot` pointing at the node's project repo,
so project settings, hooks, skills and CLAUDE.md apply as they would in a
checkout. A multi-project task runs with `cwd` at the task folder, the
generated CLAUDE.md naming the workspaces, and project settings composed by
meddle into the inline settings, since Claude Code reads project settings
only from `cwd`.

## 9. The engine: Claude Code via the Agent SDK

Every option below was read from the SDK's type definitions at 0.3.314 or
confirmed in its docs today.

**Start.**

```ts
query({
  prompt: inputStream,                      // AsyncIterable: steer and follow-up mid-turn
  options: {
    cwd, projectConfigRoot,                 // section 8
    sessionId,                              // meddle chooses; only on the task's very first turn
    resume: sessionId,                      // on every turn after that, one child per turn
    permissionMode: 'auto',
    settings: compose(ctx.settings, { autoMode: { allow: ['$defaults', ...], soft_deny: [...], hard_deny: [...] }, permissions: { ask: ctx.askRules } }),  // the per-task layer only
    settingSources: single ? ['user', 'project', 'local'] : ['user'],   // 'user' is the profile, symlinked into the task's config dir
    systemPrompt: { type: 'preset', preset: 'claude_code', append: ctx.instructions },   // fixed for the task's life: the prefix is the cache
    agents: ctx.agents,
    strictMcpConfig: true,                  // claude.ai connectors can't work on the setup-token, section 11
    env: { PATH, HOME, CLAUDE_CONFIG_DIR, CLAUDE_CODE_PROJECT_DIR_NAME, CLAUDE_CODE_OAUTH_TOKEN, ENABLE_CLAUDEAI_MCP_SERVERS: 'false', ...ctx.env },
    includePartialMessages: true,
    forwardSubagentText: true,
    canUseTool,                             // dashboard answers
    hooks: { PermissionDenied: [...] },     // classifier verdicts with rule names
    sessionStore,                           // section 10
    mcpServers, skills,                     // from context
  },
})
```

`env` replaces the child's environment wholesale in the TypeScript SDK, so
the service composes it from scratch. Auto memory stays on.

**claude.ai connectors are off.** They are the MCP servers of the claude.ai
account, surfaced into Claude Code; on the author's laptop today they are
Asana, Atlassian, Box, Canva, Claude Docs, Excalidraw, Figma, HubSpot,
Intercom, Linear, Microsoft 365, Notion, Zoho CRM and monday.com. None is
needed for a coding task, and the setup-token "can only make model
requests", so Claude Code could not fetch them anyway; leaving them on would
cost a failed fetch per start. Local MCP servers from context are
unaffected.

**Supplying `~/.claude`.** The config directory is private per task, and
the user layer reaches it by symlink from the node's **profile replica**, a
jj repo at `<data>/profile/` synced across the pool like memory. Claude
Code then reads its user layer exactly as it does in a terminal, with
`'user'` in `settingSources`, and nothing is composed in code except the
per-task settings. What a `~/.claude` holds and where each part comes from:

| In `~/.claude` | Needed | Source in a task |
|---|---|---|
| `settings.json`: permissions, `autoMode` rules, hooks, model, env | yes | profile replica, symlinked; per-task overrides in inline `settings` |
| `CLAUDE.md`, the user's instructions | yes | profile replica, symlinked |
| `skills/`, `agents/`, `commands/`, `hooks/` | yes | profile replica, symlinked; verified for skills |
| `plugins/`, installed plugins such as superpowers | yes | node-local `<data>/plugins/`, symlinked; installed per node, since plugin caches are versioned and bulky |
| `projects/<slot>/memory/` | yes | memory replica, symlinked (section 7) |
| `projects/<slot>/*.jsonl`, transcripts | no | per task, mirrored to the store |
| `.credentials.json` | no | `CLAUDE_CODE_OAUTH_TOKEN` in the environment |
| `.claude.json`: onboarding, trust, globally defined MCP servers | partly | fresh per task; MCP servers come from context; SDK sessions have no trust prompt |
| `remote-settings.json`, `policy-limits.json`, server-managed | not ours | Claude Code fetches them for the account and applies them regardless |
| `history.jsonl`, `shell-snapshots/`, `session-env/`, `file-history/`, caches, telemetry, IDE and paste state | no | per task, discarded with the task |
| `statusline-command.sh`, keybindings | no | terminal only |

The SDK could supply most of the user layer as options too: inline
`settings`, `systemPrompt` with `append`, `plugins` by path, `agents`. Only
skills have no programmatic form, memory cannot be relocated, and
server-managed settings are not ours. Symlinks make that moot and keep one
source of truth: the profile replica is seeded from the node's own
`~/.claude` on first run, and from then on the dashboard edits it and the
pool syncs it.

**What meddle records**, as the session's event log: every `SDKMessage`,
about forty types, including partial assistant deltas, tool progress, task
started, updated and progress for subagents and background work, hook
events, compaction boundaries, memory recall, rate limit events, status
changes and `permission_denied` system messages. Subagent messages carry
`parent_tool_use_id`, so the dashboard nests them. Token deltas stream for
the main session only; subagent text arrives as whole blocks.

**Approvals.** Calls the classifier or rules allow never reach meddle.
Calls that would prompt arrive at `canUseTool` with the input, suggestions,
a blocked path and a decision reason; the dashboard shows the question and
meddle answers allow (optionally with edited input) or deny with a message,
or deny with `interrupt`. `AskUserQuestion` arrives the same way. Critical
path `rm` is denied by Claude Code without asking in SDK auto mode. After
repeated classifier blocks Claude Code pauses auto mode and resumes
prompting; those prompts are expected at `canUseTool`, which the builder
verifies.

**Classifier verdicts.** Denials arrive on the `PermissionDenied` hook and
as `permission_denied` messages with `decision_reason_type` of `classifier`,
`rule` or `mode` and a reason such as `[Data Exfiltration]`. The result
message's `permission_denials` is the authoritative list. Allow verdicts are
not surfaced by Claude Code; the dashboard infers them.

**Control.** `interrupt()`, `setPermissionMode()`, `setModel()`,
`setMaxThinkingTokens()`, `updateSettings()`, `stopTask()`,
`backgroundTasks()`, `getContextUsage()`, `rewindFiles()`. Slash commands
run by sending them as the prompt. `supportedCommands()` lists them.

**Availability.** Auto mode depends on the model and can be disabled
server-side; when unavailable the session starts in `default`, visible in
the init message's `permissionMode` and in `status` messages. meddle shows
the live mode on the task and falls back to prompting through `canUseTool`.
Switching to a model without auto support drops the mode to `default`.

**Version coupling.** The SDK pins the Claude Code binary, so the meddle
version is the Claude Code version, shown per node. Nodes on different
versions may coexist in a pool: chord contracts are versioned, and a move
is refused between nodes whose Claude Code versions differ, because the
transcript format is internal to Claude Code. Upgrades are per node and
manual in v1 (`meddle update`), with the dashboard flagging a pool on mixed
versions. Restarting or upgrading the service ends its children; every live
session is then resumed by pi-durable through `resume`, and the restart is
refused while a task is mid-turn unless forced. `prewarm` keeps a spare
child ready for instant task starts at the cost of a resident process; it
is a per-node knob, off by default.

## 10. Transcripts and moves

**Store.** meddle implements the SDK's `SessionStore` over its SQLite as a
mirror only. The SDK dual-writes: the child writes the JSONL under the
task's `CLAUDE_CONFIG_DIR`, then mirrors each batch to the store's
`append`. Appends are retried twice, then a `mirror_error` message is
emitted and the batch is dropped, so meddle dedupes on entry uuid, records
`mirror_error`, and on move prefers whichever copy is longer. meddle's
`load` always returns `null`: when `load` returns entries, the SDK resumes
from a temporary config directory of its own that carries neither the
profile symlinks nor memory, which would break section 8. Transcripts
therefore travel by meddle's own transfer (step 3 below), never through the
SDK's store-resume path. `SessionStore` cannot be combined with file
checkpointing, so rewind is off; the dashboard offers jj instead. The store
is alpha; the first milestone proves the mirror, the third proves a move.

**When a move happens.** "Move to" on an idle task runs at once. On a
running task it is queued: the task shows `moving` and the move runs when
the current turn ends, so nothing is cut off. "Move now" is the explicit
alternative: A calls `interrupt()`, waits for the result message, and B,
once resumed, submits a follow-up telling Claude the turn was interrupted
for a move and to carry on. Background shells and subagents are processes
on A and cannot travel; the dashboard says so before a "move now" and lists
them, and the follow-up on B names what was stopped.

**Move procedure**, from node A to node B:

1. Dashboard assigns the task to B. A marks the task `moving` and, at the
   turn boundary or after "move now", stops background tasks. Queued
   messages stay in the task record.
2. B fetches each workspace's change and its ancestors from A's project
   repo over `meddle/git/0`. A's bookmark `meddle/task/<id>/<project>` names
   the working-copy commit.
3. A streams the task's event log (every SDK message meddle recorded) and
   its transcript entries (every `SessionStore` line, subagent subkeys
   included) to B over `meddle/blob/0`. B writes them into its SQLite and
   into the task's fresh config directory, and replies with the count and
   last uuid of each. Verified today: a copied transcript resumes from any
   directory and any slot.
4. B syncs the project memory repos.
5. B creates the task folder under its own task root, adds a workspace per
   project at the fetched change, materialises the config directory, and
   starts the session with `resume: sessionId`. Queued messages are
   re-submitted. Nothing about the move is said to Claude: paths are the
   same, the workspace is the same, and the system prompt is untouched.
   Only a "move now" that cut a turn short gets a follow-up, submitted by
   meddle so Claude carries on, and nobody types anything.
6. A compares B's receipt with its own counts and records it durably. Only
   then does the Task's owner flip, and A forgets its workspaces, deletes
   the task folder and config directory, and deletes its event log and
   transcript rows.

**The transcript on a move.** It moves, and the origin forgets it. The
owner node holds the only authoritative copy; the move copies it, verifies
it, hands over ownership, then deletes the source, in that order. **The
owner decides.** Ownership is the authority over a task, so A, and only A,
decides when its copy goes, and the one condition is B's receipt recorded
durably on A. No third node and no person is involved. A crash before the
receipt leaves A as owner with everything intact and B holding a partial it
discards. A crash after the receipt leaves B as owner and A finishing its
cleanup on restart. At no point is a transcript the only copy while in
flight. As a safety net, A keeps a compressed, non-authoritative archive of
what it sent for a grace period, default seven days, never offered for
resume and removed by a janitor; it exists so a bug in the receiver costs a
restore rather than a conversation.

What travels: workspace commits, event log and transcript, queue, task
manifest. What is regenerated: settings, environment, token. What does not
travel: file checkpoints (off), shell snapshots, the prompt cache (the first
turn after a move pays a full cache miss), and files jj does not track.
Ignored and untracked files, `target/` and other build output above all,
are rebuilt on B; Claude finds that out the way it would after a clean
checkout, by building, and nothing needs saying. Secrets do not travel in
v1 (section 11). A per-project list of untracked paths to
carry over `meddle/blob/0` is a later addition.

**Paths.** Claude must start in the same task root on every node. The pool
has one absolute task root, default `/opt/meddle/tasks`, created with the
right ownership when the service is installed, the one moment meddle has
privileges anyway. A node that cannot provide the pool's root cannot host
tasks, and the dashboard says so on its card. Task paths are therefore
identical across nodes by construction, and a transcript stays true after a
move with nothing to repair and nothing to say. Nothing is ever patched to
bridge a path difference: not the system prompt, which is the cached prefix
and which a resumed session keeps as it started anyway; not old tool
results, since editing earlier turns would invalidate the model's signed
thinking blocks. `CLAUDE_CODE_PROJECT_DIR_NAME` keeps the transcript slot
and the store's project key independent of the path regardless, and jj
records each workspace's path only in that node's replica.

**Rules.** Only one live child may hold a session id; Claude Code refuses a
second. Resume restores the model unless overridden, does not rerun a tool
that was mid-flight, and does not restore `--add-dir` or MCP flags, which
meddle passes again from context.

## 11. Shared login

The pool's credential is one token from `claude setup-token`, a one-year
OAuth token that makes model requests only. It is pool state: `meddle token
set` on any node stores it and replicates it; every node writes it to a
mode-600 file and passes it to children as `CLAUDE_CODE_OAUTH_TOKEN`. No
node refreshes anything, so no leader and no coordination; a node offline
for a week still works when it returns. The dashboard shows the expiry and
warns a month out. Rotation is another `setup-token` and another `set`.

Verified today: the same token authenticated Claude Code on the laptop and
on gem at the same moment, each with an empty config directory so no other
login could be used.

The token travels only inside iroh's encrypted streams and never on a
command line. At rest it is plaintext in the data directory, like Claude
Code's own credentials file.

**Other secrets** are not meddle's in v1. A context may name environment
variables a node must provide from its own environment or files; a task
refuses to start on a node that lacks one, and the dashboard says which.
Pool-distributed secrets, replicated the way the token is, are a later
addition.

**Note for the author.** The Agent SDK overview says Anthropic does not
allow third-party developers to offer claude.ai login or rate limits for
their products, including SDK agents, without approval. meddle is one
person's tooling on their own account; reading that clause is the author's
call, and the API-key path works unchanged if they read it the other way.

## 12. Dashboard

Interaction follows Zed's Delta and JetBrains Air: the unit on screen is a
**thread**, the conversation together with the checkout it works in, you
look at one task at a time, and the pool tells you when another task needs
you.

**Views**

- **Pool.** One card per node: hostname, endpoint id, online, Claude Code
  and meddle versions, token status, resources (cores, memory, disk free,
  load, service RSS), the node's task budget you set, and its tasks with
  state. New task, add project, move.
- **Task.** The transcript rendered from meddle's event log, not from
  Claude's files: assistant text streaming, thinking, each tool call with
  arguments and result, diffs for edits, subagent runs nested under their
  call, web searches and results, classifier denials with the rule, memory
  recalls, compaction boundaries, usage and context size. A composer for
  steer and follow-up. Controls: approve or deny with edit, interrupt,
  permission mode, model, effort, move to. A projects panel with each
  workspace's jj log and diff against its parent.
- **Projects.** Add from folder or upstream, edit context, browse memory,
  see which nodes hold the repo and at what heads.
- **Settings.** Token, budgets, thresholds.

**Notifications.** A task waiting on approval, on an `AskUserQuestion`, on
a finished turn, or on a failed move raises a notification in every open
dashboard.

**Parity list.** Everything in "What meddle records" renders. Everything
in "Control" has a button. If Claude Code would show it or let you do it in
a terminal, the dashboard does, or the task is unfinished.

## 13. State sketch

chord objects, replicated; contracts are the builder's.

| Object | State |
|---|---|
| Pool | roster, token metadata (set-by, set-at, expires-at), versions |
| Node | identity, hostname, online, resources sampled, budget, versions, tasks owned |
| Project | id, name, upstream, context, nodes holding it with heads, memory head |
| Task | id, title, state (`new`, `provisioning`, `idle`, `running`, `waiting`, `moving`, `archived`), owner, projects with parent and current change, session id, queue |
| Session | a window over the event log, pending approvals, live mode, model, effort, usage, context size |

Durable storage holds the full event log and transcripts; chord carries
windows and summaries. A browser that reconnects gets the current view and
loads earlier history on demand, as pi-durable's `watch` already models.

## 14. Observability and budgets

Measured today on the author's laptop, one idle task driven by the SDK
under bun: about 280 MB peak RSS, of which the `claude` child is 223 MB and
the bun host 60 MB; init message at 1.25 s; a trivial answer at 1.7 to
1.9 s. These are the baselines.

Each node samples and replicates: RSS of each task's process tree, split
child and service; the service's own RSS and event loop lag; time from task
start to init and to first token; event lag from SDK receipt to durable
commit; dashboard round trip; count of live tasks. Thresholds live in node
config and are shown on the node card; crossing one is a notification.

**Rewrite trigger**, so the question is settled by numbers: if the service's
own RSS per live task exceeds a quarter of the child's, or event lag stays
above a second with the node at its task budget, the service is the cost
and a rewrite is on the table. Below that, the children and the compiler
are the cost and no rewrite helps.

## 15. Security

- Peers: closed roster by endpoint id, invitation by ticket, iroh encryption
  in transit.
- Token: as section 11.
- Transcripts hold everything a tool printed, credentials included, in
  plaintext at rest, as Claude Code's own do. The data directory is the
  user's, mode 700.
- The SDK's `sandbox` option exists; off by default to keep Claude Code's
  own behaviour, available per context.
- The dashboard binds to localhost by default; reaching it from elsewhere
  goes through the pool (pigeons for SSH, or a future iroh tunnel), not an
  open port.

## 16. Verified facts

All on 2026-10-30, Claude Code 2.1.314, SDK 0.3.314, bun 1.4.4, iroh
bindings 1.2.0, pi-durable 1.4.0, chord 1.4.0.

- Headless `claude` accepts `--permission-mode auto` together with the stdio
  permission prompt tool; the init frame reports `permissionMode: auto`.
- A Claude Code transcript moved to a different project slot resumes by id
  from a different working directory and recalls its content. Lookup is
  global by id. Nothing in the side-car blob hashes points at files.
- `claude setup-token` output works on two machines concurrently with empty
  config directories; `claude auth status` reports `oauth_token`.
- The Agent SDK under bun runs a session in auto mode with an isolated
  config directory and the token in `env`; `CLAUDE_CODE_PROJECT_DIR_NAME`
  names the slot under that directory.
- pi-durable's SQLite storage opens under bun; a Harness opens and closes;
  chord imports; `@number0/iroh` binds an endpoint under bun and node.
- Per-task footprint and latencies as in section 14.
- With a private config directory whose `skills/` is a symlink, Claude
  Code discovers the linked skill and lists it in the init message's
  `skills` and `slash_commands`; a symlinked `projects/<slot>/memory/` is
  left in place.

## 17. Calls made by the author's agent

Reasonable defaults, stated so they can be rejected:

- One pool-wide task root, default `/opt/meddle/tasks`, created at service
  install, is a requirement: a node that cannot provide it does not host
  tasks. Neither the system prompt nor history ever changes under a running
  session to bridge a path difference.
- One Claude config directory per task; memory and the whole user layer
  (CLAUDE.md, settings, skills, agents, commands, hooks) symlinked from
  per-node replicas that sync across the pool; plugins installed per node.
- The origin node alone decides to delete its copy of a moved task, on the
  target's durable receipt, and keeps a non-authoritative archive for seven
  days.
- Memory slot of a multi-project task is the primary project's.
- Task bookmarks are pushed to the project's home at every turn end as a
  backup.
- Auto memory on; claude.ai connectors off because the token cannot use
  them; sandbox off; switchable per context.
- Single-project tasks load project settings from the checkout; multi-project
  tasks get settings composed by meddle.
- Rewind is off in favour of the `SessionStore`; jj covers file history.
- Moves on a running task are queued to the turn end; "move now" interrupts
  and the target resumes with a follow-up that names what was stopped.
- Only commits travel on a move; build output is rebuilt; secrets other
  than the login are node-local in v1.
- Sync on demand with a slow bookmark poll; the home node's trunk is the
  reference; landing work is not meddle's job in v1.
- Mixed versions may coexist; moves are refused across Claude Code
  versions; upgrades are manual per node.
- Git transport is a `git-remote-meddle` helper over iroh rather than SSH
  through pigeons, so no node needs sshd and peer auth stays iroh's. pigeons
  remains the reference for the stdio tunnel shape and a fallback.

## 18. Left to the builder

- The context schema and its mapping onto SDK options.
- The profile replica: seeding from a node's `~/.claude`, which files are
  linked, how the dashboard edits it, and per-node plugin installation.
- Creating the pool-wide task root at install on Linux and macOS; a node
  that cannot is a non-hosting member.
- chord contracts for the objects in section 13 and the iroh link for chord
  frames.
- The `git-remote-meddle` helper and the jj configuration (`git.subprocess`)
  it needs; the bookmark scheme for task changes.
- pi-durable task definitions and phase boundaries; recovery after a
  service crash mid-turn.
- Dashboard framework and transcript renderer; how diffs are produced for
  Claude Code's `Edit` and `Write` results.
- Metrics collection and threshold configuration.
- CLI surface: `meddle serve`, `invite`, `join`, `project add`, `task new`,
  `token set`, `status`; packaging as a single `bun build --compile` binary
  and a systemd unit.
- Test strategy: real Claude Code sessions on Haiku for the engine seam,
  everything else without network.
- Whether the author's smaller arm64 boards can host tasks at all given the
  per-task footprint. The toolchain is not the obstacle: bun, the SDK binary
  and the iroh bindings all ship linux-arm64 builds, and the iroh bindings
  ship 32-bit arm too.
- Verifying iroh-lighthouse-ts against the `EndpointAddr` shape the
  `@number0/iroh` bindings expose, since the client was written for the
  browser.

## 19. Resolved after the builder check

The builder check raised nine questions on 2026-10-30. Seven were settled
as calls in section 17. The two put to the author were answered:

- **Config directory:** per task, with memory and the whole user layer
  shared by symlink from replicas that sync across the pool (sections 8
  and 9). The author's choice, in the spirit of faff, and verified to work
  for skills and memory.
- **A node going away:** the author reframed this as the transcript's
  lifecycle on a move, now section 10's "The transcript on a move". A task
  whose node is unreachable waits for it; its commits are at home as of the
  last turn end; failover proper is not v1.

## 20. References

- uji and uji-plugins (prior art for driving Claude Code over stdio, and for
  a model-judged auto mode): https://github.com/uji-labs/uji,
  https://github.com/uji-labs/uji-plugins
- pi, pi-durable and chord: https://github.com/earendil-works/pi
- pigeons, SSH over iroh: https://github.com/n0-computer/pigeons
- iroh Node bindings: https://www.npmjs.com/package/@number0/iroh
- iroh-lighthouse (the author's): https://github.com/Jezza/iroh-lighthouse
  and https://github.com/Jezza/iroh-lighthouse-ts
- Claude Agent SDK docs: https://code.claude.com/docs/en/agent-sdk/overview,
  sessions, session-storage, permissions, hooks
- Claude Code docs: permission-modes, auto-mode-config, sessions,
  authentication, headless
- Zed Delta: https://zed.dev/blog/introducing-delta
- JetBrains Air: https://blog.jetbrains.com/air/
