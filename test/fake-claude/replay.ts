// Stands in for the `claude` binary: replays a recorded stream-json session (see record.ts).
// Env: MEDDLE_FIXTURE (path to a .jsonl recording), MEDDLE_FIXTURE_STALL=1 (pause before `result` until stdin ends or,
// as Claude Code ends an interrupted turn, an `interrupt` arrives: then the `result` comes as `error_during_execution`
// and the stand-in exits; an `interrupt` with `send_now` does that only when a user message it has not used is waiting,
// and is answered `nothing_waiting` otherwise, as Claude Code's is; a `cancel_async_message` drops the user message it
// names when it has not been used, as Claude Code drops one still queued),
// MEDDLE_FIXTURE_RESULTS_MS=<ms> (wait that long before every `result`: slow turns),
// MEDDLE_FIXTURE_LATER_RESULTS_MS=<ms> (wait that long before each `result` after the first: a slow later turn),
// MEDDLE_FIXTURE_BACKGROUND_MS=<ms> (wait that long before each `task_notification`: background work that outlasts its
// turn's `result`),
// MEDDLE_FIXTURE_MEMORY=1 (append the first prompt to the project's memory, see `transcribe`),
// MEDDLE_FIXTURE_INPUT=<path> (append every user message this run is sent to <path>, one JSON line each, as sent),
// MEDDLE_FIXTURE_BY_TOKEN=<token>=<path>,<token>=<path> (the recording of the entry whose token is the
// CLAUDE_CODE_OAUTH_TOKEN this run got; MEDDLE_FIXTURE when none is),
// MEDDLE_FIXTURE_TOOL_USE=<tool> (before the first `result`, as Claude Code does once that tool has run, calls each
// `PostToolUse` hook the host registered at `initialize` whose matcher matches <tool>), and with
// MEDDLE_FIXTURE_TOOL_USE_EXIT=1 then exits once the host answered them, with no `result` (a turn that fails).
// MEDDLE_FIXTURE_PEER=1 (stand in for Claude Code's peer messaging: register in <CLAUDE_CONFIG_DIR>/sessions as
// `<pid>.json`, named CLAUDE_CODE_SESSION_NAME, with a key, and listen on a socket, at --messaging-socket-path if given; a message written there after its
// auth line is a user message like one on stdin, reported `command_lifecycle` `queued` as it arrives, `started` as the
// recording uses it and `completed` after the next `result`, and appended to MEDDLE_FIXTURE_INPUT with
// `"via":"socket"`), with MEDDLE_FIXTURE_PEER_SKIP=1 never registering, or MEDDLE_FIXTURE_PEER_IGNORE=1 never using
// a message from the socket.
// Any argv is accepted; only `--session-id` / `--resume` are read (see `transcribe`). Dependency-free so it
// starts fast. The recording's user messages' uuids become those of the user messages this run is sent, in order,
// wherever an `out` line names them (`command_lifecycle`, `user_message_uuids`).
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Entry = { dir: "in" | "out"; t: number; line: string } | { dir: "close"; t: number } | { dir: "exit"; t: number; code: number | null };
type HookMatcher = { matcher?: string; hookCallbackIds?: string[] };
type Frame = {
  type: string; subtype?: string; uuid?: string; viaSocket?: boolean; message?: { content?: unknown }; request_id?: string;
  request?: { subtype?: string; hooks?: Record<string, HookMatcher[]>; send_now?: boolean; message_uuid?: string }; response?: { request_id?: string };
};
type Need = { kind: "user" } | { kind: "response" } | { kind: "host"; subtype: string } | { kind: "type"; type: string };
type Step = { need: Need; uuid?: string } | { emit: string; frame: Frame };

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
const input = process.env.MEDDLE_FIXTURE_INPUT;
const laterResultsMs = Number(process.env.MEDDLE_FIXTURE_LATER_RESULTS_MS ?? 0);
const backgroundMs = Number(process.env.MEDDLE_FIXTURE_BACKGROUND_MS ?? 0);
const resultsMs = Number(process.env.MEDDLE_FIXTURE_RESULTS_MS ?? 0);
const toolUse = process.env.MEDDLE_FIXTURE_TOOL_USE;
const exitAfterToolUse = process.env.MEDDLE_FIXTURE_TOOL_USE_EXIT === "1";
/** The hooks the host registered with its `initialize` request, by event. */
let hooks: Record<string, HookMatcher[]> = {};
let resultsEmitted = 0;
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
    else if (f.type === "user") steps.push({ need: { kind: "user" }, ...(f.uuid !== undefined ? { uuid: f.uuid } : {}) });
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

function answer(f: Frame, response: Record<string, unknown> = {}) {
  const liveId = f.request_id;
  const recorded = recordedResponse.get(f.request?.subtype ?? "");
  const reply = recorded
    ? { ...recorded, response: { ...recorded.response, request_id: liveId } }
    : { type: "control_response", response: { subtype: "success", request_id: liveId, response } };
  write(JSON.stringify(reply));
}

