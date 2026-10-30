import { test, expect } from "bun:test";
test("--version prints the version", async () => {
  const p = Bun.spawn(["bun", "run", "src/cli.ts", "--version"], { stdout: "pipe" });
  const out = await new Response(p.stdout).text();
  expect(out.trim()).toMatch(/^meddle \d+\.\d+\.\d+$/);
});
