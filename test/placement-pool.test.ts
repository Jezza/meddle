// test/placement-pool.test.ts — a new task is placed on a node of the pool and created there.
import { test, expect } from "bun:test";
import { createHost, memoryLinkPair, type Subscribable } from "@earendil-works/chord";
import { NodeObject, PeerObject } from "../src/state/contracts";
import { servePeer } from "../src/state/host";
import { listEvents } from "../src/store/events";
import { getTask } from "../src/store/records";
import { openDb } from "../src/store/db";
import { linkClient, peerReady, twoPoolNodes, type GitPoolNode } from "./pool-helpers";

async function eventually(cond: () => boolean, what: () => string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting: ${what()}`);
    await Bun.sleep(10);
  }
}

/** Waits until `viewer`'s roster has `of`'s summary listing project `projectId`. */
function knowsProject(viewer: GitPoolNode, of: GitPoolNode, projectId: string): Promise<void> {
  return eventually(
    () => viewer.store.row(of.id)?.summary?.projects.some((p) => p.id === projectId) === true,
    () => `${viewer.id.slice(0, 6)} to hear of ${of.id.slice(0, 6)}'s project: ${JSON.stringify(viewer.store.row(of.id)?.summary)}`,
  );
}

test("auto places a task on its project's home and creates it there; here keeps it on this node", async () => {
  const { A, B, close } = await twoPoolNodes();
  const linked = linkClient(A.host);
  try {
    await peerReady(A, B);
    await peerReady(B, A);
    await knowsProject(A, B, B.project.id);
    const nodeA = await linked.client.get(NodeObject, {});
    try {
      const auto = await nodeA.createTask({ title: "t", projectIds: [B.project.id], node: null });
      expect(auto.nodeId).toBe(B.id);
      expect(getTask(B.db, auto.manifest.id)?.title).toBe("t");
      expect(getTask(A.db, auto.manifest.id)).toBeNull();
      // B's own NodeObject lists it, and the pool hears of it.
      await eventually(() => A.store.row(B.id)?.summary?.taskCount === 1, () => "A to see B's new task");

      const absent = await nodeA.createTask({ title: "u", projectIds: [B.project.id] });
      expect(absent.nodeId).toBe(B.id);

      const here = await nodeA.createTask({ title: "h", projectIds: [B.project.id], node: "here" });
      expect(here.nodeId).toBe(A.id);
      expect(getTask(A.db, here.manifest.id)?.title).toBe("h");
      expect(getTask(B.db, here.manifest.id)).toBeNull();

      const named = await nodeA.createTask({ title: "n", projectIds: [A.project.id], node: B.id });
      expect(named.nodeId).toBe(B.id);
      expect(getTask(B.db, named.manifest.id)?.title).toBe("n");
    } finally {
      nodeA.release();
    }
  } finally {
    await linked.close();
    await close();
  }
}, 60_000);

test("a home at its running limit is passed over for a node with room", async () => {
  // B allows one running task, and its one task's turn stalls before its result.
  const { A, B, close } = await twoPoolNodes({ nodes: [{}, { extraEnv: { MEDDLE_MAX_RUNNING: "1", MEDDLE_FIXTURE_STALL: "1" } }] });
  const linked = linkClient(A.host);
  try {
    await peerReady(A, B);
    await peerReady(B, A);
    await knowsProject(A, B, B.project.id);
    await eventually(() => A.store.row(B.id)?.summary?.limit === 1, () => `A to hear B's limit: ${JSON.stringify(A.store.row(B.id)?.summary)}`);
    const busy = await B.runner.create({ title: "busy", projectIds: [B.project.id] });
    await B.runner.prompt(busy.id, "Reply with the single word ok.");
    await eventually(() => A.store.row(B.id)?.summary?.running === 1, () => `A to see B running: ${JSON.stringify(A.store.row(B.id)?.summary)}`);

    const nodeA = await linked.client.get(NodeObject, {});
    try {
      const placed = await nodeA.createTask({ title: "t", projectIds: [B.project.id], node: null });
      expect(placed.nodeId).toBe(A.id);
      expect(getTask(A.db, placed.manifest.id)?.title).toBe("t");
    } finally {
      nodeA.release();
    }
  } finally {
    await linked.close();
    await close();
  }
}, 60_000);

test("a prompt given with the task runs as its first turn on the node chosen", async () => {
  const { A, B, close } = await twoPoolNodes();
  const linked = linkClient(A.host);
  try {
    await peerReady(A, B);
    await peerReady(B, A);
    await knowsProject(A, B, B.project.id);
    const nodeA = await linked.client.get(NodeObject, {});
    try {
      const created = await nodeA.createTask({ title: "t", projectIds: [B.project.id], node: null, prompt: "Reply with the single word ok." });
      expect(created.nodeId).toBe(B.id);
      const id = created.manifest.id;
      const messages = () => listEvents(B.db, id).map((e) => e.message as any);
      await eventually(() => messages().some((m) => m.type === "result"), () => `B's turn: ${JSON.stringify(messages().map((m) => m.subtype ?? m.type))}`, 20_000);
      const prompts = messages().filter((m) => m.type === "user" && typeof m.message?.content === "string").map((m) => m.message.content);
      expect(prompts).toEqual(["Reply with the single word ok."]);
      expect(messages().find((m) => m.type === "result")?.subtype).toBe("success");
      expect(listEvents(A.db, id)).toEqual([]);
    } finally {
      nodeA.release();
    }
  } finally {
    await linked.close();
    await close();
  }
}, 60_000);

test("PeerObject.createTask refuses a peer that is not a member, before creating anything", async () => {
  const db = openDb(":memory:");
  const created: unknown[] = [];
  const never: Subscribable<null> = { subscribe: () => () => {} };
  const host = createHost({ name: "node", self: "node" });
  servePeer(host, {
    db,
    claudeCodeVersion: "2.0.0",
    hostsTasks: async () => true,
    changes: never,
    isMember: () => false,
    runner: {
      receiveTask: async () => ({ ok: false, reason: "no" }),
      activateTask: async () => ({ ok: false }),
      abandonTask: async () => {},
      create: async (input) => { created.push(input); throw new Error("not reached"); },
      prompt: async () => { created.push("prompt"); },
    },
  });
  const [down, up] = memoryLinkPair();
  host.accept(down, { principal: `peer:${"f".repeat(64)}`, kind: "client" });
  const client = createHost({ name: "peer", self: "peer", kind: "client", upstream: { link: up, principal: "node" } });
  try {
    const peer = await client.get(PeerObject, {});
    if (peer.variant !== "peer") throw new Error("expected the peer variant");
    let refusal: unknown = null;
    await peer.createTask({ title: "t", projectIds: ["p"], prompt: "hi" }).catch((err: unknown) => { refusal = err; });
    expect(refusal).toMatchObject({ code: "forbidden" });
    expect(created).toEqual([]);
    peer.release();
  } finally {
    await client.close();
    await host.close();
  }
});
