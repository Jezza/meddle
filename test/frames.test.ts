import { test, expect } from "bun:test";
import { ALPN_POOL, MAX_FRAME, StreamReader, parseHeader, writeFrame, writeLine } from "../src/pool/frames";
import { endpointPair } from "./pool-helpers";
import type { RecvStream } from "@number0/iroh";

test("lines and frames round-trip, EOF is null, oversize is refused", async () => {
  const pair = await endpointPair();
  try {
    const { a, b } = await pair.connect(ALPN_POOL);
    const small = Uint8Array.from([1, 2, 3, 4, 5]);
    const big = crypto.getRandomValues(new Uint8Array(300 * 1024));

    const out = await a.openBi();
    const writing = (async () => {
      await writeLine(out.send, '{"stream":"x"}');
      await writeFrame(out.send, 1, small);
      await writeFrame(out.send, 0, big);
      await out.send.finish();
    })();
    const reader = new StreamReader((await b.acceptBi()).recv);
    expect(await reader.readLine()).toBe('{"stream":"x"}');
    expect(await reader.readFrame()).toEqual({ kind: 1, data: small });
    const second = await reader.readFrame();
    expect(second?.kind).toBe(0);
    expect(second?.data.length).toBe(big.length);
    expect(Buffer.from(second!.data).equals(Buffer.from(big))).toBe(true);
    expect(await reader.readFrame()).toBeNull();
    expect(await reader.readLine()).toBeNull();
    await writing;

    const long = await a.openBi();
    const writingLong = long.send.writeAll(Array.from(new Uint8Array(70_000).fill(97)));
    await expect(new StreamReader((await b.acceptBi()).recv).readLine()).rejects.toThrow("line exceeds 65536 bytes");
    await writingLong;

    const medium = await a.openBi();
    const writingMedium = medium.send.writeAll(Array.from(new Uint8Array(200).fill(97)));
    await expect(new StreamReader((await b.acceptBi()).recv).readLine(100)).rejects.toThrow("line exceeds 100 bytes");
    await writingMedium;

    const huge = await a.openBi();
    const header = new Uint8Array(5);
    new DataView(header.buffer).setUint32(1, 17 * 1024 * 1024);
    await huge.send.writeAll(Array.from(header));
    await expect(new StreamReader((await b.acceptBi()).recv).readFrame()).rejects.toThrow(`frame exceeds ${MAX_FRAME} bytes`);
  } finally {
    await pair.close();
  }
});

test("parseHeader accepts {stream} objects and refuses the rest", () => {
  expect(parseHeader('{"stream":"chord","n":1}')).toEqual({ stream: "chord", n: 1 });
  expect(parseHeader('{"stream":""}')).toEqual({ stream: "" });
  for (const bad of ["not json", "", "null", "[]", '"chord"', "1", "{}", '{"stream":1}', '{"stream":null}', '["stream"]']) {
    expect(() => parseHeader(bad)).toThrow("bad stream header");
  }
});

test("readChunk hands out buffered bytes first, then each read, then null", async () => {
  const chunks = [Array.from(new TextEncoder().encode("head\nrest")), [1, 2, 3]];
  const recv = { read: async () => chunks.shift() ?? [] } as unknown as RecvStream;
  const reader = new StreamReader(recv);
  expect(await reader.readLine()).toBe("head");
  expect(new TextDecoder().decode((await reader.readChunk())!)).toBe("rest");
  expect(await reader.readChunk()).toEqual(Uint8Array.from([1, 2, 3]));
  expect(await reader.readChunk()).toBeNull();
  expect(await reader.readChunk()).toBeNull();
});
