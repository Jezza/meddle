// test/e2e.test.ts — one node end to end: `meddle serve` against the replayer, driven by the client subcommands.
import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { initColocated, jj } from "../src/jj";
import { shortId } from "../src/pool/ids";
import { tokenId } from "../src/token";
import { closedPort, errorResultFixture, meddle, replay, startServe } from "./helpers";
import { POOL_ENV } from "./pool-helpers";

/**
 * A temp home with a data dir, a created task root and a colocated jj repo, and the env a meddle child runs with; its
 * port is one nothing listens on, so a client command (`token set` tells a running node) never reaches a real node.
 */
async function home() {
  const dir = await mkdtemp("/tmp/meddle-e2e-");
  await mkdir(`${dir}/t`, { recursive: true });
  await initColocated(`${dir}/repo`);
  // A first commit, `@` empty on it: a task of the repo starts there.
  await writeFile(`${dir}/repo/README`, "repo\n");
  await jj(["commit", "-m", "init"], `${dir}/repo`);
  const env = {
    HOME: dir,
    MEDDLE_DATA_DIR: `${dir}/d`,
    MEDDLE_TASK_ROOT: `${dir}/t`,
    MEDDLE_CLAUDE_PATH: replay,
    MEDDLE_CLAUDE_RUNTIME: "bun",
    MEDDLE_FIXTURE: `${import.meta.dir}/fixtures/hello.jsonl`,
    ...POOL_ENV,
    MEDDLE_PORT: String(await closedPort()),
  };
  return { dir, env };
}

/** The task id `task new` printed (`task <id> on <node>`). */
function taskIdOf(out: { stdout: string }): string {
  const id = /^task (\S+) on \S+(?: \(.*\))?\n$/.exec(out.stdout)?.[1];
  if (id === undefined) throw new Error(`task new printed ${JSON.stringify(out.stdout)}`);
  return id;
}

test("serve, add a project, run a task's turn, and report status", async () => {
  const { dir, env } = await home();
  await writeFile(`${dir}/token`, "tok\n");
  const set = await meddle(["token", "set", "--file", `${dir}/token`], env);
  expect(set.code).toBe(0);

  const node = await startServe({ ...env, MEDDLE_PORT: "0" });
  const client = { ...env, MEDDLE_PORT: String(node.port) };
  let stopped = false;
  try {
    const added = await meddle(["project", "add", `${dir}/repo`, "--name", "repo"], client);
    expect(added.stderr).toBe("");
    expect(added.code).toBe(0);
    const projectId = added.stdout.trim();
    expect(projectId).toMatch(/^\S+$/);

    const listed = await meddle(["project", "list"], client);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toBe(`${projectId}  repo  home ${shortId(node.id)}  on ${shortId(node.id)}\n`);

    const created = await meddle(["task", "new", "--title", "t", "--project", projectId], client);
    expect(created.stderr).toBe("");
    expect(created.code).toBe(0);
    const [, taskId, on] = /^task (\S+) on (\S+)(?: \(.*\))?\n$/.exec(created.stdout) ?? [];
    expect(taskId).toMatch(/^\S+$/);
    expect(on).toBe(shortId(node.id));

    const prompted = await meddle(["task", "prompt", taskId, "Reply", "with", "the", "single", "word", "ok."], client);
    expect(prompted.code).toBe(0);
    const types = prompted.stderr.trim().split("\n");
    expect(types).toContain("system/init");
    expect(types.at(-1)).toBe("result/success");

    // nothing is parked, so there is nothing to retry (chord marks a method's own error `unavailable`)
    const retried = await meddle(["task", "retry", taskId], client);
    expect(retried.code).toBe(1);
    expect(retried.stderr).toBe(`meddle: no parked turn for task ${taskId}\n`);

    const page = await fetch(node.url);
    expect(page.status).toBe(200);
    await page.body?.cancel();

    const live = await meddle(["status"], client);
    expect(live.code).toBe(0);
    expect(live.stdout).toContain("tasks 1\n");

    stopped = true;
    expect(await node.stop()).toBe(0);
    expect(node.stderr()).toBe("");

    const status = await meddle(["status"], env);
    expect(status.stderr).toBe("");
    expect(status.code).toBe(0);
    const lines = status.stdout.trim().split("\n");
    expect(lines[0]).toMatch(/^meddle \d+\.\d+\.\d+$/);
    expect(lines[1]).toBe("claude code 2.1.314");
    expect(lines[2]).toBe(`data dir ${dir}/d`);
    expect(lines[3]).toBe(`task root ${dir}/t ok`);
    expect(lines[4]).toMatch(/^token present expires \d{4}-\d\d-\d\dT[\d:.]+Z$/);
    expect(lines[5]).toBe("tasks 1");
    expect(lines[6]).toBe(`node ${node.id}`);
    expect(lines[7]).toBe("pool (no secret set)");
    expect(lines).toHaveLength(8);
  } finally {
    if (!stopped) await node.stop();
  }
}, 60_000);

