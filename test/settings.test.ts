// test/settings.test.ts — pool settings: last writer wins per key, filtered names, the env they put on jj and tasks.
import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { loadConfig, type NodeConfig } from "../src/config";
import { buildEnv, type EngineInput } from "../src/engine/options";
import { initColocated, jj, jjEnv } from "../src/jj";
import { PoolSettings, discoveryLighthouseUrl, reservedEnv, type SettingRow } from "../src/pool/settings";
import { PoolStore } from "../src/pool/store";
import { openDb } from "../src/store/db";
import { twoPoolNodes } from "./pool-helpers";

const SELF = "a".repeat(64);
const PEER = "b".repeat(64);

function fresh(env: Record<string, string> = {}, log?: (line: string) => void): { cfg: NodeConfig; settings: PoolSettings } {
  const cfg = loadConfig({ HOME: "/h", MEDDLE_DATA_DIR: "/d", MEDDLE_TASK_ROOT: "/t", ...env });
  const settings = new PoolSettings(openDb(":memory:"), cfg, SELF, log);
  return { cfg, settings };
}

function row(key: string, value: string | null, updatedAt: string, setBy = PEER): SettingRow {
  return { key, value, updatedAt, setBy };
}

test("set, get, list, unset with tombstone", () => {
  const { settings } = fresh();
  settings.set("jj.user", "Lab");
  settings.set("env.FOO", "bar");
  expect(settings.get("jj.user")).toBe("Lab");
  expect(settings.list()).toEqual([{ key: "env.FOO", value: "bar" }, { key: "jj.user", value: "Lab" }]);
  const tomb = settings.unset("env.FOO");
  expect(tomb.value).toBeNull();
  expect(tomb.setBy).toBe(SELF);
  expect(settings.rows().find((r) => r.key === "env.FOO")?.value).toBeNull();
  expect(settings.list()).toEqual([{ key: "jj.user", value: "Lab" }]);
  expect(settings.get("env.FOO")).toBeNull();
});

test("a local write supersedes the row it acts on even when this clock is behind", () => {
  const { settings } = fresh();
  settings.merge([row("jj.user", "Far", "2099-01-01T00:00:00.000Z")]);
  const written = settings.set("jj.user", "Near", "2026-01-01T00:00:00.000Z");
  expect(written.updatedAt).toBe("2099-01-01T00:00:00.001Z");
  expect(settings.get("jj.user")).toBe("Near");
  const later = settings.set("jj.user", "Later", "2099-06-01T00:00:00.000Z");
  expect(later.updatedAt).toBe("2099-06-01T00:00:00.000Z");
});

test("merge is last writer wins per key and reports changes", () => {
  const { settings } = fresh();
  settings.set("jj.user", "Lab", "2026-01-01T00:00:00.000Z");
  expect(settings.merge([row("jj.user", "Newer", "2026-01-02T00:00:00.000Z")])).toBe(true);
  expect(settings.get("jj.user")).toBe("Newer");
  expect(settings.merge([row("jj.user", "Older", "2026-01-01T12:00:00.000Z")])).toBe(false);
  expect(settings.get("jj.user")).toBe("Newer");
  expect(settings.merge([row("jj.user", "Newer", "2026-01-02T00:00:00.000Z")])).toBe(false);
  expect(settings.merge([row("env.FOO", "bar", "2026-01-01T00:00:00.000Z")])).toBe(true);
  expect(settings.merge([row("env.FOO", null, "2026-01-03T00:00:00.000Z")])).toBe(true);
  expect(settings.get("env.FOO")).toBeNull();
  expect(settings.list()).toEqual([{ key: "jj.user", value: "Newer" }]);
  expect(settings.rows().find((r) => r.key === "env.FOO")).toEqual(row("env.FOO", null, "2026-01-03T00:00:00.000Z"));
});

