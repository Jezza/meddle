import { test, expect } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createHost, memoryLinkPair } from "@earendil-works/chord";
import { ensureDataDirs, loadConfig, paths } from "../src/config";
import { startPool } from "../src/pool/runtime";
import { PoolObject } from "../src/state/contracts";
import { openDb } from "../src/store/db";
import { addToken, listTokens, tokenFile, tokenId, tokenValue } from "../src/token";
import { listBranchRows, writeBranchRow, writeLineRow } from "../src/pool/rows";
import { HoldFailed } from "../src/pool/sync";
import { POOL_ENV, poolSummaryOf, threeNodes, twoNodes, type PoolNode, type TappedFrame } from "./pool-helpers";

const C = "c".repeat(64);
const TOKENS = ["tok2", "tok3"];

async function until(cond: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(10);
  }
}

/** `holder` knows `about`'s summary as `about` reports it, when it last heard of it, and an address. */
function knows(holder: PoolNode, about: PoolNode): boolean {
  const row = holder.store.row(about.id);
  return row?.summary?.hostname === about.summary.hostname && row.lastSeenAt !== null && row.lastAddr !== null;
}

/** `node` lists the token `value` as set at `setAt` by `setBy`, and holds its value (compared without printing it). */
async function hasToken(node: PoolNode, value: string, setAt: string, setBy: string): Promise<boolean> {
  const id = tokenId(value);
  const row = listTokens(node.db).find((t) => t.id === id);
  return row?.setAt === setAt && row.setBy === setBy && (await tokenValue(node.cfg, id)) === value;
}

function parsed(frame: TappedFrame): { t: string; m?: string; member?: string } {
  return JSON.parse(frame.text) as { t: string; m?: string; member?: string };
}

/** The frames of the first test's sync links, for the second. */
const tapped: TappedFrame[] = [];

test("summaries, roster edits and the tokens replicate through chord over iroh", async () => {
  const { a, b, framesOf, close } = await twoNodes();
  try {
    const third = { ...a.store.row(a.id)!, nodeId: C, hostname: "host-c", updatedAt: "2026-10-31T00:00:00.000Z" };
    a.store.upsert(third);
    b.store.upsert(third);

    await until(() => knows(a, b) && knows(b, a));

    const fromA = await addToken(a.cfg, a.db, "tok2", { setBy: a.id });
    await a.deps.tokenChanged();
    await until(() => hasToken(b, "tok2", fromA.setAt, a.id));
    expect((await stat(tokenFile(b.cfg, fromA.id))).mode & 0o777).toBe(0o600);

    const fromB = await addToken(b.cfg, b.db, "tok3", { setBy: b.id });
    await b.deps.tokenChanged();
    await until(() => hasToken(a, "tok3", fromB.setAt, b.id));
    // Each node lists both, in the same order.
    await until(() => JSON.stringify(listTokens(a.db)) === JSON.stringify(listTokens(b.db)));
    expect(listTokens(a.db).map((t) => t.id)).toEqual([fromA.id, fromB.id]);

    a.store.remove(C);
    a.changed();
    await until(() => b.store.row(C)?.status === "removed");
    expect([...a.errors, ...b.errors].map(String)).toEqual([]);

    tapped.push(...framesOf(a), ...framesOf(b));
  } finally {
    await close();
  }
}, 15_000);

test("a peer not serving its pool yet (still starting) is held once it does, over the connection already up", async () => {
  const { a, b, servePeers, close } = await twoNodes({ servePeersLater: true });
  try {
    await until(() => a.net.isOnline(b.id) && b.net.isOnline(a.id));
    // Each tries to hold the other's pool and is refused: nothing replicates yet.
    await until(() => a.errors.some((e) => e instanceof HoldFailed) && b.errors.some((e) => e instanceof HoldFailed));
    expect(knows(a, b) || knows(b, a)).toBe(false);
    const link = a.net.linkOf(b.id);

    // Both start serving; neither connection drops, yet each holds the other's pool and learns its summary.
    servePeers();
    await until(() => knows(a, b) && knows(b, a));
    expect(a.net.linkOf(b.id)).toEqual(link);
  } finally {
    await close();
  }
}, 15_000);

test("a token value never appears in a frame other than a fetchToken result", () => {
  expect(tapped.length).toBeGreaterThan(0);
  const carrying = tapped.filter((f) => TOKENS.some((t) => f.text.includes(t)));
  // One result each way: B fetched tok2 from A, A fetched tok3 from B; each seen once sent and once received.
  expect(carrying.length).toBeGreaterThanOrEqual(2);
  for (const frame of carrying) expect(parsed(frame).t).toBe("result");
  const states = tapped.filter((f) => parsed(f).t === "state");
  expect(states.length).toBeGreaterThan(0);
  for (const frame of states) expect(TOKENS.some((t) => frame.text.includes(t))).toBe(false);
});