test("status before the first serve has no node and no pool, and creates neither", async () => {
  const { dir, env } = await home();
  const status = await meddle(["status"], env);
  expect(status.stderr).toBe("");
  expect(status.code).toBe(0);
  expect(status.stdout).toEndWith("tasks 0\nnode (none yet)\npool (none yet)\n");
  expect(existsSync(`${dir}/d/secrets/iroh.key`)).toBe(false);
  expect(existsSync(`${dir}/d/meddle.sqlite`)).toBe(false);
});

test("a client command without a running node asks for one", async () => {
  const { env } = await home();
  const free = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = free.port!;
  await free.stop(true);
  const result = await meddle(["project", "list"], { ...env, MEDDLE_PORT: String(port) });
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe('meddle: start "meddle serve" first\n');
});

test("task prompt follows a turn its token reruns to the rerun's success, and fails with the token's notice when none is left", async () => {
  const { dir, env } = await home();
  const byToken = `tok-a=${import.meta.dir}/fixtures/rate-limited.jsonl,tok-b=${import.meta.dir}/fixtures/hello.jsonl`;
  await writeFile(`${dir}/a`, "tok-a\n");
  await writeFile(`${dir}/b`, "tok-b\n");
  expect((await meddle(["token", "add", "--file", `${dir}/a`, "--label", "a"], env)).code).toBe(0);
  await Bun.sleep(5); // set later, so second in order
  expect((await meddle(["token", "add", "--file", `${dir}/b`, "--label", "b"], env)).code).toBe(0);
  const node = await startServe({ ...env, MEDDLE_PORT: "0", MEDDLE_FIXTURE_BY_TOKEN: byToken });
  const client = { ...env, MEDDLE_PORT: String(node.port) };
  try {
    const projectId = (await meddle(["project", "add", `${dir}/repo`], client)).stdout.trim();
    const taskId = taskIdOf(await meddle(["task", "new", "--title", "t", "--project", projectId], client));

    const prompted = await meddle(["task", "prompt", taskId, "Reply with the single word ok."], client);
    expect(prompted.stderr).not.toContain("meddle: ");
    expect(prompted.code).toBe(0);
    const lines = prompted.stderr.trim().split("\n");
    const fault = lines.indexOf("meddle/token_fault");
    expect(lines.slice(0, fault).filter((l) => l.startsWith("result"))).toEqual(["result/error_during_execution"]);
    expect(lines[fault + 1]).toBe("meddle/turn_started");
    expect(lines.slice(fault).filter((l) => l.startsWith("result"))).toEqual(["result/success"]);
    expect(lines.at(-1)).toBe("result/success");

    const listed = await meddle(["token", "list"], client);
    expect(listed.stdout).toMatch(/ {2}a {2}exhausted until 2100-01-01T00:00:00\.000Z \(five_hour\)/);

    // with a usable again and b gone, a fails the turn with no token to switch to: the token's notice is the error
    expect((await meddle(["token", "enable", "a"], client)).code).toBe(0);
    expect((await meddle(["token", "remove", "b"], client)).code).toBe(0);
    const stopped = await meddle(["task", "prompt", taskId, "Reply with the single word ok."], client);
    expect(stopped.code).toBe(1);
    expect(stopped.stderr).toEndWith(
      "result/error_during_execution\nmeddle/token_fault\nmeddle: the turn ended: token a exhausted until 2100-01-01T00:00:00.000Z; no other token\n",
    );
  } finally {
    await node.stop();
  }
}, 60_000);

test("task prompt to a busy task waits for the turn that takes its text, not the one running", async () => {
  const { dir, env } = await home();
  await writeFile(`${dir}/token`, "tok\n");
  expect((await meddle(["token", "set", "--file", `${dir}/token`], env)).code).toBe(0);
  // every turn takes a while to its result; hello's Claude Code never takes a steer, so the second text runs next
  const node = await startServe({ ...env, MEDDLE_PORT: "0", MEDDLE_FIXTURE_RESULTS_MS: "4000" });
  const client = { ...env, MEDDLE_PORT: String(node.port) };
  try {
    const projectId = (await meddle(["project", "add", `${dir}/repo`], client)).stdout.trim();
    const taskId = taskIdOf(await meddle(["task", "new", "--title", "t", "--project", projectId], client));
    const at = { first: 0, second: 0 };
    const first = meddle(["task", "prompt", taskId, "first"], client).then((r) => { at.first = Date.now(); return r; });
    await Bun.sleep(1_500); // well into the first turn, which takes 4 s to its result
    const second = await meddle(["task", "prompt", taskId, "second"], client);
    at.second = Date.now();
    expect((await first).code).toBe(0);
    expect(second.code).toBe(0);
    expect(second.stderr).toEndWith("result/success\n");
    // it followed its own turn, which takes another 4 s after the first one's result
    expect(at.second - at.first).toBeGreaterThan(3_000);
  } finally {
    await node.stop();
  }
}, 60_000);

