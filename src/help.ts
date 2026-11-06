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
          '`start "meddle serve" first` when it is not running. To run it in the background, see `meddle help service install`.',
      },
      {
        name: "status",
        usage: ["status"],
        summary: "Print this node's versions, data directory, task root, token, task count, id and pool.",
        details:
          "Works with or without the node running, and creates nothing: before the node's first start it prints " +
          "`node (none yet)` and `pool (none yet)`; before `pool secret` ran, `pool (no secret set)`.",
      },
      {
        name: "service install",
        usage: ["service install [--dry-run]"],
        summary: "Install `meddle serve` as a systemd user service, and start it.",
        details:
          "Writes ~/.config/systemd/user/meddle.service (running `serve` from this checkout), reloads systemd and " +
          "enables and starts the service, then prints a command to run once to create the task root. --dry-run prints " +
          "the unit and that command and changes nothing.",
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
          "roster.forget (seconds a member may go unheard of before it counts as gone; 0 is never). Values replicate to " +
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
        usage: ["project add <path-or-url> [--name <n>] [--sync <bookmark>]..."],
        summary: "Add a project from a folder on this node or an upstream URL; this node becomes its home.",
        details:
          "A folder is used in place (made a jj repo, colocated with git, if it is not one); a URL is cloned. The home " +
          "resolves where each new task of the project starts, and holds every task's work read-only as its line, " +
          "`task/<task id>/<project>@meddle`. Other nodes fetch it from the home when they need it. --name names it " +
          "(else after the folder, or the repo in the URL). --sync adds a sync branch (a bookmark tasks can start from; " +
          "repeatable; see `project sync`). Prints the project id. Needs the node running.",
      },
      {
        name: "project sync",
        usage: ["project sync <id|name> [<bookmark>...]"],
        summary: "Set the sync branches of a project homed on this node, replacing its list.",
        details:
          "A project's sync branches are the bookmarks a task can start from, in order; the first is the default. `project " +
          "add <url>` starts the list with the upstream's default branch and `project add <folder>` with none; each " +
          "`--sync <bookmark>` of `project add` adds one. With no bookmark, the list is emptied. Nothing polls them: a " +
          "task fetches its branch from the project's home as it is created (the home fetches a URL project's sync " +
          "branches from the upstream first). Refused on a node that is not the project's home. Needs the node running.",
      },
      {
        name: "project list",
        usage: ["project list"],
        summary: "List the pool's projects: id, name, home, the nodes holding a copy and sync branches.",
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
          "being the primary; with none the task has no project and works in a scratch folder. Each project gets a jj " +
          "workspace where the project's home says it starts: --rev <rev> (for the --project before it) starts it on a " +
          "new change on that revision, and with --edit too it works on the revision itself (one with changes, nothing " +
          "on top of it and no workspace on it). A --rev naming one of the project's sync branches starts it from that " +
          "branch as the home has it. Without --rev, a folder project starts on the fork point of the folder's `@` (the " +
          "newest ancestor with changes; refused while `@` itself has changes, as meddle never moves your working copy) " +
          "and a URL project from its first sync branch. A start at a revision is held read-only on the home from then " +
          "on, as the task's line `task/<task id>/<project>@meddle`. Creating needs each project's home online, except " +
          "for a sync start (a --rev naming a sync branch, or a URL project without --rev): that starts from the copy " +
          "the task's node fetched last. Without --node or --here meddle picks an online node that hosts " +
          "tasks and has room, preferring the primary project's home. Without --title, Claude Haiku names the task from " +
          "its prompt (the first 60 characters of the prompt's first line when it cannot), or with no prompt it gets " +
          "two adjectives and a noun. With a prompt it returns once the " +
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
        summary: "Run again a turn that repeated crashes parked.",
        details: "A turn that crashed the node several times is parked rather than started again; this releases it.",
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
          "Writes the task to an archive in the data directory and removes its folder; only committed work (its " +
          "bookmarks, pushed to each project's home) and the conversation survive. Refused unless the task is idle. " +
          "Bring it back with `task restore`.",
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
          "Refused for any other task. The bookmarks each project's home keeps for the task stay.",
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
        details: "Nodes move repos with git over the pool's connections; `serve` installs the wrapper git calls.",
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
