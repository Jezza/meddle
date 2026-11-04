// test/embedded.test.ts — the single binary: the files it embeds take the place of the checkout's, and a build pins the
// Claude Code of its target's platform.
import { test, expect } from "bun:test";
import { claudePackage } from "../scripts/claude-package";
import { startDashboard } from "../src/dashboard/server";
import { embed } from "../src/embedded";
import { claudeCodeVersion } from "../src/version";
import { startPoolNode } from "./pool-helpers";

test("embedded, the dashboard serves the embedded page and script, and the version is the embedded one", async () => {
  const node = await startPoolNode();
  const claudeCode = { version: "9.9.9", sdkVersion: "0.9.9", platform: "linux-x64", binary: "claude", checksum: "", size: 0 };
  embed({ claude: null, claudeCode, html: "<p>packed page</p>", script: "/* packed script */", unit: "" });
  try {
    expect(claudeCodeVersion()).toBe("9.9.9");
    const dashboard = await startDashboard({ port: 0 }, node.host);
    try {
      expect(await (await fetch(dashboard.url)).text()).toBe("<p>packed page</p>");
      const script = await fetch(new URL("/main.js", dashboard.url));
      expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
      expect(await script.text()).toBe("/* packed script */");
    } finally {
      await dashboard.stop();
    }
  } finally {
    embed(null);
    await node.close();
  }
  expect(claudeCodeVersion()).not.toBe("9.9.9");
});

test("a build embeds the Claude Code of its target's platform package", () => {
  const glibcX64 = { platform: "linux", arch: "x64", musl: () => false };
  expect(claudePackage(null, glibcX64)).toEqual({
    platform: "linux-x64",
    name: "@anthropic-ai/claude-agent-sdk-linux-x64",
    binary: "@anthropic-ai/claude-agent-sdk-linux-x64/claude",
  });
  expect(claudePackage(null, { ...glibcX64, musl: () => true }).name).toBe("@anthropic-ai/claude-agent-sdk-linux-x64-musl");
  expect(claudePackage("bun-linux-arm64").name).toBe("@anthropic-ai/claude-agent-sdk-linux-arm64");
  expect(claudePackage("bun-linux-x64-musl-baseline").name).toBe("@anthropic-ai/claude-agent-sdk-linux-x64-musl");
  expect(claudePackage("bun-darwin-arm64").binary).toBe("@anthropic-ai/claude-agent-sdk-darwin-arm64/claude");
  expect(claudePackage("bun-windows-x64").binary).toBe("@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe");
  expect(() => claudePackage("bun-linux-riscv64")).toThrow("unsupported --target bun-linux-riscv64");
});
