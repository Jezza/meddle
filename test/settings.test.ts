// test/settings.test.ts — pool settings: last writer wins per key, filtered names, the env they put on jj and tasks.
import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { loadConfig, type NodeConfig } from "../src/config";
import { buildEnv, type EngineInput } from "../src/engine/options";
import { initColocated, jj, jjEnv } from "../src/jj";
import { MAX_POOL_ENV, MAX_SETTING_KEY, MAX_SETTING_VALUE, PoolSettings, discoveryLighthouseUrl, reservedEnv, type SettingRow } from "../src/pool/settings";
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
  // A time that is not a millisecond ISO time would sort above every real one or break the next local write.
  expect(settings.merge([row("env.FOO", "x", "9")])).toBe(false);
  expect(settings.merge([row("env.FOO", "x", "+275760-09-13T00:00:00.000Z")])).toBe(false);
  expect(settings.get("env.FOO")).toBeNull();
  expect(settings.env().PATH).toBeUndefined();
  expect(settings.rows()).toEqual([]);
  expect(lines.filter((l) => l === 'meddle: settings: ignored replicated key "env.PATH"')).toHaveLength(1);
  expect(lines).toContain('meddle: settings: ignored replicated key "nonsense"');
  expect(settings.ignored).toBe(5);
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
    projects: [{ id: "p1", name: "a", replica: "/r/a", workspace: "a", parent: "root()", base: ["0000000000000000000000000000000000000000"], context: null }],
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

