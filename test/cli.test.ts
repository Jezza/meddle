import { test, expect } from "bun:test";
import { startDashboard } from "../src/dashboard/server";
import { resolveNodeId } from "../src/pool/ids";
import { getTask } from "../src/store/records";
import { childEnv, closedPort, meddle } from "./helpers";
import { peerReady, twoPoolNodes } from "./pool-helpers";

/** The env a CLI child runs with: no inherited MEDDLE_* and a port nothing listens on. */
async function env() {
  return childEnv({ MEDDLE_PORT: String(await closedPort()) });
}

test("--version prints the version", async () => {
  const p = Bun.spawn(["bun", "run", "src/cli.ts", "--version"], { env: await env(), stdout: "pipe" });
  const out = await new Response(p.stdout).text();
  expect(out.trim()).toMatch(/^meddle \d+\.\d+\.\d+$/);
});

test("the usage text lists the pool subcommands", async () => {
  const p = Bun.spawn(["bun", "run", "src/cli.ts"], { env: await env(), stdout: "pipe", stderr: "pipe" });
  const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  expect(code).toBe(2);
  const lines = err.split("\n").map((l) => l.trim());
  expect(lines).toContain("meddle invite");
  expect(lines).toContain("meddle join <ticket>");
  expect(lines).toContain("meddle pool");
  expect(lines).toContain("meddle task move <id> <node> [--now]");
});

test("a node is named by its full id or a unique prefix of one", () => {
  const ids = ["ab".repeat(32), "ac".repeat(32), "bb".repeat(32)];
  expect(resolveNodeId(ids, ids[0]!)).toBe(ids[0]!);
  expect(resolveNodeId(ids, "ab")).toBe(ids[0]!);
  expect(resolveNodeId(ids, "b")).toBe(ids[2]!);
  expect(() => resolveNodeId(ids, "a")).toThrow("ambiguous node: a");
  expect(() => resolveNodeId(ids, "cc")).toThrow("no such node: cc");
  expect(() => resolveNodeId(ids, "")).toThrow("no such node: ");
});

test("task prompt to a task being moved queues the text, says so and exits 0 rather than waiting for a turn", async () => {
  // A's turn stalls before its result: the move waits for it in `prepare`.
  const { A, B, close } = await twoPoolNodes({ nodes: [{ extraEnv: { MEDDLE_FIXTURE_STALL: "1" } }, {}] });
  const dashboard = await startDashboard({ ...A.cfg, port: 0 }, A.host, A.pool);
  try {
    const m = await A.runner.create({ title: "t", projectIds: [A.project.id] });
    await peerReady(A, B);
    const running = new Promise<void>((res) => A.runner.onState((id, s) => { if (id === m.id && s === "running") res(); }));
    await A.runner.prompt(m.id, "Reply with the single word ok.");
    await running;
    await A.runner.moveTo(m.id, B.id, false);
    const deadline = Date.now() + 10_000;
    while (getTask(A.db, m.id)!.state !== "moving") {
      if (Date.now() > deadline) throw new Error(`A's row is still ${getTask(A.db, m.id)!.state}`);
      await Bun.sleep(20);
    }
    const port = new URL(dashboard.url).port;
    const out = await meddle(["task", "prompt", m.id, "while", "moving"], { HOME: A.home, MEDDLE_PORT: port });
    expect(out).toEqual({ stdout: "queued; it runs once the task has arrived\n", stderr: "", code: 0 });
    expect(JSON.parse(getTask(A.db, m.id)!.queued!)).toEqual(["while moving"]);
  } finally {
    await dashboard.stop();
    await close();
  }
}, 15_000);

test("config set, list and refusals go through the running node", async () => {
  const { A, close } = await twoPoolNodes();
  const dashboard = await startDashboard({ ...A.cfg, port: 0 }, A.host, A.pool);
  try {
    const port = new URL(dashboard.url).port;
    const run = (args: string[]) => meddle(["config", ...args], { HOME: A.home, MEDDLE_PORT: port });
    expect(await run(["set", "jj.user", "Lab"])).toEqual({ stdout: "", stderr: "", code: 0 });
    expect(await run(["set", "env.FOO", "bar"])).toEqual({ stdout: "", stderr: "", code: 0 });
    expect(A.pool.settings.get("jj.user")).toBe("Lab");
    expect(A.cfg.poolEnv).toEqual({ JJ_USER: "Lab", FOO: "bar" });
    expect(await run(["list"])).toEqual({ stdout: "env.FOO = bar\njj.user = Lab\n", stderr: "", code: 0 });
    expect(await run(["unset", "env.FOO"])).toEqual({ stdout: "", stderr: "", code: 0 });
    expect(await run(["list"])).toEqual({ stdout: "jj.user = Lab\n", stderr: "", code: 0 });
    const bad = await run(["set", "bad", "x"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("invalid setting key: bad");
    const reserved = await run(["set", "env.PATH", "/x"]);
    expect(reserved.code).toBe(1);
    expect(reserved.stderr).toContain("reserved environment name: PATH");
  } finally {
    await dashboard.stop();
    await close();
  }
}, 30_000);

test("config without a running node says to start one", async () => {
  for (const args of [["list"], ["set", "jj.user", "Lab"], ["unset", "jj.user"]]) {
    const out = await meddle(["config", ...args], { MEDDLE_PORT: String(await closedPort()) });
    expect(out).toEqual({ stdout: "", stderr: 'meddle: start "meddle serve" first\n', code: 1 });
  }
});

test("the usage text lists the config subcommands", async () => {
  const out = await meddle([], { MEDDLE_PORT: String(await closedPort()) });
  expect(out.code).toBe(2);
  expect(out.stderr).toContain("meddle config set <key> <value> | meddle config unset <key> | meddle config list");
});
