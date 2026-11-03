// test/move-e2e.test.ts — two `meddle serve` processes in one pool: a task with a finished turn moves from A to B
// through the CLI, resumes there, and A keeps only a row that says where it went.
import { test, expect } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createHost, webSocketLink, type Host } from "@earendil-works/chord";
import { initColocated } from "../src/jj";
import { shortId } from "../src/pool/ids";
import { TaskObject } from "../src/state/contracts";
import { startFakeLighthouse } from "./fake-lighthouse";
import { meddle, replay, startServe } from "./helpers";

/**
 * A temp home with a data dir, a created task root and a colocated jj repo, and the env a pooled meddle child runs with
 * (a jj author included).
 */
async function home(lighthouseUrl: string) {
  const dir = await mkdtemp("/tmp/meddle-move-e2e-");
  await mkdir(`${dir}/t`, { recursive: true });
  await initColocated(`${dir}/repo`);
  const env = {
    HOME: dir,
    MEDDLE_DATA_DIR: `${dir}/d`,
    MEDDLE_TASK_ROOT: `${dir}/t`,
    MEDDLE_CLAUDE_PATH: replay,
    MEDDLE_CLAUDE_RUNTIME: "bun",
    MEDDLE_FIXTURE: `${import.meta.dir}/fixtures/hello.jsonl`,
    MEDDLE_IROH_PRESET: "minimal",
    MEDDLE_IROH_BIND: "127.0.0.1:0",
    MEDDLE_LIGHTHOUSE_URL: lighthouseUrl,
    MEDDLE_DISCOVERY_POLL_MS: "1000",
    MEDDLE_PORT: "0",
    // The temp home has no jj config, and jj will not push a commit with no author (a real node's user config has one).
    JJ_USER: "meddle test",
    JJ_EMAIL: "test@meddle.invalid",
  };
  return { dir, env };
}

/** How long one poll may take, by the clock (each attempt spawns a CLI, which takes a while of its own). */
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

/** A chord client host over `ws://127.0.0.1:<port><path>`. */
function client(port: number, path: string): Host {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  return createHost({ name: "test", self: "test", kind: "client", upstream: { link: webSocketLink(socket), principal: "node" } });
}

test("a task moves from one node to another through the CLI and resumes there", async () => {
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

    // a pool of two, with a token that reaches B
    await writeFile(`${a.dir}/secret`, "move-e2e-secret-2026\n");
    await writeFile(`${b.dir}/secret`, "move-e2e-secret-2026\n");
    for (const [env, dir] of [[atA, a.dir], [atB, b.dir]] as const) {
      const set = await meddle(["pool", "secret", "--file", `${dir}/secret`], env);
      expect(set.stderr).toBe("");
      expect(set.code).toBe(0);
    }
    await until(["pool"], atA, new RegExp(`^${shortId(B.id)} \\S+ online `, "m"));
    await writeFile(`${a.dir}/token`, "tok\n");
    expect((await meddle(["token", "set", "--file", `${a.dir}/token`], atA)).code).toBe(0);
    await until(["token", "status"], atB, /^active: [0-9a-f]{16}$/m);

    // A: a project, a task and a turn
    const added = await meddle(["project", "add", `${a.dir}/repo`, "--name", "repo"], atA);
    expect(added.stderr).toBe("");
    expect(added.code).toBe(0);
    const projectId = added.stdout.trim();
    const listed = await meddle(["project", "list"], atA);
    expect(listed.stdout).toBe(`${projectId}  repo  home ${shortId(A.id)}  on ${shortId(A.id)}\n`);
    const created = await meddle(["task", "new", "--title", "t", "--project", projectId], atA);
    expect(created.stderr).toBe("");
    expect(created.code).toBe(0);
    const [, taskId = "", on] = /^task (\S+) on (\S+)\n$/.exec(created.stdout) ?? [];
    expect(on).toBe(shortId(A.id));
    const first = await meddle(["task", "prompt", taskId, "Reply", "with", "ok."], atA);
    expect(first.code).toBe(0);
    expect(first.stderr.trim().split("\n").at(-1)).toBe("result/success");

    // a node the pool does not know is refused before anything moves
    const unknown = await meddle(["task", "move", taskId, "zzzz"], atA);
    expect(unknown).toEqual({ stdout: "", stderr: "meddle: no such node: zzzz\n", code: 1 });

    // A: move it to B by B's short id
    const moved = await meddle(["task", "move", taskId, shortId(B.id)], atA);
    expect(moved).toEqual({ stdout: `moving ${taskId} to ${shortId(B.id)}\n`, stderr: "", code: 0 });
    await until(["status"], atB, /^tasks 1$/m);
    await until(["status"], atA, /^tasks 0$/m);

    // B: a resumed turn
    const resumed = await meddle(["task", "prompt", taskId, "Reply", "with", "ok", "again."], atB);
    expect(resumed.code).toBe(0);
    expect(resumed.stderr.trim().split("\n").at(-1)).toBe("result/success");

    // through A's tunnel the task is on B, idle once the turn's end (its push to home A) is done; A's own row says it
    // moved to B
    const tunnel = client(A.port, `/ws/node/${B.id}`);
    try {
      const task = await tunnel.get(TaskObject, { id: taskId });
      const deadline = Date.now() + POLL_MS;
      while (task.state.value !== "idle") {
        if (Date.now() >= deadline) throw new Error(`the task on B never went idle in ${POLL_MS} ms; last state ${task.state.value}`);
        await Bun.sleep(250);
      }
      expect(task.state.value).toBe("idle");
      task.release();
    } finally {
      await tunnel.close();
    }
    const local = client(A.port, "/ws");
    try {
      const task = await local.get(TaskObject, { id: taskId });
      expect(task.state.value).toBe("moved");
      expect(task.movedTo.value).toBe(B.id);
      task.release();
    } finally {
      await local.close();
    }
  } finally {
    const stopped = await Promise.all(nodes.map(async (n) => ({ code: await n.stop(), stderr: n.stderr() })));
    lighthouse.stop();
    for (const s of stopped) expect(s).toEqual({ code: 0, stderr: "" });
  }
}, 90_000);
