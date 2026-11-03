import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { startDashboard } from "../src/dashboard/server";
import { resolveNodeId, shortId } from "../src/pool/ids";
import { PoolObject } from "../src/state/contracts";
import { openDb } from "../src/store/db";
import { getTask } from "../src/store/records";
import { markToken, tokenId } from "../src/token";
import { childEnv, closedPort, meddle } from "./helpers";
import { linkClient, peerReady, twoPoolNodes } from "./pool-helpers";

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
  expect(lines).toContain("meddle pool");
  expect(lines).toContain("meddle pool secret [--file <path> | --generate <path>] [--name <name>]");
  expect(lines).toContain("meddle pool peer <node id> | meddle pool remove <id|prefix> | meddle pool allow <id|prefix>");
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

test("token add, set, list, enable, remove and status work on the database, without a node, never printing a value", async () => {
  const dir = await mkdtemp("/tmp/meddle-cli-token-");
  const env = { HOME: dir, MEDDLE_DATA_DIR: `${dir}/d`, MEDDLE_TASK_ROOT: `${dir}/t`, MEDDLE_PORT: String(await closedPort()) };
  // No database yet: nothing to list, and none is created.
  expect(await meddle(["token", "list"], env)).toEqual({ stdout: "active: none\n", stderr: "", code: 0 });
  expect(await meddle(["token", "status"], env)).toEqual({ stdout: "active: none\n", stderr: "", code: 0 });
  expect(existsSync(`${dir}/d/meddle.sqlite`)).toBe(false);

  await writeFile(`${dir}/a`, "tok-a\n");
  await writeFile(`${dir}/b`, "tok-b\n");
  const a = tokenId("tok-a");
  const b = tokenId("tok-b");
  expect(await meddle(["token", "add", "--file", `${dir}/a`, "--label", "work"], env)).toEqual({ stdout: `token ${a} (work)\n`, stderr: "", code: 0 });
  // `set` is `add`; without a label the token is named after its id.
  expect(await meddle(["token", "set", "--file", `${dir}/b`], env)).toEqual({ stdout: `token ${b} (${b.slice(0, 8)})\n`, stderr: "", code: 0 });
  expect(await meddle(["token", "add", "--label", "again", "--file", `${dir}/a`], env)).toEqual({ stdout: `token ${a} (again)\n`, stderr: "", code: 0 });

  const listed = await meddle(["token", "list"], env);
  expect(listed.code).toBe(0);
  expect(listed.stderr).toBe("");
  const lines = listed.stdout.trimEnd().split("\n");
  expect(lines).toHaveLength(3);
  expect(lines[0]).toMatch(new RegExp(`^${a}  again  ok  expires \\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z$`));
  expect(lines[1]).toMatch(new RegExp(`^${b}  ${b.slice(0, 8)}  ok  expires \\S+$`));
  expect(lines[2]).toBe(`active: ${a}`);
  expect(await meddle(["token", "status"], env)).toEqual(listed);
  expect(listed.stdout).not.toMatch(/tok-[ab]/);

  // A token marked exhausted shows its time, and is skipped; enable clears it.
  const db = openDb(`${dir}/d/meddle.sqlite`);
  markToken(db, a, "exhausted", "2999-01-01T00:00:00.000Z", "five_hour");
  db.close();
  const exhausted = (await meddle(["token", "list"], env)).stdout.split("\n");
  expect(exhausted[0]).toMatch(new RegExp(`^${a}  again  exhausted until 2999-01-01T00:00:00.000Z \\(five_hour\\)  expires \\S+$`));
  expect(exhausted).toContain(`active: ${b}`);
  expect(await meddle(["token", "enable", "again"], env)).toEqual({ stdout: `enabled ${a} (again)\n`, stderr: "", code: 0 });
  expect((await meddle(["token", "list"], env)).stdout).toEndWith(`active: ${a}\n`);

  expect(await meddle(["token", "remove", "again"], env)).toEqual({ stdout: `removed ${a} (again)\n`, stderr: "", code: 0 });
  expect(existsSync(`${dir}/d/secrets/tokens/${a}`)).toBe(false);
  const after = (await meddle(["token", "list"], env)).stdout.trimEnd().split("\n");
  expect(after).toHaveLength(2);
  expect(after[1]).toBe(`active: ${b}`);
  expect(await meddle(["token", "remove", "again"], env)).toEqual({ stdout: "", stderr: "meddle: no such token: again\n", code: 1 });
  expect(await meddle(["token", "remove", b.slice(0, 8)], env)).toEqual({ stdout: `removed ${b} (${b.slice(0, 8)})\n`, stderr: "", code: 0 });
  expect(await meddle(["token", "list"], env)).toEqual({ stdout: "active: none\n", stderr: "", code: 0 });
}, 30_000);

