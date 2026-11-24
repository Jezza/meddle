import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { paths } from "../src/config";
import { git, isJjRepo, jj } from "../src/jj";
import { listHeadRows } from "../src/pool/heads";
import { importProfile, profileStanding, seedProfile } from "../src/profile";
import { poolNodes, type GitPoolNode } from "./pool-helpers";

const read = (path: string) => readFile(path, "utf8").catch(() => null);

async function until<T>(what: string, get: () => Promise<T> | T, ok: (v: T) => boolean, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await get();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: last ${JSON.stringify(v)}`);
    await Bun.sleep(50);
  }
}

/** Gives `node` a `~/.claude` with `claude` as its CLAUDE.md, a skill, and Claude Code's synced account skills. */
async function claudeHome(node: GitPoolNode, claude: string): Promise<void> {
  const home = node.cfg.claudeHome;
  await mkdir(`${home}/skills/babysit`, { recursive: true });
  await mkdir(`${home}/skills/synced/org_acct/docs`, { recursive: true });
  await writeFile(`${home}/CLAUDE.md`, claude);
  await writeFile(`${home}/skills/babysit/SKILL.md`, "babysit\n");
  await writeFile(`${home}/skills/synced/org_acct/docs/SKILL.md`, "docs\n");
}

const profileOf = (n: GitPoolNode) => paths(n.cfg).profile;

test("a fresh node seeds and marks its line a seed, without the account's synced skills", async () => {
  const { nodes, close } = await poolNodes(1);
  const [A] = nodes as [GitPoolNode];
  try {
    await claudeHome(A, "mine\n");
    await seedProfile(A.cfg);
    const standing = await profileStanding(A.cfg);
    expect(standing).toMatchObject({ legacy: false, edited: false });
    expect(standing!.seed).toMatch(/^[0-9a-f]{40}$/);
    expect(await git(["log", "-1", "--format=%B", standing!.seed!], profileOf(A), A.cfg)).toContain("meddle-seed: 1");
    expect(await read(`${profileOf(A)}/CLAUDE.md`)).toBe("mine\n");
    expect(existsSync(`${profileOf(A)}/skills/synced`)).toBe(false);
    expect(existsSync(`${profileOf(A)}/skills/babysit/SKILL.md`)).toBe(true);
  } finally {
    await close();
  }
}, 30_000);

test("an existing profile becomes legacy: kept, never published, its synced skills dropped", async () => {
  const { nodes, close } = await poolNodes(1, { nodes: [{ scopeSync: true }] });
  const [A] = nodes as [GitPoolNode];
  try {
    // A profile as an older meddle seeded it.
    const dir = profileOf(A);
    await mkdir(`${dir}/skills/synced/x`, { recursive: true });
    await writeFile(`${dir}/CLAUDE.md`, "old\n");
    await writeFile(`${dir}/skills/synced/x/SKILL.md`, "x\n");
    await jj(["git", "init", "--colocate"], dir, A.cfg);
    await jj(["commit", "-m", "seed profile from /home/x/.claude"], dir, A.cfg);
    await seedProfile(A.cfg);
    expect(await profileStanding(A.cfg)).toEqual({ legacy: true, seed: null, edited: true });
    expect(existsSync(`${dir}/skills/synced`)).toBe(false);
    expect(await read(`${dir}/CLAUDE.md`)).toBe("old\n");
    await A.scopeSync!.syncNow({ kind: "profile" });
    expect(listHeadRows(A.db, "profile")).toEqual([]);
  } finally {
    await close();
  }
}, 30_000);

test("legacy nodes keep their own profile until an import, then every node takes the imported one", async () => {
  const { nodes, close } = await poolNodes(3, { nodes: [{ scopeSync: true }, { scopeSync: true }, { scopeSync: true }] });
  const [A, B, C] = nodes as [GitPoolNode, GitPoolNode, GitPoolNode];
  try {
    for (const [n, text] of [[A, "a rules\n"], [B, ""], [C, "c rules\n"]] as const) {
      const dir = profileOf(n);
      await mkdir(dir, { recursive: true });
      await writeFile(`${dir}/CLAUDE.md`, text);
      await jj(["git", "init", "--colocate"], dir, n.cfg);
      await jj(["commit", "-m", "seed profile from somewhere"], dir, n.cfg);
      await seedProfile(n.cfg);
    }
    for (const n of nodes) await n.scopeSync!.syncNow({ kind: "profile" });
    expect(await read(`${profileOf(B)}/CLAUDE.md`)).toBe("");

    const commit = await importProfile(A.cfg, profileOf(A), A.scopeSync!);
    expect((await git(["log", "-1", "--format=%P", commit], profileOf(A), A.cfg)).trim()).toBe("");
    expect(await profileStanding(A.cfg)).toEqual({ legacy: false, seed: null, edited: true });
    for (const n of [B, C]) await until(`${n.id} takes A's profile`, () => read(`${profileOf(n)}/CLAUDE.md`), (v) => v === "a rules\n");
    // The same pass that moved B's files records its standing, just after.
    await until("B's standing", () => profileStanding(B.cfg), (v) => JSON.stringify(v) === JSON.stringify({ seed: null, edited: true, legacy: false }));

    // From then on an edit anywhere spreads.
    await writeFile(`${profileOf(C)}/CLAUDE.md`, "a rules\nno attribution\n");
    await until("C's edit on A", () => read(`${profileOf(A)}/CLAUDE.md`), (v) => v === "a rules\nno attribution\n");
  } finally {
    await close();
  }
}, 120_000);

