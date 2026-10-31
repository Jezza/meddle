// test/metrics.test.ts
import { test, expect } from "bun:test";
import { mkdtemp, mkdir, realpath } from "node:fs/promises";
import { processTree, sampleTask, serviceRssKb, findTaskPids, MetricsSampler, type NodeMetrics } from "../src/metrics";

function killTree(pid: number) {
  for (const p of processTree(pid).reverse()) {
    try { process.kill(p.pid, "SIGKILL"); } catch {}
  }
}

test("process tree and rss", async () => {
  const p = Bun.spawn(["sh", "-c", "sleep 5 & sleep 5"], {});
  try {
    await Bun.sleep(100);
    const tree = processTree(p.pid);
    expect(tree.length).toBeGreaterThanOrEqual(2);
    expect(tree[0]!.pid).toBe(p.pid);
    expect(tree.slice(1).some(t => t.comm === "sleep")).toBe(true);
    expect(sampleTask(p.pid).totalRssKb).toBeGreaterThan(0);
    expect(serviceRssKb()).toBeGreaterThan(1000);
  } finally {
    killTree(p.pid);
    await p.exited;
  }
});

test("processTree of a vanished pid is empty", () => {
  expect(processTree(2 ** 22 + 12345)).toEqual([]);
});

test("findTaskPids maps a task's cwd to its shallowest descendant", async () => {
  const root = await realpath(await mkdtemp("/tmp/meddle-metrics-"));
  await mkdir(`${root}/task1/sub`, { recursive: true });
  await mkdir(`${root}/task10`, { recursive: true });
  const inTask = Bun.spawn(["sh", "-c", "cd sub && sleep 5 & sleep 5"], { cwd: `${root}/task1` });
  const lookalike = Bun.spawn(["sleep", "5"], { cwd: `${root}/task10` });
  const elsewhere = Bun.spawn(["sleep", "5"], { cwd: root });
  try {
    await Bun.sleep(100);
    const found = findTaskPids(root);
    expect(found.task1).toBe(inTask.pid);
    expect(found.task10).toBe(lookalike.pid);
    expect(Object.values(found)).not.toContain(elsewhere.pid);
    expect(Object.keys(found).sort()).toEqual(["task1", "task10"]);
  } finally {
    for (const p of [inTask, lookalike, elsewhere]) killTree(p.pid);
    await Promise.all([inTask.exited, lookalike.exited, elsewhere.exited]);
  }
});

test("MetricsSampler samples the node and each task, and stops cleanly", async () => {
  const dataDir = await mkdtemp("/tmp/meddle-metrics-");
  const p = Bun.spawn(["sleep", "5"], {});
  const s = new MetricsSampler({ taskPids: () => ({ a: p.pid, b: process.pid }), intervalMs: 60_000, dataDir });
  try {
    expect(s.latest()).toBeNull();
    s.onSample(() => { throw new Error("a broken listener must not break sampling"); });
    const first = new Promise<NodeMetrics>(r => { const off = s.onSample(m => { off(); r(m); }); });
    s.start();
    const m = await first;
    expect(s.latest()).toBe(m);
    expect(Object.keys(m.tasks).sort()).toEqual(["a", "b"]);
    expect(m.tasks.b!.totalRssKb).toBeGreaterThan(0);
    expect(m.cores).toBeGreaterThan(0);
    expect(m.memTotalKb).toBeGreaterThan(0);
    expect(m.memAvailableKb).toBeGreaterThan(0);
    expect(m.diskFreeKb).toBeGreaterThan(0);
    expect(m.serviceRssKb).toBeGreaterThan(1000);
    expect(m.eventLoopLagMs).toBeGreaterThanOrEqual(0);
    expect(m.load1).toBeGreaterThanOrEqual(0);
    expect(Number.isNaN(Date.parse(m.at))).toBe(false);
  } finally {
    s.stop();
    p.kill();
    await p.exited;
  }
});
