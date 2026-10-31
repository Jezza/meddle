import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import type { Database } from "bun:sqlite";
import type { Connection } from "@number0/iroh";
import { ensureDataDirs, loadConfig, paths, type NodeConfig } from "../src/config";
import { ALPN_JOIN, StreamReader, writeLine } from "../src/pool/frames";
import { shortId } from "../src/pool/identity";
import {
  createInvite, decodeTicket, encodeTicket, handleJoin, joinPool, type JoinDeps, type JoinReply, type Ticket,
} from "../src/pool/invite";
import { PoolNet, fromEndpoint, toEndpointAddr } from "../src/pool/net";
import { PoolStore, type NodeSummary, type WireAddr } from "../src/pool/store";
import { openDb } from "../src/store/db";
import { setToken } from "../src/token";
import { testNode, type TestNode } from "./pool-helpers";

const A = "a".repeat(64);
const encoder = new TextEncoder();

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(5);
  }
}

function summaryOf(id: string): NodeSummary {
  return { hostname: `host-${shortId(id)}`, version: "0.1.0", claudeCodeVersion: "2.0.0", hostsTasks: true, taskCount: 3 };
}

/** The inviting node: a temp home, a store with a pool of one, and a PoolNet that serves ALPN_JOIN with handleJoin. */
async function inviter() {
  const home = await mkdtemp("/tmp/meddle-invite-");
  const cfg: NodeConfig = loadConfig({
    HOME: home, MEDDLE_DATA_DIR: `${home}/d`, MEDDLE_TASK_ROOT: `${home}/t`,
    MEDDLE_IROH_PRESET: "minimal", MEDDLE_IROH_BIND: "127.0.0.1:0", MEDDLE_LIGHTHOUSE_URL: "",
  });
  await ensureDataDirs(cfg);
  const db: Database = openDb(paths(cfg).db);
  const store = new PoolStore(db);
  const node = await testNode();
  const id = node.identity.id;
  store.ensurePool({ nodeId: id, hostname: summaryOf(id).hostname });
  const admitted: [string, WireAddr][] = [];
  const errors: unknown[] = [];
  let joins = 0;
  const net = new PoolNet({
    endpoint: node.endpoint, selfId: id, isMember: (peer) => store.isMember(peer), onError: (err) => errors.push(err),
    onJoin: (conn) => {
      joins += 1;
      return handleJoin(conn, { store, selfId: id, cfg, endpoint: node.endpoint, onAdmitted: (nodeId, addr) => admitted.push([nodeId, addr]) });
    },
  });
  net.start();
  return {
    id, node, cfg, store, admitted, errors,
    joins: () => joins,
    async close() {
      await net.stop();
      db.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

/** A joining node with a pool of one in an in-memory store. */
async function joiner(): Promise<TestNode & { store: PoolStore; deps: JoinDeps }> {
  const node = await testNode();
  const store = new PoolStore(openDb(":memory:"));
  const id = node.identity.id;
  store.ensurePool({ nodeId: id, hostname: summaryOf(id).hostname });
  return { ...node, store, deps: { endpoint: node.endpoint, store, identity: node.identity, summary: () => summaryOf(id) } };
}

async function closeAll(nodes: { endpoint: { isClosed(): boolean; close(): Promise<void> } }[]): Promise<void> {
  for (const n of nodes) if (!n.endpoint.isClosed()) await n.endpoint.close();
}

/** Dials the inviter on ALPN_JOIN, sends `line` and returns the raw reply line. */
async function rawJoin(from: TestNode, to: WireAddr, line: string): Promise<string | null> {
  const conn: Connection = await from.endpoint.connect(toEndpointAddr(to), ALPN_JOIN);
  try {
    const { send, recv } = await conn.openBi();
    await writeLine(send, line);
    await send.finish();
    return await new StreamReader(recv).readLine();
  } finally {
    conn.close(0n, Array.from(encoder.encode("bye")));
  }
}

test("tickets encode and decode; junk is refused", () => {
  const t: Ticket = { v: 1, code: "c", inviter: { id: A, relay: null, direct: ["127.0.0.1:1"] } };
  const text = encodeTicket(t);
  expect(text.startsWith("meddle1")).toBe(true);
  expect(decodeTicket(text)).toEqual(t);
  expect(decodeTicket(`  ${text}\n`)).toEqual(t);
  expect(text).not.toContain("secret");
  expect(() => decodeTicket("meddle1!!!")).toThrow("not a meddle invite ticket");
  expect(() => decodeTicket("hello")).toThrow("not a meddle invite ticket");
  expect(() => decodeTicket(`meddle1${Buffer.from("{}").toString("base64url")}`)).toThrow("not a meddle invite ticket");
  expect(() => decodeTicket(encodeTicket({ ...t, inviter: { ...t.inviter, id: "nope" } }))).toThrow("not a meddle invite ticket");
  expect(() => decodeTicket(encodeTicket({ ...t, v: 2 } as unknown as Ticket))).toThrow("not a meddle invite ticket");
});

test("a node joins with a ticket and both rosters agree", async () => {
  const a = await inviter();
  const joiners: TestNode[] = [];
  try {
    await setToken(a.cfg, "tok");
    const aPool = a.store.pool();
    for (let i = 0; i < 5; i++) {
      const b = await joiner();
      joiners.push(b);
      const bId = b.identity.id;
      const ticket = createInvite(a.store, a.node.endpoint);
      expect(ticket.startsWith("meddle1")).toBe(true);
      expect(ticket).not.toContain(aPool.poolSecret);
      expect(Buffer.from(ticket.slice("meddle1".length), "base64url").toString()).not.toContain(aPool.poolSecret);
      expect(decodeTicket(ticket).inviter).toEqual(fromEndpoint(a.node.endpoint));

      const joined = await joinPool(decodeTicket(ticket), b.deps);

      expect(b.store.pool()).toMatchObject({ poolId: aPool.poolId, poolSecret: aPool.poolSecret });
      expect(joined.poolId).toBe(aPool.poolId);
      expect(joined.members).toBe(i + 2);
      for (const store of [a.store, b.store]) {
        const ids = store.members().map((r) => r.nodeId);
        expect(ids).toContain(a.id);
        expect(ids).toContain(bId);
        expect(store.row(a.id)!.hostname).toBe(summaryOf(a.id).hostname);
        expect(store.row(bId)!.hostname).toBe(summaryOf(bId).hostname);
      }
      expect(b.store.roster()).toHaveLength(a.store.roster().length);
      const bRow = a.store.row(bId)!;
      expect(bRow).toMatchObject({ status: "member", addedBy: a.id, lastAddr: fromEndpoint(b.endpoint) });
      expect(bRow.summary).toEqual({ ...summaryOf(bId), hostsTasks: false, taskCount: 0 });
      expect(b.store.row(bId)).toEqual(bRow);
      expect(b.store.row(a.id)!.lastAddr).toEqual(fromEndpoint(a.node.endpoint));
      // The inviter reports the admission once its reply is finished, which may be after the joiner has read it.
      await until(() => a.admitted.length === i + 1);
      expect(a.admitted.at(-1)).toEqual([bId, fromEndpoint(b.endpoint)]);
      expect(joined.addrs).toContainEqual(fromEndpoint(a.node.endpoint));
      expect(joined.addrs.map((x) => x.id)).not.toContain(bId);
      expect(new Set(joined.addrs.map((x) => x.id)).size).toBe(joined.addrs.length);
    }
    expect(a.admitted).toHaveLength(5);
    expect(a.errors).toEqual([]);
  } finally {
    await closeAll(joiners);
    await a.close();
  }
}, 15_000);

test("the welcome carries the pool, the roster and token metadata, never the token; a malformed request is refused", async () => {
  const a = await inviter();
  const b = await testNode();
  try {
    await setToken(a.cfg, "tok", { setAt: "2026-10-31T00:00:00.000Z" });
    const { code } = a.store.createInvite();
    const line = await rawJoin(b, fromEndpoint(a.node.endpoint), JSON.stringify({
      t: "join", code, addr: fromEndpoint(b.endpoint), hostname: "beta", version: "0.1.0", claudeCodeVersion: "2.0.0",
    }));
    expect(line).not.toBeNull();
    expect(line!.replaceAll('"token"', "")).not.toContain("tok");
    const reply = JSON.parse(line!) as JoinReply;
    if (reply.t !== "welcome") throw new Error(`expected welcome, got ${line}`);
    expect(reply.pool).toEqual({ id: a.store.pool().poolId, secret: a.store.pool().poolSecret });
    expect(reply.token).toEqual({ setAt: "2026-10-31T00:00:00.000Z", setBy: null });
    expect(reply.roster.map((r) => r.nodeId).sort()).toEqual([a.id, b.identity.id].sort());

    expect(await rawJoin(b, fromEndpoint(a.node.endpoint), "not json")).toBe(JSON.stringify({ t: "refused", reason: "bad join request" }));
    const unused = a.store.createInvite();
    const spoofed = JSON.stringify({
      t: "join", code: unused.code, addr: { id: A, relay: null, direct: [] }, hostname: "x", version: "0", claudeCodeVersion: "0",
    });
    expect(await rawJoin(b, fromEndpoint(a.node.endpoint), spoofed)).toBe(JSON.stringify({ t: "refused", reason: "bad join request" }));
    expect(a.store.consumeInvite(unused.code)).toBe(true);
    expect(a.store.row(A)).toBeNull();
  } finally {
    await closeAll([b]);
    await a.close();
  }
}, 15_000);

test("a wrong code is refused and a used ticket is refused for the next node", async () => {
  const a = await inviter();
  const b = await joiner();
  const c = await joiner();
  try {
    const ticket = decodeTicket(createInvite(a.store, a.node.endpoint));
    const bPool = b.store.pool();
    await expect(joinPool({ ...ticket, code: "wrong" }, b.deps)).rejects.toThrow("refused: unknown or expired invite");
    expect(b.store.pool()).toEqual(bPool);
    expect(a.store.row(b.identity.id)).toBeNull();

    await joinPool(ticket, b.deps);
    await until(() => a.admitted.length === 1);
    const cPool = c.store.pool();
    await expect(joinPool(ticket, c.deps)).rejects.toThrow("refused: unknown or expired invite");
    expect(c.store.pool()).toEqual(cPool);
    expect(a.store.row(c.identity.id)).toBeNull();
    expect(a.admitted.map(([id]) => id)).toEqual([b.identity.id]);
  } finally {
    await closeAll([b, c]);
    await a.close();
  }
}, 15_000);

test("a node already in a pool with others refuses to join", async () => {
  const a = await inviter();
  const b = await joiner();
  try {
    const ticket = decodeTicket(createInvite(a.store, a.node.endpoint));
    const self = b.store.row(b.identity.id)!;
    b.store.upsert({ ...self, nodeId: "c".repeat(64), hostname: "gamma" });
    await expect(joinPool(ticket, b.deps)).rejects.toThrow("already in a pool with 1 other node; remove it first");
    b.store.upsert({ ...self, nodeId: "d".repeat(64), hostname: "delta" });
    await expect(joinPool(ticket, b.deps)).rejects.toThrow("already in a pool with 2 other nodes; remove them first");
    expect(a.joins()).toBe(0);
    expect(a.store.consumeInvite(ticket.code)).toBe(true);
  } finally {
    await closeAll([b]);
    await a.close();
  }
}, 15_000);

test("a node removed from its pool may join another", async () => {
  const a = await inviter();
  const b = await joiner();
  try {
    const ticket = decodeTicket(createInvite(a.store, a.node.endpoint));
    const self = b.store.row(b.identity.id)!;
    b.store.upsert({ ...self, nodeId: "c".repeat(64), hostname: "gamma" });
    b.store.remove(b.identity.id);
    expect(await joinPool(ticket, b.deps)).toMatchObject({ poolId: a.store.pool().poolId, members: 2 });
    expect(b.store.isMember(b.identity.id)).toBe(true);
    expect(b.store.row("c".repeat(64))).toBeNull();
  } finally {
    await closeAll([b]);
    await a.close();
  }
}, 15_000);

test("a removed inviter refuses a joiner and leaves the invite unused", async () => {
  const a = await inviter();
  const b = await joiner();
  try {
    const ticket = decodeTicket(createInvite(a.store, a.node.endpoint));
    a.store.remove(a.id);
    const bPool = b.store.pool();
    await expect(joinPool(ticket, b.deps)).rejects.toThrow("refused: inviter is not a member");
    expect(b.store.pool()).toEqual(bPool);
    expect(a.store.row(b.identity.id)).toBeNull();
    expect(a.admitted).toEqual([]);
    expect(a.store.consumeInvite(ticket.code)).toBe(true);
  } finally {
    await closeAll([b]);
    await a.close();
  }
}, 15_000);
