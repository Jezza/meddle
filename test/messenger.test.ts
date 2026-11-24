// test/messenger.test.ts
import { test, expect } from "bun:test";
import { Messenger } from "../src/tasks/messenger";
import { PeerObject } from "../src/state/contracts";
import { listEvents } from "../src/store/events";
import type { PoolRuntime } from "../src/pool/runtime";
import { createTask } from "./helpers";
import { peerReady, twoPoolNodes } from "./pool-helpers";

const A = "a".repeat(64), B = "b".repeat(64), C = "c".repeat(64);
const from = { taskId: "111111111111", nodeId: A, title: "Sender" };
type Peer = { tasks?: () => Promise<unknown>; message?: (i: unknown) => Promise<unknown> };

/** A pool stand-in: members by id, each online or not, with the peer methods it serves. */
function pool(members: Record<string, { online: boolean; name: string; peer?: Peer }>): PoolRuntime {
  return {
    identity: { id: A },
    store: {
      members: () => [{ nodeId: A }, ...Object.keys(members).map((nodeId) => ({ nodeId }))],
      row: (id: string) => ({ hostname: id === A ? "alpha" : members[id]?.name ?? null }),
    },
    net: { isOnline: (id: string) => members[id]?.online ?? false },
    peerRef: async (id: string) => {
      const m = members[id];
      if (m === undefined || !m.online) throw new Error(`not connected to ${id.slice(0, 8)}`);
      return { variant: "peer", ...m.peer, release() {} };
    },
  } as unknown as PoolRuntime;
}

function runner(live: Array<{ id: string; title: string; state: string }> = []) {
  const sent: unknown[] = [];
  return {
    sent,
    listLive: () => live,
    message: async (to: string, f: unknown, text: string) => { sent.push({ to, from: f, text }); return "waking" as const; },
  };
}

test("directory lists this node's tasks and each online member's", async () => {
  const m = new Messenger({
    selfId: A, runner: runner([{ id: "222222222222", title: "Here", state: "idle" }]),
    pool: pool({
      [B]: { online: true, name: "bravo", peer: { tasks: async () => [{ id: "333333333333", title: "There", state: "running" }] } },
      [C]: { online: false, name: "charlie" },
    }),
  });
  expect(await m.directory()).toEqual([
    { id: "222222222222", title: "Here", state: "idle", nodeId: A, nodeName: "alpha" },
    { id: "333333333333", title: "There", state: "running", nodeId: B, nodeName: "bravo" },
  ]);
});

test("a member without tasks() is left out", async () => {
  const m = new Messenger({ selfId: A, runner: runner(), pool: pool({ [B]: { online: true, name: "bravo", peer: {} } }) });
  expect(await m.directory()).toEqual([]);
});

test("a hung member is left out after the timeout", async () => {
  const m = new Messenger({
    selfId: A, runner: runner(), memberMs: 100,
    pool: pool({ [B]: { online: true, name: "bravo", peer: { tasks: () => new Promise(() => {}) } } }),
  });
  const started = Date.now();
  expect(await m.directory()).toEqual([]);
  expect(Date.now() - started).toBeLessThan(1000);
});

test("send to this node's task goes to the runner", async () => {
  const r = runner([{ id: "222222222222", title: "Here", state: "idle" }]);
  const m = new Messenger({ selfId: A, runner: r });
  expect(await m.send(from, "222222222222", "hi")).toEqual({ ok: true, how: "waking", title: "Here" });
  expect(r.sent).toEqual([{ to: "222222222222", from, text: "hi" }]);
});

test("send to a remote task calls its holder's message", async () => {
  const calls: unknown[] = [];
  const m = new Messenger({
    selfId: A, runner: runner(),
    pool: pool({ [B]: { online: true, name: "bravo", peer: {
      tasks: async () => [{ id: "333333333333", title: "There", state: "running" }],
      message: async (i) => { calls.push(i); return "delivered"; },
    } } }),
  });
  expect(await m.send(from, "333333333333", "hi")).toEqual({ ok: true, how: "delivered", title: "There" });
  expect(calls).toEqual([{ to: "333333333333", from, text: "hi" }]);
});

test("send to an unknown id fails", async () => {
  const m = new Messenger({ selfId: A, runner: runner() });
  expect(await m.send(from, "999999999999", "hi")).toEqual({ ok: false, reason: "no task 999999999999" });
});

