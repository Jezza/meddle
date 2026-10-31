// test/token.test.ts
import { test, expect } from "bun:test";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig, ensureDataDirs, paths } from "../src/config";
import { setToken, getToken, tokenStatus } from "../src/token";
const A = "a".repeat(64);
async function cfg() { const d = await mkdtemp("/tmp/meddle-tok-"); const c = loadConfig({ HOME: d, MEDDLE_DATA_DIR: d, MEDDLE_TASK_ROOT: d }); await ensureDataDirs(c); return c; }
test("trims CRLF and sets mode 600", async () => {
  const c = await cfg();
  await setToken(c, "sk-ant-oat01-abc\r\n");
  expect(await getToken(c)).toBe("sk-ant-oat01-abc");
  expect(((await stat(paths(c).tokenFile)).mode & 0o777)).toBe(0o600);
});
test("empty token is refused", async () => {
  await expect(setToken(await cfg(), "  \n")).rejects.toThrow("empty token");
});
test("status reports a one-year expiry", async () => {
  const c = await cfg();
  await setToken(c, "x");
  const s = await tokenStatus(c);
  expect(s.present).toBe(true);
  expect(new Date(s.expiresAt!).getTime() - new Date(s.setAt!).getTime()).toBe(365 * 86400_000);
});
test("cli token set --file then status round-trips without printing the token", async () => {
  const d = await mkdtemp("/tmp/meddle-tok-cli-");
  const tokenPath = join(d, "token-input");
  const fake = "sk-ant-oat01-abc";
  await writeFile(tokenPath, `${fake}\n`);
  const env = { ...process.env, HOME: d, MEDDLE_DATA_DIR: d, MEDDLE_TASK_ROOT: d };
  const cwd = join(import.meta.dir, "..");
  const run = async (...args: string[]) => {
    const p = Bun.spawn([process.execPath, "run", "src/cli.ts", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { stdout, stderr, code };
  };
  const set = await run("token", "set", "--file", tokenPath);
  expect(set.code).toBe(0);
  expect(set.stdout).not.toContain(fake);
  const status = await run("token", "status");
  expect(status.code).toBe(0);
  expect(status.stdout).toContain("present: true");
  expect(status.stdout).not.toContain(fake);
});
test("setToken records setBy and a given setAt; tokenStatus returns both", async () => {
  const c = await cfg();
  await setToken(c, "tok", { setAt: "2026-10-31T10:00:00.000Z", setBy: A });
  expect(await tokenStatus(c)).toEqual({ present: true, setAt: "2026-10-31T10:00:00.000Z", setBy: A, expiresAt: "2027-10-31T10:00:00.000Z" });
});
