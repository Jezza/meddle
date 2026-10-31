// test/ws-shim.test.ts
import { test, expect } from "bun:test";
import { createHost, webSocketLink, type Host } from "@earendil-works/chord";
import { startDashboard } from "../src/dashboard/server";
import { createNodeHost, NodeObject } from "../src/state/host";
import { MetricsSampler } from "../src/metrics";
import { VERSION } from "../src/version";
import { setupNode } from "./helpers";

test("the dashboard serves the UI and a chord link on /ws", async () => {
  const node = await setupNode();
  const metrics = new MetricsSampler({ taskPids: () => ({}), intervalMs: 60_000, dataDir: node.cfg.dataDir });
  const host = createNodeHost({ cfg: node.cfg, db: node.db, runner: node.runner, metrics, claudeCodeVersion: "0.0.0" });
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
  } finally {
    await client?.close();
    await dashboard?.stop();
    await host.close();
    await node.harness.close();
  }
});