test("setting the pool secret keeps this node's settings: they merge with the pool's like any member's", () => {
  const db = openDb(":memory:");
  const cfg = loadConfig({ HOME: "/h", MEDDLE_DATA_DIR: "/d", MEDDLE_TASK_ROOT: "/t" });
  const settings = new PoolSettings(db, cfg, SELF);
  const store = new PoolStore(db);
  store.ensurePool({ nodeId: SELF, hostname: "h" });
  settings.set("jj.user", "Set before the secret");
  store.setSecret({ nodeId: SELF, hostname: "h" }, "default", "s2-secret-long-enough", "2026-01-01T00:00:00.000Z");
  expect(settings.get("jj.user")).toBe("Set before the secret");
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

const BAD_VALUE = "setting value must be at most 4096 characters with no control characters";

test("a value must be at most 4096 characters with no control characters but tab, at set and at merge", async () => {
  const lines: string[] = [];
  const { cfg, settings } = fresh({}, (line) => lines.push(line));
  expect(() => settings.set("env.FOO", "a\0b")).toThrow(BAD_VALUE);
  expect(() => settings.set("env.FOO", "x".repeat(MAX_SETTING_VALUE + 1))).toThrow(BAD_VALUE);
  expect(() => settings.set("jj.user", "Lab\nInjected")).toThrow(BAD_VALUE);
  expect(() => settings.set("env.FOO", "\x1b[31m")).toThrow(BAD_VALUE);
  expect(settings.set("env.TABBED", "a\tb").value).toBe("a\tb");
  expect(settings.set("env.LONG", "x".repeat(MAX_SETTING_VALUE)).value).toHaveLength(MAX_SETTING_VALUE);

  expect(settings.merge([row("env.FOO", "a\0b", "2026-01-01T00:00:00.000Z")])).toBe(false);
  expect(settings.merge([row("env.BIG", "x".repeat(200_000), "2026-01-01T00:00:00.000Z")])).toBe(false);
  expect(settings.rows().map((r) => r.key)).toEqual(["env.LONG", "env.TABBED"]);
  settings.apply();
  expect(cfg.poolEnv.FOO).toBeUndefined();
  expect(cfg.poolEnv.BIG).toBeUndefined();
  expect(cfg.poolEnv.TABBED).toBe("a\tb");
  expect(lines).toEqual(['meddle: settings: ignored replicated key "env.FOO"', 'meddle: settings: ignored replicated key "env.BIG"']);
  // Every jj still spawns.
  expect(await jj(["--version"], "/", cfg)).toMatch(/^jj /);
});

test("the reserved names include git config, ssh and exec, node, bash and XDG config, and the loaders", () => {
  const { settings } = fresh({}, () => {});
  for (const name of ["GIT_CONFIG_COUNT", "NODE_OPTIONS", "GIT_SSH_COMMAND", "GIT_EXEC_PATH", "LD_AUDIT", "BASH_ENV", "XDG_CONFIG_HOME"]) {
    expect(reservedEnv(name)).toBe(true);
    expect(() => settings.set(`env.${name}`, "x")).toThrow(`reserved environment name: ${name}`);
  }
  for (const name of ["GIT_CONFIG_KEY_0", "GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_12", "MEDDLE_X"]) {
    expect(reservedEnv(name)).toBe(true);
    expect(() => settings.set(`env.${name}`, "x")).toThrow(`reserved environment name: ${name}`);
  }
  expect(settings.merge([row("env.GIT_CONFIG_KEY_0", "core.sshCommand", "2026-01-01T00:00:00.000Z")])).toBe(false);
  expect(settings.merge([row("env.NODE_OPTIONS", "--import=data:,", "2026-01-01T00:00:00.000Z")])).toBe(false);
  expect(settings.env()).toEqual({});
  for (const name of ["GIT_CONFIG", "GIT_CONFIG_KEYS", "XDG_CONFIG_DIRS", "NODE_ENV", "GIT_AUTHOR_NAME"]) expect(reservedEnv(name)).toBe(false);
});

test("the ignored-key log line escapes the peer's key and cuts it to 80 characters", () => {
  const lines: string[] = [];
  const { settings } = fresh({}, (line) => lines.push(line));
  settings.merge([row("bad\nmeddle: forged line \x1b[31m", "x", "2026-01-01T00:00:00.000Z")]);
  settings.merge([row("y".repeat(500), "x", "2026-01-01T00:00:00.000Z")]);
  expect(lines).toEqual([
    'meddle: settings: ignored replicated key "bad\\nmeddle: forged line \\u001b[31m"',
    `meddle: settings: ignored replicated key "${"y".repeat(80)}"`,
  ]);
  // Distinct junk keys are counted but only the first 100 logged.
  settings.merge(Array.from({ length: 200 }, (_, i) => row(`junk${i}`, "x", "2026-01-01T00:00:00.000Z")));
  expect(lines).toHaveLength(100);
  expect(settings.ignored).toBe(202);
});

test("an empty jj identity is refused at set and dropped at merge", () => {
  const { settings } = fresh({}, () => {});
  expect(() => settings.set("jj.user", "")).toThrow("jj.user must not be empty");
  expect(() => settings.set("jj.email", "")).toThrow("jj.email must not be empty");
  settings.set("jj.user", "Lab", "2026-01-01T00:00:00.000Z");
  expect(settings.merge([row("jj.user", "", "2026-01-02T00:00:00.000Z"), row("jj.email", "", "2026-01-02T00:00:00.000Z")])).toBe(false);
  expect(settings.get("jj.user")).toBe("Lab");
  expect(settings.env()).toEqual({ JJ_USER: "Lab" });
  // An empty env.* value is a value like any other.
  expect(settings.set("env.EMPTY", "").value).toBe("");
});

test("equal times converge: the greater setBy wins, then the greater value", () => {
  const at = "2026-01-01T00:00:00.000Z";
  const pairs: [SettingRow, SettingRow][] = [
    [row("jj.user", "From A", at, SELF), row("jj.user", "From B", at, PEER)],
    [row("jj.user", "Apple", at, PEER), row("jj.user", "Banana", at, PEER)],
    [row("jj.user", null, at, PEER), row("jj.user", "Kept", at, PEER)],
  ];
  for (const [x, y] of pairs) {
    const one = fresh().settings;
    const two = fresh().settings;
    one.merge([x]);
    two.merge([y]);
    one.merge(two.rows());
    two.merge(one.rows());
    expect(one.rows()).toEqual([y]);
    expect(two.rows()).toEqual([y]);
    // Both directions agree, and re-merging changes nothing.
    expect(one.merge(two.rows())).toBe(false);
    expect(two.merge(one.rows())).toBe(false);
  }
});

test("a key is at most 256 characters, at set, at merge and in env()", async () => {
  const lines: string[] = [];
  const db = openDb(":memory:");
  const cfg = loadConfig({ HOME: "/h", MEDDLE_DATA_DIR: "/d", MEDDLE_TASK_ROOT: "/t" });
  const settings = new PoolSettings(db, cfg, SELF, (line) => lines.push(line));
  const long = `env.${"A".repeat(296)}`;
  expect(long).toHaveLength(300);
  expect(() => settings.set(long, "x")).toThrow(`invalid setting key: ${long.slice(0, 80)}`);
  expect(() => settings.set(long, "x")).not.toThrow(long.slice(0, 81));
  expect(settings.set(`env.${"B".repeat(MAX_SETTING_KEY - 4)}`, "ok").value).toBe("ok");
  const huge = `env.${"A".repeat(200_000)}`;
  expect(settings.merge([row(huge, "x", "2026-01-01T00:00:00.000Z"), row(long, "x", "2026-01-01T00:00:00.000Z")])).toBe(false);
  expect(lines).toEqual([`meddle: settings: ignored replicated key ${JSON.stringify(huge.slice(0, 80))}`]);
  // A row stored before this rule (or by any other way in) is skipped by env() too.
  db.query("INSERT INTO settings (key, value, updated_at, set_by) VALUES (?, ?, ?, ?)").run(huge, "x", "2026-01-01T00:00:00.000Z", PEER);
  settings.apply();
  expect(Object.keys(cfg.poolEnv)).toEqual(["B".repeat(MAX_SETTING_KEY - 4)]);
  expect(await jj(["--version"], "/", cfg)).toMatch(/^jj /);
});

test("env() stops adding settings past 64 KiB, in key order, and logs it once", async () => {
  const lines: string[] = [];
  const { cfg, settings } = fresh({}, (line) => lines.push(line));
  const names = Array.from({ length: 20 }, (_, i) => `V${String(i).padStart(2, "0")}`);
  for (const name of names) settings.set(`env.${name}`, "x".repeat(MAX_SETTING_VALUE));
  settings.apply();
  settings.apply();
  // Each entry is 3 + 4096 characters: 15 fit in 65536, the 16th would not.
  const fit = Math.floor(MAX_POOL_ENV / (3 + MAX_SETTING_VALUE));
  expect(fit).toBe(15);
  expect(Object.keys(cfg.poolEnv)).toEqual(names.slice(0, fit));
  expect(lines).toEqual(["meddle: settings: environment over 64 KiB; later settings not applied"]);
  expect(await jj(["--version"], "/", cfg)).toMatch(/^jj /);
});

test("C1 control characters are refused like C0 ones", () => {
  const { settings } = fresh({}, () => {});
  for (const c of ["\u0080", "\u009b", "\u009f"]) {
    expect(() => settings.set("env.FOO", `a${c}b`)).toThrow(BAD_VALUE);
    expect(settings.merge([row("env.FOO", `a${c}b`, "2026-01-01T00:00:00.000Z")])).toBe(false);
  }
  expect(settings.set("env.FOO", "caf\u00e9 \u00a0").value).toBe("caf\u00e9 \u00a0");
});

test("default model and effort: unset reads opus at medium, a bad effort or empty model is refused", () => {
  const { settings } = fresh();
  expect(settings.defaultModel()).toBe("opus");
  expect(settings.defaultEffort()).toBe("medium");
  settings.set("defaults.model", "opus");
  settings.set("defaults.effort", "high");
  expect(settings.defaultModel()).toBe("opus");
  expect(settings.defaultEffort()).toBe("high");
  expect(() => settings.set("defaults.effort", "huge")).toThrow("defaults.effort must be one of");
  expect(() => settings.set("defaults.model", "")).toThrow("must not be empty");
});