test("token add tells a running node, whose pool lists the token as active", async () => {
  const { A, close } = await twoPoolNodes({ nodes: [{ token: null }, { token: null }] });
  const dashboard = await startDashboard({ ...A.cfg, port: 0 }, A.host, A.pool);
  const linked = linkClient(A.host);
  try {
    const pool = await linked.client.get(PoolObject, {});
    if (pool.variant !== "default") throw new Error("expected the default variant");
    expect(pool.activeTokenId.value).toBeNull();
    const port = new URL(dashboard.url).port;
    const env = { HOME: A.home, MEDDLE_DATA_DIR: A.cfg.dataDir, MEDDLE_TASK_ROOT: A.cfg.taskRoot, MEDDLE_PORT: port };
    await writeFile(`${A.home}/tok`, "tok-a\n");
    const id = tokenId("tok-a");
    expect(await meddle(["token", "add", "--file", `${A.home}/tok`, "--label", "work"], env)).toEqual({ stdout: `token ${id} (work)\n`, stderr: "", code: 0 });
    const deadline = Date.now() + 10_000;
    while (pool.activeTokenId.value !== id) {
      if (Date.now() > deadline) throw new Error("the running node never listed the token");
      await Bun.sleep(20);
    }
    expect(pool.tokens.value.map((t) => [t.id, t.label])).toEqual([[id, "work"]]);
    pool.release();
  } finally {
    await linked.close();
    await dashboard.stop();
    await close();
  }
}, 30_000);

test("the usage text lists the token subcommands", async () => {
  const out = await meddle([], { MEDDLE_PORT: String(await closedPort()) });
  expect(out.code).toBe(2);
  expect(out.stderr).toContain("meddle token add [--file <path>] [--label <l>] | meddle token set [--file <path>] [--label <l>]");
  expect(out.stderr).toContain("meddle token list | meddle token status | meddle token remove <id|label> | meddle token enable <id|label>");
});

