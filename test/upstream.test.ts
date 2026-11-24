// test/upstream.test.ts — the dashboard's own /ws link: opened again after it closes, at once when the page wakes.
import { test, expect } from "bun:test";
import { Upstream, type HostEvents } from "../src/dashboard/ui/hooks";

/** An Upstream over a fake socket factory, clock and timer. */
function rig() {
  let now = 0;
  const timers: { at: number; fn: () => void }[] = [];
  const attempts: HostEvents[] = [];
  let mismatches = 0;
  const upstream = new Upstream({
    connect: (events) => { attempts.push(events); },
    mismatch: () => { mismatches++; },
    now: () => now,
    schedule: (fn, ms) => { timers.push({ at: now + ms, fn }); },
  });
  const changes: boolean[] = [];
  upstream.onChange(() => changes.push(upstream.open));
  const advance = (ms: number) => {
    now += ms;
    for (const t of timers.filter((t) => t.at <= now)) {
      timers.splice(timers.indexOf(t), 1);
      t.fn();
    }
  };
  const last = () => attempts[attempts.length - 1]!;
  return { upstream, attempts, changes, advance, last, timers, mismatches: () => mismatches };
}

test("connects at once and counts as open until its socket closes", () => {
  const { upstream, attempts, changes, last } = rig();
  expect(attempts).toHaveLength(1);
  expect(upstream.open).toBe(true);
  last().opened();
  last().closed();
  expect(upstream.open).toBe(false);
  expect(changes).toEqual([false]);
});

test("a closed socket is opened again after 1 s doubling to 30 s, and counts as open once it is", () => {
  const { upstream, attempts, advance, last } = rig();
  const delays: number[] = [];
  for (let i = 0; i < 7; i++) {
    last().closed();
    const before = attempts.length;
    let waited = 0;
    while (attempts.length === before) { advance(500); waited += 500; }
    delays.push(waited);
    expect(upstream.open).toBe(false);
  }
  expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  last().opened();
  expect(upstream.open).toBe(true);
});

test("a socket that stayed open a while starts the backoff over at 1 s", () => {
  const { attempts, advance, last } = rig();
  for (let i = 0; i < 3; i++) { last().closed(); advance(30_000); }
  last().opened();
  advance(60_000);
  last().closed();
  const before = attempts.length;
  advance(1000);
  expect(attempts).toHaveLength(before + 1);
});

test("waking during a backoff connects at once; the backoff's timer then does nothing", () => {
  const { upstream, attempts, advance, last } = rig();
  last().opened();
  last().closed();
  upstream.wake();
  expect(attempts).toHaveLength(2);
  advance(1000);
  expect(attempts).toHaveLength(2);
});

test("waking while connecting or open does nothing", () => {
  const { upstream, attempts, last } = rig();
  upstream.wake();
  last().opened();
  upstream.wake();
  expect(attempts).toHaveLength(1);
});

test("a protocol mismatch is reported once and never retried", () => {
  const { upstream, attempts, advance, last, timers, mismatches } = rig();
  last().mismatch();
  last().closed();
  advance(120_000);
  upstream.wake();
  expect(mismatches()).toBe(1);
  expect(attempts).toHaveLength(1);
  expect(timers).toHaveLength(0);
});

test("events from a replaced socket are ignored", () => {
  const { upstream, attempts, advance } = rig();
  const first = attempts[0]!;
  first.closed();
  advance(1000);
  first.closed();
  first.mismatch();
  expect(attempts).toHaveLength(2);
  attempts[1]!.opened();
  expect(upstream.open).toBe(true);
});
