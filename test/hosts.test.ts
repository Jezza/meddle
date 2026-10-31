// test/hosts.test.ts — the dashboard's per-node hosts: backoff after a failed socket, and incompatible peers.
import { test, expect } from "bun:test";
import type { Host } from "@earendil-works/chord";
import { Hosts, type HostEvents } from "../src/dashboard/ui/hooks";

const SELF = "a".repeat(64);
const PEER = "b".repeat(64);

function fakeHost(): Host & { closed: boolean } {
  const host = { closed: false, close: async () => { host.closed = true; } };
  return host as unknown as Host & { closed: boolean };
}

/** Hosts over a fake socket factory, clock and timer. */
function rig() {
  let now = 0;
  const timers: { at: number; fn: () => void }[] = [];
  const attempts: { nodeId: string; events: HostEvents; host: Host & { closed: boolean } }[] = [];
  const changes: string[] = [];
  const self = fakeHost();
  const hosts = new Hosts(SELF, self, {
    connect: (nodeId, events) => {
      const host = fakeHost();
      attempts.push({ nodeId, events, host });
      return host;
    },
    now: () => now,
    schedule: (fn, ms) => { timers.push({ at: now + ms, fn }); },
  });
  hosts.onChange((id) => changes.push(id));
  const advance = (ms: number) => {
    now += ms;
    for (const t of timers.filter((t) => t.at <= now)) {
      timers.splice(timers.indexOf(t), 1);
      t.fn();
    }
  };
  const last = () => attempts[attempts.length - 1]!;
  return { hosts, self, attempts, changes, advance, last, timers };
}

test("this node is always the /ws host; another node's host is made once and reused", () => {
  const { hosts, self, attempts, last } = rig();
  expect(hosts.for(SELF)).toBe(self);
  expect(attempts).toHaveLength(0);
  const host = hosts.for(PEER);
  expect(attempts).toHaveLength(1);
  expect(hosts.status(PEER)).toBe("connecting");
  expect(hosts.for(PEER)).toBe(host);
  last().events.opened();
  expect(hosts.status(PEER)).toBe("open");
  expect(attempts).toHaveLength(1);
});

test("a closed socket backs off 1 s doubling to 30 s, without opening a socket meanwhile", () => {
  const { hosts, attempts, changes, advance, last } = rig();
  const delays: number[] = [];
  for (let i = 0; i < 7; i++) {
    const host = hosts.for(PEER) as Host & { closed: boolean };
    expect(host).toBeDefined();
    last().events.closed();
    expect(host.closed).toBe(true);
    expect(hosts.status(PEER)).toBe("backoff");
    expect(hosts.for(PEER)).toBeUndefined();
    let waited = 0;
    while (hosts.status(PEER) === "backoff") { advance(500); waited += 500; }
    expect(hosts.status(PEER)).toBe("idle");
    delays.push(waited);
  }
  expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  expect(attempts).toHaveLength(7);
  // every drop and every end of a backoff re-renders the views
  expect(changes.filter((id) => id === PEER).length).toBeGreaterThanOrEqual(14);
});

test("a socket that stayed open a while starts the backoff over at 1 s", () => {
  const { hosts, advance, last } = rig();
  for (let i = 0; i < 3; i++) {                       // 1 s, 2 s, 4 s
    hosts.for(PEER);
    last().events.closed();
    advance(30_000);
  }
  hosts.for(PEER);
  last().events.opened();
  advance(60_000);
  last().events.closed();
  advance(999);
  expect(hosts.status(PEER)).toBe("backoff");
  advance(1);
  expect(hosts.status(PEER)).toBe("idle");
});

test("a protocol mismatch marks the node incompatible: the host is closed and never retried", () => {
  const { hosts, attempts, changes, advance, last, timers } = rig();
  const host = hosts.for(PEER) as Host & { closed: boolean };
  last().events.mismatch();
  expect(host.closed).toBe(true);
  expect(hosts.status(PEER)).toBe("incompatible");
  expect(changes).toContain(PEER);
  last().events.closed();                              // the socket's close after the mismatch changes nothing
  advance(120_000);
  expect(hosts.status(PEER)).toBe("incompatible");
  expect(hosts.for(PEER)).toBeUndefined();
  expect(attempts).toHaveLength(1);
  expect(timers).toHaveLength(0);
});

test("events from a replaced attempt are ignored", () => {
  const { hosts, attempts, advance } = rig();
  hosts.for(PEER);
  const first = attempts[0]!;
  first.events.closed();
  advance(1000);
  hosts.for(PEER);
  first.events.closed();                               // late duplicate from the old socket
  first.events.mismatch();
  expect(hosts.status(PEER)).toBe("connecting");
  expect(attempts).toHaveLength(2);
});
