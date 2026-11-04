// test/help.test.ts — `meddle help`, `--help` and `<command> --help`: what each command does, coloured on a terminal.
import { test, expect } from "bun:test";
import { helpRequest, wantsColour } from "../src/help";
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

test("help for no such command says so on stderr and exits 2; a usage error points at help", async () => {
  const out = await meddle(["help", "frob"], await env());
  expect(out.code).toBe(2);
  expect(out.stdout).toBe("");
  expect(out.stderr).toStartWith("meddle: no such command: frob\n");
  const usage = await meddle(["frob"], await env());
  expect(usage.code).toBe(2);
  expect(usage.stderr).toContain("meddle help [<command>] says what each command does.");
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
