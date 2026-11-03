// test/tunnel.test.ts — the dashboard tunnel: a browser on one node reaching another node's objects over iroh.
import { test, expect } from "bun:test";
import type { ServerWebSocket } from "bun";
import { createHost, webSocketLink, type Host } from "@earendil-works/chord";
import { startDashboard, type Dashboard } from "../src/dashboard/server";
import { IrohSocketShim, acceptDashboardStreams, bridgeSocket } from "../src/dashboard/tunnel";
import { BunSocketShim } from "../src/dashboard/ws-shim";
import { NodeObject, PoolObject } from "../src/state/contracts";
import { linkClient, linkNodes, startPoolNode, twoNodes } from "./pool-helpers";

type Node = Awaited<ReturnType<typeof startPoolNode>>;

const WAIT_MS = 10_000;

async function eventually(cond: () => boolean, ms = WAIT_MS): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(10);
  }
}

/** Starts `count` pool nodes, each accepting dashboard streams from its members; `run` gets them, all stopped after. */
async function withNodes(count: number, run: (nodes: Node[]) => Promise<void>): Promise<void> {
  const nodes: Node[] = [];
  const unsubscribes: (() => void)[] = [];
  try {
    for (let i = 0; i < count; i++) {
      const node = await startPoolNode();
      nodes.push(node);
      unsubscribes.push(acceptDashboardStreams(node.net, node.host, (id) => node.store.isMember(id)));
    }
    await run(nodes);
  } finally {
    for (const off of unsubscribes) off();
    for (const n of nodes) await n.close();
  }
}

/** Links the two nodes (both have the test pool's secret) and waits until each sees the other online. */
async function join(a: Node, b: Node): Promise<void> {
  await linkNodes(a, b);
  await eventually(() => a.net.isOnline(b.id) && b.net.isOnline(a.id));
}

/** A chord client host over a browser socket to `url`. */
function browserClient(url: string): { client: Host; socket: WebSocket } {
  const socket = new WebSocket(url);
  const client = createHost({ name: "browser", self: "browser", kind: "client", upstream: { link: webSocketLink(socket), principal: "node" } });
  return { client, socket };
}

/** Whether a WebSocket to `url` with `headers` opens (true) or is refused (false). */
function opens(url: string, headers: Record<string, string>): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, { headers } as any);
    socket.addEventListener("open", () => { socket.close(); resolve(true); });
    socket.addEventListener("error", () => resolve(false));
    socket.addEventListener("close", () => resolve(false));
  });
}

const UPGRADE = {
  Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
};

/** Records every IrohSocketShim started while `run` runs, with how often each dispatched `close`. */
async function spyShims(run: (shims: { closes: number }[]) => Promise<void>): Promise<void> {
  const shims: { closes: number }[] = [];
  const start = IrohSocketShim.prototype.start;
  IrohSocketShim.prototype.start = function (this: IrohSocketShim) {
    const seen = { closes: 0 };
    shims.push(seen);
    this.addEventListener("close", () => { seen.closes++; });
    start.call(this);
  };
  try {
    await run(shims);
  } finally {
    IrohSocketShim.prototype.start = start;
  }
}

test("a browser reaches a remote node's objects through the tunnel", async () => {
  await spyShims((shims) => withNodes(2, async ([A, B]) => {
    await join(A!, B!);
    let dashboard: Dashboard | undefined;
    const browsers: Host[] = [];
    try {
      dashboard = await startDashboard({ ...A!.cfg, port: 0 }, A!.host, A!.pool);
      const path = `${dashboard.url.replace("http", "ws")}ws/node/${B!.id}`;

      const first = browserClient(path);
      browsers.push(first.client);
      const node = await first.client.get(NodeObject, {});
      expect(node.nodeId.value).toBe(B!.id);
      const pool = await first.client.get(PoolObject, {});
      if (pool.variant !== "default") throw new Error("expected the default variant");
      expect(pool.self.value).toBe(B!.id);
      const { manifest, nodeId } = await node.createTask({ title: "t", projectIds: [B!.project.id] });
      expect(nodeId).toBe(B!.id);
      expect(B!.runner.state(manifest.id)).toBe("idle");
      node.release();
      pool.release();
      expect(shims).toHaveLength(1);

      // the browser leaves: B's end of the tunnel closes, once
      await first.client.close();
      await eventually(() => shims[0]!.closes > 0);
      await Bun.sleep(100);
      expect(shims[0]!.closes).toBe(1);

      // a fresh socket to the same path is a fresh tunnel
      const second = browserClient(path);
      browsers.push(second.client);
      const again = await second.client.get(NodeObject, {});
      expect(again.nodeId.value).toBe(B!.id);
      again.release();
      expect(shims).toHaveLength(2);

      // this node's own id is plain /ws
      const own = browserClient(`${dashboard.url.replace("http", "ws")}ws/node/${A!.id}`);
      browsers.push(own.client);
      const self = await own.client.get(NodeObject, {});
      expect(self.nodeId.value).toBe(A!.id);
      self.release();
      expect(shims).toHaveLength(2);
    } finally {
      for (const b of browsers) await b.close();
      await dashboard?.stop();
    }
  }));
}, 15_000);

