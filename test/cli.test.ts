import { test, expect } from "bun:test";
import { resolveNodeId } from "../src/pool/ids";
import { childEnv, closedPort } from "./helpers";

/** The env a CLI child runs with: no inherited MEDDLE_* and a port nothing listens on. */
async function env() {
  return childEnv({ MEDDLE_PORT: String(await closedPort()) });
}

test("--version prints the version", async () => {
  const p = Bun.spawn(["bun", "run", "src/cli.ts", "--version"], { env: await env(), stdout: "pipe" });
  const out = await new Response(p.stdout).text();
  expect(out.trim()).toMatch(/^meddle \d+\.\d+\.\d+$/);
});

test("the usage text lists the pool subcommands", async () => {
  const p = Bun.spawn(["bun", "run", "src/cli.ts"], { env: await env(), stdout: "pipe", stderr: "pipe" });
  const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  expect(code).toBe(2);
  const lines = err.split("\n").map((l) => l.trim());
  expect(lines).toContain("meddle invite");
  expect(lines).toContain("meddle join <ticket>");
  expect(lines).toContain("meddle pool");
  expect(lines).toContain("meddle task move <id> <node> [--now]");
});

test("a node is named by its full id or a unique prefix of one", () => {
  const ids = ["ab".repeat(32), "ac".repeat(32), "bb".repeat(32)];
  expect(resolveNodeId(ids, ids[0]!)).toBe(ids[0]!);
  expect(resolveNodeId(ids, "ab")).toBe(ids[0]!);
  expect(resolveNodeId(ids, "b")).toBe(ids[2]!);
  expect(() => resolveNodeId(ids, "a")).toThrow("ambiguous node: a");
  expect(() => resolveNodeId(ids, "cc")).toThrow("no such node: cc");
  expect(() => resolveNodeId(ids, "")).toThrow("no such node: ");
});
