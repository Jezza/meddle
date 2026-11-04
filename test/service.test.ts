import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { closedPort, meddle } from "./helpers";

test("service install --dry-run prints the unit and the task-root command and writes nothing", async () => {
  const home = await mkdtemp("/tmp/meddle-service-");
  const { stdout, stderr, code } = await meddle(["service", "install", "--dry-run"], { HOME: home, MEDDLE_PORT: String(await closedPort()) });
  expect(stderr).toBe("");
  expect(code).toBe(0);
  expect(stdout).toContain("ExecStart=");
  expect(stdout).toContain("serve");
  expect(stdout).toContain("WorkingDirectory=");
  const sudo = stdout.split("\n").find((line) => line.startsWith("sudo "));
  expect(sudo).toContain("/opt/meddle/tasks");
  expect(existsSync(`${home}/.config/systemd`)).toBe(false);
});

test("the unit carries the PATH of the shell that installs it, escaped for systemd", async () => {
  const home = await mkdtemp("/tmp/meddle-service-");
  const run = async (path: string) =>
    (await meddle(["service", "install", "--dry-run"], { HOME: home, MEDDLE_PORT: String(await closedPort()), PATH: path })).stdout;
  const bun = process.execPath.replace(/\/[^/]+$/, "");
  expect(await run(`/home/u/.cargo/bin:${bun}:/usr/bin:/bin`)).toContain(`\nEnvironment=PATH=/home/u/.cargo/bin:${bun}:/usr/bin:/bin\n`);
  // A `%` is doubled; a space quotes the whole assignment.
  expect(await run(`/opt/50%/bin:${bun}:/usr/bin:/bin`)).toContain(`\nEnvironment=PATH=/opt/50%%/bin:${bun}:/usr/bin:/bin\n`);
  expect(await run(`/opt/my tools/bin:${bun}:/usr/bin:/bin`)).toContain(`\nEnvironment="PATH=/opt/my tools/bin:${bun}:/usr/bin:/bin"\n`);
});

test("a node without jj or git on its PATH hosts no tasks, and says why", async () => {
  const { checkTaskRoot, loadConfig } = await import("../src/config");
  const { mkdir } = await import("node:fs/promises");
  const home = await mkdtemp("/tmp/meddle-tools-");
  await mkdir(`${home}/t`);
  const cfg = loadConfig({ HOME: home, MEDDLE_TASK_ROOT: `${home}/t` });
  expect(await checkTaskRoot(cfg)).toEqual({ ok: true });
  const saved = process.env.PATH;
  process.env.PATH = `${home}/empty`;
  try {
    expect(await checkTaskRoot(cfg)).toEqual({ ok: false, reason: `jj is not on this node's PATH (${home}/empty)` });
  } finally {
    process.env.PATH = saved;
  }
});
