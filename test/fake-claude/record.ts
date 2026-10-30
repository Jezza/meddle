// Records a real Claude Code session's stream-json frames to test/fixtures/<name>.jsonl.
// Usage: MEDDLE_LIVE=1 CLAUDE_CODE_OAUTH_TOKEN=... bun run test/fake-claude/record.ts <name> <prompt>
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform, Writable } from "node:stream";
import { query, type Options, type SpawnedProcess, type SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

type Entry =
  | { dir: "in" | "out"; t: number; line: string }
  | { dir: "close"; t: number }
  | { dir: "exit"; t: number; code: number | null };

const [name, prompt] = process.argv.slice(2);
if (process.env.MEDDLE_LIVE !== "1") { console.error("record.ts: refusing to run without MEDDLE_LIVE=1"); process.exit(2); }
if (!name || !prompt || !["hello", "approval"].includes(name)) { console.error("usage: record.ts hello|approval <prompt>"); process.exit(2); }
const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
if (!token) { console.error("record.ts: CLAUDE_CODE_OAUTH_TOKEN is not set"); process.exit(2); }

const start = Date.now();
const entries: Entry[] = [];
const now = () => Date.now() - start;

/** Calls `emit` with each complete `\n`-terminated line; buffers the partial tail. */
function lineSplitter(emit: (line: string) => void) {
  let buf = "";
  return {
    push(chunk: string) {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) !== -1) { emit(buf.slice(0, i)); buf = buf.slice(i + 1); }
    },
    flush() { if (buf) emit(buf); buf = ""; },
  };
}

let childExited!: Promise<void>;
let stderrTail = "";

function spawnTeed(options: SpawnOptions): SpawnedProcess {
  const child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, stdio: "pipe", signal: options.signal });
  childExited = new Promise(resolve => child.once("exit", (code) => { entries.push({ dir: "exit", t: now(), code }); resolve(); }));
  child.stderr.on("data", (d: Buffer) => { stderrTail = (stderrTail + d.toString()).slice(-4000); });

  const inLines = lineSplitter(line => entries.push({ dir: "in", t: now(), line }));
  const stdin = new Writable({
    write(chunk, _enc, cb) { inLines.push(chunk.toString()); child.stdin.write(chunk, cb); },
    final(cb) { inLines.flush(); entries.push({ dir: "close", t: now() }); child.stdin.end(cb); },
  });
  child.stdin.on("error", err => stdin.destroy(err));

  const outLines = lineSplitter(line => entries.push({ dir: "out", t: now(), line }));
  const stdout = new Transform({
    transform(chunk, _enc, cb) { outLines.push(chunk.toString()); cb(null, chunk); },
    flush(cb) { outLines.flush(); cb(); },
  });
  child.stdout.pipe(stdout);

  return {
    stdin, stdout,
    get killed() { return child.killed; },
    get exitCode() { return child.exitCode; },
    get signalCode() { return child.signalCode; },
    kill: (signal) => child.kill(signal),
    on: (event: any, listener: any) => { child.on(event, listener); },
    once: (event: any, listener: any) => { child.once(event, listener); },
    off: (event: any, listener: any) => { child.off(event, listener); },
  };
}

const configDir = mkdtempSync(join(tmpdir(), "meddle-record-"));
const options: Options = {
  model: "claude-haiku-5-5",
  settingSources: [],
  env: { CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_OAUTH_TOKEN: token, PATH: process.env.PATH, HOME: process.env.HOME },
  spawnClaudeCodeProcess: spawnTeed,
  ...(name === "hello"
    ? { permissionMode: "auto", tools: [] }
    : {
        permissionMode: "default", tools: ["Bash"],
        // echo is read-only and would be auto-allowed; an ask rule forces the can_use_tool request.
        settings: { permissions: { ask: ["Bash(echo hi)"] } },
        canUseTool: async (_tool, input) => ({ behavior: "allow", updatedInput: input }) }),
};

let resultSubtype = "none";
try {
  for await (const m of query({ prompt, options })) if (m.type === "result") resultSubtype = m.subtype;
  await Promise.race([childExited, new Promise(r => setTimeout(r, 10_000))]);
} catch (err) {
  console.error(`record.ts: session failed: ${(err as Error).message.split("\n")[0]}`);
  if (stderrTail) console.error(stderrTail);
  process.exitCode = 1;
} finally {
  rmSync(configDir, { recursive: true, force: true });
}

const kept = entries.filter(e => !("line" in e) || (!e.line.includes(token) && !e.line.includes("sk-ant-")));
const scrubbed = entries.length - kept.length;
const file = join(import.meta.dir, "..", "fixtures", `${name}.jsonl`);
writeFileSync(file, kept.map(e => JSON.stringify(e)).join("\n") + "\n");
console.log(`recorded ${kept.length} lines (${scrubbed} scrubbed), result subtype: ${resultSubtype}`);
