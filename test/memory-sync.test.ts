import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { paths } from "../src/config";
import { git, initColocated, jj } from "../src/jj";
import { shortId } from "../src/pool/ids";
import { memoryChanges, writeMemory } from "../src/projects/memory-sync";
import { ensureServiceRepo } from "../src/projects/replicas";
import { createTask } from "./helpers";
import { peerReady, twoPoolNodes, type GitPoolNode, type NodeOptions } from "./pool-helpers";

const read = (path: string) => readFile(path, "utf8").catch(() => null);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

async function until<T>(what: string, get: () => Promise<T> | T, ok: (v: T) => boolean, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await get();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: last ${JSON.stringify(v)}`);
    await Bun.sleep(50);
  }
}

const depsOf = (n: GitPoolNode) => ({ cfg: n.cfg, db: n.db, pool: n.pool, sync: n.scopeSync });

async function changeOf(node: GitPoolNode, repo: string, rev: string): Promise<string> {
  return (await jj(["log", "-r", rev, "--no-graph", "-T", "change_id"], repo, node.cfg)).trim();
}

/** The files the commit at `rev` touches. */
async function touched(node: GitPoolNode, repo: string, rev: string): Promise<string[]> {
  const out = await jj(["log", "-r", rev, "--no-graph", "-T", 'self.diff().files().map(|f| f.path()).join("\\n")'], repo, node.cfg);
  return out.split("\n").filter(Boolean);
}

/** A and B (each running a scope sync unless `sync` says otherwise), A's project held on B too. */
async function replicated(opts: { nodes?: NodeOptions[] } = {}) {
  const nodes = await twoPoolNodes({ nodes: opts.nodes ?? [{ scopeSync: true }, { scopeSync: true }] });
  const { A, B } = nodes;
  try {
    await peerReady(B, A);
    await peerReady(A, B);
    const id = A.project.id;
    await ensureServiceRepo({ cfg: B.cfg, db: B.db, pool: B.pool }, id);
    return { ...nodes, id, memA: paths(A.cfg).memory(id), memB: paths(B.cfg).memory(id) };
  } catch (err) {
    await nodes.close();
    throw err;
  }
}

test("the dashboard writes memory on any node and it spreads", async () => {
  const { A, B, id, memA, memB, close } = await replicated();
  try {
    // B is not the project's home.
    const { change } = await writeMemory(depsOf(B), id, "a.md", "x\n", null);
    expect(await changeOf(B, memB, "memory")).toBe(change);
    await until("a.md on A", () => read(`${memA}/a.md`), (v) => v === "x\n");
    expect(A.logs.filter((l) => l.startsWith("meddle: memory"))).toEqual([]);
  } finally {
    await close();
  }
}, 60_000);

test("writeMemory commits only its own path", async () => {
  const { A, id, memA, close } = await replicated({ nodes: [{}, {}] });
  const heard: string[] = [];
  const off = memoryChanges.subscribe((p) => { heard.push(p); });
  try {
    await writeFile(`${memA}/other.md`, "- not yet\n");
    const { change } = await writeMemory(depsOf(A), id, "a.md", "x\n", null);
    expect(await changeOf(A, memA, "memory")).toBe(change);
    expect(await jj(["log", "-r", "memory", "--no-graph", "-T", "description"], memA, A.cfg)).toBe("memory: dashboard\n");
    expect(await touched(A, memA, "memory")).toEqual(["a.md"]);
    expect(await read(`${memA}/other.md`)).toBe("- not yet\n");
    expect(await touched(A, memA, "@")).toEqual(["other.md"]);
    expect(heard).toEqual([id]);
  } finally {
    off();
    await close();
  }
}, 30_000);

test("writeMemory refuses when the file changed since it was opened", async () => {
  const { A, id, memA, close } = await replicated({ nodes: [{}, {}] });
  try {
    await writeMemory(depsOf(A), id, "a.md", "x\n", null);
    const at = await changeOf(A, memA, "memory");
    await writeFile(`${memA}/a.md`, "y\n");
    await expect(writeMemory(depsOf(A), id, "a.md", "z\n", sha("x\n"))).rejects.toMatchObject({ code: "changed" });
    expect(await read(`${memA}/a.md`)).toBe("y\n");
    expect(await changeOf(A, memA, "memory")).toBe(at);
  } finally {
    await close();
  }
}, 30_000);

test("writeMemory deletes with text null, and a null base on a file that exists has changed", async () => {
  const { A, id, memA, close } = await replicated({ nodes: [{}, {}] });
  try {
    await writeMemory(depsOf(A), id, "a.md", "x\n", null);
    const { change } = await writeMemory(depsOf(A), id, "a.md", null, sha("x\n"));
    expect(await read(`${memA}/a.md`)).toBeNull();
    expect(await changeOf(A, memA, "memory")).toBe(change);
    expect(await jj(["file", "list", "-r", "memory"], memA, A.cfg)).not.toContain("a.md");
    await writeFile(`${memA}/b.md`, "on disk\n");
    await expect(writeMemory(depsOf(A), id, "b.md", "z\n", null)).rejects.toMatchObject({ code: "changed" });
    expect(await read(`${memA}/b.md`)).toBe("on disk\n");
  } finally {
    await close();
  }
}, 30_000);

test("memory paths are confined", async () => {
  const { A, id, memA, close } = await replicated({ nodes: [{}, {}] });
  try {
    for (const path of ["../x.md", "a/b.md", "/a.md", "a.txt", ".hidden.md", ""]) {
      await expect(writeMemory(depsOf(A), id, path, "x\n", null)).rejects.toMatchObject({ code: "path" });
    }
    expect(await read(`${memA}/../x.md`)).toBeNull();
    expect(await read(`${memA}/a.txt`)).toBeNull();
  } finally {
    await close();
  }
}, 30_000);

test("saving unchanged content leaves memory where it was, and tells no one", async () => {
  const { A, id, memA, close } = await replicated({ nodes: [{}, {}] });
  const heard: string[] = [];
  const off = memoryChanges.subscribe((p) => { heard.push(p); });
  try {
    const { change } = await writeMemory(depsOf(A), id, "a.md", "x\n", null);
    expect(heard).toEqual([id]);
    const again = await writeMemory(depsOf(A), id, "a.md", "x\n", sha("x\n"));
    expect(again.change).toBe(change);
    expect(await changeOf(A, memA, "memory")).toBe(change);
    expect(heard).toEqual([id]);
  } finally {
    off();
    await close();
  }
}, 30_000);

test("a turn end publishes what the turn wrote, named for its task", async () => {
  const { A, B, id, memA, memB, close } = await replicated({
    nodes: [{ scopeSync: true, extraEnv: { MEDDLE_FIXTURE_MEMORY: "1" } }, { scopeSync: true }],
  });
  try {
    const manifest = await createTask(A, { title: "t", projectIds: [id] });
    const idle = new Promise<void>((res) => A.runner.onState((tid, s) => { if (tid === manifest.id && s === "idle") res(); }));
    await A.runner.prompt(manifest.id, "remember the tides");
    await idle;
    await until("B's memory", () => read(`${memB}/MEMORY.md`), (v) => v?.includes("remember the tides") === true);
    const log = await git(["log", "--format=%s", "-10", "refs/heads/memory"], memA, A.cfg);
    expect(log.split("\n")).toContain(`memory from ${shortId(A.id)}: task ${manifest.id}`);
  } finally {
    await close();
  }
}, 60_000);

test("memory keeps syncing while a task of the project is live", async () => {
  // The old sync deferred everything while any task of the project had a turn live on the node.
  const { A, B, id, memA, memB, close } = await replicated({
    nodes: [{ scopeSync: true }, { scopeSync: true, extraEnv: { MEDDLE_FIXTURE_STALL: "1" } }],
  });
  try {
    const m = await createTask(B, { title: "stalls", projectIds: [id] });
    const initialised = new Promise<void>((res) => {
      const off = B.runner.onEvent((tid, _seq, msg) => {
        if (tid === m.id && msg.type === "system" && (msg as { subtype?: string }).subtype === "init") { off(); res(); }
      });
    });
    await B.runner.prompt(m.id, "Stall.");
    await initialised;
    expect(B.runner.projectLive(id)).toBe(true);
    await writeFile(`${memB}/during.md`, "during\n");
    await until("during.md on A", () => read(`${memA}/during.md`), (v) => v === "during\n");
    expect(B.runner.projectLive(id)).toBe(true);
    const log = await git(["log", "--format=%s", "-10", "refs/heads/memory"], memB, B.cfg);
    expect(log.split("\n")).toContain(`memory from ${shortId(B.id)}: task ${m.id}`);
    expect(A.logs.filter((l) => l.startsWith("meddle: memory"))).toEqual([]);
    const idle = new Promise<void>((res) => B.runner.onState((tid, s) => { if (tid === m.id && s === "idle") res(); }));
    await B.runner.interrupt(m.id);
    await idle;
  } finally {
    await close();
  }
}, 60_000);

test("an old node's push to memory is folded in and spreads", async () => {
  const { A, B, id, memA, close } = await replicated({ nodes: [{ scopeSync: true }, {}] });
  try {
    await writeFile(`${memA}/MEMORY.md`, "- first\n");
    await until("A's memory head", () => git(["rev-parse", "--verify", "-q", "refs/heads/memory"], memA, A.cfg).catch(() => ""), (v) => v.trim() !== "");
    // B as a node of an older meddle: its own memory line pushed to the home's `memory`.
    const mem = `${B.home}/old`;
    await initColocated(mem, B.cfg);
    await git(["fetch", `meddle://${A.id}/memory/${id}`, "+refs/heads/memory:refs/heads/memory"], mem, B.cfg);
    await jj(["new", "memory"], mem, B.cfg);
    await writeFile(`${mem}/old.md`, "from an old node\n");
    await jj(["commit", "-m", `memory from ${shortId(B.id)}`], mem, B.cfg);
    const pushed = (await jj(["log", "-r", "@-", "--no-graph", "-T", "commit_id"], mem, B.cfg)).trim();
    await writeFile(`${memA}/new.md`, "written on a meanwhile\n");
    await git(["push", `meddle://${A.id}/memory/${id}`, `${pushed}:refs/heads/memory`], mem, B.cfg);
    await until("old.md on A", () => read(`${memA}/old.md`), (v) => v === "from an old node\n");
    await until("new.md kept on A", () => read(`${memA}/new.md`), (v) => v === "written on a meanwhile\n");
  } finally {
    await close();
  }
}, 60_000);