test("task new --here creates the task on this node and says so; an unknown --node is refused", async () => {
  const { A, close } = await twoPoolNodes();
  const dashboard = await startDashboard({ ...A.cfg, port: 0 }, A.host, A.pool);
  try {
    const port = new URL(dashboard.url).port;
    const run = (args: string[]) => meddle(["task", "new", "--title", "t", "--project", A.project.id, ...args], { HOME: A.home, MEDDLE_PORT: port });
    const here = await run(["--here"]);
    expect(here.stderr).toBe("");
    expect(here.code).toBe(0);
    const match = /^task (\S+) on (\S+)\n$/.exec(here.stdout);
    expect(match?.[2]).toBe(shortId(A.id));
    expect(getTask(A.db, match![1]!)?.title).toBe("t");

    const unknown = await run(["--node", "zzz"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("no such node: zzz");
    expect(unknown.stdout).toBe("");

    const both = await run(["--here", "--node", A.id]);
    expect(both.code).toBe(2);
  } finally {
    await dashboard.stop();
    await close();
  }
}, 30_000);

test("the usage text lists task new's node choice", async () => {
  const out = await meddle([], { MEDDLE_PORT: String(await closedPort()) });
  expect(out.stderr).toContain("meddle task new --title <t> [--project <id|name>]... [--node <id|prefix> | --here]");
});

/** Waits until `cond` holds, or fails with `what()`. */
async function eventually(cond: () => boolean, what: () => string, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting: ${what()}`);
    await Bun.sleep(20);
  }
}

test("spawn creates a task and sends its first prompt; the title defaults to the prompt's first line", async () => {
  const { listEvents } = await import("../src/store/events");
  const { A, close } = await twoPoolNodes();
  const dashboard = await startDashboard({ ...A.cfg, port: 0 }, A.host, A.pool);
  try {
    const port = new URL(dashboard.url).port;
    const run = (args: string[]) => meddle(["spawn", ...args], { HOME: A.home, MEDDLE_PORT: port });
    const out = await run(["Say hello", "--here"]);
    expect(out.stderr).toBe("");
    expect(out.code).toBe(0);
    const match = /^task (\S+) on (\S+)\n$/.exec(out.stdout);
    expect(match?.[2]).toBe(shortId(A.id));
    const id = match![1]!;
    const row = getTask(A.db, id);
    expect(row?.title).toBe("Say hello");
    expect(JSON.parse(row!.manifest).projects).toEqual([]);
    const prompts = () => listEvents(A.db, id)
      .map((e) => e.message as { type?: string; message?: { content?: unknown } })
      .filter((m) => m.type === "user" && typeof m.message?.content === "string")
      .map((m) => m.message!.content);
    await eventually(() => prompts().length > 0, () => "the first prompt in the log");
    expect(prompts()).toEqual(["Say hello"]);

    const long = `${"x".repeat(70)}\nsecond line`;
    const titled = await run([long, "--here"]);
    expect(titled.code).toBe(0);
    expect(getTask(A.db, /^task (\S+) on/.exec(titled.stdout)![1]!)?.title).toBe("x".repeat(60));
    const named = await run(["Say hello", "--here", "--title", "Greeting"]);
    expect(getTask(A.db, /^task (\S+) on/.exec(named.stdout)![1]!)?.title).toBe("Greeting");

    expect((await run(["--here"])).code).toBe(2);
    expect((await run(["hi", "--here", "--node", A.id])).code).toBe(2);
  } finally {
    await dashboard.stop();
    await close();
  }
}, 60_000);

test("project list shows every project in the pool and who holds it; --project takes a name the pool has once", async () => {
  const { mkdir } = await import("node:fs/promises");
  const { initColocated } = await import("../src/jj");
  const { A, B, close } = await twoPoolNodes();
  const dashboard = await startDashboard({ ...A.cfg, port: 0 }, A.host, A.pool);
  try {
    const port = new URL(dashboard.url).port;
    const env = { HOME: A.home, MEDDLE_PORT: port };
    await peerReady(A, B);
    // A holds a replica of B's project (both are named "a").
    await A.runner.create({ title: "r", projectIds: [B.project.id] });
    await eventually(
      () => A.store.row(B.id)?.summary?.projects.some((p) => p.id === B.project.id) === true,
      () => `A to hear of B's project: ${JSON.stringify(A.store.row(B.id)?.summary)}`,
    );
    const listed = await meddle(["project", "list"], env);
    expect(listed.stderr).toBe("");
    expect(listed.code).toBe(0);
    const [sa, sb] = [shortId(A.id), shortId(B.id)];
    const holders = [A.id, B.id].sort().map(shortId).join(",");
    const lines = listed.stdout.trimEnd().split("\n");
    expect(lines).toContain(`${A.project.id}  a  home ${sa}  on ${sa}`);
    expect(lines).toContain(`${B.project.id}  a  home ${sb}  on ${holders}`);
    expect(lines).toHaveLength(2);

    // A name two projects share is refused; one only one has is taken.
    const ambiguous = await meddle(["spawn", "Say hello", "--project", "a", "--here"], env);
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.stderr).toBe("meddle: ambiguous project name: a\n");
    const unknown = await meddle(["task", "new", "--title", "t", "--project", "nope", "--here"], env);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toBe("meddle: unknown project: nope\n");

    await mkdir(`${A.home}/solo`);
    await initColocated(`${A.home}/solo`);
    const added = await meddle(["project", "add", `${A.home}/solo`, "--name", "solo"], env);
    expect(added.code).toBe(0);
    const soloId = added.stdout.trim();
    const spawned = await meddle(["spawn", "Say hello", "--project", "solo", "--here"], env);
    expect(spawned.stderr).toBe("");
    expect(spawned.code).toBe(0);
    const id = /^task (\S+) on/.exec(spawned.stdout)![1]!;
    expect(JSON.parse(getTask(A.db, id)!.manifest).projects.map((p: { id: string }) => p.id)).toEqual([soloId]);
  } finally {
    await dashboard.stop();
    await close();
  }
}, 60_000);

