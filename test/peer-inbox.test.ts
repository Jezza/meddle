// test/peer-inbox.test.ts
import { test, expect } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { PeerInbox } from "../src/engine/peer-inbox";
import type { PeerSocket } from "../src/engine/peer-socket";

const from = { taskId: "aaaaaaaaaaaa", nodeId: "n1", title: "Quiet fox" };
const message = (text: string) => ({ text, attachments: [], peer: from });

/** A stand-in for a session's socket: every message line written to it, in order. */
async function inbox(): Promise<{ sock: PeerSocket; lines: Array<{ uuid: string; message: { content: string } }>; server: Server }> {
  const path = join(await mkdtemp("/tmp/meddle-peer-inbox-"), "s.sock");
  const lines: Array<{ uuid: string; message: { content: string } }> = [];
  const server = createServer((c) => {
    let buf = "";
    c.on("data", (d) => { buf += d; });
    c.on("end", () => {
      for (const l of buf.split("\n").filter(Boolean)) {
        const f = JSON.parse(l);
        if (f.type === "user") lines.push(f);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return { sock: { path, token: null }, lines, server };
}

const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(10);
  }
};

test("writes pushed messages in order once located", async () => {
  const { sock, lines, server } = await inbox();
  let located!: (s: PeerSocket) => void;
  const box = new PeerInbox(() => new Promise((r) => { located = r; }), () => "/reply.sock");
  const a = box.push(message("one"));
  const b = box.push(message("two"));
  await Bun.sleep(50);
  expect(lines).toHaveLength(0);
  located(sock);
  await until(() => lines.length === 2);
  expect(lines.map((l) => l.uuid)).toEqual([a, b]);
  expect(lines[0]!.message.content).toBe('<cross-session-message from="aaaaaaaaaaaa">\none\n</cross-session-message>');
  box.end();
  server.close();
});

test("take marks a message taken and untaken lists the rest", async () => {
  const { sock, server } = await inbox();
  const box = new PeerInbox(async () => sock, () => "/reply.sock");
  const a = box.push(message("one"));
  const b = box.push(message("two"));
  expect(box.take(a)).toEqual(message("one"));
  expect(box.take(a)).toBeNull();
  expect(box.untaken()).toEqual([{ uuid: b, prompt: message("two") }]);
  box.end();
  server.close();
});

test("queued says Claude Code queued a message until it is taken", () => {
  const box = new PeerInbox(() => new Promise(() => {}), () => "/r");
  const a = box.push(message("one"));
  expect(box.queued(a)).toBe(false);
  box.noteQueued(a);
  expect(box.queued(a)).toBe(true);
  box.take(a);
  expect(box.queued(a)).toBe(false);
  box.end();
});

test("a failed locate settles failed and leaves messages untaken", async () => {
  const box = new PeerInbox(async () => { throw new Error("messaging socket never registered"); }, () => "/r");
  const a = box.push(message("one"));
  expect((await box.failed).message).toBe("messaging socket never registered");
  expect(box.untaken().map((u) => u.uuid)).toEqual([a]);
  box.end();
});

test("a message not taken within startMs settles failed", async () => {
  const { sock, server } = await inbox();
  const box = new PeerInbox(async () => sock, () => "/r", { startMs: 100 });
  box.push(message("one"));
  expect((await box.failed).message).toBe("the message was not taken");
  box.end();
  server.close();
});

test("a message taken in time never settles failed", async () => {
  const { sock, lines, server } = await inbox();
  const box = new PeerInbox(async () => sock, () => "/r", { startMs: 100 });
  const a = box.push(message("one"));
  await until(() => lines.length === 1);
  box.take(a);
  const settled = await Promise.race([box.failed.then(() => "failed"), Bun.sleep(250).then(() => "quiet")]);
  expect(settled).toBe("quiet");
  box.end();
  server.close();
});

test("fail settles failed with the receipt's reason", async () => {
  const box = new PeerInbox(() => new Promise(() => {}), () => "/r");
  const a = box.push(message("one"));
  box.fail(a, "dropped");
  expect((await box.failed).message).toBe("dropped");
  expect(box.untaken()).toHaveLength(1);
  box.end();
});

test("end stops a pending locate and nothing is written after it", async () => {
  const { sock, lines, server } = await inbox();
  let aborted = false;
  let located!: (s: PeerSocket) => void;
  const box = new PeerInbox((signal) => new Promise((r) => {
    located = r;
    signal.addEventListener("abort", () => { aborted = true; });
  }), () => "/r");
  box.push(message("one"));
  await Bun.sleep(10); // the locate is under way
  box.end();
  expect(aborted).toBe(true);
  located(sock);
  await Bun.sleep(100);
  expect(lines).toHaveLength(0);
  expect(box.untaken()).toHaveLength(1);
  server.close();
});

test("a failed message does not stop later ones being written", async () => {
  const { sock, lines, server } = await inbox();
  const box = new PeerInbox(async () => sock, () => "/r", { startMs: 100 });
  box.push(message("one"));
  await box.failed; // never taken in time
  box.push(message("two"));
  await until(() => lines.length === 2);
  expect(lines.map((l) => l.message.content)).toEqual([
    '<cross-session-message from="aaaaaaaaaaaa">\none\n</cross-session-message>',
    '<cross-session-message from="aaaaaaaaaaaa">\ntwo\n</cross-session-message>',
  ]);
  box.end();
  server.close();
});
