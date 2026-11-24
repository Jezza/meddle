import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { paths } from "../src/config";
import { git } from "../src/jj";
import { mergeHeadRows, settleHeadRows } from "../src/pool/heads";
import { shortId } from "../src/pool/ids";
import { markRemoved } from "../src/pool/removed";
import { ensureServiceRepo } from "../src/projects/replicas";
import { headOf } from "../src/scopes/repo";
import type { Scope } from "../src/scopes/scope";
import { startScopeSync, type ScopeSync } from "../src/scopes/sync";
import { peerReady, twoPoolNodes, type GitPoolNode } from "./pool-helpers";
import { read } from "./scope-helpers";

async function until<T>(what: string, get: () => Promise<T> | T, ok: (v: T) => boolean, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await get();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: last ${JSON.stringify(v)}`);
    await Bun.sleep(50);
  }
}

const depsOf = (n: GitPoolNode) => ({ cfg: n.cfg, db: n.db, pool: n.pool, log: (l: string) => n.logs.push(l) });

/** A and B holding A's project, each with a scope sync (`quietMs` small unless given). */
async function pair(opts: { quietMs?: number; startB?: boolean } = {}) {
  const nodes = await twoPoolNodes();
  const { A, B } = nodes;
  const syncs: ScopeSync[] = [];
  try {
    await peerReady(B, A);
    await peerReady(A, B);
    const id = A.project.id;
    await ensureServiceRepo(depsOf(B), id, { memory: false });
    const scope: Scope = { kind: "memory", projectId: id };
    const start = (n: GitPoolNode) => {
      const s = startScopeSync({ ...depsOf(n), quietMs: opts.quietMs ?? 100, scanMs: 60_000 });
      syncs.push(s);
      return s;
    };
    const syncA = start(A);
    const syncB = opts.startB === false ? null : start(B);
    return {
      ...nodes, id, scope, syncA, syncB, start,
      memA: paths(A.cfg).memory(id), memB: paths(B.cfg).memory(id),
      async close() {
        for (const s of syncs) s.stop();
        await nodes.close();
      },
    };
  } catch (err) {
    for (const s of syncs) s.stop();
    await nodes.close();
    throw err;
  }
}

test("a memory written on one node reaches the other within seconds", async () => {
  const p = await pair();
  try {
    await until("A's repo", () => existsSync(p.memA), (v) => v);
    await writeFile(`${p.memA}/x.md`, "from a\n");
    await until("x.md on B", () => read(`${p.memB}/x.md`), (v) => v === "from a\n");
  } finally {
    await p.close();
  }
}, 60_000);

test("both nodes' concurrent appends to MEMORY.md are kept on both", async () => {
  const p = await pair({ quietMs: 60_000 });
  try {
    await p.syncA.syncNow(p.scope);
    await p.syncB!.syncNow(p.scope);
    await until("the same head", async () => [await headOf(p.A.cfg, p.memA, p.scope), await headOf(p.B.cfg, p.memB, p.scope)], ([a, b]) => a === b);
    await writeFile(`${p.memA}/MEMORY.md`, `${(await read(`${p.memA}/MEMORY.md`)) ?? ""}- from a\n`);
    await writeFile(`${p.memB}/MEMORY.md`, `${(await read(`${p.memB}/MEMORY.md`)) ?? ""}- from b\n`);
    p.syncA.touched(p.scope);
    p.syncB!.touched(p.scope);
    const both = (t: string | null) => t !== null && t.includes("- from a\n") && t.includes("- from b\n");
    await until("both lines on A", () => read(`${p.memA}/MEMORY.md`), both);
    await until("both lines on B", () => read(`${p.memB}/MEMORY.md`), both);
    await until("the same head", async () => [await headOf(p.A.cfg, p.memA, p.scope), await headOf(p.B.cfg, p.memB, p.scope)], ([a, b]) => a === b);
  } finally {
    await p.close();
  }
}, 90_000);

test("a node that was not syncing catches up and publishes what it wrote meanwhile", async () => {
  const p = await pair({ startB: false });
  try {
    await until("A's repo", () => existsSync(p.memA), (v) => v);
    await writeFile(`${p.memA}/a.md`, "a\n");
    // B is not syncing yet; what it writes waits.
    await p.syncA.syncNow(p.scope);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(p.memB, { recursive: true });
    await writeFile(`${p.memB}/b.md`, "b\n");
    p.start(p.B);
    await until("a.md on B", () => read(`${p.memB}/a.md`), (v) => v === "a\n");
    await until("b.md on A", () => read(`${p.memA}/b.md`), (v) => v === "b\n");
  } finally {
    await p.close();
  }
}, 60_000);

test("an unreachable head does not hold up the others", async () => {
  const p = await pair();
  try {
    const ghost = "f".repeat(64);
    mergeHeadRows(p.B.db, [{ scope: `memory/${p.id}`, node: ghost, seq: 1, commit: "c".repeat(40), rule: 1, seed: null, edited: true }]);
    await writeFile(`${p.memA}/y.md`, "y\n");
    await until("y.md on B", () => read(`${p.memB}/y.md`), (v) => v === "y\n");
    const state = await until("B's state", () => p.syncB!.state().find((s) => s.scope === `memory/${p.id}`), (s) => s?.waiting.some((w) => w.node === ghost) === true);
    expect(state!.waiting).toContainEqual({ node: ghost, why: "fetch" });
  } finally {
    await p.close();
  }
}, 60_000);

test("a turn end commit names the task", async () => {
  const p = await pair({ quietMs: 60_000 });
  try {
    await p.syncA.syncNow(p.scope);
    await writeFile(`${p.memA}/t.md`, "t\n");
    p.syncA.touched(p.scope, "t1");
    const log = () => git(["log", "--format=%s", "-5", "refs/heads/memory"], p.memA, p.A.cfg).catch(() => "");
    await until("the task named", log, (l) => l.split("\n").includes(`memory from ${shortId(p.A.id)}: task t1`));
  } finally {
    await p.close();
  }
}, 60_000);

test("a head of another rule version is not merged", async () => {
  const p = await pair();
  try {
    await writeFile(`${p.memA}/r.md`, "r\n");
    await until("r.md on B", () => read(`${p.memB}/r.md`), (v) => v === "r\n");
    const head = (await headOf(p.B.cfg, p.memB, p.scope))!;
    const ghost = "e".repeat(64);
    mergeHeadRows(p.B.db, [{ scope: `memory/${p.id}`, node: ghost, seq: 1, commit: head, rule: 2, seed: null, edited: true }]);
    settleHeadRows(p.B.db, `memory/${p.id}`, new Set([head]));
    await p.syncB!.syncNow(p.scope);
    expect(p.syncB!.state().find((s) => s.scope === `memory/${p.id}`)!.waiting).toContainEqual({ node: ghost, why: "rule" });
  } finally {
    await p.close();
  }
}, 60_000);

test("a removed project's memory stops syncing", async () => {
  const p = await pair();
  try {
    await p.syncB!.syncNow(p.scope);
    markRemoved(p.B.db, { id: p.id, name: "a", removedAt: new Date().toISOString(), removedBy: p.A.id });
    await p.syncB!.forget(p.scope);
    await rm(p.memB, { recursive: true, force: true });
    await p.syncB!.syncNow(p.scope);
    expect(existsSync(p.memB)).toBe(false);
    expect(p.syncB!.state().find((s) => s.scope === `memory/${p.id}`)).toBeUndefined();
  } finally {
    await p.close();
  }
}, 60_000);

test("conflict markers an older sync left are replaced before a node first publishes", async () => {
  const p = await pair({ startB: false });
  try {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(p.memB, { recursive: true });
    const marked = "a\n<<<<<<< conflict 1 of 1\n+++++++ side 1\nx\n+++++++ side 2\ny\n>>>>>>> conflict 1 of 1 ends\n";
    await writeFile(`${p.memB}/MEMORY.md`, marked);
    p.start(p.B);
    await until("MEMORY.md on A", () => read(`${p.memA}/MEMORY.md`), (v) => v !== null && v.includes("x\ny"));
    expect(await read(`${p.memA}/MEMORY.md`)).not.toContain("<<<<<<<");
    expect(await read(`${p.memB}/MEMORY.md`)).not.toContain("<<<<<<<");
  } finally {
    await p.close();
  }
}, 60_000);

test("an old node's push landing between a pass's commit and its merge does not drop what the pass committed", async () => {
  const nodes = await twoPoolNodes();
  const { A, B } = nodes;
  let inject: (() => Promise<void>) | null = null;
  const sync = startScopeSync({
    cfg: A.cfg, db: A.db, pool: A.pool, quietMs: 60_000, scanMs: 60_000,
    betweenSections: async () => {
      const go = inject;
      inject = null;
      await go?.();
    },
  });
  try {
    await peerReady(B, A);
    const id = A.project.id;
    const scope: Scope = { kind: "memory", projectId: id };
    const mem = paths(A.cfg).memory(id);
    await writeFile(`${mem}/MEMORY.md`, "- base\n");
    await sync.syncNow(scope);
    await writeFile(`${mem}/mine.md`, "committed by the pass\n");
    inject = async () => {
      // What `pushBookmark` of an older node does: `memory` moved sideways, onto a commit beside this pass's.
      const was = (await git(["rev-parse", "refs/heads/memory^"], mem, A.cfg)).trim();
      const index = `${mem}/.git/test-index`;
      const env = { GIT_INDEX_FILE: index };
      await git(["read-tree", was], mem, A.cfg, { env });
      const blob = (await git(["hash-object", "-w", "--stdin"], mem, A.cfg, { input: "pushed\n" })).trim();
      await git(["update-index", "--add", "--cacheinfo", `100644,${blob},old.md`], mem, A.cfg, { env });
      const tree = (await git(["write-tree"], mem, A.cfg, { env })).trim();
      const pushed = (await git(["commit-tree", tree, "-p", was, "-m", "memory from old"], mem, A.cfg)).trim();
      await git(["update-ref", "refs/heads/memory", pushed], mem, A.cfg);
      await rm(index, { force: true });
    };
    await sync.syncNow(scope);
    expect(inject).toBeNull();
    await sync.syncNow(scope);
    expect(await read(`${mem}/mine.md`)).toBe("committed by the pass\n");
    expect(await read(`${mem}/old.md`)).toBe("pushed\n");
    const head = (await headOf(A.cfg, mem, scope))!;
    expect(await git(["show", `${head}:mine.md`], mem, A.cfg)).toBe("committed by the pass\n");
  } finally {
    sync.stop();
    await nodes.close();
  }
}, 60_000);

test("a scope repo deleted and made again is filled from the peers' heads it already knew", async () => {
  const p = await pair();
  try {
    await writeFile(`${p.memA}/k.md`, "kept\n");
    await until("k.md on B", () => read(`${p.memB}/k.md`), (v) => v === "kept\n");
    await p.syncB!.forget(p.scope);
    await rm(p.memB, { recursive: true, force: true });
    p.B.logs.length = 0;
    await p.syncB!.syncNow(p.scope);
    await until("k.md back on B", () => read(`${p.memB}/k.md`), (v) => v === "kept\n");
    expect(p.B.logs.filter((l) => l.includes("not synced"))).toEqual([]);
  } finally {
    await p.close();
  }
}, 60_000);
