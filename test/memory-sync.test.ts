import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { paths } from "../src/config";
import { bookmarkList, jj } from "../src/jj";
import { shortId } from "../src/pool/identity";
import { syncMemoryAfter, syncMemoryBefore } from "../src/projects/memory-sync";
import { ensureReplica, type ReplicaDeps } from "../src/projects/replicas";
import { setupNode } from "./helpers";
import { peerReady, twoPoolNodes, type GitPoolNode } from "./pool-helpers";

const depsOf = (n: GitPoolNode): ReplicaDeps => ({ cfg: n.cfg, db: n.db, pool: n.pool });

async function changeOf(node: GitPoolNode, repo: string, rev: string): Promise<string> {
  return (await jj(["log", "-r", rev, "--no-graph", "-T", "change_id"], repo, node.cfg)).trim();
}

const read = (path: string) => readFile(path, "utf8").catch(() => null);

/** A and B with A's project replicated on B, and the log lines each node's memory sync wrote. */
async function replicated() {
  const nodes = await twoPoolNodes();
  const { A, B } = nodes;
  try {
    await peerReady(B, A);
    const id = A.project.id;
    await ensureReplica(depsOf(B), id);
    const logs: string[] = [];
    const log = (line: string) => { logs.push(line); };
    return { ...nodes, id, memA: paths(A.cfg).memory(id), memB: paths(B.cfg).memory(id), logs, log };
  } catch (err) {
    await nodes.close();
    throw err;
  }
}

test("memory travels from the home to a peer and back around turns", async () => {
  const { A, B, id, memA, memB, logs, log, close } = await replicated();
  try {
    const shortA = shortId(A.id);
    const shortB = shortId(B.id);
    await writeFile(`${memA}/MEMORY.md`, "- from a\n");
    await syncMemoryAfter(depsOf(A), id, log);
    expect(await changeOf(A, memA, "memory")).toBe(await changeOf(A, memA, "@-"));
    expect(await jj(["log", "-r", "@-", "--no-graph", "-T", "description"], memA, A.cfg)).toBe(`memory from ${shortA}\n`);

    await syncMemoryBefore(depsOf(B), id, false, log);
    expect(await read(`${memB}/MEMORY.md`)).toBe("- from a\n");

    await writeFile(`${memB}/NOTES.md`, "- from b\n");
    await syncMemoryAfter(depsOf(B), id, log);
    const fromB = await changeOf(B, memB, "@-");
    expect(await jj(["log", "-r", "@-", "--no-graph", "-T", "description"], memB, B.cfg)).toBe(`memory from ${shortB}\n`);
    expect(await changeOf(A, memA, "memory")).toBe(fromB);

    // The home's working copy follows the bookmark B moved: the file, not just the bookmark.
    expect(await read(`${memA}/NOTES.md`)).toBeNull();
    await syncMemoryBefore(depsOf(A), id, false, log);
    expect(await read(`${memA}/NOTES.md`)).toBe("- from b\n");
    expect(await read(`${memA}/MEMORY.md`)).toBe("- from a\n");

    // A node live for the project leaves its memory alone.
    await writeFile(`${memA}/MEMORY.md`, "- from a\n- again\n");
    await syncMemoryAfter(depsOf(A), id, log);
    const again = await changeOf(A, memA, "memory");
    await syncMemoryBefore(depsOf(B), id, true, log);
    expect(await read(`${memB}/MEMORY.md`)).toBe("- from a\n");
    expect((await bookmarkList(memB, B.cfg)).find((b) => b.name === "memory" && b.remote === shortA)?.changeId).toBe(fromB);
    await syncMemoryBefore(depsOf(B), id, false, log);
    expect(await read(`${memB}/MEMORY.md`)).toBe("- from a\n- again\n");
    expect(await changeOf(B, memB, "memory")).toBe(again);
    expect(logs).toEqual([]);
  } finally {
    await close();
  }
}, 15_000);

test("conflicting memory edits leave conflict markers on the puller and nothing throws", async () => {
  const { A, B, id, memA, memB, log, close } = await replicated();
  try {
    await writeFile(`${memA}/MEMORY.md`, "- base\n");
    await syncMemoryAfter(depsOf(A), id, log);
    await syncMemoryBefore(depsOf(B), id, false, log);
    expect(await read(`${memB}/MEMORY.md`)).toBe("- base\n");

    await writeFile(`${memA}/MEMORY.md`, "- from a\n");
    await syncMemoryAfter(depsOf(A), id, log);
    await writeFile(`${memB}/MEMORY.md`, "- from b\n");
    await syncMemoryBefore(depsOf(B), id, false, log);
    const text = (await read(`${memB}/MEMORY.md`)) ?? "";
    expect(text).toContain("<<<<<<<");
    expect(text).toContain(">>>>>>>");
    // B's turn-end sync of a conflicted commit does not throw either.
    await syncMemoryAfter(depsOf(B), id, log);
  } finally {
    await close();
  }
}, 15_000);

test("the home's turn-end sync after a peer's push keeps the peer's commit under memory", async () => {
  const { A, B, id, memA, memB, logs, log, close } = await replicated();
  try {
    await writeFile(`${memA}/MEMORY.md`, "- base\n");
    await syncMemoryAfter(depsOf(A), id, log);
    await syncMemoryBefore(depsOf(B), id, false, log);

    await writeFile(`${memB}/NOTES.md`, "- from b\n");
    await syncMemoryAfter(depsOf(B), id, log);
    const fromB = await changeOf(B, memB, "@-");
    expect(await changeOf(A, memA, "memory")).toBe(fromB);

    // A wrote during its own turn, on the base it had before B's push.
    await writeFile(`${memA}/OTHER.md`, "- from a\n");
    await syncMemoryAfter(depsOf(A), id, log);
    expect(await changeOf(A, memA, "memory")).toBe(await changeOf(A, memA, "@-"));
    expect((await jj(["log", "-r", `${fromB} & ::memory`, "--no-graph", "-T", "change_id"], memA, A.cfg)).trim()).toBe(fromB);
    expect(await read(`${memA}/NOTES.md`)).toBe("- from b\n");
    expect(await read(`${memA}/OTHER.md`)).toBe("- from a\n");
    expect(logs).toEqual([]);
  } finally {
    await close();
  }
}, 15_000);

test("with MEDDLE_FIXTURE_MEMORY=1 the stand-in appends the first prompt to the task's MEMORY.md", async () => {
  const { cfg, project, runner, harness } = await setupNode(undefined, { MEDDLE_FIXTURE_MEMORY: "1" });
  try {
    const m = await runner.create({ title: "t", projectIds: [project.id] });
    const idle = new Promise<void>((res) => runner.onState((tid, s) => { if (tid === m.id && s === "idle") res(); }));
    await runner.prompt(m.id, "Remember the tide tables.");
    await idle;
    expect(await read(`${paths(cfg).memory(project.id)}/MEMORY.md`)).toBe("Remember the tide tables.\n");
  } finally {
    await harness.close();
  }
}, 15_000);
