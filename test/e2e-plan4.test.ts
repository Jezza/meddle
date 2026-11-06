// test/e2e-plan4.test.ts — two `meddle serve` processes in one pool, through the CLI: a pool setting gives the other
// node's commits their author, a rate-limited token hands a turn to the next one and the pool learns it, task new with a prompt places
// a task on a project's home or on the node asked for, a side bookmark made on a non-home node reaches the home, and an
// archived task restores where placement says and resumes there.
import { test, expect } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createHost, webSocketLink, type Host } from "@earendil-works/chord";
import { initColocated, jj } from "../src/jj";
import { shortId } from "../src/pool/ids";
import { TaskObject } from "../src/state/contracts";
import { tokenId } from "../src/token";
import { startFakeLighthouse } from "./fake-lighthouse";
import { meddle, replay, startServe } from "./helpers";

const fixtures = `${import.meta.dir}/fixtures`;

/**
 * A temp home with a data dir, a created task root and a colocated jj repo, and the env a pooled meddle child runs
 * with: `childEnv` strips every `MEDDLE_*` of this process, so the serve env is all here. `tok-a` replays a rate-limited
 * turn and `tok-b` a good one. The jj author this process passes on (test/preload.ts) is not the pool's: the pool
 * setting must win over it.
 */
async function home(lighthouseUrl: string) {
  const dir = await mkdtemp("/tmp/meddle-e2e-plan4-");
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
    MEDDLE_FIXTURE: `${fixtures}/hello.jsonl`,
    MEDDLE_FIXTURE_BY_TOKEN: `tok-a=${fixtures}/rate-limited.jsonl,tok-b=${fixtures}/hello.jsonl`,
    MEDDLE_IROH_PRESET: "minimal",
    MEDDLE_IROH_BIND: "127.0.0.1:0",
    MEDDLE_LIGHTHOUSE_URL: lighthouseUrl,
    MEDDLE_DISCOVERY_POLL_MS: "1000",
    MEDDLE_PORT: "0",
  };
  return { dir, env };
}

/** How long one wait may take, by the clock (each attempt spawns a CLI, which takes a while of its own). */
const POLL_MS = 15_000;

/** Runs `meddle <args>` until its stdout matches `pattern`, 250 ms apart, for at most `POLL_MS`; returns the match. */
async function until(args: string[], env: Record<string, string>, pattern: RegExp): Promise<RegExpExecArray> {
  const deadline = Date.now() + POLL_MS;
  let last = "";
  for (;;) {
    const out = await meddle(args, env);
    last = `${out.stdout}${out.stderr}`;
    const match = pattern.exec(out.stdout);
    if (out.code === 0 && match) return match;
    if (Date.now() >= deadline) break;
    await Bun.sleep(250);
  }
  throw new Error(`meddle ${args.join(" ")} never matched ${pattern} in ${POLL_MS} ms; last output:\n${last}`);
}

