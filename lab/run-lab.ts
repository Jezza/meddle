// run-lab.ts: drives meddle through scenarios 1 to 13 of brief.md on a tpo lab (meddle-lab.toml), one line per check.
//   bun run run-lab.ts            (from anywhere; it brings the lab up from scratch and takes it down at the end)
// Hermetic: no internet node, the lab's own lighthouse (lh:8080), MEDDLE_IROH_PRESET=minimal, fake token, replayer.
// Logs: $S/logs/<scenario>-<node>.log (each scenario's slice of `tpo logs`), $S/logs/all-<node>.log, results.json.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";

const S = import.meta.dir;
const NODE_SH = `${S}/node.sh`;
const LOGS = `${S}/logs`;
const MEDDLE = ["a", "b", "c"] as const;
const ALL = ["lh", ...MEDDLE] as const;
type Node = (typeof MEDDLE)[number];
const LIVE = new Set(["idle", "running", "waiting"]);
const T0 = Date.now();

// ─── output ───

type Result = { scenario: string; check: string; status: "PASS" | "FAIL" | "INFO" | "CRITICAL" | "BLOCKED"; detail: string; at: string };
const results: Result[] = [];
function stamp(): string {
  return new Date().toISOString().slice(11, 23);
}
function report(scenario: string, check: string, status: Result["status"], detail = ""): void {
  results.push({ scenario, check, status, detail, at: stamp() });
  console.log(`${stamp()} ${status.padEnd(8)} ${scenario} ${check}${detail ? `: ${detail}` : ""}`);
}
const check = (scenario: string, name: string, ok: boolean, detail = "") => (report(scenario, name, ok ? "PASS" : "FAIL", detail), ok);
const info = (scenario: string, name: string, detail: string) => report(scenario, name, "INFO", detail);
const secs = (ms: number | null) => (ms === null ? "never" : `${(ms / 1000).toFixed(1)} s`);

// ─── processes ───

type Run = { code: number; out: string; err: string; ms: number };
async function run(cmd: string[], env: Record<string, string> = {}): Promise<Run> {
  const t = Date.now();
  const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out: out.trim(), err: err.trim(), ms: Date.now() - t };
}
const tpo = (...args: string[]) => run(["tpo", ...args]);
const meddle = (node: Node, ...args: string[]) => run(["tpo", "exec", "--timeout", "120s", node, "--", NODE_SH, ...args]);
const sleep = (ms: number) => Bun.sleep(ms);
const lastLine = (r: Run) => (r.err || r.out).split("\n").at(-1) ?? "";

/** Polls `fn` every `every` ms until it is true or `ms` pass; the elapsed ms, or null. */
async function waitFor(fn: () => Promise<boolean> | boolean, ms: number, every = 500): Promise<number | null> {
  const t = Date.now();
  while (Date.now() - t < ms) {
    try {
      if (await fn()) return Date.now() - t;
    } catch {}
    await sleep(every);
  }
  return null;
}

// ─── state: the nodes' databases, read-only ───

