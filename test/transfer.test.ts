// test/transfer.test.ts — a task's rows and transcript files over one blob stream.
import { test, expect } from "bun:test";
import { lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { SendStream } from "@number0/iroh";
import { paths, type NodeConfig } from "../src/config";
import { ALPN_POOL, StreamReader, writeFrame } from "../src/pool/frames";
import { getTask } from "../src/store/records";
import { SqliteSessionStore } from "../src/store/session-store";
import type { TaskManifest } from "../src/tasks/manifest";
import { exportTask, importTask, receiptsMatch, type TransferFrame } from "../src/tasks/transfer";
import { createTask, setupNode } from "./helpers";
import { endpointPair } from "./pool-helpers";

type Node = Awaited<ReturnType<typeof setupNode>>;

/** A node with one task that ran one replayed turn. */
/** A task with a project: its primary is a string. */
type ProjectTask = TaskManifest & { primaryProjectId: string };

async function turnedNode(): Promise<{ node: Node; m: ProjectTask }> {
  const node = await setupNode();
  const m = await createTask(node, { title: "t", projectIds: [node.project.id] });
  const idle = new Promise<void>((res) => node.runner.onState((tid, s) => { if (tid === m.id && s === "idle") res(); }));
  await node.runner.prompt(m.id, "Reply with the single word ok.");
  await idle;
  return { node, m: m as ProjectTask };
}

async function closeNodes(...nodes: Node[]): Promise<void> {
  for (const n of nodes) {
    await n.harness.close();
    n.db.close();
    await rm(n.home, { recursive: true, force: true });
  }
}

/** Every regular file under `root` (symlinks skipped), by forward-slash path relative to `root`. */
async function filesUnder(root: string, rel = ""): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  for (const name of await readdir(join(root, rel))) {
    const path = rel === "" ? name : `${rel}/${name}`;
    const st = await lstat(join(root, path));
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) for (const [k, v] of await filesUnder(root, path)) out.set(k, v);
    else if (st.isFile()) out.set(path, await readFile(join(root, path)));
  }
  return out;
}

function eventRows(db: Database, taskId: string) {
  return db.query("SELECT task_id, seq, type, subtype, uuid, json FROM events WHERE task_id = ? ORDER BY seq").all(taskId);
}

function transcriptRows(db: Database, sessionId: string) {
  return db.query("SELECT * FROM transcript WHERE session_id = ? ORDER BY project_key, subpath, seq").all(sessionId);
}

const encoder = new TextEncoder();
const frameJson = (frame: TransferFrame) => encoder.encode(JSON.stringify(frame));

function projectsDir(cfg: NodeConfig, taskId: string): string {
  return join(paths(cfg).taskConfig(taskId), "projects");
}

test("a task's rows and files round-trip, receipts match", async () => {
  const { node: S, m } = await turnedNode();
  const R = await setupNode();
  const pair = await endpointPair();
  try {
    const slot = join(projectsDir(S.cfg, m.id), m.primaryProjectId);
    const subagents = join(slot, m.sessionId, "subagents");
    await mkdir(subagents, { recursive: true });
    await writeFile(join(subagents, "agent-x.jsonl"), '{"type":"user","uuid":"sub-1"}\n');
    await writeFile(join(subagents, "agent-x.meta.json"), '{"agentType":"general-purpose"}\n');
    await writeFile(join(paths(S.cfg).memory(m.primaryProjectId), "MEMORY.md"), "# remember\n");
    // The replayer does not mirror its transcript (the SDK does): rows of the session, a subagent, and another session.
    const store = new SqliteSessionStore(S.db);
    const projectKey = m.primaryProjectId;
    await store.append({ projectKey, sessionId: m.sessionId }, [
      { type: "user", uuid: "u-1", timestamp: "2026-10-31T00:00:00Z" },
      { type: "assistant", uuid: "u-2", timestamp: "2026-10-31T00:00:01Z" },
      { type: "summary" },
    ]);
    await store.append({ projectKey, sessionId: m.sessionId, subpath: "subagents/agent-x" }, [{ type: "user", uuid: "sub-1" }]);
    await store.append({ projectKey, sessionId: "another" }, [{ type: "user", uuid: "o-1" }]);
    await mkdir(paths(R.cfg).taskConfig(m.id), { recursive: true });

    const { a, b } = await pair.connect(ALPN_POOL);
    const out = await a.openBi();
    const exporting = exportTask(S.cfg, S.db, m.id, out.send);
    const reader = new StreamReader((await b.acceptBi()).recv);
    const got = await importTask(R.cfg, R.db, reader, { taskId: m.id });
    const sent = await exporting;

    expect(sent.events).toBeGreaterThan(0);
    expect(sent.transcript).toBe(4);
    expect(sent.files).toBe(3);
    expect(got.receipt).toEqual(sent);
    expect(receiptsMatch(sent, got.receipt)).toBe(true);
    expect(receiptsMatch(sent, { ...got.receipt, sha256: "0".repeat(64) })).toBe(false);
    expect(receiptsMatch(sent, { ...got.receipt, lastEventSeq: sent.lastEventSeq + 1 })).toBe(false);

    const row = getTask(S.db, m.id)!;
    expect(got.manifest).toEqual(JSON.parse(row.manifest));
    expect(got.turns).toBe(row.turns);
    expect(got.queued).toEqual([]);
    expect(got.settings).toBeNull();
    expect(getTask(R.db, m.id)).toBeNull();

    expect(eventRows(R.db, m.id)).toEqual(eventRows(S.db, m.id));
    expect(transcriptRows(R.db, m.sessionId)).toEqual(transcriptRows(S.db, m.sessionId));
    expect(transcriptRows(R.db, "another")).toEqual([]);
    expect(sent.lastEventSeq).toBe((eventRows(S.db, m.id).at(-1) as { seq: number }).seq);

    const sentFiles = await filesUnder(projectsDir(S.cfg, m.id));
    const gotFiles = await filesUnder(projectsDir(R.cfg, m.id));
    expect([...gotFiles.keys()].sort()).toEqual([...sentFiles.keys()].sort());
    for (const [k, v] of sentFiles) expect(gotFiles.get(k)!.equals(v)).toBe(true);
    expect(sentFiles.has(`${m.primaryProjectId}/${m.sessionId}.jsonl`)).toBe(true);
    expect(sentFiles.has(`${m.primaryProjectId}/${m.sessionId}/subagents/agent-x.meta.json`)).toBe(true);
  } finally {
    await pair.close();
    await closeNodes(S, R);
  }
}, 15_000);

