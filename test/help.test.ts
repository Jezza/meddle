// test/help.test.ts — `meddle help`, `--help` and `<command> --help`: what each command does, coloured on a terminal.
import { test, expect } from "bun:test";
import { helpRequest, usageFor, wantsColour } from "../src/help";
import { closedPort, meddle } from "./helpers";

const ESC = "\x1b[";

async function env(extra: Record<string, string> = {}) {
  return { MEDDLE_PORT: String(await closedPort()), FORCE_COLOR: "0", ...extra };
}

test("help, --help and -h print every command with what it does, on stdout", async () => {
  for (const args of [["help"], ["--help"], ["-h"]]) {
    const out = await meddle(args, await env());
    expect(out.code).toBe(0);
    expect(out.stderr).toBe("");
    expect(out.stdout).toContain("  meddle pool peer <node id>\n      Tell this node of another by its full id");
    expect(out.stdout).toContain("  meddle task new [<prompt>]");
    expect(out.stdout).toContain("  meddle task list");
    expect(out.stdout).not.toContain(ESC);
  }
});

test("a command's help says what it does in full, asked either way; a group's lists its commands", async () => {
  const asked = await meddle(["help", "pool", "peer"], await env());
  const flag = await meddle(["pool", "peer", "--help"], await env());
  expect(asked.code).toBe(0);
  expect(flag.stdout).toBe(asked.stdout);
  expect(asked.stdout).toStartWith("usage: meddle pool peer <node id>\n");
  expect(asked.stdout).toContain("still has to prove it holds");
  expect(asked.stdout).not.toContain("meddle pool remove");

  const group = await meddle(["help", "pool"], await env());
  for (const sub of ["pool", "pool secret", "pool peer", "pool remove", "pool allow"]) expect(group.stdout).toContain(`usage: meddle ${sub}`);
  // An argument before --help does not hide the command: `task new "a prompt" --help` is task new's help.
  const withPrompt = await meddle(["task", "new", "fix the build", "--help"], await env());
  expect(withPrompt.stdout).toStartWith("usage: meddle task new [<prompt>]");
  // `token set` is a second form of `token add`.
  expect((await meddle(["help", "token", "set"], await env())).stdout).toContain("usage: meddle token add");
});

test("project add and project sync are documented with their sync branches", async () => {
  const add = await meddle(["help", "project", "add"], await env());
  expect(add.stdout).toStartWith("usage: meddle project add <path-or-url> [--name <n>] [--sync <bookmark>]...\n");
  expect(add.stdout).toContain("--sync adds a sync branch");
  const sync = await meddle(["project", "sync", "--help"], await env());
  expect(sync.code).toBe(0);
  expect(sync.stdout).toStartWith("usage: meddle project sync <id|name> [<bookmark>...]\n");
  expect(sync.stdout).toContain("the list is emptied");
  const usage = await meddle(["project"], await env());
  expect(usage.code).toBe(2);
  expect(usage.stderr).toContain("meddle project sync <id|name> [<bookmark>...]");
});

test("help for no such command says so on stderr and exits 2; a usage error points at help", async () => {
  const out = await meddle(["help", "frob"], await env());
  expect(out.code).toBe(2);
  expect(out.stdout).toBe("");
  expect(out.stderr).toStartWith("meddle: no such command: frob\n");
  const usage = await meddle(["frob"], await env());
  expect(usage.code).toBe(2);
  expect(usage.stderr).toContain("meddle help [<command>] says what each command does.");
});

test("a usage error under a known command lists only that command's forms; under none, every command", async () => {
  const group = await meddle(["token"], await env());
  expect(group.code).toBe(2);
  expect(group.stderr).toStartWith("usage: meddle token add [--file <path>] [--label <l>]\n");
  expect(group.stderr).toContain("       meddle token enable <id|label>\n");
  expect(group.stderr).toContain("meddle help token says more.");
  expect(group.stderr).not.toContain("meddle pool");
  expect(group.stderr).not.toContain("meddle task");

  // An unknown subcommand falls back to its group; a known one with bad arguments narrows to its own forms.
  expect(usageFor(["token", "frob"])).toBe(usageFor(["token"]));
  expect(usageFor(["task", "move", "x"])).toBe(
    "usage: meddle task move <id> <node> [--now]\n       meddle task move <id> --now\n       meddle task move <id> --cancel\n\nmeddle help task move says more.",
  );
  expect(usageFor(["service"])).toStartWith("usage: meddle service install [--dry-run]\n\n");
  expect(usageFor(["frob"])).toBeNull();
  expect(usageFor([])).toBeNull();
});

test("help is coloured on a terminal or with FORCE_COLOR, plain otherwise or with NO_COLOR", async () => {
  expect(wantsColour({ isTTY: true }, {})).toBe(true);
  expect(wantsColour({ isTTY: true }, { NO_COLOR: "1" })).toBe(false);
  expect(wantsColour({ isTTY: true }, { TERM: "dumb" })).toBe(false);
  expect(wantsColour({ isTTY: false }, {})).toBe(false);
  expect(wantsColour({ isTTY: false }, { FORCE_COLOR: "1" })).toBe(true);
  expect(wantsColour({ isTTY: false }, { FORCE_COLOR: "0" })).toBe(false);

  const plain = helpRequest(["help", "pool", "peer"], false)!.text;
  const coloured = helpRequest(["help", "pool", "peer"], true)!.text;
  expect(plain).not.toContain(ESC);
  expect(plain).toContain("use `pool allow`.");
  // Coloured, the description is bright blue, a backticked span in it is drawn as code instead of quoted (back to blue
  // after it), and the rest reads the same.
  expect(coloured).toContain(`use ${ESC}33mpool allow${ESC}94m.`);
  expect(coloured).toContain(`\n${ESC}94m  Nodes with the same secret`);
  const words = (s: string) => s.split(/\s+/).filter(Boolean);
  expect(words(coloured.replace(/\x1b\[[0-9;]*m/g, ""))).toEqual(words(plain.replace(/`/g, "")));

  const out = await meddle(["help"], await env({ FORCE_COLOR: "1" }));
  expect(out.stdout).toContain(`${ESC}1;36mpool peer${ESC}22;39m ${ESC}32m<node id>${ESC}39m`);
  expect(out.stdout).toContain(`${ESC}94m      Tell this node of another`);
});

test("task new documents each project's start, and neither the help nor the README mentions trunk", async () => {
  const usage = "task new [<prompt>] [--title <t>] [--project <id|name> [--rev <rev>] [--edit]]... [--node <id|prefix> | --here]";
  const asked = await meddle(["help", "task", "new"], await env());
  expect(asked.code).toBe(0);
  expect(asked.stdout).toStartWith(`usage: meddle ${usage}\n`);
  expect(asked.stdout).toContain("fork point");
  expect(asked.stdout).toContain("--edit");
  const all = await meddle(["help"], await env());
  expect(all.stdout).toContain(`  meddle ${usage}`);
  expect(all.stdout.toLowerCase()).not.toContain("trunk");
  for (const command of ["task new", "project add", "project sync"]) {
    expect((await meddle(["help", ...command.split(" ")], await env())).stdout.toLowerCase()).not.toContain("trunk");
  }
  const readme = await Bun.file(`${import.meta.dir}/../README.md`).text();
  expect(readme).toContain(usage);
  expect(readme.toLowerCase()).not.toContain("trunk");
});