test("send to a task of an offline node says so", async () => {
  const m = new Messenger({ selfId: A, runner: runner(), pool: pool({ [B]: { online: false, name: "bravo" } }), holderOf: (id) => (id === "333333333333" ? B : null) });
  expect(await m.send(from, "333333333333", "hi")).toEqual({ ok: false, reason: "node bravo is offline" });
});

test("send to itself fails", async () => {
  const m = new Messenger({ selfId: A, runner: runner([{ id: from.taskId, title: "Sender", state: "running" }]) });
  expect(await m.send(from, from.taskId, "hi")).toEqual({ ok: false, reason: "that is this task" });
});

test("send over 256 KiB fails", async () => {
  const m = new Messenger({ selfId: A, runner: runner([{ id: "222222222222", title: "Here", state: "idle" }]) });
  expect(await m.send(from, "222222222222", "x".repeat(256 * 1024 + 1))).toEqual({ ok: false, reason: "message is over 256 KiB" });
});

test("a refusal comes back as the holder's reason", async () => {
  const m = new Messenger({
    selfId: A, runner: runner(),
    pool: pool({ [B]: { online: true, name: "bravo", peer: {
      tasks: async () => [{ id: "333333333333", title: "There", state: "idle" }],
      message: async () => { throw new Error("task is archived: 333333333333"); },
    } } }),
  });
  expect(await m.send(from, "333333333333", "hi")).toEqual({ ok: false, reason: "task is archived: 333333333333" });
});

test("a message reaches a task on another node, and wakes it", async () => {
  const { A: a, B: b, close } = await twoPoolNodes({ extraEnv: { MEDDLE_FIXTURE_PEER: "1" } });
  try {
    const target = await createTask(b, { title: "Target", projectIds: [b.project.id] });
    await peerReady(a, b);
    // B lists it to its peers
    const peer = await a.pool.peerRef(b.id, PeerObject);
    try {
      if (peer.variant !== "peer") throw new Error("not the peer variant");
      expect((await peer.tasks({})).map((t) => t.id)).toContain(target.id);
    } finally {
      peer.release();
    }
    const m = new Messenger({ selfId: a.id, runner: a.runner, pool: a.pool });
    expect(await m.send({ taskId: "111111111111", nodeId: a.id, title: "Sender" }, target.id, "hi")).toEqual({ ok: true, how: "waking", title: "Target" });
    const end = Date.now() + 20_000;
    while (!listEvents(b.db, target.id).some((e) => (e.message as any).subtype === "peer_message")) {
      if (Date.now() > end) throw new Error("not delivered");
      await Bun.sleep(50);
    }
    expect(listEvents(b.db, target.id).map((e) => e.message as any).find((e) => e.subtype === "peer_message")).toMatchObject({
      from: { taskId: "111111111111", nodeId: a.id }, text: "hi",
    });
  } finally {
    await close();
  }
}, 90_000);

/** A pool whose member B is online but never hands over its PeerObject. */
function hungPool(): PoolRuntime {
  return {
    identity: { id: A },
    store: { members: () => [{ nodeId: A }, { nodeId: B }], row: (id: string) => ({ hostname: id === A ? "alpha" : "bravo" }) },
    net: { isOnline: () => true },
    peerRef: () => new Promise(() => {}),
  } as unknown as PoolRuntime;
}

test("a member whose PeerObject never comes is left out of the listing in time", async () => {
  const m = new Messenger({ selfId: A, runner: runner(), pool: hungPool(), memberMs: 100 });
  const started = Date.now();
  expect(await m.directory()).toEqual([]);
  expect(Date.now() - started).toBeLessThan(1000);
});

test("a holder that never answers a send fails it in time", async () => {
  const pool = pool2();
  const m = new Messenger({ selfId: A, runner: runner(), pool, sendMs: 150 });
  const started = Date.now();
  expect(await m.send(from, "333333333333", "hi")).toEqual({ ok: false, reason: "node bravo did not answer" });
  expect(Date.now() - started).toBeLessThan(1500);
});

/** Member B lists a task but never answers `message`. */
function pool2(): PoolRuntime {
  return pool({ [B]: { online: true, name: "bravo", peer: {
    tasks: async () => [{ id: "333333333333", title: "There", state: "idle" }],
    message: () => new Promise(() => {}),
  } } });
}
