import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { NodeConfig } from "../src/config";
import { git } from "../src/jj";
import { reconcile, type Peer, type Self } from "../src/scopes/reconcile";
import { commitLocal, headOf, moveTo } from "../src/scopes/repo";
import { carry, commitOn, filesOf, makeCfg, MEMORY, PROFILE, put, read, scopeRepo, show } from "./scope-helpers";

const me = (node: string, extra: Partial<Self> = {}): Self => ({ node, seed: null, edited: true, legacy: false, ...extra });
const peer = (node: string, commit: string, extra: Partial<Peer> = {}): Peer => ({ node, commit, seed: null, edited: true, ...extra });

/** Repo `a` with base B and diverged X and Y on it. */
async function diverged(cfg: NodeConfig, x: Record<string, string | null>, y: Record<string, string | null>, base: Record<string, string> = { "MEMORY.md": "- a\n" }) {
  const a = await scopeRepo(cfg, MEMORY, "a");
  const b = await commitOn(cfg, a, null, base, "base");
  return { a, b, x: await commitOn(cfg, a, b, x, "x"), y: await commitOn(cfg, a, b, y, "y") };
}

test("fast-forwards to a descendant", async () => {
  const cfg = await makeCfg();
  const { a, b, x } = await diverged(cfg, { "MEMORY.md": "- a\n- x\n" }, {});
  expect((await reconcile(cfg, a, me("n1"), b, [peer("n2", x)])).head).toBe(x);
});

test("keeps a head that already contains the peer's", async () => {
  const cfg = await makeCfg();
  const { a, b, x } = await diverged(cfg, { "MEMORY.md": "- a\n- x\n" }, {});
  expect((await reconcile(cfg, a, me("n1"), x, [peer("n2", b)])).head).toBe(x);
});

test("adopts the peer's head when it has none", async () => {
  const cfg = await makeCfg();
  const { a, x } = await diverged(cfg, { "MEMORY.md": "- a\n- x\n" }, {});
  expect((await reconcile(cfg, a, me("n1"), null, [peer("n2", x)])).head).toBe(x);
});

test("merges a diverged peer with parents in node-id order", async () => {
  const cfg = await makeCfg();
  const { a, x, y } = await diverged(cfg, { "MEMORY.md": "- a\n- x\n" }, { "MEMORY.md": "- a\n- y\n" });
  // n1 holds x, n2 holds y: from either side the merge is n1's line first.
  const fromN1 = (await reconcile(cfg, a, me("n1"), x, [peer("n2", y)])).head!;
  const fromN2 = (await reconcile(cfg, a, me("n2"), y, [peer("n1", x)])).head!;
  expect(fromN1).toBe(fromN2);
  expect(await show(cfg, a, fromN1, "MEMORY.md")).toBe("- a\n- x\n- y\n");
});

test("adopts the lower commit when files match but histories differ", async () => {
  const cfg = await makeCfg();
  const { a, x, y } = await diverged(cfg, { "MEMORY.md": "- same\n" }, { "MEMORY.md": "- same\n" });
  const lower = x < y ? x : y;
  expect((await reconcile(cfg, a, me("n1"), x, [peer("n2", y)])).head).toBe(lower);
  expect((await reconcile(cfg, a, me("n2"), y, [peer("n1", x)])).head).toBe(lower);
});

test("concurrent settings edits stay valid JSON", async () => {
  const cfg = await makeCfg();
  const { a, x, y } = await diverged(
    cfg,
    { "settings.json": '{"model":"opus","permissions":{"allow":["Bash(ls)"]}}' },
    { "settings.json": '{"model":"sonnet","permissions":{"allow":["Read"]},"env":{"A":"1"}}' },
    { "settings.json": '{"model":"opus","permissions":{"allow":[]}}' },
  );
  const head = (await reconcile(cfg, a, me("n1"), x, [peer("n2", y)])).head!;
  expect(JSON.parse((await show(cfg, a, head, "settings.json"))!)).toEqual({ model: "sonnet", permissions: { allow: ["Bash(ls)", "Read"] }, env: { A: "1" } });
});