test("task prompt fails fast when the turn fails", async () => {
  const { dir, env } = await home();
  await writeFile(`${dir}/token`, "tok\n");
  expect((await meddle(["token", "set", "--file", `${dir}/token`], env)).code).toBe(0);
  const node = await startServe({ ...env, MEDDLE_PORT: "0", MEDDLE_CLAUDE_PATH: `${dir}/no-such-claude` });
  const client = { ...env, MEDDLE_PORT: String(node.port) };
  try {
    const projectId = (await meddle(["project", "add", `${dir}/repo`], client)).stdout.trim();
    const taskId = taskIdOf(await meddle(["task", "new", "--title", "t", "--project", projectId], client));
    expect(taskId).toMatch(/^\S+$/);

    // the child never starts: the turn logs `turn_failed`, and its error is printed
    const prompted = await meddle(["task", "prompt", taskId, "hi"], client);
    expect(prompted.code).toBe(1);
    expect(prompted.stderr).toMatch(/meddle\/turn_failed\nmeddle: the turn failed: ReferenceError: Claude Code native binary not found at \S+\/no-such-claude\. .*\n$/);

    // no usable token: the turn fails before Claude Code starts, and still logs why
    await rm(`${dir}/d/secrets/tokens`, { recursive: true });
    const tokenless = await meddle(["task", "prompt", taskId, "hi"], client);
    expect(tokenless.code).toBe(1);
    expect(tokenless.stderr).toBe("meddle/token_fault\nmeddle/turn_failed\nmeddle: the turn failed: Error: no usable token\n");
  } finally {
    await node.stop();
  }
}, 30_000);

test("task prompt fails when the turn's result is an error", async () => {
  const { dir, env } = await home();
  await writeFile(`${dir}/token`, "tok\n");
  expect((await meddle(["token", "set", "--file", `${dir}/token`], env)).code).toBe(0);
  const node = await startServe({ ...env, MEDDLE_PORT: "0", MEDDLE_FIXTURE: await errorResultFixture("error_max_turns") });
  const client = { ...env, MEDDLE_PORT: String(node.port) };
  try {
    const projectId = (await meddle(["project", "add", `${dir}/repo`], client)).stdout.trim();
    const taskId = taskIdOf(await meddle(["task", "new", "--title", "t", "--project", projectId], client));
    const prompted = await meddle(["task", "prompt", taskId, "hi"], client);
    expect(prompted.code).toBe(1);
    expect(prompted.stderr).toEndWith("result/error_max_turns\nmeddle: the turn ended with error_max_turns\n");
  } finally {
    await node.stop();
  }
}, 30_000);

test("serve exits 1 when its port is taken", async () => {
  const { env } = await home();
  const taken = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  try {
    const result = await meddle(["serve"], { ...env, MEDDLE_PORT: String(taken.port) });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toStartWith("meddle: ");
  } finally {
    await taken.stop(true);
  }
}, 30_000);

test("serve imports the single token of an older meddle as the token labelled default, once", async () => {
  const { dir, env } = await home();
  await mkdir(`${dir}/d/secrets`, { recursive: true, mode: 0o700 });
  await writeFile(`${dir}/d/secrets/claude-token`, "tok-legacy\n", { mode: 0o600 });
  await writeFile(`${dir}/d/secrets/claude-token.meta.json`, JSON.stringify({ setAt: "2026-10-31T10:00:00.000Z", setBy: null }), { mode: 0o600 });
  const node = await startServe({ ...env, MEDDLE_PORT: "0" });
  const id = tokenId("tok-legacy");
  try {
    const listed = await meddle(["token", "list"], env);
    expect(listed).toEqual({ stdout: `${id}  default  ok  expires 2027-10-31T10:00:00.000Z\nactive: ${id}\n`, stderr: "", code: 0 });
    expect(existsSync(`${dir}/d/secrets/claude-token`)).toBe(false);
    expect(existsSync(`${dir}/d/secrets/claude-token.migrated`)).toBe(false);
    expect(existsSync(`${dir}/d/secrets/claude-token.meta.json.migrated`)).toBe(true);
  } finally {
    expect(await node.stop()).toBe(0);
  }
  expect(node.stderr()).toBe("");
}, 30_000);
