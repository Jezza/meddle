// test/pool-helpers.ts — fixtures for tests of the pool transport.
import { SecretKey, type Connection, type Endpoint } from "@number0/iroh";
import { hexOf, type Identity } from "../src/pool/identity";
import { fromEndpoint, openEndpoint, toEndpointAddr } from "../src/pool/net";

export type TestNode = { endpoint: Endpoint; identity: Identity };

function freshIdentity(): Identity {
  const key = SecretKey.generate();
  return { id: hexOf(key.public()), secret: Uint8Array.from(key.toBytes()) };
}

async function node(): Promise<TestNode> {
  const identity = freshIdentity();
  return { endpoint: await openEndpoint({ irohPreset: "minimal", irohBind: "127.0.0.1:0" }, identity), identity };
}

/**
 * Two endpoints with presetMinimal on 127.0.0.1:0 and fresh identities. `connect(alpn)` dials b from a and accepts
 * on b, returning both ends; do not use it once something else runs b's accept loop.
 */
export async function endpointPair(): Promise<{
  a: TestNode; b: TestNode;
  connect(alpn: number[]): Promise<{ a: Connection; b: Connection }>;
  close(): Promise<void>;
}> {
  const a = await node();
  const b = await node();
  return {
    a, b,
    async connect(alpn) {
      const accepted = (async () => {
        const incoming = await b.endpoint.acceptNext();
        if (!incoming) throw new Error("b's endpoint is closed");
        return (await incoming.accept()).connect();
      })();
      const dialed = await a.endpoint.connect(toEndpointAddr(fromEndpoint(b.endpoint)), alpn);
      return { a: dialed, b: await accepted };
    },
    async close() {
      for (const n of [a, b]) if (!n.endpoint.isClosed()) await n.endpoint.close();
    },
  };
}
