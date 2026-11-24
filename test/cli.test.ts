import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter } from "node:path";
import { paths } from "../src/config";
import { startDashboard } from "../src/dashboard/server";
import { resolveNodeId, shortId, uniquePrefixLengths } from "../src/pool/ids";
import { listLineRows } from "../src/pool/rows";
import { PoolObject } from "../src/state/contracts";
import { openDb } from "../src/store/db";
import { pauseTrain } from "../src/train/train";
import { updateFiles, writePending } from "../src/update/files";
import { getTask, listTasks } from "../src/store/records";
import { markToken, tokenId } from "../src/token";
import { initColocated, jj } from "../src/jj";
import { childEnv, closedPort, createTask, meddle, replay, repoRoot, startServe } from "./helpers";
import { linkClient, peerReady, POOL_ENV, poolNodes, twoPoolNodes, type GitPoolNode } from "./pool-helpers";

const ESC = "\x1b[";

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
  expect(lines).toContain("meddle pool [-v]");
  expect(lines).toContain("meddle pool secret [--file <path> | --generate <path>] [--name <name>]");
  expect(lines).toContain("meddle pool peer <node id> | meddle pool remove <id|prefix> | meddle pool allow <id|prefix>");
  expect(lines).toContain("meddle task move <id> <node> [--now] | meddle task move <id> --now | meddle task move <id> --cancel");
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
    const m = await createTask(A, { title: "t", projectIds: [A.project.id] });
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

test("the usage text lists the project subcommands", async () => {
  const out = await meddle([], { MEDDLE_PORT: String(await closedPort()) });
  expect(out.code).toBe(2);
  const lines = out.stderr.split("\n").map((l) => l.trim());
  expect(lines).toContain("meddle project add <path-or-url> [--name <n>] [--no-fetch]");
  expect(lines).toContain("meddle project list");
  expect(out.stderr).not.toContain("sync");
  expect(lines).toContain("meddle project set-default <id|name> <branch>");
  expect(lines).toContain("meddle checkout <id|name> [<dir>]");
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

  expect(await meddle(["token", "rename", "again", "work"], env)).toEqual({ stdout: `renamed ${a} (work)\n`, stderr: "", code: 0 });
  expect(await meddle(["token", "rename", a, "again"], env)).toEqual({ stdout: `renamed ${a} (again)\n`, stderr: "", code: 0 });
  expect(await meddle(["token", "rename", "nope", "x"], env)).toEqual({ stdout: "", stderr: "meddle: no such token: nope\n", code: 1 });

  expect(await meddle(["token", "remove", "again"], env)).toEqual({ stdout: `removed ${a} (again)\n`, stderr: "", code: 0 });
  expect(existsSync(`${dir}/d/secrets/tokens/${a}`)).toBe(false);
  const after = (await meddle(["token", "list"], env)).stdout.trimEnd().split("\n");
  expect(after).toHaveLength(2);
  expect(after[1]).toBe(`active: ${b}`);
  expect(await meddle(["token", "remove", "again"], env)).toEqual({ stdout: "", stderr: "meddle: no such token: again\n", code: 1 });
  expect(await meddle(["token", "remove", b.slice(0, 8)], env)).toEqual({ stdout: `removed ${b} (${b.slice(0, 8)})\n`, stderr: "", code: 0 });
  expect(await meddle(["token", "list"], env)).toEqual({ stdout: "active: none\n", stderr: "", code: 0 });
}, 30_000);

test("token list highlights each id's unique prefix, and the token commands take it", async () => {
  const dir = await mkdtemp("/tmp/meddle-cli-token-prefix-");
  const env = { HOME: dir, MEDDLE_DATA_DIR: `${dir}/d`, MEDDLE_TASK_ROOT: `${dir}/t`, MEDDLE_PORT: String(await closedPort()) };
  // Two values whose ids start alike, so a prefix can be ambiguous.
  const values = Array.from({ length: 17 }, (_, i) => `tok-${i}`);
  const x = values.find((v) => values.some((w) => w !== v && tokenId(w)[0] === tokenId(v)[0]))!;
  const y = values.find((w) => w !== x && tokenId(w)[0] === tokenId(x)[0])!;
  const [a, b] = [tokenId(x), tokenId(y)];
  for (const [value, label] of [[x, "x"], [y, "y"]] as const) {
    await writeFile(`${dir}/${label}`, `${value}\n`);
    expect((await meddle(["token", "add", "--file", `${dir}/${label}`, "--label", label], env)).code).toBe(0);
  }

  const prefixes = uniquePrefixLengths([a, b]);
  const lit = (id: string) => `${ESC}1;35m${id.slice(0, prefixes.get(id)!)}${ESC}22;39m${id.slice(prefixes.get(id)!)}`;
  const coloured = (await meddle(["token", "list"], { ...env, FORCE_COLOR: "1" })).stdout.trimEnd().split("\n");
  expect(coloured[0]).toStartWith(`${lit(a)}  x  `);
  expect(coloured[1]).toStartWith(`${lit(b)}  y  `);
  expect(coloured[2]).toBe(`active: ${lit(a)}`);

  const pa = a.slice(0, prefixes.get(a)!);
  expect(await meddle(["token", "rename", pa, "z"], env)).toEqual({ stdout: `renamed ${a} (z)\n`, stderr: "", code: 0 });
  const ambiguous = await meddle(["token", "remove", a[0]!], env);
  expect(ambiguous).toEqual({ stdout: "", stderr: `meddle: ambiguous token: ${a[0]} (${[a, b].sort().join(", ")})\n`, code: 1 });
  expect(await meddle(["token", "remove", pa], env)).toEqual({ stdout: `removed ${a} (z)\n`, stderr: "", code: 0 });
}, 30_000);

test("token, project, task and config alone list, and tokens, projects and tasks are token, project and task", async () => {
  const dir = await mkdtemp("/tmp/meddle-cli-token-alias-");
  const env = { HOME: dir, MEDDLE_DATA_DIR: `${dir}/d`, MEDDLE_TASK_ROOT: `${dir}/t`, MEDDLE_PORT: String(await closedPort()) };
  await writeFile(`${dir}/a`, "tok-a\n");
  expect((await meddle(["tokens", "add", "--file", `${dir}/a`], env)).code).toBe(0);
  const listed = await meddle(["token", "list"], env);
  expect(listed.stdout).toEndWith(`active: ${tokenId("tok-a")}\n`);
  for (const args of [["token"], ["tokens"], ["tokens", "list"]]) expect(await meddle(args, env)).toEqual(listed);
  // Without a node, the other lists say to start one rather than print their usage.
  for (const args of [["project"], ["projects"], ["task"], ["tasks"], ["config"]]) {
    expect(await meddle(args, env)).toEqual({ stdout: "", stderr: 'meddle: start "meddle serve" first\n', code: 1 });
  }
}, 30_000);