test("an import leaves out the account's synced skills and the legacy history", async () => {
  const { nodes, close } = await poolNodes(1, { nodes: [{ scopeSync: true }] });
  const [A] = nodes as [GitPoolNode];
  try {
    const source = await mkdtemp("/tmp/meddle-import-");
    await mkdir(`${source}/skills/synced/o`, { recursive: true });
    await mkdir(`${source}/skills/babysit`, { recursive: true });
    await writeFile(`${source}/CLAUDE.md`, "from dir\n");
    await writeFile(`${source}/skills/babysit/SKILL.md`, "b\n");
    await writeFile(`${source}/skills/synced/o/SKILL.md`, "o\n");
    await writeFile(`${source}/unrelated.txt`, "not a profile entry\n");
    await seedProfile(A.cfg);
    const commit = await importProfile(A.cfg, source, A.scopeSync!);
    const files = (await git(["ls-tree", "-r", "--name-only", commit], profileOf(A), A.cfg)).trim().split("\n");
    expect(files).toContain("CLAUDE.md");
    expect(files).toContain("skills/babysit/SKILL.md");
    expect(files.some((f) => f.startsWith("skills/synced"))).toBe(false);
    expect(files).not.toContain("unrelated.txt");
    expect(await read(`${profileOf(A)}/CLAUDE.md`)).toBe("from dir\n");
    await rm(source, { recursive: true, force: true });
  } finally {
    await close();
  }
}, 30_000);

test("a fresh node joining a pool takes the pool's profile", async () => {
  const { nodes, close } = await poolNodes(2, { nodes: [{ scopeSync: true }, { scopeSync: true }] });
  const [A, B] = nodes as [GitPoolNode, GitPoolNode];
  try {
    await claudeHome(A, "pool rules\n");
    await seedProfile(A.cfg);
    await importProfile(A.cfg, profileOf(A), A.scopeSync!);
    // B never had a ~/.claude: an empty seed.
    await seedProfile(B.cfg);
    expect(await profileStanding(B.cfg)).toMatchObject({ legacy: false, edited: false });
    B.scopeSync!.touched({ kind: "profile" });
    await until("B takes the pool's profile", () => read(`${profileOf(B)}/CLAUDE.md`), (v) => v === "pool rules\n");
  } finally {
    await close();
  }
}, 60_000);

test("a seeded node with edits replays them onto the pool's profile", async () => {
  const { nodes, close } = await poolNodes(2, { nodes: [{ scopeSync: true }, { scopeSync: true }] });
  const [A, B] = nodes as [GitPoolNode, GitPoolNode];
  try {
    await claudeHome(B, "b seed\n");
    await seedProfile(B.cfg);
    await mkdir(`${profileOf(B)}/skills/mine`, { recursive: true });
    await writeFile(`${profileOf(B)}/skills/mine/SKILL.md`, "b's own skill\n");
    await B.scopeSync!.syncNow({ kind: "profile" });
    expect(await profileStanding(B.cfg)).toMatchObject({ edited: true });

    await claudeHome(A, "pool rules\n");
    await seedProfile(A.cfg);
    await importProfile(A.cfg, profileOf(A), A.scopeSync!);
    await until("B replays onto the pool's", () => read(`${profileOf(B)}/CLAUDE.md`), (v) => v === "pool rules\n");
    expect(await read(`${profileOf(B)}/skills/mine/SKILL.md`)).toBe("b's own skill\n");
    await until("A gets B's skill", () => read(`${profileOf(A)}/skills/mine/SKILL.md`), (v) => v === "b's own skill\n");
    expect(await isJjRepo(profileOf(A))).toBe(true);
  } finally {
    await close();
  }
}, 60_000);

test("a second import replaces the pool's profile: what it lacks goes on every node", async () => {
  const { nodes, close } = await poolNodes(2, { nodes: [{ scopeSync: true }, { scopeSync: true }] });
  const [A, B] = nodes as [GitPoolNode, GitPoolNode];
  try {
    const first = await mkdtemp("/tmp/meddle-import-");
    await mkdir(`${first}/skills/old`, { recursive: true });
    await writeFile(`${first}/CLAUDE.md`, "first\n");
    await writeFile(`${first}/skills/old/SKILL.md`, "old\n");
    await seedProfile(A.cfg);
    await seedProfile(B.cfg);
    await importProfile(A.cfg, first, A.scopeSync!);
    await until("B takes the first import", () => read(`${profileOf(B)}/skills/old/SKILL.md`), (v) => v === "old\n");
    const second = await mkdtemp("/tmp/meddle-import-");
    await writeFile(`${second}/CLAUDE.md`, "second\n");
    const commit = await importProfile(B.cfg, second, B.scopeSync!);
    expect((await git(["log", "-1", "--format=%P", commit], profileOf(B), B.cfg)).trim()).not.toBe("");
    for (const n of [A, B]) {
      await until(`${n.id} takes the second import`, () => read(`${profileOf(n)}/CLAUDE.md`), (v) => v === "second\n");
      await until(`${n.id} drops the old skill`, () => existsSync(`${profileOf(n)}/skills/old/SKILL.md`), (v) => !v);
    }
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  } finally {
    await close();
  }
}, 90_000);