test("fetchToken refuses a principal that is not a current member", async () => {
  const { a, b, close } = await twoNodes({ start: false });
  const [down, up] = memoryLinkPair();
  const probe = createHost({ name: "probe", self: "probe", kind: "client", upstream: { link: up, principal: "node" } });
  try {
    const { id } = await addToken(b.cfg, b.db, "tok2", { setBy: b.id });
    b.host.accept(down, { principal: `peer:${a.id}`, kind: "client" });
    const pool = await probe.get(PoolObject, {});
    expect(pool.variant).toBe("peer");
    if (pool.variant !== "peer") return;
    // A member is answered.
    expect((await pool.fetchToken({ id })).value === "tok2").toBe(true);

    b.store.remove(a.id);
    let refusal: unknown = null;
    await pool.fetchToken({ id }).catch((err: unknown) => { refusal = err; });
    expect(refusal).toMatchObject({ code: "forbidden" });
    expect(String((refusal as Error).message)).toContain("not a member");
    pool.release();
  } finally {
    await probe.close();
    await close();
  }
}, 15_000);

test("a peer's older row for a token does not overwrite a newer local one, and a value held is not fetched", async () => {
  const { a, b, framesOf, start, close } = await twoNodes({ start: false });
  try {
    const older = "2026-10-31T01:00:00.000Z";
    const newer = "2026-10-31T02:00:00.000Z";
    // The same token on both, renamed later on B.
    await addToken(a.cfg, a.db, "tok2", { label: "old", setBy: a.id, now: older });
    await addToken(b.cfg, b.db, "tok2", { label: "new", setBy: b.id, now: newer });
    start();

    // A takes B's newer row; B has seen A's older one (its tokens snapshot) and kept its own.
    await until(() => listTokens(a.db)[0]?.label === "new");
    await until(() => framesOf(b).some((f) => f.direction === "in" && parsed(f).t === "state" && parsed(f).m === "tokens"));
    await Bun.sleep(200);
    expect(listTokens(b.db)).toEqual(listTokens(a.db));
    expect(listTokens(b.db)[0]).toMatchObject({ label: "new", setAt: newer, setBy: b.id });
    // Both hold the value, so neither asked for it.
    const fetches = [...framesOf(a), ...framesOf(b)].filter((f) => f.direction === "out" && parsed(f).t === "call" && parsed(f).member === "fetchToken");
    expect(fetches).toEqual([]);
  } finally {
    await close();
  }
}, 15_000);

test("a branch row written on one node reaches a node it is not linked to, relayed by the node between", async () => {
  const { a, b, c, close } = await threeNodes({ links: [["a", "b"], ["b", "c"]] });
  try {
    // No `changed()`: the write itself tells the pool.
    const written = writeBranchRow(a.db, a.id, { project: "p", branch: "main", commit: "d".repeat(40), drops: [] });
    await until(() => JSON.stringify(listBranchRows(c.db, "p")) === JSON.stringify([written]));
    expect(listBranchRows(b.db, "p")).toEqual([written]);
    expect(a.net.isOnline(c.id) || c.net.isOnline(a.id)).toBe(false);
    expect([...a.errors, ...b.errors, ...c.errors].map(String)).toEqual([]);
  } finally {
    await close();
  }
}, 15_000);

test("a row written on a node fires its pool's change notification at once", async () => {
  const home = await mkdtemp("/tmp/meddle-rows-");
  const cfg = loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/d`, MEDDLE_TASK_ROOT: `${home}/t`, ...POOL_ENV });
  await ensureDataDirs(cfg);
  const db = openDb(paths(cfg).db);
  const pool = await startPool(cfg, db, poolSummaryOf(cfg, db), { log: () => {} });
  try {
    let fired = 0;
    const off = pool.onChange(() => fired++);
    // Counted with no await in between, so that a periodic refresh cannot pass for the write's notification.
    writeBranchRow(db, pool.identity.id, { project: "p", branch: "main", commit: "d".repeat(40), drops: [] });
    const afterBranch = fired;
    writeLineRow(db, {
      project: "p", task: "t", name: "w", holder: pool.identity.id, epoch: 0, commit: "d".repeat(40), base: [], archived: false,
    });
    const afterLine = fired;
    off();
    expect([afterBranch, afterLine]).toEqual([1, 2]);
  } finally {
    await pool.stop();
    db.close();
    await rm(home, { recursive: true, force: true });
  }
}, 15_000);
