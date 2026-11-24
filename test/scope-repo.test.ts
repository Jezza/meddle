import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureDataDirs, loadConfig, type NodeConfig } from "../src/config";
import { writeMergeDriver } from "../src/git/scripts";
import { git, jj } from "../src/jj";
import { checkGit, commitLocal, headOf, isAncestor, mergeHeads, moveTo, prepareScopeRepo, resolveConflicts, sameTree } from "../src/scopes/repo";
import type { Scope } from "../src/scopes/scope";

const homes: string[] = [];
afterAll(async () => {
  for (const h of homes) await rm(h, { recursive: true, force: true });
});

const MEMORY: Scope = { kind: "memory", projectId: "p1" };
const PROFILE: Scope = { kind: "profile" };

async function makeCfg(): Promise<NodeConfig> {
  const home = await mkdtemp("/tmp/meddle-scope-");
  homes.push(home);
  const cfg = loadConfig({ HOME: home, MEDDLE_DATA_DIR: `${home}/d`, MEDDLE_TASK_ROOT: `${home}/t` });
  await ensureDataDirs(cfg);
  await writeMergeDriver(cfg);
  return cfg;
}

/** A prepared scope repo in a fresh temp dir. */
async function repo(cfg: NodeConfig, s: Scope = MEMORY, name = "r"): Promise<string> {
  const dir = join(cfg.dataDir, name);
  await prepareScopeRepo(cfg, dir, s);
  return dir;
}

const read = (path: string) => readFile(path, "utf8").catch(() => null);
const bump = async (dir: string, file: string, text: string) => writeFile(join(dir, file), ((await read(join(dir, file))) ?? "") + text);
const conflicted = async (cfg: NodeConfig, dir: string, rev: string) => (await jj(["log", "-r", rev, "--no-graph", "-T", "conflict"], dir, cfg)).trim() === "true";

/** Fetches `commit` from repo `from` into repo `to` by id. */
async function carry(cfg: NodeConfig, from: string, to: string, commit: string): Promise<void> {
  await git(["fetch", "--no-tags", from, `${commit}:refs/meddle/fetched/${commit}`], to, cfg);
}

test("checkGit accepts this machine's git", async () => {
  await checkGit();
});

test("prepareScopeRepo is idempotent and sets the driver", async () => {
  const cfg = await makeCfg();
  const dir = await repo(cfg);
  await prepareScopeRepo(cfg, dir, MEMORY);
  expect((await git(["config", "merge.meddle.driver"], dir, cfg)).trim()).toEndWith("%O %A %B %P");
  expect(await read(join(dir, ".git/info/attributes"))).toBe("* merge=meddle\n");
});

test("commitLocal commits what changed and moves the bookmark", async () => {
  const cfg = await makeCfg();
  const dir = await repo(cfg);
  expect(await commitLocal(cfg, dir, MEMORY, "nothing")).toBeNull();
  await writeFile(join(dir, "MEMORY.md"), "- a\n");
  const head = await commitLocal(cfg, dir, MEMORY, "memory from x");
  expect(head).not.toBeNull();
  expect(await headOf(cfg, dir, MEMORY)).toBe(head);
  expect((await git(["log", "-1", "--format=%s", head!], dir, cfg)).trim()).toBe("memory from x");
  expect(await commitLocal(cfg, dir, MEMORY, "again")).toBe(head);
});

test("skills/synced is never committed in the profile", async () => {
  const cfg = await makeCfg();
  const dir = await repo(cfg, PROFILE);
  await mkdir(join(dir, "skills/synced/x"), { recursive: true });
  await mkdir(join(dir, "skills/babysit"), { recursive: true });
  await writeFile(join(dir, "skills/synced/x/SKILL.md"), "x\n");
  await writeFile(join(dir, "skills/babysit/SKILL.md"), "b\n");
  const head = await commitLocal(cfg, dir, PROFILE, "profile");
  expect((await git(["ls-tree", "-r", "--name-only", head!], dir, cfg)).trim()).toBe("skills/babysit/SKILL.md");
});