/** Runs `read` until it returns a value `ok` accepts, 250 ms apart, for at most `POLL_MS`; `what` names it on failure. */
async function untilValue<T>(what: string, read: () => Promise<T>, ok: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + POLL_MS;
  let last: unknown;
  for (;;) {
    try {
      const value = await read();
      if (ok(value)) return value;
      last = value;
    } catch (err) {
      last = err;
    }
    if (Date.now() >= deadline) break;
    await Bun.sleep(250);
  }
  throw new Error(`${what} never held in ${POLL_MS} ms; last: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

/** A chord client host over `ws://127.0.0.1:<port>/ws`: the node's own dashboard socket. */
function client(port: number): Host {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  return createHost({ name: "test", self: "test", kind: "client", upstream: { link: webSocketLink(socket), principal: "node" } });
}

/** Waits until task `taskId` on the node at `port` is idle (a turn and its turn end, the push to home, done). */
async function idle(port: number, taskId: string): Promise<void> {
  const host = client(port);
  try {
    const task = await host.get(TaskObject, { id: taskId });
    try {
      await untilValue(`task ${taskId} idle`, async () => task.state.value, (s) => s === "idle");
    } finally {
      task.release();
    }
  } finally {
    await host.close();
  }
}

/** The task id `task <id> on <short>` names, checking the short id. */
function taskOn(out: { stdout: string; stderr: string; code: number }, node: string): string {
  expect(out.stderr).toBe("");
  expect(out.code).toBe(0);
  const [, taskId = "", on] = /^task (\S+) on (\S+)(?: \(.*\))?\n$/.exec(out.stdout) ?? [];
  expect(on).toBe(shortId(node));
  return taskId;
}

test("settings, tokens, placement, the bookmark namespace and archive work across two serve processes", async () => {
  const lighthouse = await startFakeLighthouse();
  const a = await home(lighthouse.url);
  const b = await home(lighthouse.url);
  const nodes: Awaited<ReturnType<typeof startServe>>[] = [];
  try {
    const A = await startServe(a.env);
    nodes.push(A);
    const B = await startServe(b.env);
    nodes.push(B);
    const atA = { ...a.env, MEDDLE_PORT: String(A.port) };
    const atB = { ...b.env, MEDDLE_PORT: String(B.port) };

    // a pool of two
    await writeFile(`${a.dir}/secret`, "plan4-e2e-secret\n");
    await writeFile(`${b.dir}/secret`, "plan4-e2e-secret\n");
    for (const [env, dir] of [[atA, a.dir], [atB, b.dir]] as const) {
      const set = await meddle(["pool", "secret", "--file", `${dir}/secret`], env);
      expect(set.stderr).toBe("");
      expect(set.code).toBe(0);
    }
    await until(["pool"], atA, new RegExp(`^ +${shortId(B.id)} +\\S+ +online `, "m"));
    await until(["pool"], atB, new RegExp(`^ +${shortId(A.id)} +\\S+ +online `, "m"));

    // settings: a jj identity set on A reaches B
    expect(await meddle(["config", "set", "jj.user", "Pool Person"], atA)).toEqual({ stdout: "", stderr: "", code: 0 });
    expect(await meddle(["config", "set", "jj.email", "pool@meddle.invalid"], atA)).toEqual({ stdout: "", stderr: "", code: 0 });
    await until(["config", "list"], atB, /^jj\.email = pool@meddle\.invalid\njj\.user = Pool Person\n$/);

    // tokens: two added on A, a first in order; both reach B
    await writeFile(`${a.dir}/tok-a`, "tok-a\n");
    await writeFile(`${a.dir}/tok-b`, "tok-b\n");
    const idA = tokenId("tok-a");
    const idB = tokenId("tok-b");
    expect(await meddle(["token", "add", "--file", `${a.dir}/tok-a`, "--label", "a"], atA)).toEqual({ stdout: `token ${idA} (a)\n`, stderr: "", code: 0 });
    await Bun.sleep(5); // set later, so second in order
    expect(await meddle(["token", "add", "--file", `${a.dir}/tok-b`, "--label", "b"], atA)).toEqual({ stdout: `token ${idB} (b)\n`, stderr: "", code: 0 });
    await until(["token", "list"], atB, new RegExp(`^${idA} {2}a {2}ok {2}.*\\n${idB} {2}b {2}ok {2}.*\\nactive: ${idA}\\n$`));

    // a project homed on each node; each node's project list shows both
    const pa = (await meddle(["project", "add", `${a.dir}/repo`, "--name", "pa"], atA)).stdout.trim();
    const pb = (await meddle(["project", "add", `${b.dir}/repo`, "--name", "pb"], atB)).stdout.trim();
    expect(pa).toMatch(/^[0-9a-f]{12}$/);
    expect(pb).toMatch(/^[0-9a-f]{12}$/);
    const both = [`${pa}  pa  home ${shortId(A.id)}  on ${shortId(A.id)}`, `${pb}  pb  home ${shortId(B.id)}  on ${shortId(B.id)}`].join("\n");
    await until(["project", "list"], atA, new RegExp(`^${both}\\n$`));
    await until(["project", "list"], atB, new RegExp(`^${both}\\n$`));

    // a turn on A: a is rate-limited, the turn reruns on b and succeeds; B learns a is exhausted
    const onA = taskOn(await meddle(["task", "new", "--title", "tokens", "--project", "pa"], atA), A.id);
    const first = await meddle(["task", "prompt", onA, "Reply", "with", "ok."], atA);
    expect(first.code).toBe(0);
    const lines = first.stderr.trim().split("\n");
    expect(lines).toContain("meddle/token_fault");
    expect(lines.at(-1)).toBe("result/success");
    await until(["token", "list"], atB, new RegExp(`^${idA} {2}a {2}exhausted until 2100-01-01T00:00:00\\.000Z \\(five_hour\\) .*\\nactive: ${idB}\\n$`, "ms"));

    // task new with a prompt on A for B's project: placed on B, its home; its turn commits on B with the pool's author
    const spawnedB = taskOn(await meddle(["task", "new", "Reply", "with", "ok.", "--project", "pb"], atA), B.id);
    await idle(B.port, spawnedB);
    const author = await jj(
      ["log", "--ignore-working-copy", "--no-graph", "-r", `meddle/task/${spawnedB}/pb`, "-T", 'author.name() ++ " <" ++ author.email() ++ ">"'],
      `${b.dir}/repo`,
    );
    expect(author).toBe("Pool Person <pool@meddle.invalid>");

    // task new with a prompt on A for A's project, asked onto B; a side bookmark made in its workspace on B reaches A's line after a turn
    const spawned = taskOn(await meddle(["task", "new", "Reply", "with", "ok.", "--project", pa, "--node", shortId(B.id)], atA), B.id);
    await idle(B.port, spawned);
    const spike = `meddle/task/${spawned}/pa.spike`;
    await jj(["bookmark", "create", spike, "-r", "@"], `${b.dir}/t/${spawned}/pa`);
    const second = await meddle(["task", "prompt", spawned, "Reply", "with", "ok", "again."], atB);
    expect(second.code).toBe(0);
    expect(second.stderr.trim().split("\n").at(-1)).toBe("result/success");
    await idle(B.port, spawned);
    // read through git, so the test runs no jj operation in a repo A's serve is using
    const refsOnA = async () => (await Bun.$`git -C ${a.dir}/repo for-each-ref ${"--format=%(refname)"} refs/remotes/meddle/task/${spawned}/`.quiet().text());
    await untilValue(`${spike} on A`, refsOnA, (out) => out.split("\n").includes(`refs/remotes/meddle/task/${spawned}/pa.spike`));

    // archive it on B; restore it from B with no node: placement picks pa's home A, the printed node is where it is
    await until(["status"], atB, /^tasks 2$/m);
    expect(await meddle(["task", "archive", spawned], atB)).toEqual({ stdout: `archived ${spawned}\n`, stderr: "", code: 0 });
    await until(["status"], atB, /^tasks 1$/m);
    const restored = await meddle(["task", "restore", spawned], atB);
    expect(restored.stderr).toBe("");
    expect(restored.code).toBe(0);
    const [, to = ""] = /^restoring to (\S+)(?: \(.*\))?\n$/.exec(restored.stdout) ?? [];
    expect(to).toBe(shortId(A.id));
    await until(["status"], atA, /^tasks 2$/m);
    await until(["status"], atB, /^tasks 1$/m);
    await idle(A.port, spawned);

    // a turn resumes there
    const resumed = await meddle(["task", "prompt", spawned, "Reply", "with", "ok", "once", "more."], atA);
    expect(resumed.code).toBe(0);
    expect(resumed.stderr.trim().split("\n").at(-1)).toBe("result/success");
  } finally {
    const stopped = await Promise.all(nodes.map(async (n) => ({ code: await n.stop(), stderr: n.stderr() })));
    lighthouse.stop();
    for (const s of stopped) expect(s).toEqual({ code: 0, stderr: "" });
  }
}, 180_000);