test("token move puts a token before or after another, without a node", async () => {
  const dir = await mkdtemp("/tmp/meddle-cli-token-move-");
  const env = { HOME: dir, MEDDLE_DATA_DIR: `${dir}/d`, MEDDLE_TASK_ROOT: `${dir}/t`, MEDDLE_PORT: String(await closedPort()) };
  expect(await meddle(["token", "move", "a", "--before", "b"], env)).toEqual({ stdout: "", stderr: "meddle: no such token: a\n", code: 1 });
  for (const name of ["a", "b", "c"]) {
    await writeFile(`${dir}/${name}`, `tok-${name}\n`);
    expect((await meddle(["token", "add", "--file", `${dir}/${name}`, "--label", name], env)).code).toBe(0);
  }
  const [a, b, c] = ["tok-a", "tok-b", "tok-c"].map(tokenId);
  const order = async () => (await meddle(["token", "list"], env)).stdout.trimEnd().split("\n").slice(0, -1).map((l) => l.split("  ")[1]!);

  expect(await meddle(["token", "move", "c", "--before", "a"], env)).toEqual({ stdout: `moved ${c} (c) before ${a} (a)\n`, stderr: "", code: 0 });
  expect(await order()).toEqual(["c", "a", "b"]);
  expect((await meddle(["token", "list"], env)).stdout).toEndWith(`active: ${c}\n`);
  expect(await meddle(["token", "move", c, "--after", b], env)).toEqual({ stdout: `moved ${c} (c) after ${b} (b)\n`, stderr: "", code: 0 });
  expect(await order()).toEqual(["a", "b", "c"]);

  expect(await meddle(["token", "move", "a", "--after", "a"], env)).toEqual({ stdout: "", stderr: "meddle: cannot move a token before or after itself\n", code: 1 });
  expect(await meddle(["token", "move", "a", "--before", "nope"], env)).toEqual({ stdout: "", stderr: "meddle: no such token: nope\n", code: 1 });
  for (const bad of [["a"], ["a", "--before"], ["a", "--before", "b", "--after", "c"], ["a", "--first"], ["--before", "b"]]) {
    const out = await meddle(["token", "move", ...bad], env);
    expect(out.code).toBe(2);
    expect(out.stderr).toBe(
      "usage: meddle token move <id|label> --before <id|label>\n       meddle token move <id|label> --after <id|label>\n\nmeddle help token move says more.\n",
    );
  }
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
  expect(out.stderr).toContain("meddle token move <id|label> --before <id|label> | meddle token move <id|label> --after <id|label>");
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
    const match = /^task (\S+) on (\S+)(?: \(.*\))?\n$/.exec(here.stdout);
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

test("the usage text lists task new's prompt, title, projects with their starts and node choice, and task list", async () => {
  const out = await meddle([], { MEDDLE_PORT: String(await closedPort()) });
  expect(out.stderr).toContain("meddle task new [<prompt>] [--title <t>] [--project <id|name> [--rev <rev>] [--edit]]... [--node <id|prefix> | --here]");
  expect(out.stderr).toContain("meddle task list");
  expect(out.stderr).not.toContain("spawn");
});

test("task new: --rev and --edit belong to the --project before them; --edit needs --rev", async () => {
  const env = { MEDDLE_PORT: String(await closedPort()) };
  const run = (args: string[]) => meddle(["task", "new", "hi", ...args], env);
  for (const args of [["--rev", "x"], ["--edit"], ["--rev", "x", "--project", "a"], ["--project", "a", "--rev", "x", "--rev", "y"], ["--project", "a", "--rev", "x", "--edit", "--edit"], ["--project", "a", "--rev"]]) {
    const out = await run(args);
    expect(out.code).toBe(2);
    expect(out.stderr).toContain("usage: meddle task new");
  }
  const noRev = await run(["--project", "a", "--edit"]);
  expect(noRev.code).toBe(2);
  expect(noRev.stderr).toBe("meddle: --edit needs --rev\n");
});

test("task new --project a --rev X --edit --project b sends a's revision to edit and b with none", async () => {
  const { writeFile: write, mkdir } = await import("node:fs/promises");
  const { initColocated, jj } = await import("../src/jj");
  const { addProjectFromFolder } = await import("../src/projects/project");
  const { A, B, close } = await twoPoolNodes();
  const dashboard = await startDashboard({ ...A.cfg, port: 0 }, A.host, A.pool);
  try {
    const read = async (n: typeof A, repo: string, rev: string) =>
      (await jj(["log", "--ignore-working-copy", "-r", rev, "--no-graph", "-T", "commit_id"], repo, n.cfg)).trim();
    // a (A's): W on its default branch P, its service repo's `@` back on P. b (B's): one commit, its default branch.
    const a = A.project.replica;
    const P = await read(A, a, "main");
    await jj(["new", P], a, A.cfg);
    await write(`${a}/w`, "w\n");
    await jj(["commit", "-m", "W"], a, A.cfg);
    const W = await read(A, a, "@-");
    await jj(["new", P], a, A.cfg);
    const bFolder = `${B.home}/b`;
    await mkdir(bFolder);
    await initColocated(bFolder, B.cfg);
    await write(`${bFolder}/b`, "b\n");
    await jj(["commit", "-m", "b"], bFolder, B.cfg);
    await jj(["bookmark", "set", "main", "-r", "@-"], bFolder, B.cfg);
    const b = await addProjectFromFolder(B.cfg, B.db, bFolder, B.id, "b");
    const fork = await read(B, b.replica, "main");
    await peerReady(A, B);
    await eventually(() => A.store.row(B.id)?.summary?.projects.some((p) => p.id === b.id) === true, () => "A to hear of b");

    const port = new URL(dashboard.url).port;
    const out = await meddle(["task", "new", "--title", "t", "--project", A.project.id, "--rev", W, "--edit", "--project", "b", "--here"], { HOME: A.home, MEDDLE_PORT: port });
    expect(out.stderr).toBe("");
    expect(out.code).toBe(0);
    const id = /^task (\S+) on/.exec(out.stdout)![1]!;
    const manifest = JSON.parse(getTask(A.db, id)!.manifest) as { projects: Array<{ name: string; base: string[] }> };
    expect(manifest.projects.map((p) => [p.name, p.base])).toEqual([["a", [P]], ["b", [fork]]]);
    const task = paths(A.cfg).task(id);
    // a's workspace edits W; b's is a new change on b's fork point.
    expect(await read(A, `${task}/a`, "@")).toBe(W);
    expect(await read(A, `${task}/b`, "@-")).toBe(fork);
  } finally {
    await dashboard.stop();
    await close();
  }
}, 60_000);

/** A PATH with `n`'s `<data>/bin`, where its `git-remote-meddle` is, first: what `project add` checks for. */
function withHelper(n: { cfg: Parameters<typeof paths>[0] }): string {
  return `${paths(n.cfg).bin}${delimiter}${process.env.PATH}`;
}

/** Waits until `cond` holds, or fails with `what()`. */
async function eventually(cond: () => boolean, what: () => string, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting: ${what()}`);
    await Bun.sleep(20);
  }
}

test("task new with a prompt sends it as the first turn; Haiku names it from the prompt afterwards, or with no prompt it keeps two adjectives and a noun", async () => {
  const { listEvents } = await import("../src/store/events");
  const { A, close } = await twoPoolNodes();
  const dashboard = await startDashboard({ ...A.cfg, port: 0 }, A.host, A.pool);
  try {
    const port = new URL(dashboard.url).port;
    const run = (args: string[]) => meddle(["task", "new", ...args], { HOME: A.home, MEDDLE_PORT: port });
    const out = await run(["Say hello", "--here"]);
    expect(out.stderr).toBe("");
    expect(out.code).toBe(0);
    const match = /^task (\S+) on (\S+)(?: \(.*\))?\n$/.exec(out.stdout);
    expect(match?.[2]).toBe(shortId(A.id));
    const id = match![1]!;
    const row = getTask(A.db, id);
    expect(JSON.parse(row!.manifest).projects).toEqual([]);
    // Made with a made-up name, not waiting on Haiku; the stand-in Claude Code replays a recording whose reply is
    // `ok`: that is Haiku's title, which replaces it.
    await eventually(() => getTask(A.db, id)?.title === "ok", () => `Haiku's title, not ${getTask(A.db, id)?.title}`);
    const prompts = () => listEvents(A.db, id)
      .map((e) => e.message as { type?: string; message?: { content?: unknown } })
      .filter((m) => m.type === "user" && typeof m.message?.content === "string")
      .map((m) => m.message!.content);
    await eventually(() => prompts().length > 0, () => "the first prompt in the log");
    expect(prompts()).toEqual(["Say hello"]);

    const named = await run(["Say hello", "--here", "--title", "Greeting"]);
    expect(getTask(A.db, /^task (\S+) on/.exec(named.stdout)![1]!)?.title).toBe("Greeting");

    // No prompt and no title: a name of two adjectives and a noun, and no turn.
    const bare = await run(["--here"]);
    expect(bare.code).toBe(0);
    const bareId = /^task (\S+) on/.exec(bare.stdout)![1]!;
    expect(getTask(A.db, bareId)?.title).toMatch(/^[a-z]+ [a-z]+ [a-z]+$/);
    expect(listEvents(A.db, bareId).some((e) => (e.message as { type?: string }).type === "user")).toBe(false);

    expect((await run(["hi", "--here", "--node", A.id])).code).toBe(2);
    expect((await run(["hi", "--title", ""])).code).toBe(2);
    expect((await run(["hi", "--frob"])).code).toBe(2);
    // `spawn` is gone: `task new` with a prompt does what it did.
    expect((await meddle(["spawn", "hi"], { HOME: A.home, MEDDLE_PORT: port })).code).toBe(2);
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
    const env = { HOME: A.home, MEDDLE_PORT: port, PATH: withHelper(A) };
    await peerReady(A, B);
    // A holds a replica of B's project (both are named "a").
    await createTask(A, { title: "r", projectIds: [B.project.id] });
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
    const ambiguous = await meddle(["task", "new", "Say hello", "--project", "a", "--here"], env);
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.stderr).toBe("meddle: ambiguous project name: a\n");
    const unknown = await meddle(["task", "new", "--title", "t", "--project", "nope", "--here"], env);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toBe("meddle: unknown project: nope\n");

    await mkdir(`${A.home}/solo`);
    await initColocated(`${A.home}/solo`);
    // A first commit, its default branch: a task of `solo` starts on it.
    await writeFile(`${A.home}/solo/README`, "solo\n");
    await (await import("../src/jj")).jj(["commit", "-m", "solo"], `${A.home}/solo`);
    await (await import("../src/jj")).jj(["bookmark", "set", "main", "-r", "@-"], `${A.home}/solo`);
    const added = await meddle(["project", "add", `${A.home}/solo`, "--name", "solo", "--no-fetch"], env);
    expect(added.code).toBe(0);
    const soloId = added.stdout.trim();
    const created = await meddle(["task", "new", "Say hello", "--project", "solo", "--here"], env);
    expect(created.stderr).toBe("");
    expect(created.code).toBe(0);
    const id = /^task (\S+) on/.exec(created.stdout)![1]!;
    expect(JSON.parse(getTask(A.db, id)!.manifest).projects.map((p: { id: string }) => p.id)).toEqual([soloId]);
  } finally {
    await dashboard.stop();
    await close();
  }
}, 60_000);