test("converges across nodes", async () => {
  const N = Number(process.env.MEDDLE_RECONCILE_NODES ?? 3);
  const STEPS = Number(process.env.MEDDLE_RECONCILE_STEPS ?? 40);
  let s = Number(process.env.MEDDLE_RECONCILE_SEED ?? 1);
  const rand = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;

  const cfg = await makeCfg();
  const nodes = Array.from({ length: N }, (_, i) => `n${i}`);
  const dirs = new Map<string, string>();
  for (const n of nodes) dirs.set(n, await scopeRepo(cfg, MEMORY, n));
  const dir = (n: string) => dirs.get(n)!;
  // A common start, as a project's first memory.
  const start = await commitOn(cfg, dir("n0"), null, { "MEMORY.md": "# Memory\n" }, "start");
  for (const n of nodes) {
    if (n !== "n0") await carry(cfg, dir("n0"), dir(n), start);
    await moveTo(cfg, dir(n), MEMORY, start, "local");
  }

  const pointers = new Set<string>();
  let token = 0;
  const edit = async (n: string) => {
    const d = dir(n);
    const topics = (await readdir(d)).filter((f) => f.endsWith(".md") && f !== "MEMORY.md");
    const r = rand();
    const t = `t${++token}`;
    if (r < 0.45 || topics.length === 0) {
      await put(d, { [`${t}.md`]: `# ${t}\nfact from ${n}\nline two\nline three\n` });
      const pointer = `- [${t}](${t}.md) by ${n}`;
      await put(d, { "MEMORY.md": `${(await read(join(d, "MEMORY.md"))) ?? ""}${pointer}\n` });
      pointers.add(pointer);
    } else if (r < 0.85) {
      const f = pick(topics);
      const lines = (await readFile(join(d, f), "utf8")).split("\n");
      lines[1 + Math.floor(rand() * Math.max(1, lines.length - 2))] = `edited ${t} by ${n}`;
      await put(d, { [f]: lines.join("\n") });
    } else {
      await put(d, { [pick(topics)]: null });
    }
  };
  const sync = async (n: string, peers: string[]) => {
    const d = dir(n);
    const own = await commitLocal(cfg, d, MEMORY, `memory from ${n}`);
    const heads: Peer[] = [];
    for (const m of peers) {
      const h = await headOf(cfg, dir(m), MEMORY);
      if (h === null) continue;
      await carry(cfg, dir(m), d, h);
      heads.push(peer(m, h));
    }
    const { head } = await reconcile(cfg, d, me(n), own, heads);
    const parent = (await git(["log", "-1", "--format=%H", "HEAD"], d, cfg).catch(() => "")).trim();
    if (head !== null && head !== parent) await moveTo(cfg, d, MEMORY, head, `memory from ${n}`);
  };

  for (let i = 0; i < STEPS; i++) {
    const n = pick(nodes);
    if (rand() < 0.6) await edit(n);
    else await sync(n, nodes.filter((m) => m !== n && rand() < 0.6));
  }
  let rounds = 0;
  for (; rounds < 6; rounds++) {
    const before = await Promise.all(nodes.map((n) => headOf(cfg, dir(n), MEMORY)));
    for (const n of nodes) await sync(n, nodes.filter((m) => m !== n));
    const after = await Promise.all(nodes.map((n) => headOf(cfg, dir(n), MEMORY)));
    if (before.join() === after.join() && new Set(after).size === 1) break;
  }
  const heads = await Promise.all(nodes.map((n) => headOf(cfg, dir(n), MEMORY)));
  expect(new Set(heads).size).toBe(1);
  expect(rounds).toBeLessThanOrEqual(3);
  const head = heads[0]!;
  const memory = (await show(cfg, dir("n0"), head, "MEMORY.md"))!.split("\n");
  for (const p of pointers) expect(memory.filter((l) => l === p)).toHaveLength(1);
  for (const f of await filesOf(cfg, dir("n0"), head)) {
    const text = (await show(cfg, dir("n0"), head, f))!;
    expect(text.split("\n").filter((l) => /^(<<<<<<<|>>>>>>>|%%%%%%%|\+\+\+\+\+\+\+)/.test(l))).toEqual([]);
  }
}, 600_000);

