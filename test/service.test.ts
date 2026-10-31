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
