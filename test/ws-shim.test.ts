// test/ws-shim.test.ts
import { test, expect } from "bun:test";
import { createHost, webSocketLink, type Host } from "@earendil-works/chord";
import { startDashboard } from "../src/dashboard/server";
import { NodeObject } from "../src/state/host";
import { VERSION } from "../src/version";
import { startPoolNode } from "./pool-helpers";

test("the dashboard serves the UI and a chord link on /ws", async () => {
  const node = await startPoolNode();
  const { host } = node;
  let dashboard: Awaited<ReturnType<typeof startDashboard>> | undefined;
  let client: Host | undefined;
  try {
    dashboard = await startDashboard({ ...node.cfg, port: 0 }, host);
    expect(dashboard.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);

    const page = await fetch(dashboard.url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<html");
    const script = await fetch(`${dashboard.url}main.js`);
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toContain("javascript");
    expect((await script.text()).length).toBeGreaterThan(0);

    const socket = new WebSocket(`${dashboard.url.replace("http", "ws")}ws`);
    client = createHost({ name: "client", self: "client", kind: "client", upstream: { link: webSocketLink(socket), principal: "node" } });
    const nodeObject = await client.get(NodeObject, {});
    expect(nodeObject.version.value).toBe(VERSION);
    expect(nodeObject.projectIds.value).toContain(node.project.id);
    nodeObject.release();

    // another site's page, or a request reaching the port under another name, never gets a link
    const ws = `${dashboard.url.replace("http", "ws")}ws`;
    expect(await opens(ws, { Origin: "http://evil.example" })).toBe(false);
    expect((await fetch(`${dashboard.url}ws`, { headers: { Origin: "http://evil.example" } })).status).toBe(403);
    expect((await fetch(dashboard.url, { headers: { Host: `evil.example:${new URL(dashboard.url).port}` } })).status).toBe(403);
    // the dashboard's own page does
    const own = new WebSocket(ws, { headers: { Origin: dashboard.url.slice(0, -1) } } as any);
    const ownClient = createHost({ name: "own", self: "own", kind: "client", upstream: { link: webSocketLink(own), principal: "node" } });
    try {
      const fromOwnPage = await ownClient.get(NodeObject, {});
      expect(fromOwnPage.version.value).toBe(VERSION);
      fromOwnPage.release();
    } finally {
      await ownClient.close();
    }
  } finally {
    await client?.close();
    await dashboard?.stop();
    await node.close();
  }
});

/** Whether a WebSocket to `url` with `headers` opens (true) or is refused (false). */
function opens(url: string, headers: Record<string, string>): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, { headers } as any);
    socket.addEventListener("open", () => { socket.close(); resolve(true); });
    socket.addEventListener("error", () => resolve(false));
    socket.addEventListener("close", () => resolve(false));
  });
}
