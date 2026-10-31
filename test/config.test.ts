// test/config.test.ts
import { test, expect } from "bun:test";
import { loadConfig, paths, checkTaskRoot, ensureDataDirs } from "../src/config";
test("defaults", () => {
  const cfg = loadConfig({ HOME: "/home/x" });
  expect(cfg.dataDir).toBe("/home/x/.local/share/meddle");
  expect(cfg.taskRoot).toBe("/opt/meddle/tasks");
  expect(cfg.port).toBe(7777);
  expect(cfg.claudeHome).toBe("/home/x/.claude");
  expect(cfg.envPassthrough).toEqual(["TERM", "LANG", "LC_ALL", "SHELL", "TMPDIR", "XDG_RUNTIME_DIR", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"]);
});
test("env overrides and derived paths", () => {
  const cfg = loadConfig({ HOME: "/home/x", MEDDLE_DATA_DIR: "/d", MEDDLE_TASK_ROOT: "/t", MEDDLE_PORT: "8000", CLAUDE_CONFIG_DIR: "/c" });
  const p = paths(cfg);
  expect(p.taskConfig("abc")).toBe("/t/abc/.meddle/claude");
  expect(p.memory("proj")).toBe("/d/memory/proj");
  expect(p.tokenFile).toBe("/d/secrets/claude-token");
  expect(cfg.claudeHome).toBe("/c");
  expect(loadConfig({ HOME: "/home/x", MEDDLE_ENV_PASSTHROUGH: " FOO  BAR " }).envPassthrough).toEqual(["FOO", "BAR"]);
});
test("checkTaskRoot reports a missing root", async () => {
  const cfg = loadConfig({ HOME: "/home/x", MEDDLE_TASK_ROOT: "/nonexistent/meddle" });
  expect((await checkTaskRoot(cfg)).ok).toBe(false);
});
test("ensureDataDirs creates secrets with mode 700", async () => {
  const dir = await import("node:fs/promises").then(fs => fs.mkdtemp("/tmp/meddle-cfg-"));
  const cfg = loadConfig({ HOME: "/home/x", MEDDLE_DATA_DIR: dir, MEDDLE_TASK_ROOT: dir });
  await ensureDataDirs(cfg);
  const st = await import("node:fs/promises").then(fs => fs.stat(paths(cfg).secrets));
  expect(st.mode & 0o777).toBe(0o700);
});
test("ensureDataDirs makes the data dir 700, tightening one that exists", async () => {
  const { mkdtemp, mkdir, stat } = await import("node:fs/promises");
  const home = await mkdtemp("/tmp/meddle-cfg-");
  const cfg = loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/d`, MEDDLE_TASK_ROOT: `${home}/t` });
  await ensureDataDirs(cfg);
  expect((await stat(cfg.dataDir)).mode & 0o777).toBe(0o700);
  const existing = loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/e`, MEDDLE_TASK_ROOT: `${home}/t` });
  await mkdir(existing.dataDir, { mode: 0o755 });
  await ensureDataDirs(existing);
  expect((await stat(existing.dataDir)).mode & 0o777).toBe(0o700);
});