test("a populated memory replica behind the memory symlink sends no file frames", async () => {
  const { node: S, m } = await turnedNode();
  const pair = await endpointPair();
  try {
    const memory = paths(S.cfg).memory(m.primaryProjectId);
    await mkdir(join(memory, "notes"), { recursive: true });
    await writeFile(join(memory, "MEMORY.md"), "# remember\n");
    await writeFile(join(memory, "notes", "a.md"), "a\n");
    expect((await lstat(join(projectsDir(S.cfg, m.id), m.primaryProjectId, "memory"))).isSymbolicLink()).toBe(true);

    const { a, b } = await pair.connect(ALPN_POOL);
    const out = await a.openBi();
    const exporting = exportTask(S.cfg, S.db, m.id, out.send);
    const reader = new StreamReader((await b.acceptBi()).recv);
    const filePaths: string[] = [];
    for (;;) {
      const frame = await reader.readFrame();
      if (frame === null) break;
      if (frame.kind !== 0) continue;
      const parsed = JSON.parse(new TextDecoder().decode(frame.data)) as TransferFrame;
      if (parsed.t === "file") filePaths.push(parsed.path);
    }
    const sent = await exporting;
    expect(filePaths).toEqual([`${m.primaryProjectId}/${m.sessionId}.jsonl`]);
    expect(sent.files).toBe(1);
    expect(filePaths.some((p) => p.includes("memory"))).toBe(false);
  } finally {
    await pair.close();
    await closeNodes(S);
  }
}, 15_000);

test("a sender that closes before done leaves no rows", async () => {
  const { node: S, m } = await turnedNode();
  const R = await setupNode();
  const pair = await endpointPair();
  try {
    await mkdir(paths(R.cfg).taskConfig(m.id), { recursive: true });
    const { a, b } = await pair.connect(ALPN_POOL);
    const out = await a.openBi();
    // Everything but the `done` frame.
    const withoutDone = {
      writeAll(bytes: number[]) {
        if (bytes[0] === 0 && new TextDecoder().decode(Uint8Array.from(bytes.slice(5))).includes('"t":"done"')) return Promise.resolve();
        return out.send.writeAll(bytes);
      },
      finish: () => out.send.finish(),
    } as unknown as SendStream;
    const exporting = exportTask(S.cfg, S.db, m.id, withoutDone);
    const reader = new StreamReader((await b.acceptBi()).recv);
    await expect(importTask(R.cfg, R.db, reader, { taskId: m.id })).rejects.toThrow("transfer ended early");
    await exporting;
    expect(eventRows(R.db, m.id)).toEqual([]);
    expect(transcriptRows(R.db, m.sessionId)).toEqual([]);
  } finally {
    await pair.close();
    await closeNodes(S, R);
  }
}, 15_000);

test("a manifest for another task is rejected, and so is a file path out of the config dir", async () => {
  const R = await setupNode();
  const pair = await endpointPair();
  try {
    const manifest: TaskManifest = {
      id: "t1", title: "t", sessionId: "s1", primaryProjectId: R.project.id, createdAt: new Date().toISOString(),
      projects: [],
    };
    const { a, b } = await pair.connect(ALPN_POOL);

    const first = await a.openBi();
    await writeFrame(first.send, 0, frameJson({ t: "manifest", manifest, settings: null, queued: [], turns: 1 }));
    await writeFrame(first.send, 0, frameJson({ t: "event", seq: 1, json: '{"type":"user"}' }));
    await first.send.finish();
    await expect(importTask(R.cfg, R.db, new StreamReader((await b.acceptBi()).recv), { taskId: "t2" }))
      .rejects.toThrow("manifest is for another task");
    expect(eventRows(R.db, "t1")).toEqual([]);
    expect(eventRows(R.db, "t2")).toEqual([]);

    for (const bad of ["../escape.jsonl", "/abs.jsonl", "a/../../escape.jsonl", ""]) {
      const s = await a.openBi();
      await writeFrame(s.send, 0, frameJson({ t: "manifest", manifest, settings: null, queued: [], turns: 1 }));
      await writeFrame(s.send, 0, frameJson({ t: "file", path: bad, size: 1 }));
      await writeFrame(s.send, 1, Uint8Array.from([120]));
      await s.send.finish();
      await expect(importTask(R.cfg, R.db, new StreamReader((await b.acceptBi()).recv), { taskId: "t1" }))
        .rejects.toThrow("bad file path");
    }
    expect(await Bun.file(join(paths(R.cfg).taskConfig("t1"), "escape.jsonl")).exists()).toBe(false);
  } finally {
    await pair.close();
    await closeNodes(R);
  }
}, 15_000);
