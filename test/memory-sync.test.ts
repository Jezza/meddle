import { expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { paths } from "../src/config";
import { bookmarkList, jj } from "../src/jj";
import { shortId } from "../src/pool/identity";
import { syncMemoryAfter, syncMemoryBefore } from "../src/projects/memory-sync";
import { ensureReplica, type ReplicaDeps } from "../src/projects/replicas";
import { createTask, setupNode } from "./helpers";
import { peerReady, startPoolNode, twoPoolNodes, type GitPoolNode } from "./pool-helpers";

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
    await syncMemoryAfter(depsOf(A), id, false, log);
    expect(await changeOf(A, memA, "memory")).toBe(await changeOf(A, memA, "@-"));
    expect(await jj(["log", "-r", "@-", "--no-graph", "-T", "description"], memA, A.cfg)).toBe(`memory from ${shortA}\n`);

    await syncMemoryBefore(depsOf(B), id, false, log);
    expect(await read(`${memB}/MEMORY.md`)).toBe("- from a\n");

    await writeFile(`${memB}/NOTES.md`, "- from b\n");
    await syncMemoryAfter(depsOf(B), id, false, log);
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
    await syncMemoryAfter(depsOf(A), id, false, log);
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

test("conflicting memory edits leave conflict markers on the puller, and once tidied up they reach the home", async () => {
  const { A, B, id, memA, memB, logs, log, close } = await replicated();
  try {
    await writeFile(`${memA}/MEMORY.md`, "- base\n");
    await syncMemoryAfter(depsOf(A), id, false, log);
    await syncMemoryBefore(depsOf(B), id, false, log);
    expect(await read(`${memB}/MEMORY.md`)).toBe("- base\n");

    await writeFile(`${memA}/MEMORY.md`, "- from a\n");
    await syncMemoryAfter(depsOf(A), id, false, log);
    await writeFile(`${memB}/MEMORY.md`, "- from b\n");
    await syncMemoryBefore(depsOf(B), id, false, log);
    const text = (await read(`${memB}/MEMORY.md`)) ?? "";
    expect(text).toContain("<<<<<<<");
    expect(text).toContain(">>>>>>>");
    // B's turn-end sync of a conflicted commit does not throw either; jj will not push it.
    await syncMemoryAfter(depsOf(B), id, false, log);
    expect(await jj(["log", "-r", "@- & conflicts()", "--no-graph", "-T", "change_id"], memB, B.cfg)).not.toBe("");
    expect(logs.filter((l) => l.includes("was not synced after the turn"))).toHaveLength(1);
    const conflicted = await changeOf(B, memB, "@-");

    // A later session tidies the markers up: the next turn end folds that into the conflicted commit, which pushes.
    await writeFile(`${memB}/MEMORY.md`, "- from a\n- from b\n");
    logs.length = 0;
    await syncMemoryAfter(depsOf(B), id, false, log);
    expect(logs).toEqual([]);
    expect(await changeOf(B, memB, "@-")).toBe(conflicted);
    expect(await jj(["log", "-r", "conflicts()", "--no-graph", "-T", "change_id"], memB, B.cfg)).toBe("");
    expect(await changeOf(A, memA, "memory")).toBe(conflicted);
    await syncMemoryBefore(depsOf(A), id, false, log);
    expect(await read(`${memA}/MEMORY.md`)).toBe("- from a\n- from b\n");
    expect(logs).toEqual([]);
  } finally {
    await close();
  }
}, 15_000);

test("the home's turn-end sync after a peer's push keeps the peer's commit under memory", async () => {
  const { A, B, id, memA, memB, logs, log, close } = await replicated();
  try {
    await writeFile(`${memA}/MEMORY.md`, "- base\n");
    await syncMemoryAfter(depsOf(A), id, false, log);
    await syncMemoryBefore(depsOf(B), id, false, log);

    await writeFile(`${memB}/NOTES.md`, "- from b\n");
    await syncMemoryAfter(depsOf(B), id, false, log);
    const fromB = await changeOf(B, memB, "@-");
    expect(await changeOf(A, memA, "memory")).toBe(fromB);

    // A wrote during its own turn, on the base it had before B's push.
    await writeFile(`${memA}/OTHER.md`, "- from a\n");
    await syncMemoryAfter(depsOf(A), id, false, log);
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
  const node = await setupNode(undefined, { MEDDLE_FIXTURE_MEMORY: "1" });
  const { cfg, project, runner, harness } = node;
  try {
    const m = await createTask(node, { title: "t", projectIds: [project.id] });
    const idle = new Promise<void>((res) => runner.onState((tid, s) => { if (tid === m.id && s === "idle") res(); }));
    await runner.prompt(m.id, "Remember the tide tables.");
    await idle;
    expect(await read(`${paths(cfg).memory(project.id)}/MEMORY.md`)).toBe("Remember the tide tables.\n");
  } finally {
    await harness.close();
  }
}, 15_000);

test("a conflicted memory bookmark on the home is resolved, and the next turn end moves memory as usual", async () => {
  const A = await startPoolNode();
  try {
    const deps: ReplicaDeps = { cfg: A.cfg, db: A.db, pool: A.pool };
    const id = A.project.id;
    const mem = paths(A.cfg).memory(id);
    const logs: string[] = [];
    const log = (line: string) => { logs.push(line); };
    const change = async (rev: string) => (await jj(["log", "-r", rev, "--no-graph", "-T", "change_id"], mem, A.cfg)).trim();
    await writeFile(`${mem}/MEMORY.md`, "- base\n");
    await syncMemoryAfter(deps, id, false, log);
    // A local commit `@` descends from, and a sibling it does not; two divergent operations point `memory` at each.
    await writeFile(`${mem}/LOCAL.md`, "- local\n");
    await jj(["commit", "-m", "local"], mem, A.cfg);
    const local = await change("@-");
    await jj(["new", "memory", "--no-edit", "-m", "sibling"], mem, A.cfg);
    const sibling = await change(`children(memory) ~ ${local}`);
    const op = (await jj(["op", "log", "-n", "1", "--no-graph", "-T", "id"], mem, A.cfg)).trim();
    await jj(["--at-op", op, "bookmark", "set", "memory", "-r", local], mem, A.cfg);
    await jj(["--at-op", op, "bookmark", "set", "memory", "-r", sibling], mem, A.cfg);
    expect((await bookmarkList(mem, A.cfg)).find((b) => b.name === "memory" && b.remote === null)?.conflicted).toBe(true);

    await syncMemoryBefore(deps, id, false, log);
    expect(logs).toEqual([`meddle: git: memory of ${shortId(id)} had a conflicted bookmark; resolved to ${sibling}`]);
    expect((await bookmarkList(mem, A.cfg)).find((b) => b.name === "memory" && b.remote === null)).toMatchObject({ changeId: sibling, conflicted: false });
    // The local side was carried across onto the chosen one.
    expect(await change(`::@ & ${sibling}`)).toBe(sibling);
    expect(await read(`${mem}/LOCAL.md`)).toBe("- local\n");

    await writeFile(`${mem}/AFTER.md`, "- after\n");
    await syncMemoryAfter(deps, id, false, log);
    expect(await change("memory")).toBe(await change("@-"));
    expect(await jj(["log", "-r", "@-", "--no-graph", "-T", "description"], mem, A.cfg)).toBe(`memory from ${shortId(A.id)}\n`);
    expect(await change(`::memory & ${sibling}`)).toBe(sibling);
    expect(await change(`::memory & ${local}`)).toBe(local);
    expect(logs).toHaveLength(1);
  } finally {
    await A.close();
    A.db.close();
    await rm(A.home, { recursive: true, force: true });
  }
}, 15_000);

test("two tasks of one project whose turns start and end together sync memory one at a time", async () => {
  const A = await startPoolNode(undefined, { MEDDLE_FIXTURE_MEMORY: "1" });
  try {
    const id = A.project.id;
    const mem = paths(A.cfg).memory(id);
    const tasks = [
      await createTask(A, { title: "one", projectIds: [id] }),
      await createTask(A, { title: "two", projectIds: [id] }),
    ];
    for (let round = 0; round < 2; round++) {
      const idle = tasks.map((m) => new Promise<void>((res) => A.runner.onState((tid, s) => { if (tid === m.id && s === "idle") res(); })));
      await Promise.all(tasks.map((m, i) => A.runner.prompt(m.id, `line ${round}.${i}`)));
      await Promise.all(idle);
    }
    expect(A.logs.filter((l) => l.startsWith("meddle: git: memory of"))).toEqual([]);
    expect(await jj(["log", "-r", "divergent()", "--no-graph", "-T", "change_id"], mem, A.cfg)).toBe("");
    const atMemory = await jj(["file", "show", "-r", "memory", "MEMORY.md"], mem, A.cfg);
    // Each task's first prompt is what the stand-in writes to memory.
    for (const line of ["line 0.0", "line 0.1"]) expect(atMemory).toContain(line);
    expect(await jj(["log", "-r", "memory", "--no-graph", "-T", "description"], mem, A.cfg)).toBe(`memory from ${shortId(A.id)}\n`);
  } finally {
    await A.close();
    A.db.close();
  }
}, 15_000);

test("a turn that ends while another task of the project is live here leaves memory alone; the last to end commits both", async () => {
  // Both turns stall before their result until interrupted, after the stand-in wrote the prompt to MEMORY.md.
  const A = await startPoolNode(undefined, { MEDDLE_FIXTURE_MEMORY: "1", MEDDLE_FIXTURE_STALL: "1" });
  try {
    const id = A.project.id;
    const mem = paths(A.cfg).memory(id);
    const one = await createTask(A, { title: "one", projectIds: [id] });
    const two = await createTask(A, { title: "two", projectIds: [id] });
    const idleOf = (taskId: string) =>
      new Promise<void>((res) => { const off = A.runner.onState((tid, s) => { if (tid === taskId && s === "idle") { off(); res(); } }); });
    /** Waits until the task's turn is live and its prompt is in the memory working copy. */
    const wrote = async (taskId: string, line: string) => {
      const deadline = Date.now() + 10_000;
      let text: string | null = null;
      for (;;) {
        text = await read(`${mem}/MEMORY.md`);
        if (A.runner.liveQuery(taskId) !== null && text?.includes(line)) return;
        if (Date.now() > deadline) throw new Error(`no live turn of ${taskId} that wrote ${line}; MEMORY.md: ${text}`);
        await Bun.sleep(20);
      }
    };
    /** The newest operation of the memory repo, read without snapshotting its working copy. */
    const head = async () => (await jj(["op", "log", "--ignore-working-copy", "-n", "1", "--no-graph", "-T", "id"], mem, A.cfg)).trim();
    const syncs = async () => (await jj(["log", "--ignore-working-copy", "-r", '::present(memory) & description(glob:"memory from*")', "--no-graph", "-T", 'change_id ++ "\\n"'], mem, A.cfg)).split("\n").filter(Boolean);

    await A.runner.prompt(one.id, "line from one");
    await wrote(one.id, "line from one");
    const before = await head();
    // The other runs a whole turn meanwhile: no snapshot, commit or rebase in the memory repo, before or after it.
    let idle = idleOf(two.id);
    await A.runner.prompt(two.id, "line from two");
    await wrote(two.id, "line from two");
    await A.runner.interrupt(two.id);
    await idle;
    expect(await head()).toBe(before);
    expect(await syncs()).toEqual([]);

    // The first one ends: one sync commits what both wrote.
    idle = idleOf(one.id);
    await A.runner.interrupt(one.id);
    await idle;
    expect(await syncs()).toHaveLength(1);
    const atMemory = await jj(["file", "show", "-r", "memory", "MEMORY.md"], mem, A.cfg);
    expect(atMemory).toContain("line from one");
    expect(atMemory).toContain("line from two");
    expect(A.logs.filter((l) => l.startsWith("meddle: git: memory of"))).toEqual([]);
  } finally {
    await A.close();
    A.db.close();
    await rm(A.home, { recursive: true, force: true });
  }
}, 15_000);

test("overlapping memory syncs of one project run one at a time: one line of history, every write under memory", async () => {
  const A = await startPoolNode();
  try {
    const deps: ReplicaDeps = { cfg: A.cfg, db: A.db, pool: A.pool };
    const id = A.project.id;
    const mem = paths(A.cfg).memory(id);
    const logs: string[] = [];
    const log = (line: string) => { logs.push(line); };
    const revs = async (revset: string) => jj(["log", "-r", revset, "--no-graph", "-T", 'change_id ++ "\\n"'], mem, A.cfg);
    for (let round = 0; round < 4; round++) {
      await writeFile(`${mem}/R${round}.md`, `- round ${round}\n`);
      const calls: Promise<void>[] = [];
      for (let k = 0; k < 4; k++) calls.push(syncMemoryAfter(deps, id, false, log), syncMemoryBefore(deps, id, false, log));
      await Promise.all(calls);
    }
    expect(logs).toEqual([]);
    expect(await revs("divergent()")).toBe("");
    // Run one at a time, the syncs leave no stray working-copy commits beside the history and no empty memory commits.
    expect(await revs("heads(all()) ~ @")).toBe("");
    expect(await revs('empty() & description(glob:"memory from*")')).toBe("");
    for (let round = 0; round < 4; round++) {
      expect(await jj(["file", "show", "-r", "memory", `R${round}.md`], mem, A.cfg)).toBe(`- round ${round}\n`);
    }
  } finally {
    await A.close();
    A.db.close();
  }
}, 15_000);