// The profile: seeds (spec 6.5, plan amendment A9).

/** A profile repo with a seed S (CLAUDE.md, other.md) and, when `edit`, an edit E on it adding skills/x.md. */
async function seeded(cfg: NodeConfig, name: string, claude: string, edit: boolean) {
  const d = await scopeRepo(cfg, PROFILE, name);
  const seed = await commitOn(cfg, d, null, { "CLAUDE.md": claude, "other.md": `${name}\n` }, "seed profile from x\n\nmeddle-seed: 1");
  const head = edit ? await commitOn(cfg, d, seed, { "skills/x.md": `${name} skill\n` }, "profile") : seed;
  return { d, seed, head };
}

const profile = { profile: true };

test("a seed-only line takes a peer's edited line", async () => {
  const cfg = await makeCfg();
  const a = await seeded(cfg, "a", "a\n", false);
  const b = await seeded(cfg, "b", "b\n", true);
  await carry(cfg, b.d, a.d, b.head);
  const r = await reconcile(cfg, a.d, me("n1", { seed: a.seed, edited: false }), a.head, [peer("n2", b.head, { seed: b.seed })], profile);
  expect(r.head).toBe(b.head);
  expect(r.self).toEqual(me("n1", { seed: b.seed, edited: true }));
});

test("of two seed-only lines the lower node id's wins", async () => {
  const cfg = await makeCfg();
  const a = await seeded(cfg, "a", "a\n", false);
  const b = await seeded(cfg, "b", "b\n", false);
  await carry(cfg, b.d, a.d, b.head);
  await carry(cfg, a.d, b.d, a.head);
  const high = await reconcile(cfg, b.d, me("n2", { seed: b.seed, edited: false }), b.head, [peer("n1", a.head, { seed: a.seed, edited: false })], profile);
  expect(high.head).toBe(a.head);
  const low = await reconcile(cfg, a.d, me("n1", { seed: a.seed, edited: false }), a.head, [peer("n2", b.head, { seed: b.seed, edited: false })], profile);
  expect(low.head).toBe(a.head);
  expect(low.skipped).toEqual([{ node: "n2", why: "seed" }]);
});

test("an edited line skips a seed-only peer", async () => {
  const cfg = await makeCfg();
  const a = await seeded(cfg, "a", "a\n", true);
  const b = await seeded(cfg, "b", "b\n", false);
  await carry(cfg, b.d, a.d, b.head);
  const r = await reconcile(cfg, a.d, me("n2", { seed: a.seed }), a.head, [peer("n1", b.head, { seed: b.seed, edited: false })], profile);
  expect(r.head).toBe(a.head);
  expect(r.skipped).toEqual([{ node: "n1", why: "seed" }]);
});

test("a legacy line takes the first imported pool line and skips seeded ones", async () => {
  const cfg = await makeCfg();
  const legacy = await scopeRepo(cfg, PROFILE, "legacy");
  const old = await commitOn(cfg, legacy, null, { "CLAUDE.md": "old\n" }, "seed profile from /home/x/.claude");
  const fresh = await seeded(cfg, "fresh", "fresh\n", true);
  const pool = await scopeRepo(cfg, PROFILE, "pool");
  const imported = await commitOn(cfg, pool, null, { "CLAUDE.md": "pool\n" }, "profile import from x");
  await carry(cfg, fresh.d, legacy, fresh.head);
  await carry(cfg, pool, legacy, imported);
  const r = await reconcile(cfg, legacy, me("n5", { legacy: true }), old, [
    peer("n1", fresh.head, { seed: fresh.seed }), peer("n2", imported),
  ], profile);
  expect(r.head).toBe(imported);
  expect(r.self).toEqual(me("n5"));
  expect(r.skipped).toEqual([{ node: "n1", why: "seed" }]);
});