function q<T>(node: string, file: string, sql: string): T[] {
  const path = `${S}/nodes/${node}/d/${file}`;
  if (!existsSync(path)) return [];
  try {
    const db = new Database(path, { readonly: true });
    try {
      return db.query(sql).all() as T[];
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}
const taskState = (node: string, id: string) => q<{ state: string }>(node, "meddle.sqlite", `select state from tasks where id='${id}'`)[0]?.state ?? "absent";
function moveRecord(node: string): { status: string; phase: string; outcome: string; error: string } {
  const r = q<{ record: string }>(node, "durable.sqlite", `select record from tasks where kind='"meddle.move"' order by id desc limit 1`)[0];
  if (!r) return { status: "-", phase: "-", outcome: "-", error: "" };
  const rec = JSON.parse(r.record);
  return {
    status: rec.state.status,
    phase: rec.state.checkpoint?.phase ?? "-",
    outcome: rec.state.outcome?.status ?? "-",
    error: rec.state.outcome?.error?.message ?? "",
  };
}
const moveCount = (node: string) => q<{ n: number }>(node, "durable.sqlite", `select count(*) n from tasks where kind='"meddle.move"'`)[0]?.n ?? 0;
function live(id: string): Node[] {
  return MEDDLE.filter((n) => LIVE.has(taskState(n, id)));
}
const states = (id: string) => MEDDLE.map((n) => `${n}=${taskState(n, id)}`).join(" ");

/** Samples task state and newest move phase on `nodes` every 250 ms until stopped. */
function sampler(id: string, nodes: string[]) {
  const lines: string[] = [];
  let last = "";
  let stop = false;
  const done = (async () => {
    while (!stop) {
      const s = nodes.map((n) => { const m = moveRecord(n); return `${n}[${taskState(n, id)}|move ${m.status}:${m.phase}${m.outcome !== "-" ? `:${m.outcome}` : ""}]`; }).join(" ");
      if (s !== last) lines.push(`${stamp()} ${s}`);
      last = s;
      await sleep(250);
    }
  })();
  return { lines, stop: async () => { stop = true; await done; return lines; } };
}

// ─── logs ───

const ANSI = /\x1b\[[0-9;]*m/g;
async function logLines(node: string): Promise<string[]> {
  return (await tpo("logs", node)).out.replace(ANSI, "").split("\n").filter(Boolean);
}
async function mark(): Promise<Record<string, number>> {
  const m: Record<string, number> = {};
  for (const n of ALL) m[n] = (await logLines(n)).length;
  return m;
}
/** Writes each node's log lines since `from` to logs/<scn>-<node>.log; the new lines per node. */
async function saveLogs(scn: string, from: Record<string, number>): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const n of ALL) {
    const lines = (await logLines(n)).slice(from[n] ?? 0);
    out[n] = lines;
    await writeFile(`${LOGS}/${scn}-${n}.log`, lines.join("\n") + (lines.length ? "\n" : ""));
  }
  return out;
}
const meddleLines = (lines: string[]) => lines.filter((l) => l.startsWith("meddle"));

// ─── pool ───

const ids: Record<string, string> = {};
const short = (n: Node) => ids[n]!.slice(0, 10);
async function poolView(node: Node): Promise<Record<string, string>> {
  const r = await meddle(node, "pool");
  const v: Record<string, string> = {};
  for (const l of r.out.split("\n")) {
    const [, host, state] = l.split(" ");
    if (host) v[host] = state ?? "";
  }
  return v;
}
const sees = async (observer: Node, other: Node, state: string) => (await poolView(observer))[other] === state;

// ─── turns and memory ───

const turns: { node: Node; text: string; ok: boolean }[] = [];
let turnNo = 0;
async function turn(node: Node, id: string, scn: string): Promise<Run & { text: string; ok: boolean }> {
  const text = `lab-turn-${++turnNo} ${scn} on ${node}`;
  const r = await meddle(node, "task", "prompt", id, text);
  const ok = r.code === 0 && r.err.includes("result/success");
  turns.push({ node, text, ok });
  return { ...r, text, ok };
}

// ─── scenarios ───

let P = "";
let TID = "";

async function s1() {
  const scn = "s1";
  const up = await tpo("up", "-d", `${S}/meddle-lab.toml`);
  check(scn, "tpo up", up.code === 0, up.out || up.err);
  for (const n of MEDDLE) {
    const ms = await waitFor(async () => (await logLines(n)).some((l) => l.startsWith("dashboard at")), 60_000);
    check(scn, `${n} serve up`, ms !== null, `dashboard line after ${secs(ms)}`);
  }
  for (const n of MEDDLE) {
    const r = await meddle(n, "status");
    const id = /^node ([0-9a-f]{64})$/m.exec(r.out)?.[1];
    if (id) ids[n] = id;
    check(scn, `status on ${n}`, r.code === 0 && id !== undefined, `${r.ms} ms, node ${id?.slice(0, 10)}, ${/^pool .*/m.exec(r.out)?.[0]}`);
  }
  const h = await run(["tpo", "exec", "a", "--", "curl", "-s", "-m", "5", "-w", " %{http_code}", "http://lh:8080/v1/health"]);
  check(scn, "lighthouse /v1/health from a", h.out.endsWith(" 200"), h.out);
}

async function s2() {
  const scn = "s2";
  const m = await mark();
  const inv1 = await meddle("a", "invite");
  const ticket = JSON.parse(Buffer.from(inv1.out.replace(/^meddle1/, ""), "base64url").toString());
  info(scn, "a's ticket address", JSON.stringify(ticket.inviter.direct));
  const j1 = await meddle("b", "join", inv1.out);
  check(scn, "b joins via a's ticket", j1.code === 0, `${j1.out || j1.err} (${j1.ms} ms)`);
  const inv2 = await meddle("b", "invite");
  const j2 = await meddle("c", "join", inv2.out);
  check(scn, "c joins via b's ticket", j2.code === 0, `${j2.out || j2.err} (${j2.ms} ms)`);
  const ms = await waitFor(async () => {
    for (const n of MEDDLE) if (Object.values(await poolView(n)).filter((s) => s === "online").length !== 3) return false;
    return true;
  }, 30_000);
  check(scn, "every pool lists the others online", ms !== null, `${secs(ms)} after c joined`);
  for (const n of MEDDLE) info(scn, `pool on ${n}`, (await meddle(n, "pool")).out.replace(/\n/g, " | "));
  const sorted = [...MEDDLE].sort((x, y) => ids[x]!.localeCompare(ids[y]!));
  info(scn, "dial direction (smaller id dials)", `a-c: ${ids.a! < ids.c! ? "a dials c" : "c dials a"}; order ${sorted.join("<")}`);
  const roster = q<{ node_id: string; last_addr: string }>("c", "meddle.sqlite", "select node_id,last_addr from roster");
  const aRow = roster.find((r) => r.node_id === ids.a);
  info(scn, "c's roster entry for a", aRow?.last_addr ?? "(none)");
  const logs = await saveLogs(scn, m);
  const lhLines = logs.lh!.filter((l) => /announce|lookup|topic|register/i.test(l));
  info(scn, "lighthouse log lines about announce/lookup", `${lhLines.length}; first: ${lhLines.slice(0, 3).join(" || ") || "(none)"}`);
  for (const n of MEDDLE) info(scn, `${n} meddle log lines`, `${meddleLines(logs[n]!).length}: ${meddleLines(logs[n]!).join(" || ") || "(silent)"}`);
}

async function s3() {
  const scn = "s3";
  await writeFile(`${S}/nodes/a/token.txt`, "tok-lab\n");
  const r = await meddle("a", "token", "add", "--file", `${S}/nodes/a/token.txt`, "--label", "lab");
  // `token <id> (<label>)`: the id names the value file every node pulls
  const id = /^token ([0-9a-f]{16}) \(lab\)$/m.exec(r.out)?.[1] ?? null;
  check(scn, "token add on a", r.code === 0 && id !== null, r.out || r.err);
  const ms = await waitFor(async () => id !== null && (await meddle("c", "token", "list")).out.includes(`active: ${id}`), 30_000);
  check(scn, "token list on c shows it active", ms !== null, `after ${secs(ms)}`);
  const f = id === null ? "(no id)" : await readFile(`${S}/nodes/c/d/secrets/tokens/${id}`, "utf8").catch(() => "(missing)");
  check(scn, "c's data dir has the token file", f.trim() === "tok-lab", JSON.stringify(f));
}

async function jjHost(home: string, args: string[], cwd?: string) {
  return run(["jj", ...(cwd ? ["-R", cwd] : []), ...args], { HOME: home, JJ_USER: "lab", JJ_EMAIL: "lab@example.invalid" });
}

async function s4() {
  const scn = "s4";
  const home = `${S}/nodes/a`;
  const repo = `${home}/repo`;
  await mkdir(repo, { recursive: true });
  await jjHost(home, ["git", "init", "--colocate", repo]);
  await writeFile(`${repo}/README.md`, "hello\n");
  await jjHost(home, ["describe", "-m", "first"], repo);
  await jjHost(home, ["new"], repo);
  const bm = await jjHost(home, ["bookmark", "set", "main", "-r", "@-"], repo);
  info(scn, "repo created", `main set: code ${bm.code}`);
  const add = await meddle("a", "project", "add", repo, "--name", "repo");
  P = add.out;
  check(scn, "project add on a", add.code === 0 && /^[0-9a-f]+$/.test(P), P || add.err);
  const nt = await meddle("a", "task", "new", "--title", "lab", "--project", P);
  TID = nt.out;
  check(scn, "task new on a", nt.code === 0 && /^[0-9a-f]+$/.test(TID), TID || nt.err);
  await writeFile(`${S}/ids.env`, `P=${P}\nTID=${TID}\n`);
  const t = await turn("a", TID, scn);
  check(scn, "one turn on a", t.ok, `${lastLine(t)} in ${t.ms} ms`);
  const bl = await jjHost(home, ["bookmark", "list", "--ignore-working-copy"], repo);
  check(scn, "task bookmark in a's repo", bl.out.includes(`meddle/task/${TID}/repo`), bl.out.replace(/\n/g, " | "));
}

/** The change a task bookmark points at in `node`'s copy of the project, as a commit id. */
async function bookmarkCommit(node: Node, bookmark: string): Promise<string> {
  const repo = node === "a" ? `${S}/nodes/a/repo` : `${S}/nodes/${node}/d/replicas/${P}`;
  const r = await jjHost(`${S}/nodes/${node}`, ["log", "--no-graph", "--ignore-working-copy", "-r", bookmark, "-T", "commit_id"], repo);
  return r.code === 0 ? r.out : "";
}

async function moveAndWait(from: Node, to: Node, ms: number): Promise<{ cli: Run; settled: number | null }> {
  const cli = await meddle(from, "task", "move", TID, short(to));
  const settled = await waitFor(() => taskState(to, TID) === "idle" && taskState(from, TID) === "moved", ms, 250);
  return { cli, settled };
}

async function s5() {
  const scn = "s5";
  const m = await mark();
  await tpo("set", "a", "b", "delay=80ms", "loss=2%");
  const t = Date.now();
  const { cli, settled } = await moveAndWait("a", "b", 120_000);
  check(scn, "task move a→b over 80ms/2% loss", cli.code === 0 && settled !== null, `cli "${cli.out || cli.err}" in ${cli.ms} ms; b idle + a moved after ${secs(settled)}`);
  const st = await waitFor(async () => (await meddle("b", "status")).out.includes("tasks 1") && (await meddle("a", "status")).out.includes("tasks 0"), 30_000);
  info(scn, "status agrees (b tasks 1, a tasks 0)", `${secs(Date.now() - t)} after the move command (status poll ${secs(st)})`);
  const tr = await turn("b", TID, scn);
  check(scn, "turn on b", tr.ok, `${lastLine(tr)} in ${tr.ms} ms`);
  const bm = `meddle/task/${TID}/repo`;
  const want = await bookmarkCommit("b", bm);
  const ms = await waitFor(async () => want !== "" && (await bookmarkCommit("a", bm)) === want, 30_000);
  check(scn, "b's bookmark reaches a's repo (home)", ms !== null, `commit ${want.slice(0, 12)} on a after ${secs(ms)}`);
  await tpo("heal", "a", "b");
  const logs = await saveLogs(scn, m);
  for (const n of MEDDLE) if (meddleLines(logs[n]!).length) info(scn, `${n} log`, meddleLines(logs[n]!).join(" || "));
}

function owner(): Node | null {
  const l = live(TID);
  return l.length === 1 ? l[0]! : null;
}
const otherOf = (n: Node): Node => (n === "b" ? "c" : n === "c" ? "b" : "b");

async function s6() {
  const scn = "s6";
  const m = await mark();
  const from = owner() ?? "b";
  const to = from === "b" ? "c" : "b";
  info(scn, "move", `${from}→${to}, task ${states(TID)}`);
  await tpo("cut", "b", "c");
  const tCut = Date.now();
  const seen = (await poolView(from))[to];
  const cli = await meddle(from, "task", "move", TID, short(to));
  const failFast = cli.code !== 0 && cli.ms < 5000;
  check(scn, "move into the cut fails fast with a clear message", failFast, `exit ${cli.code} in ${cli.ms} ms: "${cli.out || cli.err}"; ${to} was '${seen}' on ${from} at that moment`);
  let rolledBack: number | null = null;
  if (!failFast) {
    const offline = waitFor(async () => (await poolView(from))[to] === "offline", 120_000, 1000).then((ms) => ms === null ? null : Date.now() - tCut);
    rolledBack = await waitFor(() => moveRecord(from).status === "terminal", 120_000, 250);
    info(scn, `${to} shown offline on ${from}`, `${secs(await offline)} after the cut`);
    info(scn, "the move ended", `${secs(rolledBack === null ? null : Date.now() - tCut)} after the cut, ${moveRecord(from).outcome}: ${moveRecord(from).error}`);
  }
  check(scn, `task stays live on ${from}`, live(TID).length === 1 && live(TID)[0] === from, states(TID));
  await tpo("heal", "--all");
  const tHeal = Date.now();
  const back = await waitFor(() => sees(from, to, "online"), 90_000, 500);
  info(scn, `${to} online on ${from} after the heal`, secs(back === null ? null : Date.now() - tHeal));
  const logs = await saveLogs(scn, m);
  info(scn, `${from} log`, meddleLines(logs[from]!).join(" || ") || "(silent)");
}

/** After a fault during a move: waits until the move ended (or 90 s) and checks single ownership, a turn, and the other node. */
async function settle(scn: string, from: Node, to: Node, budget: number) {
  const ended = await waitFor(() => moveRecord(from).status === "terminal" && live(TID).length === 1 && !["receiving"].includes(taskState(owner() ?? from, TID)), budget, 500);
  await sleep(3000);
  const l = live(TID);
  info(scn, "outcome", `${secs(ended)} after the wait began; move ${moveRecord(from).outcome}${moveRecord(from).error ? ` (${moveRecord(from).error})` : ""}; ${states(TID)}`);
  if (l.length > 1) report(scn, "DOUBLE-LIVE task", "CRITICAL", states(TID));
  check(scn, "exactly one node has the task live", l.length === 1, states(TID));
  const home = l[0] ?? from;
  check(scn, `task idle on ${home}`, taskState(home, TID) === "idle", taskState(home, TID));
  const ghost = home === from ? to : from;
  const g = taskState(ghost, TID);
  check(scn, `${ghost} shows it moved or absent`, g === "moved" || g === "absent", g);
  // Both nodes are asked to run a turn: only the owner may.
  const other = await turn(ghost, TID, `${scn}-probe`);
  if (other.ok) report(scn, `${ghost} ALSO ran a turn`, "CRITICAL", lastLine(other));
  else info(scn, `${ghost} refuses a prompt`, lastLine(other));
  const t = await turn(home, TID, scn);
  check(scn, `turn on ${home}`, t.ok, `${lastLine(t)} in ${t.ms} ms`);
  return { home, ghost };
}

async function partitionMove(scn: string, trigger: { afterMs: number } | { phase: "commit"; plusMs: number }, probeMidCut = false) {
  const m = await mark();
  const from = owner()!;
  const to = otherOf(from);
  const on = await waitFor(() => sees(from, to, "online"), 90_000, 1000);
  info(scn, "setup", `${from}→${to}, ${to} online on ${from} (${secs(on)}), b⇄c 1500ms`);
  const smp = sampler(TID, [from, to]);
  const before = moveCount(from);
  const t = Date.now();
  const cliP = meddle(from, "task", "move", TID, short(to));
  if ("afterMs" in trigger) await sleep(trigger.afterMs);
  else {
    const ms = await waitFor(() => moveCount(from) > before && moveRecord(from).phase === "commit", 90_000, 100);
    if (ms === null) report(scn, "commit phase never reached", "BLOCKED", JSON.stringify(moveRecord(from)));
    await sleep(trigger.plusMs);
  }
  const at = Date.now() - t;
  const phase = moveRecord(from);
  info(scn, "cut", `at ${secs(at)}: ${from} move ${phase.status}:${phase.phase}, ${to} task ${taskState(to, TID)}`);
  await tpo("cut", "b", "c", "--for", "30s");
  const tCut = Date.now();
  const cli = await cliP;
  info(scn, "move command", `exit ${cli.code} in ${cli.ms} ms: ${cli.out || cli.err}`);
  if (probeMidCut) {
    await sleep(12_000 - (Date.now() - tCut));
    info(scn, "mid-cut states", `${states(TID)}; ${from} move ${moveRecord(from).status}:${moveRecord(from).phase}`);
    if (live(TID).length > 1) report(scn, "DOUBLE-LIVE during the cut", "CRITICAL", states(TID));
    const [pf, pt] = await Promise.all([turn(from, TID, `${scn}-midcut`), turn(to, TID, `${scn}-midcut`)]);
    info(scn, `mid-cut prompt on ${from}`, `${pf.ok ? "RAN A TURN" : "refused"}: ${lastLine(pf)}`);
    info(scn, `mid-cut prompt on ${to}`, `${pt.ok ? "RAN A TURN" : "refused"}: ${lastLine(pt)}`);
    if (pf.ok && pt.ok) report(scn, "both nodes ran a turn during the cut", "CRITICAL", states(TID));
  }
  await sleep(Math.max(0, 30_000 - (Date.now() - tCut)));
  const r = await settle(scn, from, to, 90_000);
  const samples = await smp.stop();
  await writeFile(`${LOGS}/${scn}-samples.log`, samples.join("\n") + "\n");
  const rec = taskState(r.ghost, TID);
  if (rec === "receiving") info(scn, `stale receiving copy on ${r.ghost}`, "left after the move ended");
  const logs = await saveLogs(scn, m);
  for (const n of [from, to]) info(scn, `${n} log`, meddleLines(logs[n]!).join(" || ") || "(silent)");
  info(scn, "phase timeline", samples.join(" ; "));
}

async function s7() {
  await tpo("set", "b", "c", "delay=1500ms");
  await partitionMove("s7a", { afterMs: 4000 });
  await partitionMove("s7b", { afterMs: 12_000 });
  await partitionMove("s7c", { phase: "commit", plusMs: 2000 });
  await partitionMove("s7d", { phase: "commit", plusMs: 3500 }, true);
}

async function s8() {
  await crashMove("s8", { afterMs: 4000 });
  await crashMove("s8b", { receiving: true });
}

async function crashMove(scn: string, trigger: { afterMs: number } | { receiving: true }) {
  await tpo("set", "b", "c", "delay=1500ms");
  const m = await mark();
  const from = owner()!;
  const to = otherOf(from);
  const on = await waitFor(() => sees(from, to, "online"), 90_000, 1000);
  info(scn, "setup", `${from}→${to}, ${to} online on ${from} (${secs(on)}), b⇄c 1500ms`);
  const smp = sampler(TID, [from, to]);
  const t0 = Date.now();
  const cliP = meddle(from, "task", "move", TID, short(to));
  if ("afterMs" in trigger) await sleep(trigger.afterMs);
  else if ((await waitFor(() => taskState(to, TID) === "receiving", 90_000, 100)) === null) report(scn, "target never showed receiving", "BLOCKED", states(TID));
  info(scn, "stop", `at ${secs(Date.now() - t0)}, ${to}: ${from} move ${moveRecord(from).phase}, ${to} task ${taskState(to, TID)}`);
  await tpo("stop", to);
  await sleep(15_000);
  const dashBefore = (await logLines(to)).filter((l) => l.startsWith("dashboard at")).length;
  info(scn, "before restart", `${from} move ${moveRecord(from).status}:${moveRecord(from).phase}:${moveRecord(from).outcome}, ${to} task ${taskState(to, TID)}`);
  await tpo("start", to);
  const up = await waitFor(async () => (await logLines(to)).filter((l) => l.startsWith("dashboard at")).length > dashBefore, 60_000);
  info(scn, `${to} serving again`, secs(up));
  const cli = await cliP;
  info(scn, "move command", `exit ${cli.code}: ${cli.out || cli.err}`);
  await settle(scn, from, to, 90_000);
  const rec = q<{ id: string }>(to, "meddle.sqlite", "select id from tasks where state='receiving'");
  check(scn, `no partial copy left on ${to}`, rec.length === 0, `${rec.length} receiving rows; task dir ${existsSync(`${S}/nodes/${to}/t/${TID}`) ? "present" : "absent"} on ${to}`);
  const samples = await smp.stop();
  await writeFile(`${LOGS}/${scn}-samples.log`, samples.join("\n") + "\n");
  await tpo("heal", "--all");
  const logs = await saveLogs(scn, m);
  for (const n of [from, to]) info(scn, `${n} log`, meddleLines(logs[n]!).join(" || ") || "(silent)");
  info(scn, "phase timeline", samples.join(" ; "));
}

async function s9() {
  const scn = "s9";
  for (const [x, y] of [["a", "b"], ["a", "c"], ["b", "c"]] as const) await waitFor(() => sees(x, y, "online"), 60_000, 1000);
  const m = await mark();
  await tpo("cut", "lh", "--for", "60s");
  const t = Date.now();
  for (const at of [10_000, 30_000]) {
    await sleep(at - (Date.now() - t));
    const views = await Promise.all(MEDDLE.map(async (n) => [n, Object.values(await poolView(n)).filter((s) => s === "online").length] as const));
    check(scn, `pools at +${at / 1000}s show everyone online`, views.every(([, k]) => k === 3), views.map(([n, k]) => `${n}:${k}/3`).join(" "));
    if (at === 10_000) {
      const from = owner()!;
      const to = otherOf(from);
      const { cli, settled } = await moveAndWait(from, to, 40_000);
      check(scn, `move ${from}→${to} during the outage`, cli.code === 0 && settled !== null, `${cli.out || cli.err}; settled after ${secs(settled)}`);
    }
  }
  await sleep(Math.max(0, 58_000 - (Date.now() - t)));
  const during = await saveLogs(`${scn}-during`, m);
  for (const n of MEDDLE) {
    const lines = meddleLines(during[n]!).filter((l) => /discovery|lighthouse/i.test(l));
    const per = new Map<string, number>();
    for (const l of lines) per.set(l, (per.get(l) ?? 0) + 1);
    const worst = Math.max(0, ...per.values());
    check(scn, `${n} logs each distinct lighthouse error at most once a minute`, worst <= 1, `${lines.length} lines, ${per.size} distinct: ${[...per.keys()].join(" || ") || "(none)"}`);
  }
  const m2 = await mark();
  await sleep(Math.max(0, 60_000 - (Date.now() - t)) + 20_000);
  const after = await saveLogs(`${scn}-after`, m2);
  const lhAnn = after.lh!.filter((l) => /announce/i.test(l));
  info(scn, "after the heal: lighthouse log lines about announces", `${lhAnn.length}: ${lhAnn.slice(0, 3).join(" || ") || "(none)"}`);
  for (const n of MEDDLE) info(scn, `${n} log after heal`, meddleLines(after[n]!).join(" || ") || "(silent)");
  const lhUp = await run(["tpo", "exec", "a", "--", "curl", "-s", "-m", "5", "-w", " %{http_code}", "http://lh:8080/v1/health"]);
  info(scn, "lighthouse health after heal", lhUp.out);
}

async function s10() {
  const scn = "s10";
  const m = await mark();
  await tpo("cut", "c", "--for", "20s");
  const t = Date.now();
  const off = await Promise.all((["a", "b"] as const).map((n) => waitFor(() => sees(n, "c", "offline"), 20_000, 500).then((ms) => [n, ms === null ? null : Date.now() - t] as const)));
  for (const [n, ms] of off) info(scn, `c offline on ${n}`, ms === null ? "not within the 20 s cut" : `${secs(ms)} after the cut`);
  await sleep(Math.max(0, 20_000 - (Date.now() - t)));
  const tHeal = Date.now();
  const on = await Promise.all((["a", "b"] as const).map((n) => waitFor(() => sees(n, "c", "online"), 90_000, 500).then((ms) => [n, ms === null ? null : Date.now() - tHeal] as const)));
  for (const [n, ms] of on) info(scn, `c online on ${n} again`, `${secs(ms)} after the heal`);
  check(scn, "a and b showed c offline during the cut", off.every(([, ms]) => ms !== null), off.map(([n, ms]) => `${n}:${secs(ms)}`).join(" "));
  check(scn, "a and b show c online after the heal", on.every(([, ms]) => ms !== null), on.map(([n, ms]) => `${n}:${secs(ms)}`).join(" "));
  const logs = await saveLogs(scn, m);
  for (const n of MEDDLE) info(scn, `${n} log`, meddleLines(logs[n]!).join(" || ") || "(silent)");
}

async function s10b() {
  const scn = "s10b";
  const m = await mark();
  await tpo("cut", "c", "--for", "60s");
  const t = Date.now();
  const off = await Promise.all((["a", "b"] as const).map((n) => waitFor(() => sees(n, "c", "offline"), 60_000, 500).then((ms) => [n, ms === null ? null : Date.now() - t] as const)));
  await sleep(Math.max(0, 60_000 - (Date.now() - t)));
  const tHeal = Date.now();
  const on = await Promise.all((["a", "b"] as const).map((n) => waitFor(() => sees(n, "c", "online"), 90_000, 500).then((ms) => [n, ms === null ? null : Date.now() - tHeal] as const)));
  check(scn, "a and b show c offline during a 60 s cut", off.every(([, ms]) => ms !== null), off.map(([n, ms]) => `${n}: ${secs(ms)} after the cut`).join(", "));
  check(scn, "a and b show c online after the heal", on.every(([, ms]) => ms !== null), on.map(([n, ms]) => `${n}: ${secs(ms)} after the heal`).join(", "));
  const logs = await saveLogs(scn, m);
  for (const n of MEDDLE) info(scn, `${n} log`, meddleLines(logs[n]!).join(" || ") || "(silent)");
}

/** Restarts the member with the largest id: nobody dials it but through its new address, which only the lighthouse has. */
async function restartLargest(scn: string, lhCutMs: number) {
  const m = await mark();
  const big = [...MEDDLE].sort((x, y) => ids[y]!.localeCompare(ids[x]!))[0]!;
  const others = MEDDLE.filter((n) => n !== big);
  const dash = (await logLines(big)).filter((l) => l.startsWith("dashboard at")).length;
  let tLhHeal = 0;
  if (lhCutMs > 0) { await tpo("cut", "lh", "--for", `${lhCutMs / 1000}s`); tLhHeal = Date.now() + lhCutMs; }
  await tpo("stop", big);
  await sleep(5000);
  await tpo("start", big);
  const t = Date.now();
  await waitFor(async () => (await logLines(big)).filter((l) => l.startsWith("dashboard at")).length > dash, 60_000);
  const res = await Promise.all(others.map((n) => waitFor(() => sees(n, big, "online"), 120_000, 500).then((ms) => [n, ms === null ? null : Date.now() - t] as const)));
  const detail = res.map(([n, ms]) => `${n}: ${secs(ms)} after start${lhCutMs > 0 && ms !== null ? ` (${secs(t + ms - tLhHeal)} relative to the lighthouse heal)` : ""}`).join(", ");
  if (lhCutMs > 0) check(scn, `${big} (largest id) comes back only once the lighthouse is back`, res.every(([, ms]) => ms !== null && t + ms >= tLhHeal - 1000), detail);
  else check(scn, `${big} (largest id) online on ${others.join(",")} after restart`, res.every(([, ms]) => ms !== null), detail);
  if (lhCutMs > 0) await sleep(Math.max(0, tLhHeal - Date.now()));
  const logs = await saveLogs(scn, m);
  for (const n of MEDDLE) info(scn, `${n} log`, meddleLines(logs[n]!).join(" || ") || "(silent)");
}

async function s11() {
  const scn = "s11";
  const m = await mark();
  const dash = (await logLines("a")).filter((l) => l.startsWith("dashboard at")).length;
  const before = q<{ last_addr: string }>("b", "meddle.sqlite", `select last_addr from roster where node_id='${ids.a}'`)[0]?.last_addr;
  await tpo("stop", "a");
  await sleep(5000);
  await tpo("start", "a");
  const t = Date.now();
  const up = await waitFor(async () => (await logLines("a")).filter((l) => l.startsWith("dashboard at")).length > dash, 60_000);
  info(scn, "a serving again", secs(up));
  const res = await Promise.all((["b", "c"] as const).map((n) => waitFor(() => sees(n, "a", "online"), 90_000, 500).then((ms) => [n, ms === null ? null : Date.now() - t] as const)));
  check(scn, "a online on b and c after restart", res.every(([, ms]) => ms !== null), res.map(([n, ms]) => `${n}:${secs(ms)} after start`).join(" "));
  const afterAddr = q<{ last_addr: string }>("b", "meddle.sqlite", `select last_addr from roster where node_id='${ids.a}'`)[0]?.last_addr;
  info(scn, "a's address before/after (b's roster)", `${before} → ${afterAddr}`);
  const logs = await saveLogs(scn, m);
  for (const n of MEDDLE) info(scn, `${n} log`, meddleLines(logs[n]!).join(" || ") || "(silent)");
}

async function s11b() {
  await restartLargest("s11b", 0);
  await restartLargest("s11c", 45_000);
}

async function memoryLines(node: Node): Promise<string[]> {
  const f = await readFile(`${S}/nodes/${node}/d/memory/${P}/MEMORY.md`, "utf8").catch(() => "");
  return f.split("\n").filter(Boolean);
}
const nodesOf = (lines: string[]) => [...new Set(turns.filter((t) => t.ok && lines.includes(t.text)).map((t) => t.node))].sort();

async function s12() {
  const scn = "s12";
  const m = await mark();
  for (const n of MEDDLE) { const l = await memoryLines(n); info(scn, `${n} memory before the round`, `${l.length} lines, from nodes [${nodesOf(l).join(",")}]`); }
  // A round: a turn on every node in turn, so each node syncs memory around a turn of its own.
  let at = owner()!;
  const order = [at, ...MEDDLE.filter((n) => n !== at)];
  for (const n of order) {
    if (n !== at) {
      const { cli, settled } = await moveAndWait(at, n, 60_000);
      info(scn, `move ${at}→${n}`, `${cli.out || cli.err}; settled ${secs(settled)}`);
      at = n;
    }
    const t = await turn(n, TID, scn);
    info(scn, `turn on ${n}`, lastLine(t));
  }
  await sleep(3000);
  for (const n of MEDDLE) {
    const l = await memoryLines(n);
    const from = nodesOf(l);
    check(scn, `${n}'s MEMORY.md holds lines from at least two nodes`, from.length >= 2, `${l.length} lines from [${from.join(",")}]`);
  }
  const homeMem = await jjHost(`${S}/nodes/a`, ["file", "show", "--ignore-working-copy", "-r", "memory", 'root:"MEMORY.md"'], `${S}/nodes/a/d/memory/${P}`);
  const hl = homeMem.out.split("\n").filter(Boolean);
  const okTurns = turns.filter((t) => t.ok);
  const missing = okTurns.filter((t) => !hl.includes(t.text));
  check(scn, "home's memory bookmark holds every completed turn's line", missing.length === 0, `${hl.length} lines from [${nodesOf(hl).join(",")}]; missing: ${missing.map((t) => `${t.text}`).join(", ") || "none"}`);
  for (const n of MEDDLE) {
    const l = await memoryLines(n);
    const miss = okTurns.filter((t) => !l.includes(t.text)).map((t) => t.text.split(" ")[0]);
    info(scn, `${n}'s MEMORY.md misses`, miss.join(", ") || "nothing");
  }
  const logs = await saveLogs(scn, m);
  for (const n of MEDDLE) info(scn, `${n} log`, meddleLines(logs[n]!).join(" || ") || "(silent)");
}

async function s13() {
  const scn = "s13";
  const script = `for p in $(pgrep -f 'cli[.]ts serve$'); do [ "$(cat /proc/$p/comm 2>/dev/null)" = bun ] || continue; tr '\\0' '\\n' < /proc/$p/environ 2>/dev/null | grep -qx "TPO_NODE=$TPO_NODE" && root=$p; done
tree() { echo $1; for k in $(pgrep -P $1); do tree $k; done; }
total=0; for p in $(tree $root); do r=$(ps -o rss= -p $p); total=$((total + r)); ps -o pid=,rss=,args= -p $p | cut -c1-120; done; echo "TOTAL_KB $total"`;
  for (const n of MEDDLE) {
    const r = await run(["tpo", "exec", n, "--", "sh", "-c", script]);
    const kb = Number(/TOTAL_KB (\d+)/.exec(r.out)?.[1] ?? "0");
    await writeFile(`${LOGS}/s13-${n}-ps.log`, r.out + "\n" + r.err + "\n");
    check(scn, `RSS of ${n}'s serve tree`, kb > 0, `${(kb / 1024).toFixed(0)} MB over ${r.out.split("\n").length - 1} processes: ${r.out.split("\n").filter((l) => !l.startsWith("TOTAL")).map((l) => l.trim().replace(/\s+/g, " ").slice(0, 70)).join(" | ")}`);
  }
}

async function main() {
  console.log(`${stamp()} lab driver starting`);
  const shown = await tpo("show");
  if (shown.code === 0 && !/no lab/.test(shown.out + shown.err)) await tpo("down");
  await rm(`${S}/nodes`, { recursive: true, force: true });
  await rm(LOGS, { recursive: true, force: true });
  await mkdir(LOGS, { recursive: true });
  await mkdir(`${S}/nodes`, { recursive: true });
  try {
    for (const [name, fn] of [["s1", s1], ["s2", s2], ["s3", s3], ["s4", s4], ["s5", s5], ["s6", s6], ["s7", s7], ["s8", s8], ["s9", s9], ["s10", s10], ["s10b", s10b], ["s11", s11], ["s11b", s11b], ["s12", s12], ["s13", s13]] as const) {
      try {
        await fn();
      } catch (err) {
        report(name, "scenario threw", "BLOCKED", err instanceof Error ? `${err.message}` : String(err));
      }
    }
  } finally {
    for (const n of ALL) await writeFile(`${LOGS}/all-${n}.log`, (await logLines(n)).join("\n") + "\n").catch(() => {});
    await tpo("down");
    const after = await tpo("show");
    check("end", "tpo show reports no lab", /no lab/.test(after.out + after.err), (after.out || after.err).split("\n")[0]!);
    const stray = await run(["pgrep", "-af", "cli.ts serve|target/release/lighthouse"]);
    check("end", "no stray serve or lighthouse process on the host", stray.out === "", stray.out.replace(/\n/g, " | "));
    await writeFile(`${LOGS}/results.json`, JSON.stringify({ ids, P, TID, turns, results, minutes: (Date.now() - T0) / 60000 }, null, 2));
    console.log(`${stamp()} done in ${((Date.now() - T0) / 60000).toFixed(1)} min`);
  }
}

await main();