test("project sync is no command, and project add takes no --sync", async () => {
  const env = { MEDDLE_PORT: String(await closedPort()) };
  for (const args of [["project", "sync", "solo", "main"], ["project", "sync", "solo"], ["project", "add", "/tmp/solo", "--sync", "dev"]]) {
    const out = await meddle(args, env);
    expect(out.code).toBe(2);
    expect(out.stdout).toBe("");
    expect(out.stderr).toStartWith("usage: meddle project add <path-or-url> [--name <n>] [--no-fetch]\n");
    expect(out.stderr).not.toContain("sync");
  }
});

test("task list prints every task of the pool, this node's first, archived ones last, each with its node and projects", async () => {
  const { acceptDashboardStreams } = await import("../src/dashboard/tunnel");
  const { A, B, close } = await twoPoolNodes();
  const dashboard = await startDashboard({ ...A.cfg, port: 0 }, A.host, A.pool);
  // As `serve` does: B serves its objects to members' dashboards (and so to A's CLI) over the pool.
  let stopTunnels = acceptDashboardStreams(B.net, B.host, (id) => B.store.isMember(id));
  try {
    const env = { HOME: A.home, MEDDLE_DATA_DIR: A.cfg.dataDir, MEDDLE_PORT: new URL(dashboard.url).port };
    await peerReady(A, B);
    const empty = await meddle(["task", "list"], env);
    expect(empty).toMatchObject({ code: 0, stdout: "", stderr: "" });

    const first = await createTask(A, { title: "first on A", projectIds: [A.project.id] });
    const loose = await createTask(A, { title: "no project", projectIds: [] });
    const onB = await createTask(B, { title: "on B", projectIds: [B.project.id] });
    await A.runner.archive(loose.id);
    const out = await meddle(["task", "list"], env);
    expect(out.stderr).toBe("");
    expect(out.code).toBe(0);
    const [sa, sb] = [shortId(A.id), shortId(B.id)];
    // A table: a header, then a row per task, the columns two or more spaces apart.
    const cells = out.stdout.trimEnd().split("\n").map((line) => line.split(/ {2,}/));
    expect(cells).toEqual([
      ["ID", "STATE", "NODE", "HOST", "PROJECTS", "TITLE"],
      [first.id, "idle", sa, A.store.row(A.id)!.hostname, "a", "first on A"],
      [loose.id, "archived", sa, A.store.row(A.id)!.hostname, "-", "no project"],
      [onB.id, "idle", sb, A.store.row(B.id)!.hostname, "a", "on B"],
    ]);
    expect(out.stdout).not.toContain("\x1b[");

    // A task is named by a unique prefix, and acted on at the node holding it, from this one: even when this node
    // keeps a row of it from before it moved away, `delete` goes to where it lives (and an idle task is refused).
    const { insertTask } = await import("../src/store/records");
    const live = getTask(B.db, onB.id)!;
    insertTask(A.db, { id: live.id, title: live.title, state: "moved", session_id: live.session_id, manifest: live.manifest, started: live.started, turns: live.turns });
    const prefix = onB.id.slice(0, 6);
    expect(await meddle(["task", "delete", prefix], env)).toEqual({
      stdout: "",
      stderr: "meddle: task is idle; only an archived task is deleted: archive it first\n",
      code: 1,
    });
    expect(getTask(A.db, onB.id)?.state).toBe("moved");
    expect(await meddle(["task", "archive", prefix], env)).toEqual({ stdout: `archived ${onB.id}\n`, stderr: "", code: 0 });
    expect(getTask(B.db, onB.id)?.state).toBe("archived");
    expect(await meddle(["task", "delete", prefix], env)).toEqual({ stdout: `deleted ${onB.id}\n`, stderr: "", code: 0 });
    expect(getTask(B.db, onB.id)).toBeNull();
    // Living nowhere now, the row this node kept is what the prefix names.
    expect(getTask(A.db, onB.id)?.state).toBe("moved");
    expect(await meddle(["task", "delete", prefix], env)).toEqual({ stdout: `deleted ${onB.id}\n`, stderr: "", code: 0 });
    expect(getTask(A.db, onB.id)).toBeNull();
    const none = await meddle(["task", "archive", "zzzz"], env);
    expect(none).toEqual({ stdout: "", stderr: "meddle: no such task: zzzz\n", code: 1 });

    // A member that is online but does not answer is reported, not waited on for ever.
    stopTunnels();
    stopTunnels = () => {};
    const silent = await meddle(["task", "list"], env);
    expect(silent.code).toBe(0);
    expect(silent.stdout.trimEnd().split("\n")).toHaveLength(3);
    expect(silent.stderr).toBe(`${sb} (${A.store.row(B.id)!.hostname}) did not answer: its tasks are not listed\n`);
  } finally {
    stopTunnels();
    await dashboard.stop();
    await close();
  }
}, 60_000);

