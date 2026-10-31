import { test, expect } from "bun:test";
import { stat } from "node:fs/promises";
import { createHost, memoryLinkPair } from "@earendil-works/chord";
import { paths } from "../src/config";
import { PoolObject } from "../src/state/contracts";
import { getToken, setToken, tokenStatus } from "../src/token";
import { twoNodes, type PoolNode, type TappedFrame } from "./pool-helpers";

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

/** `node`'s token was set at `setAt` by `setBy` and is `value` (compared without printing it). */
async function hasToken(node: PoolNode, value: string, setAt: string | undefined, setBy: string): Promise<boolean> {
  const status = await tokenStatus(node.cfg);
  return status.setAt === setAt && status.setBy === setBy && (await getToken(node.cfg)) === value;
}

function parsed(frame: TappedFrame): { t: string; m?: string; member?: string } {
  return JSON.parse(frame.text) as { t: string; m?: string; member?: string };
}

/** The frames of the first test's sync links, for the second. */
const tapped: TappedFrame[] = [];

test("summaries, roster edits and the token replicate through chord over iroh", async () => {
  const { a, b, framesOf, close } = await twoNodes();
  try {
    const third = { ...a.store.row(a.id)!, nodeId: C, hostname: "host-c", updatedAt: "2026-10-31T00:00:00.000Z" };
    a.store.upsert(third);
    b.store.upsert(third);

    await until(() => knows(a, b) && knows(b, a));

    await setToken(a.cfg, "tok2", { setBy: a.id });
    await a.deps.tokenChanged();
    const fromA = await tokenStatus(a.cfg);
    await until(() => hasToken(b, "tok2", fromA.setAt, a.id));
    expect((await stat(paths(b.cfg).tokenFile)).mode & 0o777).toBe(0o600);

    await setToken(b.cfg, "tok3", { setBy: b.id });
    await b.deps.tokenChanged();
    const fromB = await tokenStatus(b.cfg);
    await until(() => hasToken(a, "tok3", fromB.setAt, b.id));

    a.store.remove(C);
    a.changed();
    await until(() => b.store.row(C)?.status === "removed");
    expect([...a.errors, ...b.errors].map(String)).toEqual([]);

    tapped.push(...framesOf(a), ...framesOf(b));
  } finally {
    await close();
  }
}, 15_000);

test("the token never appears in a frame other than a fetchToken result", () => {
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
    await setToken(b.cfg, "tok2", { setBy: b.id });
    b.host.accept(down, { principal: `peer:${a.id}`, kind: "client" });
    const pool = await probe.get(PoolObject, {});
    expect(pool.variant).toBe("peer");
    if (pool.variant !== "peer") return;
    // A member is answered.
    expect((await pool.fetchToken({})).value === "tok2").toBe(true);

    b.store.remove(a.id);
    let refusal: unknown = null;
    await pool.fetchToken({}).catch((err: unknown) => { refusal = err; });
    expect(refusal).toMatchObject({ code: "forbidden" });
    expect(String((refusal as Error).message)).toContain("not a member");
    pool.release();
  } finally {
    await probe.close();
    await close();
  }
}, 15_000);

test("a peer with an older token does not overwrite a newer local one", async () => {
  const { a, b, framesOf, start, close } = await twoNodes({ start: false });
  try {
    const older = "2026-10-31T01:00:00.000Z";
    const newer = "2026-10-31T02:00:00.000Z";
    await setToken(a.cfg, "tok2", { setAt: older, setBy: a.id });
    await setToken(b.cfg, "tok3", { setAt: newer, setBy: b.id });
    start();

    // A takes B's newer token; B has seen A's older one (its token snapshot) and kept its own.
    await until(() => hasToken(a, "tok3", newer, b.id));
    await until(() => framesOf(b).some((f) => f.direction === "in" && parsed(f).t === "state" && parsed(f).m === "token"));
    await Bun.sleep(200);
    expect(await hasToken(b, "tok3", newer, b.id)).toBe(true);
    const fetches = framesOf(b).filter((f) => f.direction === "out" && parsed(f).t === "call" && parsed(f).member === "fetchToken");
    expect(fetches).toEqual([]);
  } finally {
    await close();
  }
}, 15_000);
