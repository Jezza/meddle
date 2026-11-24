// test/peer-socket.test.ts
import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { envelope, findSocket, writePeerLine } from "../src/engine/peer-socket";

const keyName = (pid: number, path: string) => `${pid}.${createHash("sha256").update(path).digest("hex")}.key`;

async function registry(): Promise<string> {
  return mkdtemp("/tmp/meddle-peer-socket-");
}

test("envelope wraps the text for the sender", () => {
  expect(envelope("aaaaaaaaaaaa", "hi")).toBe('<cross-session-message from="aaaaaaaaaaaa">\nhi\n</cross-session-message>');
});

test("findSocket finds the session listening at the path, and its token", async () => {
  const dir = await registry();
  await writeFile(join(dir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, name: "aaaaaaaaaaaa", messagingSocketPath: "/x.sock" }));
  await writeFile(join(dir, keyName(process.pid, "/x.sock")), JSON.stringify({ peerToken: "t" }));
  expect(await findSocket(dir, "/x.sock", { timeoutMs: 1000 })).toEqual({ path: "/x.sock", token: "t" });
});

test("findSocket waits for the session's entry, not just its key", async () => {
  const dir = await registry();
  await writeFile(join(dir, keyName(process.pid, "/x.sock")), JSON.stringify({ peerToken: "t" }));
  await expect(findSocket(dir, "/x.sock", { timeoutMs: 300 })).rejects.toThrow("messaging socket never registered");
});

test("findSocket skips a key whose process is gone", async () => {
  const dir = await registry();
  const gone = 2 ** 22 + 1;
  await writeFile(join(dir, `${gone}.json`), JSON.stringify({ pid: gone, messagingSocketPath: "/x.sock" }));
  await writeFile(join(dir, keyName(gone, "/x.sock")), JSON.stringify({ peerToken: "t" }));
  await expect(findSocket(dir, "/x.sock", { timeoutMs: 300 })).rejects.toThrow("messaging socket never registered");
});

test("findSocket skips another socket's key", async () => {
  const dir = await registry();
  await writeFile(join(dir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, messagingSocketPath: "/y.sock" }));
  await writeFile(join(dir, keyName(process.pid, "/y.sock")), JSON.stringify({ peerToken: "t" }));
  await expect(findSocket(dir, "/x.sock", { timeoutMs: 300 })).rejects.toThrow("messaging socket never registered");
});

test("findSocket waits for the session to register", async () => {
  const dir = await registry();
  setTimeout(() => {
    void writeFile(join(dir, keyName(process.pid, "/y.sock")), JSON.stringify({ peerToken: "t" }))
      .then(() => writeFile(join(dir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, messagingSocketPath: "/y.sock" })));
  }, 200);
  expect(await findSocket(dir, "/y.sock", { timeoutMs: 3000, pollMs: 50 })).toEqual({ path: "/y.sock", token: "t" });
});

test("findSocket stops when aborted", async () => {
  const dir = await registry();
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 100);
  await expect(findSocket(dir, "/x.sock", { timeoutMs: 5000, signal: stop.signal })).rejects.toThrow();
});

test("writePeerLine sends auth then the message", async () => {
  const dir = await registry();
  const path = join(dir, "s.sock");
  const got = new Promise<string>((resolve) => {
    const server = createServer((c) => {
      let buf = "";
      c.on("data", (d) => { buf += d; });
      c.on("end", () => { resolve(buf); server.close(); });
    });
    server.listen(path);
  });
  await Bun.sleep(50);
  await writePeerLine({ path, token: "t" }, { uuid: "11111111-1111-4111-8111-111111111111", from: "uds:/r.sock", content: "hello" });
  const lines = (await got).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  expect(lines).toHaveLength(2);
  expect(lines[0]).toEqual({ type: "auth", token: "t" });
  expect(lines[1]).toMatchObject({
    msgV: 1, msg_id: "11111111-1111-4111-8111-111111111111", uuid: "11111111-1111-4111-8111-111111111111",
    type: "user", priority: "next", from: "uds:/r.sock", message: { role: "user", content: "hello" },
  });
});

test("writePeerLine without a token sends the message alone", async () => {
  const dir = await registry();
  const path = join(dir, "s.sock");
  const got = new Promise<string>((resolve) => {
    const server = createServer((c) => {
      let buf = "";
      c.on("data", (d) => { buf += d; });
      c.on("end", () => { resolve(buf); server.close(); });
    });
    server.listen(path);
  });
  await Bun.sleep(50);
  await writePeerLine({ path, token: null }, { uuid: "u", from: "uds:/r.sock", content: "hello" });
  const lines = (await got).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  expect(lines.map((l) => l.type)).toEqual(["user"]);
});

test("writePeerLine rejects when nothing listens", async () => {
  const dir = await registry();
  await expect(writePeerLine({ path: join(dir, "none.sock"), token: null }, { uuid: "u", from: "uds:/r", content: "x" })).rejects.toThrow();
});

test("writePeerLine gives up on a session that takes the line but never closes", async () => {
  const dir = await registry();
  const path = join(dir, "s.sock");
  const server = createServer(() => { /* reads nothing, closes nothing */ });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  const started = Date.now();
  await expect(writePeerLine({ path, token: null }, { uuid: "u", from: "uds:/r", content: "x" }, { timeoutMs: 300 })).rejects.toThrow("timed out");
  expect(Date.now() - started).toBeLessThan(2000);
  server.close();
});
