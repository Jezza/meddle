// Stands in for the `claude` binary: replays a recorded stream-json session (see record.ts).
// Env: MEDDLE_FIXTURE (path to a .jsonl recording), MEDDLE_FIXTURE_STALL=1 (pause before `result` until stdin ends or,
// as Claude Code ends an interrupted turn, an `interrupt` arrives: then the `result` comes as `error_during_execution`
// and the stand-in exits),
// MEDDLE_FIXTURE_MEMORY=1 (append the first prompt to the project's memory, see `transcribe`),
// MEDDLE_FIXTURE_BY_TOKEN=<token>=<path>,<token>=<path> (the recording of the entry whose token is the
// CLAUDE_CODE_OAUTH_TOKEN this run got; MEDDLE_FIXTURE when none is).
// Any argv is accepted; only `--session-id` / `--resume` are read (see `transcribe`). Dependency-free so it
// starts fast.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Entry = { dir: "in" | "out"; t: number; line: string } | { dir: "close"; t: number } | { dir: "exit"; t: number; code: number | null };
type Frame = { type: string; subtype?: string; message?: { content?: unknown }; request_id?: string; request?: { subtype?: string }; response?: { request_id?: string } };
type Need = { kind: "user" } | { kind: "response" } | { kind: "host"; subtype: string } | { kind: "type"; type: string };
type Step = { need: Need } | { emit: string; frame: Frame };

/** The recording for the token this run got, from MEDDLE_FIXTURE_BY_TOKEN, if it lists that token. */
function fixtureForToken(): string | undefined {
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  for (const entry of (process.env.MEDDLE_FIXTURE_BY_TOKEN ?? "").split(",")) {
    const at = entry.indexOf("=");
    if (at > 0 && entry.slice(0, at) === token) return entry.slice(at + 1);
  }
  return undefined;
}
const fixture = fixtureForToken() ?? process.env.MEDDLE_FIXTURE;
if (!fixture) { process.stderr.write("replay.ts: MEDDLE_FIXTURE is not set\n"); process.exit(2); }
const stall = process.env.MEDDLE_FIXTURE_STALL === "1";
const memory = process.env.MEDDLE_FIXTURE_MEMORY === "1";
const EOF_CAP_MS = 5_000;

