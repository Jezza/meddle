// Stands in for the `claude` binary: replays a recorded stream-json session (see record.ts).
// Env: MEDDLE_FIXTURE (path to a .jsonl recording), MEDDLE_FIXTURE_STALL=1 (pause forever before `result`).
// Any argv is accepted and ignored. Dependency-free so it starts fast.
import { readFileSync } from "node:fs";

type Entry = { dir: "in" | "out"; t: number; line: string } | { dir: "close"; t: number } | { dir: "exit"; t: number; code: number | null };
type Frame = { type: string; subtype?: string; request_id?: string; request?: { subtype?: string }; response?: { request_id?: string } };
type Need = { kind: "user" } | { kind: "response" } | { kind: "host"; subtype: string } | { kind: "type"; type: string } | { kind: "eof" };
type Step = { need: Need } | { emit: string; frame: Frame };

const fixture = process.env.MEDDLE_FIXTURE;
if (!fixture) { process.stderr.write("replay.ts: MEDDLE_FIXTURE is not set\n"); process.exit(2); }
const stall = process.env.MEDDLE_FIXTURE_STALL === "1";
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
  if (e.dir === "close") { sawClose = true; steps.push({ need: { kind: "eof" } }); continue; }
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
    case "eof": return false;
  }
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
  if (need.kind === "eof") return waitForEof();
  for (;;) {
    const hit = arrived.find(a => !a.used && matches(need, a.frame));
    if (hit) { hit.used = true; return; }
    if (eof) await finish();
    await new Promise<void>(r => { wake = r; });
  }
}

for (const step of steps.slice(0, lastEmit + 1)) {
  if ("need" in step) { await waitFor(step.need); continue; }
  if (step.frame.type === "result" && stall) {
    stalling = true;
    if (eof) await finish();
    await new Promise<never>(() => {}); // still answering control requests; exits on stdin EOF or SIGTERM
  }
  if (step.frame.type === "control_request") lastEmittedRequestId = step.frame.request_id;
  write(step.emit);
}
if (!exitedOnItsOwn) await waitForEof();
await finish();