test("seed plus edits meeting an unrelated edited line replays only the edits", async () => {
  const cfg = await makeCfg();
  const a = await seeded(cfg, "a", "a\n", true);
  const pool = await scopeRepo(cfg, PROFILE, "pool");
  const imported = await commitOn(cfg, pool, null, { "CLAUDE.md": "pool\n" }, "profile import from x");
  await carry(cfg, pool, a.d, imported);
  const r = await reconcile(cfg, a.d, me("n2", { seed: a.seed }), a.head, [peer("n1", imported)], profile);
  expect((await git(["log", "-1", "--format=%P", r.head!], a.d, cfg)).trim()).toBe(imported);
  expect(await filesOf(cfg, a.d, r.head!)).toEqual(["CLAUDE.md", "skills/x.md"]);
  expect(await show(cfg, a.d, r.head!, "CLAUDE.md")).toBe("pool\n");
  expect(r.self).toEqual(me("n2"));
});

test("an edited line waits for a peer whose seeded line is unrelated and edited", async () => {
  const cfg = await makeCfg();
  const a = await seeded(cfg, "a", "a\n", true);
  const pool = await scopeRepo(cfg, PROFILE, "pool");
  const imported = await commitOn(cfg, pool, null, { "CLAUDE.md": "pool\n" }, "profile import from x");
  await carry(cfg, a.d, pool, a.head);
  const r = await reconcile(cfg, pool, me("n1"), imported, [peer("n2", a.head, { seed: a.seed })], profile);
  expect(r.head).toBe(imported);
  expect(r.skipped).toEqual([{ node: "n2", why: "seed" }]);
});

test("of two seeded lines with edits, only the higher node replays", async () => {
  const cfg = await makeCfg();
  const a = await seeded(cfg, "a", "a\n", true);
  const b = await seeded(cfg, "b", "b\n", true);
  await carry(cfg, b.d, a.d, b.head);
  await carry(cfg, a.d, b.d, a.head);
  const low = await reconcile(cfg, a.d, me("n1", { seed: a.seed }), a.head, [peer("n2", b.head, { seed: b.seed })], profile);
  expect(low.head).toBe(a.head);
  expect(low.skipped).toEqual([{ node: "n2", why: "seed" }]);
  const high = await reconcile(cfg, b.d, me("n2", { seed: b.seed }), b.head, [peer("n1", a.head, { seed: a.seed })], profile);
  expect((await git(["log", "-1", "--format=%P", high.head!], b.d, cfg)).trim()).toBe(a.head);
  expect(high.self.seed).toBe(a.seed);
  // Settled: from the lower node the replayed line is now a descendant.
  await carry(cfg, b.d, a.d, high.head!);
  const again = await reconcile(cfg, a.d, low.self, low.head, [peer("n2", high.head!, { seed: high.self.seed })], profile);
  expect(again.head).toBe(high.head);
});

test("two unrelated edited lines without seeds merge with an empty base", async () => {
  const cfg = await makeCfg();
  const a = await scopeRepo(cfg, PROFILE, "a");
  const x = await commitOn(cfg, a, null, { "CLAUDE.md": "x\n" }, "profile import from a");
  const y = await commitOn(cfg, a, null, { "CLAUDE.md": "y\n" }, "profile import from b");
  const r = await reconcile(cfg, a, me("n1"), x, [peer("n2", y)], profile);
  expect(await show(cfg, a, r.head!, "CLAUDE.md")).toBe("x\ny\n");
});