test("task archive, restore and delete go through the running node; restore takes --here, --node or neither; the usage text lists them", async () => {
  const usage = Bun.spawn(["bun", "run", "src/cli.ts"], { env: await env(), stdout: "pipe", stderr: "pipe" });
  const [err] = await Promise.all([new Response(usage.stderr).text(), usage.exited]);
  const lines = err.split("\n").map((l) => l.trim());
  expect(lines).toContain("meddle task archive <id> | meddle task delete <id>");
  expect(lines).toContain("meddle task restore <id> [--node <id|prefix> | --here]");

  const { A, B, close } = await twoPoolNodes();
  const dashboard = await startDashboard({ ...A.cfg, port: 0 }, A.host, A.pool);
  try {
    const m = await createTask(A, { title: "t", projectIds: [A.project.id] });
    const port = new URL(dashboard.url).port;
    const run = (args: string[]) => meddle(["task", ...args], { HOME: A.home, MEDDLE_PORT: port });
    const label = (id: string) => `${shortId(id)} (${A.store.row(id)!.hostname})`;
    const refused = await run(["delete", m.id]);
    expect(refused).toMatchObject({ stdout: "", code: 1 });
    expect(refused.stderr).toContain("task is idle");
    expect((await run(["restore", m.id, "--here", "--node", B.id])).code).toBe(2);
    expect(await run(["archive", m.id])).toEqual({ stdout: `archived ${m.id}\n`, stderr: "", code: 0 });
    expect(getTask(A.db, m.id)).toMatchObject({ state: "archived", archived_on: A.id });
    expect(await run(["restore", m.id, "--here"])).toEqual({ stdout: `task ${m.id} on ${label(A.id)}\n`, stderr: "", code: 0 });
    expect(getTask(A.db, m.id)).toMatchObject({ state: "idle", archived_on: null });
    // Neither: placement picks the project's home, this node.
    expect(await run(["archive", m.id])).toEqual({ stdout: `archived ${m.id}\n`, stderr: "", code: 0 });
    expect(await run(["restore", m.id])).toEqual({ stdout: `task ${m.id} on ${label(A.id)}\n`, stderr: "", code: 0 });
    expect(await run(["archive", m.id])).toEqual({ stdout: `archived ${m.id}\n`, stderr: "", code: 0 });
    expect(await run(["delete", m.id])).toEqual({ stdout: `deleted ${m.id}\n`, stderr: "", code: 0 });
    expect(getTask(A.db, m.id)).toBeNull();

    // On another node, named by a prefix: the move starts and the node runs it.
    const n = await createTask(A, { title: "u", projectIds: [A.project.id] });
    expect(await run(["archive", n.id])).toEqual({ stdout: `archived ${n.id}\n`, stderr: "", code: 0 });
    expect(await run(["restore", n.id, "--node", B.id.slice(0, 10)])).toEqual({ stdout: `restoring to ${label(B.id)}\n`, stderr: "", code: 0 });
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

test("ids resolve by a unique prefix, and each id's shortest unique prefix is what the CLI highlights", async () => {
  const { resolveId, uniquePrefixLengths } = await import("../src/pool/ids");
  const { highlightId, table } = await import("../src/ansi");
  const ids = ["e98d79415f8e", "e98a00000000", "164ff3e5ed00"];
  expect(resolveId(ids, "e98d", "task")).toBe("e98d79415f8e");
  expect(resolveId(ids, "1", "task")).toBe("164ff3e5ed00");
  expect(() => resolveId(ids, "e98", "task")).toThrow("ambiguous task: e98 (e98a00000000, e98d79415f8e)");
  expect(() => resolveId(ids, "f", "task")).toThrow("no such task: f");
  const lengths = uniquePrefixLengths(ids);
  expect(Object.fromEntries(lengths)).toEqual({ "e98d79415f8e": 4, "e98a00000000": 4, "164ff3e5ed00": 1 });
  // Each highlighted prefix resolves to its id.
  for (const [id, n] of lengths) expect(resolveId(ids, id.slice(0, n), "task")).toBe(id);
  expect(Object.fromEntries(uniquePrefixLengths(["abc"]))).toEqual({ abc: 1 });
  expect(highlightId("e98d79415f8e", 4, false)).toBe("e98d79415f8e");
  expect(highlightId("e98d79415f8e", 4, true)).toBe("\x1b[1;35me98d\x1b[22;39m79415f8e");
  // Coloured cells line up by what they show.
  expect(table(["A", "B"], [[highlightId("abc", 1, true), "x"], ["abcdef", "y"]], false)).toEqual(["A       B", "\x1b[1;35ma\x1b[22;39mbc     x", "abcdef  y"]);
});

test("a project is named by its id, its name, or a unique prefix of its id", async () => {
  const { resolveProject } = await import("../src/pool/projects");
  const projects = [
    { id: "aaaa11112222", name: "alpha", home: "h", holders: [] },
    { id: "aaab33334444", name: "beta", home: "h", holders: [] },
    { id: "cccc55556666", name: "aaaa", home: "h", holders: [] },
  ];
  expect(resolveProject(projects, "aaaa1")).toBe("aaaa11112222");
  expect(resolveProject(projects, "c")).toBe("cccc55556666");
  // A name wins over a prefix.
  expect(resolveProject(projects, "aaaa")).toBe("cccc55556666");
  expect(() => resolveProject(projects, "aaa")).toThrow("ambiguous project: aaa (aaaa11112222, aaab33334444)");
  expect(() => resolveProject(projects, "zz")).toThrow("unknown project: zz");
});

test("project remove names a project of the pool or a removed one, and refuses a prefix that starts both", async () => {
  const { resolveRemovable } = await import("../src/pool/projects");
  const projects = [
    { id: "aaaa11112222", name: "alpha", home: "h", holders: [] },
    { id: "cccc55556666", name: "aaab", home: "h", holders: [] },
  ];
  const removed = [
    { id: "aaab33334444", name: "beta", removedAt: "2026-11-23T10:00:00.000Z", removedBy: "n" },
    { id: "dddd77778888", name: "delta", removedAt: "2026-11-23T10:00:00.000Z", removedBy: "n" },
    { id: "dddd99990000", name: "delta2", removedAt: "2026-11-23T10:00:00.000Z", removedBy: "n" },
  ];
  // A live project names itself: its tasks are checked.
  expect(resolveRemovable(projects, removed, "alpha")).toEqual({ id: "aaaa11112222", name: "alpha" });
  expect(resolveRemovable(projects, removed, "aaaa11112222")).toEqual({ id: "aaaa11112222", name: "alpha" });
  expect(resolveRemovable(projects, removed, "aaaa1")).toEqual({ id: "aaaa11112222", name: "alpha" });
  // A removed one by its id or a prefix of it alone: no name, nothing to check.
  expect(resolveRemovable(projects, removed, "aaab33334444")).toEqual({ id: "aaab33334444", name: undefined });
  expect(resolveRemovable(projects, removed, "aaab3")).toEqual({ id: "aaab33334444", name: undefined });
  // A name wins over a prefix, as `resolveProject` has it.
  expect(resolveRemovable(projects, removed, "aaab")).toEqual({ id: "cccc55556666", name: "aaab" });
  // A prefix that starts a live id and a removed one, or two removed ones, is ambiguous.
  expect(() => resolveRemovable(projects, removed, "aaa")).toThrow("ambiguous project: aaa (aaaa11112222, aaab33334444)");
  expect(() => resolveRemovable(projects, removed, "dddd")).toThrow("ambiguous project: dddd (dddd77778888, dddd99990000)");
  // An id the roster does not list yet passes through for the node to ask the members.
  expect(resolveRemovable(projects, removed, "0123456789ab")).toEqual({ id: "0123456789ab", name: undefined });
  expect(() => resolveRemovable(projects, removed, "zz")).toThrow("unknown project: zz");
  // A project the roster still lists once removed: removed, nothing to check.
  expect(resolveRemovable([...projects, { id: "aaab33334444", name: "beta", home: "h", holders: [] }], removed, "beta"))
    .toEqual({ id: "aaab33334444", name: undefined });
});

/**
 * One pool node serving the CLI, with a checkout `co` of its project `a` cloned from it: `main` (P) there, then C (a
 * change with content on P) under the checkout's `@`, an empty change. `cli` runs `meddle` in the checkout.
 */
async function checkoutNode() {
  const { jj } = await import("../src/jj");
  const { makeCheckout } = await import("../src/projects/checkouts");
  const { nodes, close } = await poolNodes(1);
  const n = nodes[0]!;
  const dashboard = await startDashboard({ ...n.cfg, port: 0 }, n.host, n.pool);
  const port = new URL(dashboard.url).port;
  const PATH = withHelper(n);
  const co = await makeCheckout(n.cfg, n.id, n.project, `${n.home}/co`, { PATH });
  const run = (args: string[]) => jj(args, co, n.cfg);
  const read = async (rev: string, template = "commit_id") => (await run(["log", "--ignore-working-copy", "-r", rev, "--no-graph", "-T", template])).trim();
  await writeFile(`${co}/c`, "c\n");
  await run(["commit", "-m", "C"]);
  const cli = (args: string[]) => meddle(args, { HOME: n.home, MEDDLE_DATA_DIR: n.cfg.dataDir, MEDDLE_PORT: port, PATH }, co);
  return {
    n, co, cli, run, read, P: await read("main"), C: await read("@-"), Cid: await read("@-", "change_id.short(12)"),
    close: async () => { await dashboard.stop(); await close(); },
  };
}

/** The id `task new` printed. */
const taskIdOf = (stdout: string) => /task (\S+) on/.exec(stdout)![1]!;

/** A manifest's bases, by project name. */
const basesOf = (n: GitPoolNode, id: string) =>
  (JSON.parse(getTask(n.db, id)!.manifest) as { projects: Array<{ name: string; base: string[] }> }).projects.map((p) => [p.name, p.base]);

test("task new in a checkout starts on the fork point of its @, which is immutable in the checkout when the command returns", async () => {
  const c = await checkoutNode();
  try {
    expect(await c.read(`${c.C} & immutable()`)).toBe("");
    const out = await c.cli(["task", "new", "--title", "t", "--project", "a", "--here"]);
    expect(out.stderr).toBe("");
    expect(out.code).toBe(0);
    const id = taskIdOf(out.stdout);
    expect(basesOf(c.n, id)).toEqual([["a", [c.C]]]);
    // The task's line, fetched back: C is read-only in the checkout now.
    expect(await c.read(`${c.C} & immutable()`)).toBe(c.C);
    expect(await c.read(`meddle/task/${id}/a@meddle`)).toBe(c.C);
    // On the node, the task's workspace is a new change on C.
    const { jj } = await import("../src/jj");
    expect(await jj(["log", "--ignore-working-copy", "-r", "@-", "--no-graph", "-T", "commit_id"], `${paths(c.n.cfg).task(id)}/a`, c.n.cfg)).toBe(c.C);
  } finally {
    await c.close();
  }
}, 60_000);

test("task new --edit W in a checkout whose @ is an empty child of W: @ moves onto W's parents, and the start's base is W's parents", async () => {
  const c = await checkoutNode();
  try {
    const out = await c.cli(["task", "new", "--title", "t", "--project", "a", "--rev", c.C, "--edit", "--here"]);
    expect(out.stderr).toBe("");
    expect(out.code).toBe(0);
    expect(out.stdout).toStartWith(`moved your empty @ off ${c.Cid}\n`);
    const id = taskIdOf(out.stdout);
    expect(basesOf(c.n, id)).toEqual([["a", [c.P]]]);
    expect(await c.read("@-")).toBe(c.P);
    expect(await c.read("@ & empty()", "change_id")).not.toBe("");
    expect(await c.read(`${c.C} & immutable()`)).toBe(c.C);
    expect(await c.read(`meddle/task/${id}/a@meddle`)).toBe(c.C);
  } finally {
    await c.close();
  }
}, 60_000);

test("task new --edit W in a checkout: refused while W is the checkout's @ with changes, and while W has another child", async () => {
  const c = await checkoutNode();
  try {
    // @ is W itself, with changes.
    await c.run(["edit", c.C]);
    await writeFile(`${c.co}/more`, "more\n");
    const wc = await c.cli(["task", "new", "--title", "t", "--project", "a", "--rev", "@", "--edit", "--here"]);
    expect(wc.code).toBe(1);
    const W = await c.read("@", "change_id.short(12)");
    expect(wc.stderr).toBe(`meddle: project a: ${W} is default's working copy; move off it first\n`);

    // W with a child D (content), and @ an empty change on D.
    await c.run(["new", "-m", "D"]);
    await writeFile(`${c.co}/d`, "d\n");
    await c.run(["new"]);
    const top = await c.cli(["task", "new", "--title", "t", "--project", "a", "--rev", W, "--edit", "--here"]);
    expect(top.code).toBe(1);
    expect(top.stderr).toBe(`meddle: project a: ${W} has revisions on top of it\n`);
    expect(listTasks(c.n.db)).toEqual([]);
  } finally {
    await c.close();
  }
}, 60_000);

test("task new in a checkout with no --project is a task of the checkout's project, started from its @'s fork point", async () => {
  const c = await checkoutNode();
  try {
    const out = await c.cli(["task", "new", "--title", "t", "--here"]);
    expect(out.stderr).toBe("");
    expect(out.code).toBe(0);
    const id = taskIdOf(out.stdout);
    expect(basesOf(c.n, id)).toEqual([["a", [c.C]]]);
    expect(await c.read(`meddle/task/${id}/a@meddle`)).toBe(c.C);
  } finally {
    await c.close();
  }
}, 60_000);

test("task new in a checkout with --rev and --edit but no --project starts the checkout's project there; outside one it is a usage error", async () => {
  const c = await checkoutNode();
  try {
    const child = await c.cli(["task", "new", "--title", "t", "--rev", "main", "--here"]);
    expect(child.stderr).toBe("");
    expect(child.code).toBe(0);
    expect(basesOf(c.n, taskIdOf(child.stdout))).toEqual([["a", [c.P]]]);

    const edit = await c.cli(["task", "new", "--title", "t", "--rev", c.C, "--edit", "--here"]);
    expect(edit.stderr).toBe("");
    expect(edit.code).toBe(0);
    expect(edit.stdout).toStartWith(`moved your empty @ off ${c.Cid}\n`);
    const id = taskIdOf(edit.stdout);
    expect(basesOf(c.n, id)).toEqual([["a", [c.P]]]);
    expect(await c.read(`meddle/task/${id}/a@meddle`)).toBe(c.C);

    // --edit alone still needs --rev.
    const noRev = await c.cli(["task", "new", "--title", "t", "--edit", "--here"]);
    expect(noRev.code).toBe(2);
    expect(noRev.stderr).toBe("meddle: --edit needs --rev\n");
  } finally {
    await c.close();
  }
}, 60_000);

test("project status prints each branch: its commit, or a conflicted one's siblings and how to resolve it", async () => {
  const { git } = await import("../src/jj");
  const { listBranchRows, mergeBranchRows, settleBranchRows, writeBranchRow } = await import("../src/pool/rows");
  const { nodes, close } = await poolNodes(1);
  const n = nodes[0]!;
  const dashboard = await startDashboard({ ...n.cfg, port: 0 }, n.host, n.pool);
  try {
    const repo = n.project.replica;
    const main = listBranchRows(n.db, n.project.id, "main")[0]!.commit!;
    // Two commits on main, pushed as `feature` on two nodes that could not see each other.
    const commit = async (message: string) => (await git(["commit-tree", `${main}^{tree}`, "-p", main, "-m", message], repo, n.cfg)).trim();
    const [x, y] = [await commit("x"), await commit("y")].sort() as [string, string];
    mergeBranchRows(n.db, [{ project: n.project.id, branch: "feature", node: "f".repeat(64), seq: 1, commit: y, drops: [] }]);
    settleBranchRows(n.db, n.project.id, new Set([main, y]));
    writeBranchRow(n.db, n.id, { project: n.project.id, branch: "feature", commit: x, drops: [] });
    const out = await meddle(["project", "status", n.project.name], { HOME: n.home, MEDDLE_DATA_DIR: n.cfg.dataDir, MEDDLE_PORT: new URL(dashboard.url).port });
    expect(out.stderr).toBe("");
    expect(out.code).toBe(0);
    expect(out.stdout).toBe([
      `main  ${main.slice(0, 12)} (default)`,
      `feature  conflicted, at its siblings' merge base ${main.slice(0, 12)}`,
      "feature is conflicted; push a merge of its siblings, or delete the ones you don't want",
      `  meddle/conflict/feature/${x.slice(0, 12)}@meddle`,
      `  meddle/conflict/feature/${y.slice(0, 12)}@meddle`,
      "  to keep your own work: jj bookmark set feature -r <your commit>",
      "",
    ].join("\n"));
  } finally {
    await dashboard.stop();
    await close();
  }
}, 60_000);

/** Gives the task a file to land: written in its workspace of the project, then to the line's row. */
async function withFile(node: GitPoolNode, taskId: string, name: string): Promise<void> {
  await writeFile(`${paths(node.cfg).task(taskId)}/${node.project.name}/${name}`, `${name}\n`);
  await node.runner.writeTaskLines(taskId);
}

test("task accept and task unqueue take several tasks, on any node; train prints the queue at the project's home and pauses and resumes it", async () => {
  const { acceptDashboardStreams } = await import("../src/dashboard/tunnel");
  const { A, B, close } = await twoPoolNodes();
  // No round of the conductor takes the tasks queued here.
  for (const n of [A, B]) pauseTrain(n.db, n.project.id, "held by the test");
  const dashboard = await startDashboard({ ...A.cfg, port: 0 }, A.host, A.pool);
  // As `serve` does: B serves its objects to members' dashboards (and so to A's CLI) over the pool.
  const stopTunnels = acceptDashboardStreams(B.net, B.host, (id) => B.store.isMember(id));
  try {
    await peerReady(A, B);
    const env = { HOME: A.home, MEDDLE_DATA_DIR: A.cfg.dataDir, MEDDLE_PORT: new URL(dashboard.url).port };
    const run = (...args: string[]) => meddle(args, env);
    const one = await createTask(A, { title: "Add a.txt", projectIds: [A.project.id] });
    const two = await createTask(A, { title: "Add b.txt", projectIds: [A.project.id] });
    const bare = await createTask(A, { title: "Nothing to add", projectIds: [A.project.id] });
    const onB = await createTask(B, { title: "Add c.txt", projectIds: [B.project.id] });
    await withFile(A, one.id, "a.txt");
    await withFile(A, two.id, "b.txt");
    await withFile(B, onB.id, "c.txt");

    // Several tasks, named by an id or a prefix; one of another node, acted on at the node holding it.
    expect(await run("task", "accept", one.id, two.id.slice(0, 8))).toEqual({
      stdout: `queued ${one.id} on a's train\nqueued ${two.id} on a's train\n`, stderr: "", code: 0,
    });
    expect(await run("task", "accept", onB.id.slice(0, 8))).toEqual({ stdout: `queued ${onB.id} on a's train\n`, stderr: "", code: 0 });
    // Accepting a queued task changes nothing, and says the same.
    expect(await run("task", "accept", one.id)).toEqual({ stdout: `queued ${one.id} on a's train\n`, stderr: "", code: 0 });
    // A refusal is the task's own, with `meddle: ` before it; with several tasks the task it is for goes before it, the
    // others are still accepted, and the exit status says one failed.
    expect(await run("task", "accept", bare.id)).toEqual({
      stdout: "", stderr: "meddle: nothing to land: the task's work is already on main\n", code: 1,
    });
    expect(await run("task", "accept", bare.id, "zzzz", one.id)).toEqual({
      stdout: `queued ${one.id} on a's train\n`,
      stderr: `meddle: ${bare.id}: nothing to land: the task's work is already on main\nmeddle: zzzz: no such task: zzzz\n`,
      code: 1,
    });

    // The queue as the project's home has it, while it is paused: A's project here, B's through the tunnel.
    const home = { paused: "paused: held by the test" };
    expect(await run("train", A.project.id)).toEqual({
      stdout: `${home.paused}\nqueued:\n  Add a.txt (${one.id})  queued\n  Add b.txt (${two.id})  queued\n`, stderr: "", code: 0,
    });
    expect(await run("train", B.project.id)).toEqual({
      stdout: `${home.paused}\nqueued:\n  Add c.txt (${onB.id})  queued\n`, stderr: "", code: 0,
    });
    // Two projects (both named a), none named, and this folder no checkout: the command asks which.
    const ask = await run("train");
    expect(ask).toMatchObject({ stdout: "", code: 1 });
    expect(ask.stderr).toStartWith("meddle: name a project: a (");
    expect((await run("train", "nosuch")).stderr).toBe("meddle: unknown project: nosuch\n");

    // Unqueue takes tasks off; one not queued stays as it is, and says so.
    expect(await run("task", "unqueue", one.id, bare.id)).toEqual({ stdout: `unqueued ${one.id}\n${bare.id} is not queued\n`, stderr: "", code: 0 });
    expect(await run("task", "unqueue", "zzzz")).toEqual({ stdout: "", stderr: "meddle: no such task: zzzz\n", code: 1 });
    expect(await run("train", A.project.id)).toMatchObject({ stdout: `${home.paused}\nqueued:\n  Add b.txt (${two.id})  queued\n` });

    // Pause and resume go to the home too, A's here and B's through the tunnel; pausing changes a pause's reason.
    expect(await run("task", "unqueue", two.id, onB.id)).toMatchObject({ code: 0 });
    for (const project of [A.project.id, B.project.id]) {
      expect(await run("train", "pause", project)).toEqual({ stdout: "paused a's train\n", stderr: "", code: 0 });
      expect(await run("train", project)).toEqual({ stdout: "paused: you paused it\nnothing queued\n", stderr: "", code: 0 });
      expect(await run("train", "resume", project)).toEqual({ stdout: "resumed a's train\n", stderr: "", code: 0 });
      expect(await run("train", project)).toEqual({ stdout: "nothing queued\n", stderr: "", code: 0 });
    }
  } finally {
    stopTunnels();
    await dashboard.stop();
    await close();
  }
}, 90_000);

test("train says when the project's home is offline: its train waits for it, and nothing is asked of it", async () => {
  const { A, B, close } = await twoPoolNodes();
  const dashboard = await startDashboard({ ...A.cfg, port: 0 }, A.host, A.pool);
  try {
    await peerReady(A, B);
    const env = { HOME: A.home, MEDDLE_DATA_DIR: A.cfg.dataDir, MEDDLE_PORT: new URL(dashboard.url).port };
    await B.pool.stop();
    const deadline = Date.now() + 20_000;
    while (A.net.isOnline(B.id)) {
      if (Date.now() > deadline) throw new Error("A still sees B online");
      await Bun.sleep(50);
    }
    const label = `${shortId(B.id)} (${A.store.row(B.id)!.hostname})`;
    for (const args of [["train", B.project.id], ["train", B.project.id, "--follow"], ["train", "pause", B.project.id], ["train", "resume", B.project.id]]) {
      expect({ args, ...(await meddle(args, env)) }).toEqual({
        args, stdout: "", stderr: `meddle: a's train waits: its home ${label} is offline\n`, code: 1,
      });
    }
    // This node's own project is another matter.
    expect(await meddle(["train", A.project.id], env)).toMatchObject({ stdout: expect.stringContaining("nothing queued"), code: 0 });
  } finally {
    await dashboard.stop();
    await close();
  }
}, 60_000);

/**
 * What a node of a meddle older than the train serves of `TaskObject` (no `queue`, `accept` or `unqueue`) and of
 * `ProjectObject` (no `train`, `pause`, `resume` or `retry`), with the node's own `NodeObject` listing `taskIds`: a host
 * that stands for B at the end of A's tunnel. Chord refuses to bind a client built with the train's members to it before
 * anything is served, so the two older objects have no factory worth running.
 */
async function olderNodeHost(taskIds: string[]) {
  const { createHost, remote } = await import("@earendil-works/chord");
  const { NodeObject, ProjectObject, TaskObject } = await import("../src/state/contracts");
  const { Value } = await import("typebox/value");
  const without = <T extends Record<string, unknown>>(members: T, names: string[]) =>
    Object.fromEntries(Object.entries(members).filter(([name]) => !names.includes(name)));
  const task = TaskObject.def.variants.default;
  const project = ProjectObject.def.variants.default;
  const OlderTask = remote("meddle.task", {
    ...TaskObject.def, variants: { default: { state: without(task.state, ["queue"]), methods: without(task.methods, ["accept", "unqueue"]) } },
  } as never);
  const OlderProject = remote("meddle.project", {
    ...ProjectObject.def, variants: { default: { state: without(project.state, ["train"]), methods: without(project.methods, ["pause", "resume", "retry"]) } },
  } as never);
  const host = createHost({ name: "node", self: "node" });
  // The node's own object, as it is: every state member a value its schema takes, `taskIds` the ones given.
  host.serve(NodeObject, (_input, _principal, self) => ({
    variant: "default",
    ...Object.fromEntries(Object.entries(NodeObject.def.variants.default.state).map(([name, schema]) => [
      name, self.state(name, schema as never, { init: () => (name === "taskIds" ? taskIds : Value.Create(schema as never)) as never }),
    ])),
    ...Object.fromEntries(Object.keys(NodeObject.def.variants.default.methods).map((name) => [name, () => { throw new Error(name); }])),
  }) as never);
  const never = () => { throw new Error("not bound"); };
  host.serve(OlderTask, never as never);
  host.serve(OlderProject, never as never);
  return host;
}

test("a task on a node older than the train is not found, and the refusal names that node; train at an older home says so", async () => {
  const { acceptDashboardStreams } = await import("../src/dashboard/tunnel");
  const { A, B, close } = await twoPoolNodes();
  const dashboard = await startDashboard({ ...A.cfg, port: 0 }, A.host, A.pool);
  const onB = await createTask(B, { title: "Add c.txt", projectIds: [B.project.id] });
  const older = await olderNodeHost([onB.id]);
  // B's tunnel is served by what an older B would serve.
  const stopTunnels = acceptDashboardStreams(B.net, older, (id) => B.store.isMember(id));
  try {
    await peerReady(A, B);
    const env = { HOME: A.home, MEDDLE_DATA_DIR: A.cfg.dataDir, MEDDLE_PORT: new URL(dashboard.url).port };
    const label = `${shortId(B.id)} (${A.store.row(B.id)!.hostname})`;
    const unlisted = `${label} runs an older meddle: its tasks are not listed`;
    for (const verb of ["accept", "unqueue"]) {
      expect(await meddle(["task", verb, onB.id], env)).toEqual({ stdout: "", stderr: `meddle: no such task: ${onB.id} (${unlisted})\n`, code: 1 });
    }
    // With several, the task it is for goes before it, as for any refusal; a task here is still taken.
    const here = await createTask(A, { title: "Add a.txt", projectIds: [A.project.id] });
    await withFile(A, here.id, "a.txt");
    pauseTrain(A.db, A.project.id, "held by the test");
    expect(await meddle(["task", "accept", onB.id, here.id], env)).toEqual({
      stdout: `queued ${here.id} on a's train\n`, stderr: `meddle: ${onB.id}: no such task: ${onB.id} (${unlisted})\n`, code: 1,
    });
    // `task list` says the same of that node, and lists the others'.
    const list = await meddle(["task", "list"], env);
    expect(list.stderr).toBe(`${unlisted}\n`);
    expect(list.stdout).toContain(here.id);

    // Its project's train cannot be asked of it either: the home is named, by its hostname.
    expect(await meddle(["train", B.project.id], env)).toEqual({
      stdout: "", stderr: `meddle: ${A.store.row(B.id)!.hostname} runs an older meddle\n`, code: 1,
    });
    expect(await meddle(["train", "pause", B.project.id], env)).toMatchObject({ stdout: "", code: 1 });
  } finally {
    stopTunnels();
    await older.close();
    await dashboard.stop();
    await close();
  }
}, 60_000);

test("train --follow prints the train as it changes and ends once its queue is empty; with nothing queued it ends at once", async () => {
  const { nodes, close } = await poolNodes(1);
  const A = nodes[0]!;
  pauseTrain(A.db, A.project.id, "held by the test");
  const dashboard = await startDashboard({ ...A.cfg, port: 0 }, A.host, A.pool);
  let proc: { kill(): void } | undefined;
  try {
    const env = { HOME: A.home, MEDDLE_DATA_DIR: A.cfg.dataDir, MEDDLE_PORT: new URL(dashboard.url).port };
    const idle = await meddle(["train", "--follow"], env);
    expect(idle).toEqual({ stdout: "paused: held by the test\nnothing queued\n", stderr: "", code: 0 });

    const m = await createTask(A, { title: "Add a.txt", projectIds: [A.project.id] });
    await withFile(A, m.id, "a.txt");
    expect(await meddle(["task", "accept", m.id], env)).toMatchObject({ code: 0 });
    const follower = Bun.spawn(["bun", "run", `${repoRoot}/src/cli.ts`, "train", "--follow"], {
      cwd: repoRoot, env: childEnv(env), stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    proc = follower;
    // It prints the queue and waits for it to change.
    const reader = follower.stdout.getReader();
    const decoder = new TextDecoder();
    let printed = "";
    const readUntil = async (done: (text: string) => boolean) => {
      const end = Date.now() + 20_000;
      while (!done(printed)) {
        const next = await Promise.race([reader.read(), Bun.sleep(Math.max(0, end - Date.now())).then(() => null)]);
        if (next === null) throw new Error(`timed out; it printed ${JSON.stringify(printed)}`);
        if (next.done) return;
        printed += decoder.decode(next.value, { stream: true });
      }
    };
    await readUntil((text) => text.includes("Add a.txt"));
    expect(follower.exitCode).toBeNull();
    expect(await meddle(["task", "unqueue", m.id], env)).toEqual({ stdout: `unqueued ${m.id}\n`, stderr: "", code: 0 });
    await readUntil(() => false);
    expect(await Promise.race([follower.exited, Bun.sleep(20_000).then(() => "timeout" as const)])).toBe(0);
    expect(printed).toBe(`paused: held by the test\nqueued:\n  Add a.txt (${m.id})  queued\n\npaused: held by the test\nnothing queued\n`);
    expect(await new Response(follower.stderr).text()).toBe("");
  } finally {
    proc?.kill();
    await dashboard.stop();
    await close();
  }
}, 90_000);

test("task accept, task unqueue and train pause or resume are refused while an update awaits confirmation; watching the train is not", async () => {
  const dir = await mkdtemp("/tmp/meddle-train-cli-");
  try {
    const env = { HOME: dir, MEDDLE_DATA_DIR: `${dir}/d`, MEDDLE_TASK_ROOT: `${dir}/t`, MEDDLE_PORT: String(await closedPort()) };
    await mkdir(`${dir}/d`, { recursive: true });
    const build = "1ee71ee71ee7";
    await writePending(updateFiles(`${dir}/d`, "/unused"), {
      v: 1, phase: "swapped", rollout: "r1", build, previousBuild: "0ld0ld0ld0ld", platform: "linux-x64", swappedAt: Date.now(),
      healthMs: 120_000, starts: 1, healthy: false, late: false,
    });
    for (const args of [["task", "accept", "0012", "0034"], ["task", "unqueue", "0012"], ["train", "pause"], ["train", "resume", "site"]]) {
      expect({ args, ...(await meddle(args, env)) }).toEqual({
        args, stdout: "", stderr: `meddle: update in progress (build ${build}), try again shortly\n`, code: 1,
      });
    }
    // Reads go on: with no node running they say so, as any command that talks to one does.
    for (const args of [["train"], ["train", "site"], ["train", "--follow"]]) {
      expect({ args, ...(await meddle(args, env)) }).toEqual({ args, stdout: "", stderr: 'meddle: start "meddle serve" first\n', code: 1 });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);

test("project remove removes and prints the project", async () => {
  const dir = await mkdtemp("/tmp/meddle-cli-");
  await mkdir(`${dir}/t`, { recursive: true });
  for (const name of ["one", "two", "busy"]) {
    await initColocated(`${dir}/${name}`);
    await writeFile(`${dir}/${name}/README`, `${name}\n`);
    await jj(["commit", "-m", "init"], `${dir}/${name}`);
    await jj(["bookmark", "set", "main", "-r", "@-"], `${dir}/${name}`);
  }
  const base = {
    HOME: dir,
    MEDDLE_DATA_DIR: `${dir}/d`,
    MEDDLE_TASK_ROOT: `${dir}/t`,
    MEDDLE_CLAUDE_PATH: replay,
    MEDDLE_CLAUDE_RUNTIME: "bun",
    MEDDLE_FIXTURE: `${import.meta.dir}/fixtures/hello.jsonl`,
    ...POOL_ENV,
  };
  await writeFile(`${dir}/token`, "tok\n");
  expect((await meddle(["token", "set", "--file", `${dir}/token`], { ...base, MEDDLE_PORT: String(await closedPort()) })).code).toBe(0);
  const node = await startServe({ ...base, MEDDLE_PORT: "0" });
  const client = { ...base, MEDDLE_PORT: String(node.port) };
  try {
    const add = async (name: string) => (await meddle(["project", "add", `${dir}/${name}`, "--name", name], client)).stdout.trim();
    const [one, two, busy] = [await add("one"), await add("two"), await add("busy")];

    // By name: the line names it, and the list no longer does.
    expect(await meddle(["project", "remove", "one"], client)).toEqual({ stdout: `removed ${shortId(one)} (one)\n`, stderr: "", code: 0 });
    const listed = (await meddle(["project", "list"], client)).stdout;
    expect(listed).not.toContain(one);
    expect(listed).toContain(two);
    // By id, once removed: the same line, and nothing else happens.
    expect(await meddle(["project", "remove", one], client)).toEqual({ stdout: `removed ${shortId(one)} (one)\n`, stderr: "", code: 0 });
    expect(await meddle(["project", "remove", two], client)).toEqual({ stdout: `removed ${shortId(two)} (two)\n`, stderr: "", code: 0 });
    expect((await meddle(["project", "list"], client)).stdout).not.toContain(two);

    const unknown = await meddle(["project", "remove", "nope"], client);
    expect(unknown).toEqual({ stdout: "", stderr: "meddle: unknown project: nope\n", code: 1 });

    // A project a task that is not archived uses is refused, and removable once the task is archived.
    const created = await meddle(["task", "new", "--title", "t", "--project", busy], client);
    expect(created.stderr).toBe("");
    expect(created.code).toBe(0);
    const taskId = /^task (\S+) on/.exec(created.stdout)![1]!;
    const refused = await meddle(["project", "remove", "busy"], client);
    expect(refused).toEqual({ stdout: "", stderr: `meddle: project busy is used by ${taskId}\n`, code: 1 });
    expect((await meddle(["task", "archive", taskId], client)).code).toBe(0);
    expect((await meddle(["project", "remove", "busy"], client)).stdout).toBe(`removed ${shortId(busy)} (busy)\n`);

    expect((await meddle(["project", "remove"], client)).code).toBe(2);
  } finally {
    await node.stop();
    await rm(dir, { recursive: true, force: true });
  }
}, 120_000);

test("profile import makes a directory the pool's profile and prints the commit", async () => {
  const dir = await mkdtemp("/tmp/meddle-cli-");
  await mkdir(`${dir}/t`, { recursive: true });
  await mkdir(`${dir}/src/skills/babysit`, { recursive: true });
  await writeFile(`${dir}/src/CLAUDE.md`, "imported rules\n");
  await writeFile(`${dir}/src/skills/babysit/SKILL.md`, "babysit\n");
  const base = {
    HOME: dir, MEDDLE_DATA_DIR: `${dir}/d`, MEDDLE_TASK_ROOT: `${dir}/t`, MEDDLE_CLAUDE_PATH: replay, MEDDLE_CLAUDE_RUNTIME: "bun",
    MEDDLE_FIXTURE: `${import.meta.dir}/fixtures/hello.jsonl`, ...POOL_ENV,
  };
  const node = await startServe({ ...base, MEDDLE_PORT: "0" });
  const client = { ...base, MEDDLE_PORT: String(node.port) };
  try {
    const out = await meddle(["profile", "import", `${dir}/src`], client);
    expect(out.stderr).toBe("");
    expect(out.code).toBe(0);
    expect(out.stdout).toMatch(/^imported [0-9a-f]{12}\n$/);
    expect(await readFile(`${dir}/d/profile/CLAUDE.md`, "utf8")).toBe("imported rules\n");
    expect(await readFile(`${dir}/d/profile/skills/babysit/SKILL.md`, "utf8")).toBe("babysit\n");
  } finally {
    await node.stop();
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);