test("files over a megabyte are committed", async () => {
  const cfg = await makeCfg();
  const dir = await repo(cfg);
  await writeFile(join(dir, "big.md"), "x".repeat(2 * 1024 * 1024));
  const head = await commitLocal(cfg, dir, MEMORY, "big");
  expect((await git(["ls-tree", "--name-only", head!], dir, cfg)).trim()).toBe("big.md");
});

/** Repo A with a base commit and two diverged commits X and Y on it, and repo B holding all three. */
async function diverged(cfg: NodeConfig, files: { base: Record<string, string>; x: Record<string, string | null>; y: Record<string, string | null> }) {
  const a = await repo(cfg, MEMORY, "a");
  const b = await repo(cfg, MEMORY, "b");
  for (const [f, t] of Object.entries(files.base)) await writeFile(join(a, f), t);
  const base = (await commitLocal(cfg, a, MEMORY, "base"))!;
  const side = async (edits: Record<string, string | null>, name: string) => {
    await jj(["new", base], a, cfg);
    for (const [f, t] of Object.entries(edits)) {
      if (t === null) await rm(join(a, f), { force: true });
      else await writeFile(join(a, f), t);
    }
    await jj(["commit", "-m", name], a, cfg);
    return (await jj(["log", "-r", "@-", "--no-graph", "-T", "commit_id"], a, cfg)).trim();
  };
  const x = await side(files.x, "x");
  const y = await side(files.y, "y");
  await carry(cfg, a, b, x);
  await carry(cfg, a, b, y);
  return { a, b, base, x, y };
}

const show = (cfg: NodeConfig, dir: string, rev: string, file: string) => git(["show", `${rev}:${file}`], dir, cfg).catch(() => null);

test("mergeHeads makes the identical commit on two repos", async () => {
  const cfg = await makeCfg();
  const { a, b, x, y } = await diverged(cfg, { base: { "MEMORY.md": "- a\n" }, x: { "MEMORY.md": "- a\n- x\n" }, y: { "MEMORY.md": "- a\n- y\n" } });
  const inA = await mergeHeads(cfg, a, x, y);
  const inB = await mergeHeads(cfg, b, x, y);
  expect(inA).toBe(inB);
  expect(await show(cfg, a, inA, "MEMORY.md")).toBe("- a\n- x\n- y\n");
  expect((await git(["log", "-1", "--format=%an <%ae>|%P", inA], a, cfg)).trim()).toBe(`meddle <meddle@localhost>|${x} ${y}`);
});

test("mergeHeads of a modify/delete keeps the edit", async () => {
  const cfg = await makeCfg();
  const { a, x, y } = await diverged(cfg, { base: { "d.md": "1\n" }, x: { "d.md": "2\n" }, y: { "d.md": null } });
  expect(await show(cfg, a, await mergeHeads(cfg, a, x, y), "d.md")).toBe("2\n");
  expect(await show(cfg, a, await mergeHeads(cfg, a, y, x), "d.md")).toBe("2\n");
});

test("mergeHeads of a file against a directory takes the second parent's", async () => {
  const cfg = await makeCfg();
  const a = await repo(cfg, MEMORY, "a");
  await writeFile(join(a, "MEMORY.md"), "m\n");
  const base = (await commitLocal(cfg, a, MEMORY, "base"))!;
  await jj(["new", base], a, cfg);
  await writeFile(join(a, "n"), "file\n");
  await jj(["commit", "-m", "x"], a, cfg);
  const x = (await jj(["log", "-r", "@-", "--no-graph", "-T", "commit_id"], a, cfg)).trim();
  await jj(["new", base], a, cfg);
  await mkdir(join(a, "n"));
  await writeFile(join(a, "n/inner.md"), "dir\n");
  await jj(["commit", "-m", "y"], a, cfg);
  const y = (await jj(["log", "-r", "@-", "--no-graph", "-T", "commit_id"], a, cfg)).trim();
  const merged = await mergeHeads(cfg, a, x, y);
  expect((await git(["ls-tree", "-r", "--name-only", merged], a, cfg)).trim().split("\n")).toEqual(["MEMORY.md", "n/inner.md"]);
});