test("invalid keys and reserved names are refused at set and dropped at merge", () => {
  const lines: string[] = [];
  const { settings } = fresh({}, (line) => lines.push(line));
  expect(() => settings.set("foo", "x")).toThrow("invalid setting key: foo");
  expect(() => settings.set("env.lower", "x")).toThrow("invalid setting key: env.lower");
  expect(() => settings.unset("foo")).toThrow("invalid setting key: foo");
  expect(() => settings.set("env.PATH", "x")).toThrow("reserved environment name: PATH");
  expect(() => settings.set("env.MEDDLE_PORT", "1")).toThrow("reserved environment name: MEDDLE_PORT");
  expect(() => settings.set("env.ANTHROPIC_API_KEY", "k")).toThrow("reserved environment name: ANTHROPIC_API_KEY");
  expect(() => settings.set("env.JJ_USER", "x")).toThrow("reserved environment name: JJ_USER");
  expect(() => settings.set("limits.running", "-1")).toThrow("limits.running must be a non-negative integer");
  expect(() => settings.set("limits.running", "1.5")).toThrow("limits.running must be a non-negative integer");
  expect(() => settings.set("lighthouse.url", "")).toThrow("lighthouse.url must not be empty");
  expect(settings.rows()).toEqual([]);
  for (const name of ["PATH", "HOME", "LD_PRELOAD", "GIT_DIR", "MEDDLE_ANYTHING", "CLAUDE_CODE_OAUTH_TOKEN"]) expect(reservedEnv(name)).toBe(true);
  expect(reservedEnv("FOO")).toBe(false);

  expect(settings.merge([row("env.PATH", "/evil", "2026-01-01T00:00:00.000Z")])).toBe(false);
  expect(settings.merge([row("env.PATH", "/evil", "2026-01-02T00:00:00.000Z")])).toBe(false);
  expect(settings.merge([row("nonsense", "x", "2026-01-01T00:00:00.000Z")])).toBe(false);
  expect(settings.env().PATH).toBeUndefined();
  expect(settings.rows()).toEqual([]);
  expect(lines.filter((l) => l === "meddle: settings: ignored replicated key env.PATH")).toHaveLength(1);
  expect(lines).toContain("meddle: settings: ignored replicated key nonsense");
  expect(settings.ignored).toBe(3);
});

test("env maps jj identity and env.* and apply updates cfg.poolEnv", () => {
  const { cfg, settings } = fresh();
  settings.set("jj.user", "Lab");
  settings.set("jj.email", "lab@example.invalid");
  settings.set("env.FOO", "bar");
  settings.set("limits.running", "2");
  settings.set("lighthouse.url", "https://lighthouse.example.invalid");
  expect(settings.env()).toEqual({ JJ_USER: "Lab", JJ_EMAIL: "lab@example.invalid", FOO: "bar" });
  expect(cfg.poolEnv).toEqual({});
  settings.apply();
  expect(jjEnv(cfg).JJ_USER).toBe("Lab");
  expect(jjEnv(cfg).FOO).toBe("bar");
  const manifest = {
    id: "abc", title: "t", sessionId: "11111111-1111-4111-8111-111111111111", primaryProjectId: "p1", createdAt: "",
    projects: [{ id: "p1", name: "a", replica: "/r/a", workspace: "a", parent: "root()" }],
  };
  const input: EngineInput = {
    cfg, manifest, contexts: [], projectSettings: [], token: "tok-a", prompt: (async function* () {})(),
    canUseTool: async () => ({ behavior: "deny" as const, message: "x" }), onPermissionDenied: () => {},
    sessionStore: {} as EngineInput["sessionStore"], resume: false,
  };
  const env = buildEnv(input);
  expect(env.FOO).toBe("bar");
  expect(env.JJ_USER).toBe("Lab");
  expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok-a");
  const first = cfg.poolEnv;
  settings.apply();
  expect(cfg.poolEnv).not.toBe(first);
  expect(cfg.poolEnv).toEqual(first);
});

