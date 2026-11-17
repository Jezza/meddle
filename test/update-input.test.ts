// test/update-input.test.ts — a node whose new build awaits confirmation accepts no input: every method of the objects
// dashboards and the CLI change things through refuses while the gate says why, and so does every CLI command that
// writes, before it does anything (also while the node is down for its swap).
import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { NodeObject, PoolObject, TaskObject, UpdateObject } from "../src/state/contracts";
import { getTask } from "../src/store/records";
import { gated, inputRefusal, nodeInputHold } from "../src/update/gate";
import { serveUpdate } from "../src/update/object";
import { updateFiles, writePending } from "../src/update/files";
import type { UpdateSnapshot } from "../src/update/updater";
import { closedPort, createTask, meddle } from "./helpers";
import { linkClient, startPoolNode } from "./pool-helpers";

const BUILD = "1ee71ee71ee7";
const HELD = inputRefusal(BUILD);

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** Why `p` rejected (it must). */
async function refusal(p: Promise<unknown>): Promise<string> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(Error);
  return (err as Error).message;
}

test("the refusal names the build and says to try again", () => {
  expect(HELD).toBe(`update in progress (build ${BUILD}), try again shortly`);
});

test("a node started awaiting confirmation is held until its updater starts, then as long as the updater says", () => {
  const awaiting = { build: BUILD };
  expect(nodeInputHold(undefined, awaiting)).toBe(HELD);
  expect(nodeInputHold(undefined, null)).toBeNull();
  let held: string | null = HELD;
  const updater = { inputHold: () => held };
  expect(nodeInputHold(updater, awaiting)).toBe(HELD);
  // Confirmed: the updater's word wins over what the node started with.
  held = null;
  expect(nodeInputHold(updater, awaiting)).toBeNull();
});

test("gated refuses an implementation's methods while held and leaves its other members alone", async () => {
  let held: string | null = HELD;
  const cell = { value: 1 };
  const impl = gated({ cell, add: async (n: number) => n + 1, sync: () => "done", look: async () => "seen" }, () => held, ["look"]);
  expect(impl.cell).toBe(cell);
  // A method named a read is not held.
  expect(await impl.look()).toBe("seen");
  expect(await refusal(impl.add(1))).toBe(HELD);
  expect(await refusal(impl.sync() as unknown as Promise<unknown>)).toBe(HELD);
  held = null;
  expect(await impl.add(1)).toBe(2);
  expect(impl.sync()).toBe("done");
});

test("while an update awaits confirmation, every method of NodeObject, TaskObject, PoolObject and UpdateObject refuses, and reads go on", async () => {
  let held: string | null = null;
  const A = await startPoolNode(undefined, {}, { inputHold: () => held });
  const snapshot: UpdateSnapshot = {
    self: A.id, build: { buildId: BUILD, platform: "linux-x64" }, poolBuild: null, rollout: null, lastFailure: null,
    awaitingConfirmation: true, held: HELD, nodes: [],
  };
  let started = 0;
  serveUpdate(A.host, {
    snapshot: () => snapshot,
    startRollout: async () => { started++; return { rollout: "r", build: BUILD, escalated: false, participants: [] }; },
    changes: { subscribe: () => () => {} },
    inputHold: () => held,
  });
  const m = await createTask(A, { title: "before", projectIds: [A.project.id] });
  const owner = linkClient(A.host);
  try {
    const node = await owner.client.get(NodeObject, {});
    const task = await owner.client.get(TaskObject, { id: m.id });
    const pool = await owner.client.get(PoolObject, {});
    const update = await owner.client.get(UpdateObject, {});
    if (pool.variant !== "default") throw new Error("expected the default pool view");
    held = HELD;

    // One valid call of every method each contract has: a method added later must be added here (and is gated).
    const other = "f".repeat(64);
    const calls: Record<string, Record<string, () => Promise<unknown>>> = {
      node: {
        createTask: () => node.createTask({ projects: [{ id: A.project.id }], node: "here", prompt: "hi" }),
        addProjectFromFolder: () => node.addProjectFromFolder({ path: A.home }),
        addProjectFromUpstream: () => node.addProjectFromUpstream({ url: "https://example.invalid/x.git" }),
        setDefaultBranch: () => node.setDefaultBranch({ projectId: A.project.id, branch: "other" }),
        dismiss: () => node.dismiss({ id: "n1" }),
      },
      task: {
        prompt: () => task.prompt({ text: "hello" }),
        rename: () => task.rename({ title: "after" }),
        interrupt: () => task.interrupt({}),
        sendNow: () => task.sendNow({}),
        retry: () => task.retry({}),
        approve: () => task.approve({ requestId: "r1" }),
        deny: () => task.deny({ requestId: "r1", message: "no" }),
        answerQuestion: () => task.answerQuestion({ requestId: "r1", answers: {} }),
        setPermissionMode: () => task.setPermissionMode({ mode: "plan" }),
        setModel: () => task.setModel({ model: "opus" }),
        setEffort: () => task.setEffort({ effort: "high" }),
        moveTo: () => task.moveTo({ nodeId: other, now: false }),
        cancelMove: () => task.cancelMove({}),
        moveNow: () => task.moveNow({}),
        archive: () => task.archive({}),
        restore: () => task.restore({ node: null }),
        delete: () => task.delete({}),
      },
      pool: {
        poolChanged: () => pool.poolChanged({}),
        remove: () => pool.remove({ nodeId: other }),
        allow: () => pool.allow({ nodeId: other }),
        tokenChanged: () => pool.tokenChanged({}),
        enableToken: () => pool.enableToken({ id: other }),
        moveToken: () => pool.moveToken({ id: other, before: other }),
        setSetting: () => pool.setSetting({ key: "jj.user", value: "Lab" }),
        unsetSetting: () => pool.unsetSetting({ key: "jj.user" }),
      },
      update: {
        start: () => update.start({ binaries: [], force: true }),
      },
    };
    expect(Object.keys(calls.node!).sort()).toEqual(Object.keys(NodeObject.def.variants.default.methods).sort());
    // The task's reads, which are not held.
    const taskReads: Record<string, () => Promise<unknown>> = {
      changeDiff: () => task.changeDiff({ project: A.project.id, change: m.projects[0]!.base[0]!, from: m.projects[0]!.base[0]! }),
      changeFile: () => task.changeFile({ project: A.project.id, rev: m.projects[0]!.base[0]!, path: "README" }),
      workspaceFile: () => task.workspaceFile({ path: `${A.cfg.taskRoot}/${m.id}/a/README` }),
    };
    expect([...Object.keys(calls.task!), ...Object.keys(taskReads)].sort()).toEqual(Object.keys(TaskObject.def.variants.default.methods).sort());
    expect(Object.keys(calls.pool!).sort()).toEqual(Object.keys(PoolObject.def.variants.default.methods).sort());
    expect(Object.keys(calls.update!).sort()).toEqual(Object.keys(UpdateObject.def.variants.default.methods).sort());
    for (const [object, methods] of Object.entries(calls)) {
      for (const [name, call] of Object.entries(methods)) {
        const why = await refusal(call());
        if (!why.includes(HELD)) throw new Error(`${object}.${name} was not refused for the update: ${why}`);
      }
    }
    expect(await Promise.all(Object.values(taskReads).map((call) => call()))).toEqual(["", "a\n", "a\n"]);
    // Nothing changed, and what dashboards read still reads.
    expect(getTask(A.db, m.id)?.title).toBe("before");
    expect(A.pool.settings.get("jj.user")).toBeNull();
    expect(started).toBe(0);
    expect(task.manifest.value.title).toBe("before");
    expect(update.awaitingConfirmation.value).toBe(true);

    // Confirmed: input is taken again.
    held = null;
    await task.rename({ title: "after" });
    await pool.setSetting({ key: "jj.user", value: "Lab" });
    expect(getTask(A.db, m.id)?.title).toBe("after");
    expect(A.pool.settings.get("jj.user")).toBe("Lab");
    for (const ref of [node, task, pool, update]) ref.release();
  } finally {
    await owner.close();
    await A.close();
  }
}, 60_000);