test("the usage text lists spawn and the project choice by name", async () => {
  const out = await meddle([], { MEDDLE_PORT: String(await closedPort()) });
  expect(out.stderr).toContain("meddle spawn <prompt> [--project <id|name>]... [--node <id|prefix> | --here] [--title <t>]");
  expect(out.stderr).toContain("meddle task new --title <t> [--project <id|name>]... [--node <id|prefix> | --here]");
});

test("task archive, restore and delete go through the running node; restore takes --here, --node or neither; the usage text lists them", async () => {
  const usage = Bun.spawn(["bun", "run", "src/cli.ts"], { env: await env(), stdout: "pipe", stderr: "pipe" });
  const [err] = await Promise.all([new Response(usage.stderr).text(), usage.exited]);
  const lines = err.split("\n").map((l) => l.trim());
  expect(lines).toContain("meddle task archive <id> | meddle task delete <id>");
  expect(lines).toContain("meddle task restore <id> [--node <id|prefix> | --here]");

  const { A, B, close } = await twoPoolNodes();
  const dashboard = await startDashboard({ ...A.cfg, port: 0 }, A.host, A.pool);
  try {
    const m = await A.runner.create({ title: "t", projectIds: [A.project.id] });
    const port = new URL(dashboard.url).port;
    const run = (args: string[]) => meddle(["task", ...args], { HOME: A.home, MEDDLE_PORT: port });
    const refused = await run(["delete", m.id]);
    expect(refused).toMatchObject({ stdout: "", code: 1 });
    expect(refused.stderr).toContain("task is idle");
    expect((await run(["restore", m.id, "--here", "--node", B.id])).code).toBe(2);
    expect(await run(["archive", m.id])).toEqual({ stdout: `archived ${m.id}\n`, stderr: "", code: 0 });
    expect(getTask(A.db, m.id)).toMatchObject({ state: "archived", archived_on: A.id });
    expect(await run(["restore", m.id, "--here"])).toEqual({ stdout: `task ${m.id} on ${shortId(A.id)}\n`, stderr: "", code: 0 });
    expect(getTask(A.db, m.id)).toMatchObject({ state: "idle", archived_on: null });
    // Neither: placement picks the project's home, this node.
    expect(await run(["archive", m.id])).toEqual({ stdout: `archived ${m.id}\n`, stderr: "", code: 0 });
    expect(await run(["restore", m.id])).toEqual({ stdout: `task ${m.id} on ${shortId(A.id)}\n`, stderr: "", code: 0 });
    expect(await run(["archive", m.id])).toEqual({ stdout: `archived ${m.id}\n`, stderr: "", code: 0 });
    expect(await run(["delete", m.id])).toEqual({ stdout: `deleted ${m.id}\n`, stderr: "", code: 0 });
    expect(getTask(A.db, m.id)).toBeNull();

    // On another node, named by a prefix: the move starts and the node runs it.
    const n = await A.runner.create({ title: "u", projectIds: [A.project.id] });
    expect(await run(["archive", n.id])).toEqual({ stdout: `archived ${n.id}\n`, stderr: "", code: 0 });
    expect(await run(["restore", n.id, "--node", B.id.slice(0, 10)])).toEqual({ stdout: `restoring to ${shortId(B.id)}\n`, stderr: "", code: 0 });
    const deadline = Date.now() + 15_000;
    while (getTask(B.db, n.id)?.state !== "idle" || getTask(A.db, n.id)?.state !== "moved") {
      if (Date.now() > deadline) throw new Error(`A ${getTask(A.db, n.id)?.state}, B ${getTask(B.db, n.id)?.state}`);
      await Bun.sleep(25);
    }
  } finally {
    await dashboard.stop();
    await close();
  }
}, 60_000);
