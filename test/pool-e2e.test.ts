// test/pool-e2e.test.ts — two `meddle serve` processes form a pool through the CLI, finding each other only through a
// (fake) lighthouse.
import { test, expect } from "bun:test";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createHost, webSocketLink } from "@earendil-works/chord";
import { Database } from "bun:sqlite";
import { shortId } from "../src/pool/identity";
import { tokenId } from "../src/token";
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

test("two nodes given one secret form a pool through the lighthouse, replicate a token, and tunnel a dashboard link", async () => {
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

    expect((await meddle(["status"], atA)).stdout).toContain("pool (no secret set)\n");
    await writeFile(`${a.dir}/secret`, "e2e-pool-secret-2026\n");
    await writeFile(`${b.dir}/secret`, "e2e-pool-secret-2026\n");
    const setA = await meddle(["pool", "secret", "--file", `${a.dir}/secret`], atA);
    expect(setA.stderr).toBe("");
    expect(setA.code).toBe(0);
    const poolId = (await until(["status"], atA, /^pool ([0-9a-f]{64}) \(default\) members 1$/m))[1]!;
    expect(setA.stdout).toBe(`pool ${shortId(poolId)} (default)\n`);
    // The same secret on B puts it in the same pool: same id, found through the lighthouse, proved to each other.
    const setB = await meddle(["pool", "secret", "--file", `${b.dir}/secret`], atB);
    expect(setB).toEqual({ stdout: `pool ${shortId(poolId)} (default)\n`, stderr: "", code: 0 });

    // A table, this node first and marked @; with -v, the connection held with the other: who dialed it, B's session.
    const listing = await until(["pool", "-v"], atA, new RegExp(`^ +${shortId(B.id)} +\\S+ +online +\\S+ +\\S+ +0 +[0-9a-f]{10} +([0-9a-f]{28})$`, "m"));
    const lines = listing.input.trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^ +NODE +HOST +STATE +MEDDLE +CLAUDE +TASKS +DIALER +SESSION$/);
    expect(lines[1]).toMatch(new RegExp(`^@ +${shortId(A.id)} +\\S+ +online +\\S+ +\\S+ +0 +- +[0-9a-f]{28}$`));
    // B's session as A sees it on the connection is B's own.
    const atBListing = await until(["pool", "-v"], atB, new RegExp(`^@ +${shortId(B.id)} .* ([0-9a-f]{28})$`, "m"));
    expect(listing[1]).toBe(atBListing[1]);
    // Without -v, no connection columns.
    expect((await meddle(["pool"], atA)).stdout.split("\n")[0]).toMatch(/^ +NODE +HOST +STATE +MEDDLE +CLAUDE +TASKS$/);
    await until(["status"], atB, new RegExp(`^pool ${poolId} \\(default\\) members 2$`, "m"));
    // both announce the pool's topic
    for (let i = 0; ![...lighthouse.topics().values()].some((t) => t.has(A.id) && t.has(B.id)); i++) {
      if (i === 80) throw new Error("the nodes never announced one topic");
      await Bun.sleep(250);
    }

    // the token added on A reaches B, listed alike and active there, and is never printed
    await writeFile(`${a.dir}/token`, "tok2\n");
    const id = tokenId("tok2");
    const set = await meddle(["token", "add", "--file", `${a.dir}/token`, "--label", "work"], atA);
    expect(set).toEqual({ stdout: `token ${id} (work)\n`, stderr: "", code: 0 });
    const atAList = (await meddle(["token", "list"], atA)).stdout;
    expect(atAList).toMatch(new RegExp(`^${id}  work  ok  expires \\S+\nactive: ${id}\n$`));
    const replicated = await until(["token", "list"], atB, new RegExp(`^active: ${id}$`, "m"));
    expect(replicated.input).toBe(atAList);
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

// Each CLI process here pays about 370 ms of scrypt on a Raspberry Pi: together far past bun's default 5 s there.
test("pool secret --generate writes a new 600 file and sets the pool; --file elsewhere gives the same id; a short secret is refused", async () => {
  const { dir, env } = await home("");
  const offline = { ...env, MEDDLE_PORT: String(await closedPort()) };
  const generated = await meddle(["pool", "secret", "--generate", `${dir}/pool-secret`], offline);
  expect(generated.stderr).toBe("");
  expect(generated.code).toBe(0);
  const [, short] = /^pool ([0-9a-f]{10}) \(default\)\nsecret written to \S+; copy it to the other nodes \(meddle pool secret --file <path>\)\n$/.exec(generated.stdout) ?? [];
  expect(short).toBeDefined();
  const file = await readFile(`${dir}/pool-secret`, "utf8");
  expect(file).toMatch(/^[A-Za-z0-9_-]{43}\n$/);
  expect((await stat(`${dir}/pool-secret`)).mode & 0o777).toBe(0o600);
  expect(generated.stdout).not.toContain(file.trim());
  // Never over an existing file.
  const again = await meddle(["pool", "secret", "--generate", `${dir}/pool-secret`], offline);
  expect(again.code).toBe(1);
  expect(again.stderr).toContain("EEXIST");
  // The same file on another node: the same pool.
  const other = await home("");
  const set = await meddle(["pool", "secret", "--file", `${dir}/pool-secret`], { ...other.env, MEDDLE_PORT: offline.MEDDLE_PORT });
  expect(set).toEqual({ stdout: `pool ${short} (default)\n`, stderr: "", code: 0 });
  const status = await meddle(["status"], other.env);
  expect(status.stdout).toMatch(new RegExp(`^pool ${short}[0-9a-f]{54} \\(default\\) members 1$`, "m"));
  // A short one, or one as an argument, is refused.
  await writeFile(`${dir}/weak`, "hunter2\n");
  expect(await meddle(["pool", "secret", "--file", `${dir}/weak`], offline)).toEqual({ stdout: "", stderr: "meddle: the secret is shorter than 16 characters (use --generate)\n", code: 1 });
  expect((await meddle(["pool", "secret", "this-is-a-long-enough-secret"], offline)).code).toBe(2);
}, 30_000);

test("token set without a running node writes the token and says so", async () => {
  const { dir, env } = await home("");
  await writeFile(`${dir}/token`, "tok\n");
  const id = tokenId("tok");
  const set = await meddle(["token", "set", "--file", `${dir}/token`], { ...env, MEDDLE_PORT: String(await closedPort()) });
  expect(set).toEqual({ stdout: `token ${id} (${id.slice(0, 8)})\n`, stderr: "", code: 0 });
  const status = await meddle(["token", "status"], env);
  expect(status.stdout).toEndWith(`active: ${id}\n`);
  expect((await readFile(`${dir}/d/secrets/tokens/${id}`, "utf8"))).toBe("tok");
  // set by this node: its identity, created for the purpose
  const nodeId = /^node ([0-9a-f]{64})$/m.exec((await meddle(["status"], env)).stdout)?.[1];
  expect(nodeId).toBeDefined();
  const db = new Database(`${dir}/d/meddle.sqlite`, { readonly: true });
  try {
    expect(db.query("SELECT set_by FROM tokens WHERE id = ?").get(id)).toEqual({ set_by: nodeId });
  } finally {
    db.close();
  }
});
