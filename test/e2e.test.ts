// test/e2e.test.ts — one node end to end: `meddle serve` against the replayer, driven by the client subcommands.
import { test, expect } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { initColocated } from "../src/jj";
import { errorResultFixture, meddle, replay, startServe } from "./helpers";

/** A temp home with a data dir, a created task root and a colocated jj repo, and the env a meddle child runs with. */
async function home() {
  const dir = await mkdtemp("/tmp/meddle-e2e-");
  await mkdir(`${dir}/t`, { recursive: true });
  await initColocated(`${dir}/repo`);
  const env = {
    HOME: dir,
    MEDDLE_DATA_DIR: `${dir}/d`,
    MEDDLE_TASK_ROOT: `${dir}/t`,
    MEDDLE_CLAUDE_PATH: replay,
    MEDDLE_CLAUDE_RUNTIME: "bun",
    MEDDLE_FIXTURE: `${import.meta.dir}/fixtures/hello.jsonl`,
  };
  return { dir, env };
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
    expect(listed.stdout).toBe(`${projectId}  repo  ${dir}/repo\n`);

    const created = await meddle(["task", "new", "--title", "t", "--project", projectId], client);
    expect(created.stderr).toBe("");
    expect(created.code).toBe(0);
    const taskId = created.stdout.trim();
    expect(taskId).toMatch(/^\S+$/);

    const prompted = await meddle(["task", "prompt", taskId, "Reply", "with", "the", "single", "word", "ok."], client);
    expect(prompted.code).toBe(0);
    const types = prompted.stderr.trim().split("\n");
    expect(types).toContain("system/init");
    expect(types.at(-1)).toBe("result/success");

    // nothing is parked, so there is nothing to retry (chord marks a method's own error `unavailable`)
    const retried = await meddle(["task", "retry", taskId], client);
    expect(retried.code).toBe(1);
    expect(retried.stderr).toBe(`meddle: unavailable: no parked turn for task ${taskId}\n`);

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
    expect(lines).toHaveLength(6);
  } finally {
    if (!stopped) await node.stop();
  }
}, 60_000);

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

test("task prompt fails fast when the turn fails", async () => {
  const { dir, env } = await home();
  await writeFile(`${dir}/token`, "tok\n");
  expect((await meddle(["token", "set", "--file", `${dir}/token`], env)).code).toBe(0);
  const node = await startServe({ ...env, MEDDLE_PORT: "0", MEDDLE_CLAUDE_PATH: `${dir}/no-such-claude` });
  const client = { ...env, MEDDLE_PORT: String(node.port) };
  try {
    const projectId = (await meddle(["project", "add", `${dir}/repo`], client)).stdout.trim();
    const taskId = (await meddle(["task", "new", "--title", "t", "--project", projectId], client)).stdout.trim();
    expect(taskId).toMatch(/^\S+$/);

    // the child never starts: the turn logs `turn_failed`, and its error is printed
    const prompted = await meddle(["task", "prompt", taskId, "hi"], client);
    expect(prompted.code).toBe(1);
    expect(prompted.stderr).toMatch(/meddle\/turn_failed\nmeddle: the turn failed: ReferenceError: Claude Code native binary not found at \S+\/no-such-claude\. .*\n$/);

    // no token: the turn fails before Claude Code starts, and still logs why
    await rm(`${dir}/d/secrets/claude-token`);
    const tokenless = await meddle(["task", "prompt", taskId, "hi"], client);
    expect(tokenless.code).toBe(1);
    expect(tokenless.stderr).toBe("meddle/turn_failed\nmeddle: the turn failed: Error: no token set\n");
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
    const taskId = (await meddle(["task", "new", "--title", "t", "--project", projectId], client)).stdout.trim();
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