// Turn the recording into steps: wait for an `in` line, or emit an `out` line. Responses to the
// host's own control requests are lifted out of the sequence and served on demand by subtype.
const entries: Entry[] = readFileSync(fixture, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
const hostRequestSubtype = new Map<string, string>(); // recorded request_id -> subtype
for (const e of entries) {
  if (e.dir !== "in") continue;
  const f: Frame = JSON.parse(e.line);
  if (f.type === "control_request" && f.request_id) hostRequestSubtype.set(f.request_id, f.request?.subtype ?? "");
}
const recordedResponse = new Map<string, Frame>(); // subtype -> recorded control_response
const steps: Step[] = [];
let sawClose = false, exitedOnItsOwn = false;
for (const e of entries) {
  // A recorded `close` is the SDK ending stdin; where it falls among the child's output is
  // incidental, so it never gates an `out` line. It only decides the lifetime at the end.
  if (e.dir === "close") { sawClose = true; continue; }
  if (e.dir === "exit") { exitedOnItsOwn = !sawClose; continue; }
  const f: Frame = JSON.parse(e.line);
  if (e.dir === "in") {
    if (f.type === "control_request") steps.push({ need: { kind: "host", subtype: f.request?.subtype ?? "" } });
    else if (f.type === "control_response") steps.push({ need: { kind: "response" } });
    else if (f.type === "user") steps.push({ need: { kind: "user" } });
    else steps.push({ need: { kind: "type", type: f.type } });
    continue;
  }
  const answers = f.type === "control_response" ? hostRequestSubtype.get(f.response?.request_id ?? "") : undefined;
  if (answers !== undefined) recordedResponse.set(answers, f);
  else steps.push({ emit: e.line, frame: f });
}
const lastEmit = steps.findLastIndex(s => "emit" in s);

// stdin: answer host control requests at once; queue everything for the waits.
const arrived: { frame: Frame; used: boolean }[] = [];
let eof = false;
let wake: () => void = () => {};
let lastEmittedRequestId: string | undefined;
let stalling = false;
/** While stalling: the `result` line held back, sent (as an interrupted turn's) when an interrupt arrives. */
let heldResult: string | undefined;

const write = (line: string) => process.stdout.write(line + "\n");
/** Exits 0 once everything written to stdout has been flushed. */
async function finish(): Promise<never> {
  await new Promise(r => process.stdout.write("", r));
  process.exit(0);
}

function answer(f: Frame) {
  const liveId = f.request_id;
  const recorded = recordedResponse.get(f.request?.subtype ?? "");
  const reply = recorded
    ? { ...recorded, response: { ...recorded.response, request_id: liveId } }
    : { type: "control_response", response: { subtype: "success", request_id: liveId, response: {} } };
  write(JSON.stringify(reply));
}

let buf = "";
process.stdin.on("data", (chunk: Buffer) => {
  buf += chunk.toString();
  let i: number;
  while ((i = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let f: Frame;
    try { f = JSON.parse(line); } catch { continue; }
    if (f.type === "control_request") answer(f);
    if (f.type === "control_request" && f.request?.subtype === "interrupt" && stalling && heldResult !== undefined) {
      write(JSON.stringify({ ...JSON.parse(heldResult), subtype: "error_during_execution", is_error: true, errors: [] }));
      heldResult = undefined;
      // The SDK keeps stdin open after an interrupted turn's result (meddle closes it after a grace period): the
      // stand-in ends the session itself instead.
      void finish();
    }
    arrived.push({ frame: f, used: false });
  }
  wake();
});
process.stdin.on("end", () => { eof = true; if (stalling) finish(); wake(); });

function matches(need: Need, f: Frame): boolean {
  switch (need.kind) {
    case "user": return f.type === "user";
    case "response": return f.type === "control_response" && f.response?.request_id === lastEmittedRequestId;
    case "host": return f.type === "control_request" && f.request?.subtype === need.subtype;
    case "type": return f.type === need.type;
  }
}

/** The session id the SDK passed (`--session-id <id>` or `--resume <id>`, either also as `--flag=<id>`). */
function sessionArg(): string | undefined {
  const argv = process.argv;
  for (const flag of ["--session-id", "--resume"]) {
    const i = argv.indexOf(flag);
    if (i !== -1 && i + 1 < argv.length) return argv[i + 1];
    const joined = argv.find(a => a.startsWith(`${flag}=`));
    if (joined !== undefined) return joined.slice(flag.length + 1);
  }
  return undefined;
}

let transcribed = false;
/**
 * Like the real CLI, writes the session's transcript once it reads the first user message: one line, that message,
 * appended to `<CLAUDE_CONFIG_DIR>/projects/<CLAUDE_CODE_PROJECT_DIR_NAME>/<session id>.jsonl`. Without a session id
 * or those variables it writes nothing. With MEDDLE_FIXTURE_MEMORY=1 it also appends the message's text as one line
 * to `memory/MEMORY.md` in that directory, as a session that saves a memory would.
 */
function transcribe(f: Frame) {
  if (transcribed) return;
  transcribed = true;
  const id = sessionArg();
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  const projectDir = process.env.CLAUDE_CODE_PROJECT_DIR_NAME;
  if (!id || !configDir || !projectDir) return;
  const dir = join(configDir, "projects", projectDir);
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, `${id}.jsonl`), JSON.stringify(f) + "\n");
  if (memory) {
    mkdirSync(join(dir, "memory"), { recursive: true });
    appendFileSync(join(dir, "memory", "MEMORY.md"), promptText(f).replace(/\n/g, " ") + "\n");
  }
}

/** The text of a user message: its content string, or its text blocks joined. */
function promptText(f: Frame): string {
  const content = f.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b: { type?: string; text?: string }) => (b.type === "text" && typeof b.text === "string" ? b.text : "")).join("");
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms).unref());
/** Resolves on stdin EOF, or EOF_CAP_MS after the first wait began; one cap for the whole run. */
let eofOrCap: Promise<void> | undefined;
function waitForEof(): Promise<void> {
  if (eof) return Promise.resolve();
  return eofOrCap ??= Promise.race([new Promise<void>(r => process.stdin.once("end", () => r())), sleep(EOF_CAP_MS)]);
}

/** Resolves once an unconsumed arrived frame satisfies `need`; exits if stdin ends first. */
async function waitFor(need: Need) {
  for (;;) {
    const hit = arrived.find(a => !a.used && matches(need, a.frame));
    if (hit) {
      hit.used = true;
      if (need.kind === "user") transcribe(hit.frame);
      return;
    }
    if (eof) await finish();
    await new Promise<void>(r => { wake = r; });
  }
}

for (const step of steps.slice(0, lastEmit + 1)) {
  if ("need" in step) { await waitFor(step.need); continue; }
  if (step.frame.type === "result" && stall) {
    stalling = true;
    heldResult = step.emit;
    if (eof) await finish();
    await new Promise<never>(() => {}); // still answering control requests; exits on stdin EOF or SIGTERM
  }
  if (step.frame.type === "control_request") lastEmittedRequestId = step.frame.request_id;
  write(step.emit);
}
if (!exitedOnItsOwn) await waitForEof();
await finish();