test("every CLI command that writes is refused while a swap is in progress, before it does anything; reads are not", async () => {
  const dir = await mkdtemp("/tmp/meddle-update-input-");
  dirs.push(dir);
  await mkdir(`${dir}/d`, { recursive: true });
  const env = { HOME: dir, MEDDLE_DATA_DIR: `${dir}/d`, MEDDLE_TASK_ROOT: `${dir}/t`, MEDDLE_PORT: String(await closedPort()) };
  await writePending(updateFiles(`${dir}/d`, "/unused"), {
    v: 1, phase: "swapped", rollout: "r1", build: BUILD, previousBuild: "0ld0ld0ld0ld", platform: "linux-x64", swappedAt: Date.now(),
    healthMs: 120_000, starts: 1, healthy: false, late: false,
  });
  await writeFile(`${dir}/tok`, "tok-a\n");
  await writeFile(`${dir}/secret`, "s".repeat(64));
  const node = "a".repeat(64);
  const writes = [
    ["pool", "secret", "--file", `${dir}/secret`],
    ["pool", "peer", node],
    ["pool", "remove", "abc"],
    ["pool", "allow", "abc"],
    ["token", "add", "--file", `${dir}/tok`],
    ["token", "set", "--file", `${dir}/tok`],
    ["token", "remove", "work"],
    ["token", "enable", "work"],
    ["token", "move", "work", "--before", "home"],
    ["config", "set", "jj.user", "Lab"],
    ["config", "unset", "jj.user"],
    ["project", "add", dir],
    ["project", "set-default", "a", "main"],
    ["task", "new", "hello"],
    ["task", "prompt", "0012", "hello"],
    ["task", "retry", "0012"],
    ["task", "move", "0012", "abc"],
    ["task", "move", "0012", "--cancel"],
    ["task", "archive", "0012"],
    ["task", "restore", "0012", "--here"],
    ["task", "delete", "0012"],
    ["update", "--force"],
  ];
  const outs = await Promise.all(writes.map((args) => meddle(args, env)));
  for (const [i, out] of outs.entries()) {
    expect({ args: writes[i], ...out }).toEqual({ args: writes[i], stdout: "", stderr: `meddle: ${HELD}\n`, code: 1 });
  }
  // Nothing was written: no database, no identity.
  expect(existsSync(`${dir}/d/meddle.sqlite`)).toBe(false);
  // Reads go on.
  expect(await meddle(["token", "list"], env)).toEqual({ stdout: "active: none\n", stderr: "", code: 0 });
  expect((await meddle(["update"], env)).stderr).toBe('meddle: start "meddle serve" first\n');
}, 60_000);
