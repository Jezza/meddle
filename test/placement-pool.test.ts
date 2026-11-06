// test/placement-pool.test.ts — a new task is placed on a node of the pool and created there.
import { loadConfig } from "../src/config";
import { test, expect } from "bun:test";
import { createHost, memoryLinkPair, type Subscribable } from "@earendil-works/chord";
import { NodeObject, PeerObject } from "../src/state/contracts";
import { servePeer } from "../src/state/host";
import { listEvents } from "../src/store/events";
import { getTask } from "../src/store/records";
import { openDb } from "../src/store/db";
import { linkClient, peerReady, twoPoolNodes, type GitPoolNode } from "./pool-helpers";
import { createTask } from "./helpers";

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
      const auto = await nodeA.createTask({ title: "t", projects: [{ id: B.project.id }], node: null });
      expect(auto.nodeId).toBe(B.id);
      expect(getTask(B.db, auto.manifest.id)?.title).toBe("t");
      expect(getTask(A.db, auto.manifest.id)).toBeNull();
      // B's own NodeObject lists it, and the pool hears of it.
      await eventually(() => A.store.row(B.id)?.summary?.taskCount === 1, () => "A to see B's new task");

      const absent = await nodeA.createTask({ title: "u", projects: [{ id: B.project.id }] });
      expect(absent.nodeId).toBe(B.id);

      const here = await nodeA.createTask({ title: "h", projects: [{ id: B.project.id }], node: "here" });
      expect(here.nodeId).toBe(A.id);
      expect(getTask(A.db, here.manifest.id)?.title).toBe("h");
      expect(getTask(B.db, here.manifest.id)).toBeNull();

      const named = await nodeA.createTask({ title: "n", projects: [{ id: A.project.id }], node: B.id });
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
    const busy = await createTask(B, { title: "busy", projectIds: [B.project.id] });
    await B.runner.prompt(busy.id, "Reply with the single word ok.");
    await eventually(() => A.store.row(B.id)?.summary?.running === 1, () => `A to see B running: ${JSON.stringify(A.store.row(B.id)?.summary)}`);

    const nodeA = await linked.client.get(NodeObject, {});
    try {
      const placed = await nodeA.createTask({ title: "t", projects: [{ id: B.project.id }], node: null });
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
      const created = await nodeA.createTask({ title: "t", projects: [{ id: B.project.id }], node: null, prompt: "Reply with the single word ok." });
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

test("PeerObject.createTaskAt refuses a peer that is not a member, before creating anything", async () => {
  const db = openDb(":memory:");
  const created: unknown[] = [];
  const never: Subscribable<null> = { subscribe: () => () => {} };
  const host = createHost({ name: "node", self: "node" });
  servePeer(host, {
    cfg: loadConfig({}),
    db,
    selfId: "self",
    claudeCodeVersion: "2.0.0",
    hostsTasks: async () => true,
    changes: never,
    isMember: () => false,
    runner: {
      receiveTask: async () => ({ ok: false, reason: "no" }),
      activateTask: async () => ({ ok: false }),
      abandonTask: async () => {},
      create: async (input) => { created.push(input); throw new Error("not reached"); },
      prompt: async () => { created.push("prompt"); return "turn" as const; },
    },
  });
  const [down, up] = memoryLinkPair();
  host.accept(down, { principal: `peer:${"f".repeat(64)}`, kind: "client" });
  const client = createHost({ name: "peer", self: "peer", kind: "client", upstream: { link: up, principal: "node" } });
  try {
    const peer = await client.get(PeerObject, {});
    if (peer.variant !== "peer") throw new Error("expected the peer variant");
    let refusal: unknown = null;
    await peer.createTaskAt({ title: "t", taskId: "0123456789ab", starts: [{ projectId: "p", kind: "sync", branch: "main" }], prompt: "hi" })
      .catch((err: unknown) => { refusal = err; });
    expect(refusal).toMatchObject({ code: "forbidden" });
    expect(created).toEqual([]);
    peer.release();
  } finally {
    await client.close();
    await host.close();
  }
});

test("with the home unreachable, placement picks a node holding a replica, which starts the task from the sync branch it last fetched", async () => {
  const { writeFile } = await import("node:fs/promises");
  const { jj } = await import("../src/jj");
  const { paths } = await import("../src/config");
  const { setProjectSync } = await import("../src/projects/project");
  const { A, B, close } = await twoPoolNodes();
  const linked = linkClient(B.host);
  try {
    // A is the home of its project, whose sync branch is `main`.
    const repo = A.project.replica;
    await writeFile(`${repo}/README`, "hello\n");
    await jj(["commit", "-m", "hello"], repo, A.cfg);
    await jj(["bookmark", "set", "main", "-r", "@-"], repo, A.cfg);
    setProjectSync(A.db, A.project.id, ["main"]);
    const main = (await jj(["log", "-r", "main", "--no-graph", "-T", "commit_id"], repo, A.cfg)).trim();
    await peerReady(B, A);
    const nodeB = await linked.client.get(NodeObject, {});
    try {
      // B fetches `main` as it creates a first task from it.
      const first = await nodeB.createTask({ title: "first", projects: [{ id: A.project.id, rev: "main" }], node: "here" });
      expect(first.manifest.projects[0]!.base).toBe(main);

      await A.net.stop();
      await eventually(() => !B.net.isOnline(A.id), () => "B to see A offline");
      const placed = await nodeB.createTask({ title: "second", projects: [{ id: A.project.id, rev: "main" }], node: null });
      expect(placed.nodeId).toBe(B.id);
      expect(placed.manifest.projects[0]!.base).toBe(main);
      const workspace = `${paths(B.cfg).task(placed.manifest.id)}/a`;
      expect((await jj(["log", "-r", "@-", "--no-graph", "-T", "commit_id"], workspace, B.cfg)).trim()).toBe(main);
      expect(B.logs.filter((l) => l.includes("home offline"))).toEqual([
        "meddle: project a: home offline; starting from main as fetched last",
      ]);
    } finally {
      nodeB.release();
    }
  } finally {
    await linked.close();
    await close();
  }
}, 60_000);

test("a peer's refusal of a create names the node that refused", async () => {
  const { rm } = await import("node:fs/promises");
  const { shortId } = await import("../src/pool/ids");
  const { A, B, close } = await twoPoolNodes();
  const linked = linkClient(A.host);
  try {
    await peerReady(A, B);
    await rm(B.cfg.taskRoot, { recursive: true, force: true });
    const nodeA = await linked.client.get(NodeObject, {});
    try {
      let refusal: unknown = null;
      await nodeA.createTask({ title: "t", projects: [], node: B.id }).catch((err: unknown) => { refusal = err; });
      expect(refusal).toBeInstanceOf(Error);
      const message = (refusal as Error).message;
      expect(message).toContain(`${shortId(B.id)}: task root ${B.cfg.taskRoot} does not exist`);
    } finally {
      nodeA.release();
    }
  } finally {
    await linked.close();
    await close();
  }
}, 60_000);

test("with no other node online, an automatic create says why this node cannot take the task", async () => {
  const { rm } = await import("node:fs/promises");
  const { startPoolNode } = await import("./pool-helpers");
  const rootless = await startPoolNode();
  const full = await startPoolNode(undefined, { MEDDLE_MAX_RUNNING: "1", MEDDLE_FIXTURE_STALL: "1" });
  const one = linkClient(rootless.host);
  const two = linkClient(full.host);
  try {
    await rm(rootless.cfg.taskRoot, { recursive: true, force: true });
    const nodeOne = await one.client.get(NodeObject, {});
    await expect(nodeOne.createTask({ title: "t", projects: [], node: null })).rejects.toThrow("this node has no task root");
    nodeOne.release();

    const busy = await createTask(full, { title: "busy", projectIds: [] });
    await full.runner.prompt(busy.id, "Reply with the single word ok.");
    await eventually(() => full.runner.running() === 1, () => "the stalled turn to run");
    const nodeTwo = await two.client.get(NodeObject, {});
    await expect(nodeTwo.createTask({ title: "t", projects: [], node: null })).rejects.toThrow("this node is at its running limit; use --here");
    const here = await nodeTwo.createTask({ title: "h", projects: [], node: "here" });
    expect(here.nodeId).toBe(full.id);
    nodeTwo.release();
  } finally {
    await one.close();
    await two.close();
    await rootless.close();
    await full.close();
  }
}, 60_000);
