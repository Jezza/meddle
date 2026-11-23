// The dashboard: the UI page, its script, and a chord link for every browser on /ws, on localhost only (or through a
// proxy on `MEDDLE_DASHBOARD_ORIGIN`, which forwards to localhost and guards the way in); a browser
// reaches another node of the pool on /ws/node/<nodeId>, tunnelled over iroh. It also takes a file a browser attaches
// to a prompt (PUT /blobs, answered with the file's hash) and gives one back by hash (GET /blobs/<hash>).
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { acceptWebSockets, type Host } from "@earendil-works/chord";
import { cleanName, INLINE_IMAGE_TYPES, isBlobHash, MAX_BLOB_BYTES } from "../blobs/attachment";
import type { BlobFetcher } from "../blobs/pool";
import type { NodeConfig } from "../config";
import type { PoolRuntime } from "../pool/runtime";
import { DASHBOARD_PRINCIPAL, bridgeSocket } from "./tunnel";
import { BunSocketShim, ShimServer } from "./ws-shim";
import { embedded } from "../embedded";

const UI_DIR = join(import.meta.dir, "ui");
const PREBUILT = join(import.meta.dir, "../../dist/ui/main.js");

/**
 * Every dashboard connection acts as this principal: the server binds to 127.0.0.1 only, and `trusted` holds. A proxy on
 * the dashboard origin is what decides who reaches it from elsewhere.
 */
const PRINCIPAL = DASHBOARD_PRINCIPAL;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

const TUNNEL = /^\/ws\/node\/([^/]*)$/;
const NODE_ID = /^[0-9a-f]{64}$/;
const BLOB = /^\/blobs\/([^/]*)$/;

/** The dashboard origin a proxy serves it on, and that origin's `Host`. */
type Proxy = { origin: string; host: string };

/** `peerId` is set for a socket tunnelled to another node. */
type SocketData = { request: Request; shim?: BunSocketShim; peerId?: string };

export type Dashboard = { url: string; stop(): Promise<void> };

/**
 * Serves the dashboard on `127.0.0.1:<cfg.port>` (`0` picks a free port), and to a proxy on `cfg.dashboardOrigin` when
 * set, with `host`'s objects on `/ws`, and with `pool`, each online member's objects on `/ws/node/<nodeId>` (this
 * node's own id is `/ws`). With `blobs`, files are taken into its store on `PUT /blobs` and given out on
 * `GET /blobs/<hash>`, fetched from the pool first if this node lacks one; without it there is no `/blobs`.
 */
