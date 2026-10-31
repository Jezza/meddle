// test/fake-lighthouse.ts — an in-process, signature-blind lighthouse for tests (`bun test/fake-lighthouse.ts` serves one).
import { decodePayload, type AnnounceBody, type EndpointAddr, type LookupBody, type Peer } from "iroh-lighthouse";

type Entry = { addr: EndpointAddr; expiresAt: number };

const MIN_TTL_SECS = 10;
const MAX_TTL_SECS = 604_800;

export type FakeLighthouse = {
  url: string;
  stop(): void;
  /** Every topic id seen, each with its unexpired registrations by node id. */
  topics(): Map<string, Map<string, Peer>>;
  /** How many announces it has answered. */
  announces(): number;
};

/**
 * `Bun.serve` on 127.0.0.1:0 speaking the lighthouse's HTTP routes without checking signatures. With `hang: true`,
 * every request is accepted and never answered; with `grantedTtl`, every announce reply carries it as `ttl_secs`.
 */
export async function startFakeLighthouse(options: { hang?: boolean; grantedTtl?: unknown } = {}): Promise<FakeLighthouse> {
  const registry = new Map<string, Map<string, Entry>>();
  let announces = 0;

  const live = (topic: string): Map<string, Entry> => {
    let entries = registry.get(topic);
    if (!entries) {
      entries = new Map();
      registry.set(topic, entries);
    }
    const now = Date.now();
    for (const [id, e] of entries) if (e.expiresAt <= now) entries.delete(id);
    return entries;
  };
  const asPeer = (e: Entry): Peer => ({ addr: e.addr, expires_in_secs: Math.max(0, Math.round((e.expiresAt - Date.now()) / 1000)) });
  const malformed = (message: string) => Response.json({ type: "error", code: "malformed", message }, { status: 400 });

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (options.hang) return new Promise<Response>(() => {});
      const path = new URL(req.url).pathname;
      if (req.method === "POST" && path === "/v1/announce") {
        const body = decodePayload<AnnounceBody>(((await req.json()) as { payload: string }).payload);
        if (body.topic === null) return malformed("the fake lighthouse has no directory");
        const entries = live(body.topic);
        const ttl = body.ttl_secs === 0 ? 0 : Math.min(MAX_TTL_SECS, Math.max(MIN_TTL_SECS, body.ttl_secs));
        if (ttl === 0) entries.delete(body.addr.id);
        else entries.set(body.addr.id, { addr: body.addr, expiresAt: Date.now() + ttl * 1000 });
        const peers = [...entries.values()].filter((e) => e.addr.id !== body.addr.id).map(asPeer);
        announces++;
        return Response.json({ type: "announced", ttl_secs: "grantedTtl" in options ? options.grantedTtl : ttl, peers });
      }
      if (req.method === "POST" && path === "/v1/lookup") {
        const body = decodePayload<LookupBody>(((await req.json()) as { payload: string }).payload);
        return Response.json({ type: "peers", peers: [...live(body.topic).values()].map(asPeer) });
      }
      if (req.method === "GET" && path === "/v1/info") {
        return Response.json({
          type: "info", version: "fake", lighthouse: null,
          min_ttl_secs: MIN_TTL_SECS, max_ttl_secs: MAX_TTL_SECS, max_peers_per_topic: 256,
        });
      }
      if (req.method === "GET" && path === "/v1/health") return new Response("ok");
      return Response.json({ type: "error", code: "not_found", message: `no route ${req.method} ${path}` }, { status: 404 });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => void server.stop(true),
    announces: () => announces,
    topics() {
      const out = new Map<string, Map<string, Peer>>();
      for (const topic of registry.keys()) out.set(topic, new Map([...live(topic)].map(([id, e]) => [id, asPeer(e)])));
      return out;
    },
  };
}

if (import.meta.main) {
  const lighthouse = await startFakeLighthouse({ hang: process.argv.includes("--hang") });
  console.log(lighthouse.url);
}