test("unknown, removed and offline nodes fail fast; the tunnel path is gated like /ws", async () => {
  await withNodes(3, async ([A, B, C]) => {
    await join(A!, B!);
    await join(A!, C!);
    let dashboard: Dashboard | undefined;
    try {
      dashboard = await startDashboard({ ...A!.cfg, port: 0 }, A!.host, A!.pool);
      const url = dashboard.url;
      const port = new URL(url).port;

      const unknown = await fetch(`${url}ws/node/${"0".repeat(64)}`, { headers: UPGRADE });
      expect(unknown.status).toBe(404);
      expect(await unknown.text()).toBe("unknown node");
      const malformed = await fetch(`${url}ws/node/not-a-node`, { headers: UPGRADE });
      expect(malformed.status).toBe(404);
      expect(await malformed.text()).toBe("unknown node");

      // gated like /ws: another site's page, or the port under another name, never gets a tunnel
      const tunnel = `${url.replace("http", "ws")}ws/node/${B!.id}`;
      expect(await opens(tunnel, { Origin: "http://evil.example" })).toBe(false);
      expect((await fetch(`${url}ws/node/${B!.id}`, { headers: { ...UPGRADE, Origin: "http://evil.example" } })).status).toBe(403);
      expect((await fetch(`${url}ws/node/${B!.id}`, { headers: { ...UPGRADE, Host: `other.example:${port}` } })).status).toBe(403);
      expect(await opens(tunnel, { Origin: url.slice(0, -1) })).toBe(true);

      // an offline member answers 503 at once
      await C!.net.stop();
      await eventually(() => !A!.net.isOnline(C!.id));
      const started = Date.now();
      const offline = await fetch(`${url}ws/node/${C!.id}`, { headers: UPGRADE });
      expect(Date.now() - started).toBeLessThan(1000);
      expect(offline.status).toBe(503);
      expect(await offline.text()).toBe("node offline");

      // a removed node is unknown
      await A!.pool.remove(B!.id);
      const removed = await fetch(`${url}ws/node/${B!.id}`, { headers: UPGRADE });
      expect(removed.status).toBe(404);
      expect(await removed.text()).toBe("unknown node");
    } finally {
      await dashboard?.stop();
    }
  });
}, 15_000);

test("without a pool the tunnel path answers 404", async () => {
  const node = await startPoolNode();
  let dashboard: Dashboard | undefined;
  try {
    dashboard = await startDashboard({ ...node.cfg, port: 0 }, node.host);
    const response = await fetch(`${dashboard.url}ws/node/${node.id}`, { headers: UPGRADE });
    expect(response.status).toBe(404);
  } finally {
    await dashboard?.stop();
    await node.close();
  }
}, 15_000);

test("the tunnel carries binary frames both ways", async () => {
  const pair = await twoNodes();
  const { a, b } = pair;
  type Data = { shim?: BunSocketShim };
  const server = Bun.serve<Data, never>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      return server.upgrade(request, { data: {} }) ? undefined : new Response("expected a WebSocket upgrade", { status: 400 });
    },
    websocket: {
      open(ws: ServerWebSocket<Data>) {
        const shim = new BunSocketShim(ws as ServerWebSocket<unknown>);
        ws.data.shim = shim;
        void bridgeSocket(shim, a.net, b.id);
      },
      message(ws: ServerWebSocket<Data>, data) {
        ws.data.shim?.dispatchMessage(data);
      },
      close(ws: ServerWebSocket<Data>) {
        ws.data.shim?.dispatchClose();
      },
    },
  });
  let remote: IrohSocketShim | undefined;
  let browser: WebSocket | undefined;
  try {
    await eventually(() => a.net.isOnline(b.id));
    const atRemote: unknown[] = [];
    const remoteReady = Promise.withResolvers<IrohSocketShim>();
    const off = b.net.onStream((s) => {
      if (s.header.stream !== "dashboard") return false;
      const shim = new IrohSocketShim(s);
      shim.addEventListener("message", (event) => atRemote.push(event.data));
      shim.start();
      remoteReady.resolve(shim);
      return true;
    });
    try {
      browser = new WebSocket(`ws://127.0.0.1:${server.port}/`);
      browser.binaryType = "arraybuffer";
      const atBrowser: unknown[] = [];
      browser.addEventListener("message", (event) => atBrowser.push(event.data));
      await new Promise((resolve, reject) => {
        browser!.addEventListener("open", resolve);
        browser!.addEventListener("error", reject);
      });

      const mib = (seed: number) => Uint8Array.from({ length: 1024 * 1024 }, (_, i) => (i * 31 + seed) & 0xff);
      const up = mib(7);
      browser.send(up);
      browser.send("hello remote");
      remote = await remoteReady.promise;
      await eventually(() => atRemote.length === 2);
      expect(atRemote[0]).toBeInstanceOf(Uint8Array);
      expect(Buffer.from(atRemote[0] as Uint8Array).equals(Buffer.from(up))).toBe(true);
      expect(atRemote[1]).toBe("hello remote");

      const down = mib(13);
      remote.send(down);
      remote.send("hello browser");
      await eventually(() => atBrowser.length === 2);
      expect(atBrowser[0]).toBeInstanceOf(ArrayBuffer);
      expect(Buffer.from(atBrowser[0] as ArrayBuffer).equals(Buffer.from(down))).toBe(true);
      expect(atBrowser[1]).toBe("hello browser");

      // the remote end closes: the browser's socket is closed 1011 `tunnel closed`
      const closed = Promise.withResolvers<{ code: number; reason: string }>();
      browser.addEventListener("close", (event) => closed.resolve({ code: event.code, reason: event.reason }));
      remote.close();
      expect(remote.readyState).toBe(3);
      expect(await closed.promise).toEqual({ code: 1011, reason: "tunnel closed" });
    } finally {
      off();
    }
  } finally {
    browser?.close();
    remote?.close();
    await server.stop(true);
    await pair.close();
  }
}, 15_000);
