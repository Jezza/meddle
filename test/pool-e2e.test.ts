// test/pool-e2e.test.ts — two `meddle serve` processes form a pool through the CLI, finding each other only through a
// (fake) lighthouse.
import { test, expect } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createHost, webSocketLink } from "@earendil-works/chord";
import { shortId } from "../src/pool/identity";
import { NodeObject } from "../src/state/host";
import { startFakeLighthouse } from "./fake-lighthouse";
import { closedPort, meddle, replay, startServe } from "./helpers";

/** A temp home with a data dir and a created task root, and the env a pooled meddle child runs with. */
async function home(lighthouseUrl: string) {
  const dir = await mkdtemp("/tmp/meddle-pool-e2e-");
  await mkdir(`${dir}/t`, { recursive: true });
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
  };
  return { dir, env };
}

/** Runs `meddle <args>` until its stdout matches `pattern`, every 250 ms for at most 20 s; returns the match. */
async function until(args: string[], env: Record<string, string>, pattern: RegExp): Promise<RegExpExecArray> {
  let last = "";
  for (let i = 0; i < 80; i++) {
    const out = await meddle(args, env);
    last = `${out.stdout}${out.stderr}`;
    const match = pattern.exec(out.stdout);
    if (out.code === 0 && match) return match;
    await Bun.sleep(250);
  }
  throw new Error(`meddle ${args.join(" ")} never matched ${pattern}; last output:\n${last}`);
}

test("two nodes form a pool: invite, join, replicate the token, and tunnel a dashboard link", async () => {
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

    const invited = await meddle(["invite"], atA);
    expect(invited.stderr).toBe("");
    expect(invited.code).toBe(0);
    expect(invited.stdout).toMatch(/^meddle1\S+\n$/);

    const poolId = (await until(["status"], atA, /^pool ([0-9a-f]+) members 1$/m))[1]!;
    const joined = await meddle(["join", invited.stdout.trim()], atB);
    expect(joined.stderr).toBe("");
    expect(joined.code).toBe(0);
    expect(joined.stdout).toBe(`joined pool ${shortId(poolId)} with 2 nodes\n`);

    const listing = await until(["pool"], atA, new RegExp(`^${shortId(B.id)} \\S+ online meddle \\S+ claude \\S+ tasks 0$`, "m"));
    const lines = listing.input.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines).toContainEqual(expect.stringMatching(new RegExp(`^${shortId(A.id)} \\S+ online meddle \\S+ claude \\S+ tasks 0 \\(this node\\)$`)));
    await until(["status"], atB, new RegExp(`^pool ${poolId} members 2$`, "m"));
    // both announce the pool's topic
    for (let i = 0; ![...lighthouse.topics().values()].some((t) => t.has(A.id) && t.has(B.id)); i++) {
      if (i === 80) throw new Error("the nodes never announced one topic");
      await Bun.sleep(250);
    }

    // the token set on A reaches B, with the same setAt, and is never printed
    await writeFile(`${a.dir}/token`, "tok2\n");
    const set = await meddle(["token", "set", "--file", `${a.dir}/token`], atA);
    expect(set).toEqual({ stdout: "token set\n", stderr: "", code: 0 });
    const setAt = (await until(["token", "status"], atA, /^setAt: (\S+)$/m))[1]!;
    const replicated = await until(["token", "status"], atB, /^present: true\nsetAt: (\S+)$/m);
    expect(replicated[1]).toBe(setAt);
    expect(replicated.input).not.toContain("tok2");

    // a dashboard link to B through A
    const socket = new WebSocket(`ws://127.0.0.1:${A.port}/ws/node/${B.id}`);
    const client = createHost({ name: "test", self: "test", kind: "client", upstream: { link: webSocketLink(socket), principal: "node" } });
    try {
      const node = await client.get(NodeObject, {});
      expect(node.nodeId.value).toBe(B.id);
      node.release();
    } finally {
      await client.close();
    }
  } finally {
    const stopped = await Promise.all(nodes.map(async (n) => ({ code: await n.stop(), stderr: n.stderr() })));
    lighthouse.stop();
    for (const s of stopped) expect(s).toEqual({ code: 0, stderr: "" });
  }
}, 60_000);

test("token set without a running node writes the token and says so", async () => {
  const { dir, env } = await home("");
  await writeFile(`${dir}/token`, "tok\n");
  const set = await meddle(["token", "set", "--file", `${dir}/token`], { ...env, MEDDLE_PORT: String(await closedPort()) });
  expect(set).toEqual({ stdout: "token set\n", stderr: "", code: 0 });
  const status = await meddle(["token", "status"], env);
  expect(status.stdout).toStartWith("present: true\n");
  // set by this node: its identity, created for the purpose
  const nodeId = /^node ([0-9a-f]{64})$/m.exec((await meddle(["status"], env)).stdout)?.[1];
  expect(nodeId).toBeDefined();
  expect(JSON.parse(await readFile(`${dir}/d/secrets/claude-token.meta.json`, "utf8")).setBy).toBe(nodeId);
});
