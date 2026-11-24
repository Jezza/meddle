// test/dashboard-origin.test.ts — the dashboard behind a proxy on MEDDLE_DASHBOARD_ORIGIN, as nginx forwards it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHost } from "@earendil-works/chord";
import { BlobFetcher } from "../src/blobs/pool";
import { BlobStore } from "../src/blobs/store";
import { startDashboard, type Dashboard } from "../src/dashboard/server";

const ORIGIN = "https://meddle.example.com";
const proxied = { host: "meddle.example.com", origin: ORIGIN };

let home: string;
let dashboard: Dashboard;
let url: string;

beforeAll(async () => {
  home = await mkdtemp("/tmp/dashboard-origin-");
  const blobs = new BlobFetcher(new BlobStore(join(home, "blobs")), null);
  dashboard = await startDashboard({ port: 0, dashboardOrigin: ORIGIN }, createHost({ name: "node", self: "node" }), undefined, blobs);
  url = dashboard.url;
});
afterAll(async () => {
  await dashboard.stop();
  await rm(home, { recursive: true, force: true });
});

/** Whether a socket on /ws with `headers` opens, rather than being refused. */
function opens(headers: Record<string, string>): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${url.replace("http", "ws")}ws`, { headers } as unknown as string[]);
    ws.onopen = () => { ws.close(); resolve(true); };
    ws.onerror = () => resolve(false);
  });
}

test("the proxy's requests reach the node: the page, an upload and the socket", async () => {
  expect((await fetch(url, { headers: { host: proxied.host } })).status).toBe(200);
  expect((await fetch(`${url}blobs`, { method: "PUT", body: "x", headers: proxied })).status).toBe(200);
  expect(await opens(proxied)).toBe(true);
});

test("localhost still works beside the proxy", async () => {
  expect((await fetch(url)).status).toBe(200);
  expect(await opens({ origin: url.slice(0, -1) })).toBe(true);
});

test("another site's page cannot drive the node through the proxy, nor can another name", async () => {
  const evil = { host: proxied.host, origin: "https://evil.example" };
  expect((await fetch(`${url}blobs`, { method: "PUT", body: "x", headers: evil })).status).toBe(403);
  expect(await opens(evil)).toBe(false);
  // the origin's scheme counts: a plain-http page on the same name is another origin
  expect(await opens({ host: proxied.host, origin: "http://meddle.example.com" })).toBe(false);
  expect((await fetch(url, { headers: { host: "other.example.com" } })).status).toBe(403);
});

test("without a dashboard origin, the proxy's name is refused", async () => {
  const local = await startDashboard({ port: 0 }, createHost({ name: "node", self: "node" }));
  try {
    expect((await fetch(local.url, { headers: { host: proxied.host } })).status).toBe(403);
  } finally {
    await local.stop();
  }
});
