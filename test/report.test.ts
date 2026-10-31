// test/report.test.ts
import { test, expect } from "bun:test";
import { dedupe } from "../src/pool/report";

test("dedupe passes each distinct message once a minute", () => {
  let clock = 0;
  const seen: string[] = [];
  const report = dedupe((m) => seen.push(m), { now: () => clock });
  report("dialing x: timed out");
  clock = 30_000;
  report("dialing x: timed out");
  report("y refused the connection");
  expect(seen).toEqual(["dialing x: timed out", "y refused the connection"]);
  clock = 59_999;
  report("dialing x: timed out");
  expect(seen).toHaveLength(2);
  clock = 60_000;
  report("dialing x: timed out");
  report("y refused the connection");
  expect(seen).toEqual(["dialing x: timed out", "y refused the connection", "dialing x: timed out"]);
});