test("mergeHeads of unrelated histories unions both", async () => {
  const cfg = await makeCfg();
  const a = await repo(cfg, MEMORY, "a");
  const b = await repo(cfg, MEMORY, "b");
  await writeFile(join(a, "MEMORY.md"), "- a\n");
  await writeFile(join(b, "MEMORY.md"), "- b\n");
  const x = (await commitLocal(cfg, a, MEMORY, "a"))!;
  const y = (await commitLocal(cfg, b, MEMORY, "b"))!;
  await carry(cfg, b, a, y);
  expect(await show(cfg, a, await mergeHeads(cfg, a, x, y), "MEMORY.md")).toBe("- a\n- b\n");
});

test("criss-cross merges agree on both repos", async () => {
  // X and Y merged both ways (M1 = X+Y, M2 = Y+X style), then each side adds a line and they merge again.
  const cfg = await makeCfg();
  const { a, b, x, y } = await diverged(cfg, { base: { "MEMORY.md": "- a\n" }, x: { "MEMORY.md": "- a\n- x\n" }, y: { "MEMORY.md": "- a\n- y\n" } });
  const m1 = await mergeHeads(cfg, a, x, y);
  const m2 = await mergeHeads(cfg, a, y, x);
  const grow = async (m: string, line: string) => {
    await git(["update-ref", `refs/heads/g${line.slice(2)}`, m], a, cfg);
    await jj(["new", m], a, cfg);
    await bump(a, "MEMORY.md", `${line}\n`);
    await jj(["commit", "-m", `add ${line.slice(2)}`], a, cfg);
    return (await jj(["log", "-r", "@-", "--no-graph", "-T", "commit_id"], a, cfg)).trim();
  };
  const p = await grow(m1, "- p");
  const q = await grow(m2, "- q");
  await carry(cfg, a, b, p);
  await carry(cfg, a, b, q);
  const inA = await mergeHeads(cfg, a, p, q);
  expect(await mergeHeads(cfg, b, p, q)).toBe(inA);
  const lines = (await show(cfg, a, inA, "MEMORY.md"))!.split("\n");
  for (const l of ["- a", "- x", "- y", "- p", "- q"]) expect(lines.filter((x) => x === l)).toHaveLength(1);
});

test("isAncestor and sameTree", async () => {
  const cfg = await makeCfg();
  const { a, base, x, y } = await diverged(cfg, { base: { "MEMORY.md": "- a\n" }, x: { "MEMORY.md": "- b\n" }, y: { "MEMORY.md": "- b\n" } });
  expect(await isAncestor(cfg, a, base, x)).toBe(true);
  expect(await isAncestor(cfg, a, x, y)).toBe(false);
  expect(await sameTree(cfg, a, x, y)).toBe(true);
  expect(await sameTree(cfg, a, base, x)).toBe(false);
});

test("moveTo brings the files onto the commit", async () => {
  const cfg = await makeCfg();
  const { a, x, y } = await diverged(cfg, { base: { "MEMORY.md": "- a\n" }, x: { "MEMORY.md": "- a\n- x\n" }, y: { "MEMORY.md": "- a\n- y\n" } });
  await moveTo(cfg, a, MEMORY, x, "local");
  expect(await read(join(a, "MEMORY.md"))).toBe("- a\n- x\n");
  // Sideways: the working copy follows, and jj keeps working.
  await moveTo(cfg, a, MEMORY, y, "local");
  expect(await read(join(a, "MEMORY.md"))).toBe("- a\n- y\n");
  expect(await headOf(cfg, a, MEMORY)).toBe(y);
  expect(await commitLocal(cfg, a, MEMORY, "nothing")).toBe(y);
});

