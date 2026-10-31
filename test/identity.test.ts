import { test, expect } from "bun:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { SecretKey } from "@number0/iroh";
import { loadConfig, ensureDataDirs, paths } from "../src/config";
import { loadOrCreateIdentity, shortId, isNodeId, hexOf, endpointIdOf } from "../src/pool/identity";

async function cfg() { const d = await mkdtemp("/tmp/meddle-id-"); const c = loadConfig({ HOME: d, MEDDLE_DATA_DIR: d, MEDDLE_TASK_ROOT: d }); await ensureDataDirs(c); return c; }

test("the identity is created once, hex, mode 600, and its id is the iroh public key", async () => {
  const c = await cfg();
  const a = await loadOrCreateIdentity(c);
  const b = await loadOrCreateIdentity(c);
  expect(isNodeId(a.id)).toBe(true);
  expect(b.id).toBe(a.id);
  expect(a.secret.length).toBe(32);
  expect((await stat(paths(c).irohKey)).mode & 0o777).toBe(0o600);
  expect((await readFile(paths(c).irohKey, "utf8")).trim()).toMatch(/^[0-9a-f]{64}$/);
  expect(hexOf(SecretKey.fromBytes(Array.from(a.secret)).public())).toBe(a.id);
  expect(endpointIdOf(a.id).equals(SecretKey.fromBytes(Array.from(a.secret)).public())).toBe(true);
  expect(() => endpointIdOf("zz")).toThrow("not a node id");
  expect(shortId(a.id)).toBe(a.id.slice(0, 10));
});
