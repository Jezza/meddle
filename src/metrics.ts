// src/metrics.ts — the service's own footprint and each task's process tree, from /proc (Linux).
// On other platforms the /proc readers return empty/zero values instead of throwing.
import { readdirSync, readFileSync, readlinkSync, statfsSync } from "node:fs";
import { cpus } from "node:os";

const linux = process.platform === "linux";

export type ProcInfo = { pid: number; comm: string; rssKb: number };
export type TaskMetrics = { childRssKb: number; totalRssKb: number };
export type NodeMetrics = {
  at: string;
  serviceRssKb: number;
  eventLoopLagMs: number;
  tasks: Record<string, TaskMetrics>;
  cores: number;
  memTotalKb: number;
  memAvailableKb: number;
  load1: number;
  diskFreeKb: number;
};

function readText(path: string): string | null {
  try { return readFileSync(path, "utf8"); } catch { return null; }
}

/** A `Key:   1234 kB` line from a /proc status-style file, in KB; 0 when absent. */
function kbField(text: string | null, key: string): number {
  const m = text?.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"));
  return m ? Number(m[1]) : 0;
}

function rssOf(pid: number): number {
  return kbField(readText(`/proc/${pid}/status`), "VmRSS");
}

type StatEntry = { pid: number; comm: string; ppid: number };

/** One pass over every /proc/<pid>/stat. Processes that vanish mid-scan are skipped. */
function scanStats(): Map<number, StatEntry> {
  const out = new Map<number, StatEntry>();
  let names: string[];
  try { names = readdirSync("/proc"); } catch { return out; }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const text = readText(`/proc/${name}/stat`);
    if (!text) continue;
    // comm is in parentheses and may itself contain spaces or ')': split on the last ')'.
    const open = text.indexOf("(");
    const close = text.lastIndexOf(")");
    if (open < 0 || close < open) continue;
    const rest = text.slice(close + 2).split(" "); // [state, ppid, ...]
    const ppid = Number(rest[1]);
    if (!Number.isFinite(ppid)) continue;
    out.set(Number(name), { pid: Number(name), comm: text.slice(open + 1, close), ppid });
  }
  return out;
}

/** `pid` and its descendants, breadth-first (so shallower processes come first), with depth. */
function walkTree(pid: number): Array<StatEntry & { depth: number }> {
  if (!linux) return [];
  const stats = scanStats();
  const root = stats.get(pid);
  if (!root) return [];
  const children = new Map<number, StatEntry[]>();
  for (const s of stats.values()) {
    const list = children.get(s.ppid);
    if (list) list.push(s); else children.set(s.ppid, [s]);
  }
  const out: Array<StatEntry & { depth: number }> = [];
  const queue = [{ ...root, depth: 0 }];
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i]!;
    out.push(cur);
    for (const c of children.get(cur.pid) ?? []) queue.push({ ...c, depth: cur.depth + 1 });
  }
  return out;
}

/** The process and all its descendants. Empty when `pid` does not exist (or off Linux). */
export function processTree(pid: number): ProcInfo[] {
  return walkTree(pid).map(({ pid, comm }) => ({ pid, comm, rssKb: rssOf(pid) }));
}

/** `childRssKb` sums the `claude*` processes in the tree; `totalRssKb` sums the whole tree. */
export function sampleTask(pid: number): TaskMetrics {
  let childRssKb = 0;
  let totalRssKb = 0;
  for (const p of processTree(pid)) {
    totalRssKb += p.rssKb;
    if (p.comm.startsWith("claude")) childRssKb += p.rssKb;
  }
  return { childRssKb, totalRssKb };
}

/** This process's resident set size in KB. */
export function serviceRssKb(): number {
  return linux ? rssOf(process.pid) : 0;
}

/**
 * Task id → pid for this process's descendants whose cwd is `<taskRoot>/<taskId>` or below it.
 * The shallowest match per task wins (the `claude` child, not its tool subprocesses).
 */
export function findTaskPids(taskRoot: string): Record<string, number> {
  const prefix = taskRoot.replace(/\/+$/, "") + "/";
  const out: Record<string, number> = {};
  for (const p of walkTree(process.pid).slice(1)) {
    let cwd: string;
    try { cwd = readlinkSync(`/proc/${p.pid}/cwd`); } catch { continue; }
    if (!cwd.startsWith(prefix)) continue;
    const taskId = cwd.slice(prefix.length).split("/")[0]!;
    if (taskId && !(taskId in out)) out[taskId] = p.pid;
  }
  return out;
}

function memInfo(): { memTotalKb: number; memAvailableKb: number } {
  const text = linux ? readText("/proc/meminfo") : null;
  return { memTotalKb: kbField(text, "MemTotal"), memAvailableKb: kbField(text, "MemAvailable") };
}

function load1(): number {
  const n = Number((linux ? readText("/proc/loadavg") : null)?.split(" ")[0]);
  return Number.isFinite(n) ? n : 0;
}

function diskFreeKb(dir: string): number {
  try {
    const s = statfsSync(dir);
    return Math.floor((Number(s.bavail) * Number(s.bsize)) / 1024);
  } catch { return 0; }
}

export class MetricsSampler {
  private interval: ReturnType<typeof setInterval> | null = null;
  private probe: ReturnType<typeof setTimeout> | null = null;
  private last: NodeMetrics | null = null;
  private listeners = new Set<(m: NodeMetrics) => void>();

  constructor(private opts: { taskPids: () => Record<string, number>; intervalMs: number; dataDir: string }) {}

  /** Samples at once, then every `intervalMs`; the timer does not keep the process alive. */
  start(): void {
    if (this.interval) return;
    this.tick();
    this.interval = setInterval(() => this.tick(), this.opts.intervalMs);
    this.interval.unref();
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    if (this.probe) clearTimeout(this.probe);
    this.interval = null;
    this.probe = null;
  }

  latest(): NodeMetrics | null {
    return this.last;
  }

  onSample(cb: (m: NodeMetrics) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  /** Event-loop lag is how late a zero-delay timer fires; the sample is taken when it does. */
  private tick(): void {
    if (this.probe) return; // the previous sample has not completed yet
    const scheduled = performance.now();
    this.probe = setTimeout(() => {
      this.probe = null;
      this.emit(this.sample(performance.now() - scheduled));
    }, 0);
  }

  private sample(eventLoopLagMs: number): NodeMetrics {
    let pids: Record<string, number> = {};
    try { pids = this.opts.taskPids(); } catch {}
    const tasks: Record<string, TaskMetrics> = {};
    for (const [id, pid] of Object.entries(pids)) tasks[id] = sampleTask(pid);
    return {
      at: new Date().toISOString(),
      serviceRssKb: serviceRssKb(),
      eventLoopLagMs,
      tasks,
      cores: cpus().length,
      ...memInfo(),
      load1: load1(),
      diskFreeKb: diskFreeKb(this.opts.dataDir),
    };
  }

  private emit(m: NodeMetrics): void {
    this.last = m;
    for (const cb of [...this.listeners]) {
      try { cb(m); } catch {}
    }
  }
}