test("runningLimit prefers MEDDLE_MAX_RUNNING, then limits.running, then 0", () => {
  const pinned = fresh({ MEDDLE_MAX_RUNNING: "2" }).settings;
  pinned.set("limits.running", "5");
  expect(pinned.runningLimit()).toBe(2);
  const { settings } = fresh();
  expect(settings.runningLimit()).toBe(0);
  settings.set("limits.running", "3", "2026-01-01T00:00:00.000Z");
  expect(settings.runningLimit()).toBe(3);
  settings.merge([row("limits.running", "abc", "2026-01-02T00:00:00.000Z")]);
  expect(settings.runningLimit()).toBe(0);
  settings.set("limits.running", "4");
  settings.unset("limits.running");
  expect(settings.runningLimit()).toBe(0);
});

test("lighthouse.url applies live unless the node's env is explicit", () => {
  const unset = fresh({});
  expect(unset.cfg.lighthouseUrlExplicit).toBe(false);
  expect(discoveryLighthouseUrl(unset.cfg, unset.settings)).toBe("https://iroh.ichor.io");
  unset.settings.set("lighthouse.url", "https://one.example.invalid");
  expect(unset.settings.lighthouseUrl()).toBe("https://one.example.invalid");
  expect(discoveryLighthouseUrl(unset.cfg, unset.settings)).toBe("https://one.example.invalid");
  // A replicated empty value never reaches Discovery.
  unset.settings.merge([row("lighthouse.url", "", "2099-01-01T00:00:00.000Z")]);
  expect(unset.settings.lighthouseUrl()).toBeNull();
  expect(discoveryLighthouseUrl(unset.cfg, unset.settings)).toBe("https://iroh.ichor.io");

  const explicit = fresh({ MEDDLE_LIGHTHOUSE_URL: "https://mine.example.invalid" });
  expect(explicit.cfg.lighthouseUrlExplicit).toBe(true);
  explicit.settings.set("lighthouse.url", "https://one.example.invalid");
  expect(discoveryLighthouseUrl(explicit.cfg, explicit.settings)).toBe("https://mine.example.invalid");
});

test("joining another pool drops the old pool's settings", () => {
  const db = openDb(":memory:");
  const cfg = loadConfig({ HOME: "/h", MEDDLE_DATA_DIR: "/d", MEDDLE_TASK_ROOT: "/t" });
  const settings = new PoolSettings(db, cfg, SELF);
  const store = new PoolStore(db);
  store.ensurePool({ nodeId: SELF, hostname: "h" });
  settings.set("jj.user", "Old pool");
  store.replacePool({ poolId: "p2", poolSecret: "s2", createdAt: "2026-01-01T00:00:00.000Z" }, store.roster());
  expect(settings.rows()).toEqual([]);
});

test("settings replicate between two nodes and jj commits on the other node carry the identity", async () => {
  const { A, B, close } = await twoPoolNodes();
  const dir = await mkdtemp("/tmp/meddle-settings-");
  try {
    A.pool.settings.set("jj.user", "Lab");
    A.pool.settings.set("jj.email", "lab@example.invalid");
    await A.pool.refresh();
    const deadline = Date.now() + 10_000;
    while (B.pool.settings.get("jj.user") !== "Lab" || B.pool.settings.get("jj.email") !== "lab@example.invalid") {
      if (Date.now() > deadline) throw new Error(`B has ${JSON.stringify(B.pool.settings.list())}`);
      await Bun.sleep(20);
    }
    expect(B.cfg.poolEnv).toEqual({ JJ_USER: "Lab", JJ_EMAIL: "lab@example.invalid" });
    await initColocated(dir, B.cfg);
    await jj(["describe", "-m", "x"], dir, B.cfg);
    // The preload sets JJ_EMAIL=test@meddle.invalid in this process: the pool's identity wins over it.
    expect((await jj(["log", "-r", "@", "--no-graph", "-T", "author.email()"], dir, B.cfg)).trim()).toBe("lab@example.invalid");
    expect((await jj(["log", "-r", "@", "--no-graph", "-T", "author.name()"], dir, B.cfg)).trim()).toBe("Lab");
  } finally {
    await close();
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
