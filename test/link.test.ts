// test/link.test.ts — IrohLink on its own, over a stand-in stream.
import { test, expect } from "bun:test";
import { IrohLink } from "../src/pool/link";
import type { PeerStream } from "../src/pool/net";

/** A PeerStream whose connection closes at once and whose reads never complete. */
function closingStream(): PeerStream {
  return {
    peerId: "a".repeat(64),
    header: { stream: "chord" },
    stream: {
      send: { finish: async () => {}, writeAll: async () => {} },
      recv: { stop: async () => {} },
    } as unknown as PeerStream["stream"],
    reader: { readLine: () => new Promise<string | null>(() => {}) } as unknown as PeerStream["reader"],
    closed: Promise.resolve("closed by peer: bye (code 0)"),
  };
}

test("a close handler that throws ends the link without an unhandled rejection", async () => {
  const link = new IrohLink(closingStream());
  link.onClose(() => { throw new Error("handler bug"); });
  const later: string[] = [];
  await Bun.sleep(20);
  expect(link.closed).toBe(true);
  link.onClose((reason) => later.push(reason));
  expect(later).toEqual(["closed"]);
});
