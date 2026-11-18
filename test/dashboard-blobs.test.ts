// test/dashboard-blobs.test.ts — a browser uploading a file to its node and downloading one by its hash.
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHost } from "@earendil-works/chord";
import { MAX_BLOB_BYTES } from "../src/blobs/attachment";
import { BlobFetcher } from "../src/blobs/pool";
import { BlobStore } from "../src/blobs/store";
import { startDashboard, type Dashboard } from "../src/dashboard/server";

const sha = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

let store: BlobStore;
let dashboard: Dashboard;
let url: string;

beforeAll(async () => {
  store = new BlobStore(join(await mkdtemp("/tmp/dashboard-blobs-"), "blobs"));
  dashboard = await startDashboard({ port: 0 }, createHost({ name: "node", self: "node" }), undefined, new BlobFetcher(store, null));
  url = dashboard.url;
});
afterAll(async () => {
  await dashboard.stop();
});

const temps = async () => (await readdir(store.dir)).filter((f) => f.startsWith(".tmp-"));

test("an upload answers its hash and downloads back", async () => {
  const up = await fetch(`${url}blobs`, { method: "PUT", body: "hello" });
  expect(up.status).toBe(200);
  expect(await up.json()).toEqual({ hash: sha("hello"), size: 5 });
  const down = await fetch(`${url}blobs/${sha("hello")}?type=image/png&name=a.png`);
  expect(down.status).toBe(200);
  expect(down.headers.get("content-type")).toBe("image/png");
  expect(down.headers.get("content-disposition")).toBe("inline");
  expect(down.headers.get("x-content-type-options")).toBe("nosniff");
  expect(down.headers.get("content-security-policy")).toBe("sandbox");
  expect(down.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
  expect(await down.text()).toBe("hello");
});

test("anything but the four image types downloads as a file", async () => {
  await fetch(`${url}blobs`, { method: "PUT", body: "hello" });
  const svg = await fetch(`${url}blobs/${sha("hello")}?type=image/svg%2Bxml&name=x.svg`);
  expect(svg.headers.get("content-type")).toBe("application/octet-stream");
  expect(svg.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''x.svg");
  expect(svg.headers.get("x-content-type-options")).toBe("nosniff");
  expect(svg.headers.get("content-security-policy")).toBe("sandbox");
  expect(await svg.text()).toBe("hello");
  // a page claiming html, no type, or a type of any other case gets no more than a file
  for (const type of ["text/html", "", "IMAGE/PNG"]) {
    const r = await fetch(`${url}blobs/${sha("hello")}?type=${encodeURIComponent(type)}&name=p.html`);
    expect(r.headers.get("content-type")).toBe("application/octet-stream");
    expect(r.headers.get("content-disposition")).toStartWith("attachment;");
  }
  expect((await fetch(`${url}blobs/${sha("hello")}`)).headers.get("content-type")).toBe("application/octet-stream");
});

test("a download's name is encoded into its header, whatever it holds", async () => {
  await fetch(`${url}blobs`, { method: "PUT", body: "hello" });
  const name = 'résumé "1"\r\nSet-Cookie: a=b.txt';
  const r = await fetch(`${url}blobs/${sha("hello")}?type=text/plain&name=${encodeURIComponent(name)}`);
  expect(r.headers.get("content-disposition")).toBe(`attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  expect(r.headers.get("set-cookie")).toBeNull();
  // no name at all is still a file with a name
  const bare = await fetch(`${url}blobs/${sha("hello")}`);
  expect(bare.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''file");
});

test("too large is 413 and leaves nothing; unknown or bad hashes are 404", async () => {
  const big = await fetch(`${url}blobs`, { method: "PUT", body: new Uint8Array(64 * 1024 * 1024 + 1) });
  expect(big.status).toBe(413);
  expect(await big.text()).toBe("file exceeds 64 MB");
  expect(await temps()).toEqual([]);
  expect((await fetch(`${url}blobs/${"0".repeat(64)}`)).status).toBe(404);
  expect((await fetch(`${url}blobs/..%2Fsecrets`)).status).toBe(404);
  expect((await fetch(`${url}blobs/${"A".repeat(64)}`)).status).toBe(404);
});

test("a body that grows past the limit without announcing its length is 413 and leaves nothing", async () => {
  const chunk = new Uint8Array(1024 * 1024);
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent > MAX_BLOB_BYTES / chunk.length) return controller.close();
      sent += 1;
      controller.enqueue(chunk);
    },
  });
  const big = await fetch(`${url}blobs`, { method: "PUT", body, duplex: "half" } as RequestInit);
  expect(big.status).toBe(413);
  expect(await big.text()).toBe("file exceeds 64 MB");
  expect(await temps()).toEqual([]);
});

test("a file of the limit's size is taken", async () => {
  const exact = new Uint8Array(MAX_BLOB_BYTES);
  const up = await fetch(`${url}blobs`, { method: "PUT", body: exact });
  expect(up.status).toBe(200);
  expect((await up.json() as { size: number }).size).toBe(MAX_BLOB_BYTES);
}, 30_000);

test("an empty upload is the empty file", async () => {
  const empty = { hash: sha(""), size: 0 };
  for (const init of [{ method: "PUT" }, { method: "PUT", body: new Uint8Array(0) }, { method: "PUT", body: new Blob([]) }]) {
    const up = await fetch(`${url}blobs`, init);
    expect(up.status).toBe(200);
    expect(await up.json()).toEqual(empty);
  }
  const down = await fetch(`${url}blobs/${empty.hash}?type=text/plain&name=empty.txt`);
  expect(down.status).toBe(200);
  expect(await down.text()).toBe("");
  expect(await temps()).toEqual([]);
});

test("only PUT on /blobs and GET on /blobs/<hash>", async () => {
  for (const method of ["GET", "POST", "DELETE"]) expect((await fetch(`${url}blobs`, { method })).status).toBe(405);
  for (const method of ["PUT", "POST", "DELETE"]) expect((await fetch(`${url}blobs/${sha("hello")}`, { method, body: "x" })).status).toBe(405);
  expect((await fetch(`${url}blobs/`)).status).toBe(404);
  expect((await fetch(`${url}blobsx`)).status).toBe(404);
});

test("another site's page cannot upload or download, nor can another name for the port", async () => {
  const evil = { origin: "http://evil.example" };
  const put = await fetch(`${url}blobs`, { method: "PUT", body: "x", headers: evil });
  expect(put.status).toBe(403);
  expect(await store.has(sha("x"))).toBe(false);
  await fetch(`${url}blobs`, { method: "PUT", body: "hello" });
  expect((await fetch(`${url}blobs/${sha("hello")}`, { headers: evil })).status).toBe(403);
  const rebound = { host: `evil.example:${new URL(url).port}` };
  expect((await fetch(`${url}blobs/${sha("hello")}`, { headers: rebound })).status).toBe(403);
  // the dashboard's own page may
  const own = await fetch(`${url}blobs`, { method: "PUT", body: "x", headers: { origin: url.slice(0, -1) } });
  expect(own.status).toBe(200);
});

test("without a blob store the dashboard has no /blobs", async () => {
  const bare = await startDashboard({ port: 0 }, createHost({ name: "node", self: "node" }));
  try {
    expect((await fetch(`${bare.url}blobs`, { method: "PUT", body: "x" })).status).toBe(404);
    expect((await fetch(`${bare.url}blobs/${sha("x")}`)).status).toBe(404);
  } finally {
    await bare.stop();
  }
});

test("a store that cannot be read or written is a 500 with a reason", async () => {
  // a file where the blobs directory should be
  const base = await mkdtemp("/tmp/dashboard-blobs-");
  await writeFile(join(base, "blobs"), "not a directory");
  const logged = spyOn(console, "error").mockImplementation(() => {});
  const broken = await startDashboard({ port: 0 }, createHost({ name: "node", self: "node" }), undefined, new BlobFetcher(new BlobStore(join(base, "blobs")), null));
  try {
    const down = await fetch(`${broken.url}blobs/${sha("hello")}`);
    expect(down.status).toBe(500);
    expect(down.headers.get("content-type")).toStartWith("text/plain");
    expect((await down.text()).length).toBeGreaterThan(0);
    const up = await fetch(`${broken.url}blobs`, { method: "PUT", body: "hello" });
    expect(up.status).toBe(500);
    expect(up.headers.get("content-type")).toStartWith("text/plain");
    expect((await up.text()).length).toBeGreaterThan(0);
    // and the fault is logged, not lost
    expect(logged).toHaveBeenCalledTimes(2);
  } finally {
    logged.mockRestore();
    await broken.stop();
  }
});