export async function startDashboard(
  cfg: Pick<NodeConfig, "port"> & Partial<Pick<NodeConfig, "dashboardOrigin">>,
  host: Host,
  pool?: PoolRuntime,
  blobs?: BlobFetcher,
): Promise<Dashboard> {
  const script = await uiScript();
  const page = uiPage();
  const sockets = new ShimServer<Request>();
  let port = 0;
  const proxy = cfg.dashboardOrigin ? { origin: cfg.dashboardOrigin, host: new URL(cfg.dashboardOrigin).host } : null;
  acceptWebSockets(sockets, host, { principal: (request) => (trusted(request, port, proxy) ? PRINCIPAL : undefined) });

  const server = Bun.serve<SocketData, never>({
    hostname: "127.0.0.1",
    port: cfg.port,
    fetch(request, server) {
      if (!trusted(request, server.port ?? port, proxy)) return forbidden();
      const { pathname, searchParams } = new URL(request.url);
      if (pathname === "/" || pathname === "/index.html") {
        return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (pathname === "/main.js") {
        return new Response(script, { headers: { "content-type": "text/javascript; charset=utf-8" } });
      }
      if (blobs !== undefined && (pathname === "/blobs" || BLOB.test(pathname))) {
        return guarded(blobRoute(request, pathname, searchParams, blobs));
      }
      const tunnel = TUNNEL.exec(pathname);
      if (pathname === "/ws" || (tunnel !== null && pool !== undefined)) {
        const id = tunnel?.[1];
        let peerId: string | undefined;
        if (pool !== undefined && id !== undefined && id !== pool.identity.id) {
          if (!NODE_ID.test(id) || pool.store.row(id)?.status !== "member") return new Response("unknown node", { status: 404 });
          if (!pool.net.isOnline(id)) return new Response("node offline", { status: 503 });
          peerId = id;
        }
        if (server.upgrade(request, { data: { request, peerId } })) return undefined;
        return new Response("expected a WebSocket upgrade", { status: 400 });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      // A frame chord sent and Bun dropped would desync the link silently; a closed socket ends it instead.
      closeOnBackpressureLimit: true,
      open(ws: ServerWebSocket<SocketData>) {
        const shim = new BunSocketShim(ws as ServerWebSocket<unknown>);
        ws.data.shim = shim;
        if (ws.data.peerId !== undefined && pool !== undefined) void bridgeSocket(shim, pool.net, ws.data.peerId);
        else sockets.emitConnection(shim, ws.data.request);
      },
      message(ws: ServerWebSocket<SocketData>, data) {
        ws.data.shim?.dispatchMessage(data);
      },
      close(ws: ServerWebSocket<SocketData>) {
        ws.data.shim?.dispatchClose();
      },
    },
  });

  port = server.port ?? cfg.port;
  return {
    url: `http://127.0.0.1:${port}/`,
    stop: () => server.stop(true),
  };
}

const CAP_MESSAGE = "file exceeds 64 MB";

/** No bytes at all: what an empty file's upload has in place of a body. */
async function* noBytes(): AsyncGenerator<Uint8Array> {}

function notAllowed(allow: string): Response {
  return new Response("method not allowed", { status: 405, headers: { allow } });
}

/**
 * What every answer on `/blobs` carries, a refusal or a fault as much as a file, so that none is ever read in a way that
 * lets it run script in the dashboard's origin, which drives the node: `nosniff` holds the browser to the type given,
 * and `sandbox` leaves a page that shows it with no origin of its own.
 */
const GUARD_HEADERS = { "x-content-type-options": "nosniff", "content-security-policy": "sandbox" };

/** `response` with `GUARD_HEADERS`. */
async function guarded(response: Promise<Response> | Response): Promise<Response> {
  const r = await response;
  for (const [name, value] of Object.entries(GUARD_HEADERS)) r.headers.set(name, value);
  return r;
}

/** The refusal of a request that may not reach the node, with `GUARD_HEADERS` as on any answer on `/blobs`. */
function forbidden(): Response {
  return new Response("forbidden", { status: 403, headers: GUARD_HEADERS });
}

/**
 * Answers a request on `/blobs` (`PUT`, `putBlob`) or `/blobs/<x>` (`GET`, `getBlob`). Refused when the browser says
 * another site's page sent it (`crossSite`).
 */
function blobRoute(request: Request, pathname: string, query: URLSearchParams, blobs: BlobFetcher): Promise<Response> | Response {
  if (crossSite(request)) return forbidden();
  if (pathname === "/blobs") return request.method === "PUT" ? putBlob(request, blobs) : notAllowed("PUT");
  return request.method === "GET" ? getBlob(BLOB.exec(pathname)![1]!, query, blobs) : notAllowed("GET");
}

/**
 * Whether the browser says the request comes from another site's page (`Sec-Fetch-Site` `cross-site` or `same-site`):
 * an `<img>` there sends no `Origin`, so `trusted` alone would let that page find out which files this node has. A
 * request without the header (not a browser's), from the dashboard's own page (`same-origin`) or typed in (`none`)
 * passes.
 */
function crossSite(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  return site === "cross-site" || site === "same-site";
}

/**
 * Stores the request's body as a blob and answers `{ hash, size }`. A body over the 64 MB limit is refused as soon as
 * its `Content-Length` says so, unread, or when it grows past the limit; nothing is kept then. A request has no body
 * when it is empty, so that is the empty file.
 */
async function putBlob(request: Request, blobs: BlobFetcher): Promise<Response> {
  const announced = request.headers.get("content-length");
  if (announced !== null && Number(announced) > MAX_BLOB_BYTES) return new Response(CAP_MESSAGE, { status: 413 });
  try {
    return Response.json(await blobs.store.write(request.body ?? noBytes(), { maxBytes: MAX_BLOB_BYTES }));
  } catch (err) {
    if (err instanceof Error && err.message === `blob exceeds ${MAX_BLOB_BYTES} bytes`) {
      return new Response(CAP_MESSAGE, { status: 413 });
    }
    console.error("meddle: dashboard: storing an uploaded file failed:", err);
    return new Response("could not store the file", { status: 500 });
  }
}

/**
 * Gives out the blob with this hash, fetching it from the pool if this node lacks it. Only the four image types Claude
 * takes (`?type=`) are served as what they claim, inline; every other file is an opaque download named `?name=`. Never
 * as a page of the dashboard's origin: see `guarded`.
 */
async function getBlob(hash: string, query: URLSearchParams, blobs: BlobFetcher): Promise<Response> {
  if (!isBlobHash(hash)) return new Response("not found", { status: 404 });
  try {
    if (!(await blobs.ensure(hash))) return new Response("not found", { status: 404 });
  } catch (err) {
    console.error(`meddle: dashboard: reading blob ${hash} failed:`, err);
    return new Response("could not read the file", { status: 500 });
  }
  const type = query.get("type") ?? "";
  const inline = INLINE_IMAGE_TYPES.includes(type);
  const name = cleanName(query.get("name") ?? "");
  return new Response(Bun.file(blobs.store.path(hash)), {
    headers: {
      "content-type": inline ? type : "application/octet-stream",
      "content-disposition": inline ? "inline" : `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
}

/**
 * Whether a request may reach the node: its `Host` is a loopback name with this port or the dashboard origin's (no DNS
 * rebinding), and its `Origin`, when a browser sent one, is this server's own or the dashboard origin (no other site's
 * page drives the node over /ws). A proxy must pass both headers on as the browser sent them.
 */
function trusted(request: Request, port: number, proxy: Proxy | null): boolean {
  const host = request.headers.get("host");
  if (host === null || !(isLoopback(`http://${host}`, port) || host.toLowerCase() === proxy?.host)) return false;
  const origin = request.headers.get("origin");
  return origin === null || isLoopback(origin, port) || origin === proxy?.origin;
}

function isLoopback(url: string, port: number): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" && LOOPBACK.has(parsed.hostname) && Number(parsed.port || 80) === port
    && parsed.pathname === "/" && parsed.username === "" && parsed.search === "";
}

/** The dashboard page: embedded in the single binary, else this checkout's `ui/index.html`. */
function uiPage(): Blob {
  const packed = embedded();
  return packed !== null ? new Blob([packed.html]) : Bun.file(join(UI_DIR, "index.html"));
}

/** The browser bundle: embedded in the single binary, else `dist/ui/main.js` when built ahead, else built from `ui/main.tsx` now. */
async function uiScript(): Promise<Blob> {
  const packed = embedded();
  if (packed !== null) return new Blob([packed.script]);
  const prebuilt = Bun.file(PREBUILT);
  if (await prebuilt.exists()) return prebuilt;
  const build = await Bun.build({ entrypoints: [join(UI_DIR, "main.tsx")], target: "browser", format: "esm" });
  if (!build.success) throw new AggregateError(build.logs, "building the dashboard UI failed");
  const output = build.outputs.find((o) => o.kind === "entry-point");
  if (output === undefined) throw new Error("building the dashboard UI produced no entry point");
  return output;
}