/** The uuids of the user messages that arrived and that the recording has not used: those waiting to run. */
function waitingUuids(): string[] {
  return arrived.filter(a => !a.used && a.frame.type === "user").map(a => a.frame.uuid ?? "");
}

/**
 * Answers an `interrupt` with `send_now` as Claude Code does: with nothing waiting, `nothing_waiting` and the turn goes
 * on; otherwise, while stalling, the turn is cut (`stopped`). Answers whether the turn is cut. Claude Code would then
 * run what is waiting as a turn of its own; the stand-in ends instead, so it is left untaken.
 */
function answerSendNow(f: Frame): boolean {
  const waiting = waitingUuids();
  const cut = waiting.length > 0 && stalling && heldResult !== undefined;
  answer(f, { still_queued: waiting, send_now: waiting.length === 0 ? "nothing_waiting" : cut ? "stopped" : "delivering" });
  return cut;
}

/**
 * Answers a `cancel_async_message` as Claude Code does: a user message that arrived and has not been used is dropped
 * (`cancelled: true`, with its uuid); any other is not (`cancelled: false`).
 */
function answerCancel(f: Frame) {
  const uuid = f.request?.message_uuid;
  const waiting = arrived.find(a => !a.used && a.frame.type === "user" && a.frame.uuid === uuid);
  if (waiting === undefined) { answer(f, { cancelled: false }); return; }
  waiting.used = true;
  answer(f, { cancelled: true, message_uuid: uuid });
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
    if (f.type === "control_request" && f.request?.subtype === "initialize") hooks = f.request.hooks ?? {};
    let cut = false; // the turn is interrupted
    if (f.type === "control_request" && f.request?.subtype === "interrupt" && f.request.send_now === true) cut = answerSendNow(f);
    else if (f.type === "control_request" && f.request?.subtype === "cancel_async_message") answerCancel(f);
    else if (f.type === "control_request") { answer(f); cut = f.request?.subtype === "interrupt"; }
    if (cut && stalling && heldResult !== undefined) {
      write(JSON.stringify({ ...JSON.parse(heldResult), subtype: "error_during_execution", is_error: true, errors: [] }));
      heldResult = undefined;
      // The SDK keeps stdin open after an interrupted turn's result (meddle closes it after a grace period): the
      // stand-in ends the session itself instead.
      void finish();
    }
    if (f.type === "user" && input !== undefined) appendFileSync(input, line + "\n");
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

/** The value of `flag` on the command line (`--flag <v>` or `--flag=<v>`), if given. */
function flagArg(flag: string): string | undefined {
  const argv = process.argv;
  const i = argv.indexOf(flag);
  if (i !== -1 && i + 1 < argv.length) return argv[i + 1];
  return argv.find(a => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
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
 * appended to `<CLAUDE_CONFIG_DIR>/projects/<CLAUDE_CODE_PROJECT_DIR_NAME>/<session id>.jsonl`; without
 * CLAUDE_CODE_PROJECT_DIR_NAME, the project dir is the working directory with every character but letters and digits
 * made `-` (Claude Code's own name for it). Without a session id or CLAUDE_CONFIG_DIR it writes nothing. With MEDDLE_FIXTURE_MEMORY=1 it also appends the message's text as one line
 * to `memory/MEMORY.md` in that directory, as a session that saves a memory would.
 */
function transcribe(f: Frame) {
  if (transcribed) return;
  transcribed = true;
  const id = sessionArg();
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  const projectDir = process.env.CLAUDE_CODE_PROJECT_DIR_NAME ?? process.cwd().replace(/[^A-Za-z0-9]/g, "-");
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

/** The recording's user message uuids, each mapped to that of the user message this run got in its place. */
const liveUuids = new Map<string, string>();
/** `line` with every recorded user message uuid this run has a live one for replaced by it. */
function withLiveUuids(line: string): string {
  for (const [recorded, live] of liveUuids) line = line.replaceAll(recorded, live);
  return line;
}

/** Resolves once an unconsumed arrived frame satisfies `need`; exits if stdin ends first. */
async function waitFor(need: Need, recordedUuid?: string) {
  for (;;) {
    const hit = arrived.find(a => !a.used && matches(need, a.frame));
    if (hit) {
      hit.used = true;
      if (hit.frame.viaSocket === true && hit.frame.uuid !== undefined) {
        lifecycle(hit.frame.uuid, "started");
        toComplete.push(hit.frame.uuid);
      }
      if (need.kind === "user") transcribe(hit.frame);
      if (recordedUuid !== undefined && hit.frame.uuid !== undefined) liveUuids.set(recordedUuid, hit.frame.uuid);
      return;
    }
    if (eof) await finish();
    await new Promise<void>(r => { wake = r; });
  }
}

/** Calls each `PostToolUse` hook whose matcher matches `tool`, as Claude Code does once the tool has run; how many. */
function toolUsed(tool: string): number {
  let n = 0;
  for (const m of hooks.PostToolUse ?? []) {
    if (m.matcher !== undefined && m.matcher !== "" && !new RegExp(`^(?:${m.matcher})$`).test(tool)) continue;
    for (const id of m.hookCallbackIds ?? []) {
      const input = {
        hook_event_name: "PostToolUse", session_id: sessionArg() ?? "", transcript_path: "", cwd: process.cwd(),
        tool_name: tool, tool_input: {}, tool_response: {}, tool_use_id: "toolu_replay",
      };
      write(JSON.stringify({ type: "control_request", request_id: `replay-hook-${n++}`, request: { subtype: "hook_callback", callback_id: id, input, tool_use_id: "toolu_replay" } }));
    }
  }
  return n;
}

/** Resolves once the host has answered `n` hook calls (`replay-hook-<i>`); exits if stdin ends first. */
async function hooksAnswered(n: number) {
  const answered = () => arrived.filter(a => a.frame.type === "control_response" && (a.frame.response?.request_id ?? "").startsWith("replay-hook-")).length;
  while (answered() < n) {
    if (eof) await finish();
    await new Promise<void>(r => { wake = r; });
  }
}

/** Socket messages the recording used, whose `completed` follows the next `result`. */
const toComplete: string[] = [];
/** Reports a socket message's progress as Claude Code does, by the uuid it was sent with. */
function lifecycle(uuid: string, state: "queued" | "started" | "completed") {
  write(JSON.stringify({ type: "command_lifecycle", command_uuid: uuid, state, uuid: randomUUID(), session_id: sessionArg() ?? "" }));
}
if (process.env.MEDDLE_FIXTURE_PEER === "1" && process.env.MEDDLE_FIXTURE_PEER_SKIP !== "1") {
  const sessions = join(process.env.CLAUDE_CONFIG_DIR ?? tmpdir(), "sessions");
  mkdirSync(sessions, { recursive: true });
  // Where the host said to listen (`--messaging-socket-path`), else a socket of its own.
  const sock = flagArg("--messaging-socket-path") ?? join(mkdtempSync(join(tmpdir(), "meddle-replay-sock-")), `${process.pid}.sock`);
  try { rmSync(sock); } catch { /* none left */ }
  const token = randomBytes(16).toString("hex");
  const ignore = process.env.MEDDLE_FIXTURE_PEER_IGNORE === "1";
  createServer((c) => {
    let pending = "";
    let authed = false;
    c.on("data", (chunk: Buffer) => {
      pending += chunk.toString();
      let i: number;
      while ((i = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, i); pending = pending.slice(i + 1);
        let f: Frame & { token?: string; msg_id?: string };
        try { f = JSON.parse(line); } catch { continue; }
        if (f.type === "auth") { authed = f.token === token; continue; }
        if (f.type !== "user" || !authed) continue;
        if (input !== undefined) appendFileSync(input, JSON.stringify({ ...f, via: "socket" }) + "\n");
        if (f.uuid !== undefined) lifecycle(f.uuid, "queued");
        if (ignore) continue;
        arrived.push({ frame: { ...f, viaSocket: true }, used: false });
        wake();
      }
    });
  }).listen(sock).unref();
  const entry = join(sessions, `${process.pid}.json`);
  writeFileSync(join(sessions, `${process.pid}.${createHash("sha256").update(sock).digest("hex")}.key`), JSON.stringify({ peerToken: token }));
  writeFileSync(entry, JSON.stringify({ pid: process.pid, sessionId: sessionArg(), name: process.env.CLAUDE_CODE_SESSION_NAME, messagingSocketPath: sock }));
  process.on("exit", () => { try { rmSync(entry); } catch { /* gone */ } });
}

let toolCalled = false;
for (const step of steps.slice(0, lastEmit + 1)) {
  if ("need" in step) { await waitFor(step.need, step.uuid); continue; }
  if (step.frame.type === "result" && toolUse !== undefined && !toolCalled) {
    toolCalled = true;
    const called = toolUsed(toolUse);
    if (exitAfterToolUse) {
      await hooksAnswered(called);
      await finish();
    }
  }
  if (step.frame.type === "result" && resultsMs > 0) await sleep(resultsMs);
  if (step.frame.subtype === "task_notification" && backgroundMs > 0) await sleep(backgroundMs);
  if (step.frame.type === "result" && resultsEmitted++ > 0 && laterResultsMs > 0) await sleep(laterResultsMs);
  const line = withLiveUuids(step.emit);
  if (step.frame.type === "result" && stall) {
    stalling = true;
    heldResult = line;
    if (eof) await finish();
    await new Promise<never>(() => {}); // still answering control requests; exits on stdin EOF or SIGTERM
  }
  if (step.frame.type === "control_request") lastEmittedRequestId = step.frame.request_id;
  write(line);
  if (step.frame.type === "result") for (const uuid of toComplete.splice(0)) lifecycle(uuid, "completed");
}
if (!exitedOnItsOwn) await waitForEof();
await finish();