test("a write landing during a move is kept", async () => {
  const cfg = await makeCfg();
  const { a, x, y } = await diverged(cfg, { base: { "MEMORY.md": "- a\n" }, x: { "MEMORY.md": "- a\n- x\n" }, y: { "MEMORY.md": "- a\n- y\n" } });
  await moveTo(cfg, a, MEMORY, x, "local");
  await moveTo(cfg, a, MEMORY, y, "late write", { beforeNew: () => writeFile(join(a, "late.md"), "late\n") });
  expect(await read(join(a, "late.md"))).toBe("late\n");
  const head = (await headOf(cfg, a, MEMORY))!;
  expect(await show(cfg, a, head, "late.md")).toBe("late\n");
  expect(await show(cfg, a, head, "MEMORY.md")).toBe("- a\n- y\n");
  expect(await conflicted(cfg, a, "@")).toBe(false);
});

test("resolveConflicts folds a three-sided conflict", async () => {
  const cfg = await makeCfg();
  const a = await repo(cfg, MEMORY, "a");
  await writeFile(join(a, "MEMORY.md"), "- a\n");
  const base = (await commitLocal(cfg, a, MEMORY, "base"))!;
  const sides: string[] = [];
  for (const l of ["x", "y", "z"]) {
    await jj(["new", base], a, cfg);
    await writeFile(join(a, "MEMORY.md"), `- a\n- ${l}\n`);
    await jj(["commit", "-m", l], a, cfg);
    sides.push((await jj(["log", "-r", "@-", "--no-graph", "-T", "commit_id"], a, cfg)).trim());
  }
  await jj(["new", ...sides, "-m", "conflicted"], a, cfg);
  await jj(["new"], a, cfg);
  const bad = (await jj(["log", "-r", "@-", "--no-graph", "-T", "commit_id"], a, cfg)).trim();
  expect(await conflicted(cfg, a, bad)).toBe(true);
  const fixed = await resolveConflicts(cfg, a, bad);
  expect(await show(cfg, a, fixed, "MEMORY.md")).toBe("- a\n- x\n- y\n- z\n");
  expect((await git(["ls-tree", "--name-only", fixed], a, cfg)).trim()).toBe("MEMORY.md");
});

test("commitLocal resolves a conflicted parent and returns the resolved head", async () => {
  const cfg = await makeCfg();
  const a = await repo(cfg, MEMORY, "a");
  await writeFile(join(a, "MEMORY.md"), "- a\n");
  const base = (await commitLocal(cfg, a, MEMORY, "base"))!;
  const sides: string[] = [];
  for (const l of ["x", "y"]) {
    await jj(["new", base], a, cfg);
    await writeFile(join(a, "MEMORY.md"), `- a\n- ${l}\n`);
    await jj(["commit", "-m", l], a, cfg);
    sides.push((await jj(["log", "-r", "@-", "--no-graph", "-T", "commit_id"], a, cfg)).trim());
  }
  await jj(["new", ...sides, "-m", "conflicted"], a, cfg);
  await jj(["new"], a, cfg);
  const head = (await commitLocal(cfg, a, MEMORY, "memory"))!;
  expect(await conflicted(cfg, a, head)).toBe(false);
  expect(await show(cfg, a, head, "MEMORY.md")).toBe("- a\n- x\n- y\n");
});

test("commitLocal folds a bookmark moved by someone else in", async () => {
  // An old node's push moved `memory` to P while this node's working copy sits on H.
  const cfg = await makeCfg();
  const { a, x, y } = await diverged(cfg, { base: { "MEMORY.md": "- a\n" }, x: { "MEMORY.md": "- a\n- x\n" }, y: { "MEMORY.md": "- a\n- y\n" } });
  await moveTo(cfg, a, MEMORY, x, "local");
  await git(["update-ref", "refs/heads/memory", y], a, cfg);
  await writeFile(join(a, "n.md"), "n\n");
  const head = (await commitLocal(cfg, a, MEMORY, "memory"))!;
  expect(await isAncestor(cfg, a, y, head)).toBe(true);
  expect(await show(cfg, a, head, "MEMORY.md")).toBe("- a\n- x\n- y\n");
  expect(await show(cfg, a, head, "n.md")).toBe("n\n");
});
