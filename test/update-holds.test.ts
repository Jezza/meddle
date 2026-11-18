// test/update-holds.test.ts — what a pool update holds on a node's TaskRunner: no turn starts while turns are held
// (prompts queue), a turn cut off by the swap's restart waits for the hold to lift and then carries on, and moves,
// archives, restores and new tasks are refused while held.
import { expect, test } from "bun:test";
import { createRegistry } from "@earendil-works/pi-durable";
import { listEvents } from "../src/store/events";
import { getTask, queuedOf } from "../src/store/records";
import { CARRY_ON_PROMPT, TaskRunner } from "../src/tasks/durable";
import { openHarness } from "../src/tasks/harness";
import { createTask, replay, setupNode } from "./helpers";

const HELD = "update in progress (build 1ee71ee71ee7)";

async function eventually(cond: () => boolean | Promise<boolean>, what: () => string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting: ${what()}`);
    await Bun.sleep(10);
  }
}

const prompts = (db: Parameters<typeof listEvents>[0], id: string) =>
  listEvents(db, id).filter((e) => (e.message as { type?: string }).type === "user").map((e) => (e.message as { message: { content: unknown } }).message.content);

test("while turns are held a prompt queues, and it runs once the hold lifts", async () => {
  const node = await setupNode();
  const { db, runner } = node;
  const m = await createTask(node, { title: "t", projectIds: [node.project.id] });
  runner.setHolds({ turns: HELD, work: null, hosting: null });
  expect(await runner.prompt(m.id, "Reply with the single word ok.")).toBe("queued");
  await Bun.sleep(200);
  expect(runner.state(m.id)).toBe("idle");
  expect(queuedOf(getTask(db, m.id)!)).toEqual([{ text: "Reply with the single word ok.", attachments: [] }]);
  expect(await runner.busyTasks()).toEqual([]);
  runner.setHolds({ turns: null, work: null, hosting: null });
  await eventually(() => listEvents(db, m.id).some((e) => (e.message as { type?: string }).type === "result"), () => runner.state(m.id));
  await eventually(() => runner.state(m.id) === "idle", () => runner.state(m.id));
  expect(prompts(db, m.id)).toEqual(["Reply with the single word ok."]);
  await node.harness.close();
});

test("a turn cut off by a restart waits on a held Harness, then carries on once it resumes", async () => {
  const node = await setupNode("hello.jsonl", { MEDDLE_FIXTURE_STALL: "1" });
  const { cfg, db, runner } = node;
  const m = await createTask(node, { title: "t", projectIds: [node.project.id] });
  const initialised = new Promise<void>((res) => runner.onEvent((tid, _s, msg: { type?: string; subtype?: string }) => {
    if (tid === m.id && msg.type === "system" && msg.subtype === "init") res();
  }));
  await runner.prompt(m.id, "Reply with the single word ok.");
  await initialised;
  expect(await runner.busyTasks()).toEqual([m.id]);
  // The swap's restart: the process goes down mid-turn.
  await node.harness.close();
  // On the new build the Harness opens held: nothing reruns, and nothing counts as in flight.
  const h = await openHarness(cfg, createRegistry(), { hold: true });
  const again = new TaskRunner(cfg, db, h.harness, { claudePath: replay, claudeRuntime: "bun", extraEnv: { MEDDLE_FIXTURE: `${import.meta.dir}/fixtures/hello.jsonl` } });
  again.setHolds({ turns: HELD, work: HELD, hosting: HELD });
  await Bun.sleep(300);
  expect(prompts(db, m.id)).toEqual(["Reply with the single word ok."]);
  expect(await again.busyTasks()).toEqual([]);
  // Held: no archive, no move, no new task here.
  await expect(again.archive(m.id)).rejects.toThrow(HELD);
  expect(() => again.checkMove(getTask(db, m.id)!, "b".repeat(64))).toThrow(HELD);
  await expect(createTask({ ...node, runner: again }, { title: "u", projectIds: [node.project.id] })).rejects.toThrow("this node takes no tasks now");
  // Confirmed: the hold lifts, the Harness resumes, and the cut-off turn carries on.
  again.setHolds({ turns: null, work: null, hosting: null });
  again.resumeHarness();
  await eventually(() => prompts(db, m.id).length === 2, () => JSON.stringify(prompts(db, m.id)));
  expect(prompts(db, m.id)).toEqual(["Reply with the single word ok.", CARRY_ON_PROMPT]);
  await eventually(() => again.state(m.id) === "idle", () => again.state(m.id));
  await h.close();
});
